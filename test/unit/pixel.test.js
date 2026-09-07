'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyzeBitmap, hitTestPixel, scalePlan, makeBitmap, paintRect } = require('../../src/shared/pixel');
const { decodePng } = require('../fixtures/png');
const { circle, twoRects, blank } = require('../fixtures/shapes');

const FIX = (n) => path.join(__dirname, '..', 'fixtures', n);
const has = (f) => fs.existsSync(FIX(f));

test('scalePlan: 大图等比缩小到 maxDim，小图不放大', () => {
  assert.deepEqual(scalePlan(1000, 500, 220), { scale: 0.22, width: 220, height: 110 });
  const small = scalePlan(64, 48, 220);
  assert.equal(small.scale, 1);
  assert.deepEqual([small.width, small.height], [64, 48]);
  assert.deepEqual(scalePlan(0, 0, 220), { scale: 0, width: 0, height: 0 });
});

test('analyzeBitmap: 实心圆命中/锚点合理', () => {
  const bm = circle(24, 10, [255, 0, 0, 255]);
  const a = analyzeBitmap(bm);
  assert.equal(a.hasPixels, true);
  assert.ok(a.anchor.x > 10 && a.anchor.x < 14);
  assert.ok(a.anchor.y > 10 && a.anchor.y < 14);
  // 中心命中、四角穿透
  assert.equal(hitTestPixel(bm, 12, 12), true);
  assert.equal(hitTestPixel(bm, 0, 0), false);
  assert.equal(hitTestPixel(bm, 23, 0), false);
  assert.equal(hitTestPixel(bm, 12, 0), false);
  // 越界必穿透
  assert.equal(hitTestPixel(bm, -1, 12), false);
  assert.equal(hitTestPixel(bm, 24, 12), false);
  assert.equal(hitTestPixel(bm, 12.9, 12.1), true); // 小数坐标取整
});

test('analyzeBitmap: 左右双矩形 → bbox 中点 (19.5,19.5)', () => {
  const bm = twoRects(40, 40, { x0: 2, y0: 4, x1: 14, y1: 36 }, { x0: 26, y0: 4, x1: 38, y1: 36 }, [0, 0, 255, 255]);
  const a = analyzeBitmap(bm);
  assert.deepEqual(a.bbox, { x0: 2, y0: 4, x1: 38, y1: 36 });
  assert.ok(Math.abs(a.anchor.x - 19.5) < 1e-6 && Math.abs(a.anchor.y - 19.5) < 1e-6);
  // 两矩形间隙 (20,20) 其实无像素 → 命中 false（间隙穿透）
  assert.equal(hitTestPixel(bm, 20, 20), false);
  assert.equal(hitTestPixel(bm, 8, 20), true);
});

test('阈值：低于 alpha 阈值的半透明不算可交互', () => {
  const bm = makeBitmap(4, 4, [0, 0, 0, 0]);
  paintRect(bm, 0, 0, 2, 2, [255, 255, 255, 10]);  // alpha=10 < 20
  paintRect(bm, 2, 2, 4, 4, [255, 255, 255, 200]); // alpha=200
  assert.equal(hitTestPixel(bm, 1, 1), false);
  assert.equal(hitTestPixel(bm, 3, 3), true);
});

test('全透明图片 hasPixels=false', () => {
  assert.equal(analyzeBitmap(blank(16, 16)).hasPixels, false);
});

// ---- 真实 PNG 文件夹具（生成→解码→命中/不命中） ----
test('真实 PNG 夹具：解码后命中检测与锚点', { skip: !has('circle-24.png') }, () => {
  const bm = decodePng(fs.readFileSync(FIX('circle-24.png')));
  assert.equal(bm.width, 24);
  const a = analyzeBitmap(bm);
  assert.equal(a.hasPixels, true);
  assert.equal(hitTestPixel(bm, 12, 12), true);   // 圆心
  assert.equal(hitTestPixel(bm, 0, 0), false);    // 角落透明
  assert.equal(hitTestPixel(bm, 1, 12), false);   // 圆外
  assert.ok(a.anchor.x > 11 && a.anchor.x < 13);
});

test('真实 PNG 夹具：双矩形锚点 = bbox 中点', { skip: !has('two-rects-40x40.png') }, () => {
  const bm = decodePng(fs.readFileSync(FIX('two-rects-40x40.png')));
  const a = analyzeBitmap(bm);
  assert.ok(Math.abs(a.anchor.x - 19.5) < 1e-6 && Math.abs(a.anchor.y - 19.5) < 1e-6);
  assert.equal(hitTestPixel(bm, 8, 20), true);
  assert.equal(hitTestPixel(bm, 20, 20), false);
});

test('真实 PNG 夹具：空白图 hasPixels=false', { skip: !has('blank-16.png') }, () => {
  const bm = decodePng(fs.readFileSync(FIX('blank-16.png')));
  assert.equal(analyzeBitmap(bm).hasPixels, false);
});
