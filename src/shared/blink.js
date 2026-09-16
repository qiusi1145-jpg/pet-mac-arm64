'use strict';

const { CFG } = require('./config');

/**
 * 清洗"眨眼动画"帧配置（config.js 帧 → 安全结构，纯函数）。
 * 帧必须带非空 path；durationMs 缺失/非法时回退 defaultFrameMs，并夹到 [30, 5000]ms。
 */
function normalizeBlinkFrames(raw) {
  const fallbackMs = CFG.blinkAnim.defaultFrameMs;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw) {
    if (!f || typeof f.path !== 'string' || !f.path.trim()) continue;
    const d = Number(f.durationMs);
    const durationMs = Number.isFinite(d) ? Math.min(5000, Math.max(30, Math.round(d))) : fallbackMs;
    out.push({ path: f.path, durationMs });
  }
  return out;
}

/**
 * 一次眨眼/特效起播机会是否命中（触发概率 0~1，rng 可注入测试）。
 * probability <= 0 永不播；>= 1 必播；中间按概率掷骰。
 */
function shouldPlayBlinkAnim(probability, rng = Math.random) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (p >= 1) return true;
  return rng() < p;
}

/**
 * 呼吸零点检测（眨眼/特效的起播门禁，纯函数）：
 * prevOff/curOff = 主呼吸波的缩放偏移（scale - 1），符号翻转 = 波形恰好经过未变形尺寸。
 * 任一为 0 不算翻转（呼吸幅度渐入期、暂停恢复瞬间不误触发）；非数一律 false。
 */
function isBreathZeroCross(prevOff, curOff) {
  if (!Number.isFinite(prevOff) || !Number.isFinite(curOff)) return false;
  if (prevOff === 0 || curOff === 0) return false;
  return prevOff > 0 !== curOff > 0;
}

module.exports = { normalizeBlinkFrames, shouldPlayBlinkAnim, isBreathZeroCross };

