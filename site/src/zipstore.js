/**
 * zipstore.js — 极简 ZIP 打包器（仅 store 不压缩，零依赖）
 *
 * 为什么要自己写：导出的都是 JPEG，本身已经压缩过，ZIP 再压一次几乎不省空间，
 * 却要多带 96KB 的 JSZip。这里 ~90 行搞定，浏览器和 Node 都能用。
 *
 * 只实现了 ZIP 的最低必需部分：本地文件头 + 中央目录 + EOCD，UTF-8 文件名标志位。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Uint8Array} zip 字节
 */
export function makeZip(files, now = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const entries = [];
  const locals = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new Uint8Array(30 + nameBytes.length + size);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);   // 本地文件头签名
    dv.setUint16(4, 20, true);           // 解压所需版本 2.0
    dv.setUint16(6, 0x0800, true);       // bit 11 = UTF-8 文件名
    dv.setUint16(8, 0, true);            // 压缩方式 0 = store
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(f.data, 30 + nameBytes.length);

    entries.push({ nameBytes, crc, size, offset });
    locals.push(local);
    offset += local.length;
  }

  const centralParts = entries.map((e) => {
    const buf = new Uint8Array(46 + e.nameBytes.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x02014b50, true);   // 中央目录头签名
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.size, true);
    dv.setUint32(24, e.size, true);
    dv.setUint16(28, e.nameBytes.length, true);
    dv.setUint32(42, e.offset, true);
    buf.set(e.nameBytes, 46);
    return buf;
  });

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const localSize = locals.reduce((s, b) => s + b.length, 0);
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, entries.length, true);
  dv.setUint16(10, entries.length, true);
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, localSize, true);

  const out = new Uint8Array(localSize + centralSize + 22);
  let p = 0;
  for (const b of locals) { out.set(b, p); p += b.length; }
  for (const b of centralParts) { out.set(b, p); p += b.length; }
  out.set(eocd, p);
  return out;
}
