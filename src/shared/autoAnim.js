'use strict';
/**
 * 「自动动画」的纯逻辑 —— 原「眨眼」与「随机特效」两套调度合并而来。
 *
 * 行为线（用户 2026-10-02 定稿）：
 *   每 6~7 秒到点一次；到点先按 chance（默认 80%）掷一次，不中就什么也不做、等下一次；
 *   命中后从 groups 里随机挑一组播放（三种动画 = 三组，帧数分别 1 / 1 / 2），
 *   每帧 frameMs（默认 150ms），播完回主图。
 *
 * 全部无副作用、随机数由调用方注入（渲染层传 Math.random，单测传可控序列），
 * 所以"间隔区间 / 掷概率 / 随机选组 / 配置清洗"都能在 node --test 里锁死，不用真等。
 */
const { CFG } = require('./config');

const clampNum = (v, def, lo, hi) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : def;
};

/**
 * 清洗 CFG.autoAnim（手改配置可能出现非法值，与 typingCfg 同思路）。
 * 两条不许放松的守卫：max 不得小于 min（否则 nextDelayMs 会算出负等待），
 * 空组/无 path 的帧一律丢掉（否则起播会显示残缺）。
 */
function normalizeAutoAnim(raw = CFG.autoAnim) {
  const src = raw || {};
  const min = clampNum(src.minIntervalMs, 6000, 500, 600000);
  const max = clampNum(src.maxIntervalMs, 7000, 500, 600000);
  const chance = Number(src.chance);
  const groups = (Array.isArray(src.groups) ? src.groups : [])
    .map((g) => ({
      name: String((g && g.name) || '动画'),
      frames: (g && Array.isArray(g.frames) ? g.frames : []).filter((f) => typeof f === 'string' && f),
    }))
    .filter((g) => g.frames.length > 0);
  return {
    minIntervalMs: min,
    maxIntervalMs: Math.max(min, max),
    chance: Number.isFinite(chance) ? Math.min(1, Math.max(0, chance)) : 0.8,
    frameMs: clampNum(src.frameMs, 150, 30, 5000),
    groups,
  };
}

/** 下一次到点的等待毫秒数（min~max 均匀随机；区间被清洗成相等时就是定值）。 */
function nextDelayMs(cfg, rng = Math.random) {
  const r = Number.isFinite(Number(rng())) ? Math.min(1, Math.max(0, Number(rng()))) : 0;
  return Math.round(cfg.minIntervalMs + r * (cfg.maxIntervalMs - cfg.minIntervalMs));
}

/** 到点了播不播：掷一次 chance。0 = 永不播，1 = 必播。无组可播时一律不播。 */
function shouldAnimate(cfg, rng = Math.random) {
  if (!cfg.groups.length) return false;
  const r = Number(rng());
  return Number.isFinite(r) ? r < cfg.chance : false;
}

/** 随机挑一组，返回下标；没有可用组返回 -1。 */
function pickGroupIndex(cfg, rng = Math.random) {
  const n = cfg.groups.length;
  if (!n) return -1;
  const r = Number(rng());
  if (!Number.isFinite(r)) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor(Math.abs(r) * n)));
}

module.exports = { normalizeAutoAnim, nextDelayMs, shouldAnimate, pickGroupIndex };
