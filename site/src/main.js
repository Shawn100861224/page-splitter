/**
 * main.js — 页面交互：选图 → 自动分区 → 手改分界 → 导出 ZIP
 * 全部在本机完成，不发任何网络请求。
 */
import { analyze, DEFAULTS } from './segment.js?v=19';
import {
  loadBitmap, downscale, canvasToGray, cropRegion, canvasToJpegBlob, bitmapSize, rotate90,
} from './imageio.js';
import { makeZip } from './zipstore.js';

document.documentElement.dataset.build = 'v13-hist';

const $ = (id) => document.getElementById(id);

/* 内置浏览器（微信/QQ）没有 Web Share、也写不进相册：单独给提示，别让用户以为能一键存图 */
const UA = navigator.userAgent;
const FORCE_MOBILE = new URLSearchParams(location.search).has('mobile');
const inAppBrowser = /MicroMessenger|QQ\/|QQBrowser|Weibo/i.test(UA)
  || new URLSearchParams(location.search).has('inapp');   // ?inapp=1 用来在本机复现提示

// 在微信/QQ 里打开时，页首先给一条提示——这一条决定大多数人能不能存进相册。
// 别指望他滑到对话区下面的黄色说明，那已经太晚了：他会在"文件"里找不到图。
{
  const bar = document.getElementById('inapp-bar');
  if (bar && inAppBrowser) {
    bar.hidden = false;
    bar.innerHTML = '你现在是在微信 / QQ 里打开，<b>这里存不进相册</b>：点右上角 <b>⋯</b> → <b>在浏览器打开</b>，再点「保存到相册」。';
  }
}

// 首页「适合 / 不适合」：宽屏展开，手机上收起（手机上首屏要留给选图和按钮）
{
  const fit = document.getElementById('fit-details');
  if (fit && window.matchMedia('(min-width: 720px)').matches) fit.open = true;
}

const el = {
  drop: $('drop'), file: $('file'), btnSample: $('btn-sample'), sampleLine: document.querySelector('.sample-line'),
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
  el.btnZip.disabled = true;
  // 48MP 相机原图能到 12MB 以上，解码要几秒；先说明一下，别让人以为点坏了
  const mb = file.size / (1024 * 1024);
  setStatus(mb >= 12 ? `这张 ${mb.toFixed(0)}MB，读进来要几秒，别急着再点一次…` : '');
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
    if (el.sampleLine) el.sampleLine.hidden = true;
    el.editor.hidden = false;
    drawPreview();
    // 分析是同步的：先让浏览器把这一帧画出来，再算，否则用户看到的是「点了没反应」
    setStatus('分析中…');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    runAnalyze();
    if (el.uaTip) el.uaTip.hidden = !inAppBrowser;
    try { window.history.pushState({ stage: 'editor' }, ''); } catch (_) { /* 老浏览器忽略 */ }
    document.documentElement.dataset.stage = 'editor';
  } catch (err) {
    console.error(err);
    // 原来直接把浏览器抛的英文内部错误拼进界面；状态条现在选图页也看得见了，更得说人话
    setStatus('这张图读不出来：可能不是图片，也可能文件损坏了。换一张试试。', 'warn');
    if (el.sampleLine) el.sampleLine.hidden = false;   // 失败要回到干净的空态，示例入口也该回来
    el.file.value = '';                                // 不清空的话，同一个文件重选不会再触发 change
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

/**
 * 分界线能放的范围：从内容顶到「整页底部」，不是到最后一个墨迹带。
 * 卡在墨迹带底部时，想把最后一段往下扩一点（多留空白）会拖不动，
 * 用户只会觉得红线坏了——这条限制在实操里弊大于利。
 */
function dividerBounds() {
  const [top] = contentBounds();
  const hi = Math.max(top + 8, S.analysis.height - 4);
  return [Math.min(top + 4, hi - 4), hi];
}

/**
 * 分界线分两种角色：内容上方的才是"切分线"，落在最后一个墨迹带下方的只当"末段底"。
 * v39 放开拖到页底之后，一条线既当分界线又当末段底，于是出现「红线还在画、段数却少一段」
 * ——单线拖到内容下方时 2 段会静默变成 1 段。这里把两种角色分开：切分线数量 + 1 恒等于段数。
 */
function splitDividers() {
  const [top, bottom0] = contentBounds();
  const H = S.analysis.height;
  const ds = S.dividers.filter((y) => y > top && y < H - 2).sort((a, b) => a - b);
  const cuts = [];
  let end = bottom0;
  for (const y of ds) {
    if (y > bottom0 + 2) end = Math.max(end, y);   // 内容下方：只把末段往下延长
    else cuts.push(y);
  }
  return { cuts, end, hasEnd: end > bottom0 + 2 };
}

function regions() {
  const [top] = contentBounds();
  const { cuts, end } = splitDividers();
  const ys = [top, ...cuts, end];
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
  const { hasEnd } = splitDividers();
  const endTip = hasEnd ? ' · 灰点线是页底，不参与切分' : '';
  // 自动一段都没切出来：多半是空白页/纯色截图/拍糊了。
  // 这时兜底显示整页，别让状态栏说成"手工调整：自动 0 段"——用户没动过手，看了一脸问号。
  if (auto === 0) {
    setStatus('没找到文字：整页空白、纯色或拍糊了。换一张，或在预览上点空白处自己加线', 'warn');
  } else {
    setStatus(`${n} 段${extra}${endTip}` + (risky ? ` · ${risky} 处间距接近阈值，建议核对` : ''), risky ? 'warn' : '');
  }
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
  const [, contentBottom] = contentBounds();
  S.dividers.forEach((y, i) => {
    const line = document.createElement('div');
    // 内容下方这条不切分，只是把末段延到页底；画成灰点线，别让人以为它会切开
    const isEnd = y > contentBottom + 2;
    line.className = isEnd ? 'line end' : 'line';
    line.style.top = pct(y);
    line.tabIndex = 0;
    line.setAttribute('role', 'slider');
    line.setAttribute('aria-label', isEnd
      ? '页底边界（不参与切分），上下方向键微调，Delete 删除'
      : `分界线 ${i + 1}，上下方向键微调，Delete 删除`);
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
        const [lo, hi] = dividerBounds();
        S.dividers[i] = clamp(y + (e.key === 'ArrowUp' ? -step : step), lo, hi);
        render();
        syncStatus();   // 键盘微调也要更新段数与「页底」提示，别只刷列表
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
    const [lo, hi] = dividerBounds();
    const next = clamp(Math.round(y), lo, hi);
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
    // 宽必须跟导出一致：横拍时 S.base 是摆正后的图，S.bmp 还横着，用错会宽高互换
    const srcW = S.base || S.bmp;
    const wPx = srcW ? Math.round(srcW.width) : 0;
    span.textContent = `${wPx} × ${hPx} px`;
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

let zipBusy = false;

async function exportZip(ev) {
  if (zipBusy) return;
  const rs = regions();
  if (!rs.length) return;
  zipBusy = true;
  // 工具栏和弹窗里各有一个入口，两处都要锁：连点会并发打两遍包，下两个同名文件
  const trigger = ev && ev.currentTarget && ev.currentTarget.tagName === 'BUTTON' ? ev.currentTarget : el.btnZip;
  const label = trigger.textContent;
  el.btnZip.disabled = true;
  if (el.dlgZip) el.dlgZip.disabled = true;
  trigger.textContent = '打包中…';
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
    zipBusy = false;
    el.btnZip.disabled = false;
    if (el.dlgZip) el.dlgZip.disabled = false;
    trigger.textContent = label;
  }
}


/* ---------------- 保存到相册 ----------------
 * iPhone 上 <a download> 只会落到「文件」，进不了相册。
 * 进相册只有两条路：Web Share（系统分享面板 →「存储 N 项」）或长按图片保存。
 * 分享必须在用户手势里同步调用，所以图片提前在后台缓存好，点击时直接交出 File[]。
 */
const share = { files: [], building: false, seq: 0, timer: 0, done: 0 };

/** 手机/平板：用系统分享面板才能进相册，桌面浏览器落"下载"文件夹 */
function isMobile() {
  if (FORCE_MOBILE) return true;   // ?mobile=1：在电脑上验手机端分支
  return matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * 能不能把这些文件交给系统分享面板。
 * 注意必须按「实际张数」探测：很多安卓浏览器支持分享 1 张、不支持一次分享多张，
 * 只用一个文件探测会误判成支持，真发的时候系统只处理第一张（用户看到的「全部保存」
 * 变成一张一张选，就是这么来的）。
 */
function canShareFiles(n = 1) {
  try {
    if (!navigator.canShare) return false;
    const mk = () => new File([new Uint8Array([0])], 'p.jpg', { type: 'image/jpeg' });
    const files = n > 1 ? [mk(), mk()] : [mk()];
    return !!navigator.canShare({ files });
  } catch (e) {
    return false;
  }
}

function updateSaveBtn() {
  if (!el.btnSave) return;
  const n = regions().length;
  const touch = isMobile();
  // 电脑上没有相册可存，主按钮让位给真正能用的「导出 ZIP」，别把人引到长按面板
  el.btnSave.hidden = !touch;
  el.btnZip.classList.toggle('primary', !touch);
  el.btnSave.disabled = !n;
  if (share.building && n && share.done < n) {
    el.btnSave.textContent = `准备中 ${share.done}/${n}…`;
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
    if (seq === share.seq) { share.files = out.slice(); share.done = out.length; updateSaveBtn(); }
  }
  if (seq !== share.seq) return;
  share.files = out;
  share.done = out.length;
  share.building = false;
  updateSaveBtn();
}

function scheduleShareFiles(delay = 250) {
  clearTimeout(share.timer);
  // 电脑上没有系统分享面板，File[] 根本用不到；别在后台白编码一遍全分辨率图
  if (!isMobile()) { share.files = []; share.building = false; share.done = 0; updateSaveBtn(); return; }
  share.building = true;
  share.files = [];
  share.done = 0;
  updateSaveBtn();
  share.timer = setTimeout(buildShareFiles, delay);
}

async function saveToGallery() {
  if (!S.result) return;
  if (!share.files.length) {
    setStatus(share.building ? '还在准备图片，稍等一秒再点' : '没有可保存的分段', 'warn');
    return;
  }
  const n = share.files.length;
  if (!canShareFiles(n)) {          // 系统面板吃不下这么多张（很多安卓浏览器只支持单张）
    openGalleryFallback();
    setStatus(canShareFiles(1)
      ? `这个浏览器不能一次把 ${n} 张交给系统相册，只能逐张存：长按图片，或点每张下面的「存到相册」`
      : '长按任意一张图片即可保存（电脑上点「下载」）', 'warn');
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

/* 示例图：第一次来的人手上往往没有作业照片，不给他一条能走的路，页面就到此为止 */
if (el.btnSample) {
  const idle = el.btnSample.textContent;
  el.btnSample.addEventListener('click', async () => {
    el.btnSample.disabled = true;
    el.btnSample.textContent = '正在载入示例…';
    try {
      const r = await fetch('sample-work.jpg');
      if (!r.ok) throw new Error(String(r.status));
      const b = await r.blob();
      await openFile(new File([b], '示例习题.jpg', { type: 'image/jpeg' }));
    } catch (err) {
      setStatus('示例图没载入成功，直接选你自己的照片就行', 'warn');
    } finally {
      el.btnSample.disabled = false;
      el.btnSample.textContent = idle;
    }
  });
}
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
  if (el.sampleLine) el.sampleLine.hidden = false;
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

/** 用户是否动过分界线（和自动结果不一致）。用于返回键确认，防止滑动误触丢掉手动调整。 */
function editedSinceAuto() {
  if (!S.result) return false;
  const auto = S.result.regions.slice(1).map((r) => r[0]);
  if (auto.length !== S.dividers.length) return true;
  return S.dividers.some((y, i) => Math.abs(y - auto[i]) > 1);
}

/* 手机返回键：面板 → 关面板；编辑器 → 回选图页；选图页才真的离开网站 */
window.addEventListener('popstate', (ev) => {
  const stage = (ev.state && ev.state.stage) || '';
  if (stage !== 'editor' && editedSinceAuto()) {
    try { history.pushState({ stage: 'editor' }, ''); } catch (_) { /* ignore */ }
    if (!window.confirm('你手动调过分界线，返回会丢掉这些调整。\n确定要退出吗？')) return;
  }
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
  const [lo, hi] = dividerBounds();
  if (y <= lo + 2 || y >= hi - 2) return;
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
