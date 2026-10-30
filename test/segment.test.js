/**
 * 回归测试：site/src/segment.js 必须复现 tools/split_blocks.py（v2）的结果。
 * 夹具由 tools/make_fixture.py 生成，truth-small.json 是 Python 侧的真值。
 * 改了算法先跑 `npm test`：两边不一致就挂，别悄悄改 truth。
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

const truth = JSON.parse(readFileSync(join(FIX, 'truth-small.json'), 'utf8'));
const gray = new Uint8Array(gunzipSync(readFileSync(join(FIX, 'page-small.gray.gz'))));
const img = { gray, width: truth.width, height: truth.height };

const TOL = 3; // 像素容差：两边实现的取整/插值细节略有差异

test('夹具尺寸自洽', () => {
  assert.equal(gray.length, truth.width * truth.height);
});

test('墨迹带数量与位置与 Python 参考一致', () => {
  const r = analyze(img, { gapRatio: truth.params.gapRatio });
  assert.equal(r.bands.length, truth.bands.length,
    `带数 ${r.bands.length} != ${truth.bands.length}`);
  truth.bands.forEach(([y0, y1], i) => {
    const [a, b] = r.bands[i];
    assert.ok(Math.abs(a - y0) <= TOL && Math.abs(b - y1) <= TOL,
      `第 ${i} 带 [${a},${b}] 与真值 [${y0},${y1}] 差超过 ${TOL}px`);
  });
});

test('分区数量与位置与 Python 参考一致', () => {
  const r = analyze(img, { gapRatio: truth.params.gapRatio });
  assert.equal(r.regions.length, truth.regions.length,
    `分区数 ${r.regions.length} != ${truth.regions.length}`);
  truth.regions.forEach(([y0, y1], i) => {
    const [a, b] = r.regions[i];
    assert.ok(Math.abs(a - y0) <= TOL && Math.abs(b - y1) <= TOL,
      `第 ${i} 段 [${a},${b}] 与真值 [${y0},${y1}] 差超过 ${TOL}px`);
  });
});

test('分区首尾覆盖全部墨迹带，无重叠无空洞', () => {
  const r = analyze(img, { gapRatio: truth.params.gapRatio });
  assert.equal(r.regions[0][0], r.bands[0][0]);
  assert.equal(r.regions[r.regions.length - 1][1], r.bands[r.bands.length - 1][1]);
  for (let i = 1; i < r.regions.length; i++) {
    assert.ok(r.regions[i][0] > r.regions[i - 1][1], '分区之间出现重叠');
  }
});

test('页面底部横贯细线不当成文字带', () => {
  const r = analyze(img);
  for (const [y0, y1] of r.bands) {
    const isEdgeZone = y0 >= DEFAULTS.edgeY * truth.height;
    const isThin = (y1 - y0) <= DEFAULTS.edgeMaxH * truth.height;
    assert.ok(!(isEdgeZone && isThin), `底部细线 [${y0},${y1}] 没有被剔除`);
  }
});

test('参数可调：gapRatio 变大则分区变少', () => {
  const tight = analyze(img, { gapRatio: 0.30 });
  const loose = analyze(img, { gapRatio: 0.50 });
  assert.ok(tight.regions.length >= loose.regions.length,
    `${tight.regions.length} 段应不少于 ${loose.regions.length} 段`);
});

test('rgbaToGray 与 Pillow "L" 同向', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  const g = rgbaToGray(px, 3, 1);
  assert.ok(Math.abs(g[0] - 255) <= 1);
  assert.ok(Math.abs(g[1] - 0) <= 1);
  assert.ok(Math.abs(g[2] - 76) <= 2, `纯红应约 76，实际 ${g[2]}`);
});
