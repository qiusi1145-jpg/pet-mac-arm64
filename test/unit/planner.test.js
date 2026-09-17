'use strict';
/** 学习计划表纯逻辑单测：日期键运算 / 周视图 / 条目清洗 / 分组与进度 / 逾期。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const PL = require('../../src/shared/planner');
const { CFG } = require('../../src/shared/config');
const { normalizeSettings } = require('../../src/shared/content');

/* ================= 日期键 ================= */

test('dateKey / parseDateKey：本地日期往返，非法返回空/null', () => {
  const k = PL.dateKey(new Date(2026, 8, 14)); // 2026-09-14
  assert.equal(k, '2026-09-14');
  const d = PL.parseDateKey(k);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 14);
  assert.equal(PL.parseDateKey('2026-9-4'), null);
  assert.equal(PL.parseDateKey('乱七八糟'), null);
  assert.equal(PL.dateKey('不是日期'), '');
});

test('addDays：跨月/跨年正确', () => {
  assert.equal(PL.addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(PL.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(PL.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(PL.addDays('2026-09-14', 0), '2026-09-14');
});

test('startOfWeek / weekKeys：周一为起点返回连续 7 天', () => {
  // 2026-09-14 是周一
  assert.equal(PL.startOfWeek('2026-09-14', 1), '2026-09-14');
  assert.equal(PL.startOfWeek('2026-09-16', 1), '2026-09-14');
  assert.deepEqual(PL.weekKeys('2026-09-14', 1), [
    '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20',
  ]);
  // 周日为起点时，同一天属于上一周的第一天
  assert.equal(PL.startOfWeek('2026-09-14', 0), '2026-09-13');
});

/* ================= 条目清洗 ================= */

test('normalizeTime：归一 HH:MM，非法 → 空', () => {
  assert.equal(PL.normalizeTime('7:05'), '07:05');
  assert.equal(PL.normalizeTime('23:59'), '23:59');
  assert.equal(PL.normalizeTime('24:00'), '');
  assert.equal(PL.normalizeTime('7:5'), '');
  assert.equal(PL.normalizeTime(''), '');
});

test('normalizeItem：裁剪文本、丢弃空条目、补 id、非法日期清空', () => {
  const it = PL.normalizeItem({ text: '  背单词  ', date: '2026-09-14', time: '7:05' });
  assert.equal(it.text, '背单词');
  assert.equal(it.date, '2026-09-14');
  assert.equal(it.time, '07:05');
  assert.equal(it.done, false);
  assert.ok(it.id.length > 0);
  assert.equal(PL.normalizeItem({ text: '   ' }), null);
  assert.equal(PL.normalizeItem(null), null);
  assert.equal(PL.normalizeItem({ text: 'x', date: '不是日期' }).date, '');
});

test('normalizeItem：超长文本按 config 截断', () => {
  const long = 'a'.repeat(CFG.planner.maxTextLen + 50);
  assert.equal(PL.normalizeItem({ text: long }).text.length, CFG.planner.maxTextLen);
});

test('normalizePlanner：null → null；条目数受 maxItems 约束（防 settings.json 膨胀）', () => {
  assert.equal(PL.normalizePlanner(null), null);
  const many = { items: Array.from({ length: CFG.planner.maxItems + 20 }, (_, i) => ({ text: `t${i}` })) };
  assert.equal(PL.normalizePlanner(many).items.length, CFG.planner.maxItems);
  assert.deepEqual(PL.normalizePlanner({ items: 'bad' }).items, []);
});

/* ================= 分组 / 进度 / 逾期 ================= */

const ITEMS = [
  PL.normalizeItem({ id: 'a', text: '晚课', date: '2026-09-14', time: '20:00' }),
  PL.normalizeItem({ id: 'b', text: '早读', date: '2026-09-14', time: '07:30', done: true }),
  PL.normalizeItem({ id: 'c', text: '全天复习', date: '2026-09-14' }),
  PL.normalizeItem({ id: 'd', text: '昨天的作业', date: '2026-09-13' }),
  PL.normalizeItem({ id: 'e', text: '还没定日期' }),
];

test('itemsForDate：只取当天；有时间的按时间升序且排在无时间的前面', () => {
  const list = PL.itemsForDate(ITEMS, '2026-09-14');
  assert.deepEqual(list.map((i) => i.id), ['b', 'a', 'c']);
  assert.deepEqual(PL.itemsForDate(ITEMS, '2026-09-20'), []);
});

test('dayProgress：当天完成度', () => {
  const p = PL.dayProgress(ITEMS, '2026-09-14');
  assert.deepEqual(p, { total: 3, done: 1, ratio: 1 / 3 });
  assert.deepEqual(PL.dayProgress(ITEMS, '2026-09-19'), { total: 0, done: 0, ratio: 0 });
});

test('unscheduled / overdue：待安排与逾期未完成', () => {
  assert.deepEqual(PL.unscheduled(ITEMS).map((i) => i.id), ['e']);
  assert.deepEqual(PL.overdue(ITEMS, '2026-09-14').map((i) => i.id), ['d']);
  assert.deepEqual(PL.overdue(ITEMS, '2026-09-13'), [], '当天不算逾期');
});

test('dayLabel：今天/明天/昨天/本周周几/月日', () => {
  const s = CFG.planner.strings;
  assert.equal(PL.dayLabel('2026-09-14', '2026-09-14'), s.today);
  assert.equal(PL.dayLabel('2026-09-15', '2026-09-14'), s.tomorrow);
  assert.equal(PL.dayLabel('2026-09-13', '2026-09-14'), '昨天');
  assert.equal(PL.dayLabel('2026-09-17', '2026-09-14'), '周四');
  assert.equal(PL.dayLabel('2026-10-02', '2026-09-14'), '10/2');
  assert.equal(PL.dayLabel('', '2026-09-14'), '未排期');
});

/* ================= 设置持久化 ================= */

test('normalizeSettings：planner 往返（非法项丢弃）', () => {
  const s = normalizeSettings({ planner: { items: [{ text: '背单词', date: '2026-09-14' }, { text: '' }, null, 'x'] } });
  assert.equal(s.planner.items.length, 1);
  assert.equal(s.planner.items[0].text, '背单词');
  assert.equal(normalizeSettings({ planner: 'bad' }).planner, null);
  assert.equal(normalizeSettings({}).planner, null);
});

/* ================= 三视图（2026-09-17：日 / 周课表 / 月历） ================= */

test('normalizePlanner：view 白名单清洗（非法/缺失 → day），合法值保留', () => {
  assert.equal(PL.normalizePlanner({ items: [] }).view, 'day');
  assert.equal(PL.normalizePlanner({ items: [], view: 'week' }).view, 'week');
  assert.equal(PL.normalizePlanner({ items: [], view: 'month' }).view, 'month');
  assert.equal(PL.normalizePlanner({ items: [], view: 'year' }).view, 'day');   // 非法 → day
  assert.equal(PL.normalizePlanner({ items: [], view: 42 }).view, 'day');
});

test('monthGrid：42 格（6×7）、按 weekStart 对齐、首格补齐到周首', () => {
  // 2026-09-01 是周二；weekStart=1 → 首格 2026-08-31（周一）
  const g = PL.monthGrid(2026, 9, 1);
  assert.equal(g.length, 42);
  assert.equal(g[0], '2026-08-31');
  assert.equal(g[6], '2026-09-06');
  assert.equal(g[41], '2026-10-11');
  // 周日为起点 → 首格 2026-08-30
  assert.equal(PL.monthGrid(2026, 9, 0)[0], '2026-08-30');
  // 跨月正确（8 月矩阵尾部应进 10 月）
  const g8 = PL.monthGrid(2026, 8, 1);
  assert.equal(g8[0], '2026-07-27');
  assert.equal(g8[41], '2026-09-06');
  // 非法月份
  assert.deepEqual(PL.monthGrid(2026, 13, 1), []);
  assert.deepEqual(PL.monthGrid('x', 9, 1), []);
});

test('inMonth：区分本月与邻月（月历灰显用）', () => {
  assert.equal(PL.inMonth('2026-09-15', 2026, 9), true);
  assert.equal(PL.inMonth('2026-08-31', 2026, 9), false);
  assert.equal(PL.inMonth('2026-10-01', 2026, 9), false);
  assert.equal(PL.inMonth('', 2026, 9), false);
});

test('hourRange：自适应夹取（保证事件都在轴内），无计划回默认 8~22', () => {
  const wk = PL.weekKeys('2026-09-14', 1);
  // 有 07:30 与 23:00 的计划 → 轴放宽到 7~24
  const wide = [
    PL.normalizeItem({ text: '早读', date: '2026-09-14', time: '07:30' }),
    PL.normalizeItem({ text: '晚课', date: '2026-09-15', time: '23:00' }),
  ];
  assert.deepEqual(PL.hourRange(wide, wk), [7, 24]);
  // 只有 10~16 的计划 → 用默认范围（8~22 已覆盖）
  const normal = [PL.normalizeItem({ text: '上午', date: '2026-09-14', time: '10:00' }),
    PL.normalizeItem({ text: '下午', date: '2026-09-14', time: '16:00' })];
  assert.deepEqual(PL.hourRange(normal, wk), [8, 22]);
  // 没有任何带时间的计划 → 默认 8~22
  assert.deepEqual(PL.hourRange([], wk), [8, 22]);
  assert.deepEqual(PL.hourRange([{ time: '09:00', date: '2026-10-01' }], wk), [8, 22]); // 不在本周的不算
});
