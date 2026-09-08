'use strict';

const { CFG } = require('./config');

/** 生成下一次眨眼的随机计划（间隔 + 时长），便于单元测试注入随机源。 */
function planBlink(rng = Math.random) {
  const c = CFG.blink;
  return {
    intervalMs: c.minIntervalMs + rng() * Math.max(0, c.maxIntervalMs - c.minIntervalMs),
    durationMs: c.minDurationMs + rng() * Math.max(0, c.maxDurationMs - c.minDurationMs),
  };
}

module.exports = { planBlink };
