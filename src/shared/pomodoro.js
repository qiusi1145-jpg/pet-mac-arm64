'use strict';
/**
 * 番茄钟纯逻辑（无 DOM / 无 Electron → 可单测）。
 *
 * 设计成"状态 + 纯函数转移"，时间由调用方注入（now），于是计时逻辑不需要真等待也能测：
 *   createState(prefs)      → 初始状态（默认从"专注"开始）
 *   start(state, now)       → 开始/继续
 *   pause(state, now)       → 暂停（先把已走的时间结算掉，再停）
 *   tick(state, now)        → { state, finished }（finished = 这一段走完了）
 *   finishPhase(state,prefs)→ { state, nextPhase, message }（切到下一段：专注/短休/长休）
 *   resetAll(state,prefs)   → 回到"第一段专注"（清零计数）
 *
 * 节奏：专注 → 短休 → 专注 → … 每完成 longBreakEvery 个专注，下一次休息用长休。
 */
const { CFG } = require('./config');

const PHASES = ['focus', 'shortBreak', 'longBreak'];

/** 预设时长（分钟），来自 config（窗口里做成快捷按钮）。 */
function presets() {
  const c = CFG.pomodoro;
  return {
    focus: c.presets.focus.slice(),
    shortBreak: c.presets.shortBreak.slice(),
    longBreak: c.presets.longBreak.slice(),
  };
}

/** 把任意输入夹进合法分钟区间；非法 → 回退 fallback。 */
function clampMinutes(v, fallback) {
  const c = CFG.pomodoro;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(c.maxMinutes, Math.max(c.minMinutes, n));
}

/**
 * 清洗 settings.pomodoro（用户自定义时长/节奏）。
 * 返回 null 表示"用户没设置过"（一切走 config 默认）。
 */
function normalizePomodoroPrefs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = CFG.pomodoro;
  const every = Math.round(Number(raw.longBreakEvery));
  return {
    focusMin: clampMinutes(raw.focusMin, c.defaultFocusMin),
    shortBreakMin: clampMinutes(raw.shortBreakMin, c.defaultShortBreakMin),
    longBreakMin: clampMinutes(raw.longBreakMin, c.defaultLongBreakMin),
    longBreakEvery: Number.isFinite(every) ? Math.min(12, Math.max(1, every)) : c.longBreakEvery,
    autoStartNext: raw.autoStartNext === true,
  };
}

/** 生效时长（分钟）：用户设置 > config 默认。 */
function durationsOf(prefs) {
  const c = CFG.pomodoro;
  const p = prefs || {};
  return {
    focus: clampMinutes(p.focusMin, c.defaultFocusMin),
    shortBreak: clampMinutes(p.shortBreakMin, c.defaultShortBreakMin),
    longBreak: clampMinutes(p.longBreakMin, c.defaultLongBreakMin),
    longBreakEvery: Number.isFinite(Number(p.longBreakEvery))
      ? Math.min(12, Math.max(1, Math.round(Number(p.longBreakEvery))))
      : c.longBreakEvery,
    autoStartNext: p.autoStartNext === true,
  };
}

function phaseLabel(phase) {
  const s = CFG.pomodoro.strings;
  if (phase === 'shortBreak') return s.phaseShortBreak;
  if (phase === 'longBreak') return s.phaseLongBreak;
  return s.phaseFocus;
}

/** 某一段的时长（ms）。 */
function phaseMs(phase, durations) {
  const min = phase === 'focus' ? durations.focus
    : phase === 'shortBreak' ? durations.shortBreak
      : durations.longBreak;
  return Math.max(1000, Math.round(min * 60 * 1000));
}

/**
 * 初始状态。
 * @param {Object|null} prefs 用户偏好（可为空）
 * @param {'focus'|'shortBreak'|'longBreak'} [phase='focus']
 * @param {number} [completedFocus=0] 已完成专注个数（用于决定下一次休息长短）
 */
function createState(prefs, phase = 'focus', completedFocus = 0) {
  const durations = durationsOf(prefs);
  const totalMs = phaseMs(phase, durations);
  return {
    phase, completedFocus,
    durations,
    running: false,
    remainMs: totalMs,
    totalMs,
    lastAt: 0,
  };
}

function start(state, now) {
  if (state.running) return state;
  return { ...state, running: true, lastAt: now };
}

/** 暂停：先把 [lastAt, now] 这段时间结算掉再停（否则暂停期间的"时间"会在恢复时被吞掉/重复计）。 */
function pause(state, now) {
  const r = tick(state, now);
  return { ...r.state, running: false, lastAt: 0 };
}

/** 推进计时。finished=true 表示这一段刚好走完（调用方接着调 finishPhase）。 */
function tick(state, now) {
  if (!state || !state.running) return { state, finished: false };
  // 注意：lastAt 可能是 0（测试注入的起点），不能用 `||` 兜底（0 是假值会吞掉整段时间）
  const last = Number.isFinite(Number(state.lastAt)) ? Number(state.lastAt) : Number(now);
  const dt = Math.max(0, Number(now) - last);
  const remain = Math.max(0, state.remainMs - dt);
  const next = { ...state, remainMs: remain, lastAt: now };
  if (remain <= 0) { next.running = false; next.lastAt = 0; return { state: next, finished: true }; }
  return { state: next, finished: false };
}

/** 由当前段推出下一段（不改变状态）。 */
function nextPhaseOf(state) {
  const d = state.durations;
  if (state.phase !== 'focus') return 'focus';
  const nextCount = state.completedFocus + 1;
  return (nextCount % Math.max(1, d.longBreakEvery) === 0) ? 'longBreak' : 'shortBreak';
}

/** 这一段结束后切到下一段（重置剩余时长；完成专注则计数 +1）。 */
function finishPhase(state, prefs) {
  const durations = prefs ? durationsOf(prefs) : state.durations;
  const withDur = { ...state, durations };
  const nextPhase = nextPhaseOf(withDur);
  const completedFocus = state.phase === 'focus' ? state.completedFocus + 1 : state.completedFocus;
  const totalMs = phaseMs(nextPhase, durations);
  const next = {
    ...withDur,
    phase: nextPhase,
    completedFocus,
    running: durations.autoStartNext === true,
    remainMs: totalMs,
    totalMs,
    lastAt: 0,
  };
  const s = CFG.pomodoro.strings;
  const message = state.phase === 'focus' ? s.doneFocus : s.doneBreak;
  return { state: next, nextPhase, message };
}

/** 重置到"第一段专注"（计数清零；不自动开始）。 */
function resetAll(state, prefs) {
  void state;
  return createState(prefs, 'focus', 0);
}

/** 立即跳到指定段（用户点"跳过"或直接选阶段）。 */
function jumpTo(state, phase, prefs) {
  return createState(prefs, PHASES.includes(phase) ? phase : 'focus', state ? state.completedFocus : 0);
}

/** 倒计时文本：MM:SS（≥1 小时显示 H:MM:SS）。 */
function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 已完成比例 0~1（用于进度环）。 */
function progressRatio(state) {
  if (!state || !state.totalMs) return 0;
  return Math.min(1, Math.max(0, 1 - state.remainMs / state.totalMs));
}

module.exports = {
  PHASES,
  presets,
  clampMinutes,
  normalizePomodoroPrefs,
  durationsOf,
  phaseLabel,
  phaseMs,
  createState,
  start,
  pause,
  tick,
  nextPhaseOf,
  finishPhase,
  resetAll,
  jumpTo,
  formatClock,
  progressRatio,
};
