/**
 * main.js — 页面交互：选图 → 自动分区 → 手改分界 → 导出 ZIP
 * 全部在本机完成，不发任何网络请求。
 */
import { analyze, DEFAULTS } from './segment.js';
import {
  loadBitmap, downscale, canvasToGray, cropRegion, canvasToJpegBlob, bitmapSize,
} from './imageio.js';
import { makeZip } from './zipstore.js';

const $ = (id) => document.getElementById(id);

const el = {
  drop: $('drop'), file: $('file'),
  editor: $('editor'),
  gap: $('gap'), pad: $('pad'), outGap: $('out-gap'), outPad: $('out-pad'),
  btnBack: $('btn-back'), btnAuto: $('btn-auto'), btnAdd: $('btn-add'), btnZip: $('btn-zip'),
  status: $('status'),
  stage: $('stage'), preview: $('preview'), overlay: $('overlay'),
  bands: $('bands'), lines: $('lines'), list: $('list'),
};

/** 全局状态（一次性页面，不做框架） */
const S = {
  bmp: null,
  analysis: null,   // { canvas, scale, width, height }
  gray: null,
  result: null,
  dividers: [],     // 内部分界线的 y（分析坐标系）
  pad: Number(el.pad.value),
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
    S.analysis = downscale(S.bmp);
    S.gray = canvasToGray(S.analysis.canvas);
    el.drop.hidden = true;
    el.editor.hidden = false;
    drawPreview();
    runAnalyze();
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
  S.result = analyze(S.gray, { gapRatio: S.gapRatio });
  S.dividers = S.result.regions.slice(1).map((r) => r[0]);
  const ms = Math.round(performance.now() - t0);
  const n = regions().length;
  const warn = S.result.warnings[0];
  setStatus(`${n} 段 · ${S.result.bands.length} 条墨迹带 · ${ms}ms`
    + (warn ? ` · ${warn}` : ''), warn ? 'warn' : '');
  render();
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
      S.dividers.splice(i, 1);
      render();
      syncStatus();
    });

    line.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 12 : 2;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const [top, bottom] = contentBounds();
        S.dividers[i] = clamp(y + (e.key === 'ArrowUp' ? -step : step), top + 4, bottom - 4);
        render();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
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

  line.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
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

  const end = () => { dragging = false; if (moved) { render(); syncStatus(); } };
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
    btn.textContent = '下载';
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
  const { canvas } = cropRegion(S.bmp, yRange, S.analysis.scale, box());
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
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const blob = await regionToBlob(yRange);
    download(blob, `第${String(index + 1).padStart(2, '0')}段.jpg`);
  } catch (err) {
    console.error(err);
    setStatus(`导出失败：${err.message || err}`, 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = '下载';
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

el.pad.addEventListener('input', () => {
  S.pad = Number(el.pad.value);
  el.outPad.textContent = String(S.pad);
});
el.pad.addEventListener('change', () => { if (S.result) renderList(); });

el.btnBack.addEventListener('click', () => {
  el.editor.hidden = true;
  el.drop.hidden = false;
  el.file.value = '';
  S.bmp = null;
  S.result = null;
  setStatus('');
});

el.btnAuto.addEventListener('click', () => { if (S.result) runAnalyze(); });

el.btnAdd.addEventListener('click', () => {
  if (!S.result) return;
  const [top, bottom] = contentBounds();
  const mid = Math.round((top + bottom) / 2);
  const taken = S.dividers.some((y) => Math.abs(y - mid) < 6);
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
  S.dividers.push(y);
  render();
  syncStatus();
});

el.btnZip.addEventListener('click', exportZip);

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
