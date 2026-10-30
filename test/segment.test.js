/**
 * 回归测试：site/src/segment.js 必须复现 tools/split_blocks.py 的结果。
 * 每个 case 由 tools/make_fixtures.py 生成：缩小灰度 + Python 真值 + cases.json 索引。
 * 改了算法先跑 `npm test`：两边不一致就挂，**别改 truth.json 让测试变绿**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyze, rgbaToGray, DEFAULTS } from '../site/src/segment.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const cases = JSON.parse(readFileSync(join(FIX, 'cases.json'), 'utf8'));

/** 按各自名载入 gray + truth + 跑一遍（同一 case 多个断言复用结果） */
function load(c) {
  const truth = JSON.parse(readFileSync(join(FIX, `${c.slug}.truth.json`), 'utf8'));
  const gray = new Uint8Array(gunzipSync(readFileSync(join(FIX, `${c.slug}.gray.gz`))));
  assert.equal(gray.length, truth.width * truth.height, `${c.slug}: 灰度字节数与尺寸不符`);
  const img = { gray, width: truth.width, height: truth.height };
  const r = analyze(img, { gapRatio: truth.params.gap_ratio });
  return { truth, r, img };
}

const loaded = new Map(cases.map((c) => [c.slug, load(c)]));

test('cases.json 至少有一个样本，且每个都有 truth', () => {
  assert.ok(cases.length >= 1);
  for (const c of cases) assert.ok(loaded.get(c.slug).truth.bands.length > 0, `${c.slug} 没有墨迹带`);
});

for (const c of cases) {
  const { truth, r } = loaded.get(c.slug);
  // 容差按页高给：小夹具上 3px 已经够严，大图允许同比例
  const tol = Math.max(3, Math.round(truth.height * 0.004));

  test(`[${c.slug}] 墨迹带与 Python 一致（${truth.bands.length} 条）`, () => {
    assert.equal(r.bands.length, truth.bands.length,
      `${c.slug}: 带数 ${r.bands.length} != ${truth.bands.length}`);
    truth.bands.forEach(([y0, y1], i) => {
      const [a, b] = r.bands[i];
      assert.ok(Math.abs(a - y0) <= tol && Math.abs(b - y1) <= tol,
        `${c.slug}: 第 ${i} 带 [${a},${b}] vs 真值 [${y0},${y1}] 超差 ${tol}px`);
    });
  });

  test(`[${c.slug}] 分区与 Python 一致（${truth.regions.length} 段）`, () => {
    assert.equal(r.regions.length, truth.regions.length,
      `${c.slug}: 分区数 ${r.regions.length} != ${truth.regions.length}`);
    truth.regions.forEach(([y0, y1], i) => {
      const [a, b] = r.regions[i];
      assert.ok(Math.abs(a - y0) <= tol && Math.abs(b - y1) <= tol,
        `${c.slug}: 第 ${i} 段 [${a},${b}] vs 真值 [${y0},${y1}] 超差 ${tol}px`);
    });
  });

  test(`[${c.slug}] 分区首尾覆盖全部墨迹带，无重叠无空洞`, () => {
    assert.equal(r.regions[0][0], r.bands[0][0]);
    assert.equal(r.regions[r.regions.length - 1][1], r.bands[r.bands.length - 1][1]);
    for (let i = 1; i < r.regions.length; i++) {
      assert.ok(r.regions[i][0] > r.regions[i - 1][1], `${c.slug}: 分区重叠`);
    }
  });

  test(`[${c.slug}] 页面底部横贯细线不当成文字带`, () => {
    for (const [y0, y1] of r.bands) {
      const isEdgeZone = y0 >= DEFAULTS.edgeY * truth.height;
      const isThin = (y1 - y0) <= DEFAULTS.edgeMaxH * truth.height;
      assert.ok(!(isEdgeZone && isThin), `${c.slug}: 底部细线 [${y0},${y1}] 没剔掉`);
    }
  });

  test(`[${c.slug}] 灵敏度方向正确：gapRatio 变大 → 段数不增`, () => {
    const { img } = loaded.get(c.slug);
    const tight = analyze(img, { gapRatio: 0.26 });
    const loose = analyze(img, { gapRatio: 0.55 });
    assert.ok(tight.regions.length >= loose.regions.length,
      `${c.slug}: ${tight.regions.length} 段应不少于 ${loose.regions.length} 段`);
  });
}

// 已知边界的页面：不要求切得对，只要求**提前说清楚**
for (const c of cases.filter((x) => x.kind === 'two-column' || x.kind === 'dense')) {
  const { r } = loaded.get(c.slug);
  test(`[${c.slug}] 这类页面必须给出提示（不许默默切错）`, () => {
    assert.ok(r.warnings.length > 0, `${c.slug}: 没有任何提示`);
  });
  if (c.kind === 'two-column') {
    test(`[${c.slug}] 检测到中间空白沟，提示是双栏`, () => {
      assert.ok(r.gutter, `${c.slug}: 没检测到栏间空白`);
      assert.ok(r.warnings.some((w) => w.includes('双栏')), r.warnings.join(' | '));
    });
  }
}

for (const c of cases.filter((x) => x.kind === 'print' || x.kind === 'screenshot' || x.kind === 'handwriting')) {
  const { r } = loaded.get(c.slug);
  test(`[${c.slug}] 单栏页不该误报双栏`, () => {
    assert.ok(!r.gutter, `${c.slug}: 误判双栏`);
    assert.ok(!r.warnings.some((w) => w.includes('双栏')), r.warnings.join(' | '));
  });
}

test('rgbaToGray 与 Pillow "L" 同向', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  const g = rgbaToGray(px, 3, 1);
  assert.ok(Math.abs(g[0] - 255) <= 1);
  assert.ok(Math.abs(g[1] - 0) <= 1);
  assert.ok(Math.abs(g[2] - 76) <= 2, `纯红应约 76，实际 ${g[2]}`);
});
