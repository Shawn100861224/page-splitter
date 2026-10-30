"""从样本原图生成回归夹具（缩小版灰度 + Python 参考输出）。

用法：
    python tools/make_fixture.py "C:/path/to/photo.jpg" [--width 1008]

产物（都进版本库，别删）：
    test/fixtures/page-small.gray.gz   # 原始灰度字节，gzip
    test/fixtures/page-small.png       # 同尺寸 PNG，给人眼看
    test/fixtures/truth.json           # Python 参考实现的 bands/regions
"""
import argparse
import gzip
import json
import os
import sys

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import split_blocks  # noqa: E402

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "fixtures")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--width", type=int, default=1008)
    ap.add_argument("--gap-ratio", type=float, default=0.37)
    args = ap.parse_args()

    os.makedirs(FIX, exist_ok=True)
    im = ImageOps.exif_transpose(Image.open(args.image)).convert("L")
    scale = args.width / im.width
    small = im.resize((args.width, max(1, round(im.height * scale))), Image.LANCZOS)
    png = os.path.join(FIX, "page-small.png")
    small.save(png)

    raw = np.asarray(small, dtype=np.uint8).tobytes()
    with gzip.open(os.path.join(FIX, "page-small.gray.gz"), "wb", compresslevel=9) as f:
        f.write(raw)

    r = split_blocks.analyse(png, 0.12, 0.88, 0.40, 0.55, 0.45,
                             0.004, 0.012, 0.006, 16, 0.10)
    regions, med, gthr, _ = split_blocks.group(r["bands"], args.gap_ratio)
    truth = dict(
        source=os.path.basename(args.image),
        width=args.width, height=small.height,
        bands=[list(b) for b in r["bands"]],
        regions=[list(x) for x in regions],
        medianBand=med, gapThresh=gthr,
        params=dict(gapRatio=args.gap_ratio, inkRatio=0.55, bgDiv=16,
                    rowThreshRatio=0.012, minBandRatio=0.006),
    )
    with open(os.path.join(FIX, "truth-small.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False, indent=1)

    print(f"夹具 {small.width}x{small.height}  bands={len(truth['bands'])} "
          f"regions={len(truth['regions'])}  中位带高={med:.0f} 阈值={gthr:.1f}")
    for i, (y0, y1) in enumerate(truth["regions"]):
        print(f"  R{i + 1} {y0}..{y1} (h {y1 - y0})")


if __name__ == "__main__":
    main()
