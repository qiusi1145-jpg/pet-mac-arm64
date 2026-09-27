'use strict';
/** 生成测试夹具 PNG（圆、双矩形、全透明、实心宠物样本）。 */
const fs = require('fs');
const path = require('path');
const { encodePng } = require('../../src/shared/png');
const { circle, twoRects, blank } = require('./shapes');

function write(name, bm) {
  const f = path.join(__dirname, name);
  fs.writeFileSync(f, encodePng(bm));
  console.log('wrote', f, `${bm.width}x${bm.height}`);
}

const op = [255, 80, 80, 255];
write('circle-24.png', circle(24, 10, op));
write('circle-64.png', circle(64, 28, op));
write('two-rects-40x40.png', twoRects(40, 40, { x0: 2, y0: 4, x1: 14, y1: 36 }, { x0: 26, y0: 4, x1: 38, y1: 36 }, op));
write('blank-16.png', blank(16, 16));
write('pet-96.png', circle(96, 44, [110, 190, 250, 255])); // UI 自动化宠物
// UI 自动化背景：宽 160×高 64 满幅（左右两块拼满，方便按“宽高比 160/64”断言等比缩放）
write('bg-160x64.png', twoRects(160, 64,
  { x0: 0, y0: 0, x1: 80, y1: 64 },
  { x0: 80, y0: 0, x1: 160, y1: 64 },
  [150, 210, 130, 255]));

// 双矩形：bbox 半开 [2,38)x[4,36)，锚点 = 像素中点 (19.5,19.5)
module.exports = {};
