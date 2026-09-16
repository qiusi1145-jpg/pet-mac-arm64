'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeBlinkFrames, shouldPlayBlinkAnim, isBreathZeroCross } = require('../../src/shared/blink');
const { CFG } = require('../../src/shared/config');

test('眨眼配置：零点触发概率与单图时长存在且合理', () => {
  assert.ok(CFG.blink.zeroChance > 0 && CFG.blink.zeroChance <= 1, `zeroChance=${CFG.blink.zeroChance}`);
  assert.ok(CFG.blink.zeroFrameMs >= 30 && CFG.blink.zeroFrameMs <= 1000, `zeroFrameMs=${CFG.blink.zeroFrameMs}`);
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

test('呼吸零点检测：偏移符号翻转 = 零点；0 / 非数不触发', () => {
  assert.equal(isBreathZeroCross(-0.001, 0.001), true);
  assert.equal(isBreathZeroCross(0.001, -0.001), true);
  assert.equal(isBreathZeroCross(-0.5, -0.4), false);
  assert.equal(isBreathZeroCross(0.5, 0.4), false);
  assert.equal(isBreathZeroCross(0, 0.5), false);   // 渐入期/恢复瞬间不误触发
  assert.equal(isBreathZeroCross(0.5, 0), false);
  assert.equal(isBreathZeroCross(0, 0), false);
  assert.equal(isBreathZeroCross(NaN, 0.5), false);
  assert.equal(isBreathZeroCross(0.5, undefined), false);
});
