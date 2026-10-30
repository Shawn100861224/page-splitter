#!/usr/bin/env python
"""文档照片按文字块切图（切题 / 切段）。只依赖 Pillow + numpy。

用法：
    python split_blocks.py page.jpg --dry-run                   # 只打印分析结果
    python split_blocks.py page.jpg --out crops --write         # 落盘 part-01.jpg ...
    python split_blocks.py page.jpg --x0 0.10 --x1 0.86 --gap-ratio 0.45 --write

判读要点：
  * 打印里带 `!` 的间距表示“离切分阈值不到 30%”，这些位置自动切分不可靠，需要人工决定。
  * 列区间明显不对（只选了半页 / 把相邻页切进来）用 --x0/--x1 覆盖。
  * 落盘下边界取最后一条墨迹带 + pad，不用整图高度，避免把桌面黑边切进来。

算法要点（v2，2026-10-30 重写）：
  1) 背景用「整幅缩到 1/16 再放大」估计，再以 灰度/背景 < ink_ratio 判墨。
     早期版本用「每行 85 分位」当背景，页面下半部分存在横向阴影（左暗右亮），
     按行做背景时左半页被整块判成墨，几道题会粘成一条。
  2) 行阈值取 max(页宽×0.012, 行剖面 99 分位×0.05)；只用 sm.max()×0.06 会被阴影区拉高，
     导致真实的细笔画行被吞掉。
  3) 间距极小的带（< 中位带高 10%）先合并：同一行字的上下笔画常被切成两条。
  4) 页面边缘线剔除：位于图片下部 15%、高度 < 2%H、横跨 ≥60% 页宽的细长带，
     是桌面/本子边缘的阴影线，不是文字（已用视觉核对确认无字）。
"""
import argparse
import os

import numpy as np
from PIL import Image, ImageOps


def _runs(flags, min_len):
    """把布尔序列压成 [start, end) 区间列表，丢掉短于 min_len 的。"""
    out, start = [], None
    for i, v in enumerate(flags):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    if start is not None and len(flags) - start >= min_len:
        out.append((start, len(flags)))
    return out


DEFAULT_GAP_RATIO = 0.36


def analyse_image(im, x0=0.12, x1=0.88, thr_ratio=0.40, ink_ratio=0.55,
                  col_ink_max=0.45, smooth_ratio=0.004, row_thresh_ratio=0.012,
                  min_band_ratio=0.006, bg_div=16, merge_ratio=0.10,
                  gap_ratio=DEFAULT_GAP_RATIO):
    """对已打开的灰度图做完整分析，返回 bands / regions / 参数。网页版算法要按这份结果对齐。"""
    im = im.convert("L")
    a = np.asarray(im).astype(np.float32)
    H, W = a.shape

    paper = float(np.percentile(a, 90))
    thr = thr_ratio * paper

    lo, hi = int(W * x0), int(W * x1)
    win = a[:, lo:hi]
    ink0 = win < thr

    # 深色桌面 / 装订阴影：整列几乎全是墨 → 剔掉，取剩下最长的一段
    col_ink = ink0.mean(axis=0)
    keep = col_ink <= col_ink_max
    runs = _runs(keep, max(2, int((hi - lo) * 0.15)))
    s, e = max(runs, key=lambda r: r[1] - r[0]) if runs else (0, hi - lo)
    sub = win[:, s:e]
    xs0, xs1 = lo + s, lo + e
    sh, sw = sub.shape

    # 1) 二维背景：缩到 1/16 再放大，消除光照渐变与阴影
    r_off = Image.NEAREST
    tmp = "tmp_bg_gray"
    sub_img = Image.fromarray(np.clip(sub, 0, 255).astype(np.uint8))
    bg_small = sub_img.resize((max(4, sw // bg_div), max(4, sh // bg_div)), Image.BILINEAR)
    bg = np.asarray(bg_small.resize((sw, sh), Image.BILINEAR), dtype=np.float32)
    del tmp, r_off
    bg = np.maximum(bg, 1.0)

    ink = (sub / bg) < ink_ratio
    row_ink = ink.sum(axis=1).astype(np.float32)

    # 2) 平滑 + 行阈值
    k = max(3, int(round(H * smooth_ratio)) | 1)
    sm = np.convolve(row_ink, np.ones(k) / k, mode="same")
    thr_row = max(sw * row_thresh_ratio, float(np.percentile(sm, 99)) * 0.05)
    min_len = max(2, int(round(H * min_band_ratio)))
    raw = _runs(list(sm > thr_row), min_len)

    # 3) 先合并间距极小的带（同一行字的上下笔画 / 标点）
    if raw:
        med0 = float(np.median([b[1] - b[0] for b in raw]))
        mg = max(2, int(round(med0 * merge_ratio)))
        bands = [list(raw[0])]
        for b in raw[1:]:
            if b[0] - bands[-1][1] < mg:
                bands[-1][1] = b[1]
            else:
                bands.append(list(b))
        bands = [(b[0], b[1]) for b in bands]
    else:
        bands = []

    # 4) 剔除页面边缘 / 阴影细线
    def _is_edge_band(b):
        y0, y1 = b
        h = y1 - y0
        if h > 0.02 * H or y0 < 0.85 * H:
            return False
        seg = ink[y0:y1]
        cov = float((seg.sum(axis=0) > 0).mean()) if h else 0.0
        return cov >= 0.60

    bands = [b for b in bands if not _is_edge_band(b)]

    # 4.5) xs 扩到真实墨迹列范围（与 site/src/segment.js 一致）：
    #      分析窗只取"够密的那一段"，但导出按 xs 裁，窗外的字会被整片切掉。
    if bands:
        # 用**全宽**背景重算一张墨迹图（与 JS 的 backgroundModel 同口径）：
        # 分析窗内的 ink 只有 sw 列，拿它判断窗外有没有字是错的（下标还是窗内偏移）。
        bgs = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).resize(
            (max(4, W // bg_div), max(4, H // bg_div)), Image.BILINEAR)
        bgf = np.maximum(np.asarray(bgs.resize((W, H), Image.BILINEAR), dtype=np.float32), 1.0)
        ra, rb = bands[0][0], bands[-1][1]
        # 1.2% 行数起步：桌面/阴影列只有零散几个像素，真文字列远高于此
        need = max(4, int(round((rb - ra) * 0.012)))
        colcnt = ((a[ra:rb] / bgf[ra:rb]) < ink_ratio).sum(axis=0)
        hit = np.nonzero(colcnt >= need)[0]
        if hit.size:
            xs0 = min(xs0, int(hit[0]))
            xs1 = max(xs1, int(hit[-1]) + 1)
        del bgf, bgs

    regions, med, thr_gap, gaps = group(bands, gap_ratio)
    return dict(im=im, W=W, H=H, paper=paper, thr=thr, xs=[xs0, xs1],
                bands=[[b[0], b[1]] for b in bands], regions=regions,
                median_band=med, gap_thresh=thr_gap, gaps=gaps,
                profile=sm, thr_row=thr_row, smooth_k=k, row_ink=row_ink,
                params=dict(ink_ratio=ink_ratio, bg_div=bg_div, merge_ratio=merge_ratio,
                            row_thresh_ratio=row_thresh_ratio,
                            min_band_ratio=min_band_ratio, gap_ratio=gap_ratio))


def analyse(path, **kw):
    """命令行用：路径进来，其余同 analyse_image。"""
    return analyse_image(ImageOps.exif_transpose(Image.open(path)), **kw)


def pick_threshold(gaps, med, gap_ratio):
    """阈值怎么定：先看这页间距有没有"明显两档"。

    印刷/截图的题间相对行距是**跳跃式**（实测 20px→158px，7.9 倍）；手写页题间只比
    行距高一点点（实测 51px→55px，1.08 倍），没有跳跃。所以取排序后 gap 的最大跳跃
    g[i+1]/g[i]：≥2.2 倍且其上至少还有 2 个 gap，才认为有两档、阈值取跳跃中点；
    否则退回 med × gapRatio。与 site/src/segment.js 逐条同逻辑。
    """
    base = max(2.0, med * gap_ratio)
    n = len(gaps)
    if n < 5:
        return base
    # 只在"够宽的间距"里找跳跃：带内碎缝（2~3px）会让比值虚高，阈值被压到十几像素，
    # 整页就按行切了。med*0.2 以下的不参与跳跃判定（阈值本身仍按全部 gaps 算）。
    floor = max(2.0, med * 0.2)
    cand = sorted(float(x) for x in gaps if float(x) >= floor)
    m = len(cand)
    if m < 3:
        return base
    g = cand
    at, best = -1, 0.0
    for i in range(m - 1):
        r = g[i + 1] / max(1.0, g[i])
        if r > best:
            best, at = r, i
    if at < 0 or best < 2.2 or m - 1 - at < 2:
        return base
    return max(base, (g[at] + g[at + 1]) / 2.0)


def group(bands, gap_ratio):
    if not bands:
        return [], 0.0, 0.0, []
    heights = sorted(b[1] - b[0] for b in bands)
    med = float(heights[len(heights) // 2])

    # 小碎带（花括号尖、标点、题号上标）并到更近的一侧，再算间距：
    # 否则一个 26px 的括号尖会凭 55px 的间距白开一段。
    work = [list(b) for b in bands]
    if len(work) >= 3:
        for _ in range(8):
            if len(work) < 3:
                break
            idx = min(range(len(work)), key=lambda i: work[i][1] - work[i][0])
            if work[idx][1] - work[idx][0] >= 0.5 * med:
                break
            up = work[idx][0] - work[idx - 1][1] if idx > 0 else None
            dn = work[idx + 1][0] - work[idx][1] if idx < len(work) - 1 else None
            if up is None or (dn is not None and dn < up):
                work[idx + 1][0] = work[idx][0]
            else:
                work[idx - 1][1] = work[idx][1]
            work.pop(idx)

    # 切分基准：小碎带归位后再取上中位数（与 site/src/segment.js 完全一致）
    wh = sorted(w[1] - w[0] for w in work) if work else [0]
    med = float(wh[len(wh) // 2])
    gaps = [work[i + 1][0] - work[i][1] for i in range(len(work) - 1)]
    thr = pick_threshold(gaps, med, gap_ratio)
    regions = [[work[0][0], work[0][1]]]
    for i, g in enumerate(gaps, start=1):
        if g > thr:
            regions.append([work[i][0], work[i][1]])
        else:
            regions[-1][1] = work[i][1]
    full_gaps = [bands[i + 1][0] - bands[i][1] for i in range(len(bands) - 1)]
    return regions, med, thr, full_gaps


def main():
    p = argparse.ArgumentParser()
    p.add_argument("image")
    p.add_argument("--out", default="crops")
    p.add_argument("--prefix", default="part")
    p.add_argument("--x0", type=float, default=0.12, help="列起点百分比")
    p.add_argument("--x1", type=float, default=0.88, help="列终点百分比")
    p.add_argument("--thr-ratio", type=float, default=0.40, help="列过滤墨阈值 = 该值 × 纸面90分位")
    p.add_argument("--ink-ratio", type=float, default=0.55,
                   help="墨 = 灰度 / 二维背景 < 该值（0.50–0.62）")
    p.add_argument("--bg-div", type=int, default=16, help="背景估计的下采样倍数")
    p.add_argument("--merge-ratio", type=float, default=0.10, help="间距 < 该值×中位带高 先合并")
    p.add_argument("--col-ink-max", type=float, default=0.45)
    p.add_argument("--smooth-ratio", type=float, default=0.004)
    p.add_argument("--row-thresh-ratio", type=float, default=0.012)
    p.add_argument("--min-band-ratio", type=float, default=0.006)
    p.add_argument("--gap-ratio", type=float, default=0.36,
                   help="间距 > 该值 × 中位带高 就切开（本机实测 0.36–0.38 出 8 段）")
    p.add_argument("--pad", type=int, default=28, help="上下左右留白像素")
    p.add_argument("--quality", type=int, default=92)
    p.add_argument("--write", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--json", help="把 bands/regions 写到该 json 文件（给回归测试用）")
    args = p.parse_args()

    r = analyse(args.image, x0=args.x0, x1=args.x1, thr_ratio=args.thr_ratio,
                ink_ratio=args.ink_ratio, col_ink_max=args.col_ink_max,
                smooth_ratio=args.smooth_ratio, row_thresh_ratio=args.row_thresh_ratio,
                min_band_ratio=args.min_band_ratio, bg_div=args.bg_div,
                merge_ratio=args.merge_ratio, gap_ratio=args.gap_ratio)
    regions, med, gthr, gaps = r["regions"], r["median_band"], r["gap_thresh"], r["gaps"]

    print(f"图 {r['W']}x{r['H']}  纸面90分位={r['paper']:.0f}  列过滤墨阈值={r['thr']:.0f}")
    print(f"列区间 x={r['xs'][0]}..{r['xs'][1]}  平滑窗={r['smooth_k']}  行阈值={r['thr_row']:.1f}")
    print(f"\n墨迹带 {len(r['bands'])} 条:")
    for i, (y0, y1) in enumerate(r["bands"]):
        print(f"  #{i:02d} [{y0},{y1}] h={y1 - y0}")
    tier = "两档跳跃" if gthr > max(2.0, med * args.gap_ratio) + 0.01 else "基准"
    print(f"\n中位带高={med:.0f}  切分阈值={gthr:.1f}px ({args.gap_ratio}×中位带高, {tier})")
    print("相邻间距:")
    risky = []
    for i, g in enumerate(gaps):
        ratio = g / gthr if gthr else 0
        flag = "!" if 0.7 <= ratio <= 1.3 else " "
        print(f"  {flag} gap {r['bands'][i][1]:>5}->{r['bands'][i + 1][0]:<5} = {g:>4} ({ratio:.2f}×) "
              f"{'切' if g > gthr else '合'}")
        if flag == "!":
            risky.append((i, g, ratio))
    print(f"\n分区 {len(regions)} 段:")
    for i, (y0, y1) in enumerate(regions):
        print(f"  #{i + 1} y {y0}..{y1} (h {y1 - y0})")
    if risky:
        print(f"\n! 有 {len(risky)} 处间距离阈值不到 30%，自动切分不可靠，建议 vision 抽查或手工定：")
        for i, g, ratio in risky:
            print(f"   band {i} 与 {i + 1} 之间 gap={g} ({ratio:.2f}×)")

    if args.json:
        import json
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(dict(image=os.path.basename(args.image), W=r["W"], H=r["H"],
                           xs=list(r["xs"]), bands=[list(b) for b in r["bands"]],
                           regions=[list(x) for x in regions],
                           median_band=med, gap_thresh=gthr,
                           params=r["params"]),
                      f, ensure_ascii=False, indent=1)
        print(f"\nJSON → {os.path.abspath(args.json)}")

    if not args.write or args.dry_run:
        return

    os.makedirs(args.out, exist_ok=True)
    im, W, H, pad = r["im"], r["W"], r["H"], args.pad
    left = max(0, r["xs"][0] - pad)
    right = min(W, r["xs"][1] + pad)
    n = 0
    for i, (y0, y1) in enumerate(regions):
        box = (left, max(0, y0 - pad), right, min(H, y1 + pad))
        if box[3] - box[1] < 8:
            continue
        n += 1
        name = f"{args.prefix}-{n:02d}.jpg"
        im.crop(box).convert("RGB").save(os.path.join(args.out, name),
                                        quality=args.quality)
        print(f"写入 {name}  {box[2] - box[0]}x{box[3] - box[1]}")
    print(f"共 {n} 张 → {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main()
