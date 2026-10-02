'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GestureTracker, simulate,
  springParams, integrateSpring, impulse, settleSpring,
  step, atRest,
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

// 帧率无关的落地收敛。macOS 软件渲染实测 ~30fps 时宠物会卡在"贴地小弹跳"的极限环里
// 永远回不了待机（一步重力攒下的速度顶穿了速度阈值）；低帧率的 Windows 机器同样会中。
test('物理：低帧率下也必须收敛到贴地静止（回弹判据用弹起高度，不用速度）', () => {
  for (const fps of [60, 30, 15]) {
    const dt = 1 / fps;
    let s = { x: 500, y: 0, vx: 0, vy: 0, grounded: false, w: 96, h: 96, col: { ...COL } };
    let settled = -1;
    for (let i = 0; i < Math.ceil(8 * fps); i++) {   // 最多给 8 秒
      s = step(s, dt, WORLD).s;
      if (atRest(s)) { settled = i; break; }
    }
    assert.ok(settled >= 0, `${fps}fps 下 8 秒内未收敛（vy=${s.vy.toFixed(2)} grounded=${s.grounded}）`);
    assert.ok(settled <= 4 * fps, `${fps}fps 收敛用了 ${(settled / fps).toFixed(2)}s，超过 4s 上限`);
  }
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

/* ---------- 收位（q 弹尾巴不再改写 CSS 缩放） ----------
 * 现象是用户 2026-10-02 反馈的"弹完之后整张图闪烁和震颤"。根因不在动画，而在**看不见的
 * 千分位缩放仍被逐帧写给浏览器**：主图 2048 见方按 386 CSS px 显示（下采样比 3.54），
 * 缩放比每变一次整张图就重新光栅化一次（实测 scale(1,1.0001) vs scale(1,1) 差 23736 个像素、
 * 最大色差 235/255），而弹簧尾巴会反复跨过 4 位小数的取整边界 → 画面闪+抖。 */

test('settleSpring：偏离与速度都进 eps → 吸附到精确的 {1,0}', () => {
  const P = springParams();
  const E = CFG.anim.squishRestEps;
  assert.deepEqual(settleSpring({ s: 1 + E / 2, v: 0 }, P), { s: 1, v: 0 });
  assert.deepEqual(settleSpring({ s: 1 - E / 2, v: P.w0 * E / 2 }, P), { s: 1, v: 0 });
  // 还在明显形变 / 还有速度余量 → 一个字都不改（不能把回弹中的身体硬按住）
  const big = { s: 1 + E * 2, v: 0 };
  assert.equal(settleSpring(big, P), big);
  const fast = { s: 1, v: P.w0 * E * 2 };
  assert.equal(settleSpring(fast, P), fast);
});

test('settleSpring：配置阈值可见性 —— eps 换算成屏幕位移必须小于 1 CSS px', () => {
  const E = CFG.anim.squishRestEps;
  assert.ok(Number.isFinite(E) && E > 0 && E <= 0.005, `squishRestEps=${E}`);
  assert.ok(E * CFG.image.petMaxDim < 1, `${E} × 显示宽 ${CFG.image.petMaxDim} = ${(E * CFG.image.petMaxDim).toFixed(3)}px，吸附那一下必须看不出来`);
});

for (const hz of [30, 60, 240]) {
  test(`摸头之后：CSS 缩放串必须**停止改写**并回到空串（${hz}Hz）`, () => {
    const P = springParams();
    const dt = 1 / hz;
    let x = impulse({ s: 1, v: 0 }, CFG.anim.headpatImpulse * 0.35);
    let y = impulse({ s: 1, v: 0 }, -CFG.anim.headpatImpulse);
    // 与渲染层 setScale 逐字同构：4 位小数、恒等时交回空串
    const write = (sx, sy) => (sx === 1 && sy === 1 ? '' : `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`);
    let lastNonEmpty = -1, t = 0, sawDeform = 0;
    for (let i = 0; i < 8 * hz; i++) {
      x = settleSpring(integrateSpring(x, dt, P), P);
      y = settleSpring(integrateSpring(y, dt, P), P);
      t += dt;
      const css = write(x.s, y.s);
      if (css !== '') lastNonEmpty = t;
      if (Math.abs(y.s - 1) > 0.02) sawDeform++;
    }
    assert.ok(sawDeform >= hz * 0.1, '形变本身被吞了：q 弹看不见就没意义了');
    assert.ok(lastNonEmpty >= 0, '至少弹起来过');
    // 0.7s 这条线是有对照的（同一套积分实测）：没收位时 30Hz=3.53s、60Hz=2.97s、240Hz 8 秒内
    // 从未停过；收位后分别是 0.50 / 0.43 / 0.36s。取 0.7 给 30Hz 的帧粒度留一格余量。
    assert.ok(lastNonEmpty < 0.7,
      `${hz}Hz 下缩放串到 ${lastNonEmpty.toFixed(2)}s 还在被改写（尾巴没收位 → 整张图持续重绘=闪+抖）`);
  });
}

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
