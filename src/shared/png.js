'use strict';
/**
 * 迷你 PNG 编解码器（纯 Node + zlib，无第三方依赖），8bit RGBA 非隔行。
 * 位图格式与 geom.js 约定一致：{ width, height, data(RGBA 每像素 4 字节) }。
 * 共用方：测试夹具生成（test/fixtures）、内置素材生成器（tools/gen-assets.js）、
 * 以及读回素材做像素断言的单测。只写 IHDR/IDAT/IEND —— 刻意不带 gAMA/iCCP/cHRM/sRGB，
 * 避免浏览器按内嵌色彩档案单独调色导致同像素不同色（见 util.js stripPngColorChunks）。
 */
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 把 RGBA 位图编码成 PNG Buffer。 */
function encodePng(bitmap) {
  const { width: w, height: h, data } = bitmap;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = data[(y * w * 4) + x];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 解码 PNG Buffer 为位图。 */
function decodePng(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlace not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  if (!w || !h) throw new Error('no IHDR');
  if (colorType !== 6 || bitDepth !== 8) throw new Error(`unsupported colorType=${colorType} depth=${bitDepth}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const cur = Buffer.alloc(stride);
    raw.copy(cur, 0, rowStart, rowStart + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;                       // Sub
        case 2: v = (v + b) & 0xff; break;                       // Up
        case 3: v = (v + Math.floor((a + b) / 2)) & 0xff; break; // Average
        case 4: { // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 0xff;
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    cur.copy(prev);
  }
  return { width: w, height: h, data: new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength) };
}

module.exports = { encodePng, decodePng };
