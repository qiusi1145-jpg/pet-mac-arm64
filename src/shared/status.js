'use strict';
/**
 * 状态系统（纯函数，0-100 内部保留小数、显示取整、每秒结算）。红线的根基：
 *  归零半透明 / 恢复不透明 / 疲劳窗口 / 离线一次性结算等全部可单测。
 *
 * 状态字段（持久化整份）：
 *  mood/satiety/energy/affinity: 0..100 浮点
 *  lastActive: 最近一次主动互动的毫秒时间戳（情绪空闲衰减从此算）
 *  lastTs:     上次结算的时间戳
 *  interactions: 最近互动时间戳数组（用于疲劳滚动窗口；只保留窗口内）
 */
const { CFG } = require('./config');
const { clamp } = require('./util');

function createDefaultStatus(now, cfg = CFG.status) {
  return {
    mood: cfg.initialMood,
    energy: cfg.initialEnergy,
    satiety: cfg.initialSatiety,
    affinity: cfg.initialAffinity,
    lastActive: now,
    lastTs: now,
    interactions: [],
  };
}

/** 主动互动：情绪 +2 并重置空闲计时、记录互动时间（供疲劳窗口）。返回新对象。 */
function registerInteraction(st, now, cfg = CFG.status) {
  const n = { ...st };
  n.mood = clamp(n.mood + cfg.moodPerInteraction, 0, 100);
  n.lastActive = now;
  n.interactions = pruneInteractions(st.interactions, now, cfg).concat([now]);
  n.lastTs = now;
  return n;
}

function pruneInteractions(list, now, cfg) {
  const cutoff = now - cfg.fatigueWindowMs;
  return list.filter((t) => t >= cutoff);
}

/** 喂食：饱食 +20、体力 +5，同时算一次互动。 */
function feed(st, now, cfg = CFG.status) {
  let n = registerInteraction(st, now, cfg);
  n.satiety = clamp(n.satiety + cfg.satietyPerFeed, 0, 100);
  n.energy = clamp(n.energy + cfg.energyPerFeed, 0, 100);
  return n;
}

/**
 * 高频互动（摸头 / 拖动结束这类普通主动互动，喂食不经过这里）：与 registerInteraction
 * 相同，另加“短时高频”体力惩罚 —— 需求：短时间内大量点击/拖动要轻微按比例消耗体力。
 * 做法：以 burstWindowMs 为滚动窗口，窗口内（含本次）互动次数超过 burstQuota 后，
 * 每多一次按 burstEnergyPerExtra 扣一点体力（可正可负、夹在 0..100）。
 * 与分钟级“疲劳窗口”是两回事（那是 settleStatus 里的连续衰减，这里是即时扣减）。
 */
function rapidInteract(st, now, cfg = CFG.status) {
  let n = registerInteraction(st, now, cfg);
  const cutoff = now - cfg.burstWindowMs;
  const recent = n.interactions.filter((t) => t >= cutoff).length; // 含本次
  const over = Math.max(0, recent - cfg.burstQuota);
  if (over > 0) {
    n.energy = clamp(n.energy - over * cfg.burstEnergyPerExtra, 0, 100);
  }
  return n;
}

/**
 * 结算：把状态从 st.lastTs 推进到 now（dt = now - lastTs）。既可每秒调用，
 * 也可在“离线很久后启动 / 隐藏恢复显示”时一次性调用（同一套衰减模型）。
 * 不修改入参，返回新对象。
 */
function settleStatus(st, now, cfg = CFG.status) {
  const dtMs = Math.max(0, now - (st.lastTs ?? now));
  if (dtMs === 0) return { ...st };
  const dtMin = dtMs / 60000;

  let n = { ...st };
  n.interactions = pruneInteractions(n.interactions, now, cfg);

  // 饱食度：约每小时 -2
  n.satiety = clamp(n.satiety - cfg.satietyDecayPerHour * (dtMs / 3600000), 0, 100);

  // 情绪：空闲（距 lastActive）超过 idleDecayDelayMs 才开始衰减，速率随时间由 start 升到 max。
  const idleMs = Math.max(0, now - n.lastActive - cfg.idleDecayDelayMs);
  if (idleMs > 0) {
    const idleMin = idleMs / 60000;
    const rampMax = cfg.moodDecayRampMin;
    const ratePerMin = Math.min(
      cfg.moodDecayMaxPerMin,
      cfg.moodDecayStartPerMin +
        (cfg.moodDecayMaxPerMin - cfg.moodDecayStartPerMin) * Math.min(1, idleMin / rampMax)
    );
    n.mood = clamp(n.mood - ratePerMin * dtMin, 0, 100);
  }

  // 体力：疲劳（滚动窗口互动 > 阈值）→ 衰减；否则缓慢恢复。
  const activeCount = n.interactions.length;
  const fatigue = activeCount > cfg.fatigueThresholdCount;
  if (fatigue) {
    n.energy = clamp(n.energy - cfg.fatigueDrainPerMin * dtMin, 0, 100);
  } else {
    n.energy = clamp(n.energy + cfg.energyRecoverPerMin * dtMin, 0, 100);
  }
  n.lastTs = now;
  return n;
}

/** 好感度：注入可控随机数 rng∈[0,1)。命中则 +1（不超上限）。返回 {affinity, rolled, level?} */
function rollAffinity(st, rng, cfg = CFG.status) {
  const rolled = rng() < cfg.affinityChance;
  if (!rolled) return { affinity: st.affinity, rolled: false };
  const before = st.affinity;
  const after = clamp(before + 1, 0, cfg.affinityCap);
  return { affinity: after, rolled: true, level: crossedMilestone(before, after, cfg) };
}

/** 返回跨越的里程碑档位（如 20/40/…），[] 表示未跨越。 */
function crossedMilestone(before, after, cfg = CFG.status) {
  const step = cfg.affinityMilestoneStep;
  const out = [];
  const b = Math.floor(before / step), a = Math.floor(after / step);
  for (let lv = b + 1; lv <= a; lv++) out.push(lv * step);
  return out;
}

/** UI 汇总：取整后的数值 + 是否低状态（任一归零）+ 目标不透明度。 */
function deriveStatus(st, cfg = CFG.status) {
  const mood = Math.floor(clamp(st.mood, 0, 100));
  const energy = Math.floor(clamp(st.energy, 0, 100));
  const satiety = Math.floor(clamp(st.satiety, 0, 100));
  const low =
    st.mood <= cfg.zeroEpsilon || st.energy <= cfg.zeroEpsilon || st.satiety <= cfg.zeroEpsilon;
  return {
    mood, energy, satiety,
    affinity: Math.floor(clamp(st.affinity, 0, 100)),
    low,
    opacity: low ? cfg.lowOpacity : 1,
  };
}

module.exports = {
  createDefaultStatus,
  registerInteraction,
  feed,
  rapidInteract,
  settleStatus,
  rollAffinity,
  crossedMilestone,
  deriveStatus,
};
