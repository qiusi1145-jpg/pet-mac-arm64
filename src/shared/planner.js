'use strict';
/**
 * 学习计划表纯逻辑（无 DOM / 无 Electron → 可单测）。
 *
 * 数据模型：一条计划 = { id, text, date, time, done, note }
 *   date：'YYYY-MM-DD'（本地日期，不带时区，避免跨时区漂移）
 *   time：'HH:MM' 或 ''（不排具体时刻，只算当天）
 * 时间函数一律接受注入的"今天"（todayKey），因此周视图/进度不需要真等到某一天也能测。
 */
const { CFG } = require('./config');

const pad2 = (n) => String(n).padStart(2, '0');

/** 视图白名单（2026-09-17 三视图：单日 / 周课表 / 月历）。 */
const VIEWS = ['day', 'week', 'month'];

/** Date → 'YYYY-MM-DD'（本地时区，不用 toISOString 以免 UTC 漂移）。 */
function dateKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** 'YYYY-MM-DD' → 本地零点的 Date（非法返回 null）。 */
function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 日期键加减天数（跨月/跨年由 Date 处理）。 */
function addDays(key, n) {
  const d = parseDateKey(key);
  if (!d) return '';
  d.setDate(d.getDate() + Number(n || 0));
  return dateKey(d);
}

/** 该日期所在周的第一天（weekStart：0=周日，1=周一）。 */
function startOfWeek(key, weekStart = 1) {
  const d = parseDateKey(key);
  if (!d) return '';
  const ws = Number(weekStart) === 0 ? 0 : 1;
  const delta = (d.getDay() - ws + 7) % 7;
  return addDays(key, -delta);
}

/** 从 startKey 起的 7 个日期键（周视图用）。 */
function weekKeys(startKey, weekStart = 1) {
  const first = startOfWeek(startKey, weekStart);
  if (!first) return [];
  const out = [];
  for (let i = 0; i < 7; i++) out.push(addDays(first, i));
  return out;
}

/** 'HH:MM' 归一（非法 → ''）。 */
function normalizeTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return '';
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return '';
  return `${pad2(h)}:${pad2(mi)}`;
}

/** 单条计划清洗；text 为空则丢弃（返回 null）。 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const max = CFG.planner.maxTextLen;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, max) : '';
  if (!text) return null;
  const date = parseDateKey(raw.date) ? String(raw.date) : '';
  return {
    id: typeof raw.id === 'string' && raw.id
      ? raw.id
      : `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    text,
    date,
    time: normalizeTime(raw.time),
    done: !!raw.done,
    note: typeof raw.note === 'string' ? raw.note.trim().slice(0, max) : '',
  };
}

/**
 * 清洗 settings.planner（整表）。返回 null 表示"用户没设置过"。
 * 超过 maxItems 的尾部丢弃，防止 settings.json 无限膨胀。
 * view：上次使用的视图（'day'|'week'|'month'，2026-09-17 三视图升级起持久化）。
 */
function normalizePlanner(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const items = [];
  if (Array.isArray(raw.items)) {
    for (const it of raw.items) {
      const n = normalizeItem(it);
      if (n) items.push(n);
      if (items.length >= CFG.planner.maxItems) break;
    }
  }
  return { items, view: VIEWS.includes(raw.view) ? raw.view : 'day' };
}

/** 排序：有时间的在前（按时间升序），无时间的按创建顺序（按 id 稳定）。 */
function sortItems(items) {
  return items.slice().sort((a, b) => {
    if (a.time && b.time) return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
    if (a.time) return -1;
    if (b.time) return 1;
    return 0;
  });
}

/** 取某天的计划（已排序）。date 为空的条目视为"未排期"，只在"全部"视图里出现。 */
function itemsForDate(items, key) {
  return sortItems((items || []).filter((it) => it && it.date === key));
}

/** 当天进度（用于日程窗的进度条与"学习"菜单的角标）。 */
function dayProgress(items, key) {
  const list = (items || []).filter((it) => it && it.date === key);
  const done = list.filter((it) => it.done).length;
  return { total: list.length, done, ratio: list.length ? done / list.length : 0 };
}

/** 未排期条目（date 为空）——放"待安排"区，避免用户加完就找不到了。 */
function unscheduled(items) {
  return sortItems((items || []).filter((it) => it && !it.date));
}

/** 逾期未完成：日期早于 today 且未完成。 */
function overdue(items, todayKey) {
  return sortItems((items || []).filter((it) => it && !it.done && it.date && it.date < todayKey));
}

/** 相对日期文案：今天/明天/昨天/周几(本周末内)/日期。 */
function dayLabel(key, todayKey) {
  if (!key) return '未排期';
  const s = CFG.planner.strings;
  if (key === todayKey) return s.today;
  if (key === addDays(todayKey, 1)) return s.tomorrow;
  if (key === addDays(todayKey, -1)) return '昨天';
  const inWeek = weekKeys(todayKey, CFG.planner.weekStart).includes(key);
  if (inWeek) {
    const d = parseDateKey(key);
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
}

/**
 * 月历矩阵（2026-09-17 月视图）：给定年月，返回从"该月第一格"起的 42 个日期键
 * （6 行 × 7 列，前后用相邻月份补齐），起点按 weekStart 对齐。
 * year 年份、month 1~12；非法输入返回 []。
 */
function monthGrid(year, month, weekStart = 1) {
  const y = Math.round(Number(year));
  const m = Math.round(Number(month));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return [];
  const first = dateKey(new Date(y, m - 1, 1));
  const firstCell = startOfWeek(first, weekStart);
  if (!firstCell) return [];
  const out = [];
  for (let i = 0; i < 42; i++) out.push(addDays(firstCell, i));
  return out;
}

/** key 是否落在 [year, month]（month 1~12）：月历区分"本月/邻月"灰显用。 */
function inMonth(key, year, month) {
  if (!parseDateKey(key)) return false;
  return Number(key.slice(0, 4)) === year && Number(key.slice(5, 7)) === month;
}

/**
 * 周课表时间轴范围（2026-09-17 周视图）：取本周带时间的计划的 [最早小时, 最晚小时+1)，
 * 并夹进 [0, 24]；一周没排任何带时间的计划 → 返回默认 8~22。
 * 保证所有事件都落在轴内（min 再往下放宽到默认起点、max 顶到最晚事件结束）。
 */
function hourRange(items, keys, defStart = 8, defEnd = 22) {
  let min = Infinity;
  let max = -Infinity;
  for (const it of items || []) {
    if (!it || !it.time || !keys.includes(it.date)) continue;
    const h = Number(it.time.slice(0, 2));
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  if (min === Infinity) return [defStart, defEnd];
  return [
    Math.max(0, Math.min(defStart, min)),
    Math.min(24, Math.max(defEnd, max + 1)),
  ];
}

module.exports = {
  VIEWS,
  dateKey,
  parseDateKey,
  addDays,
  startOfWeek,
  weekKeys,
  monthGrid,
  inMonth,
  hourRange,
  normalizeTime,
  normalizeItem,
  normalizePlanner,
  sortItems,
  itemsForDate,
  dayProgress,
  unscheduled,
  overdue,
  dayLabel,
};
