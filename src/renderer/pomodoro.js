'use strict';
/**
 * 番茄钟窗口：预设 + 自定义时长，专注/短休/长休自动轮转。
 * 计时与阶段转移全部走 shared/pomodoro.js（与单测同一份纯函数）；
 * 完成一个专注 → 通知主进程给桌宠回体力/情绪（`pomodoro:report`）。
 */
const { ipcRenderer } = require('electron');
const { CFG } = require('../shared/config');
const P = require('../shared/pomodoro');
const PS = require('../shared/pomodoroStats');

const $ = (id) => document.getElementById(id);
const el = {
  arc: $('arc'), clock: $('clock'), phase: $('phase'), count: $('count'),
  toggleBtn: $('toggleBtn'), resetBtn: $('resetBtn'), skipBtn: $('skipBtn'),
  preFocus: $('preFocus'), preShort: $('preShort'), preLong: $('preLong'),
  inFocus: $('inFocus'), inShort: $('inShort'), inLong: $('inLong'), inEvery: $('inEvery'),
  autoNext: $('autoNext'), msg: $('msg'), saveBtn: $('saveBtn'),
  // 标签页 / 学习记录 / 成就
  tabBtnTimer: $('tabBtnTimer'), tabBtnRecords: $('tabBtnRecords'), tabBtnAch: $('tabBtnAch'),
  tabTimer: $('tabTimer'), tabRecords: $('tabRecords'), tabAch: $('tabAch'),
  tagInput: $('tagInput'),
  stToday: $('stToday'), stWeek: $('stWeek'), stStreak: $('stStreak'), stStreakBest: $('stStreakBest'),
  stTotal: $('stTotal'), stTotalS: $('stTotalS'), recList: $('recList'), achGrid: $('achGrid'),
};

const CIRC = 2 * Math.PI * 84;
const S = CFG.pomodoro.strings;

let prefs = P.normalizePomodoroPrefs(null) || {};   // 生效偏好（缺项由 durationsOf 兜底）
let state = P.createState(prefs);
let timer = 0;

/* ---------------- 学习记录追踪 ---------------- */
let stats = PS.emptyStats();   // 主进程权威副本的本地镜像（每次 report 后用返回值刷新）
let segStartedAt = 0;          // 当前专注段的开始时间戳（"开始"而非"继续"时刷新）
let flowStreak = 0;            // 本次使用中不中断连续完成的专注数（心流成就用）

const lastTagKey = 'pomodoro.lastTag';
function currentTag() { return (el.tagInput.value || '').trim().slice(0, 24); }
el.tagInput.value = (() => { try { return localStorage.getItem(lastTagKey) || ''; } catch { return ''; } })();
el.tagInput.addEventListener('change', () => {
  try { localStorage.setItem(lastTagKey, currentTag()); } catch { /* 忽略 */ }
});

/** 当前专注段已累计的毫秒数（暂停后 remainMs 已结算，直接相减即可）。 */
function elapsedMsOf() { return Math.max(0, (state.totalMs || 0) - (state.remainMs || 0)); }

/**
 * 上报一次专注段（完成/中断）。返回主进程响应（含刷新后的 stats）。
 * 中断按约定 ≥1 分钟才记（config.pomodoro.abortMinMs）。
 */
/**
 * 上报一次专注段（完成/中断）。
 * opts.minutes/plannedMin 可显式指定（"完整走完"时在切段前先算好）；
 * 返回主进程响应（含刷新后的 stats）。中断按约定 ≥1 分钟才记（config.pomodoro.abortMinMs）。
 */
async function reportSegment(ok, opts = {}) {
  const minutes = opts.minutes !== undefined ? opts.minutes : elapsedMsOf() / 60000;
  const plannedMin = opts.plannedMin !== undefined ? opts.plannedMin : Math.round((state.totalMs || 0) / 60000);
  const startedAt = segStartedAt;   // 先取值再清零
  segStartedAt = 0;
  if (!ok) flowStreak = 0;
  const payload = {
    phase: ok ? 'focus' : 'abort',
    minutes: Math.round(minutes * 10) / 10,
    plannedMin,
    startedAt,
    tag: currentTag(),
    flowStreak: ok ? flowStreak : 0,
  };
  try {
    const res = await ipcRenderer.invoke('pomodoro:report', payload);
    if (res && res.stats) { stats = res.stats; renderRecords(); renderAch(); }
    if (res && Array.isArray(res.unlocked) && res.unlocked.length) {
      setMsg(`🏆 解锁成就：${res.unlocked.map((u) => u.name).join('、')}`);
    }
    return res;
  } catch { /* 主进程没起/测试环境：记录缺失但不影响计时 */ }
  return null;
}

/** 本段是否值得记一条"中断"（专注段 + 学过 ≥1 分钟）。 */
function abortWorthy() {
  return state.phase === 'focus' && segStartedAt > 0 && elapsedMsOf() >= CFG.pomodoro.abortMinMs;
}

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

/** 一段走完：专注完成 → 先记账（此刻 elapsedMs 还属于本段）再通知主进程奖励；然后切下一段。 */
async function onPhaseFinished() {
  const wasFocus = state.phase === 'focus';
  const finishedMinutes = Math.round(state.totalMs / 60000);
  const res = P.finishPhase(state, prefs);
  state = res.state;
  if (wasFocus) {
    flowStreak += 1;                       // 心流：本次使用中连续完成的专注数
    const rep = await reportSegment(true, { minutes: finishedMinutes, plannedMin: finishedMinutes });
    // 解锁成就时 reportSegment 已把消息换成 🏆 文案，别再被默认消息盖掉
    if (!rep || !Array.isArray(rep.unlocked) || !rep.unlocked.length) setMsg(res.message);
  } else {
    void ipcRenderer.invoke('pomodoro:report', { phase: 'break', minutes: finishedMinutes });
  }
  if (!res.state.running) stopTimer();
  render();
}

function toggle() {
  if (state.running) { state = P.pause(state, Date.now()); stopTimer(); setMsg(S.paused); }
  else {
    // 全新专注段（非暂停续走）→ 记下段开始时间（学习记录的"几点开始学的"）
    if (state.phase === 'focus' && state.remainMs === state.totalMs) segStartedAt = Date.now();
    state = P.start(state, Date.now()); ensureTimer(); setMsg(S.running);
  }
  render();
}

/* ---------------- 事件 ---------------- */

el.toggleBtn.addEventListener('click', toggle);

el.resetBtn.addEventListener('click', () => {
  stopTimer();
  if (abortWorthy()) void reportSegment(false);   // 学了 ≥1 分钟被打断 → 记一条中断
  state = P.resetAll(state, prefs);
  segStartedAt = 0; flowStreak = 0;
  setMsg(S.idle);
  render();
});

el.skipBtn.addEventListener('click', () => {
  // 跳过当前段：不计入专注完成数（只有真正走完才算），直接切下一段
  const next = state.phase === 'focus'
    ? (state.completedFocus + 1) % Math.max(1, state.durations.longBreakEvery) === 0 ? 'longBreak' : 'shortBreak'
    : 'focus';
  stopTimer();
  if (abortWorthy()) void reportSegment(false);   // 跳过一个学过一段时间的专注 = 中断
  state = P.jumpTo(state, next, prefs);
  segStartedAt = 0;
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

/* ---------------- 标签页：计时 / 记录 / 成就 ---------------- */

function fmtMin(m) {
  const v = Math.round((Number(m) || 0) * 10) / 10;
  if (v >= 60 && v % 60 === 0) return `${v / 60} 小时`;
  if (v >= 60) return `${Math.floor(v / 60)}h${Math.round(v % 60)}m`;
  return `${v} 分钟`;
}

function showTab(name) {
  const on = { timer: name === 'timer', records: name === 'records', ach: name === 'ach' };
  el.tabTimer.hidden = !on.timer;
  el.tabRecords.hidden = !on.records;
  el.tabAch.hidden = !on.ach;
  el.tabBtnTimer.classList.toggle('on', on.timer);
  el.tabBtnRecords.classList.toggle('on', on.records);
  el.tabBtnAch.classList.toggle('on', on.ach);
  if (on.records) renderRecords();
  if (on.ach) renderAch();
}
el.tabBtnTimer.addEventListener('click', () => showTab('timer'));
el.tabBtnRecords.addEventListener('click', () => showTab('records'));
el.tabBtnAch.addEventListener('click', () => showTab('ach'));

/** 记录页：顶部统计卡 + 明细列表（最新在上）。 */
function renderRecords() {
  const today = PS.dayKey(Date.now());
  const monday = (() => {           // 本周一（自然周，周一开始）
    const t = new Date(); t.setHours(0, 0, 0, 0);
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    return PS.dayKey(t.getTime());
  })();
  el.stToday.textContent = fmtMin(PS.minutesOnDay(stats, today));
  el.stWeek.textContent = fmtMin(PS.minutesSince(stats, monday));
  const a = stats.agg;
  el.stStreak.textContent = `${a.streakCur} 天`;
  el.stStreakBest.textContent = a.streakBest > 0 ? `最长 ${a.streakBest} 天` : '';
  el.stTotal.textContent = fmtMin(a.totalMin);
  el.stTotalS.textContent = `完整 ${a.done} 次 · 中断 ${a.abort} 次`;

  el.recList.textContent = '';
  const list = stats.entries.slice().reverse();
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty'; d.textContent = '还没有学习记录——完成第一个专注就会出现在这里。';
    el.recList.appendChild(d);
    return;
  }
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'rec';
    const tm = document.createElement('span');
    tm.className = 'tm';
    const t = e.s ? new Date(e.s) : null;
    tm.textContent = `${e.d.slice(5)} ${t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : ''}`;
    const tag = document.createElement('span');
    tag.className = `tag${e.tag ? '' : ' empty'}`;
    tag.textContent = e.tag || '未标注';
    tag.title = e.tag || '';
    const du = document.createElement('span');
    du.className = 'du';
    du.textContent = fmtMin(e.got);
    const st = document.createElement('span');
    st.className = `st ${e.ok ? 'ok' : 'no'}`;
    st.textContent = e.ok ? '完整' : '中断';
    row.append(tm, tag, du, st);
    el.recList.appendChild(row);
  }
}

/** 成就页：徽章网格（解锁=点亮+日期；未解锁=灰显）。 */
function renderAch() {
  el.achGrid.textContent = '';
  for (const def of PS.achievementDefs()) {
    const at = stats.ach[def.id];
    const b = document.createElement('div');
    b.className = `badge ${at ? 'on' : 'off'}`;
    const ic = document.createElement('div');
    ic.className = 'ic'; ic.textContent = at ? '🏆' : '🔒';
    const nm = document.createElement('div');
    nm.className = 'nm'; nm.textContent = def.name;
    b.append(ic, nm);
    if (at) {
      const dt = document.createElement('div');
      dt.className = 'dt';
      dt.textContent = `解锁于 ${PS.dayKey(at)}`;
      b.appendChild(dt);
    }
    el.achGrid.appendChild(b);
  }
}

/* ---------------- 启动 ---------------- */

(async () => {
  try {
    const saved = await ipcRenderer.invoke('pomodoro:prefs:load');
    const n = P.normalizePomodoroPrefs(saved);
    if (n) prefs = n;
  } catch { /* 用默认 */ }
  try {
    const s = await ipcRenderer.invoke('pomodoro:stats:load');
    if (s) stats = PS.normalizeStats(s);   // 学习记录（主进程权威数据）
  } catch { /* 空白记录 */ }
  state = P.createState(prefs);
  renderPresets();
  render();
  renderRecords();
  renderAch();
  setMsg(S.idle);
})();

// 关窗瞬间 sendSync 会阻塞渲染进程 → 用 on（一次性快速落盘），不能用 handle
window.addEventListener('beforeunload', () => {
  stopTimer();
  // 学了 ≥1 分钟的专注被关窗打断 → 记一条中断（同步上报，保证落盘后再退出）
  if (abortWorthy()) {
    try {
      ipcRenderer.sendSync('pomodoro:abort:sync', {
        phase: 'abort',
        minutes: Math.round((elapsedMsOf() / 60000) * 10) / 10,
        plannedMin: Math.round((state.totalMs || 0) / 60000),
        startedAt: segStartedAt,
        tag: currentTag(),
        flowStreak: 0,
      });
    } catch { /* 尽力而为 */ }
  }
});
