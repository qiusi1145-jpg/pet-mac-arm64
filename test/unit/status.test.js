'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDefaultStatus, registerInteraction, feed, rapidInteract, settleStatus,
  rollAffinity, crossedMilestone, deriveStatus,
} = require('../../src/shared/status');

const T0 = 1_700_000_000_000;

test('默认状态：数值正确，lastTs/lastActive 为当前时刻', () => {
  const s = createDefaultStatus(T0);
  assert.equal(s.mood, 80); assert.equal(s.energy, 100); assert.equal(s.satiety, 80);
  assert.equal(s.affinity, 0); assert.equal(s.lastTs, T0); assert.equal(s.lastActive, T0);
});

test('主动互动：情绪 +2、重置空闲计时、记录互动时间', () => {
  let s = createDefaultStatus(T0);
  s = registerInteraction(s, T0 + 1000);
  assert.equal(s.mood, 82);
  assert.equal(s.lastActive, T0 + 1000);
  assert.ok(s.interactions.includes(T0 + 1000));
});

test('喂食：饱食 +20、体力 +5、情绪 +2', () => {
  let s = createDefaultStatus(T0);
  s = feed(s, T0 + 100);
  assert.ok(s.satiety >= 80); // 从 80 可能因 time=0 不减，仅加
  s = { ...createDefaultStatus(T0), satiety: 10, energy: 10 };
  const f = feed(s, T0 + 1);
  assert.equal(f.satiety, 30);
  assert.equal(f.energy, 15);
  assert.equal(f.mood, 82);
});

test('离线结算（一次性大步长）：饱食衰减、体力恢复、情绪空闲才衰减', () => {
  const cfg = require('../../src/shared/config').CFG.status;
  const H = 3600 * 1000; // 1 小时
  let s = createDefaultStatus(T0);
  s = { ...s, mood: 60, energy: 50, satiety: 70, lastActive: T0 - cfg.idleDecayDelayMs - H }; // 空闲已久
  const o = settleStatus(s, T0 + 24 * H, cfg); // 离线一天
  assert.ok(o.satiety < 70, '饱食应衰减');
  assert.ok(o.mood < 60, '情绪应衰减');
  assert.ok(o.energy > 50, '体力应恢复');
  assert.equal(o.lastTs, T0 + 24 * H);
  assert.ok(o.satiety >= 0 && o.mood >= 0 && o.energy <= 100, '数值应夹取');
});

test('疲劳窗口：短时间互动过多 → 体力消耗而非恢复', () => {
  const cfg = { ...require('../../src/shared/config').CFG.status, fatigueThresholdCount: 3, fatigueWindowMs: 300000 };
  let s = createDefaultStatus(T0);
  s = { ...s, energy: 50 };
  for (let i = 0; i < 5; i++) s = registerInteraction(s, T0 + i * 1000, cfg);
  const drained = settleStatus(s, T0 + 10000, cfg);
  assert.ok(drained.energy < 50, '疲劳时应掉体力');
  // 无互动场景（低活跃）→ 恢复
  const idle = { ...createDefaultStatus(T0), energy: 40, interactions: [] };
  const recovered = settleStatus(idle, T0 + 10000, cfg);
  assert.ok(recovered.energy > 40, '非疲劳时应恢复');
});

test('情绪衰减有滞后：在空闲缓冲期内不衰减，超过后速率随时间上升', () => {
  const cfg = { ...require('../../src/shared/config').CFG.status,
    idleDecayDelayMs: 10 * 60000, moodDecayStartPerMin: 0.2, moodDecayMaxPerMin: 2, moodDecayRampMin: 10 };
  let s = createDefaultStatus(T0);
  const during = settleStatus(s, T0 + 9 * 60000, cfg);
  assert.equal(during.mood, 80, '缓冲期内情绪不变');
  const after = settleStatus(s, T0 + 60 * 60000, cfg); // 空闲 50 分钟后的一分钟
  assert.ok(after.mood < 80, '超过缓冲期开始衰减');
});

test('好感度：命中 +1 且上限 100；20/40/… 档跨越返回等级', () => {
  const s = { ...createDefaultStatus(T0), affinity: 19 };
  const hit = rollAffinity(s, () => 0.0); // 必中
  assert.equal(hit.rolled, true); assert.equal(hit.affinity, 20);
  assert.deepEqual(hit.level, [20]);
  const miss = rollAffinity(s, () => 0.99);
  assert.equal(miss.rolled, false); assert.equal(miss.affinity, 19);
  // 上限
  const cap = rollAffinity({ ...s, affinity: 100 }, () => 0);
  assert.equal(cap.affinity, 100);
});

test('里程碑计算：只有跨过的档位才返回', () => {
  assert.deepEqual(crossedMilestone(0, 19), []);
  assert.deepEqual(crossedMilestone(0, 20), [20]);
  assert.deepEqual(crossedMilestone(21, 45), [40]);
  assert.deepEqual(crossedMilestone(19, 45), [20, 40]);
  assert.deepEqual(crossedMilestone(80, 81), []);
});

test('高频互动（rapidInteract）：短窗口内超过配额按比例扣体力；配额内不扣；只记普通互动', () => {
  const cfg = { ...require('../../src/shared/config').CFG.status, burstWindowMs: 100000, burstQuota: 2, burstEnergyPerExtra: 1 };
  let s = { ...createDefaultStatus(T0), energy: 100 };
  s = rapidInteract(s, T0 + 1000, cfg); // 窗口内第 1 次，配额内不扣
  s = rapidInteract(s, T0 + 1100, cfg); // 第 2 次，配额内不扣
  assert.equal(s.energy, 100, '配额内不扣体力');
  s = rapidInteract(s, T0 + 1200, cfg); // 第 3 次 → over1 → -1
  s = rapidInteract(s, T0 + 1300, cfg); // 第 4 次 → over2 → -2
  s = rapidInteract(s, T0 + 1400, cfg); // 第 5 次 → over3 → -3
  assert.equal(s.energy, 100 - 6, '超出的次数按比例累扣');
  assert.equal(s.mood, 80 + 2 * 5, '每次仍是主动互动：情绪照常 +2');
  assert.equal(s.satiety, 80, '不改变饱食');
});

test('高频判定只看短窗口：超出 burstWindowMs 的旧互动不计入高频', () => {
  const cfg = { ...require('../../src/shared/config').CFG.status, burstQuota: 1, burstEnergyPerExtra: 5, burstWindowMs: 2500 };
  let s = { ...createDefaultStatus(T0), energy: 90, interactions: [T0 - 100000] };
  s = rapidInteract(s, T0, cfg); // 上一次互动在 100s 前 → 本次是窗口内唯一 → 不扣
  assert.equal(s.energy, 90);
});

test('高频惩罚触底夹在 0，不会变负数', () => {
  const cfg = { ...require('../../src/shared/config').CFG.status, burstWindowMs: 100000, burstQuota: 0, burstEnergyPerExtra: 10 };
  let s = { ...createDefaultStatus(T0), energy: 3 };
  s = rapidInteract(s, T0 + 10, cfg);
  assert.equal(s.energy, 0);
});

test('deriveStatus：取整 + 归零判半透明 + 不叠加恢复', () => {
  const v0 = deriveStatus({ mood: 0.0002, energy: 50, satiety: 90, affinity: 12.6 });
  assert.equal(v0.mood, 0); assert.equal(v0.low, true); assert.equal(v0.opacity, 0.45);
  assert.equal(v0.affinity, 12);
  const ok = deriveStatus({ mood: 50, energy: 0.0, satiety: 90, affinity: 0 });
  assert.equal(ok.low, true, '体力归零也算');
  const fine = deriveStatus({ mood: 50, energy: 1, satiety: 90, affinity: 0 });
  assert.equal(fine.low, false); assert.equal(fine.opacity, 1);
});
