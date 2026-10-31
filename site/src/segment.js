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
  gapRatio: 0.36,
  count: 0,              // >0 时按"这页几道题"取最大的 K-1 个空白切        // 间距 > 该值 × 中位带高 就切开
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

  // 2.5) 横线笔记本的格线：整行几乎贯穿页宽的那一行不是字，是印刷横线。
  // 不清掉的话它会让每一行都成为"墨迹带"，结果就是按行切碎（实测深色格线：3 组题切成 19 段）。
  // 只清零行剖面，不动掩膜——横线上压着的手写笔画本来也只有 1~2 行像素受影响。
  const ruledThr = sw * 0.75;
  let ruledRows = 0;
  let runY = [];
  for (let y = 0; y <= H; y++) {
    const hit = y < H && rowInk[y] >= ruledThr;
    if (hit) { runY.push(y); continue; }
    // 只认"细"的高覆盖行组：格线一般 1~6px 厚。厚块是涂黑/大面积阴影，是真内容，别动。
    if (runY.length >= 1 && runY.length <= 6) {
      for (const yy of runY) rowInk[yy] = 0;
      ruledRows += runY.length;
    }
    runY = [];
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
  let { thr: gapThresh, mode: thrMode } = pickThreshold(allGaps, med, p);
  // 用户说了"这页几道题"就按最大的 K-1 个空白切（实测三张真实笔记，理想切点恰好是最大的那几个）；
  // 没说的话走自动阈值这条线。
  const wantCount = Number.isFinite(p.count) && p.count >= 2 ? Math.round(p.count) : 0;
  let regions, gaps, risky;
  const byCount = wantCount >= 2 && work.length > wantCount - 1;
  if (byCount) {
    ({ regions, gaps, risky } = splitByIndices(work, topGapIndices(allGaps, wantCount - 1)));
    thrMode = 'count';
  } else {
    ({ regions, gaps, risky } = splitByThreshold(work, gapThresh));
  }

  // 切得太碎（>=10 段）时再试一档更宽松的阈值：密排手写的题距常常只比行距大一半，
  // 严格两档判据（2.2 倍）会退化成按行切，用户看到几十条红线只能一条条删。
  // 只有段数显著减少（<=71%）才采用，避免把本来正确的细分并粗。
  if (!byCount && regions.length >= 10) {
    let best = null;
    for (const t of relaxedCandidates(allGaps, med, p)) {
      if (t <= gapThresh) continue;
      const alt = splitByThreshold(work, t);
      if (alt.regions.length < 2 || alt.regions.length * 1.4 > regions.length) continue;
      if (!best || alt.regions.length < best.regions.length) best = { ...alt, thr: t };
    }
    if (best) {
      regions = best.regions;
      gaps = best.gaps;
      risky = best.risky;
      gapThresh = best.thr;
      thrMode = 'relaxed';
    }
  }

  // 5.4) 丢掉几乎没墨的段：页底空白、背面透字、页边阴影会被当成一条墨迹带，
  // 切完就成了"第 4 段是一张白纸"。用行墨密度跟本页中位数比，低于 12% 的直接丢弃。
  if (regions.length > 1) {
    const dens = regions.map(([a, b]) => {
      let s = 0;
      for (let y = a; y < b; y++) s += rowInk[y];
      return s / Math.max(1, (b - a) * sw);
    });
    const ref = dens.slice().sort((x, y) => x - y)[dens.length >> 1];
    const keep = regions.filter((_, i) => dens[i] >= ref * 0.12);
    if (keep.length >= 1 && keep.length < regions.length) {
      regions.length = 0;
      regions.push(...keep);
      risky.length = 0;
    }
  }

  // 5.5) 窄片合并（"后悔药"）：段高不到 0.6 × 中位行高，连半行都不到，肯定不是一道题
  // （墨点、横线、纸边阴影造成的假段）。并进间距更小的邻段，直到没有这种碎片。
  // 阈值不敢放大：实测真题里"一道单行短题"只有 0.9 × 行高，判据放到 1.5 倍会把真题也并掉。
  if (!byCount && regions.length >= 3) {
    const merged = mergeNarrowRegions(regions, gaps, med);
    if (merged.length !== regions.length) {
      regions.length = 0;
      regions.push(...merged.regions);
      gaps.length = 0;
      gaps.push(...merged.gaps);
      risky.length = 0;   // 段变了，原来的"间距可疑"位置已经失效
    }
  }

  // 6) 两类"这工具干不了"的页面，早点说清楚，别等用户导出后才发现
  const gutter = findGutter(colCount);
  // 只按带数判断会误伤"细笔迹但切得对"的页面（35 条带却正好 7 段），所以要求实际段数也很多
  const dense = bands.length >= 25 && med < 0.02 * H && regions.length >= 15;
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
  // 切得很碎：这页行距和题距差不多，用户会看到一大堆红线（真实反馈："每张都有这么多红线"）。
  // 给出可操作的两条出路，而不是让他一条条去删。
  if (regions.length >= 10 && !dense && !glued && !gutter) {
    warnings.push(`切得很碎（${regions.length} 段）：这页的行距和题距差不多，把「灵敏度」往左拖再点「重新分区」，也可以点红线右侧的 × 只删掉多余的`);
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

/** 按给定间距阈值把行带合成段（阈值以上的间距就切一刀） */
function splitByThreshold(work, thr) {
  const regions = [];
  const gaps = [];
  const risky = [];
  if (work.length) {
    regions.push([work[0][0], work[0][1]]);
    for (let i = 1; i < work.length; i++) {
      const g = work[i][0] - work[i - 1][1];
      gaps.push(g);
      const ratio = thr ? g / thr : 0;
      if (ratio >= 0.7 && ratio <= 1.3) risky.push({ gap: g, ratio, at: work[i - 1][1] });
      if (g > thr) regions.push([work[i][0], work[i][1]]);
      else regions[regions.length - 1][1] = work[i][1];
    }
  }
  return { regions, gaps, risky };
}

/**
 * 已经切碎时用的候选阈值（只在 >=10 段时尝试）：
 *  1) 宽松两档——跳跃只要 1.6 倍、上面至少 3 个间距；
 *  2) gap 的 90 分位——只切最宽的那一成空隙，天然不会切碎。
 * 谁能让段数显著减少就用谁，都不行就保持原结果。
 */
function relaxedCandidates(gaps, med, p) {
  const base = Math.max(2, med * p.gapRatio);
  const floor = Math.max(2, med * 0.35);
  const out = [];
  const cand = gaps.filter((v) => v >= floor).slice().sort((a, b) => a - b);
  const m = cand.length;
  if (m >= 5) {
    let at = -1, best = 0;
    for (let i = 0; i < m - 1; i++) {
      const r = cand[i + 1] / Math.max(1, cand[i]);
      if (r > best) { best = r; at = i; }
    }
    if (at >= 0 && best >= 1.6 && m - 1 - at >= 3) {
      out.push(Math.max(base, (cand[at] + cand[at + 1]) / 2));
    }
  }
  if (m >= 6) {
    out.push(Math.max(base, cand[Math.min(m - 1, Math.floor(m * 0.9))]));
  }
  return [...new Set(out)].sort((a, b) => b - a);
}

/**
 * 用户直接告诉工具"这页有几道题"时，按**最大的 K-1 个空白**切。
 *
 * 为什么这个信号最可靠：实测三张真实手写笔记（3/3/4 道题），理想切点恰好是
 * 该页最大的 3 个间距——题与题之间总比题内的行距空得多；而"题号"本身
 * 在纸上和正文之间只有 1~10px 缝隙（连写），几何上根本抓不出来（tools/probe_numbers.py 实测 0 命中）。
 * 所以把"认题号"这一步交给人眼（他拍照时本来就知道有几题），工具只负责切得准。
 */
export function splitByIndices(work, cutIdx) {
  const regions = [];
  const gaps = [];
  const risky = [];
  if (work.length) {
    regions.push([work[0][0], work[0][1]]);
    for (let i = 1; i < work.length; i++) {
      const g = work[i][0] - work[i - 1][1];
      gaps.push(g);
      if (cutIdx.has(i - 1)) regions.push([work[i][0], work[i][1]]);
      else regions[regions.length - 1][1] = work[i][1];
    }
  }
  return { regions, gaps, risky };
}

/** 取出最大的 k 个间距的下标（k 超过可用间距数时全部返回） */
export function topGapIndices(gaps, k) {
  return new Set(gaps
    .map((g, i) => ({ g, i }))
    .sort((a, b) => b.g - a.g)
    .slice(0, Math.max(0, Math.min(k, gaps.length)))
    .map(({ i }) => i));
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
/**
 * 窄片合并：段高 < 1.5 × 中位行高 的段不可能是"一道题"，并进间距更小的邻段。
 * 每次都挑"最窄的那一段"先并，并完重新判断，避免一次并错方向。
 * @returns {{regions: number[][], gaps: number[]}}
 */
export function mergeNarrowRegions(regions, gaps, med, limitRatio = 0.6) {
  const cur = regions.map(r => [r[0], r[1]]);
  const g = gaps.slice();
  const limit = Math.max(4, med * limitRatio);
  let guard = 0;
  while (cur.length > 2 && guard++ < 200) {
    let idx = -1;
    let minH = Infinity;
    for (let i = 0; i < cur.length; i++) {
      const h = cur[i][1] - cur[i][0];
      if (h < limit && h < minH) { minH = h; idx = i; }
    }
    if (idx < 0) break;
    let toPrev;
    if (idx === 0) toPrev = false;
    else if (idx === cur.length - 1) toPrev = true;
    else toPrev = (g[idx - 1] ?? Infinity) <= (g[idx] ?? Infinity);
    if (toPrev) {
      cur[idx - 1][1] = cur[idx][1];
      g.splice(idx - 1, 1);
      cur.splice(idx, 1);
    } else {
      cur[idx][1] = cur[idx + 1][1];
      g.splice(idx, 1);
      cur.splice(idx + 1, 1);
    }
  }
  return { regions: cur, gaps: g };
}

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
