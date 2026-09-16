'use strict';
/**
 * ChatEngine 契约 + 注册表 + rule 引擎的回归测试。
 *
 * 核心目的（对应《语音识别调研与接入方案》§5.3「复用旧聊天的兼容性」）：
 * **证明把"关键词→回复"包装成引擎之后，行为与迁移前的主进程内联逻辑逐例等价**——
 * 这是"接口预留"不破坏现状的唯一硬证据。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../../src/shared/chat');
const { matchChatRule, normalizeChatEnginePref, normalizeSettings, defaultSettings } = require('../../src/shared/content');
const { CFG } = require('../../src/shared/config');

/* ================= 注册表 ================= */

test('注册表：内置 rule / llm 两个引擎已自注册', () => {
  const ids = chat.listEngines().map((e) => e.id);
  assert.ok(ids.includes('rule'), 'rule 引擎应内置');
  assert.ok(ids.includes('llm'), 'llm 占位应已注册（用于证明可扩展）');
  assert.equal(chat.getEngine('rule').id, 'rule');
});

test('注册表：非法对象/缺 send 的引擎被拒绝（不抛异常）', () => {
  assert.equal(chat.registerEngine(null), false);
  assert.equal(chat.registerEngine({ id: 'x' }), false);
  assert.equal(chat.registerEngine({ id: '', send() {} }), false);
  assert.equal(chat.registerEngine({ id: 'ok', send() {} }), true);
});

test('注册表：listEngines 回报 available（llm 未配置 → false）', () => {
  const byId = Object.fromEntries(chat.listEngines().map((e) => [e.id, e]));
  assert.equal(byId.rule.available, true);
  assert.equal(byId.llm.available, false);
  assert.equal(byId.rule.capabilities.offline, true);
});

/* ================= 选引擎 / 降级 ================= */

test('选引擎：未设置 → 用 fallback（rule）', () => {
  const r = chat.selectEngine(null);
  assert.equal(r.engine.id, 'rule');
  assert.equal(r.degradedFrom, null);
});

test('选引擎：active=rule 正常命中', () => {
  const r = chat.selectEngine({ active: 'rule' });
  assert.equal(r.engine.id, 'rule');
  assert.equal(r.requestedId, 'rule');
});

test('选引擎：active=llm（未实现/不可用）→ 自动回落 rule 并回报 degradedFrom', () => {
  const r = chat.selectEngine({ active: 'llm' });
  assert.equal(r.engine.id, 'rule', 'llm 不可用时必须回落到 rule，桌宠不能哑巴');
  assert.equal(r.degradedFrom, 'llm');
  assert.equal(r.requestedId, 'llm');
});

test('选引擎：active 指向不存在的引擎 → 回落 fallback', () => {
  const r = chat.selectEngine({ active: 'gpt9000' });
  assert.equal(r.engine.id, 'rule');
  assert.equal(r.degradedFrom, null); // 引擎不存在，不算"可用性降级"
});

/* ================= ChatRequest 归一 ================= */

test('makeRequest：text 便捷写法 → messages；channel 缺省 text', () => {
  const req = chat.makeRequest({ text: '你好' });
  assert.equal(req.channel, 'text');
  assert.deepEqual(req.messages, [{ role: 'user', content: '你好' }]);
});

test('makeRequest：voice 频道被保留（语音/文字的唯一差别）', () => {
  assert.equal(chat.makeRequest({ channel: 'voice', text: '你好' }).channel, 'voice');
  assert.equal(chat.makeRequest({ channel: '乱写', text: 'x' }).channel, 'text');
});

test('makeRequest：非法 message 被过滤；context/meta 原样带过', () => {
  const req = chat.makeRequest({
    messages: [{ role: 'user', content: 'a' }, { role: 'user' }, null, 'x'],
    context: { chatRules: [] }, meta: { asrConfidence: 0.9 },
  });
  assert.equal(req.messages.length, 1);
  assert.deepEqual(req.context, { chatRules: [] });
  assert.equal(req.meta.asrConfidence, 0.9);
});

test('lastUserText：取最后一条 user 消息', () => {
  const req = chat.makeRequest({
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '一' }, { role: 'assistant', content: '二' }, { role: 'user', content: '三' }],
  });
  assert.equal(chat.lastUserText(req), '三');
  assert.equal(chat.lastUserText(chat.makeRequest({})), '');
});

/* ================= rule 引擎：与旧 matchChatRule 逐例等价 ================= */

const RULES = [
  { keyword: '你好', reply: '短' },
  { keyword: '你好呀', reply: '长' },
  { keyword: 'HELLO', reply: 'hi' },
  { keyword: '在吗', reply: '在的' },
];

test('rule 引擎：与 matchChatRule 逐例等价（这是"行为零变化"的硬证据）', () => {
  const inputs = ['你好呀', '你好', '好呀', 'say hello to me', 'HELLO', '在吗？', '今天天气不错', ''];
  for (const input of inputs) {
    const legacy = matchChatRule(RULES, input);
    const r = chat.ruleEngine.send(chat.makeRequest({ text: input, context: { chatRules: RULES } }));
    if (!String(input).trim()) {
      // 空/全空白：不调引擎语义，直接 ok:false（与迁移前 chatSend 的早退一致）
      assert.equal(r.ok, false, `空输入 ok 应为 false: ${JSON.stringify(input)}`);
      assert.equal(r.matched, false);
      assert.equal(r.reply, null);
      continue;
    }
    assert.equal(r.ok, true, `ok: ${input}`);
    assert.equal(r.matched, !!legacy, `matched: ${input}`);
    assert.equal(r.reply, legacy ? legacy.reply : null, `reply: ${input}`);
    if (legacy) assert.equal(r.meta.keyword, legacy.keyword, `keyword: ${input}`);
  }
});

test('rule 引擎：多命中取最长关键词（与旧行为一致）', () => {
  const r = chat.ruleEngine.send(chat.makeRequest({ text: '你好呀', context: { chatRules: RULES } }));
  assert.equal(r.reply, '长');
  assert.equal(r.meta.keyword, '你好呀');
});

test('rule 引擎：未命中 → ok:true / matched:false / 无回复（触发"被点一下"）', () => {
  const r = chat.ruleEngine.send(chat.makeRequest({ text: '完全不相关', context: { chatRules: RULES } }));
  assert.equal(r.ok, true);
  assert.equal(r.matched, false);
  assert.equal(r.reply, null);
  assert.equal(r.engine, 'rule');
});

test('rule 引擎：无 context.chatRules 时按"没有规则"处理，不抛异常', () => {
  const r = chat.ruleEngine.send(chat.makeRequest({ text: '你好' }));
  assert.equal(r.matched, false);
});

test('rule 引擎：输入截断到 500 字（与迁移前 chatSend 的 slice 一致）', () => {
  const long = '啊'.repeat(550) + '在吗';
  const r = chat.ruleEngine.send(chat.makeRequest({ text: long, context: { chatRules: RULES } }));
  assert.equal(r.matched, false, '关键词在 500 字之后 → 截断后匹配不到');
  const within = '啊'.repeat(400) + '在吗';
  assert.equal(chat.ruleEngine.send(chat.makeRequest({ text: within, context: { chatRules: RULES } })).matched, true);
});

/* ================= normalizeResult 健壮性 ================= */

test('normalizeResult：实现者漏字段也不炸编排器', () => {
  assert.deepEqual(chat.normalizeResult(null, 'x'), { ok: true, matched: false, reply: null, engine: 'x' });
  const r = chat.normalizeResult({ ok: false, error: 'boom' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
  assert.equal(chat.normalizeResult({ reply: 42 }, 'x').reply, null, '非字符串 reply 归一为 null');
});

/* ================= llm 引擎：已实现（OpenAI 兼容），未配置时不可用 ================= */

test('llm 引擎：未配置（无密钥/base_url）时 available=false，且失败回落 rule 不抛异常', async () => {
  const { llmEngine, configure, resetRuntime } = require('../../src/shared/chat/llm');
  resetRuntime();
  configure({ prefs: null, getApiKey: () => '' });
  assert.equal(llmEngine.available(), false);
  const r = await llmEngine.send(chat.makeRequest({ text: '你好' }));
  assert.equal(r.ok, true, '回落 rule 后仍是"有结果"的返回（不是异常）');
  assert.equal(r.engine, 'rule');
  assert.equal(r.meta.degradedFrom, 'llm');
  assert.ok(r.meta.fallbackReason, '必须带回落原因码');
  resetRuntime();
});

test('llm 配置字段齐全（预设/超时/重试/流式/字数/人设）', () => {
  const c = chat.llmConfig();
  for (const k of ['baseUrl', 'model', 'temperature', 'maxTokens', 'maxChars', 'timeoutMs',
    'retryMax', 'retryBaseMs', 'stream', 'forceFallback', 'systemPrompt', 'presets']) {
    assert.ok(k in c, `config.chatEngine.engines.llm 应有 ${k}`);
  }
  assert.ok(Array.isArray(c.presets) && c.presets.length >= 2, '应带服务商预设');
  assert.equal(c.apiKeyEnv, '', '密钥只存环境变量名，且默认空');
  assert.equal(c.timeoutMs, 10000, '默认超时 10s');
});

/* ================= 设置持久化 ================= */

test('normalizeSettings：chatEngine 缺省 null；合法 active 保留', () => {
  assert.equal(defaultSettings().chatEngine, null);
  assert.equal(normalizeSettings({}).chatEngine, null);
  assert.equal(normalizeSettings({ chatEngine: { active: 'llm' } }).chatEngine.active, 'llm');
  assert.equal(normalizeSettings({ chatEngine: { active: 'rule' } }).chatEngine.active, 'rule');
});

test('normalizeChatEnginePref：未知/畸形引擎 id 回退 config 默认（防止手改 settings 让桌宠哑巴）', () => {
  assert.equal(normalizeChatEnginePref(null), null);
  assert.equal(normalizeChatEnginePref('oops'), null);
  assert.equal(normalizeChatEnginePref({ active: 'gpt9000' }).active, CFG.chatEngine.active);
  assert.equal(normalizeChatEnginePref({ active: 123 }).active, CFG.chatEngine.active);
  assert.equal(normalizeChatEnginePref({ active: 'llm' }).active, 'llm');
});

test('config：chatEngine.active 必须是已登记的引擎 id', () => {
  const ids = Object.keys(CFG.chatEngine.engines);
  assert.ok(ids.includes(CFG.chatEngine.active), 'config 默认 active 必须在 engines 里');
  assert.deepEqual(ids.sort(), ['llm', 'rule']);
});
