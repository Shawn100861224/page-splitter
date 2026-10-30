"""造几张合成页，用来验证"这工具干不了的页面"会不会提前警告。

合成页只代表几何排版（行距、栏宽、字号），**不代表真实拍照的纸张/光照/手写**，
所以它们只用来锁行为（--baseline），不当"切得对"的证据。

    python tools/make_synthetic.py            # 写 samples/synthetic/*.jpg
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "samples" / "synthetic"
W, H = 1654, 2339  # A4 @ 200dpi

CJK = [
    "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simsun.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]


def font(size: int) -> ImageFont.FreeTypeFont:
    for p in CJK:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    raise SystemExit("找不到中文字体，装个 msyh.ttc 或 Noto Sans CJK")


def paper() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    im = Image.new("L", (W, H), 246)
    d = ImageDraw.Draw(im)
    d.rectangle([40, 40, W - 40, H - 40], outline=180, width=2)  # 页边，帮眼睛定位
    return im, d


def exam_page() -> Image.Image:
    """编号题、行距大 → 应该按题切开（合成版"能切"的对照）"""
    im, d = paper()
    f, ft = font(42), font(46)
    y = 150
    for q in range(1, 6):
        d.text((120, y), f"{q}. 请计算下列各式的值并写出过程。", fill=30, font=ft)
        y += 70
        for line in range(2):
            d.text((150, y), "解：由题意可得 f(x)=ax²+bx+c，代入已知条件得方程组的解。", fill=40, font=f)
            y += 62
        y += 140  # 题间留白
    return im


def dense_page() -> Image.Image:
    """印刷密排：行距≈字高 → 应该按行切 + 警告"""
    im, d = paper()
    f = font(40)
    y = 120
    for i in range(26):
        d.text((120, y), "第一节 绪论：本节介绍基本概念、研究范围与主要方法，并给出后续章节的脉络。", fill=35, font=f)
        y += 46  # 行距只比字高多 6px
    return im


def two_column_page() -> Image.Image:
    """双栏：中间有整列空白 → 应该警告不是单栏"""
    im, d = paper()
    f = font(34)
    for col in range(2):
        x = 120 + col * (W // 2)
        y = 140
        for i in range(18):
            d.text((x, y), "双栏排版的正文，用于检验中间空沟的检测。", fill=35, font=f)
            y += 50
    return im


def screenshot_page() -> Image.Image:
    """截图式：纯白底、无纸纹、无阴影、留白大"""
    im = Image.new("L", (1080, 1920), 255)
    d = ImageDraw.Draw(im)
    f, ft = font(38), font(44)
    y = 160
    for q in range(1, 4):
        d.text((80, y), f"{q}. 判断下列说法是否正确，并说明理由。", fill=0, font=ft)
        y += 70
        d.text((110, y), "答：该说法正确，因为模型在训练集上的损失持续下降。", fill=20, font=f)
        y += 90
        d.text((110, y), "补充说明：验证集指标并不随之一致上升。", fill=20, font=f)
        y += 200
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pages = {
        "exam-print.jpg": exam_page,
        "dense-print.jpg": dense_page,
        "two-column.jpg": two_column_page,
        "screenshot.jpg": screenshot_page,
    }
    for name, fn in pages.items():
        im = fn()
        im.save(OUT / name, quality=92)
        print(f"{name:20s} {im.width}x{im.height}")


if __name__ == "__main__":
    main()
