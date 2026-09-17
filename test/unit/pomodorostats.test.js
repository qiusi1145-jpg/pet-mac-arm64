'use strict';
/**
 * 番茄钟学习记录与成就（shared/pomodoroStats.js）单测。
 * 覆盖：清洗白名单、记账聚合（完整/中断）、连续天数（跨天/断档/同日重复）、
 * 成就解锁（时长/次数/连续/单日/长专注/早鸟/夜猫/心流）、明细截断、坏数据兜底。
 */
const test = require('node:test');
const assert = require('node:assert');
const PS = require('../../src/shared/pomodoroStats');

// config 里成就阶梯默认值：time [60,300,600,3000,6000] / done [1,10,50,100,500]
// / streak [3,7,14,30,100] / day [30,60,120,240] / long [45,60] / flow [4]
const DAY0 = '2026-09-17';
const TS0 = new Date(2026, 8, 17, 10, 0, 0).getTime(); // 2026-09-17 10:00 本地时间

test('normalizeStats：空输入/坏输入 → 空白统计，不抛错', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { entries: 'nope', days: 1 }, { agg: { done: 'x' } }]) {
    const s = PS.normalizeStats(bad);
    assert.strictEqual(s.entries.length, 0);
    assert.strictEqual(s.agg.done, 0);
    assert.strictEqual(s.agg.totalMin, 0);
  }
});

test('normalizeStats：白名单清洗（坏条目剔除、非法日期兜底、ach 白名单）', () => {
  const s = PS.normalizeStats({
    entries: [
      { d: DAY0, s: TS0, plan: 25, got: 25, ok: true, tag: '高数' },
      null,
      { d: 'garbage', s: TS0, got: 5 },              // 日期非法 → 按时间戳兜底
      { got: -3 },                                    // 负数 → 0 分钟（仍保留条目）
    ],
    days: { [DAY0]: 25, 'bad-key': 9 },
    agg: { done: 1, totalMin: 25, hacker: 1 },
    ach: { t60: 111, notAch: 222 },
  });
  assert.strictEqual(s.entries.length, 3);
  assert.strictEqual(s.entries[0].tag, '高数');
  assert.strictEqual(s.days[DAY0], 25);
  assert.strictEqual(s.days['bad-key'], undefined);
  assert.strictEqual(s.agg.done, 1);
  assert.strictEqual(s.agg.hacker, undefined);
  assert.strictEqual(s.ach.t60, 111);
  assert.strictEqual(s.ach.notAch, undefined);
});

test('recordFocus：完成专注 → 聚合正确 + 首次即解锁 count=1 / time=1h(若时长够)', () => {
  const stats = PS.emptyStats();
  const r = PS.recordFocus(stats, { startedAt: TS0, plannedMin: 60, minutes: 60, ok: true, tag: '背单词' }, Date.now());
  assert.strictEqual(r.stats.agg.done, 1);
  assert.strictEqual(r.stats.agg.totalMin, 60);
  assert.strictEqual(r.stats.days[DAY0], 60);
  assert.strictEqual(r.stats.agg.streakCur, 1);
  assert.ok(r.unlocked.some((u) => u.id === 'c1'));
  assert.ok(r.unlocked.some((u) => u.id === 't60'));
  assert.strictEqual(r.stats.ach.t60 > 0, true);
});

test('recordFocus：中断也记账（时长计入累计），但连续天数不加', () => {
  const stats = PS.emptyStats();
  const r = PS.recordFocus(stats, { startedAt: TS0, plannedMin: 25, minutes: 11, ok: false, tag: '' }, Date.now());
  assert.strictEqual(r.stats.agg.abort, 1);
  assert.strictEqual(r.stats.agg.done, 0);
  assert.strictEqual(r.stats.agg.totalMin, 11);
  assert.strictEqual(r.stats.days[DAY0], 11);
  assert.strictEqual(r.stats.agg.streakCur, 0);
  assert.strictEqual(r.unlocked.length, 0); // 中断不该解锁任何成就
});

test('recordFocus：几乎没学（<3 秒折算）→ 忽略不记', () => {
  const stats = PS.emptyStats();
  const r = PS.recordFocus(stats, { startedAt: TS0, plannedMin: 25, minutes: 0.001, ok: false }, Date.now());
  assert.strictEqual(r.entry, null);
  assert.strictEqual(r.stats.entries.length, 0);
});

test('连续天数：跨天递增 / 同日重复不加 / 断档重置 / best 保留', () => {
  const stats = PS.emptyStats();
  const at = (day, hour) => new Date(2026, 8, day, hour, 0, 0).getTime();
  // 9/17（天1）
  PS.recordFocus(stats, { startedAt: at(17, 10), minutes: 25, ok: true }, Date.now());
  // 同日再来一个 → streak 仍是 1
  PS.recordFocus(stats, { startedAt: at(17, 15), minutes: 25, ok: true }, Date.now());
  assert.strictEqual(stats.agg.streakCur, 1);
  // 9/18（天2）
  PS.recordFocus(stats, { startedAt: at(18, 10), minutes: 25, ok: true }, Date.now());
  assert.strictEqual(stats.agg.streakCur, 2);
  // 9/20（断档一天 → 重置为 1；best 停在 2）
  PS.recordFocus(stats, { startedAt: at(20, 10), minutes: 25, ok: true }, Date.now());
  assert.strictEqual(stats.agg.streakCur, 1);
  assert.strictEqual(stats.agg.streakBest, 2);
  // 中断不影响 streak
  PS.recordFocus(stats, { startedAt: at(20, 11), minutes: 5, ok: false }, Date.now());
  assert.strictEqual(stats.agg.streakCur, 1);
});

test('成就：长专注 / 单日纪录 / 早鸟 / 夜猫 / 心流', () => {
  const stats = PS.emptyStats();
  const at = (day, hour, min) => new Date(2026, 8, day, hour, min || 0, 0).getTime();
  // 早鸟：6:30 完成一次 50 分钟专注（同时命中长专注 45）
  let r = PS.recordFocus(stats, { startedAt: at(17, 6, 30), minutes: 50, ok: true }, Date.now());
  assert.ok(r.unlocked.some((u) => u.id === 'p_early'));
  assert.ok(r.unlocked.some((u) => u.id === 'l45'));
  assert.ok(!r.unlocked.some((u) => u.id === 'l60')); // 50 < 60 不解锁
  assert.strictEqual(stats.agg.maxOneMin, 50);
  // 夜猫子：23:30 完成一次 60 分钟（单日 110 → 解锁 d60/d30；t60 阶梯没有 110）
  r = PS.recordFocus(stats, { startedAt: at(17, 23, 30), minutes: 60, ok: true }, Date.now());
  assert.ok(r.unlocked.some((u) => u.id === 'p_owl'));
  assert.ok(r.unlocked.some((u) => u.id === 'l60'));
  assert.ok(r.unlocked.some((u) => u.id === 'd60'));
  assert.strictEqual(stats.agg.bestDayMin, 110);
  // 凌晨 4 点也算夜猫
  assert.strictEqual(stats.agg.owlCnt, 1); // 刚才 23:30 那次
  PS.recordFocus(stats, { startedAt: at(18, 4, 0), minutes: 30, ok: true }, Date.now());
  assert.strictEqual(stats.agg.owlCnt, 2);
  // 心流：连续完成 4 个
  r = PS.recordFocus(stats, { startedAt: at(18, 8, 0), minutes: 10, ok: true, flowStreak: 4 }, Date.now());
  assert.ok(r.unlocked.some((u) => u.id === 'f4'));
  assert.strictEqual(stats.agg.flowBest, 4);
  // 已解锁的成就不重复进 unlocked
  const again = PS.recordFocus(stats, { startedAt: at(18, 10, 0), minutes: 10, ok: true, flowStreak: 5 }, Date.now());
  assert.strictEqual(again.unlocked.length, 0);
  assert.strictEqual(stats.agg.flowBest, 5); // flow 只增不减
});

test('明细截断：超过 statsMaxEntries 只保留最近 N 条（聚合不丢）', () => {
  const stats = PS.emptyStats();
  let t = TS0;
  for (let i = 0; i < 450; i++) {
    t += 60 * 60 * 1000;
    PS.recordFocus(stats, { startedAt: t, minutes: 1, ok: true }, t);
  }
  assert.ok(stats.entries.length <= 400);
  assert.strictEqual(stats.agg.done, 450);       // 聚合全量保留
  assert.strictEqual(stats.agg.totalMin, 450);
});

test('minutesOnDay / minutesSince：按日查询', () => {
  const stats = PS.emptyStats();
  const at = (day, hour) => new Date(2026, 8, day, hour, 0, 0).getTime();
  PS.recordFocus(stats, { startedAt: at(17, 10), minutes: 25, ok: true }, Date.now());
  PS.recordFocus(stats, { startedAt: at(18, 10), minutes: 30, ok: true }, Date.now());
  assert.strictEqual(PS.minutesOnDay(stats, '2026-09-17'), 25);
  assert.strictEqual(PS.minutesOnDay(stats, '2026-09-19'), 0);
  assert.strictEqual(PS.minutesSince(stats, '2026-09-17', '2026-09-18'), 55);
  assert.strictEqual(PS.minutesSince(stats, '2026-09-18'), 30);
});

test('prevDay：跨月/跨年边界', () => {
  assert.strictEqual(PS.prevDay('2026-09-01'), '2026-08-31');
  assert.strictEqual(PS.prevDay('2026-01-01'), '2025-12-31');
  assert.strictEqual(PS.prevDay('2026-03-01'), '2026-02-28');
});
