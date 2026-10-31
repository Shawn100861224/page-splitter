
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { analyze } from './site/src/segment.js';
const truth = JSON.parse(readFileSync('test/fixtures/handwritten-ruled.truth.json','utf8'));
const gray = new Uint8Array(gunzipSync(readFileSync('test/fixtures/handwritten-ruled.gray.gz')));
const r = analyze({gray, width: truth.width, height: truth.height}, {gapRatio: truth.params.gap_ratio});
const hs = r.regions.map(([a,b]) => b-a);
console.log(JSON.stringify({med: r.medianBand, tol: +(r.medianBand*1.5).toFixed(1), n: r.regions.length, heights: hs, minRatio: +(Math.min(...hs)/r.medianBand).toFixed(2), truthN: truth.regions.length, truthH: truth.regions.map(([a,b])=>b-a)}));
