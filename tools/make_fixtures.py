"""批量生成回归夹具：一张样图 → 缩小灰度 + Python 真值 + cases.json 索引。

用法：
    python tools/make_fixtures.py samples/*.jpg
    python tools/make_fixtures.py a.jpg --kind print --note "印刷习题册，预期按行切"
    python tools/make_fixtures.py a.jpg --baseline     # 只锁当前行为，不保证切得对

产物（都是版本库的一部分，别手改）：
    test/fixtures/<slug>.gray.gz       原始灰度字节（gzip，Node 里 zlib 直接解）
    test/fixtures/<slug>.png           缩小版，给人看
    test/fixtures/<slug>.truth.json    Python 参考实现的 bands / regions / 参数
    test/fixtures/cases.json           索引：slug、来源、尺寸、kind、expect

注意：夹具是**回归基线**，不是"正确答案"。切得不对的样本要标 --baseline，
让测试只保证"JS 与 Python 一致、结果没变"，别假装它切对了。
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
import split_blocks as sb  # noqa: E402

FIX = Path(__file__).resolve().parent.parent / "test" / "fixtures"
CASES = FIX / "cases.json"


def slugify(path: Path) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", path.stem.lower()).strip("-")
    return s or "sample"


def uniqueness(slug: str, used: set[str]) -> str:
    if slug not in used:
        return slug
    i = 2
    while f"{slug}-{i}" in used:
        i += 1
    return f"{slug}-{i}"


def build(path: Path, target: int, kind: str, note: str, expect: str, used: set[str]) -> dict:
    im = ImageOps.exif_transpose(Image.open(path)).convert("L")
    scale = min(1.0, target / max(im.size))
    if scale < 1.0:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)

    slug = uniqueness(slugify(path), used)
    used.add(slug)

    res = sb.analyse_image(im, gap_ratio=sb.DEFAULT_GAP_RATIO)  # 同一份 Python 实现
    truth = {
        "slug": slug,
        "source": path.name,
        "width": im.width,
        "height": im.height,
        "xs": res["xs"],
        "bands": res["bands"],
        "regions": res["regions"],
        "median_band": res["median_band"],
        "gap_thresh": res["gap_thresh"],
        "params": res["params"],
        "kind": kind,
        "expect": expect,
        "note": note,
    }

    FIX.mkdir(parents=True, exist_ok=True)
    (FIX / f"{slug}.gray.gz").write_bytes(gzip.compress(np.asarray(im, dtype=np.uint8).tobytes(), 9))
    im.save(FIX / f"{slug}.png", optimize=True)
    (FIX / f"{slug}.truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1), encoding="utf-8")
    return truth


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--width", type=int, default=1008, help="夹具最长边（默认 1008）")
    ap.add_argument("--kind", default="handwriting")
    ap.add_argument("--note", default="")
    ap.add_argument("--baseline", action="store_true", help="只锁当前行为，不保证切得对")
    args = ap.parse_args()

    cases = json.loads(CASES.read_text(encoding="utf-8")) if CASES.exists() else []
    used = {c["slug"] for c in cases}
    added = []

    print(f"{'slug':28s} {'尺寸':>11s} {'带':>3s} {'段':>3s} {'中位':>5s} {'阈值':>6s}")
    for raw in args.images:
        p = Path(raw).expanduser().resolve()
        if not p.exists():
            print(f"  跳过（不存在）：{p}")
            continue
        expect = "baseline" if args.baseline else "match"
        t = build(p, args.width, args.kind, args.note, expect, used)
        cases = [c for c in cases if c["slug"] != t["slug"]]
        cases.append({k: t[k] for k in ("slug", "source", "width", "height", "kind", "expect", "note")})
        added.append(t)
        print(f"{t['slug']:28s} {t['width']:5d}x{t['height']:<5d} {len(t['bands']):3d} "
              f"{len(t['regions']):3d} {t['median_band']:5.0f} {t['gap_thresh']:6.1f}")

    CASES.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n夹具目录：{FIX}（共 {len(cases)} 个 case，本次新增/更新 {len(added)} 个）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
