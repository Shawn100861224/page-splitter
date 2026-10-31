/**
 * main.js — 页面交互：选图 → 自动分区 → 手改分界 → 导出 ZIP
 * 全部在本机完成，不发任何网络请求。
 */
import { analyze, DEFAULTS } from './segment.js?v=18';
import {
  loadBitmap, downscale, canvasToGray, cropRegion, canvasToJpegBlob, bitmapSize, rotate90,
} from './imageio.js';
import { makeZip } from './zipstore.js';

document.documentElement.dataset.build = 'v13-hist';

const $ = (id) => document.getElementById(id);

/* 内置浏览器（微信/QQ）没有 Web Share、也写不进相册：单独给提示，别让用户以为能一键存图 */
const UA = navigator.userAgent;
const inAppBrowser = /MicroMessenger|QQ\/|QQBrowser|Weibo/i.test(UA)
  || new URLSearchParams(location.search).has('inapp');   // ?inapp=1 用来在本机复现提示

// 首页「适合 / 不适合」：宽屏展开，手机上收起（手机上首屏要留给选图和按钮）
{
  const fit = document.getElementById('fit-details');
  if (fit && window.matchMedia('(min-width: 720px)').matches) fit.open = true;
}

const el = {
  drop: $('drop'), file: $('file'),
  editor: $('editor'),
  gap: $('gap'), pad: $('pad'), count: $('count'), outGap: $('out-gap'), outPad: $('out-pad'),
  btnBack: $('btn-back'), btnAuto: $('btn-auto'), btnAdd: $('btn-add'), btnZip: $('btn-zip'),
  btnUndo: $('btn-undo'), btnSave: $('btn-save'), dlgZip: $('dlg-zip'), dlgAll: $('dlg-all'),
  dlgGallery: $('dlg-gallery'), galleryList: $('gallery-list'), dlgClose: $('dlg-close'),
  status: $('status'), warnings: $('warnings'), uaTip: $('ua-tip'),
  stage: $('stage'), preview: $('preview'), overlay: $('overlay'),
  bands: $('bands'), lines: $('lines'), list: $('list'),
};

/** 全局状态（一次性页面，不做框架） */
const S = {
  bmp: null,
  analysis: null,   // { canvas, scale, width, height }
  base: null,       // 摆正方向后的源（横拍照片被转过 90°）
  gray: null,
  result: null,
  dividers: [],     // 内部分界线的 y（分析坐标系）
  pad: Number(el.pad.value),
  count: 0,          // 用户填的"这页几道题"，0 = 自动
  gapRatio: Number(el.gap.value) / 100,
  thumbUrls: [],
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setStatus(msg, kind = '') {
  if (!msg) {
    el.status.hidden = true;
    el.status.textContent = '';
    return;
  }
  el.status.hidden = false;
  el.status.className = 'status' + (kind ? ` ${kind}` : '');
  el.status.textContent = msg;
}

/* ---------------- 读图 ---------------- */
async function openFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('这个文件不是图片，换一张试试', 'warn');
    return;
  }
  setStatus('');
  el.btnZip.disabled = true;
  try {
    S.bmp = await loadBitmap(file);
    // 横着拍的照片（纸转了 90°）先摆正：分析只认"行"，方向反了就只会切出 1 段。
    S.base = S.bmp;
    S.analysis = downscale(S.base);
    S.gray = canvasToGray(S.analysis.canvas);
    for (let k = 0; k < 2; k++) {
      const probe = analyze(S.gray, { gapRatio: S.gapRatio, count: S.count });
      if (!probe.needRotate) break;
      S.base = rotate90(S.base);
      S.analysis = downscale(S.base);
      S.gray = canvasToGray(S.analysis.canvas);
    }
    el.drop.hidden = true;
    el.editor.hidden = false;
    drawPreview();
    runAnalyze();
    if (el.uaTip) el.uaTip.hidden = !inAppBrowser;
    try { window.history.pushState({ stage: 'editor' }, ''); } catch (_) { /* 老浏览器忽略 */ }
    document.documentElement.dataset.stage = 'editor';
  } catch (err) {
    console.error(err);
    setStatus(`读图失败：${err.message || err}`, 'warn');
    el.drop.hidden = false;
    el.editor.hidden = true;
  }
}

function drawPreview() {
  const { canvas, width, height } = S.analysis;
  el.preview.width = width;
  el.preview.height = height;
  el.preview.getContext('2d').drawImage(canvas, 0, 0);
}

/* ---------------- 分析 ---------------- */
function runAnalyze() {
  const t0 = performance.now();
  S.result = analyze(S.gray, { gapRatio: S.gapRatio, count: S.count });
  S.dividers = S.result.regions.slice(1).map((r) => r[0]);
  history.length = 0;
  updateUndo();
  const ms = Math.round(performance.now() - t0);
  const n = regions().length;
  const w = S.result.warnings;
  setStatus(`${n} 段 · ${S.result.bands.length} 条墨迹带 · ${ms}ms`
    + (w.length ? ` · ${w[0]}` + (w.length > 1 ? `（另有 ${w.length - 1} 条提示见下方）` : '') : ''),
    w.length ? 'warn' : '');
  renderWarnings(w);
  render();
  syncStatus();
}

/** 当前分区：内容上下边界 + 手改分界 */
function contentBounds() {
  const b = S.result.bands;
  if (!b.length) return [0, S.analysis.height];
  return [b[0][0], b[b.length - 1][1]];
}

function regions() {
  const [top, bottom] = contentBounds();
  const ys = [top, ...S.dividers.filter((y) => y > top && y < bottom).sort((a, b) => a - b), bottom];
  const out = [];
  for (let i = 0; i < ys.length - 1; i++) {
    if (ys[i + 1] - ys[i] >= 4) out.push([ys[i], ys[i + 1]]);
  }
  return out;
}

/** 分析给出的"这页可能不适合"的提示，逐条列在状态栏下面 */
function renderWarnings(list) {
  if (!el.warnings) return;
  el.warnings.replaceChildren();
  if (!list || !list.length) { el.warnings.hidden = true; return; }
  for (const t of list) {
    const li = document.createElement('li');
    li.textContent = t;
    el.warnings.appendChild(li);
  }
  el.warnings.hidden = false;
}

/* ---------------- 撤销 ---------------- */
// 只记分界线位置：图、分析结果都没变，撤销就是回到上一组线。
const history = [];

function snapshot(lines = S.dividers.slice()) {
  const top = history[history.length - 1];
  if (top && top.length === lines.length && top.every((v, i) => v === lines[i])) return;
  history.push(lines);
  if (history.length > 60) history.shift();
  updateUndo();
}

function undo() {
  const prev = history.pop();
  updateUndo();
  if (!prev) return;
  S.dividers = prev.slice();
  render();
  syncStatus();
}

function updateUndo() {
  if (el.btnUndo) el.btnUndo.disabled = history.length === 0 || !S.result;
}

/* ---------------- 渲染 ---------------- */
function render() {
  renderOverlay();
  renderList();
}

/** 手工改动分界后同步状态栏（分析结果本身没变，段数会变） */
function syncStatus() {
  if (!S.result) return;
  const n = regions().length;
  const risky = (S.result.risky || []).length;
  const auto = S.result.regions.length;
  const extra = n === auto ? '' : `（手工调整：自动 ${auto} 段）`;
  setStatus(`${n} 段${extra}` + (risky ? ` · ${risky} 处间距接近阈值，建议核对` : ''), risky ? 'warn' : '');
  el.btnZip.disabled = !n;            // 有分段才允许导出（此前只在读图时禁用、从未启用，是真 bug）
  scheduleShareFiles();   // 段变了就把相册用的图片重新编码（防抖，拖完才跑）
}

function renderOverlay() {
  const H = S.analysis.height;
  const pct = (y) => `${(y / H) * 100}%`;

  el.bands.replaceChildren();
  for (const [y0, y1] of S.result.bands) {
    const d = document.createElement('div');
    d.className = 'band';
    d.style.top = pct(y0);
    d.style.height = `${((y1 - y0) / H) * 100}%`;
    el.bands.appendChild(d);
  }

  el.lines.replaceChildren();
  S.dividers.forEach((y, i) => {
    const line = document.createElement('div');
    line.className = 'line';
    line.style.top = pct(y);
    line.tabIndex = 0;
    line.setAttribute('role', 'slider');
    line.setAttribute('aria-label', `分界线 ${i + 1}，上下方向键微调，Delete 删除`);
    line.dataset.y = String(y);

    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.type = 'button';
    kill.textContent = '×';
    kill.title = '删除这条分界线';
    kill.addEventListener('click', (e) => {
      e.stopPropagation();
      snapshot();
      S.dividers.splice(i, 1);
      render();
      syncStatus();
    });

    line.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 12 : 2;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        snapshot();
        const [top, bottom] = contentBounds();
        S.dividers[i] = clamp(y + (e.key === 'ArrowUp' ? -step : step), top + 4, bottom - 4);
        render();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        snapshot();
        S.dividers.splice(i, 1);
        render();
        syncStatus();
      }
    });

    line.appendChild(kill);
    makeDraggable(line, i);
    el.lines.appendChild(line);
  });
}

/** 拖动分界线（指针事件 + 键盘已单独处理） */
function makeDraggable(line, index) {
  let dragging = false;
  let moved = false;
  let before = null;

  line.addEventListener('pointerdown', (e) => {
    // 点在 × 上不要开始拖动：setPointerCapture 会把后续 click 重定向到 line，
    // 按钮的 click 永远收不到（手机上表现为"点叉没用"）。
    if (e.target.closest('.kill')) return;
    dragging = true;
    moved = false;
    before = S.dividers.slice();
    line.setPointerCapture(e.pointerId);
  });

  line.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = el.overlay.getBoundingClientRect();
    const y = ((e.clientY - rect.top) / rect.height) * S.analysis.height;
    const [top, bottom] = contentBounds();
    const next = clamp(Math.round(y), top + 4, bottom - 4);
    if (Math.abs(next - S.dividers[index]) >= 1) {
      moved = true;
      S.dividers[index] = next;
      line.style.top = `${(next / S.analysis.height) * 100}%`;
    }
  });

  const end = () => {
    dragging = false;
    if (moved && before) snapshot(before);
    if (moved) { render(); syncStatus(); }
  };
  line.addEventListener('pointerup', end);
  line.addEventListener('pointercancel', end);
}

function renderList() {
  S.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  S.thumbUrls = [];
  el.list.replaceChildren();

  regions().forEach(([y0, y1], i) => {
    const li = document.createElement('li');
    li.className = 'item';

    const thumb = document.createElement('canvas');
    drawThumb(thumb, y0, y1);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = `第 ${String(i + 1).padStart(2, '0')} 段`;
    const span = document.createElement('span');
    const hPx = Math.round((y1 - y0) / S.analysis.scale);
    span.textContent = `${hPx}px 高 · y ${Math.round(y0 / S.analysis.scale)}–${Math.round(y1 / S.analysis.scale)}`;
    meta.append(b, span);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = isMobile() ? '存到相册' : '下载';
    btn.addEventListener('click', () => exportOne(i, [y0, y1], btn));

    li.append(thumb, meta, btn);
    el.list.appendChild(li);
  });
}

function drawThumb(canvas, y0, y1) {
  const src = S.analysis.canvas;
  const [left, right] = S.result.xs;
  const w = right - left;
  const h = Math.max(1, y1 - y0);
  const scale = Math.min(1, 96 / w);
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, left, y0, w, h, 0, 0, canvas.width, canvas.height);
}

/* ---------------- 导出 ---------------- */
function box() {
  return { x0: S.result.xs[0], x1: S.result.xs[1], pad: S.pad };
}

async function regionToBlob(yRange) {
  const { canvas } = cropRegion(S.base || S.bmp, yRange, S.analysis.scale, box());
  return canvasToJpegBlob(canvas, 0.92);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportOne(index, yRange, btn) {
  const name = `第${String(index + 1).padStart(2, '0')}段.jpg`;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';

  try {
    // 手机：能分享就弹系统面板（一步进相册）；不能分享就给这张大图，长按存相册。
    // 两种情况都保证"点了有反应、且给出进相册的路"，不再静默落进"下载"文件夹。
    if (isMobile()) {
      let file = share.files[index];
      if (!file || !canShareFiles()) {
        const blob = await regionToBlob(yRange);
        file = new File([blob], name, { type: 'image/jpeg' });
      }
      if (canShareFiles()) {
        try {
          await navigator.share({ files: [file], title: name });
          setStatus(`已交给系统：在面板里选「保存」就进相册了（${name}）`);
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          console.warn('单段分享失败，改成长按保存', err);
        }
      }
      openGalleryFallback([file]);
      setStatus('长按这张图 →「保存图片」就进相册了');
      return;
    }

    const blob = await regionToBlob(yRange);
    download(blob, name);
  } catch (err) {
    console.error(err);
    setStatus(`导出失败：${err.message || err}`, 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function exportZip() {
  const rs = regions();
  if (!rs.length) return;
  el.btnZip.disabled = true;
  const label = el.btnZip.textContent;
  el.btnZip.textContent = '打包中…';
  try {
    const files = [];
    for (let i = 0; i < rs.length; i++) {
      const blob = await regionToBlob(rs[i]);
      const buf = new Uint8Array(await blob.arrayBuffer());
      files.push({ name: `第${String(i + 1).padStart(2, '0')}段.jpg`, data: buf });
    }
    const zip = makeZip(files);
    const stamp = new Date().toISOString().slice(0, 10);
    download(new Blob([zip], { type: 'application/zip' }), `切图_${stamp}_${rs.length}段.zip`);
    setStatus(`已导出 ${rs.length} 段，共 ${(zip.length / 1048576).toFixed(1)}MB`);
  } catch (err) {
    console.error(err);
    setStatus(`导出失败：${err.message || err}`, 'warn');
  } finally {
    el.btnZip.disabled = false;
    el.btnZip.textContent = label;
  }
}


/* ---------------- 保存到相册 ----------------
 * iPhone 上 <a download> 只会落到「文件」，进不了相册。
 * 进相册只有两条路：Web Share（系统分享面板 →「存储 N 项」）或长按图片保存。
 * 分享必须在用户手势里同步调用，所以图片提前在后台缓存好，点击时直接交出 File[]。
 */
const share = { files: [], building: false, seq: 0, timer: 0 };

/** 手机/平板：用系统分享面板才能进相册，桌面浏览器落"下载"文件夹 */
function isMobile() {
  return matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function canShareFiles() {
  try {
    const probe = new File([new Uint8Array([0])], 'p.jpg', { type: 'image/jpeg' });
    return !!(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch (e) {
    return false;
  }
}

function updateSaveBtn() {
  if (!el.btnSave) return;
  const n = regions().length;
  el.btnSave.hidden = false;      // 按钮常显：不支持系统分享时直接开长按面板
  el.btnSave.disabled = !n;
  if (share.building && !share.files.length && n) {
    el.btnSave.textContent = `准备中 ${share.files.length}/${n}…`;
  } else {
    el.btnSave.textContent = canShareFiles() ? '保存到相册' : '保存图片';
  }
}

/** 后台把每段编码成 JPEG File，供系统分享面板直接使用 */
async function buildShareFiles() {
  if (!S.result) { share.files = []; updateSaveBtn(); return; }
  const seq = ++share.seq;
  const rs = regions();
  share.building = true;
  const out = [];
  for (let i = 0; i < rs.length; i++) {
    if (seq !== share.seq) return;            // 有更新的一轮，放弃
    try {
      const blob = await regionToBlob(rs[i]);
      out.push(new File([blob], `第${String(i + 1).padStart(2, '0')}段.jpg`, { type: 'image/jpeg' }));
    } catch (err) {
      console.warn('预编码失败', err);
    }
    if (seq === share.seq) { share.files = out.slice(); updateSaveBtn(); }
  }
  if (seq !== share.seq) return;
  share.files = out;
  share.building = false;
  updateSaveBtn();
}

function scheduleShareFiles(delay = 250) {
  clearTimeout(share.timer);
  share.building = true;
  share.files = [];
  updateSaveBtn();
  share.timer = setTimeout(buildShareFiles, delay);
}

async function saveToGallery() {
  if (!S.result) return;
  if (!share.files.length) {
    setStatus(share.building ? '还在准备图片，稍等一秒再点' : '没有可保存的分段', 'warn');
    return;
  }
  if (!canShareFiles()) {           // 桌面 Chrome / 微信内置浏览器等：走长按保存
    openGalleryFallback();
    setStatus('长按任意一张图片即可保存（电脑上点「下载」）');
    return;
  }
  try {
    await navigator.share({
      files: share.files,
      title: `切好的 ${share.files.length} 段`,
    });
    setStatus(`已交给系统：在弹出的面板里选「存储 ${share.files.length} 项」就进相册了`);
  } catch (err) {
    if (err && err.name === 'AbortError') return;   // 用户自己取消
    console.warn('share 失败，改用长按保存', err);
    openGalleryFallback();
  }
}

/** 分享不可用时的兜底：把大图列出来让人长按保存 */
function openGalleryFallback(list) {
  const files = Array.isArray(list) && list.length ? list : share.files;
  el.galleryList.innerHTML = '';
  files.forEach((f, i) => {
    const box = document.createElement('figure');
    const im = document.createElement('img');
    if (inAppBrowser) {
      // 微信/QQ 的 X5 内核长按保存对 blob: 不稳定，改用 data: URL（容量够、能长按存）
      const fr = new FileReader();
      fr.onload = () => { im.src = String(fr.result); };
      fr.readAsDataURL(f);
    } else {
      im.src = URL.createObjectURL(f);
    }
    im.alt = `第 ${i + 1} 段`;
    im.loading = 'lazy';
    const cap = document.createElement('figcaption');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = `下载到文件`;
    btn.addEventListener('click', () => download(f, f.name));
    cap.className = 'cap';
    cap.textContent = `第 ${String(i + 1).padStart(2, '0')} 段 · 长按这张图 → 保存到相册 · `;
    cap.appendChild(btn);
    box.append(im, cap);
    el.galleryList.appendChild(box);
  });
  if (typeof el.dlgGallery.showModal === 'function') el.dlgGallery.showModal();
  else el.dlgGallery.setAttribute('open', '');
  try { window.history.pushState({ stage: 'gallery' }, ''); } catch (_) { /* ignore */ }
  document.documentElement.dataset.stage = 'gallery';
}

/* ---------------- 事件绑定 ---------------- */
el.drop.addEventListener('click', () => el.file.click());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.file.click();
  }
});
el.file.addEventListener('change', () => {
  if (el.file.files && el.file.files[0]) openFile(el.file.files[0]);
});

['dragenter', 'dragover'].forEach((t) => {
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('hot'); });
  el.editor.addEventListener(t, (e) => { e.preventDefault(); });
});
['dragleave', 'drop'].forEach((t) => {
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('hot'); });
  el.editor.addEventListener(t, (e) => e.preventDefault());
});
el.drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});
el.editor.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) openFile(f);
      break;
    }
  }
});

el.gap.addEventListener('input', () => {
  S.gapRatio = Number(el.gap.value) / 100;
  el.outGap.textContent = S.gapRatio.toFixed(2);
});
el.gap.addEventListener('change', () => { if (S.result) runAnalyze(); });

// 「这页几道题」：填了就按最大的 K-1 个空白切，清空就回到自动
const parseCount = () => {
  const v = Math.round(Number(el.count.value));
  return Number.isFinite(v) && v >= 2 && v <= 20 ? v : 0;
};
el.count.addEventListener('change', () => {
  S.count = parseCount();
  if (S.result) runAnalyze();
});

el.pad.addEventListener('input', () => {
  S.pad = Number(el.pad.value);
  el.outPad.textContent = String(S.pad);
});
el.pad.addEventListener('change', () => { if (S.result) renderList(); });

function backToDrop() {
  document.documentElement.dataset.stage = 'drop';
  el.editor.hidden = true;
  el.drop.hidden = false;
  el.file.value = '';
  S.bmp = null;
  S.base = null;
  S.result = null;
  share.files = [];
  share.dirty = true;
  setStatus('');
  renderWarnings([]);
}

el.btnBack.addEventListener('click', () => {
  if (window.history.state && window.history.state.stage === 'editor') window.history.back();  // 让浏览器返回栈同步，不然后面按返回会跳两层
  else backToDrop();
});

/* 手机返回键：面板 → 关面板；编辑器 → 回选图页；选图页才真的离开网站 */
window.addEventListener('popstate', (ev) => {
  const stage = (ev.state && ev.state.stage) || '';
  document.documentElement.dataset.stage = stage || 'drop';
  if (el.dlgGallery && el.dlgGallery.open) {
    el.dlgGallery.close();
    if (stage === 'editor') return;
  }
  if (stage !== 'editor') backToDrop();
});

el.btnAuto.addEventListener('click', () => { if (S.result) runAnalyze(); });

el.btnAdd.addEventListener('click', () => {
  if (!S.result) return;
  const [top, bottom] = contentBounds();
  const mid = Math.round((top + bottom) / 2);
  const taken = S.dividers.some((y) => Math.abs(y - mid) < 6);
  snapshot();
  S.dividers.push(taken ? mid + 12 : mid);
  render();
  syncStatus();
});

el.overlay.addEventListener('click', (e) => {
  if (!S.result) return;
  if (e.target.closest('.line')) return;
  const rect = el.overlay.getBoundingClientRect();
  const y = Math.round(((e.clientY - rect.top) / rect.height) * S.analysis.height);
  const [top, bottom] = contentBounds();
  if (y <= top + 6 || y >= bottom - 6) return;
  if (S.dividers.some((d) => Math.abs(d - y) < 6)) return;
  snapshot();
  S.dividers.push(y);
  render();
  syncStatus();
});

el.btnZip.addEventListener('click', exportZip);
if (el.dlgZip) el.dlgZip.addEventListener('click', exportZip);
if (el.dlgAll) el.dlgAll.addEventListener('click', async () => {
  // 逐张触发下载：Chrome/安卓浏览器会全部存进「下载」，相册的「下载」相册里能看到
  for (let i = 0; i < share.files.length; i++) {
    download(share.files[i], share.files[i].name);
    await new Promise((r) => setTimeout(r, 350));
  }
  setStatus(`已请求下载 ${share.files.length} 张：会进「下载/Download」，相册的「下载」相册可见`);
});
el.btnSave.addEventListener('click', saveToGallery);
el.dlgClose.addEventListener('click', () => el.dlgGallery.close());
// 用「关闭」按钮退出面板时，把压进去的那层历史也退掉，否则返回键会先空按一次
el.dlgGallery.addEventListener('close', () => {
  if (window.history.state && window.history.state.stage === 'gallery') window.history.back();
});
el.dlgGallery.addEventListener('click', (e) => { if (e.target === el.dlgGallery) el.dlgGallery.close(); });
el.btnUndo.addEventListener('click', undo);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    if (!history.length) return;
    e.preventDefault();
    undo();
  }
});

el.outGap.textContent = S.gapRatio.toFixed(2);
el.outPad.textContent = String(S.pad);

// 方便本地调试 / 自动化验收（不参与界面逻辑）
window.__splitter = {
  S, DEFAULTS, regions, exportZip, regionToBlob, contentBounds,
  async selfTest() {
    const rs = regions();
    const checks = [];
    const files = [];
    for (let i = 0; i < rs.length; i++) {
      const blob = await regionToBlob(rs[i]);
      const buf = new Uint8Array(await blob.arrayBuffer());
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
      checks.push({ i: i + 1, bytes: buf.length, isJpeg });
      files.push({ name: `第${String(i + 1).padStart(2, '0')}段.jpg`, data: buf });
    }
    const zip = makeZip(files);
    return {
      segments: rs.length,
      checks,
      zipBytes: zip.length,
      zipSig: [zip[0], zip[1], zip[2], zip[3]],
      eocdSig: Array.from(zip.slice(zip.length - 22, zip.length - 18)),
    };
  },
};
