'use strict';
/**
 * 果冻动画核心（纯函数）：阻尼弹簧 + 待机呼吸波形。可单测。
 * q 弹（squish-stretch）用“围绕 1 的欠阻尼弹簧”：挤压后自然回弹并略过冲拉伸，再收敛。
 */
const { CFG } = require('./config');

/** 无参数版本（直接用 config 的 q 弹弹簧）——供 renderer 复用同一套常数。 */
function springParams() {
  const f = CFG.anim.squishFrequency; // “回弹频率感”(Hz，越大越抖)
  const w0 = 2 * Math.PI * f;
  const damp = CFG.anim.squishDamping; // 阻尼比 ζ（<1 欠阻尼=有Q弹过冲）
  return { w0, damp };
}

/**
 * 弹簧积分一步（阻尼隐式 + 半隐式欧拉，数值稳定）。
 * @returns {{s:number,v:number}}
 */
function integrateSpring({ s, v }, dt, { w0, damp }) {
  const k = w0 * w0;
  const c = 2 * damp * w0;           // 阻尼系数
  const vn = (v + k * (1 - s) * dt) / (1 + c * dt); // 阻尼向后差分，稳定
  let ns = s + vn * dt;
  let nv = vn;
  if (!Number.isFinite(ns) || !Number.isFinite(nv)) {
    ns = 1; nv = 0; // 数值发散保护
  }
  return { s: ns, v: nv };
}

/** 冲量：给弹簧注入初速度（正值=放大即拉伸、负值=压缩）。 */
function impulse(st, amount) {
  return { s: st.s, v: st.v + amount };
}

/**
 * 待机呼吸：围绕锚点的慢速果冻缩放。
 * 返回 (breatheX, breatheY)；幅度由 CFG.anim.breatheAmplitude 控制（默认 ±1.5%），相位可调。
 */
function breathe(tMs, opts = {}) {
  const A = opts.amplitude ?? CFG.anim.breatheAmplitude;
  const T = opts.periodMs ?? CFG.anim.breathePeriodMs;
  const ph = opts.phaseMs ?? 0;
  const x = 1 + A * Math.sin(((tMs + ph) / T) * 2 * Math.PI);
  const y = 1 + A * Math.sin(((tMs + ph) / T) * 2 * Math.PI + 1.2); // y 稍滞后，带点“蠕动”感
  return { x, y };
}

module.exports = { springParams, integrateSpring, impulse, breathe };
