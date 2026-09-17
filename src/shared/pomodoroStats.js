'use strict';
/**
 * 番茄钟学习记录与成就（纯逻辑，无 DOM / 无 Electron → 可单测）。
 *
 * 数据形态（data/pomodoro-stats.json，主进程持有，渲染层经 IPC 只读）：
 * {
 *   entries: [ { d:'YYYY-MM-DD', s:开始时间戳, plan:计划分钟, got:实际分钟, ok:完整?, tag:'' } ],
 *   days:    { 'YYYY-MM-DD': 当日实际专注分钟 },
 *   agg: {
 *     totalMin,            // 累计实际专注分钟（完整 + 中断都算）
 *     done, abort,         // 完整专注次数 / 中断次数
 *     streakCur, streakBest, streakLast,  // 连续天数（"当天有 ≥1 次完整专注"才算学过）
 *     bestDay:'YYYY-MM-DD'|'', bestDayMin, // 单日纪录
 *     maxOneMin,           // 单次完整专注的最长分钟（长专注成就用）
 *     earlyCnt, owlCnt,    // 早鸟(6-8点)/夜猫(23点-次日5点)完整专注次数
 *     flowBest,            // 一次使用中不中断连续完成专注的最大个数
 *   },
 *   ach: { 成就id: 解锁时间戳 },
 * }
 *
 * 关键规则（与用户确认过，2026-09-17）：
 *  - 中断的专注也记（实际 ≥1 分钟才记），实际时长计入累计；不足 1 分钟忽略；
 *  - 连续天数只认"完整专注"——中断不算学过；
 *  - 每条可带标签（学什么自己填）。
 */
const { CFG } = require('./config');

/** 本地时区的 YYYY-MM-DD（ts 可省 = 现在）。 */
function dayKey(ts) {
  const t = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/** d 的前一天（YYYY-MM-DD）。 */
function prevDay(d) {
  const [y, m, dd] = String(d).split('-').map(Number);
  const t = new Date(y, (m || 1) - 1, dd || 1);
  t.setDate(t.getDate() - 1);
  return dayKey(t.getTime());
}

/** 分钟数清洗：保留 1 位小数、非负、上限 24h。 */
function clampMin(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1440, Math.round(n * 10) / 10);
}

/** 单条记录清洗：非法字段一律兜底，绝不抛错（坏一条不能坏整个文件）。 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.d)) ? String(raw.d) : dayKey(Number(raw.s) || Date.now());
  const s = Number.isFinite(Number(raw.s)) ? Math.round(Number(raw.s)) : 0;
  return {
    d, s,
    plan: clampMin(raw.plan),
    got: clampMin(raw.got),
    ok: raw.ok === true,
    tag: String(raw.tag || '').slice(0, 24),
  };
}

/** 空白统计。 */
function emptyStats() {
  return {
    entries: [],
    days: {},
    agg: {
      totalMin: 0, done: 0, abort: 0,
      streakCur: 0, streakBest: 0, streakLast: '',
      bestDay: '', bestDayMin: 0,
      maxOneMin: 0, earlyCnt: 0, owlCnt: 0, flowBest: 0,
    },
    ach: {},
  };
}

/** 全量清洗（读文件 / IPC 边界都过这里）。 */
function normalizeStats(raw) {
  const base = emptyStats();
  if (!raw || typeof raw !== 'object') return base;
  const out = base;
  const cap = Math.max(1, CFG.pomodoro.statsMaxEntries);
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  for (const e of list.slice(-cap)) {
    const n = normalizeEntry(e);
    if (n) out.entries.push(n);
  }
  if (raw.days && typeof raw.days === 'object') {
    for (const [k, v] of Object.entries(raw.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
        const m = clampMin(v);
        if (m > 0) out.days[k] = m;
      }
    }
  }
  const a = raw.agg && typeof raw.agg === 'object' ? raw.agg : {};
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : def);
  out.agg = {
    totalMin: clampMin(a.totalMin),
    done: Math.floor(num(a.done, 0)),
    abort: Math.floor(num(a.abort, 0)),
    streakCur: Math.floor(num(a.streakCur, 0)),
    streakBest: Math.floor(num(a.streakBest, 0)),
    streakLast: /^\d{4}-\d{2}-\d{2}$/.test(String(a.streakLast)) ? String(a.streakLast) : '',
    bestDay: /^\d{4}-\d{2}-\d{2}$/.test(String(a.bestDay)) ? String(a.bestDay) : '',
    bestDayMin: clampMin(a.bestDayMin),
    maxOneMin: clampMin(a.maxOneMin),
    earlyCnt: Math.floor(num(a.earlyCnt, 0)),
    owlCnt: Math.floor(num(a.owlCnt, 0)),
    flowBest: Math.floor(num(a.flowBest, 0)),
  };
  if (raw.ach && typeof raw.ach === 'object') {
    for (const [k, v] of Object.entries(raw.ach)) {
      if (achievementById(k) && Number.isFinite(Number(v))) out.ach[k] = Math.round(Number(v));
    }
  }
  return out;
}

/* ---------------- 成就定义（阶梯数值在 config，文案在这里生成） ---------------- */

function fmtHours(min) { return min % 60 === 0 ? `${min / 60} 小时` : `${min} 分钟`; }

function achievementDefs() {
  const c = CFG.pomodoro.statsAchievements;
  const defs = [];
  for (const n of c.timeMin) defs.push({ id: `t${n}`, cat: 'time', name: `累计学习 ${fmtHours(n)}`, test: (s) => s.agg.totalMin >= n });
  for (const n of c.doneCount) defs.push({ id: `c${n}`, cat: 'count', name: `完成 ${n} 次专注`, test: (s) => s.agg.done >= n });
  for (const n of c.streakDays) defs.push({ id: `s${n}`, cat: 'streak', name: `连续学习 ${n} 天`, test: (s) => s.agg.streakBest >= n });
  for (const n of c.dayMin) defs.push({ id: `d${n}`, cat: 'day', name: `单日学习 ${fmtHours(n)}`, test: (s) => s.agg.bestDayMin >= n });
  for (const n of c.longFocusMin) defs.push({ id: `l${n}`, cat: 'long', name: `单次专注 ${n} 分钟`, test: (s) => s.agg.maxOneMin >= n });
  for (const n of c.flowCount) defs.push({ id: `f${n}`, cat: 'flow', name: `心流：连续完成 ${n} 个专注`, test: (s) => s.agg.flowBest >= n });
  defs.push({ id: 'p_early', cat: 'period', name: '早鸟：在 6-8 点完成专注', test: (s) => s.agg.earlyCnt >= 1 });
  defs.push({ id: 'p_owl', cat: 'period', name: '夜猫子：在 23 点后完成专注', test: (s) => s.agg.owlCnt >= 1 });
  return defs;
}

const DEFS = achievementDefs();
const DEF_BY_ID = new Map(DEFS.map((d) => [d.id, d]));

function achievementById(id) { return DEF_BY_ID.get(String(id)) || null; }

/** 对当前 stats 评测全部成就，返回新解锁的 [{id,name}]（并写入 stats.ach）。 */
function evalAchievements(stats, now) {
  const unlocked = [];
  for (const def of DEFS) {
    if (stats.ach[def.id]) continue;
    let hit = false;
    try { hit = !!def.test(stats); } catch { hit = false; }
    if (hit) { stats.ach[def.id] = now; unlocked.push({ id: def.id, name: def.name, cat: def.cat }); }
  }
  return unlocked;
}

/* ---------------- 记账 ---------------- */

/**
 * 记一次专注（完成或中断）→ 追加明细、更新聚合、评成就。
 * @param {object} stats 现有统计（会被原地修改——调用方持有唯一副本）
 * @param {object} ev { startedAt, plannedMin, minutes, ok, tag, flowStreak }
 * @param {number} now 当前时间戳（成就解锁时刻）
 * @returns {{stats, entry, unlocked}} unlocked = 新解锁成就列表
 */
function recordFocus(stats, ev, now) {
  const e = normalizeEntry({
    d: dayKey(Number(ev && ev.startedAt) || now),
    s: Number(ev && ev.startedAt) || now,
    plan: ev && ev.plannedMin,
    got: ev && ev.minutes,
    ok: !!(ev && ev.ok),
    tag: ev && ev.tag,
  });
  if (!e || e.got < 0.05) return { stats, entry: null, unlocked: [] }; // 几乎没学，忽略

  const a = stats.agg;
  a.totalMin = clampMin(a.totalMin + e.got);
  if (e.ok) a.done += 1; else a.abort += 1;

  // 每日累计（完整 + 中断的实际时长都算"这一天学了多久"）
  stats.days[e.d] = clampMin((stats.days[e.d] || 0) + e.got);
  if (stats.days[e.d] > a.bestDayMin) { a.bestDayMin = stats.days[e.d]; a.bestDay = e.d; }

  // 连续天数：只有完整专注才算"学过"；同一天重复完成不重复加
  if (e.ok) {
    if (a.streakLast === e.d) { /* 今天已计过 */ }
    else if (a.streakLast && prevDay(e.d) === a.streakLast) a.streakCur += 1;
    else a.streakCur = 1;
    a.streakLast = e.d;
    if (a.streakCur > a.streakBest) a.streakBest = a.streakCur;
  }

  // 单次最长（只认完整专注）
  if (e.ok && e.got > a.maxOneMin) a.maxOneMin = e.got;

  // 时段成就（按开始时间的小时；本地时区）
  const h = e.s ? new Date(e.s).getHours() : new Date().getHours();
  if (e.ok) {
    if (h >= 6 && h < 8) a.earlyCnt += 1;
    if (h >= 23 || h < 5) a.owlCnt += 1;
  }

  // 心流：渲染层上报"本次使用中连续完成的专注数"
  const flow = Math.floor(Number(ev && ev.flowStreak) || 0);
  if (flow > a.flowBest) a.flowBest = flow;

  // 明细截断（最旧的丢弃）
  const cap = Math.max(1, CFG.pomodoro.statsMaxEntries);
  stats.entries.push(e);
  if (stats.entries.length > cap) stats.entries = stats.entries.slice(-cap);

  const unlocked = evalAchievements(stats, now);
  return { stats, entry: e, unlocked };
}

/** 某一天的实际专注分钟（无记录=0）。 */
function minutesOnDay(stats, d) { return clampMin((stats.days && stats.days[d]) || 0); }

/** 最近 N 天（含今天）的总分钟（本周视图用，自然周从周一开始由调用方给起点）。 */
function minutesSince(stats, startDayKey, endDayKey) {
  let sum = 0;
  for (const [k, v] of Object.entries(stats.days || {})) {
    if (k >= startDayKey && (!endDayKey || k <= endDayKey)) sum += Number(v) || 0;
  }
  return Math.round(sum * 10) / 10;
}

module.exports = {
  dayKey, prevDay, clampMin,
  normalizeEntry, emptyStats, normalizeStats,
  achievementDefs, achievementById, evalAchievements,
  recordFocus, minutesOnDay, minutesSince,
};
