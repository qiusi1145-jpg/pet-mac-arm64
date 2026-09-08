'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planBlink } = require('../../src/shared/blink');
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
