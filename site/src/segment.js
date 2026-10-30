/**
 * segment.js — 文档照片自动分区（纯计算，无 DOM 依赖）
 *
 * 输入：{ gray: Uint8Array|Float32Array(宽*高), width, height }
 * 输出：{ paper, xs, bands, regions, medianBand, gapThresh, params, warnings }
 *
 * 坐标一律是"图像像素"，原点左上。bands/regions 是 [y0, y1) 半开区间。
 * 算法与 tools/split_blocks.py（v2）逐行对应，改动必须两边同步，否则
 * test/fixtures 的回归会挂。
 */

export const DEFAULTS = Object.freeze({
  x0: 0.12,           // 列扫描起点（比例）
  x1: 0.88,           // 列扫描终点（比例）
  thrRatio: 0.40,     // 列过滤墨阈值 = 0.40 × 纸面90分位
  colInkMax: 0.45,    // 整列墨占比超过它的列直接丢掉（桌面/装订阴影）
  bgDiv: 16,          // 背景估计下采样倍数
  inkRatio: 0.55,     // 墨 = 灰度 / 二维背景 < 0.55
  smoothRatio: 0.004, // 行剖面平滑窗 = 0.4% 图高
  rowThreshRatio: 0.012, // 行阈值下限 = 页宽 × 0.012
  rowThreshP99: 0.05,    // 行阈值 = max(下限, 行剖面 99 分位 × 0.05)
  minBandRatio: 0.006,   // 最短墨迹带 = 0.6% 图高
  gapRatio: 0.36,        // 间距 > 该值 × 中位带高 就切开
  smallBandRatio: 0.5,   // 高度 < 中位带高×0.5 视为小碎带，并到更近一侧
  edgeY: 0.85,           // 页面边缘线剔除：只在下部 15% 找
  edgeMaxH: 0.02,        // 边缘线高度上限 = 2% 图高
  edgeCoverage: 0.60,    // 边缘线横向覆盖 ≥ 60% 页宽
});

/** RGBA → 灰度（Uint8），Rec.601 权重，与 Python 版 PIL 的 "L" 一致 */
export function rgbaToGray(rgba, width, height) {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114 + 500) / 1000;
  }
  return out;
}

/** 直方图取分位（0..255） */
function percentile(gray, q) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const target = Math.floor(gray.length * q / 100);
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > target) return v;
  }
  return 255;
}

/**
 * 二维背景模型：先把图缩到 1/bgDiv 求均值，再按行双线性放大。
 * 不缓存整张放大的背景——12MP 照片那要 48MB Float32，手机上会炸；
 * 改成 fillRow(y, out) 逐行填，内存只多一行。
 */
function backgroundModel(gray, width, height, bgDiv) {
  const bw = Math.max(4, Math.floor(width / bgDiv));
  const bh = Math.max(4, Math.floor(height / bgDiv));
  const small = new Float32Array(bw * bh);
  const cnt = new Float32Array(bw * bh);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(bh - 1, Math.floor(y * bh / height));
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(bw - 1, Math.floor(x * bw / width));
      const k = sy * bw + sx;
      small[k] += gray[rowOff + x];
      cnt[k] += 1;
    }
  }
  for (let i = 0; i < small.length; i++) small[i] = small[i] / Math.max(1, cnt[i]);

  const fx = new Float32Array(width);
  const fx0 = new Int32Array(width);
  const fwx = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const f = Math.min(bw - 1, Math.max(0, (x + 0.5) * bw / width - 0.5));
    const x0 = Math.floor(f);
    fx0[x] = x0;
    fwx[x] = f - x0;
  }

  return {
    bw, bh, small,
    /** 把第 y 行的背景灰度填进 out（长度 width） */
    fillRow(y, out) {
      const f = Math.min(bh - 1, Math.max(0, (y + 0.5) * bh / height - 0.5));
      const y0 = Math.floor(f);
      const y1 = Math.min(bh - 1, y0 + 1);
      const wy = f - y0;
      const r0 = y0 * bw, r1 = y1 * bw;
      for (let x = 0; x < width; x++) {
        const x0 = fx0[x], wx = fwx[x];
        const x1 = Math.min(bw - 1, x0 + 1);
        const top = small[r0 + x0] + (small[r0 + x1] - small[r0 + x0]) * wx;
        const bot = small[r1 + x0] + (small[r1 + x1] - small[r1 + x0]) * wx;
        out[x] = top + (bot - top) * wy;
      }
    },
  };
}

/** 布尔序列 → [start,end) 区间，短于 minLen 的丢掉 */
function runs(flags, minLen) {
  const out = [];
  let start = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && start < 0) start = i;
    else if (!flags[i] && start >= 0) {
      if (i - start >= minLen) out.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0 && flags.length - start >= minLen) out.push([start, flags.length]);
  return out;
}

/** 含零填充的滑动平均（等价 numpy.convolve mode='same'） */
function smoothProfile(arr, k) {
  const n = arr.length;
  const half = (k - 1) >> 1;
  const out = new Float32Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    out[i] = (pre[b + 1] - pre[a]) / k;
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 上中位数：和 tools/split_blocks.py 的 heights[len//2] 完全一致，两边才可比 */
function medianUpper(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  return s[s.length >> 1];
}

/**
 * 主入口。
 * @param {{gray: Uint8Array|Float32Array, width: number, height: number}} img
 * @param {Partial<typeof DEFAULTS>} options
 */
export function analyze(img, options = {}) {
  const p = { ...DEFAULTS, ...options };
  const { gray, width: W, height: H } = img;
  const paper = percentile(gray, 90);
  const colThr = p.thrRatio * paper;

  // 1) 列区间：整列几乎全是墨（桌面/装订）→ 丢掉，取剩下最长一段
  const lo = Math.floor(W * p.x0), hi = Math.floor(W * p.x1);
  const winW = hi - lo;
  const keepFlags = [];
  for (let x = lo; x < hi; x++) {
    let c = 0;
    for (let y = 0; y < H; y++) if (gray[y * W + x] < colThr) c++;
    keepFlags.push(c / H <= p.colInkMax);
  }
  const colRuns = runs(keepFlags, Math.max(2, Math.floor(winW * 0.15)));
  let xs0 = lo, xs1 = hi;
  if (colRuns.length) {
    let best = colRuns[0];
    for (const r of colRuns) if (r[1] - r[0] > best[1] - best[0]) best = r;
    xs0 = lo + best[0];
    xs1 = lo + best[1];
  }
  const sw = xs1 - xs0;

  // 2) 二维背景 + 墨掩膜
  const bgModel = backgroundModel(gray, W, H, p.bgDiv);
  const bgRow = new Float32Array(W);
  const rowInk = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    bgModel.fillRow(y, bgRow);
    const rowOff = y * W;
    let c = 0;
    for (let x = xs0; x < xs1; x++) {
      if (gray[rowOff + x] / (bgRow[x] || 1) < p.inkRatio) c++;
    }
    rowInk[y] = c;
  }

  // 3) 平滑 + 行阈值
  const k = Math.max(3, (Math.round(H * p.smoothRatio) | 1));
  const sm = smoothProfile(rowInk, k);
  const rowThr = Math.max(sw * p.rowThreshRatio, percentileOfFloat(sm, 0.99) * p.rowThreshP99);
  const minLen = Math.max(2, Math.round(H * p.minBandRatio));
  const flags = new Array(H);
  for (let y = 0; y < H; y++) flags[y] = sm[y] > rowThr;
  let bands = runs(flags, minLen).map(([a, b]) => [a, b]);

  // 4) 剔除页面边缘/阴影细线（照片下半部横贯页宽的薄带，不是文字）
  bands = bands.filter(([y0, y1]) => {
    const h = y1 - y0;
    if (h > p.edgeMaxH * H || y0 < p.edgeY * H) return true; // 不在边缘区 → 保留
    // 该带内每列是否有墨：逐行算（背景逐行取），只留一列覆盖表
    const covered_cols = new Uint8Array(sw);
    for (let y = y0; y < y1; y++) {
      bgModel.fillRow(y, bgRow);
      const rowOff = y * W;
      for (let x = 0; x < sw; x++) {
        if (!covered_cols[x] && gray[rowOff + xs0 + x] / (bgRow[xs0 + x] || 1) < p.inkRatio) covered_cols[x] = 1;
      }
    }
    let covered = 0;
    for (let x = 0; x < sw; x++) if (covered_cols[x]) covered++;
    return covered / sw < p.edgeCoverage; // 横向覆盖不足 60% → 是文字带，保留
  });

  // 5) 小碎带并到更近一侧 → 算间距 → 分区
  const bandHeights = bands.map(([a, b]) => b - a);
  let med = medianUpper(bandHeights); // 与 Python 同口径（len//2），两边才会归位同一批碎带
  let work = bands.map(([a, b]) => [a, b]);
  if (work.length >= 3) {
    for (let guard = 0; guard < 8; guard++) {
      if (work.length < 3) break;
      let idx = 0;
      for (let i = 1; i < work.length; i++) {
        if (work[i][1] - work[i][0] < work[idx][1] - work[idx][0]) idx = i;
      }
      if (work[idx][1] - work[idx][0] >= p.smallBandRatio * med) break;
      const up = idx > 0 ? work[idx][0] - work[idx - 1][1] : null;
      const dn = idx < work.length - 1 ? work[idx + 1][0] - work[idx][1] : null;
      if (up === null || (dn !== null && dn < up)) {
        work[idx + 1][0] = work[idx][0];
      } else {
        work[idx - 1][1] = work[idx][1];
      }
      work.splice(idx, 1);
    }
  }

  // 切分基准：小碎带归位后再取"上中位数"。用原始带高会随碎带数量漂（实测 124 vs 143，
  // 阈值差 7px 就够把一道题切成两段），归位后 JS 与 Python 落到同一档。
  med = medianUpper(work.map(([a, b]) => b - a));
  const gapThresh = Math.max(2, med * p.gapRatio);
  const regions = [];
  const gaps = [];
  const risky = [];
  if (work.length) {
    regions.push([work[0][0], work[0][1]]);
    for (let i = 1; i < work.length; i++) {
      const g = work[i][0] - work[i - 1][1];
      gaps.push(g);
      const ratio = gapThresh ? g / gapThresh : 0;
      if (ratio >= 0.7 && ratio <= 1.3) risky.push({ gap: g, ratio, at: work[i - 1][1] });
      if (g > gapThresh) regions.push([work[i][0], work[i][1]]);
      else regions[regions.length - 1][1] = work[i][1];
    }
  }

  return {
    paper, xs: [xs0, xs1], bands, regions, gaps, risky,
    medianBand: med, gapThresh, rowThresh: rowThr,
    params: p, profile: sm,
    warnings: risky.length
      ? [`${risky.length} 处间距接近切分阈值（±30%），自动切分可能不准，建议手动核对`]
      : [],
  };
}

/** 浮点数组分位（0..1） */
export function percentileOfFloat(arr, q) {
  const n = arr.length;
  if (!n) return 0;
  const copy = Float64Array.from(arr).sort();
  const idx = Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))));
  return copy[idx];
}
