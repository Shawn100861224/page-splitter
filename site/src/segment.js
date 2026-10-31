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
  const colCount = new Uint32Array(sw); // 每列墨点数，用来判"中间有无整列空白"（双栏的沟）
  for (let y = 0; y < H; y++) {
    bgModel.fillRow(y, bgRow);
    const rowOff = y * W;
    let c = 0;
    for (let x = 0; x < sw; x++) {
      if (gray[rowOff + xs0 + x] / (bgRow[xs0 + x] || 1) < p.inkRatio) { c++; colCount[x]++; }
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

  // 4.5) xs 扩到真实墨迹列范围：分析窗只保证"够密的那一段"，
  // 而导出/缩略图按 xs 裁 —— 窗外的字会被整片切掉（实测一张 2355 宽的横条，
  // 窗只到 2072，最右边一列矩阵数字没了）。这里用同一套局部对比判据找"有任何墨"的列。
  if (bands.length) {
    const rowA = bands[0][0];
    const rowB = bands[bands.length - 1][1];
    const span = Math.max(1, rowB - rowA);
    // 1.2% 行数起步：桌面/阴影列只有零散几个像素，真文字列远高于此
    const need = Math.max(4, Math.round(span * 0.012));
    const cnt = new Uint16Array(W);
    for (let y = rowA; y < rowB; y++) {
      bgModel.fillRow(y, bgRow);
      const rowOff = y * W;
      for (let x = 0; x < W; x++) {
        if (cnt[x] > need) continue; // 已经够数就不再数
        if (gray[rowOff + x] / (bgRow[x] || 1) < p.inkRatio) cnt[x]++;
      }
    }
    let xa = -1;
    let xb = -1;
    for (let x = 0; x < W; x++) {
      if (cnt[x] >= need) { if (xa < 0) xa = x; xb = x; }
    }
    if (xa >= 0) {
      xs0 = Math.min(xs0, xa);
      xs1 = Math.max(xs1, xb + 1);
    }
  }

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
  // 先算所有间距，再看"间距本身能不能分出两档"——印刷正文的行距是均匀的，
  // 只按 band 高的比例切会把每行都切成一段；题目之间的间距则明显跳一档。
  const allGaps = [];
  for (let i = 1; i < work.length; i++) allGaps.push(work[i][0] - work[i - 1][1]);
  const { thr: gapThresh, mode: thrMode } = pickThreshold(allGaps, med, p);
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

  // 6) 两类"这工具干不了"的页面，早点说清楚，别等用户导出后才发现
  const gutter = findGutter(colCount);
  const dense = bands.length >= 25 && med < 0.02 * H;
  // 整页粘成一两块：多半是纸面反光/阴影/墨太淡，行间空白没被识别出来
  const glued = bands.length <= 2 && med > 0.12 * H;

  // 顺序=重要性：先说"这页根本不适合"，再说"这儿你得看一眼"
  const warnings = [];
  if (gutter) {
    warnings.push('疑似双栏页面：它只按单栏横排切，右栏会被并进左栏的段落，建议分两次或换工具');
  }
  if (glued) {
    warnings.push('几乎没有识别到行间空白（整页像一整块）：可能是光线太暗、纸面反光或墨太淡，建议重拍或换个角度');
  }
  if (dense) {
    warnings.push(`疑似印刷密排正文（${bands.length} 条细带）：行距与字高接近时会被按行切开，需逐行合并或换工具`);
  }
  // 有多行却只切出 1 段：说明整页空隙都差不多，没找到"题间"那档更大的空白。
  // 不提示的话用户会以为切好了，导出的其实是一整张长图。
  if (regions.length === 1 && bands.length >= 4 && !glued && !gutter) {
    warnings.push('只切出 1 段：没找到明显的题间空白（各处空隙差不多大）。把「灵敏度」往左拖一点再试，或直接点预览里的空白处手动加分界线');
  }
  // 已经说了"不适合"的时候，"哪几处间距可疑"就是噪音
  if (risky.length && !gutter && !glued) {
    warnings.push(`${risky.length} 处间距接近切分阈值（±30%），自动切分可能不准，建议手动核对`);
  }

  return {
    paper, xs: [xs0, xs1], bands, regions, gaps, risky, gutter,
    medianBand: med, gapThresh, thrMode, rowThresh: rowThr,
    params: p, profile: sm, warnings,
  };
}

/**
 * 阈值怎么定：先看这页的间距有没有"明显两档"。
 *
 * 印刷/截图页的行距是一档、题间是一档，两档之间是**跳跃式**（实测 20px → 158px，7.9 倍）；
 * 手写页的题间距挤在行距上面一点点（实测 51px → 55px，1.08 倍），没有跳跃。
 * 所以在排序后的 gap 里找最大跳跃 g[i+1]/g[i]：≥2.2 倍、且上面至少还有 2 个 gap，
 * 才认为存在两档，阈值取跳跃处中点；否则退回 med × gapRatio（手写页靠这条）。
 *
 * 只按基准阈值时，印刷正文会被按行切（实测 15 行 → 15 段，误切 3 倍）。
 */
export function pickThreshold(gaps, med, p) {
  const base = Math.max(2, med * p.gapRatio);
  const n = gaps.length;
  if (n < 5) return { thr: base, mode: 'base' };
  // 只在"够宽的间距"里找跳跃：带内碎缝（2~3px）会让比值虚高，把阈值压到十几像素，
  // 结果整页按行切。med*0.2 以下的一律不参与跳跃判定（阈值计算仍用全部 gaps）。
  const floor = Math.max(2, med * 0.35);
  const cand = gaps.filter((v) => v >= floor).sort((a, b) => a - b);
  const m = cand.length;
  if (m < 3) return { thr: base, mode: 'base' };
  const g = Float64Array.from(cand);
  let at = -1, bestRatio = 0;
  for (let i = 0; i < m - 1; i++) {
    const r = g[i + 1] / Math.max(1, g[i]);
    if (r > bestRatio) { bestRatio = r; at = i; }
  }
  if (at < 0 || bestRatio < 2.2 || m - 1 - at < 2) return { thr: base, mode: 'base' };
  return { thr: Math.max(base, (g[at] + g[at + 1]) / 2), mode: 'two-tier' };
}

/**
 * 找页面中间的"空白沟"：整列几乎没有墨、宽度够、左右两侧都各自有足够多的墨。
 * 命中就是双栏排版——单栏切法在这种页面上必然切错，宁可提前警告。
 */
function findGutter(colCount) {
  const n = colCount.length;
  if (n < 40) return null;
  let max = 0;
  for (let i = 0; i < n; i++) if (colCount[i] > max) max = colCount[i];
  if (max <= 0) return null;
  const quiet = max * 0.06;
  const minGap = Math.max(6, Math.round(n * 0.05));
  const from = Math.floor(n * 0.2), to = Math.floor(n * 0.8);
  let start = -1;
  for (let i = from; i < to; i++) {
    const empty = colCount[i] <= quiet;
    if (empty && start < 0) start = i;
    if ((!empty || i === to - 1) && start >= 0) {
      const end = empty ? i + 1 : i;
      if (end - start >= minGap) {
        let left = 0, right = 0;
        for (let k = 0; k < start; k++) left += colCount[k];
        for (let k = end; k < n; k++) right += colCount[k];
        const total = left + right;
        if (total > 0 && left / total > 0.2 && right / total > 0.2) {
          return { from: start, to: end };
        }
      }
      start = -1;
    }
  }
  return null;
}

/** 浮点数组分位（0..1） */
export function percentileOfFloat(arr, q) {
  const n = arr.length;
  if (!n) return 0;
  const copy = Float64Array.from(arr).sort();
  const idx = Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))));
  return copy[idx];
}
