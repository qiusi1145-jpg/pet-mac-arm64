'use strict';
/**
 * 数据模型与规则（纯函数，可单测）：持久化设置 schema、待办清单纯逻辑、聊天规则。
 * 只做数据处理，不做 IO；真正的文件读写只在主进程 store.js。
 */

const { CFG } = require('./config');
const { normalizeVoicePrefs } = require('./voice');
const { normalizePomodoroPrefs } = require('./pomodoro');
const { normalizePlanner } = require('./planner');
const { normalizeAccentPref } = require('./uiTheme');

/* ================= 设置 schema（落盘与读盘字段一致） ================= */

function defaultSettings() {
  return {
    // 活动区域尺寸（相对主屏工作区的像素值，加载后仍会用 computeRegion 夹取）。
    region: { width: null, height: null }, // null = 默认填满工作区
    locked: false,
    visible: true,
    pos: null, // {x,y} 区域内部坐标（宠物左上角；写入留档，启动不据此恢复）
    // 图片资产（复制到 data/assets 后，只存相对 data 的路径；旧 %APPDATA% 迁移/测试可含绝对）
    pet: { path: null }, // 兼容旧用户主图路径（正常定制走 data/assets/pet/pet.png）
    background: { path: null, opacity: CFG.ui.bgDefaultOpacity },
    // BGM
    playlist: [], // [{path,title}]
    // 状态快照（含 lastTs 时间戳，用于离线结算）
    status: null,
    // 界面
    pillCollapsed: false,
    // 是否允许吸附到其它窗口顶沿
    snapEnabled: true,
    // 是否允许物理模拟（甩动抛掷 / 失去支撑坠落）；关闭后人物拖到哪停在哪，但吸附仍工作。
    physicsEnabled: true,
    // 待办清单
    todos: [], // [{id,text,due,done,important}]
    // 聊天回复规则
    chatRules: [], // [{keyword,reply}]
    // 聊天引擎选择（ChatEngine 注册表；缺省 = rule，即现有关键词规则）
    chatEngine: null, // { active:'rule'|'llm' }；非法/未知引擎时回退 rule
    // 语音偏好（触发方式/唤醒词/模型/设备；清洗逻辑在 shared/voice.js）
    voice: null, // { enabled, mode, model, deviceId, wake:{word,tokens,boost,threshold}, duckBgm, showPartial }
    // 番茄钟（时长偏好；清洗逻辑在 shared/pomodoro.js）
    pomodoro: null, // { focusMin, shortBreakMin, longBreakMin, longBreakEvery, autoStartNext }
    // 学习计划表条目（清洗逻辑在 shared/planner.js）
    planner: null, // { items: [{id,text,date,done,note}] }
    // 学英语偏好（难度/主题；详见 config.english）
    english: null,
    // 通用设置（UI 主题色 accent；清洗逻辑在 shared/uiTheme.js；2026-09-17 起）
    uiPrefs: null, // { accent: 'blue' | 'purple' | ... }
  };
}

/** 从磁盘 JSON 清洗出合法设置（缺省字段用默认值，类型错误则回退默认）。 */
function normalizeSettings(raw) {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const out = { ...d };
  if (raw.region && typeof raw.region === 'object') {
    const w = Number(raw.region.width);
    const h = Number(raw.region.height);
    out.region = {
      width: Number.isFinite(w) && w > 0 ? w : null,
      height: Number.isFinite(h) && h > 0 ? h : null,
    };
  }
  out.locked = !!raw.locked;
  out.visible = raw.visible !== false;
  if (raw.pos && Number.isFinite(raw.pos.x) && Number.isFinite(raw.pos.y)) {
    out.pos = { x: raw.pos.x, y: raw.pos.y };
  }
  if (raw.pet && typeof raw.pet.path === 'string') out.pet = { path: raw.pet.path };
  if (raw.background && typeof raw.background === 'object') {
    out.background.path = typeof raw.background.path === 'string' ? raw.background.path : null;
    const op = Number(raw.background.opacity);
    out.background.opacity = Number.isFinite(op)
      ? Math.min(CFG.ui.bgOpacityMax, Math.max(CFG.ui.bgOpacityMin, op))
      : d.background.opacity;
  }
  if (Array.isArray(raw.playlist)) {
    out.playlist = raw.playlist
      .filter((t) => t && typeof t.path === 'string' && t.path.length > 0)
      .map((t) => ({ path: t.path, title: typeof t.title === 'string' ? t.title : '' }));
  }
  out.status = raw.status && typeof raw.status === 'object' ? { ...raw.status } : null;
  out.pillCollapsed = !!raw.pillCollapsed;
  out.snapEnabled = raw.snapEnabled !== false;
  out.physicsEnabled = raw.physicsEnabled !== false;
  out.todos = normalizeTodos(raw.todos);
  out.chatRules = normalizeChatRules(raw.chatRules);
  out.chatEngine = normalizeChatEnginePref(raw.chatEngine);
  out.voice = normalizeVoicePrefs(raw.voice);
  out.pomodoro = normalizePomodoroPrefs(raw.pomodoro);
  out.planner = normalizePlanner(raw.planner);
  if (raw.english && typeof raw.english === 'object') out.english = { ...raw.english };
  out.uiPrefs = normalizeAccentPref(raw.uiPrefs);
  return out;
}

/* ================= 待办清单纯逻辑 ================= */

/** 单条待办清洗：非法字段回退默认，text 为空则丢弃（返回 null）。 */
function normalizeTodo(t) {
  if (!t || typeof t !== 'object') return null;
  const text = typeof t.text === 'string' ? t.text.trim().slice(0, 200) : '';
  if (!text) return null;
  const due = Number.isFinite(t.due) ? t.due : null;
  return {
    id: typeof t.id === 'string' && t.id ? t.id : `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    text,
    due,
    done: !!t.done,
    important: !!t.important,
  };
}

/** 列表清洗：丢弃非法项。 */
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const n = normalizeTodo(t);
    if (n) out.push(n);
  }
  return out;
}

/** 未完成且已到截止时间的待办（按截止时间升序，最紧迫在前）。 */
function findDueTodos(todos, now) {
  return (todos || [])
    .filter((t) => !t.done && t.due != null && t.due <= now)
    .sort((a, b) => a.due - b.due);
}

/**
 * 挑选随机催促目标：仅 ♥ 未完成待办；截止时间越近权重越高 ——
 * 已过期/剩余 ≤ urgentMs → urgentWeight（大幅提升）；剩余 ≤ soonMs → soonWeight（翻倍）；
 * 无截止时间权重 1。加权随机（rng 可注入以便测试）。
 */
function pickReminderTodo(todos, now, rng = Math.random) {
  const pool = (todos || []).filter((t) => !t.done && t.important);
  if (!pool.length) return null;
  const weights = pool.map((t) => {
    if (t.due == null) return 1;
    const left = t.due - now;
    if (left <= 0 || left <= CFG.reminder.urgentMs) return CFG.reminder.urgentWeight;
    if (left <= CFG.reminder.soonMs) return CFG.reminder.soonWeight;
    return 1;
  });
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** 用模板生成提醒文案（{task} 替换为待办内容）。 */
function formatTask(template, task) {
  return String(template || '{task}').replace('{task}', task);
}

/** 下一次催促的随机延迟（min~max 区间内均匀分布，rng 可注入便于测试）。 */
function randomReminderDelay(rng = Math.random) {
  const c = CFG.reminder;
  return c.minIntervalMs + rng() * Math.max(0, c.maxIntervalMs - c.minIntervalMs);
}

/* ================= 聊天回复规则 / 聊天引擎偏好 ================= */

/** 规则列表清洗：keyword/reply 均非空字符串才保留。 */
function normalizeChatRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const keyword = typeof r.keyword === 'string' ? r.keyword.trim().slice(0, 100) : '';
    const reply = typeof r.reply === 'string' ? r.reply.slice(0, 500) : '';
    if (!keyword || !reply) continue;
    out.push({ keyword, reply });
  }
  return out;
}

/**
 * 匹配规则：忽略大小写，输入文本“包含”某关键词即触发；
 * 同时命中多个时返回关键词最长的那条；无命中返回 null。
 */
function matchChatRule(rules, input) {
  const text = String(input || '').toLowerCase();
  if (!text) return null;
  let best = null;
  for (const r of rules || []) {
    if (!r || typeof r.keyword !== 'string' || !r.keyword) continue;
    if (!text.includes(r.keyword.toLowerCase())) continue;
    if (!best || r.keyword.length > best.keyword.length) best = r;
  }
  return best;
}

/**
 * 聊天引擎偏好清洗：`active` 必须命中 config.chatEngine.engines 里登记的 id，
 * 否则回退 config 默认值（防止手改 settings 指向不存在的引擎 → 桌宠"不说话"）。
 * 注意：这里**不判定引擎可用性**（如 llm 未实现）——那是 shared/chat 的 selectEngine 职责，
 * 它会自动回落 rule 并回报 degradedFrom。
 * 返回 null 表示"用户没设置过"（编排器按 config 默认处理）。
 */
/* ================= LLM 引擎偏好（白名单 + 夹取 + URL 校验） =================
 * ★ 安全红线：本函数**只认白名单字段** —— 任何顺着设置 JSON 混进来的 `apiKey` 都会被丢掉。
 *   密钥只走两条路：独立密钥文件（主进程，默认 `~/.deskpet/llm.key`，**不在便携目录内**）/ 环境变量；
 *   **永不进 settings.json**。注意 `keyFile` 也**不属于**用户可改偏好 —— 它是部署级配置，只在 config.js 里。
 */

/** 字符串清洗：非字符串→''；去首尾空白；按上限截断。 */
function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 数值夹取：非有限数→默认值；否则夹到 [min,max]（取整可选）。 */
function clampNum(v, min, max, dft, int) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
}

/**
 * base_url 校验：只允许 http/https（**挡掉 file:// 等本地协议**），去掉尾部斜杠，限长 300。
 * 返回 '' 表示不合法（调用方再回落到预设值）。
 */
function normalizeBaseUrl(v) {
  const s = clampStr(v, 300).replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return '';
  return s;
}

/**
 * LLM 偏好规范化：与 config 里的默认值/预设合并，产出**引擎直接可用**的一份配置。
 * @returns {{provider:string, baseUrl:string, model:string, systemPrompt:string,
 *  temperature:number, maxTokens:number, maxChars:number, historyTurns:number,
 *  historyMaxChars:number, timeoutMs:number, retryMax:number, retryBaseMs:number,
 *  stream:boolean, forceFallback:boolean}}
 */
function normalizeLlmPrefs(raw) {
  const c = (CFG.chatEngine && CFG.chatEngine.engines && CFG.chatEngine.engines.llm) || {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const presets = Array.isArray(c.presets) ? c.presets : [];
  const ids = presets.map((p) => p.id);
  const provider = ids.includes(src.provider) ? src.provider : (ids.includes(c.provider) ? c.provider : (ids[0] || 'custom'));
  const preset = presets.find((p) => p.id === provider) || null;
  // base_url：用户手填优先（且必须合法）；否则用预设；自定义且都空 = '' （→ 引擎判不可用）
  const baseUrl = normalizeBaseUrl(src.baseUrl) || normalizeBaseUrl(preset && preset.baseUrl) || '';
  const model = clampStr(src.model, 100) || clampStr(preset && preset.model, 100) || '';
  return {
    provider,
    baseUrl,
    model,
    systemPrompt: clampStr(src.systemPrompt, 2000),   // 空 = 用 config 里的默认人设
    temperature: clampNum(src.temperature, 0, 2, c.temperature, false),
    maxTokens: clampNum(src.maxTokens, 16, 4096, c.maxTokens, true),
    maxChars: clampNum(src.maxChars, 20, 1000, c.maxChars, true),
    historyTurns: clampNum(src.historyTurns, 0, 30, c.historyTurns, true),
    historyMaxChars: clampNum(src.historyMaxChars, 200, 20000, c.historyMaxChars, true),
    timeoutMs: clampNum(src.timeoutMs, 1000, 120000, c.timeoutMs, true),
    retryMax: clampNum(src.retryMax, 0, 5, c.retryMax, true),
    retryBaseMs: clampNum(src.retryBaseMs, 10, 10000, c.retryBaseMs, true),
    stream: !!src.stream,
    forceFallback: !!src.forceFallback,
  };
}

function normalizeChatEnginePref(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = Object.keys(CFG.chatEngine.engines || {});
  const active = typeof raw.active === 'string' && ids.includes(raw.active)
    ? raw.active
    : CFG.chatEngine.active;
  // ★ 必须把 llm 偏好一起带上：否则"切换引擎"会把用户填的 base_url/模型/人设挤掉
  return { active, llm: normalizeLlmPrefs(raw.llm) };
}

module.exports = {
  defaultSettings,
  normalizeSettings,
  normalizeTodo,
  normalizeTodos,
  findDueTodos,
  pickReminderTodo,
  formatTask,
  randomReminderDelay,
  normalizeChatRules,
  normalizeChatEnginePref,
  normalizeLlmPrefs,
  normalizeBaseUrl,
  matchChatRule,
  normalizeVoicePrefs,
  normalizePomodoroPrefs,
  normalizePlanner,
};
