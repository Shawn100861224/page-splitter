"""探索：能不能不靠 OCR，只靠"行首有一块孤立的小墨迹"来认题号行。

用法：python tools/probe_numbers.py samples/handwritten-ruled.jpg
输出每一条墨迹带在行首的几何特征，并对照参考实现切出来的段落起点，
看"题号行"这个信号够不够用。只是一次性实验脚本，不参与产品构建。
"""
import sys
import numpy as np
from PIL import Image

sys.path.insert(0, "tools")
from split_blocks import analyse_image  # noqa: E402


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "samples/handwritten-ruled.jpg"
    im = Image.open(path)
    r = analyse_image(im)
    a = np.asarray(im.convert("L")).astype(np.float32)
    H, W = a.shape

    # 全图二维背景 → 墨掩码（与网页同口径）
    bg_div = 16
    bg = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).resize(
        (max(4, W // bg_div), max(4, H // bg_div)), Image.BILINEAR)
    bg = np.maximum(np.asarray(bg.resize((W, H), Image.BILINEAR), dtype=np.float32), 1.0)
    ink = (a / bg) < 0.55

    xs0, xs1 = r["xs"]
    print(f"图 {W}x{H}  列范围 {xs0}-{xs1}  带 {len(r['bands'])} 段 {len(r['regions'])}")
    print(f"{'band':>4} {'y0':>5} {'y1':>5} {'行宽%':>6} {'首块w':>6} {'其后空':>7}  判定")
    seg_starts = {b[0] for b in r["regions"]}
    hit, miss, false_pos = 0, [], []

    for i, (y0, y1) in enumerate(r["bands"]):
        row = ink[y0:y1, :]
        col = row.sum(axis=0) > 0
        # 行内墨迹覆盖宽度
        nz = np.nonzero(col)[0]
        if nz.size == 0:
            continue
        row_w = (nz[-1] - nz[0]) / W
        # 从左边界开始找第一块连续墨迹，以及它后面的空白
        seg = col[xs0:]
        idx = np.nonzero(seg)[0]
        if idx.size == 0:
            continue
        s1 = idx[0]
        e1 = s1
        while e1 + 1 < seg.size and seg[e1 + 1]:
            e1 += 1
        w = e1 - s1 + 1
        nxt = np.nonzero(seg[e1 + 1:])[0]
        gap2 = int(nxt[0]) if nxt.size else 9999
        # 候选判据：首块窄（<6% 页宽）、后面有明显空白（>=0.8% 页宽）、整行够长
        ok = (8 <= w <= 0.06 * W) and gap2 >= 0.008 * W and row_w > 0.15
        is_start = y0 in seg_starts
        if is_start and ok:
            hit += 1
        elif is_start and not ok:
            miss.append(i)
        elif ok and not is_start:
            false_pos.append(i)
        print(f"{i:>4} {y0:>5} {y1:>5} {row_w*100:>5.0f}% {w:>6} {gap2:>7}  "
              f"{'段落起点' if is_start else '         '} {'✓题号?' if ok else ''}")

    n_seg = len(r["regions"])
    print(f"\n段落 {n_seg}；起点被认成题号行 {hit}；起点漏判 {len(miss)}（band {miss}）；"
          f"非起点误报 {len(false_pos)}（band {false_pos}）")


if __name__ == "__main__":
    main()
