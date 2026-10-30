import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeZip, crc32 } from '../site/src/zipstore.js';

const enc = new TextEncoder();

test('crc32 与标准值一致', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('打包结构自洽：签名、条数、CRC、长度', () => {
  const a = enc.encode('hello page splitter');
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // 假 JPEG 头
  const zip = makeZip([
    { name: '第01题.jpg', data: a },
    { name: '第02题.jpg', data: b },
  ], new Date('2026-10-30T20:00:00'));

  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // EOCD 在末尾 22 字节
  assert.equal(dv.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(zip.length - 22 + 10, true), 2, '应有 2 个条目');

  // 第一个本地头
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  const crc0 = dv.getUint32(14, true);
  const size0 = dv.getUint32(18, true);
  const nameLen0 = dv.getUint16(26, true);
  assert.equal(size0, a.length);
  assert.equal(crc0, crc32(a));
  const name0 = new TextDecoder().decode(zip.slice(30, 30 + nameLen0));
  assert.equal(name0, '第01题.jpg', 'UTF-8 文件名必须原样保留');
  const data0 = zip.slice(30 + nameLen0, 30 + nameLen0 + size0);
  assert.deepEqual(Array.from(data0), Array.from(a));
});

test('空文件列表也能产出合法 EOCD', () => {
  const zip = makeZip([]);
  assert.equal(zip.length, 22);
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint32(0, true), 0x06054b50);
  assert.equal(dv.getUint16(10, true), 0);
});
