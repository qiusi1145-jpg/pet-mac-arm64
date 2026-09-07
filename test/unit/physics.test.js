'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const physics = require('../../src/shared/physics');
const { CFG } = require('../../src/shared/config');

const WORLD = { w: 1707, h: 1019 };
const PET = { w: 96, h: 96 };

/** 掷出一记弹道，跑到静止/步数上限，校验全程不越界。 */
function throwAndTrack(x, y, vx, vy, maxSteps = 60 * 12) {
  let s = { x, y, vx, vy, grounded: false, ...PET };
  const maxX = WORLD.w - PET.w, maxY = WORLD.h - PET.h;
  let landed = 0, minY = Infinity;
  for (let i = 0; i < maxSteps; i++) {
    const r = physics.step(s, 1 / 60, WORLD);
    if (r.landed) landed++;
    s = r.s;
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), '状态应为有限数');
    assert.ok(s.x >= -1e-6 && s.x <= maxX + 1e-6, `x 越界: ${s.x}`);
    assert.ok(s.y >= -1e-6 && s.y <= maxY + 1e-6, `y 越界: ${s.y}`);
    minY = Math.min(minY, s.y);
    if (physics.atRest(s) && s.y >= maxY - 0.5) break;
  }
  return { s, landed, minY };
}

test('红线：抛掷后无论怎么撞，宠物始终留在活动区域内并最终静止在地面', () => {
  // 一组刁钻初速：向上猛抛、水平平抛、向下砸、朝角上猛甩
  const throws = [
    [800, 917, 0, -2000], [800, 400, 0, 1200], [10, 10, 1500, -1500],
    [1600, 900, -1400, -100], [805, 100, 900, 900], [100, 500, 1800, 0],
    [805, 500, -2000, -2000], [805, 500, 2000, 2000],
  ];
  for (const [x, y, vx, vy] of throws) {
    const { s, landed } = throwAndTrack(x, y, vx, vy);
    assert.ok(landed >= 1, `应发生过落地(t=${[x, y, vx, vy].join(',')})`);
    assert.ok(s.y >= WORLD.h - PET.h - 0.5, '最终应停在地面');
    assert.ok(s.grounded, '最终应贴地');
  }
});

test('重力和反弹能量递减：连续落地速度严格衰减（restitution<1）', () => {
  const P = CFG.physics;
  // 采集“每次落地反弹后的初速”序列，应单调递减
  const impacts = [];
  let s = { x: 800, y: 300, vx: 0, vy: -500, grounded: false, ...PET };
  for (let i = 0; i < 60 * 10; i++) {
    const r = physics.step(s, 1 / 60, WORLD);
    s = r.s;
    if (r.landed) impacts.push(Math.abs(s.vy)); // 落地后 vy 已是反弹负速度
    if (physics.atRest(s) && s.grounded) break;
  }
  assert.ok(impacts.length >= 2, `应至少反弹几次，实际 ${impacts.length}`);
  for (let i = 1; i < impacts.length; i++) {
    assert.ok(impacts[i] < impacts[i - 1] * (1 + 1e-9), `反弹速度应递减: ${impacts[i - 1]} -> ${impacts[i]}`);
  }
  // 数值应与 restitution 一致（半隐式欧拉离散引入 ~±3% 误差，故留裕度）
  const ratio = impacts[1] / impacts[0];
  assert.ok(Math.abs(ratio - P.restitution) < 0.05, `反弹比应≈restitution: ${ratio}`);
});

test('静止贴地：速度低于阈值不再回弹，直接贴住并停下', () => {
  // 低速落地（例如轻微下滑）应贴地静止而不是弹跳
  let s = { x: 500, y: 900, vx: 60, vy: 0, grounded: false, ...PET };
  let groundedEver = false;
  for (let i = 0; i < 60 * 4; i++) {
    s = physics.step(s, 1 / 60, WORLD).s;
    if (s.grounded) groundedEver = true;
    if (physics.atRest(s) && s.grounded) break;
  }
  assert.ok(groundedEver, '低速应能贴地');
  assert.ok(physics.atRest(s), '最终应静止');
  assert.ok(s.y >= WORLD.h - PET.h - 0.5, '停在地面');
});

test('拖动是 1:1 跟随：launch/step 只在显式调用时改变位置', () => {
  // 物理模块本身不监听任何鼠标事件 —— 它只在被调用时积分。这里验证：
  // 纯静止（不 launch、不 step）状态不漂移（由渲染层保证拖动不经积分）。
  const s = { x: 700, y: 800, vx: 0, vy: 0, grounded: true, ...PET };
  const r = physics.step(s, 1 / 60, WORLD);
  assert.ok(Math.abs(r.s.x - 700) < 1e-9 && Math.abs(r.s.y - 800) < 1e-9, '贴地无速度时位置不变');
});

test('尺寸跨步保留：step 返回值带 w/h，后续边界钳制不失效', () => {
  // 回归：曾因 o 丢弃 w/h 使 maxX/maxY=NaN，宠物直接穿出区域自由落体。
  let s = { x: 800, y: 917, vx: 700, vy: -800, grounded: false, ...PET };
  const { s: next } = physics.step(s, 1 / 60, WORLD);
  assert.equal(next.w, PET.w, '返回值应保留宽');
  assert.equal(next.h, PET.h, '返回值应保留高');
  // 用返回值继续迭代，必须能弹回（不再 NaN 钳制）
  let cur = next;
  const floor = WORLD.h - PET.h;
  let maxYseen = cur.y;
  for (let i = 0; i < 60 * 8; i++) {
    cur = physics.step(cur, 1 / 60, WORLD).s;
    maxYseen = Math.max(maxYseen, cur.y);
    if (physics.atRest(cur) && cur.y >= floor - 0.5) break;
  }
  assert.ok(maxYseen <= floor + 1e-6, `不得穿过地板，实际到 ${maxYseen}`);
});
