'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GestureTracker, simulate,
  springParams, integrateSpring, impulse, breathe,
  step, atRest,
  chooseSnapTarget, shouldDetach,
} = require('../../src/shared/motion');
const { CFG } = require('../../src/shared/config');

/* ================= 物理 ================= */

const WORLD = { w: 1707, h: 1019 };
const PET = { w: 96, h: 96 };

/** 掷出一记弹道，跑到静止/步数上限，校验全程不越界。 */
function throwAndTrack(x, y, vx, vy, maxSteps = 60 * 12) {
  let s = { x, y, vx, vy, grounded: false, ...PET };
  const maxX = WORLD.w - PET.w, maxY = WORLD.h - PET.h;
  let landed = 0, minY = Infinity;
  for (let i = 0; i < maxSteps; i++) {
    const r = step(s, 1 / 60, WORLD);
    if (r.landed) landed++;
    s = r.s;
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), '状态应为有限数');
    assert.ok(s.x >= -1e-6 && s.x <= maxX + 1e-6, `x 越界: ${s.x}`);
    assert.ok(s.y >= -1e-6 && s.y <= maxY + 1e-6, `y 越界: ${s.y}`);
    minY = Math.min(minY, s.y);
    if (atRest(s) && s.y >= maxY - 0.5) break;
  }
  return { s, landed, minY };
}

test('物理红线：抛掷后无论怎么撞，始终留在区域内并最终静止在地面', () => {
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

test('物理：重力和反弹能量递减：连续落地速度严格衰减（restitution<1）', () => {
  const P = CFG.physics;
  const impacts = [];
  let s = { x: 800, y: 300, vx: 0, vy: -500, grounded: false, ...PET };
  for (let i = 0; i < 60 * 10; i++) {
    const r = step(s, 1 / 60, WORLD);
    s = r.s;
    if (r.landed) impacts.push(Math.abs(s.vy));
    if (atRest(s) && s.grounded) break;
  }
  assert.ok(impacts.length >= 2, `应至少反弹几次，实际 ${impacts.length}`);
  for (let i = 1; i < impacts.length; i++) {
    assert.ok(impacts[i] < impacts[i - 1] * (1 + 1e-9), `反弹速度应递减: ${impacts[i - 1]} -> ${impacts[i]}`);
  }
  const ratio = impacts[1] / impacts[0];
  assert.ok(Math.abs(ratio - P.restitution) < 0.05, `反弹比应≈restitution: ${ratio}`);
});

test('物理：静止贴地：速度低于阈值不再回弹，直接贴住并停下', () => {
  let s = { x: 500, y: 900, vx: 60, vy: 0, grounded: false, ...PET };
  let groundedEver = false;
  for (let i = 0; i < 60 * 4; i++) {
    s = step(s, 1 / 60, WORLD).s;
    if (s.grounded) groundedEver = true;
    if (atRest(s) && s.grounded) break;
  }
  assert.ok(groundedEver, '低速应能贴地');
  assert.ok(atRest(s), '最终应静止');
  assert.ok(s.y >= WORLD.h - PET.h - 0.5, '停在地面');
});

test('物理：拖动是 1:1 跟随：step 只在显式调用时改变位置', () => {
  const s = { x: 700, y: 800, vx: 0, vy: 0, grounded: true, ...PET };
  const r = step(s, 1 / 60, WORLD);
  assert.ok(Math.abs(r.s.x - 700) < 1e-9 && Math.abs(r.s.y - 800) < 1e-9, '贴地无速度时位置不变');
});

test('物理：尺寸跨步保留：返回值带 w/h，后续边界钳制不失效', () => {
  let s = { x: 800, y: 917, vx: 700, vy: -800, grounded: false, ...PET };
  const { s: next } = step(s, 1 / 60, WORLD);
  assert.equal(next.w, PET.w, '返回值应保留宽');
  assert.equal(next.h, PET.h, '返回值应保留高');
  let cur = next;
  const floor = WORLD.h - PET.h;
  let maxYseen = cur.y;
  for (let i = 0; i < 60 * 8; i++) {
    cur = step(cur, 1 / 60, WORLD).s;
    maxYseen = Math.max(maxYseen, cur.y);
    if (atRest(cur) && cur.y >= floor - 0.5) break;
  }
  assert.ok(maxYseen <= floor + 1e-6, `不得穿过地板，实际到 ${maxYseen}`);
});

/* ================= 像素级碰撞盒（col） ================= */

const COL = { ox: 4, oy: 4, w: 88, h: 88 }; // 96×96 图四周各 4px 透明边距

test('物理：碰撞盒落地：实体像素贴地，透明边距悬出地面之下不产生“悬空”', () => {
  let s = { x: 500, y: 0, vx: 0, vy: 0, grounded: false, w: 96, h: 96, col: { ...COL } };
  for (let i = 0; i < 60 * 6; i++) s = step(s, 1 / 60, WORLD).s;
  assert.ok(s.grounded, '最终应贴地');
  const expectY = WORLD.h - COL.oy - COL.h; // 碰撞盒底边 = world.h
  assert.ok(Math.abs(s.y - expectY) < 0.5, `y=${s.y} 应为 ${expectY}（整图落地会是 ${WORLD.h - 96}，视觉悬空 4px）`);
});

test('物理：碰撞盒跨步自包含：返回值必须带 col（红线：丢字段 = 边界静默失效）', () => {
  const r = step({ x: 0, y: 0, vx: 100, vy: 0, grounded: false, w: 96, h: 96, col: { ...COL } }, 1 / 60, WORLD);
  assert.deepEqual(r.s.col, COL);
});

test('物理：无 col 的旧状态回退整图包围盒（兼容旧调用方）', () => {
  const r = step({ x: 0, y: 0, vx: 0, vy: 100, grounded: false, ...PET }, 1 / 60, WORLD);
  assert.deepEqual(r.s.col, { ox: 0, oy: 0, w: PET.w, h: PET.h });
});

test('物理：碰撞盒贴墙：左透明边距允许悬出，实体像素触壁才反弹', () => {
  // x=-2：整图越界但碰撞盒左缘 = -2+4 = 2 > 0，未触壁 → 不反弹、位置不夹回 0
  let s = { x: -2, y: 500, vx: -10, vy: 0, grounded: false, w: 96, h: 96, col: { ...COL } };
  const r1 = step(s, 1 / 60, WORLD);
  assert.equal(r1.hitWall, false, '透明边距悬出不算触壁');
  assert.equal(r1.s.grounded, false);
  // x=-8：碰撞盒左缘 = -4 < 0 → 触壁反弹并钳回 -ox
  s = { x: -8, y: 500, vx: -500, vy: 0, grounded: false, w: 96, h: 96, col: { ...COL } };
  const r2 = step(s, 1 / 60, WORLD);
  assert.equal(r2.hitWall, true, '实体像素触壁应反弹');
  assert.ok(Math.abs(r2.s.x - (-COL.ox)) < 1e-6, `x=${r2.s.x} 应钳到 ${-COL.ox}`);
});

test('物理：碰撞盒右壁与天花板同样按实体像素钳制', () => {
  const maxX = WORLD.w - COL.w - COL.ox;
  let s = { x: maxX + 10, y: 500, vx: 500, vy: 0, grounded: false, w: 96, h: 96, col: { ...COL } };
  const r1 = step(s, 1 / 60, WORLD);
  assert.equal(r1.hitWall, true);
  assert.ok(Math.abs(r1.s.x - maxX) < 1e-6);
  s = { x: 500, y: -10, vx: 0, vy: -500, grounded: false, w: 96, h: 96, col: { ...COL } };
  const r2 = step(s, 1 / 60, WORLD);
  assert.equal(r2.hitCeiling, true);
  assert.ok(Math.abs(r2.s.y - (-COL.oy)) < 1e-6);
});

/* ================= 弹簧（q 弹 / 呼吸） ================= */

test('弹簧：冲量后最终收敛回 1（静止）', () => {
  const P = springParams();
  let st = { s: 1, v: 0 };
  st = impulse(st, -6.2);
  let maxDev = 0;
  for (let i = 0; i < 2000; i++) {
    st = integrateSpring(st, 1 / 60, P);
    maxDev = Math.max(maxDev, Math.abs(st.s - 1));
  }
  assert.ok(Math.abs(st.s - 1) < 1e-3, `s=${st.s}`);
  assert.ok(Math.abs(st.v) < 1e-2, `v=${st.v}`);
  assert.ok(maxDev > 0.05, '压缩后应有明显形变');
});

test('弹簧：挤压后会过冲（Q弹拉长）且幅度受控、不发散', () => {
  const P = springParams();
  let st = { s: 1, v: 0 };
  st = impulse(st, -6.2);
  let maxS = 0, minS = 1;
  for (let i = 0; i < 900; i++) {
    st = integrateSpring(st, 1 / 60, P);
    maxS = Math.max(maxS, st.s);
    minS = Math.min(minS, st.s);
  }
  assert.ok(minS < 0.92, `压缩明显: min=${minS}`);
  assert.ok(maxS > 1.015 && maxS < 1.2, `过冲可见但受控: max=${maxS}`);
  assert.ok(Math.abs(st.s - 1) < 1e-3, '最终回到 1');
});

test('呼吸波：按给定幅度/周期生成，中心为 1', () => {
  const A = 0.015, T = 4200;
  const ys = [];
  for (let t = 0; t < T; t += 25) {
    const b = breathe(t, { amplitude: A, periodMs: T });
    ys.push(b.y);
  }
  const max = Math.max(...ys), min = Math.min(...ys);
  assert.ok(max >= 1 + A - 1e-3, `上峰应接近 1+A: max=${max}`);
  assert.ok(min <= 1 - A + 1e-3, `下谷应接近 1-A: min=${min}`);
  assert.ok(max <= 1 + A + 1e-9 && min >= 1 - A - 1e-9, '不超出给定幅度 A');
  assert.ok(Math.abs((max + min) / 2 - 1) < 1e-3, '以 1 为中心');
});

test('呼吸波：无配置也能跑（用默认 CFG 幅度 ±1.5%）', () => {
  const A = CFG.anim.breatheAmplitude;
  assert.ok(A > 0.014 && A < 0.016, `默认呼吸幅度应≈1.5%（got ${A}）`);
  const ys = [];
  for (let t = 0; t < 4200; t += 50) {
    const b = breathe(t);
    ys.push(b.y);
  }
  const max = Math.max(...ys), min = Math.min(...ys);
  assert.ok(max <= 1 + A + 1e-9 && min >= 1 - A - 1e-9, '峰值不超默认幅度包络');
  assert.ok(max - min > 2 * A * 0.9, `默认呼吸应达到 ~±${A}（got range ${(max - min).toFixed(4)}）`);
  assert.ok(Math.abs((max + min) / 2 - 1) < 1e-3, '以 1 为中心');
});

/* ================= 窗口吸附 ================= */

const W = (p) => ({ id: p.id || 'w', title: p.title || '', cls: 'foo', minimized: false, left: 100, top: 200, right: 700, bottom: 900, ...p });
const P = CFG.physics; // snapProximityY / snapMarginX

test('吸附：锚点水平落在窗口内、垂直贴近顶沿 → 命中该窗口', () => {
  const win = W({ id: 'a', left: 100, right: 700, top: 200 });
  const hit = chooseSnapTarget({ x: 400, y: 200 }, [win]);
  assert.equal(hit, win);
});

test('吸附：多个候选取垂直距离最近的', () => {
  const far = W({ id: 'far', left: 900, right: 1500, top: 200 });
  const near = W({ id: 'near', left: 300, right: 500, top: 210 });
  const closer = W({ id: 'closer', left: 350, right: 450, top: 202 });
  const hit = chooseSnapTarget({ x: 400, y: 200 }, [far, near, closer]);
  assert.equal(hit && hit.id, 'closer');
});

test('吸附：锚点虽贴顶但水平越出窗口范围（超出余量）→ 不命中', () => {
  const win = W({ left: 500, right: 700, top: 200 });
  assert.equal(chooseSnapTarget({ x: 400, y: 200 }, [win]), null);
});

test('吸附：水平在范围内但垂直太远（超过 snapProximityY）→ 不命中', () => {
  const win = W({ left: 300, right: 500, top: 200 });
  assert.equal(chooseSnapTarget({ x: 400, y: 200 + P.snapProximityY + 5 }, [win]), null);
});

test('吸附：允许水平落在窗口边缘外一小段余量内（snapMarginX）', () => {
  const win = W({ left: 500, right: 700, top: 200 });
  const x = 500 - P.snapMarginX;
  assert.ok(chooseSnapTarget({ x, y: 200 }, [win]), '应命中');
  assert.equal(chooseSnapTarget({ x: 500 - P.snapMarginX - 1, y: 200 }, [win]), null, '超出余量不命中');
});

test('吸附：无候选/空列表 → null', () => {
  assert.equal(chooseSnapTarget({ x: 400, y: 200 }, []), null);
  assert.equal(chooseSnapTarget({ x: 400, y: 200 }, [W({ left: 10, right: 20, top: 30 })]), null);
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

/* ================= 手势 ================= */

const DOWN = (t, x = 50, y = 50, button = 0) => ({ type: 'down', x, y, t, button });
const MOVE = (t, x, y) => ({ type: 'move', x, y, t });
const UP = (t, button = 0) => ({ type: 'up', t, button });

test('手势：左键短点(无位移) → tap(摸头)', () => {
  const a = simulate([DOWN(0), UP(30)]);
  assert.deepEqual(a.map((x) => x.type), ['tap']);
});

test('手势：微小位移仍算 tap', () => {
  const a = simulate([DOWN(0), MOVE(10, 53, 52), MOVE(20, 52, 54), UP(40)]);
  assert.deepEqual(a.map((x) => x.type), ['tap']);
});

test('手势：位移超过容差 → 转拖动，松开给 release', () => {
  const a = simulate([DOWN(0), MOVE(10, 60, 50), MOVE(20, 80, 50), MOVE(30, 100, 50), UP(40)]);
  const rel = a.find((x) => x.type === 'release');
  assert.ok(rel, '应有 release');
  assert.equal(rel.moved, true);
});

test('手势：快速甩动 → release.speed 超过抛出阈值(~800px/s)', () => {
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

test('手势：缓慢拖动释放 → speed 低于抛出阈值', () => {
  const ev = [
    DOWN(0, 50, 50), MOVE(50, 58, 50), MOVE(150, 66, 50), MOVE(250, 74, 50), UP(280, 0),
  ];
  const a = simulate(ev);
  const rel = a.find((x) => x.type === 'release');
  assert.ok(rel, '应有 release');
  assert.ok(rel.speed < 300, `speed=${rel.speed}`);
});

test('手势：左键长按 3s（不移动）→ longpress-toggle，且 0.5s 后出现 ring', () => {
  const a = simulate([
    DOWN(0, 50, 50),
    { type: 'tick', t: 600 },
    { type: 'tick', t: 3100 },
  ]);
  const types = a.map((x) => x.type);
  assert.ok(types.includes('ring'));
  assert.ok(types.includes('longpress-toggle'));
});

test('手势：右键长按 1.5s → menu（阈值与左键锁定拆开）', () => {
  const a = simulate([
    DOWN(0, 50, 50, 2),
    { type: 'tick', t: 1600 },
  ]);
  assert.deepEqual(a.map((x) => x.type), ['menu']);
});

test('手势：右键长按不足 1.5s → 无 menu', () => {
  const a = simulate([
    DOWN(0, 50, 50, 2),
    { type: 'tick', t: 1400 },
  ]);
  assert.deepEqual(a, []);
});

test('手势：同一 1.6s 时长：右键出菜单，左键仍不算锁定', () => {
  const right = simulate([DOWN(0, 50, 50, 2), { type: 'tick', t: 1600 }]);
  const left = simulate([DOWN(0, 50, 50), { type: 'tick', t: 1600 }]);
  assert.deepEqual(right.map((x) => x.type), ['menu']);
  assert.ok(!left.some((x) => x.type === 'longpress-toggle'), '左键锁定应仍为 3s');
});

test('手势：右键快速松开 → 无动作', () => {
  const a = simulate([DOWN(0, 50, 50, 2), UP(40, 2)]);
  assert.deepEqual(a, []);
});

test('手势：拖拽中鼠标静止但长时间按住 → 不触发 tap/长按', () => {
  const tr = new GestureTracker();
  tr.pointerDown({ x: 50, y: 50, t: 0, button: 0 });
  tr.pointerMove({ x: 80, y: 50, t: 20 });
  tr.tick(4000);
  const snaps = tr.snapshot();
  assert.equal(snaps.dragging, true);
  assert.deepEqual(tr.drainActions(), []);
  tr.pointerUp({ t: 4100 });
  const acts = tr.drainActions();
  assert.equal(acts.some((x) => x.type === 'longpress-toggle'), false);
  assert.equal(acts.some((x) => x.type === 'release'), true);
});

test('手势：一次按下只会触发一次长按（tapLocked 去重）', () => {
  const tr = new GestureTracker();
  tr.pointerDown({ x: 50, y: 50, t: 0, button: 0 });
  tr.tick(3500);
  tr.tick(4000);
  const acts = tr.drainActions();
  assert.equal(acts.filter((x) => x.type === 'longpress-toggle').length, 1);
});
