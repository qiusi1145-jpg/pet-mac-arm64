'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planBlink, normalizeBlinkFrames, shouldPlayBlinkAnim } = require('../../src/shared/blink');
const { CFG } = require('../../src/shared/config');

test('眨眼计划：间隔和时长都在配置区间内', () => {
  const plan = planBlink(() => 0.5);
  assert.ok(plan.intervalMs >= CFG.blink.minIntervalMs && plan.intervalMs <= CFG.blink.maxIntervalMs);
  assert.ok(plan.durationMs >= CFG.blink.minDurationMs && plan.durationMs <= CFG.blink.maxDurationMs);
});

test('眨眼计划：随机源决定结果，便于可复现测试', () => {
  const a = planBlink(() => 0.2);
  const b = planBlink(() => 0.2);
  assert.deepEqual(a, b);
  assert.ok(a.intervalMs < CFG.blink.maxIntervalMs);
});

test('眨眼动画帧清洗：非法帧丢弃、时长夹取、缺省回退默认值', () => {
  const out = normalizeBlinkFrames([
    { path: 'a.png', durationMs: 120 },
    { path: '', durationMs: 100 },        // 空 path → 丢弃
    { durationMs: 100 },                  // 无 path → 丢弃
    { path: 'b.png' },                    // 无时长 → 默认
    { path: 'c.png', durationMs: 1 },     // 过小 → 夹到 30
    { path: 'd.png', durationMs: 99999 }, // 过大 → 夹到 5000
    'junk',                               // 非对象 → 丢弃
  ]);
  assert.deepEqual(out, [
    { path: 'a.png', durationMs: 120 },
    { path: 'b.png', durationMs: CFG.blinkAnim.defaultFrameMs },
    { path: 'c.png', durationMs: 30 },
    { path: 'd.png', durationMs: 5000 },
  ]);
  assert.deepEqual(normalizeBlinkFrames(null), []);
  assert.deepEqual(normalizeBlinkFrames('x'), []);
});

test('眨眼动画触发概率：0 永不播、1 必播、中间按 rng 掷骰', () => {
  assert.equal(shouldPlayBlinkAnim(0, () => 0.1), false);
  assert.equal(shouldPlayBlinkAnim(-1, () => 0.1), false);
  assert.equal(shouldPlayBlinkAnim(1, () => 0.999), true);
  assert.equal(shouldPlayBlinkAnim(2, () => 0.999), true); // 超界夹为必播
  assert.equal(shouldPlayBlinkAnim(0.5, () => 0.49), true);
  assert.equal(shouldPlayBlinkAnim(0.5, () => 0.51), false);
  assert.equal(shouldPlayBlinkAnim('bad', () => 0.1), false); // 非法 → 不播
});
