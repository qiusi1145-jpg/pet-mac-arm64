'use strict';
/**
 * 语音聊天设置窗口：调整**后台唤醒**（开关 + 唤醒词）、识别档位、麦克风、闪避 BGM、实时字幕。
 *
 * 【结构】原来的"触发方式"4 选 1（按键 / 唤醒 / 唤醒+按键 / 常听）已取消：「常听」升级成
 * **语音对话**（聊天窗 🎤 进入/退出）。要持久化的只剩两项：`wake.enabled`（后台唤醒监听）
 * 与 `ptt`（按键说话键位）。
 * ★ 沿革：按键说话（PTT）曾于 2026-09-16 白天被取消、当晚按用户要求**恢复** ——
 *   现在它与语音对话**共存**（对话是会话状态，按键是"进入/退出 + 提前提交"的快捷方式），
 *   不要再当成互斥关系。
 *
 * 逻辑复用 shared/voice.js（与单测跑的是同一份代码）：
 *   normalizeVoicePrefs / wakeTokensOf / buildKeywordLine / wakeEnabledOf / acceleratorFromEvent
 * 持久化：settings.voice（主进程 voice:prefs:load / voice:prefs:save）。
 */
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
const V = require('../shared/voice');

const $ = (id) => document.getElementById(id);
const el = {
  wakeEnabled: $('wakeEnabled'),
  wakePick: $('wakePick'), wakeWord: $('wakeWord'), wakeTokens: $('wakeTokens'),
  wakeBoost: $('wakeBoost'), wakeThreshold: $('wakeThreshold'), kwLine: $('kwLine'),
  model: $('model'), device: $('device'), status: $('status'), retryBtn: $('retryBtn'),
  enabled: $('enabled'), duckBgm: $('duckBgm'), showPartial: $('showPartial'),
  keyLocal: $('keyLocal'), keyGlobal: $('keyGlobal'), keyClear: $('keyClear'),
  msg: $('msg'), saveBtn: $('saveBtn'), revertBtn: $('revertBtn'),
};

/** 正在录制键位：'local' | 'global' | null */
let recording = null;

/** 就地生效的偏好（保存前的编辑态） */
let prefs = V.normalizeVoicePrefs(null) || fallbackPrefs();
let dirty = false;

/** 未设过偏好时的默认态（= config 默认值）。 */
function fallbackPrefs() {
  return {
    enabled: CFG.voice.enabled,
    model: CFG.voice.model,
    deviceId: '',
    wake: {
      enabled: CFG.voice.wake.enabled !== false,
      word: CFG.voice.wake.word,
      tokens: '',
      boost: CFG.voice.wake.boost,
      threshold: CFG.voice.wake.threshold,
    },
    // 键位走 accelerator 白名单：非法/畸形一律丢弃（手改 settings 写坏键位不能变成"瞎抢键"）
    ptt: {
      local: CFG.voice.ptt.local,
      globalKey: CFG.voice.ptt.globalKey || '',
    },
    duckBgm: CFG.voice.duckBgmWhileListening,
    showPartial: CFG.voice.showPartial,
  };
}

/** 唤醒词区块的提示（开着的唤醒词没有音素串 → 永远唤不醒，必须说清）。 */
function renderWakeHint() {
  if (!prefs.wake.enabled) { el.kwLine.classList.remove('bad'); return; }
  const line = V.buildKeywordLine(prefs);
  if (!line) setMsg('⚠ 这个唤醒词还没有音素串，唤醒不会生效——请从内置词库选一个，或手填音素串。', true);
}

function setMsg(text, isErr) {
  el.msg.textContent = text || '';
  el.msg.classList.toggle('err', !!isErr);
}

/* ---------------- 渲染 ---------------- */

function renderWakeEnabled() {
  const on = prefs.wake.enabled !== false;
  el.wakePick.disabled = !on;
  el.wakeWord.disabled = !on;
  el.wakeTokens.disabled = !on;
  el.wakeBoost.disabled = !on;
  el.wakeThreshold.disabled = !on;
}

function renderWakePick() {
  el.wakePick.textContent = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '（从内置词库选择…）';
  el.wakePick.appendChild(blank);
  for (const b of CFG.voice.wake.builtin) {
    const o = document.createElement('option');
    o.value = b.word;
    o.textContent = b.tokens ? b.word : `${b.word}（需自填音素串）`;
    el.wakePick.appendChild(o);
  }
}

function renderKwLine() {
  const line = V.buildKeywordLine(prefs);
  el.kwLine.textContent = line
    ? `关键词串：${line}`
    : '关键词串：（空）—— 该唤醒词暂无音素映射，唤醒不会触发';
  el.kwLine.classList.toggle('bad', !line);
}

function renderModels() {
  el.model.textContent = '';
  for (const m of (CFG.voice.models || [])) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    el.model.appendChild(o);
  }
  el.model.value = prefs.model;
}

function renderDevices(devices) {
  el.device.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = '系统默认';
  el.device.appendChild(def);
  for (const d of devices || []) {
    const o = document.createElement('option');
    o.value = d.deviceId || d.id || '';
    o.textContent = d.label || o.value || '未命名设备';
    el.device.appendChild(o);
  }
  el.device.value = prefs.deviceId;
}

function renderAll() {
  renderWakePick();
  renderModels();
  el.wakeEnabled.checked = prefs.wake.enabled !== false;
  el.wakeWord.value = prefs.wake.word;
  el.wakeTokens.value = prefs.wake.tokens;
  el.wakeBoost.value = String(prefs.wake.boost);
  el.wakeThreshold.value = String(prefs.wake.threshold);
  el.enabled.checked = prefs.enabled;
  el.duckBgm.checked = prefs.duckBgm;
  el.showPartial.checked = prefs.showPartial;
  renderWakeEnabled();
  renderKeys();
  renderKwLine();
}

/* ---------------- 按键说话（键位录制） ----------------
 * 「点一下框 → 直接按下你想用的键」比手写 accelerator 字符串可靠得多：还会顺带挡住
 * 只按修饰键（Ctrl/Shift 单独按不算一个键）、以及 Electron 不认的键名。Esc = 取消。
 * 存的是 Electron accelerator 语法，主进程拿去 globalShortcut、聊天窗拿去匹配事件，
 * 两边**共用 shared/voice.js 的同一套纯函数**，不会各写一套而跑偏。 */
function renderKeys() {
  el.keyLocal.textContent = recording === 'local' ? '请按键…' : V.prettyAccelerator(prefs.ptt.local);
  el.keyGlobal.textContent = recording === 'global'
    ? '请按键…'
    : (prefs.ptt.globalKey ? V.prettyAccelerator(prefs.ptt.globalKey) : '未设置（点击设置）');
  el.keyLocal.classList.toggle('rec', recording === 'local');
  el.keyGlobal.classList.toggle('rec', recording === 'global');
}

/** 单键（无修饰）设成**全局**会独占那个键 —— 必须提醒，否则用户会以为"我的字母键坏了"。 */
function keyHintFor(acc) {
  return acc.includes('+') ? '' : '　⚠ 单键会全局独占（其它程序收不到它），会影响打字';
}

el.keyLocal.addEventListener('click', () => {
  recording = 'local';
  renderKeys();
  setMsg(CFG.voice.strings.pressKey);
});
el.keyGlobal.addEventListener('click', () => {
  recording = 'global';
  renderKeys();
  setMsg(CFG.voice.strings.pressKey);
});
el.keyClear.addEventListener('click', () => {
  prefs.ptt.globalKey = '';
  recording = null;
  dirty = true;
  renderKeys();
  setMsg(CFG.voice.strings.keyCleared);
});

// 捕获阶段监听：抢在其它处理之前把按键吃掉，避免 Ctrl+W / F5 之类的默认行为把窗口弄乱
window.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  // 单独按 Esc = 取消（Escape 本身要配修饰键才能被记下来）
  if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    recording = null;
    renderKeys();
    setMsg('已取消');
    return;
  }
  const acc = V.acceleratorFromEvent(e);
  if (!acc) { setMsg(CFG.voice.strings.pressKey, true); return; }   // 只按了修饰键
  if (recording === 'local') prefs.ptt.local = acc;
  else prefs.ptt.globalKey = acc;
  recording = null;
  dirty = true;
  renderKeys();
  setMsg(`已记录：${V.prettyAccelerator(acc)}${keyHintFor(acc)}`);
}, true);

/* ---------------- 事件 ---------------- */

el.wakeEnabled.addEventListener('change', () => {
  prefs.wake.enabled = el.wakeEnabled.checked;
  dirty = true;
  renderWakeEnabled();
  setMsg(el.wakeEnabled.checked ? '已开启后台唤醒（麦克风会常驻监听）' : '已关闭后台唤醒（只在聊天窗点 🎤 说话）');
});

el.wakePick.addEventListener('change', () => {
  const w = el.wakePick.value;
  if (!w) return;
  prefs.wake.word = w;
  prefs.wake.tokens = ''; // 换内置词 → 交回词库查表
  el.wakeWord.value = w;
  el.wakeTokens.value = '';
  dirty = true;
  renderKwLine();
});

el.wakeWord.addEventListener('input', () => {
  prefs.wake.word = el.wakeWord.value.trim();
  dirty = true;
  renderKwLine();
});

el.wakeTokens.addEventListener('input', () => {
  prefs.wake.tokens = el.wakeTokens.value.trim();
  dirty = true;
  renderKwLine();
});

function readSensitivity() {
  const raw = { boost: el.wakeBoost.value, threshold: el.wakeThreshold.value, word: prefs.wake.word, tokens: prefs.wake.tokens };
  // 借 normalizeVoicePrefs 做夹取/校验（与保存路径同一套规则）
  const n = V.normalizeVoicePrefs({ ...prefs, wake: raw });
  if (n) {
    prefs.wake.boost = n.wake.boost;
    prefs.wake.threshold = n.wake.threshold;
  }
}
el.wakeBoost.addEventListener('change', () => { readSensitivity(); el.wakeBoost.value = String(prefs.wake.boost); dirty = true; renderKwLine(); });
el.wakeThreshold.addEventListener('change', () => { readSensitivity(); el.wakeThreshold.value = String(prefs.wake.threshold); dirty = true; renderKwLine(); });

el.model.addEventListener('change', () => { prefs.model = el.model.value; dirty = true; refreshStatus(); });
el.device.addEventListener('change', () => { prefs.deviceId = el.device.value; dirty = true; });
el.enabled.addEventListener('change', () => { prefs.enabled = el.enabled.checked; dirty = true; });
el.duckBgm.addEventListener('change', () => { prefs.duckBgm = el.duckBgm.checked; dirty = true; });
el.showPartial.addEventListener('change', () => { prefs.showPartial = el.showPartial.checked; dirty = true; });

el.saveBtn.addEventListener('click', async () => {
  readSensitivity();
  const payload = V.normalizeVoicePrefs(prefs) || prefs;
  const res = await ipcRenderer.invoke('voice:prefs:save', payload);
  if (res && res.ok) {
    prefs = res.prefs || payload;
    dirty = false;
    renderAll();
    renderWakeHint();
    // 全局键可能被别的程序占用 → 主进程如实回报（res.ptt.ok === false）
    // 这时必须**明确告诉用户**，否则他会以为"设了却没反应"
    if (res.ptt && res.ptt.ok === false) {
      setMsg(CFG.voice.strings.keyTaken, true);
    } else if (prefs.ptt && prefs.ptt.globalKey) {
      setMsg(`已保存（全局键 ${V.prettyAccelerator(prefs.ptt.globalKey)} 已生效）`);
    } else {
      setMsg(prefs.wake.enabled !== false ? '已保存（后台唤醒已开启）' : '已保存（仅聊天窗语音对话）');
    }
    setTimeout(() => setMsg(''), 3200);
  } else setMsg('保存失败', true);
});

el.revertBtn.addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('voice:prefs:save', null);
  prefs = fallbackPrefs();
  renderAll();
  dirty = false;
  setMsg(res && res.ok ? '已还原为默认' : '已还原（但写盘失败）', !(res && res.ok));
  refreshStatus();
});

/* ---------------- 状态（模型/引擎可用性，由主进程 voice:status 提供） ---------------- */

async function refreshStatus() {
  try {
    const s = await ipcRenderer.invoke('voice:status');
    if (!s) return;
    const bits = [];
    if (s.available) {
      bits.push(`引擎：${s.engine}｜模型：${s.model}（已就绪）`);
      // 配置的档位没装但别的档位装了 → 说清楚在用哪个，别让用户以为"设了没生效"
      if (s.fallbackFrom) bits.push(`⚠ 配置的档位「${s.fallbackFrom}」未安装，当前实际使用「${s.model}」`);
    } else if (s.loading) {
      // 正在加载与"卡住"必须分开说：前者该等，后者该重试
      bits.push(`正在加载模型…（${s.model}）首次约 1~3 秒`);
    } else {
      bits.push(`当前不可用：${reasonText(s)}`);
    }
    if (s.kwsReady === false) bits.push('唤醒词模型缺失 → 唤醒功能不可用');
    if (s.retries > 0) bits.push(`已自动重建 ${s.retries} 次${s.stage ? `（最后阶段：${s.stage}）` : ''}`);
    if (s.error) bits.push(`错误：${s.error}`);
    el.status.textContent = bits.join('　');
    if (el.retryBtn) el.retryBtn.hidden = !!s.available;  // 已经能用就不必重试
  } catch { el.status.textContent = ''; }
}

/** 不可用原因 → 一句人话（不再一律说"模型没装"，那是会把人带偏的） */
function reasonText(s) {
  switch (s.reason) {
    case 'no-model': return '语音模型未安装（放 data/voice/models，或跑 npm run voice:fetch）';
    case 'disabled': return '语音功能已关闭（勾选上方"启用语音聊天"后保存）';
    case 'crashed': return '识别进程反复失败已停用 → 点「重试」恢复';
    case 'not-ready': return '语音引擎还没准备好 → 点「重试」重建（不必重启应用）';
    case 'not-initialized': return '语音服务未启动 → 点「重试」拉起';
    default: return s.reason || '未知原因';
  }
}

async function refreshDevices() {
  try {
    const r = await ipcRenderer.invoke('voice:devices');
    renderDevices(r && r.devices ? r.devices : []);
  } catch { renderDevices([]); }
}

/* 重试：重建识别进程（"卡住/已停用"时的自救出口 —— 用户不必去重启整个应用） */
el.retryBtn.addEventListener('click', async () => {
  el.retryBtn.disabled = true;
  setMsg('正在重建语音引擎…');
  try {
    const r = await ipcRenderer.invoke('voice:retry');
    await refreshStatus();
    setMsg(r && r.ok ? '已重建，稍等 1~3 秒后即可说话' : '重建未成功，请看上方状态', !(r && r.ok));
  } catch { setMsg('重建失败', true); }
  el.retryBtn.disabled = false;
  setTimeout(() => setMsg(''), 2500);
});

(async () => {
  try {
    const saved = await ipcRenderer.invoke('voice:prefs:load');
    if (saved) prefs = saved;
  } catch { /* 取不到用默认 */ }
  renderAll();
  await refreshDevices();
  await refreshStatus();
  setInterval(refreshStatus, 4000);
})();
