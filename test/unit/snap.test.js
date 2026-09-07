'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseSnapTarget, attachTopY, shouldDetach } = require('../../src/shared/snap');
const { CFG } = require('../../src/shared/config');

const W = (p) => ({ id: p.id || 'w', title: p.title || '', cls: 'foo', minimized: false, left: 100, top: 200, right: 700, bottom: 900, ...p });
const P = CFG.physics; // snapProximityY / snapMarginX

test('吸附：锚点水平落在窗口内、垂直贴近顶沿 → 命中该窗口', () => {
  const win = W({ id: 'a', left: 100, right: 700, top: 200 });
  const hit = chooseSnapTarget({ x: 400, y: 200 }, [win]); // 锚点恰在顶沿
  assert.equal(hit, win);
});

test('吸附：多个候选取垂直距离最近的', () => {
  const far = W({ id: 'far', left: 900, right: 1500, top: 200 }); // 水平不含锚点x=400
  const near = W({ id: 'near', left: 300, right: 500, top: 210 });
  const closer = W({ id: 'closer', left: 350, right: 450, top: 202 });
  const hit = chooseSnapTarget({ x: 400, y: 200 }, [far, near, closer]);
  assert.equal(hit && hit.id, 'closer');
});

test('吸附：锚点虽贴顶但水平越出窗口范围（超出余量）→ 不命中', () => {
  const win = W({ left: 500, right: 700, top: 200 });
  assert.equal(chooseSnapTarget({ x: 400, y: 200 }, [win]), null); // x=400 < 500-margin
});

test('吸附：水平在范围内但垂直太远（超过 snapProximityY）→ 不命中', () => {
  const win = W({ left: 300, right: 500, top: 200 });
  assert.equal(chooseSnapTarget({ x: 400, y: 200 + P.snapProximityY + 5 }, [win]), null);
});

test('吸附：允许水平落在窗口边缘外一小段余量内（snapMarginX）', () => {
  const win = W({ left: 500, right: 700, top: 200 });
  const x = 500 - P.snapMarginX; // 刚好在余量内
  assert.ok(chooseSnapTarget({ x, y: 200 }, [win]), '应命中');
  assert.equal(chooseSnapTarget({ x: 500 - P.snapMarginX - 1, y: 200 }, [win]), null, '超出余量不命中');
});

test('吸附：无候选/空列表 → null', () => {
  assert.equal(chooseSnapTarget({ x: 400, y: 200 }, []), null);
  assert.equal(chooseSnapTarget({ x: 400, y: 200 }, [W({ left: 10, right: 20, top: 30 })]), null);
});

test('贴顶位置：底边贴窗口顶 = 顶沿 - 宠物高', () => {
  assert.equal(attachTopY(200, 96), 104);
  assert.equal(attachTopY(0, 64), -64);
});

test('吸附中脱落判定：窗口消失/最小化/移动 → 需坠落；静止且同几何 → 不脱落', () => {
  const snapped = { handle: 'w', left: 100, top: 200, right: 700, bottom: 900, minimized: false };
  assert.ok(shouldDetach(snapped, null), '窗口没了要掉');
  assert.ok(!shouldDetach(snapped, { ...snapped }), '没变不掉');

  assert.ok(shouldDetach(snapped, { ...snapped, minimized: true }), '最小化要掉');
  assert.ok(shouldDetach(snapped, { ...snapped, top: 205 }), '被移动(上下)要掉');
  assert.ok(shouldDetach(snapped, { ...snapped, left: 120 }), '被移动(左右)要掉');
  assert.ok(shouldDetach(snapped, { ...snapped, bottom: 850 }), '被缩放要掉');
});
