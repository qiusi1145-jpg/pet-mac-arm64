'use strict';
/** 通用纯工具：数值运算，全部无副作用、可单测。 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

const lerp = (a, b, t) => a + (b - a) * t;

const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

/** 把 v 折返到区间内（把超出部分等量反射回来，用于进度等）。 */
const reflect = (v, lo, hi) => {
  const span = hi - lo || 1;
  let d = (v - lo) % (2 * span);
  if (d < 0) d += 2 * span;
  return d > span ? hi - (d - span) : lo + d;
};

/** 判断某个绝对值是否已小到可视为零。 */
const nearZero = (v, eps) => Math.abs(v) < eps;

/** 秒级 dt（ms -> s），带下限保护。 */
const secs = (ms) => Math.max(0, ms) / 1000;

/** 平滑趋近当前值：返回朝向 target 前进 step（不小于 minStep）后的值。 */
const approach = (cur, target, step) => {
  if (cur < target) return Math.min(target, cur + step);
  if (cur > target) return Math.max(target, cur - step);
  return target;
};

module.exports = { clamp, clamp01, lerp, dist, reflect, nearZero, secs, approach };
