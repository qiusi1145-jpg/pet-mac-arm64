'use strict';
/** 通用纯工具：数值运算 + PNG 字节级处理，无副作用、可单测。 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ---- PNG 无损剥离内嵌色彩档案块（iCCP/gAMA/cHRM/sRGB） ----
 * 带色彩档案的 PNG 会被浏览器单独调色，与不带档案的素材出现肉眼色差
 * （实测：本体 pet.png 带 iCCP 而动画帧没有，原始像素完全一致也会色差）。
 * 只删辅助块、像素零改动；非 PNG / 结构异常 → 原样返回，绝不破坏文件。 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_CHUNKS = new Set(['iCCP', 'gAMA', 'cHRM', 'sRGB']);

function stripPngColorChunks(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 + 12 + 4) return buf;
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return buf;
    const parts = [PNG_SIGNATURE];
    let off = 8;
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      const dataStart = off + 8;
      const dataEnd = dataStart + len;
      if (dataEnd + 4 > buf.length) return buf; // 结构异常 → 原样返回
      if (!PNG_COLOR_CHUNKS.has(type)) {
        // 保留块按原字节重组：长度头 + 数据 + 原 CRC（CRC 覆盖 type+data，内容未变无需重算）
        const head = Buffer.alloc(8);
        head.writeUInt32BE(len, 0);
        head.write(type, 4, 'latin1');
        parts.push(head, buf.subarray(dataStart, dataEnd), buf.subarray(dataEnd, dataEnd + 4));
      }
      off = dataEnd + 4;
      if (type === 'IEND') break;
    }
    return Buffer.concat(parts);
  } catch {
    return buf;
  }
}

module.exports = { clamp, stripPngColorChunks };
