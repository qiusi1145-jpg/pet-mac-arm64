'use strict';
/**
 * 番茄钟窗口：预设 + 自定义时长，专注/短休/长休自动轮转。
 * 计时与阶段转移全部走 shared/pomodoro.js（与单测同一份纯函数）；
 * 完成一个专注 → 通知主进程给桌宠回体力/情绪（`pomodoro:report`）。
 */
const { ipcRenderer } = require('electron');
const { CFG } = require('../shared/config');
const P = require('../shared/pomodoro');

const $ = (id) => document.getElementById(id);
const el = {
  arc: $('arc'), clock: $('clock'), phase: $('phase'), count: $('count'),
  toggleBtn: $('toggleBtn'), resetBtn: $('resetBtn'), skipBtn: $('skipBtn'),
  preFocus: $('preFocus'), preShort: $('preShort'), preLong: $('preLong'),
  inFocus: $('inFocus'), inShort: $('inShort'), inLong: $('inLong'), inEvery: $('inEvery'),
  autoNext: $('autoNext'), msg: $('msg'), saveBtn: $('saveBtn'),
};

const CIRC = 2 * Math.PI * 84;
const S = CFG.pomodoro.strings;

let prefs = P.normalizePomodoroPrefs(null) || {};   // 生效偏好（缺项由 durationsOf 兜底）
let state = P.createState(prefs);
let timer = 0;

/* ---------------- 渲染 ---------------- */

function render() {
  el.clock.textContent = P.formatClock(state.remainMs);
  el.phase.textContent = P.phaseLabel(state.phase);
  el.count.textContent = state.completedFocus > 0 ? `已完成 ${state.completedFocus} 个专注` : '';
  const ratio = P.progressRatio(state);
  el.arc.style.strokeDashoffset = String(CIRC * (1 - ratio));
  el.arc.style.stroke = state.phase === 'focus' ? 'var(--ring)' : 'var(--ringBreak)';
  el.toggleBtn.textContent = state.running ? '暂停' : (state.remainMs === state.totalMs ? '开始' : '继续');
  const d = P.durationsOf(prefs);
  el.inFocus.value = String(d.focus);
  el.inShort.value = String(d.shortBreak);
  el.inLong.value = String(d.longBreak);
  el.inEvery.value = String(d.longBreakEvery);
  el.autoNext.checked = d.autoStartNext === true;
  document.title = `${P.formatClock(state.remainMs)} · ${P.phaseLabel(state.phase)}`;
}

function setMsg(t, isErr) {
  el.msg.textContent = t || '';
  el.msg.classList.toggle('err', !!isErr);
}

/** 预设快捷按钮（值来自 config.pomodoro.presets）。 */
function renderPresets() {
  const ps = P.presets();
  const bind = (host, list, key) => {
    host.textContent = '';
    for (const min of list) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = String(min);
      b.dataset.min = String(min);
      b.addEventListener('click', () => {
        prefs[key === 'focus' ? 'focusMin' : key === 'shortBreak' ? 'shortBreakMin' : 'longBreakMin'] = min;
        applyPrefsToTiming();
        setMsg(`已设为 ${min} 分钟`);
      });
      host.appendChild(b);
    }
  };
  bind(el.preFocus, ps.focus, 'focus');
  bind(el.preShort, ps.shortBreak, 'shortBreak');
  bind(el.preLong, ps.longBreak, 'longBreak');
}

/** 偏好变化后：把新时长应用到"当前段的重置"，但不打断已经在走的计时（用户改的是下一次）。 */
function applyPrefsToTiming() {
  prefs = P.normalizePomodoroPrefs(prefs) || prefs;
  state.durations = P.durationsOf(prefs);
  if (!state.running) {
    const total = P.phaseMs(state.phase, state.durations);
    state.totalMs = total;
    state.remainMs = total;
  }
  render();
}

/* ---------------- 计时 ---------------- */

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    const r = P.tick(state, Date.now());
    state = r.state;
    if (r.finished) onPhaseFinished();
    render();
  }, CFG.pomodoro.tickMs);
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = 0; }
}

/** 一段走完：专注完成 → 通知主进程奖励；然后切下一段。 */
function onPhaseFinished() {
  const wasFocus = state.phase === 'focus';
  const minutes = Math.round(state.totalMs / 60000);
  const res = P.finishPhase(state, prefs);
  state = res.state;
  if (wasFocus) {
    void ipcRenderer.invoke('pomodoro:report', { phase: 'focus', minutes });
  } else {
    void ipcRenderer.invoke('pomodoro:report', { phase: 'break', minutes });
  }
  setMsg(res.message);
  if (!res.state.running) stopTimer();
  render();
}

function toggle() {
  if (state.running) { state = P.pause(state, Date.now()); stopTimer(); setMsg(S.paused); }
  else { state = P.start(state, Date.now()); ensureTimer(); setMsg(S.running); }
  render();
}

/* ---------------- 事件 ---------------- */

el.toggleBtn.addEventListener('click', toggle);

el.resetBtn.addEventListener('click', () => {
  stopTimer();
  state = P.resetAll(state, prefs);
  setMsg(S.idle);
  render();
});

el.skipBtn.addEventListener('click', () => {
  // 跳过当前段：不计入专注完成数（只有真正走完才算），直接切下一段
  const next = state.phase === 'focus'
    ? (state.completedFocus + 1) % Math.max(1, state.durations.longBreakEvery) === 0 ? 'longBreak' : 'shortBreak'
    : 'focus';
  stopTimer();
  state = P.jumpTo(state, next, prefs);
  setMsg(`已跳过 → ${P.phaseLabel(next)}`);
  render();
});

for (const [input, key] of [[el.inFocus, 'focusMin'], [el.inShort, 'shortBreakMin'], [el.inLong, 'longBreakMin'], [el.inEvery, 'longBreakEvery']]) {
  input.addEventListener('change', () => {
    prefs[key] = input.value;
    applyPrefsToTiming();
  });
}
el.autoNext.addEventListener('change', () => { prefs.autoStartNext = el.autoNext.checked; applyPrefsToTiming(); });

el.saveBtn.addEventListener('click', async () => {
  prefs = P.normalizePomodoroPrefs(prefs) || prefs;
  const res = await ipcRenderer.invoke('pomodoro:prefs:save', prefs);
  setMsg(res && res.ok ? '时长已保存' : '保存失败', !(res && res.ok));
  if (res && res.ok) setTimeout(() => setMsg(''), 1800);
});

/* ---------------- 启动 ---------------- */

(async () => {
  try {
    const saved = await ipcRenderer.invoke('pomodoro:prefs:load');
    const n = P.normalizePomodoroPrefs(saved);
    if (n) prefs = n;
  } catch { /* 用默认 */ }
  state = P.createState(prefs);
  renderPresets();
  render();
  setMsg(S.idle);
})();

window.addEventListener('beforeunload', stopTimer);
