'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeBlinkFrames, shouldPlayBlinkAnim } = require('../../src/shared/blink');
const { CFG } = require('../../src/shared/config');

test('眨眼配置：随机心跳间隔与单图时长存在且合理', () => {
  const b = CFG.blink;
  assert.ok(b.minIntervalMs > 0, `minIntervalMs=${b.minIntervalMs}`);
  assert.ok(b.maxIntervalMs > b.minIntervalMs, `间隔区间反了：${b.minIntervalMs}~${b.maxIntervalMs}`);
  assert.ok(b.frameMs >= 30 && b.frameMs <= 1000, `frameMs=${b.frameMs}`);
});

test('待机呼吸已整体删除（配置与纯函数都不该再回来）', () => {
  assert.equal(CFG.anim.breatheAmplitude, undefined, 'CFG.anim.breatheAmplitude 仍在');
  assert.equal(CFG.anim.breathePeriodMs, undefined, 'CFG.anim.breathePeriodMs 仍在');
  assert.equal(CFG.blink.zeroChance, undefined, 'CFG.blink.zeroChance（呼吸零点概率）仍在');
  assert.equal(CFG.blink.zeroFrameMs, undefined, 'CFG.blink.zeroFrameMs 仍在');
  assert.equal(require('../../src/shared/motion').breathe, undefined, 'motion.breathe 仍在');
  assert.equal(require('../../src/shared/blink').isBreathZeroCross, undefined, 'blink.isBreathZeroCross 仍在');
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
