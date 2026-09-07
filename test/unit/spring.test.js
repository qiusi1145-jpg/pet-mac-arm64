'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { springParams, integrateSpring, impulse, breathe } = require('../../src/shared/spring');
const { CFG } = require('../../src/shared/config');

test('弹簧冲量后最终收敛回 1（静止）', () => {
  const P = springParams();
  let st = { s: 1, v: 0 };
  st = impulse(st, -6.2); // 摸头量级压缩
  let maxDev = 0;
  for (let i = 0; i < 2000; i++) {
    st = integrateSpring(st, 1 / 60, P);
    maxDev = Math.max(maxDev, Math.abs(st.s - 1));
  }
  assert.ok(Math.abs(st.s - 1) < 1e-3, `s=${st.s}`);
  assert.ok(Math.abs(st.v) < 1e-2, `v=${st.v}`);
  assert.ok(maxDev > 0.05, '压缩后应有明显形变');   // 证明真弹了一下
});

test('挤压后会过冲（Q弹拉长）且幅度受控、不发散', () => {
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

test('呼吸无配置也能跑（用默认 CFG 幅度 ±1.5%）', () => {
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
