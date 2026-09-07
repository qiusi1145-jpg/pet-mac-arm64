'use strict';
/** 测试形状构建器（内存位图），供 gen.js 与单测共用。 */
const { makeBitmap, paintRect } = require('../../src/shared/pixel');

/** 实心圆盘。返回 {width,height,data}。 */
function circle(size, radius, rgba) {
  const bm = makeBitmap(size, size, [0, 0, 0, 0]);
  const c = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d <= radius) {
        const o = (y * size + x) * 4;
        bm.data[o] = rgba[0]; bm.data[o + 1] = rgba[1]; bm.data[o + 2] = rgba[2]; bm.data[o + 3] = rgba[3];
      }
    }
  }
  return bm;
}

/** 左右两个分离的实心矩形（用于测包围盒/锚点取中点）。 */
function twoRects(w, h, leftR, rightR, rgba) {
  const bm = makeBitmap(w, h, [0, 0, 0, 0]);
  paintRect(bm, leftR.x0, leftR.y0, leftR.x1, leftR.y1, rgba);
  paintRect(bm, rightR.x0, rightR.y0, rightR.x1, rightR.y1, rgba);
  return bm;
}

/** 全透明位图。 */
function blank(w, h) {
  return makeBitmap(w, h, [0, 0, 0, 0]);
}

module.exports = { circle, twoRects, blank };
