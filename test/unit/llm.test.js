'use strict';
/**
 * LLM 引擎单测（L1：纯 Node，零 Electron；用**本地 mock HTTP 服务**造出 401/404/429/超时/流式等场景）。
 *
 * 覆盖三批需求里所有"能自动化"的点：
 *   ① 偏好规范化（白名单 + 夹取 + base_url 校验，且**密钥字段被丢弃**）
 *   ② SSE 解析（分片边界 / CRLF / 多行 data / 心跳 / flush）
 *   ③ 密钥文件（明文独立文件，**必须在便携目录之外**；路径解析 / 自动建目录 / 坏文件不抛）
 *   ④ 引擎：请求构造、错误分类、指数退避重试（有上限）、取消、超时、截断、回落 rule、日志
 *   ⑤ 流式：打字机增量、跨分片、超时/取消/截断/回落**在流式路径同样生效**
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const chat = require(path.join(ROOT, 'src', 'shared', 'chat'));           // 注册 rule + llm
const llm = require(path.join(ROOT, 'src', 'shared', 'chat', 'llm'));
const { createSseParser, parseOpenAiChunk } = require(path.join(ROOT, 'src', 'shared', 'chat', 'sse'));
const { normalizeLlmPrefs, normalizeBaseUrl, normalizeChatEnginePref, normalizeSettings } = require(path.join(ROOT, 'src', 'shared', 'content'));
const { LlmSecret, resolveKeyFile, isInsideDir, parseKeyText } = require(path.join(ROOT, 'src', 'main', 'llmSecret'));

/* ================= 本地 mock 服务 ================= */

function startMock(handle) {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
      handle({ req, res, body, url: String(req.url || ''), auth: String(req.headers.authorization || '') });
    });
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
      });
    });
  });
}

const jsonReply = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

/** 最常见的 mock：模型名 → 行为。 */
function standardHandler(state = {}) {
  return ({ res, body, url }) => {
    // 路径不对 = "接口地址写错"（真实服务也会这样回 404）
    if (!String(url).startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body>404 Not Found</body></html>');
      return;
    }
    const model = String(body.model || '');
    state.calls = state.calls || {};
    state.calls[model] = (state.calls[model] || 0) + 1;
    if (model === 'ok') {
      jsonReply(res, 200, {
        model,
        choices: [{ message: { role: 'assistant', content: '你好呀' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      });
      return;
    }
    if (model === 'long') {
      jsonReply(res, 200, { model, choices: [{ message: { role: 'assistant', content: '长'.repeat(200) }, finish_reason: 'stop' }] });
      return;
    }
    if (model === '401') { jsonReply(res, 401, { error: { message: 'Invalid API key' } }); return; }
    if (model === '404model') { jsonReply(res, 404, { error: { message: 'The model `404model` does not exist' } }); return; }
    if (model === '500') { jsonReply(res, 500, { error: { message: 'boom' } }); return; }
    if (model === '429') { jsonReply(res, 429, { error: { message: 'rate limited' } }); return; }
    if (model === '429-then-ok') {
      state.attempts = state.attempts || {};
      const n = state.attempts[model] = (state.attempts[model] || 0) + 1;
      if (n === 1) { jsonReply(res, 429, { error: { message: 'rate limited' } }); return; }
      jsonReply(res, 200, { model, choices: [{ message: { role: 'assistant', content: '重试成功' }, finish_reason: 'stop' }] });
      return;
    }
    if (model === 'badjson') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{not json at all');
      return;
    }
    if (model === 'nocontent') {
      jsonReply(res, 200, { model, choices: [{ message: { role: 'assistant' } }] });
      return;
    }
    if (model === 'stream' || model === 'stream-split' || model === 'stream-long' || model === 'stream-stall') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const parts = model === 'stream-long' ? Array.from({ length: 30 }, (_, i) => `第${i}段`) : ['你', '好', '呀'];
      let i = 0;
      const write = (s) => res.write(s);
      const push = () => {
        if (i >= parts.length) {
          write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`);
          write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }] })}\n\n`;
        if (model === 'stream-split') {
          // 故意把一帧切成两半写出去：验证解析器能跨越分片边界
          const mid = Math.floor(frame.length / 2);
          write(frame.slice(0, mid));
          setTimeout(() => { write(frame.slice(mid)); i++; setTimeout(push, 5); }, 5);
        } else if (model === 'stream-stall') {
          write(frame); i++;
          // 之后不再写（首块后卡住 → 由空闲超时兜住），不 end
        } else {
          write(frame); i++;
          setTimeout(push, 5);
        }
      };
      push();
      return;
    }
    jsonReply(res, 400, { error: { message: `mock 不认识模型 ${model}` } });
  };
}

/** 统一的运行时注入（每个用例都先 reset，避免互相污染）。 */
function useEngine({ prefs, key = 'sk-test-key', onDelta = null, onLog = null } = {}) {
  llm.resetRuntime();
  llm.resetHistory();
  llm.configure({ prefs, getApiKey: () => key, onDelta, onLog });
}

const basePrefs = (patch = {}) => ({
  provider: 'custom', baseUrl: '', model: 'ok', temperature: 0.5, maxChars: 120,
  historyTurns: 4, historyMaxChars: 1000, timeoutMs: 1000, retryMax: 2, retryBaseMs: 10,
  stream: false, forceFallback: false, ...patch,
});

/* ================= ① 偏好规范化 ================= */

test('偏好：base_url 只允许 http/https（挡掉 file:// 等本地协议）', () => {
  assert.equal(normalizeBaseUrl('file:///etc/passwd'), '', 'file:// 必须被拒');
  assert.equal(normalizeBaseUrl('ftp://x/y'), '', '非 http(s) 一律拒');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1', '去掉尾部斜杠');
  assert.equal(normalizeBaseUrl('  http://127.0.0.1:11434/v1  '), 'http://127.0.0.1:11434/v1');
});

test('偏好：非法 base_url 回落到预设值；预设能带出 base_url/模型名', () => {
  const p = normalizeLlmPrefs({ provider: 'deepseek', baseUrl: 'file:///tmp/x', model: '' });
  assert.equal(p.provider, 'deepseek');
  assert.equal(p.baseUrl, 'https://api.deepseek.com/v1', '非法手填 → 用预设');
  assert.equal(p.model, 'deepseek-chat', '模型名留空 → 用预设');
});

test('偏好：未知 provider 回落到默认；数值全部夹取在安全范围内', () => {
  const p = normalizeLlmPrefs({
    provider: '不存在的东西', baseUrl: 'https://a/v1', model: 'm',
    temperature: 99, maxChars: 99999, timeoutMs: 1, retryMax: 99, historyTurns: -5,
  });
  assert.ok(['deepseek', 'openai', 'custom'].includes(p.provider));
  assert.equal(p.temperature, 2, '温度夹到 2');
  assert.equal(p.maxChars, 1000);
  assert.equal(p.timeoutMs, 1000, '超时下限 1s');
  assert.equal(p.retryMax, 5, '重试次数有上限（绝不无限重试）');
  assert.equal(p.historyTurns, 0, '历史轮数下限 0');
});

test('★ 偏好白名单：混进来的 apiKey 字段必须被丢弃（密钥不进 settings.json）', () => {
  const p = normalizeLlmPrefs({ baseUrl: 'https://a/v1', model: 'm', apiKey: 'sk-should-be-dropped' });
  assert.equal(p.apiKey, undefined, 'apiKey 不在白名单里，必须被丢掉');
  assert.equal(JSON.stringify(p).includes('sk-should-be-dropped'), false);
});

test('设置：normalizeChatEnginePref 必须保留 llm 偏好（切换引擎不能把配置挤掉）', () => {
  const s = normalizeSettings({ chatEngine: { active: 'llm', llm: { baseUrl: 'https://a/v1', model: 'm', maxChars: 42 } } });
  assert.equal(s.chatEngine.active, 'llm');
  assert.equal(s.chatEngine.llm.baseUrl, 'https://a/v1');
  assert.equal(s.chatEngine.llm.maxChars, 42);
});

/* ================= ② SSE 解析 ================= */

test('SSE：正常多帧 + [DONE]', () => {
  const p = createSseParser();
  const out = p.push('data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n');
  assert.deepEqual(out, ['{"a":1}', '{"a":2}', '[DONE]']);
  assert.equal(p.pending, '');
});

test('SSE：一帧被切成两半也能正确拼回（跨分片边界）', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('data: {"cho'), []);
  assert.deepEqual(p.push('ices":[]}\n\n'), ['{"choices":[]}']);
});

test('SSE：兼容 CRLF、多行 data、心跳注释行', () => {
  const p = createSseParser();
  const out = p.push(': keep-alive\r\n\r\ndata: line1\r\ndata: line2\r\n\r\n');
  assert.deepEqual(out, ['line1\nline2'], '多行 data 用 \\n 连接，心跳被忽略');
});

test('SSE：flush 交出没有空行收尾的最后一帧', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('data: tail'), []);
  assert.deepEqual(p.flush(), ['tail']);
});

test('SSE：parseOpenAiChunk 解析 delta / DONE / 错误 / 非 JSON', () => {
  assert.equal(parseOpenAiChunk('{"choices":[{"delta":{"content":"你"}}]}').text, '你');
  assert.equal(parseOpenAiChunk('[DONE]').done, true);
  assert.equal(parseOpenAiChunk('{"error":{"message":"boom"}}').error, 'boom');
  assert.equal(parseOpenAiChunk('not-json').parseError, true);
});

/* ================= ③ 密钥文件（明文，但必须在便携目录之外） ================= */

/** 造临时目录（登记下来，文件跑完统一清理）。 */
const TMP_DIRS = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

/** 造一个"多层目录 + llm.key"的路径：故意多一层，用来验证"目录不存在会自动创建"。 */
function tmpSecretPath() {
  return path.join(tmpDir('pet-keyfile-'), 'nested', 'llm.key');
}

// 文件跑完把这些临时目录清掉（别在系统 TEMP 里堆垃圾）
after(() => {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }
});

test('密钥路径解析：默认在用户主目录下（便携目录之外），支持 ~ / 绝对路径 / env 覆盖', () => {
  const home = path.join(path.sep + 'home', 'someone');
  assert.equal(resolveKeyFile({ homeDir: home }), path.join(home, '.deskpet', 'llm.key'));
  assert.equal(resolveKeyFile({ keyFile: '~/a/b.key', homeDir: home }), path.join(home, 'a', 'b.key'));
  // 相对路径按**主目录**解析（刻意不按程序目录，否则又变成便携的了）
  assert.equal(resolveKeyFile({ keyFile: 'rel/llm.key', homeDir: home }), path.join(home, 'rel', 'llm.key'));
  const abs = path.join(path.sep + 'etc', 'deskpet.key');
  assert.equal(resolveKeyFile({ keyFile: abs, homeDir: home }), abs);
  // 环境变量优先级最高（自检/测试隔离用）
  assert.equal(resolveKeyFile({ keyFile: abs, homeDir: home, envFile: '~/x/y.key' }), path.join(home, 'x', 'y.key'));
});

test('isInsideDir：能判断"密钥文件是否落在了便携目录里"（本轮的核心不变量）', () => {
  const root = path.join(path.sep + 'app', 'data');
  assert.equal(isInsideDir(root, path.join(root, 'secret.bin')), true);
  assert.equal(isInsideDir(root, path.join(root, 'voice', 'x')), true);
  assert.equal(isInsideDir(root, root), true);
  assert.equal(isInsideDir(root, path.join(path.sep + 'home', 'u', '.deskpet', 'llm.key')), false);
  // 前缀相同但不是同一目录（data2 不是 data 的子目录）—— 必须判 false，否则断言会放水
  assert.equal(isInsideDir(root, path.join(path.sep + 'app', 'data2', 'x')), false);
});

test('密钥文件解析：跳过注释与空行、容忍前缀与引号、只取第一行有效内容', () => {
  assert.equal(parseKeyText(''), '');
  assert.equal(parseKeyText('# 只有注释\n\n'), '');
  assert.equal(parseKeyText('# 说明\nsk-abc123\n'), 'sk-abc123');
  assert.equal(parseKeyText('KEY=sk-abc123'), 'sk-abc123');
  assert.equal(parseKeyText('OPENAI_API_KEY = "sk-abc123"'), 'sk-abc123');
  assert.equal(parseKeyText("apiKey='sk-abc123'\n"), 'sk-abc123');
  assert.equal(parseKeyText('# c\n\nsk-first\nsk-second\n'), 'sk-first');
});

test('密钥文件：落盘是明文（可用记事本改）、新实例（=重启应用）能读回、状态为 file', () => {
  const file = tmpSecretPath();
  const v = new LlmSecret({ file });
  assert.equal(v.set('sk-abcdef123456').ok, true);
  assert.equal(fs.existsSync(file), true);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('sk-abcdef123456'), true, '明文保存是本次需求（不要加密保险箱）');
  assert.ok(raw.includes('#'), '带中文说明头，用户手工改时知道这是什么');
  const v2 = new LlmSecret({ file });      // 新实例 = 重启应用
  assert.equal(v2.get(), 'sk-abcdef123456', '重启后能读回');
  assert.equal(v2.status().stored, true);
  assert.equal(v2.status().source, 'file');
  assert.equal(v2.status().path, file);
});

test('★ 换电脑场景：目标目录/文件都不存在时，保存即自动创建整条路径', () => {
  const dir = tmpDir('pet-newpc-');
  const deep = path.join(dir, 'a', 'b', 'c', 'llm.key');
  assert.equal(fs.existsSync(path.dirname(deep)), false, '起初目录不存在');
  const v = new LlmSecret({ file: deep });
  assert.equal(v.status().source, 'none', '没有文件就是"未配置"，不是错误');
  assert.equal(v.status().error, '', '文件不存在不算错误（首次使用就是这样）');
  const r = v.set('sk-new-pc');
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(deep), true, '写完就存在了');
  assert.equal(new LlmSecret({ file: deep }).get(), 'sk-new-pc');
});

test('密钥文件：空/超长密钥被拒；没有文件时 get() 返回空且不算错误', () => {
  const file = tmpSecretPath();
  const v = new LlmSecret({ file });
  assert.equal(v.get(), '');
  assert.equal(v.status().error, '');
  assert.equal(v.set('   ').code, 'empty');
  assert.equal(v.set('\n').code, 'empty');
  assert.equal(v.set('x'.repeat(500)).code, 'too-long');
  assert.equal(fs.existsSync(file), false, '被拒的密钥绝不落盘');
});

test('密钥文件：clear 之后文件消失、缓存清空、状态归零', () => {
  const file = tmpSecretPath();
  const v = new LlmSecret({ file });
  v.set('sk-abcdef123456');
  assert.equal(v.clear().ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(v.get(), '');
  assert.equal(v.status().source, 'none');
});

test('密钥文件：只剩注释（被手工改坏）→ 不抛异常，给出 empty-file 原因码', () => {
  const file = tmpSecretPath();
  new LlmSecret({ file }).set('sk-abcdef123456');
  fs.writeFileSync(file, '# 我把密钥删了\n\n', 'utf8');
  const v = new LlmSecret({ file });
  assert.equal(v.get(), '');
  assert.equal(v.status().error, 'empty-file');
  assert.equal(v.status().stored, false, '文件在但读不出密钥 → 不能算"已配置"');
  assert.equal(v.status().exists, true);
});

test('密钥文件：读取失败（路径指向目录）→ 不抛异常，给出 io 原因码', () => {
  const dir = tmpDir('pet-keydir-');
  const v = new LlmSecret({ file: dir });   // 指向目录：readFileSync 会 EISDIR
  assert.equal(v.get(), '');
  assert.equal(v.status().error, 'io');
});
/* ================= ④ 引擎：成功 / 错误分类 / 重试 / 回落 ================= */

test('非流式成功：请求构造正确（URL、鉴权头、参数、人设、末尾用户输入）', async () => {
  let seen = null;
  const mock = await startMock((ctx) => { seen = ctx; jsonReply(ctx.res, 200, { model: 'ok', choices: [{ message: { role: 'assistant', content: '你好呀' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }); });
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, systemPrompt: '你是测试桌宠', maxChars: 33 }) });
    const logs = [];
    llm.configure({ onLog: (e) => logs.push(e) });
    const r = await llm.send(chat.makeRequest({ text: '在吗', context: { chatRules: [] } }));
    assert.equal(r.ok, true);
    assert.equal(r.reply, '你好呀');
    assert.equal(r.engine, 'llm');
    assert.equal(seen.url, '/v1/chat/completions', 'OpenAI 兼容路径');
    assert.equal(seen.auth, 'Bearer sk-test-key');
    assert.equal(seen.body.model, 'ok');
    assert.equal(seen.body.stream, false);
    assert.equal(seen.body.temperature, 0.5);
    assert.equal(seen.body.max_tokens, 512);
    const sys = seen.body.messages[0];
    assert.equal(sys.role, 'system');
    assert.ok(sys.content.includes('你是测试桌宠'), '人设进 system');
    assert.ok(sys.content.includes('33'), '字数约束进 system');
    assert.equal(seen.body.messages[seen.body.messages.length - 1].content, '在吗');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].path, 'llm');
    assert.equal(logs[0].ok, true);
    assert.equal(logs[0].completionTokens, 2);
  } finally { await mock.close(); }
});

test('错误分类：401 → auth；404(模型) → model-not-found；404(地址) → not-found；500 → server', async () => {
  const mock = await startMock(standardHandler());
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl }) });
    const cases = [['401', 'auth'], ['404model', 'model-not-found'], ['500', 'server']];
    for (const [model, want] of cases) {
      llm.configure({ prefs: basePrefs({ baseUrl: mock.baseUrl, model }) });
      const r = await llm.send(chat.makeRequest({ text: 'hi' }));
      assert.equal(r.engine, 'rule', `${model} 失败要回落 rule`);
      assert.equal(r.meta.fallbackReason, want, `${model} → ${want}`);
    }
    // 地址错：路径不是 /v1/chat/completions
    llm.configure({ prefs: basePrefs({ baseUrl: `http://127.0.0.1:${mock.port}/wrong`, model: 'ok' }) });
    const r2 = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(r2.meta.fallbackReason, 'not-found');
  } finally { await mock.close(); }
});

test('★ 密钥错误时也不哑火：401 → 回落规则引擎并给出规则回复', async () => {
  const mock = await startMock(standardHandler());
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: '401' }) });
    const r = await llm.send(chat.makeRequest({ text: '你好', context: { chatRules: [{ keyword: '你好', reply: '（规则）嗨' }] } }));
    assert.equal(r.engine, 'rule');
    assert.equal(r.reply, '（规则）嗨', '桌宠照常有反应');
    assert.equal(r.meta.degradedFrom, 'llm');
    assert.equal(r.meta.fallbackReason, 'auth');
  } finally { await mock.close(); }
});

test('重试：429/5xx 按 retryMax 退避重试（共 3 次尝试）后回落；不无限重试', async () => {
  const state = {};
  const mock = await startMock(standardHandler(state));
  try {
    const logs = [];
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: '429', retryMax: 2, retryBaseMs: 10 }), onLog: (e) => logs.push(e) });
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(state.calls['429'], 3, '1 次 + 重试 2 次 = 3 次尝试');
    assert.equal(r.engine, 'rule');
    assert.ok(logs.some((e) => e.kind === 'retry'), '日志里应能看到退避重试');
    assert.equal(logs[logs.length - 1].attempts, 3);
  } finally { await mock.close(); }
});

test('重试：429 之后成功 → 不回落（重试是有意义的）', async () => {
  const state = {};
  const mock = await startMock(standardHandler(state));
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: '429-then-ok', retryMax: 2, retryBaseMs: 10 }) });
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(r.engine, 'llm');
    assert.equal(r.reply, '重试成功');
  } finally { await mock.close(); }
});

test('重试次数可配为 0（只尝试一次）', async () => {
  const state = {};
  const mock = await startMock(standardHandler(state));
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: '500', retryMax: 0, retryBaseMs: 10 }) });
    await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(state.calls['500'], 1);
  } finally { await mock.close(); }
});

test('★ 超时：不重试、回落 rule，原因码 = timeout', async () => {
  const mock = await startMock(({ res }) => { /* 故意不回：靠超时兜住 */ setTimeout(() => { try { res.end(); } catch { /* 已关 */ } }, 3000); });
  try {
    const logs = [];
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'stall', timeoutMs: 1000, retryMax: 2 }), onLog: (e) => logs.push(e) });
    const t0 = Date.now();
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    const dt = Date.now() - t0;
    assert.equal(r.engine, 'rule');
    assert.equal(r.meta.fallbackReason, 'timeout');
    assert.ok(dt >= 900 && dt < 2500, `应在 ~1s 超时（实际 ${dt}ms）`);
    assert.equal(logs[logs.length - 1].attempts, 1, '超时不做重试');
  } finally { await mock.close(); }
});

test('★ 取消：abort 后立刻返回，原因码 = aborted，且不重试', async () => {
  const mock = await startMock(({ res }) => { setTimeout(() => { try { res.end(); } catch { /* 已关 */ } }, 3000); });
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'stall', timeoutMs: 5000, retryMax: 2 }) });
    const ctrl = new AbortController();
    const p = llm.send(chat.makeRequest({ text: 'hi', signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 150);
    const r = await p;
    assert.equal(r.engine, 'rule');
    assert.equal(r.meta.fallbackReason, 'aborted');
  } finally { await mock.close(); }
});

test('解析失败也算失败：坏 JSON / 没有 content → bad-response 并回落', async () => {
  const mock = await startMock(standardHandler());
  try {
    for (const model of ['badjson', 'nocontent']) {
      useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model }) });
      const r = await llm.send(chat.makeRequest({ text: 'hi' }));
      assert.equal(r.meta.fallbackReason, 'bad-response', `${model} 应归为响应解析失败`);
    }
  } finally { await mock.close(); }
});

test('字数截断：超长回复截断到 maxChars 并加省略号', async () => {
  const mock = await startMock(standardHandler());
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'long', maxChars: 20 }) });
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(r.reply.length, 21, '20 字 + 省略号');
    assert.equal(r.reply.endsWith('…'), true);
  } finally { await mock.close(); }
});

test('调试开关：forceFallback 直接回落，且**根本不发请求**', async () => {
  const state = {};
  const mock = await startMock(standardHandler(state));
  try {
    const logs = [];
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, forceFallback: true }), onLog: (e) => logs.push(e) });
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(r.engine, 'rule');
    assert.equal(r.meta.fallbackReason, 'force-fallback');
    assert.equal(Object.keys(state.calls || {}).length, 0, '不该发出任何请求');
    assert.equal(logs[logs.length - 1].path, 'fallback');
  } finally { await mock.close(); }
});

test('未配置（没填 base_url / 没密钥）→ 直接回落且原因可解释', async () => {
  useEngine({ prefs: basePrefs({ baseUrl: '', model: 'ok' }) });
  const r1 = await llm.send(chat.makeRequest({ text: 'hi' }));
  assert.equal(r1.meta.fallbackReason, 'no-base-url');
  useEngine({ prefs: basePrefs({ baseUrl: 'https://api.example.com/v1', model: 'm' }), key: '' });
  assert.equal(llm.available(), false, '云端没密钥 = 不可用');
  const r2 = await llm.send(chat.makeRequest({ text: 'hi' }));
  assert.equal(r2.meta.fallbackReason, 'no-key');
});

test('本地服务允许不带密钥（Ollama 这类）', () => {
  useEngine({ prefs: basePrefs({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen' }), key: '' });
  assert.equal(llm.available(), true);
  useEngine({ prefs: basePrefs({ baseUrl: 'http://localhost:1234/v1', model: 'qwen' }), key: '' });
  assert.equal(llm.available(), true);
});

test('历史：多轮累积进 messages，historyTurns=0 时不带历史', async () => {
  const seen = [];
  const mock = await startMock((ctx) => { seen.push(ctx.body); standardHandler()(ctx); });
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'ok', historyTurns: 4 }) });
    await llm.send(chat.makeRequest({ text: '第一句' }));
    await llm.send(chat.makeRequest({ text: '第二句' }));
    const last = seen[seen.length - 1].messages;
    assert.equal(last[0].role, 'system');
    assert.equal(last[1].content, '第一句', '历史被带上');
    assert.equal(last[2].role, 'assistant');
    assert.equal(last[last.length - 1].content, '第二句');

    llm.resetHistory();
    llm.configure({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'ok', historyTurns: 0 }) });
    const seenBefore = seen.length;
    await llm.send(chat.makeRequest({ text: '第三句' }));
    const noHist = seen[seen.length - 1].messages;
    assert.equal(seen.length, seenBefore + 1);
    assert.equal(noHist.length, 2, 'system + 本轮输入（不带历史）');
  } finally { await mock.close(); }
});

/* ================= ⑤ 流式路径（能力必须与非流式对齐） ================= */

test('流式：打字机增量 + 最终文本 + 日志路径 = llm-stream', async () => {
  const mock = await startMock(standardHandler());
  try {
    const deltas = [];
    const logs = [];
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'stream', stream: true }), onDelta: (t) => deltas.push(t), onLog: (e) => logs.push(e) });
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(r.ok, true);
    assert.equal(r.reply, '你好呀');
    assert.ok(deltas.length >= 2, `应收到多次增量（实际 ${deltas.length}）`);
    assert.equal(deltas[deltas.length - 1], '你好呀', '最后一次增量=完整文本');
    assert.equal(r.meta.streamed, true);
    assert.equal(logs[logs.length - 1].path, 'llm-stream');
    assert.equal(logs[logs.length - 1].completionTokens, 3, '流式也要拿到 usage');
  } finally { await mock.close(); }
});

test('流式：SSE 帧被切成两半（跨分片）也能拼出完整文本', async () => {
  const mock = await startMock(standardHandler());
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'stream-split', stream: true }) });
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(r.reply, '你好呀');
  } finally { await mock.close(); }
});

test('★ 流式路径同样要能截断（容易只在非流式写对）', async () => {
  const mock = await startMock(standardHandler());
  try {
    // maxChars 的下限是 20（config 夹取），这里用下限值验证
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'stream-long', stream: true, maxChars: 20 }) });
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(r.reply.length, 21, '20 字 + 省略号');
    assert.equal(r.reply.endsWith('…'), true);
  } finally { await mock.close(); }
});

test('★ 流式路径同样要能超时（首块后卡住 → 空闲超时）→ 回落 timeout', async () => {
  const mock = await startMock(standardHandler());
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'stream-stall', stream: true, timeoutMs: 1000, retryMax: 2 }) });
    const r = await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(r.engine, 'rule');
    assert.equal(r.meta.fallbackReason, 'timeout');
  } finally { await mock.close(); }
});

test('★ 流式路径同样要能取消 → 回落 aborted', async () => {
  const mock = await startMock(standardHandler());
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'stream-stall', stream: true, timeoutMs: 5000 }) });
    const ctrl = new AbortController();
    const p = llm.send(chat.makeRequest({ text: 'hi', signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 150);
    const r = await p;
    assert.equal(r.meta.fallbackReason, 'aborted');
  } finally { await mock.close(); }
});

test('★ 流式路径同样要能回落（401 在流式下也要走兜底）', async () => {
  const mock = await startMock(standardHandler());
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: '401', stream: true }) });
    const r = await llm.send(chat.makeRequest({ text: 'hi', context: { chatRules: [{ keyword: 'hi', reply: '（规则）' }] } }));
    assert.equal(r.engine, 'rule');
    assert.equal(r.reply, '（规则）');
    assert.equal(r.meta.fallbackReason, 'auth');
  } finally { await mock.close(); }
});

/* ================= ⑥ probe（测试连接） ================= */

test('probe：成功 / 401 / 模型不存在 / 网络不可达 / base_url 非法 分类明确', async () => {
  const mock = await startMock(standardHandler());
  // 找一个"真的没人监听"的端口（先监听再关掉）——端口 1 属于 Fetch 规范禁用端口，测不出网络错误
  const probeSrv = http.createServer();
  await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r));
  const deadPort = probeSrv.address().port;
  await new Promise((r) => probeSrv.close(() => r()));
  try {
    const cases = [['ok', 'ok'], ['401', 'auth'], ['404model', 'model-not-found'], ['500', 'server']];
    for (const [model, want] of cases) {
      useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model }) });
      const r = await llm.probe();
      assert.equal(r.code, want, `probe(${model}) → ${want}（实际 ${r.code}）`);
      assert.equal(typeof r.elapsedMs, 'number');
    }
    // 网络不可达：端口没人监听
    useEngine({ prefs: basePrefs({ baseUrl: `http://127.0.0.1:${deadPort}/v1`, model: 'ok' }) });
    assert.equal((await llm.probe()).code, 'network');
    // base_url 非法（Fetch 禁用端口）→ 明确归为配置错误，而不是"未知"
    useEngine({ prefs: basePrefs({ baseUrl: 'http://127.0.0.1:1/v1', model: 'ok' }) });
    assert.equal((await llm.probe()).code, 'bad-url');
    // 没填 base_url / 没密钥
    useEngine({ prefs: basePrefs({ baseUrl: '' }) });
    assert.equal((await llm.probe()).code, 'no-base-url');
    useEngine({ prefs: basePrefs({ baseUrl: 'https://api.example.com/v1' }), key: '' });
    assert.equal((await llm.probe()).code, 'no-key');
  } finally { await mock.close(); }
});

test('probe：只发一次请求、不写历史、不重试', async () => {
  const state = {};
  const mock = await startMock(standardHandler(state));
  try {
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: '429', retryMax: 2, retryBaseMs: 10 }) });
    const r = await llm.probe();
    assert.equal(r.code, 'rate-limit');
    assert.equal(state.calls['429'], 1, '测试连接不做退避重试');
    assert.equal(llm.historyLength(), 0, '测试连接不污染会话历史');
  } finally { await mock.close(); }
});

/* ================= ⑦ 日志与脱敏 ================= */

test('日志：每次请求都上报耗时/状态码/tokens/路径；失败也上报', async () => {
  const mock = await startMock(standardHandler());
  try {
    const logs = [];
    useEngine({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: 'ok' }), onLog: (e) => logs.push(e) });
    await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(logs.length, 1);
    const e = logs[0];
    for (const k of ['ts', 'kind', 'path', 'ok', 'httpStatus', 'attempts', 'elapsedMs', 'model', 'replyChars']) {
      assert.ok(k in e, `日志需要 ${k}`);
    }
    assert.equal(e.httpStatus, 200);
    assert.equal(e.replyChars, 3);
    assert.equal(e.promptTokens, 11);

    llm.configure({ prefs: basePrefs({ baseUrl: mock.baseUrl, model: '401' }) });
    await llm.send(chat.makeRequest({ text: 'hi' }));
    assert.equal(logs[logs.length - 1].path, 'fallback');
    assert.equal(logs[logs.length - 1].code, 'auth');
    assert.equal(logs[logs.length - 1].httpStatus, 401);
  } finally { await mock.close(); }
});

test('脱敏：错误信息里的密钥被打码（防御第三方回显密钥）', () => {
  const key = 'sk-abcdefghijklmn';
  assert.equal(llm.sanitizeText(`Invalid key ${key}`, key).includes(key), false);
  assert.equal(llm.sanitizeText('Authorization: Bearer sk-1234567890abcdef', '').includes('1234567890'), false);
  assert.equal(llm.pickErrorMessage(JSON.stringify({ error: { message: `bad ${key}` } }), key).includes(key), false);
});
