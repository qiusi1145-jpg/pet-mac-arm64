'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GestureTracker, simulate } = require('../../src/shared/gesture');

const DOWN = (t, x = 50, y = 50, button = 0) => ({ type: 'down', x, y, t, button });
const MOVE = (t, x, y) => ({ type: 'move', x, y, t });
const UP = (t, button = 0) => ({ type: 'up', t, button });

test('左键短点(无位移) → tap(摸头)', () => {
  const a = simulate([DOWN(0), UP(30)]);
  assert.deepEqual(a.map((x) => x.type), ['tap']);
});

test('微小位移仍算 tap', () => {
  const a = simulate([DOWN(0), MOVE(10, 53, 52), MOVE(20, 52, 54), UP(40)]);
  assert.deepEqual(a.map((x) => x.type), ['tap']);
});

test('位移超过容差 → 转拖动，松开给 release', () => {
  const a = simulate([DOWN(0), MOVE(10, 60, 50), MOVE(20, 80, 50), MOVE(30, 100, 50), UP(40)]);
  const rel = a.find((x) => x.type === 'release');
  assert.ok(rel, '应有 release');
  assert.equal(rel.moved, true);
});

test('快速甩动 → release.speed 超过抛出阈值(~800px/s)', () => {
  const ev = [
    DOWN(0, 50, 50),
    MOVE(20, 55, 50), MOVE(30, 60, 50), MOVE(40, 80, 50),
    MOVE(50, 120, 50), MOVE(60, 160, 50), MOVE(70, 200, 50), UP(75, 0),
  ];
  const a = simulate(ev);
  const rel = a.find((x) => x.type === 'release');
  assert.ok(rel && rel.speed > 800, `speed=${rel && rel.speed}`);
  assert.ok(rel.vx > 0, '向右甩应 vx>0');
});

test('缓慢拖动释放 → speed 低于抛出阈值', () => {
  const ev = [
    DOWN(0, 50, 50), MOVE(50, 58, 50), MOVE(150, 66, 50), MOVE(250, 74, 50), UP(280, 0),
  ];
  const a = simulate(ev);
  const rel = a.find((x) => x.type === 'release');
  assert.ok(rel, '应有 release');
  assert.ok(rel.speed < 300, `speed=${rel.speed}`);
});

test('左键长按 3s（不移动）→ longpress-toggle，且 0.5s 后出现 ring', () => {
  const a = simulate([
    DOWN(0, 50, 50),
    { type: 'tick', t: 600 },   // 超过 ringDelay 500
    { type: 'tick', t: 3100 },  // 达到 longPress 3000
  ]);
  const types = a.map((x) => x.type);
  assert.ok(types.includes('ring'));
  assert.ok(types.includes('longpress-toggle'));
});

test('右键长按 1.5s → menu（阈值与左键锁定拆开）', () => {
  const a = simulate([
    DOWN(0, 50, 50, 2),
    { type: 'tick', t: 1600 },
  ]);
  assert.deepEqual(a.map((x) => x.type), ['menu']);
});

test('右键长按不足 1.5s → 无 menu', () => {
  const a = simulate([
    DOWN(0, 50, 50, 2),
    { type: 'tick', t: 1400 },
  ]);
  assert.deepEqual(a, []);
});

test('同一 1.6s 时长：右键出菜单，左键仍不算锁定', () => {
  const right = simulate([DOWN(0, 50, 50, 2), { type: 'tick', t: 1600 }]);
  const left = simulate([DOWN(0, 50, 50), { type: 'tick', t: 1600 }]);
  assert.deepEqual(right.map((x) => x.type), ['menu']);
  assert.ok(!left.some((x) => x.type === 'longpress-toggle'), '左键锁定应仍为 3s');
});

test('右键快速松开 → 无动作', () => {
  const a = simulate([DOWN(0, 50, 50, 2), UP(40, 2)]);
  assert.deepEqual(a, []);
});

test('拖拽中鼠标静止但长时间按住 → 不触发 tap/长按', () => {
  // 已在 drag 模式后即使按住很久也不应触发 toggle
  const tr = new GestureTracker();
  tr.pointerDown({ x: 50, y: 50, t: 0, button: 0 });
  tr.pointerMove({ x: 80, y: 50, t: 20 });  // 触发 drag
  tr.tick(4000);                            // 长按已无意义
  const snaps = tr.snapshot();
  assert.equal(snaps.dragging, true);
  assert.deepEqual(tr.drainActions(), []);
  tr.pointerUp({ t: 4100 });
  const acts = tr.drainActions();
  assert.equal(acts.some((x) => x.type === 'longpress-toggle'), false);
  assert.equal(acts.some((x) => x.type === 'release'), true);
});

test('一次按下只会触发一次长按（tapLocked 去重）', () => {
  const tr = new GestureTracker();
  tr.pointerDown({ x: 50, y: 50, t: 0, button: 0 });
  tr.tick(3500);
  tr.tick(4000);
  const acts = tr.drainActions();
  assert.equal(acts.filter((x) => x.type === 'longpress-toggle').length, 1);
});
