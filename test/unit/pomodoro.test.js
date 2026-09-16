'use strict';
/** 番茄钟纯逻辑单测：时长清洗 / 状态转移 / 长休节奏 / 格式化。
 *  时间通过注入 now 控制 → 不需要真等待即可覆盖"走完一段"的全部路径。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../src/shared/pomodoro');
const { CFG } = require('../../src/shared/config');
const { normalizeSettings } = require('../../src/shared/content');

const MIN = 60 * 1000;

/* ================= 清洗 ================= */

test('presets：来自 config，且是副本（外部改动不污染 config 深冻结表）', () => {
  const p = P.presets();
  assert.deepEqual(p.focus, CFG.pomodoro.presets.focus);
  p.focus.push(999);
  assert.notEqual(CFG.pomodoro.presets.focus.length, p.focus.length);
});

test('clampMinutes：夹进 [min,max]，非法回退 fallback', () => {
  assert.equal(P.clampMinutes(25, 1), 25);
  assert.equal(P.clampMinutes(9999, 25), CFG.pomodoro.maxMinutes);
  assert.equal(P.clampMinutes(0, 25), CFG.pomodoro.minMinutes);
  assert.equal(P.clampMinutes('x', 25), 25);
});

test('normalizePomodoroPrefs：null → null；非法项回退默认；长休间隔夹 1~12', () => {
  assert.equal(P.normalizePomodoroPrefs(null), null);
  const n = P.normalizePomodoroPrefs({ focusMin: 9999, longBreakEvery: 0 });
  assert.equal(n.focusMin, CFG.pomodoro.maxMinutes);
  assert.equal(n.longBreakEvery, 1);
  assert.equal(P.normalizePomodoroPrefs({ longBreakEvery: 99 }).longBreakEvery, 12);
  assert.equal(P.normalizePomodoroPrefs({}).autoStartNext, false);
  assert.equal(P.normalizePomodoroPrefs({ autoStartNext: true }).autoStartNext, true);
});

test('durationsOf：无偏好时用 config 默认', () => {
  const d = P.durationsOf(null);
  assert.equal(d.focus, CFG.pomodoro.defaultFocusMin);
  assert.equal(d.shortBreak, CFG.pomodoro.defaultShortBreakMin);
  assert.equal(d.longBreak, CFG.pomodoro.defaultLongBreakMin);
  assert.equal(d.longBreakEvery, CFG.pomodoro.longBreakEvery);
});

/* ================= 状态与计时 ================= */

test('createState：默认从"专注"起步，剩余 = 总时长，未运行', () => {
  const s = P.createState(null);
  assert.equal(s.phase, 'focus');
  assert.equal(s.completedFocus, 0);
  assert.equal(s.running, false);
  assert.equal(s.remainMs, 25 * MIN);
  assert.equal(s.totalMs, 25 * MIN);
});

test('start / tick：按注入时间推进；未运行时不走时', () => {
  let s = P.createState({ focusMin: 1 });
  assert.equal(P.tick(s, 100000).finished, false, '未开始不应变化');
  assert.equal(P.tick(s, 100000).state.remainMs, 1 * MIN);
  s = P.start(s, 1000);
  assert.equal(s.running, true);
  const r = P.tick(s, 1000 + 30000);
  assert.equal(r.state.remainMs, 30000);
  assert.equal(r.finished, false);
});

test('tick：走完 → finished=true、自动停表、remain 不为负', () => {
  let s = P.start(P.createState({ focusMin: 1 }), 0);
  const r = P.tick(s, 5 * MIN);
  assert.equal(r.finished, true);
  assert.equal(r.state.remainMs, 0);
  assert.equal(r.state.running, false);
});

test('pause：暂停前先结算已走时间（恢复时不会重复计/吞时间）', () => {
  let s = P.start(P.createState({ focusMin: 1 }), 0);
  s = P.pause(s, 20000);
  assert.equal(s.running, false);
  assert.equal(s.remainMs, 40000);
  s = P.start(s, 999999);           // 中间隔了很久才开始
  const r = P.tick(s, 999999 + 10000);
  assert.equal(r.state.remainMs, 30000, '暂停期间的时间不计入');
});

/* ================= 阶段转移与长休节奏 ================= */

test('finishPhase：专注结束 → 短休，且完成计数 +1', () => {
  const s0 = P.createState(null);
  const r = P.finishPhase(s0, null);
  assert.equal(r.state.phase, 'shortBreak');
  assert.equal(r.state.completedFocus, 1);
  assert.equal(r.state.remainMs, CFG.pomodoro.defaultShortBreakMin * MIN);
  assert.match(r.message, /专注完成/);
});

test('finishPhase：休息结束 → 回到专注，计数不变', () => {
  const s = P.finishPhase(P.createState(null), null).state; // → shortBreak
  const r = P.finishPhase(s, null);
  assert.equal(r.state.phase, 'focus');
  assert.equal(r.state.completedFocus, 1);
  assert.match(r.message, /休息结束/);
});

test('长休节奏：每完成 longBreakEvery 个专注用一次长休', () => {
  const prefs = { longBreakEvery: 2 };
  let s = P.createState(prefs);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const a = P.finishPhase(s, prefs);   // 专注 → 休息
    seen.push(a.nextPhase);
    s = P.finishPhase(a.state, prefs).state; // 休息 → 专注
  }
  assert.deepEqual(seen, ['shortBreak', 'longBreak', 'shortBreak', 'longBreak']);
});

test('autoStartNext：开启后切段即自动继续；默认关闭', () => {
  const off = P.finishPhase(P.createState(null), null).state;
  assert.equal(off.running, false);
  const on = P.finishPhase(P.createState({ autoStartNext: true }), { autoStartNext: true }).state;
  assert.equal(on.running, true);
});

test('resetAll / jumpTo：重置回第一段专注；jumpTo 保留已完成计数', () => {
  let s = P.finishPhase(P.createState(null), null).state;
  const r = P.resetAll(s, null);
  assert.equal(r.phase, 'focus');
  assert.equal(r.completedFocus, 0);
  assert.equal(r.remaining, undefined);
  const j = P.jumpTo(s, 'longBreak', null);
  assert.equal(j.phase, 'longBreak');
  assert.equal(j.completedFocus, 1, '跳段不应清掉已完成计数');
  assert.equal(j.remainMs, P.phaseMs('longBreak', j.durations));
});

test('phaseMs：不吃非法偏好（夹取后仍 ≥1 秒）', () => {
  const d = P.durationsOf({ focusMin: -5 });
  assert.ok(P.phaseMs('focus', d) >= 1000);
});

/* ================= 展示 ================= */

test('formatClock：MM:SS，≥1 小时显示 H:MM:SS', () => {
  assert.equal(P.formatClock(25 * MIN), '25:00');
  assert.equal(P.formatClock(0), '00:00');
  assert.equal(P.formatClock(61 * 1000), '01:01');
  assert.equal(P.formatClock(3725000), '1:02:05');
  assert.equal(P.formatClock(-100), '00:00');
});

test('progressRatio：0 → 1，夹在 [0,1]', () => {
  const s = P.createState({ focusMin: 10 });
  assert.equal(P.progressRatio(s), 0);
  assert.equal(P.progressRatio({ ...s, remainMs: 0 }), 1);
  assert.equal(P.progressRatio({ totalMs: 0, remainMs: 0 }), 0);
});

test('phaseLabel：三态文案来自 config', () => {
  assert.equal(P.phaseLabel('focus'), CFG.pomodoro.strings.phaseFocus);
  assert.equal(P.phaseLabel('shortBreak'), CFG.pomodoro.strings.phaseShortBreak);
  assert.equal(P.phaseLabel('longBreak'), CFG.pomodoro.strings.phaseLongBreak);
});

/* ================= 设置持久化 ================= */

test('normalizeSettings：pomodoro 往返', () => {
  const s = normalizeSettings({ pomodoro: { focusMin: 45, shortBreakMin: 10, longBreakMin: 20, longBreakEvery: 3, autoStartNext: true } });
  assert.deepEqual(s.pomodoro, { focusMin: 45, shortBreakMin: 10, longBreakMin: 20, longBreakEvery: 3, autoStartNext: true });
  assert.equal(normalizeSettings({}).pomodoro, null);
});
