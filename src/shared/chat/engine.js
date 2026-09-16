'use strict';
/**
 * ChatEngine 契约 + 注册表（纯函数，可单测；无 DOM / 无 Electron）。
 *
 * 唯一目的：让"以后接大模型"变成「新增一个文件 + 改一个配置字段」，
 * 而不动 ASR、不动 IPC、不动 UI、不动持久化。
 *
 * 三条设计原则（对应《语音识别调研与接入方案》§五）：
 *  1. 引擎无关：编排器只认 ChatEngine 契约，不认 OpenAI / DeepSeek / Ollama。
 *  2. 语音与文字同源：两者最终都变成一条 ChatRequest，只有 channel 不同
 *     —— 这是 ASR 与 LLM 的唯一接缝。
 *  3. 现状不破坏：现有"关键词→回复"必须能原样跑在新抽象上（单测逐例回归）。
 *
 * 契约（JSDoc typedef，实现者按此对齐）：
 *
 * @typedef {Object} ChatMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 * @property {number} [ts]
 *
 * @typedef {Object} ChatRequest
 * @property {'text'|'voice'} channel   ★ 语音/文字的唯一差别；引擎通常无需关心
 * @property {ChatMessage[]} messages   已由编排器拼好（含历史与 systemPrompt）
 * @property {Object} [context]         只读快照，供引擎参考：
 *                                      { status:{mood,energy,satiety,affinity}, todos:[…],
 *                                        study:{level,rank,dueToday}, form:'main'|'alt',
 *                                        chatRules:[{keyword,reply}] }
 * @property {AbortSignal} [signal]     取消（用户关窗 / 再次说话）
 * @property {Object} [meta]            渠道细节：{ asrConfidence, durationMs, rawText }
 *
 * @typedef {Object} ChatResult
 * @property {boolean} ok
 * @property {boolean} matched         rule 引擎语义：是否命中关键词；LLM 恒 true
 * @property {string|null} reply
 * @property {string} [engine]         产出该回复的引擎 id（便于排查）
 * @property {string} [error]          失败原因（ok=false 时有意义）
 * @property {Object} [usage]          预留：{ promptTokens, completionTokens }
 * @property {Object} [meta]           引擎私有：rule→{keyword}；llm→{model,finishReason}
 *
 * @typedef {Object} ChatEngine
 * @property {string} id
 * @property {string} [label]
 * @property {{streaming:boolean, context:boolean, tools:boolean, offline:boolean}} capabilities
 * @property {(req: ChatRequest) => (Promise<ChatResult>|ChatResult)} send
 * @property {(req: ChatRequest) => AsyncIterable<string>} [stream]  可选，流式增量文本
 * @property {() => boolean} [available]                             可选，用于降级判断
 * @property {() => void} [dispose]                                  可选，释放连接
 */

/** 引擎 id → 引擎对象。模块加载期由各引擎文件自注册（rule 内置）。 */
const registry = new Map();

/**
 * 注册（或替换同名）引擎。传入非法对象直接忽略（不抛，避免启动期炸掉主进程）。
 * @param {ChatEngine} engine
 * @returns {boolean} 是否注册成功
 */
function registerEngine(engine) {
  if (!engine || typeof engine !== 'object') return false;
  if (typeof engine.id !== 'string' || !engine.id) return false;
  if (typeof engine.send !== 'function') return false;
  registry.set(engine.id, engine);
  return true;
}

/** 取引擎（未注册返回 null）。 */
function getEngine(id) {
  return registry.get(String(id)) || null;
}

/** 已注册引擎清单（给设置界面/排查用；available 为实时判定）。 */
function listEngines() {
  const out = [];
  for (const e of registry.values()) {
    let available = true;
    try { available = typeof e.available === 'function' ? !!e.available() : true; } catch { available = false; }
    out.push({ id: e.id, label: e.label || e.id, capabilities: { ...(e.capabilities || {}) }, available });
  }
  return out;
}

/** 测试用：清空注册表（生产代码不要调用）。 */
function clearEngines() {
  registry.clear();
}

/**
 * 按设置选引擎。目标引擎不存在或 `available()===false` → 回落到 fallbackId，
 * 并带上 degradedFrom（谁被降级掉了），便于编排器提示/埋点。
 *
 * @param {{active?:string}|null} prefs   settings.chatEngine（缺省用 fallbackId）
 * @param {string} [fallbackId='rule']
 * @returns {{ engine: ChatEngine|null, requestedId: string, degradedFrom: string|null }}
 */
function selectEngine(prefs, fallbackId = 'rule') {
  const requestedId = prefs && typeof prefs.active === 'string' && prefs.active ? prefs.active : fallbackId;
  let degradedFrom = null;
  let engine = registry.get(requestedId) || null;
  if (engine) {
    let available = true;
    try { available = typeof engine.available === 'function' ? !!engine.available() : true; } catch { available = false; }
    if (!available) { degradedFrom = engine.id; engine = null; }
  }
  if (!engine) engine = registry.get(fallbackId) || null;
  return { engine, requestedId, degradedFrom };
}

/**
 * 构造一条规范化的 ChatRequest（便宜行事：允许只给 text 不拼 messages）。
 * @param {{channel?:'text'|'voice', text?:string, messages?:ChatMessage[], context?:Object, meta?:Object, signal?:AbortSignal}} [init]
 * @returns {ChatRequest}
 */
function makeRequest(init = {}) {
  const channel = init.channel === 'voice' ? 'voice' : 'text';
  let messages = Array.isArray(init.messages) ? init.messages.filter((m) => m && typeof m.content === 'string') : [];
  if (!messages.length && typeof init.text === 'string') messages = [{ role: 'user', content: init.text }];
  const req = { channel, messages };
  if (init.context && typeof init.context === 'object') req.context = init.context;
  if (init.meta && typeof init.meta === 'object') req.meta = init.meta;
  if (init.signal) req.signal = init.signal;
  return req;
}

/** 取最后一条用户消息的文本（语音/文字同源；引擎都从这里拿"这一句"）。 */
function lastUserText(req) {
  const msgs = req && Array.isArray(req.messages) ? req.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/** 规范化引擎返回值：保证 ok/matched/reply 三件套字段齐全（实现者漏字段也不炸编排器）。 */
function normalizeResult(raw, engineId) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    ok: r.ok !== false,
    matched: !!r.matched,
    reply: typeof r.reply === 'string' ? r.reply : null,
    engine: r.engine || engineId || undefined,
    ...(r.error ? { error: String(r.error) } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    ...(r.meta ? { meta: r.meta } : {}),
  };
}

module.exports = {
  registerEngine, getEngine, listEngines, clearEngines,
  selectEngine, makeRequest, lastUserText, normalizeResult,
};
