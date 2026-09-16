'use strict';
/**
 * llm 引擎：OpenAI 兼容 `POST {baseUrl}/chat/completions`（非流式 + 流式两条路径）。
 *
 * 契约不变：只实现 ChatEngine 的 `send(req) -> ChatResult`，**编排器与其它模块一行都不用改**。
 *
 * 环境（密钥/偏好/日志/打字机）从哪来：
 *   本文件属于 `shared/`（不碰 Electron / store / 密钥文件）→ 由**主进程注入**（`configure()`）：
 *     · prefs       settings.chatEngine.llm（已 normalize，见 content.normalizeLlmPrefs）
 *     · getApiKey   取密钥的函数（主进程读密钥文件/环境变量；**密钥不进 shared 层之外的任何地方**）
 *     · onLog       每次请求结束后上报一条结构化日志（耗时/状态码/tokens/走的哪条路径）
 *     · onDelta     流式增量（主进程用它做打字机效果）
 *     · fetchImpl   测试注入（默认用全局 fetch）
 *
 * 失败策略（需求"失败不哑火"）：
 *   401/404/429/5xx/超时/离线/解析失败 → **一律回落到 rule 引擎**（桌宠照常有反应），
 *   并把 `meta.degradedFrom='llm'` + `fallbackReason` 带出去给界面提示。
 *   其中 429 / 5xx / 网络抖动先按指数退避重试（retryMax 次，**绝不无限重试**），
 *   超时与用户取消**不重试**（等下去只会更慢）。
 *
 * 两条路径能力必须对齐（流式不是"另一套简版"）：超时、取消、重试、截断、回落、日志，
 * 在 stream=true 时全部走同一套外层逻辑，只有"怎么读响应"不同。
 */
const { registerEngine, getEngine, lastUserText, normalizeResult } = require('./engine');
const { createSseParser, parseOpenAiChunk } = require('./sse');
const { CFG } = require('../config');
const { normalizeLlmPrefs } = require('../content');

const ENGINE_ID = 'llm';

/** 默认人设/约束（config 可改；用户在设置面板填的 systemPrompt 优先）。 */
function llmConfig() {
  try {
    return (CFG.chatEngine && CFG.chatEngine.engines && CFG.chatEngine.engines.llm) || {};
  } catch { return {}; }
}

/* ================= 运行期环境（依赖注入） ================= */

function freshRuntime() {
  return {
    prefs: null,                 // settings.chatEngine.llm（可空 = 用 config 默认）
    getApiKey: () => '',         // 主进程注入
    onLog: null,                 // 主进程注入
    onDelta: null,               // 主进程注入（流式打字机）
    fetchImpl: null,             // 测试注入
    now: () => Date.now(),
  };
}
let runtime = freshRuntime();

function configure(next) {
  if (!next || typeof next !== 'object') return;
  runtime = { ...runtime, ...next };
}
function resetRuntime() { runtime = freshRuntime(); }

/** 当前生效的 LLM 配置（config 默认 + 用户偏好，已夹取）。 */
function prefs() { return normalizeLlmPrefs(runtime.prefs); }
function keyOf() {
  try { return String(runtime.getApiKey() || '').trim(); } catch { return ''; }
}
function fetchOf() {
  if (runtime.fetchImpl) return runtime.fetchImpl;
  return (typeof fetch === 'function') ? fetch : null;
}

/** 本地服务（127.0.0.1 / localhost）允许不带密钥；云端必须有密钥。 */
function isLocalUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(url || ''));
}

/** 不可用的**原因码**（给 UI 说人话，不要一律"没配置"）。 */
function unavailableReason() {
  const p = prefs();
  if (!p.baseUrl) return 'no-base-url';
  if (!p.model) return 'no-model';
  if (!isLocalUrl(p.baseUrl) && !keyOf()) return 'no-key';
  if (!fetchOf()) return 'no-fetch';
  return '';
}

/** 引擎可用性：配置齐 + （云端时）密钥在。选择引擎时据此决定是否回落 rule。 */
function available() { return !unavailableReason(); }

/* ================= 文本工具（纯函数，可单测） ================= */

/** 把可能混进错误信息/日志里的密钥打码（防御性：第三方回显密钥时也别让它进日志）。 */
function sanitizeText(text, key) {
  let s = String(text == null ? '' : text);
  if (key && key.length >= 8) s = s.split(key).join('sk-***');
  s = s.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1***');
  return s;
}

/** 从响应体里抠一句人话（尽量取 error.message）。 */
function pickErrorMessage(bodyText, key) {
  const raw = String(bodyText == null ? '' : bodyText).trim();
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const e = j && j.error;
    const msg = (e && (e.message || e.code)) || j.message || j.msg;
    if (msg) return sanitizeText(String(msg), key).slice(0, 200);
  } catch { /* 不是 JSON，直接截断原文 */ }
  return sanitizeText(raw, key).slice(0, 200);
}

/**
 * HTTP 状态码 → 明确原因码（需求要求"这几类要能分清楚"）。
 * auth=密钥错 / not-found=地址错 / model-not-found=模型不存在 / rate-limit=限流 / server=服务端错。
 */
function classifyHttp(status, bodyText, key) {
  const n = Number(status) || 0;
  const msg = pickErrorMessage(bodyText, key);
  if (n === 401 || n === 403) return { code: 'auth', httpStatus: n, detail: msg || '密钥无效或无权限' };
  if (n === 429) return { code: 'rate-limit', httpStatus: n, detail: msg || '触发限流' };
  if (n === 404) {
    // 404 且提到 model → 模型名写错；否则更像"地址/路径写错"
    if (/model|模型/i.test(msg)) return { code: 'model-not-found', httpStatus: n, detail: msg };
    return { code: 'not-found', httpStatus: n, detail: msg || '接口地址不存在（检查 base_url 是否含 /v1）' };
  }
  if (n === 400) {
    if (/model|模型/i.test(msg)) return { code: 'model-not-found', httpStatus: n, detail: msg };
    return { code: 'bad-request', httpStatus: n, detail: msg || '请求被拒绝（参数或模型名问题）' };
  }
  if (n >= 500) return { code: 'server', httpStatus: n, detail: msg || '服务端错误' };
  if (n === 0) return { code: 'network', httpStatus: 0, detail: msg || '网络不可达' };
  return { code: `http-${n}`, httpStatus: n, detail: msg };
}

/** 网络层异常 → 原因码（区分 超时 / 用户取消 / 断网）。 */
function classifyThrown(err, state) {
  if (state && state.timedOut) return { code: 'timeout', detail: '请求超时' };
  if (state && state.abortedByCaller) return { code: 'aborted', detail: '已取消' };
  // 递归取错误码/信息：undici 在 IPv4+IPv6 同时失败时会包一层 AggregateError
  //（`err.cause` 上没有 code，真正的 ECONNREFUSED 在 `cause.errors[]` 里）
  const collect = (e, depth) => {
    if (!e || depth > 3) return '';
    const parts = [e.code, e.message];
    if (Array.isArray(e.errors)) for (const sub of e.errors) parts.push(collect(sub, depth + 1));
    return parts.filter(Boolean).join(' ');
  };
  const raw = collect((err && err.cause) || err, 0) || String(err || '');
  // 配置类错误：base_url 本身不合法（Fetch 规范禁用端口 / 协议不支持…）→ 比"未知错误"有用得多
  if (/bad port|unsupported protocol|invalid url|failed to parse url/i.test(raw)) {
    return { code: 'bad-url', detail: raw.slice(0, 200) };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|NetworkError|UND_ERR/i.test(raw)) {
    return { code: 'network', detail: raw.slice(0, 200) };
  }
  if (/abort/i.test(raw)) {
    return state && state.timedOut ? { code: 'timeout', detail: '请求超时' }
      : { code: 'aborted', detail: '已取消' };
  }
  return { code: 'unknown', detail: raw.slice(0, 200) };
}

/** 回复截断：超过 maxChars 就截 + 省略号（气泡装不下长段落）。 */
function truncateReply(text, maxChars) {
  const s = String(text == null ? '' : text).trim();
  const limit = Math.max(1, Number(maxChars) || 120);
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…`;
}

/** 拼 system prompt：人设 + 上下文摘要 + 硬约束（字数）。 */
function assembleSystemPrompt(p, req) {
  const cfg = llmConfig();
  const persona = p.systemPrompt || cfg.systemPrompt || '';
  const parts = [];
  if (persona) parts.push(persona);
  const ctx = (req && req.context) || {};
  const bits = [];
  if (ctx.status && typeof ctx.status === 'object') {
    const b = [];
    for (const [k, label] of [['mood', '心情'], ['energy', '体力'], ['satiety', '饱食'], ['affinity', '亲密']]) {
      const v = Number(ctx.status[k]);
      if (Number.isFinite(v)) b.push(`${label}${Math.round(v)}`);
    }
    if (b.length) bits.push(b.join('/'));
  }
  if (Array.isArray(ctx.todos)) {
    const open = ctx.todos.filter((t) => t && !t.done);
    if (open.length) bits.push(`有 ${open.length} 条没做完的待办，最近一条是「${String(open[0].text || '').slice(0, 30)}」`);
  }
  if (ctx.study && typeof ctx.study === 'object' && ctx.study.level) {
    bits.push(`正在学英语（难度 ${String(ctx.study.level).slice(0, 20)}）`);
  }
  if (bits.length) parts.push(`（已知信息：${bits.join('；')}。需要时自然带一句，不必生硬罗列。）`);
  const rules = String(cfg.replyRules || '').replace('{maxChars}', String(p.maxChars));
  if (rules) parts.push(rules);
  return parts.join('\n');
}

/** 组装 messages：system + 历史（受轮数/字数预算限制）+ 本轮用户输入。 */
function buildMessages(req, p) {
  const msgs = [];
  const sys = assembleSystemPrompt(p, req);
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const h of trimHistory(p)) msgs.push(h);
  const cur = String(lastUserText(req) || '').trim();
  if (cur) msgs.push({ role: 'user', content: cur });
  return msgs;
}

/* ================= 会话历史（内存；重启即清） ================= */

let history = [];

function trimHistory(p) {
  const maxTurns = Math.max(0, p.historyTurns);
  let list = maxTurns === 0 ? [] : history.slice(-maxTurns * 2);
  const budget = Math.max(200, p.historyMaxChars);
  let total = list.reduce((s, m) => s + m.content.length, 0);
  while (list.length > 2 && total > budget) {
    total -= list[0].content.length;
    list = list.slice(1);
  }
  return list;
}

function recordHistory(userText, assistantText) {
  const u = String(userText || '').trim();
  const a = String(assistantText || '').trim();
  if (!u || !a) return;
  history.push({ role: 'user', content: u.slice(0, 1000) });
  history.push({ role: 'assistant', content: a.slice(0, 2000) });
  if (history.length > 60) history = history.slice(-60);
}

function resetHistory() { history = []; }
function historyLength() { return history.length; }

/* ================= 请求 ================= */

const RETRIABLE = new Set(['rate-limit', 'server', 'network']);   // ★ 只有这三类才退避重试
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** 组合"用户取消"与"超时"两个中止源，并给出中止原因（用于区分 timeout / aborted）。 */
function linkAbort(externalSignal) {
  const ctrl = new AbortController();
  const state = { timedOut: false, abortedByCaller: false };
  if (externalSignal) {
    if (externalSignal.aborted) { state.abortedByCaller = true; ctrl.abort(); }
    else externalSignal.addEventListener('abort', () => { state.abortedByCaller = true; ctrl.abort(); }, { once: true });
  }
  return { ctrl, state };
}

/**
 * 单次尝试（不重试、不回落）：成功返回 {ok:true, reply, usage, ...}，失败返回 {ok:false, code, detail, httpStatus}。
 * 流式：首块与"块间空闲"都受 timeoutMs 约束 —— 长回复不会被总时长掐断，但卡住会超时。
 */
async function attemptOnce(req, p, opts = {}) {
  const stream = !!opts.stream;
  const f = fetchOf();
  if (!f) return { ok: false, code: 'no-fetch', detail: '当前运行时没有 fetch' };
  const key = keyOf();
  if (!isLocalUrl(p.baseUrl) && !key) return { ok: false, code: 'no-key', detail: '没有配置密钥' };

  const { ctrl, state } = linkAbort(req && req.signal);
  let timer = 0;
  const arm = (ms) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { state.timedOut = true; ctrl.abort(); }, ms); };
  const disarm = () => { if (timer) { clearTimeout(timer); timer = 0; } };
  arm(p.timeoutMs);

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;   // 本地服务允许不带
  const body = {
    model: p.model,
    messages: buildMessages(req, p),
    temperature: p.temperature,
    max_tokens: p.maxTokens,
    stream,
  };

  try {
    const res = await f(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await safeText(res);
      disarm();
      return { ok: false, ...classifyHttp(res.status, text, key) };
    }
    const ctype = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';

    // ---- 非流式（或服务端忽略了 stream 参数、直接回 JSON）----
    const canStream = stream && res.body && typeof res.body.getReader === 'function' && !/application\/json/i.test(ctype);
    if (!canStream) {
      const text = await res.text();
      disarm();
      let j;
      try { j = JSON.parse(text); } catch { return { ok: false, code: 'bad-response', detail: sanitizeText(text, key).slice(0, 200) }; }
      if (j && j.error) return { ok: false, ...classifyHttp(400, JSON.stringify(j), key), detail: pickErrorMessage(JSON.stringify(j), key) };
      const choice = (j && Array.isArray(j.choices) && j.choices[0]) || null;
      const reply = (choice && choice.message && choice.message.content) || '';
      if (typeof reply !== 'string' || !reply.trim()) {
        return { ok: false, code: 'bad-response', detail: '响应里没有可用的回复内容', usage: (j && j.usage) || null };
      }
      return { ok: true, reply, usage: (j && j.usage) || null, model: (j && j.model) || p.model, finishReason: choice && choice.finish_reason, httpStatus: res.status };
    }

    // ---- 流式：SSE 增量解析（分片边界由 sse.js 负责）----
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    const parser = createSseParser();
    const deltaMs = Math.max(16, Number(llmConfig().streamDeltaMs) || 80);
    const hardCap = Math.max(1000, Number(llmConfig().streamMaxChars) || 20000);
    let acc = '';
    let usage = null;
    let finish = null;
    let lastPush = 0;
    let sawDone = false;
    let guardHit = false;
    let parseErrors = 0;

    const handle = (data) => {
      const c = parseOpenAiChunk(data);
      if (c.parseError) { parseErrors++; return; }
      if (c.error) throw Object.assign(new Error('stream-error'), { __code: 'server', __detail: sanitizeText(c.error, key) });
      if (c.text) {
        acc += c.text;
        const t = runtime.now();
        if (runtime.onDelta && (t - lastPush >= deltaMs)) { lastPush = t; try { runtime.onDelta(acc); } catch { /* 推送失败不影响主流程 */ } }
        if (acc.length >= hardCap) guardHit = true;   // 防御：模型失控重复 → 停止读取，保留已有文本
      }
      if (c.usage) usage = c.usage;
      if (c.finishReason) finish = c.finishReason;
      if (c.done) sawDone = true;
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm(p.timeoutMs);                       // ★ 每收到一块就重置空闲超时
      for (const data of parser.push(dec.decode(value, { stream: true }))) {
        handle(data);
        if (sawDone) break;
      }
      if (sawDone || guardHit) break;
    }
    if (!sawDone && !guardHit) {
      for (const data of parser.flush()) handle(data);
    }
    disarm();
    try { reader.cancel(); } catch { /* 已结束 */ }

    if (!acc.trim()) {
      return { ok: false, code: 'bad-response', detail: parseErrors ? '流式数据无法解析' : '流式响应为空', usage };
    }
    if (runtime.onDelta) { try { runtime.onDelta(acc); } catch { /* 收尾推送失败可忽略 */ } }
    return { ok: true, reply: acc, usage, model: p.model, finishReason: finish, httpStatus: res.status, streamed: true, guardHit };
  } catch (err) {
    disarm();
    if (err && err.__code) return { ok: false, code: err.__code, detail: err.__detail || '' };
    return { ok: false, ...classifyThrown(err, state) };
  } finally {
    disarm();
  }
}

/** 读响应体但绝不因为读失败而抛（错误路径上更要稳）。 */
async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

/* ================= 日志（主进程注入 onLog 后落到日志面板） ================= */

function emitLog(entry) {
  if (runtime.onLog) {
    // 带上时间戳，让日志条目自洽（主进程只是把它塞进环形缓冲并发给面板）
    try { runtime.onLog({ ts: runtime.now(), ...entry }); } catch { /* 日志失败不能影响聊天 */ }
  }
}

/* ================= 失败回落 rule（"桌宠照常有反应"） ================= */

function fallbackToRule(req, errInfo, extra) {
  const rule = getEngine('rule');
  let raw = null;
  try { raw = rule ? rule.send(req) : null; } catch { raw = null; }
  const res = normalizeResult(raw || { ok: true, matched: false, reply: null }, 'rule');
  res.engine = 'rule';
  res.meta = {
    ...(res.meta || {}),
    degradedFrom: 'llm',
    fallbackReason: (errInfo && errInfo.code) || 'unknown',
    fallbackDetail: sanitizeText((errInfo && errInfo.detail) || '').slice(0, 200),
  };
  emitLog({
    kind: (extra && extra.kind) || 'chat',
    channel: (extra && extra.channel) || 'text',
    path: 'fallback',
    ok: true,
    code: res.meta.fallbackReason,
    detail: res.meta.fallbackDetail,
    httpStatus: (errInfo && errInfo.httpStatus) || 0,
    attempts: (extra && extra.attempts) || 1,
    elapsedMs: (extra && extra.elapsedMs) || 0,
    model: prefs().model,
    replyChars: (res.reply || '').length,
    matched: res.matched,
  });
  return res;
}

/* ================= 对外：send / probe ================= */

/**
 * 处理一次聊天（文字/语音同源）。
 * @param {import('./engine').ChatRequest} req
 * @returns {Promise<import('./engine').ChatResult>}
 */
async function send(req) {
  const t0 = runtime.now();
  const p = prefs();
  const channel = (req && req.channel) || 'text';
  const finishMeta = (r, extra) => ({
    ...r,
    meta: {
      ...(r.meta || {}),
      model: p.model,
      stream: !!p.stream,
      attempts: (extra && extra.attempts) || 1,
      elapsedMs: Math.max(0, runtime.now() - t0),
      httpStatus: (extra && extra.httpStatus) || 0,
      ...(extra && extra.extraMeta ? extra.extraMeta : {}),
    },
  });

  // ① 调试开关：强制走回落（验收兜底逻辑用，不必拔网线）
  if (p.forceFallback) {
    return fallbackToRule(req, { code: 'force-fallback', detail: '调试开关：强制回落' }, { channel, elapsedMs: runtime.now() - t0 });
  }
  // ② 配置不齐 → 回落（并让界面能说清是缺哪一项）
  const why = unavailableReason();
  if (why) {
    return fallbackToRule(req, { code: why, detail: 'LLM 配置不完整' }, { channel, elapsedMs: runtime.now() - t0 });
  }

  // ③ 尝试 + 受控重试
  const maxAttempts = 1 + Math.max(0, p.retryMax);
  let attempt = 0;
  let last = null;
  while (attempt < maxAttempts) {
    attempt++;
    last = await attemptOnce(req, p, { stream: !!p.stream });
    if (last.ok) break;
    if (last.code === 'aborted') break;                 // 用户取消：不再重试
    if (!RETRIABLE.has(last.code)) break;               // 只重试 429/5xx/网络抖动
    if (attempt >= maxAttempts) break;
    const wait = p.retryBaseMs * Math.pow(2, attempt - 1);
    emitLog({ kind: 'retry', path: 'llm', ok: false, code: last.code, detail: last.detail, httpStatus: last.httpStatus || 0, attempts: attempt, elapsedMs: runtime.now() - t0, model: p.model, note: `退避 ${wait}ms 后第 ${attempt + 1} 次尝试` });
    await sleep(wait);
  }

  // ④ 成功
  if (last && last.ok) {
    const reply = truncateReply(last.reply, p.maxChars);
    recordHistory(String(lastUserText(req) || ''), reply);
    emitLog({
      kind: 'chat', channel,
      path: p.stream && last.streamed ? 'llm-stream' : 'llm',
      ok: true, code: '', httpStatus: last.httpStatus || 0, attempts: attempt,
      elapsedMs: runtime.now() - t0, model: last.model || p.model,
      promptTokens: (last.usage && last.usage.prompt_tokens) || 0,
      completionTokens: (last.usage && last.usage.completion_tokens) || 0,
      replyChars: reply.length,
      truncated: reply.length !== String(last.reply).trim().length,
      note: last.guardHit ? '命中流式累计上限，已停止读取' : '',
    });
    return finishMeta(
      normalizeResult({ ok: true, matched: true, reply, usage: last.usage || null, meta: { finishReason: last.finishReason || null } }, ENGINE_ID),
      { attempts: attempt, httpStatus: last.httpStatus, extraMeta: { streamed: !!last.streamed } },
    );
  }

  // ⑤ 失败 → 回落 rule（桌宠照常有反应）
  return fallbackToRule(req, last || { code: 'unknown' }, { channel, attempts: attempt, elapsedMs: runtime.now() - t0 });
}

/**
 * 「测试连接」：一次最小请求（max_tokens=1、不重试、不写历史、不走应用回落），
 * 把结果分类告诉用户：成功 / 401 密钥错 / 404 地址错 / 模型不存在 / 网络不可达 / 超时…
 * @returns {Promise<{ok:boolean, code:string, detail:string, httpStatus:number, elapsedMs:number, model:string, reply:string}>}
 */
async function probe() {
  const t0 = runtime.now();
  const p = prefs();
  const base = { ok: false, code: '', detail: '', httpStatus: 0, elapsedMs: 0, model: p.model, reply: '' };
  const fail = (code, detail, httpStatus) => {
    const r = { ...base, ok: false, code, detail: detail || '', httpStatus: httpStatus || 0, elapsedMs: Math.max(0, runtime.now() - t0) };
    emitLog({ kind: 'probe', channel: 'text', path: 'llm', ok: false, code, detail: r.detail, httpStatus: r.httpStatus, attempts: 1, elapsedMs: r.elapsedMs, model: p.model, note: '测试连接' });
    return r;
  };
  if (!p.baseUrl) return fail('no-base-url', '没有填 base_url');
  if (!p.model) return fail('no-model', '没有填模型名');
  if (!isLocalUrl(p.baseUrl) && !keyOf()) return fail('no-key', '还没有保存密钥');
  if (!fetchOf()) return fail('no-fetch', '当前运行时没有 fetch');

  const r = await attemptOnce({ channel: 'text', messages: [{ role: 'user', content: 'ping' }] }, { ...p, maxTokens: 1 }, { stream: false });
  const elapsed = Math.max(0, runtime.now() - t0);
  if (r.ok) {
    const out = { ...base, ok: true, code: 'ok', detail: '连接成功', httpStatus: r.httpStatus || 200, elapsedMs: elapsed, model: p.model, reply: String(r.reply || '').slice(0, 40) };
    emitLog({ kind: 'probe', channel: 'text', path: 'llm', ok: true, code: 'ok', httpStatus: out.httpStatus, attempts: 1, elapsedMs: elapsed, model: p.model, promptTokens: (r.usage && r.usage.prompt_tokens) || 0, completionTokens: (r.usage && r.usage.completion_tokens) || 0, note: '测试连接' });
    return out;
  }
  return fail(r.code, r.detail, r.httpStatus);
}

/* ================= 注册 ================= */

const llmEngine = {
  id: ENGINE_ID,
  label: '大模型（OpenAI 兼容）',
  capabilities: { streaming: true, context: true, tools: false, offline: false },
  available,
  send,
  probe,
  resetHistory,
};

registerEngine(llmEngine);

module.exports = {
  llmEngine, llmConfig, configure, resetRuntime,
  send, probe, resetHistory, historyLength,
  available, unavailableReason, prefs,
  // 供单测直接验证的纯函数
  truncateReply, assembleSystemPrompt, buildMessages, classifyHttp, classifyThrown,
  sanitizeText, pickErrorMessage, isLocalUrl,
  LLM_ENGINE_ID: ENGINE_ID,
};
