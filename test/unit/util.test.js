'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripPngColorChunks } = require('../../src/shared/util');
const { encodePng, decodePng } = require('../fixtures/png');
const { circle } = require('../fixtures/shapes');

/** 手工拼一个带指定辅助块的 PNG Buffer（chunk = 4B长度 + 4B类型 + 数据 + 4B CRC）。 */
function buildPngWithChunks(extraTypes) {
  const bm = circle(16, 6, [255, 0, 0, 255]);
  const base = encodePng(bm);
  if (!extraTypes.length) return base;
  // 在 IHDR 之后插入伪造的辅助块（数据内容随意，剥离器只看类型）
  const sig = base.subarray(0, 8);
  const rest = base.subarray(8);
  const inserts = extraTypes.map((t) => {
    const data = Buffer.from([1, 2, 3, 4]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(4, 0);
    head.write(t, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC 置 0（剥离器不校验）
  });
  return Buffer.concat([sig, ...inserts, rest]);
}

function chunkTypes(buf) {
  const types = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    types.push(type);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return types;
}

test('剔色彩块：iCCP/gAMA/cHRM/sRGB 被移除，IHDR/IDAT/IEND 原样保留', () => {
  const inBuf = buildPngWithChunks(['iCCP', 'gAMA', 'cHRM', 'sRGB']);
  const out = stripPngColorChunks(inBuf);
  assert.deepEqual(chunkTypes(out), ['IHDR', 'IDAT', 'IEND']);
  assert.ok(out.length < inBuf.length);
});

test('剔色彩块：像素零改动（剥离后仍可解码且位图一致）', () => {
  const bm = circle(24, 10, [120, 200, 90, 255]);
  const withICC = (() => {
    const base = encodePng(bm);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(4, 0);
    head.write('iCCP', 4, 'latin1');
    return Buffer.concat([base.subarray(0, 8), head, Buffer.from([9, 9, 9, 9]), Buffer.alloc(4), base.subarray(8)]);
  })();
  const out = stripPngColorChunks(withICC);
  const decoded = decodePng(out);
  assert.equal(decoded.width, bm.width);
  assert.deepEqual(decoded.data, bm.data);
});

test('剔色彩块：无色彩块的 PNG 原字节返回（无损）', () => {
  const bm = circle(16, 6, [10, 20, 30, 255]);
  const buf = encodePng(bm);
  const out = stripPngColorChunks(buf);
  assert.ok(out.equals(buf), '输出应与输入逐字节一致');
});

test('剔色彩块：非 PNG / 截断 / 空 → 原样返回不抛错', () => {
  const junk = Buffer.from('hello world, not a png at all');
  assert.ok(stripPngColorChunks(junk).equals(junk));
  assert.ok(stripPngColorChunks(Buffer.alloc(0)).equals(Buffer.alloc(0)));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(stripPngColorChunks(sig).equals(sig)); // 只有签名（截断）
  assert.equal(stripPngColorChunks(null), null);
});
