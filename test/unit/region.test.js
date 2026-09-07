'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultRegionSettings, computeRegion, rectContains, clampPointToRegion } = require('../../src/shared/region');

// 假工作区：1920x1040 @ (0,0)（去掉任务栏）
const WA = { x: 0, y: 0, width: 1920, height: 1040 };

test('默认设置 = 填满整个工作区', () => {
  assert.deepEqual(defaultRegionSettings(WA), { width: 1920, height: 1040 });
});

test('全尺寸区域正好 = 工作区', () => {
  const r = computeRegion(WA, { width: 1920, height: 1040 });
  assert.deepEqual(r, { x: 0, y: 0, width: 1920, height: 1040 });
});

test('缩小区域保持贴底 + 水平居中', () => {
  const r = computeRegion(WA, { width: 1000, height: 600 });
  assert.equal(r.width, 1000);
  assert.equal(r.height, 600);
  assert.equal(r.x, Math.round((1920 - 1000) / 2));     // 水平居中
  assert.equal(r.y + r.height, WA.y + WA.height);       // 底边贴工作区底
});

test('超过工作区会被夹回', () => {
  const r = computeRegion(WA, { width: 99999, height: 99999 });
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1040);
});

test('比宠物还小的最小尺寸被抬高（避免放不下宠物）', () => {
  const r = computeRegion(WA, { width: 1, height: 1 }, 220);
  assert.ok(r.width >= 260 && r.height >= 260);
});

test('rectContains / clampPointToRegion', () => {
  const r = { x: 100, y: 200, width: 500, height: 300 };
  assert.equal(rectContains(r, 100, 200), true);
  assert.equal(rectContains(r, 600, 200), false);
  const c = clampPointToRegion(r, 5, 5);
  assert.deepEqual(c, { x: 100, y: 200 });
  const c2 = clampPointToRegion(r, 700, 700);
  assert.deepEqual(c2, { x: 600, y: 500 }); // margin=0 允许贴到右/下边界
});
