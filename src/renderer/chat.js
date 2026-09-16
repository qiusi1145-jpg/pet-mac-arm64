'use strict';
/** 聊天窗口：**只负责渲染**，内容全部由主进程推来（它也是聊天记录的唯一写入方）。
 *
 *  为什么改成这样（2026-09-16）：以前"文字路径在本窗自己 append（用 invoke 返回值）、
 *  语音路径由主进程 push"，两条路并存；聊天记录一旦要持久化，就会出现"界面有、记录没有"的不一致。
 *  现在：打开时 `chat:history:load` 拉全量记录渲染 → 之后所有新消息走 `chat:message` 增量。
 *  规则由“聊天设置”窗口维护；未命中任何关键词时桌宠会被“点击一下”（Q 弹 + 情绪变化）。
 *  开场白：记录为空时由主进程写入一条（不会每次开窗都堆一条）。 */
const { ipcRenderer } = require('electron');

/* ---- UI 主题色（通用设置切换；只改视觉变量，不碰业务逻辑） ---- */
void (async () => {
  const prefs = await ipcRenderer.invoke('uiPrefs:load').catch(() => null);
  if (prefs && prefs.accent) document.documentElement.dataset.accent = prefs.accent;
})();
ipcRenderer.on('ui:accent', (_e, prefs) => {
  if (prefs && prefs.accent) document.documentElement.dataset.accent = prefs.accent;
});

const { CFG } = require('../shared/config');
const V = require('../shared/voice');   // 键位展示/匹配：与主进程注册全局键**共用同一套纯函数**，不各写一套

const msgsEl = document.getElementById('msgs');
const inputEl = document.getElementById('input');

function appendMsg(text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  msgsEl.appendChild(d);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

/** 渲染整个记录（打开窗口时一次）。 */
function renderHistory(entries) {
  msgsEl.textContent = '';
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.text) continue;
    appendMsg(e.text, e.who === 'pet' ? 'pet' : e.who === 'me' ? 'me' : 'sys');
  }
}

/**
 * 发送一句文字。**不再自己渲染**：那一条（我说的 + 桌宠回复 + 可能的旁白）都由主进程
 * `chat:message` 推回来 —— 自己再 append 一次就会显示两遍、记录里也会多一条。
 */
async function send() {
  const text = inputEl.value.trim();
  if (!text) { inputEl.focus(); return; }
  inputEl.value = '';
  try { await ipcRenderer.invoke('chat:send', text); } catch { /* 主进程异常，保持安静 */ }
  inputEl.focus();
}

/* ================= 取消进行中的请求 =================
 * 大模型可能要等几秒，用户需要能中断。两个入口：界面上的「停止」按钮 + Esc。
 * 按钮延迟 250ms 才显示 —— 规则引擎几乎瞬间返回，不该让按钮闪一下。 */
const stopBtn = document.getElementById('stopBtn');
let busyTimer = 0;

ipcRenderer.on('chat:busy', (_e, p) => {
  const busy = !!(p && p.busy);
  if (busy) {
    if (!busyTimer && stopBtn.hidden) busyTimer = setTimeout(() => { busyTimer = 0; stopBtn.hidden = false; }, 250);
  } else {
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = 0; }
    stopBtn.hidden = true;
  }
});

async function cancelInflight() {
  let r = null;
  try { r = await ipcRenderer.invoke('chat:cancel'); } catch { /* 主进程没起好 */ }
  if (r && r.ok) appendMsg('（已取消）', 'sys');
}

stopBtn.addEventListener('click', () => { void cancelInflight(); });
// Esc = 取消（与「停止」同义；输入框里按 Esc 也想中断，所以监听 window 层）
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') void cancelInflight(); });

document.getElementById('sendBtn').addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// 规则变化时轻提示（当前窗口的匹配即时生效）
ipcRenderer.on('chatRules:changed', (_e, { rules }) => {
  appendMsg(`（回复规则已更新：现在有 ${rules.length} 条规则）`, 'sys');
});

// 语音来源的消息由主进程推来：who='me' = 我说的那句（识别结果）、'pet' = 桌宠回复、'sys' = 提示
ipcRenderer.on('chat:message', (_e, m) => {
  if (!m || !m.text) return;
  appendMsg(m.text, m.who === 'pet' ? 'pet' : m.who === 'me' ? 'me' : 'sys');
});

// 记录被清空（设置窗里的按钮）→ 本窗立刻同步，别让旧内容留在屏幕上
ipcRenderer.on('chat:history:cleared', () => {
  msgsEl.textContent = '';
  appendMsg('（聊天记录已清空）', 'sys');   // 只是本次界面的提示，不写进记录
});

/* ================= 「正在输入」实时显示 =================
 * 呈现规则：
 *  · **没进语音对话时保持安静**（用户 2026-09-15 定调：后台等唤醒词不该在界面上乱动）；
 *  · 进了语音对话就给出反馈：在听 / 在想… / 正在识别 + 实时字幕 + 电平条。
 * 数据来自 voice:state（状态+电平）、voice:partial（实时字幕）、voice:dialog（对话态）、
 * voice:discard（过短没发给模型）。
 * 识别完成后，**我说的那句会作为 'me' 消息进入对话**（否则只有桌宠的回复，读起来像自言自语）。 */
const liveEl = document.getElementById('live');
const liveTxtEl = liveEl.querySelector('.txt');
const liveBarEl = liveEl.querySelector('.bar > i');
const live = { state: 'idle', rms: 0, partial: '', thinking: false, note: '', noteTimer: 0 };
let dialogOn = false;

function renderLive() {
  const show = dialogOn || live.state === 'decoding';
  liveEl.hidden = !show;
  if (!show) return;
  const S = CFG.voice.strings;
  let txt;
  let busy = false;
  if (live.note) {
    txt = live.note;                       // 过短/没听清这类一次性提示优先显示
  } else if (dialogOn && live.thinking) {
    txt = S.thinking; busy = true;          // 已提交、正在等模型（这期间不做识别）
  } else if (live.state === 'decoding') {
    txt = live.partial ? `正在识别：${live.partial}` : '正在识别…'; busy = true;
  } else if (dialogOn) {
    txt = S.dialogOn;                       // 语音对话中，正在等你说话
  } else {
    txt = '';
  }
  liveEl.classList.toggle('busy', busy);
  liveTxtEl.textContent = txt;
  liveBarEl.style.width = `${Math.min(100, Math.round(live.rms * 500))}%`;
}

/** 一次性提示（过短等）：显示几秒后自动让位给正常状态文案。 */
function flashLiveNote(text, ms = 2600) {
  live.note = text;
  if (live.noteTimer) clearTimeout(live.noteTimer);
  live.noteTimer = setTimeout(() => { live.note = ''; live.noteTimer = 0; renderLive(); }, ms);
  renderLive();
}

ipcRenderer.on('voice:state', (_e, p) => {
  live.state = (p && p.state) || 'idle';
  live.rms = (p && p.rms) || 0;
  if (live.state !== 'decoding') live.partial = '';
  renderLive();
});
ipcRenderer.on('voice:partial', (_e, p) => { live.partial = (p && p.text) || ''; renderLive(); });

/* ================= 语音对话（🎤 = 进入 / 再点退出） + 聊天窗内「按住说话」 =================
 * 2026-09-16 用户定调：聊天界面**常态是打字**，点 🎤 才进入语音对话；
 * 进入后自动连续多轮（说完静音自动断句 → 停麦等模型 → 回复到了自动接着听）。
 * ★ 当晚用户要求**恢复按键说话（PTT）**，现在两者**共存**（不是互斥）：
 *   · 全局键（任何窗口都能按）= 按一下进入 / 再按一下退出（只在主进程，见 applyPttShortcut）；
 *   · 聊天窗内的键 = **按住说话**：按住确保进入对话，**松开立即提交这一句**（不等 1.2 秒静音），
 *     再往下照常由 asr:resume 接着听 —— 所以"按住/松开"只是比等静音更快的一种提交方式。
 * 识别在独立的隐藏进程里跑（音频不跨进程），本窗只负责"进入/退出/提交"与状态显示。 */
const micBtn = document.getElementById('micBtn');
/** 聊天窗内「按住说话」的键位（来自 settings.voice.ptt.local，可在语音聊天设置里自定义）。 */
let pttLocal = CFG.voice.ptt.local;
/** 是否正按着说话键（防止 keydown 自动重复触发多次进入）。 */
let holding = false;

/** 麦克风按钮的 tooltip：进入/退出 + 当前「按住说话」键位（键位可自定义，所以得动态拼）。 */
function micTitle() {
  const key = V.prettyAccelerator(pttLocal);
  return dialogOn ? `点击退出语音对话（也可按住 ${key} 说话）` : `点击进入语音对话（或按住 ${key} 说话）`;
}

/** 同步「按住说话」键位（启动时与设置窗保存后各调一次）。 */
function applyLocalKey(prefs) {
  pttLocal = (prefs && prefs.ptt && prefs.ptt.local) || CFG.voice.ptt.local;
  micBtn.title = micTitle();
}

/* ---------------- 聊天窗内「按住说话」 ----------------
 * 按住 = 确保进入语音对话（若还没进）并开始说话；松开 = **立即提交这一句**。
 * 默认键位 Ctrl+Shift+Space —— **故意避开 Ctrl+空格**：那是 Windows 中文输入法的中英切换，
 * 事件会先被输入法吃掉，桌宠根本收不到（2026-09-15 踩过）。 */
async function holdStart() {
  if (holding) return;
  holding = true;
  try {
    if (!dialogOn) {
      const r = await ipcRenderer.invoke('voice:start');
      if (!r || !r.ok) {
        holding = false;
        appendMsg(r && r.hint ? r.hint : voiceUnavailableHint(await voiceStatus()), 'sys');
        return;
      }
      await refreshVoiceUi();
    }
    micBtn.classList.add('hold');
  } catch { holding = false; }
}

async function holdEnd() {
  if (!holding) return;
  holding = false;
  micBtn.classList.remove('hold');
  // 松手就是"我说完了"——不必再等 1.2 秒静音断句。
  // 太短的话识别侧会自己丢掉（不会去打扰大模型），这里不用管。
  try { await ipcRenderer.invoke('voice:flush'); } catch { /* 已退出会话 */ }
}

window.addEventListener('keydown', (e) => {
  if (e.repeat || !V.matchesAccelerator(pttLocal, e)) return;
  e.preventDefault();
  void holdStart();
});
window.addEventListener('keyup', (e) => {
  if (!V.matchesAccelerator(pttLocal, e)) return;
  e.preventDefault();
  void holdEnd();
});
// 窗口失焦（切走/被遮住）时别把"按住"状态卡住，否则下次回来以为还在按着
window.addEventListener('blur', () => { void holdEnd(); });

async function voiceStatus() {
  try { return await ipcRenderer.invoke('voice:status'); } catch { return null; }
}

/**
 * 语音不可用时的**一句话原因**。
 * 以前这里一律说"模型还没装"—— 遇到"进程卡住/已停用"就会把人带偏
 * （2026-09-15 的教训：真因是启动接线漏了，却一直提示"去装模型"）。
 */
function voiceUnavailableHint(st) {
  if (!st) return '语音暂不可用（主进程没响应状态查询）';
  if (st.reason === 'no-model') return '语音模型还没装：跑 npm run voice:fetch，或把模型放进 data/voice/models';
  if (st.reason === 'disabled') return '语音功能已关闭：主菜单 → 聊天 ▸ 语音聊天设置 里打开';
  if (st.reason === 'crashed') return `语音已停用：${st.error || '识别进程反复失败'}（在语音聊天设置里点「重试」）`;
  if (st.reason === 'not-initialized') return '语音服务未启动（在语音聊天设置里点「重试」）';
  if (st.loading) return '语音引擎正在加载模型，稍等 1~3 秒再试';
  return `语音引擎还没准备好${st.error ? '：' + st.error : ''}（在语音聊天设置里点「重试」）`;
}

/** 刷新麦克风按钮与状态条（语音可用性 + 当前是否在对话中）。 */
async function refreshVoiceUi() {
  const st = await voiceStatus();
  const available = !!(st && st.available);
  micBtn.hidden = !available;              // 不可用时**不露出**（优雅隐藏，与旧行为一致）
  if (st && typeof st.dialog === 'boolean') dialogOn = st.dialog;
  micBtn.classList.toggle('on', dialogOn);
  micBtn.title = micTitle();
  renderLive();
  return { available, status: st };
}

micBtn.addEventListener('click', async () => {
  micBtn.disabled = true;
  try {
    if (dialogOn) {
      await ipcRenderer.invoke('voice:stop');
    } else {
      const r = await ipcRenderer.invoke('voice:start');
      // 失败必须说清原因（主进程也会弹气泡，但这里离用户更近）
      if (!r || !r.ok) appendMsg(r && r.hint ? r.hint : voiceUnavailableHint(await voiceStatus()), 'sys');
    }
  } catch { /* 主进程异常：保持安静 */ }
  micBtn.disabled = false;
  await refreshVoiceUi();
});

// 主进程推来的对话态（进入/退出、以及"正在想"）
ipcRenderer.on('voice:dialog', (_e, p) => {
  dialogOn = !!(p && p.on);
  live.thinking = !!(p && p.thinking);
  micBtn.classList.toggle('on', dialogOn);
  micBtn.title = micTitle();
  renderLive();
});
// 过短 / 没内容：**没有发给大模型**（用户要求），在状态条上轻提示一下
ipcRenderer.on('voice:discard', (_e, p) => {
  const S = CFG.voice.strings;
  const why = (p && p.reason) === 'too-short-text' ? '太短了，没有发给桌宠' : S.tooShort;
  if (dialogOn) flashLiveNote(why);
});
// 设置窗改了唤醒开关/唤醒词/**键位** → 立即生效，不用重开聊天窗
ipcRenderer.on('voice:prefs:changed', (_e, p) => {
  applyLocalKey(p && p.prefs);
  void refreshVoiceUi();
});

(async () => {
  // 打开时把**持久化的聊天记录**拉出来渲染（记录为空时主进程会写入并返回一条开场白）。
  // 记录只存在本机、且在便携目录之外 —— 见 config.chat.logFile。
  try {
    const h = await ipcRenderer.invoke('chat:history:load');
    if (h) renderHistory(h.entries);
  } catch { /* 拉不到就空着，之后的消息照常显示 */ }
  inputEl.focus();

  // 键位来自 settings.voice.ptt.local（语音聊天设置里可改）—— 先拉一次，
  // 让 tooltip 和"按住说话"用的都是用户真正设的键，而不是写死的默认值。
  try { applyLocalKey(await ipcRenderer.invoke('voice:prefs:load')); } catch { /* 拉不到就用默认键位 */ }

  const { available, status: vst } = await refreshVoiceUi();
  if (available) {
    appendMsg(`（点 🎤 进入语音对话，直接说话就行；也可以按住 ${V.prettyAccelerator(pttLocal)} 说话，或打字）`, 'sys');
  } else {
    appendMsg(`（${voiceUnavailableHint(vst)}）`, 'sys');
  }
})();
