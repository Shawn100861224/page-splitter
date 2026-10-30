/**
 * imageio.js — 读图、缩放、取灰度（浏览器端，不上传）
 *
 * 分析时把长边缩到 ANALYZE_MAX（默认 1600）——12MP 手机照片直接算也能跑，
 * 但手机上省 3~5 倍的 CPU 时间，边界精度用 1600 完全够（实测误差 < 3px）。
 * 导出时回到原图分辨率裁剪，不吃画质。
 */

export const ANALYZE_MAX = 4096;

/**
 * 分析画面的像素上限。手机上 48MP 原图直接分析要 48MB 灰度 + 190MB canvas，
 * Safari 会直接杀页；截到 25MP 后灰度 ~25MB，原图仍留着用来导出（导出按原分辨率裁）。
 */
export const ANALYZE_MAX_PIXELS = 25_000_000;

/** 从 File/Blob 读成 ImageBitmap（自动按 EXIF 摆正） */
export async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return await createImageBitmap(file);
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('图片解码失败，换一张试试'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function bitmapSize(bmp) {
  return { width: bmp.width || bmp.naturalWidth, height: bmp.height || bmp.naturalHeight };
}

/** 按长边上限等比缩放，返回 canvas（分析用） */
export function downscale(bmp, maxSide = ANALYZE_MAX) {
  const { width, height } = bitmapSize(bmp);
  let scale = Math.min(1, maxSide / Math.max(width, height));
  const px = width * height * scale * scale;
  if (px > ANALYZE_MAX_PIXELS) scale *= Math.sqrt(ANALYZE_MAX_PIXELS / px); // 大图按面积再截一刀
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return { canvas, ctx, scale, width: w, height: h };
}

/** canvas → {gray(Uint8Array), width, height} */
export function canvasToGray(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // Rec.601，和 Pillow "L" 一致
    gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114 + 500) / 1000;
  }
  return { gray, width, height };
}

/**
 * 全分辨率裁剪一段。
 * @param {ImageBitmap|HTMLImageElement} bmp 原图
 * @param {[number, number]} yRange 分析坐标系下的 [y0, y1)
 * @param {number} scale 分析图 / 原图 的缩放比
 * @param {{x0:number, x1:number, pad:number}} box 分析坐标系下的左右边界与留白
 */
export function cropRegion(bmp, yRange, scale, box, quality = 0.92) {
  const { width: W, height: H } = bitmapSize(bmp);
  const inv = 1 / scale;
  const left = Math.max(0, Math.round((box.x0 - box.pad) * inv));
  const right = Math.min(W, Math.round((box.x1 + box.pad) * inv));
  const top = Math.max(0, Math.round((yRange[0] - box.pad) * inv));
  const bottom = Math.min(H, Math.round((yRange[1] + box.pad) * inv));
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 原图若带透明通道，铺白底，JPEG 才不出黑块
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, left, top, w, h, 0, 0, w, h);
  return { canvas, box: { left, top, w, h } };
}

export function canvasToJpegBlob(canvas, quality = 0.92) {
  return new Promise((res, rej) => {
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('导出失败：canvas.toBlob 返回空'))),
      'image/jpeg', quality);
  });
}
