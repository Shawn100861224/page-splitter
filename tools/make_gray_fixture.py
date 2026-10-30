#!/usr/bin/env python
"""把一张图压成“降采样灰度 + base64 JSON”，供没有 JPEG 解码器的环境（Node/浏览器测试）做算法回归。

用法：
    python make_gray_fixture.py page.jpg test/fixtures/page1-g3.b64 3

输出 JSON: {"width": W, "height": H, "b64": "<原始灰度字节的 base64>"}
测试侧读法（Node）：
    const fx = JSON.parse(readFileSync(fixture, 'utf8'));
    const gray = Uint8Array.from(Buffer.from(fx.b64, 'base64'));

缩放系数用整数（2 或 3）：期望边界值同时除以该系数，±2% 页高作为容差。
若 1/3 缩放下窄间距被平滑抹平（分区数不对），改用 divisor=2（文件约 4MB）。
"""
import base64
import json
import sys

from PIL import Image


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    src, dst = sys.argv[1], sys.argv[2]
    div = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    im = Image.open(src).convert("L")
    im = im.resize((im.width // div, im.height // div), Image.LANCZOS)
    payload = {"width": im.width, "height": im.height,
               "b64": base64.b64encode(im.tobytes()).decode()}
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    print(f"{dst}: {im.width}x{im.height} raw={im.width * im.height} bytes")


if __name__ == "__main__":
    main()
