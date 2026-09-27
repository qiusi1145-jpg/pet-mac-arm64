'use strict';
/**
 * LLM 端到端自检（`npm run llm:e2e` = `electron . --llm-e2e`）——**开发/验收专用**（与 `--voice-e2e` 同套路）。
 *
 * 为什么需要它：单测能覆盖纯函数与引擎逻辑，但**"密钥真的落在便携目录之外了""重启后真的还能用"**
 * 这类事情只有把**真实的 PetApp（含真实路径解析与文件 IO）**跑起来才能证明。
 *
 * 它自己起一个**进程内 mock LLM 服务**（127.0.0.1 随机端口）：不碰外网、不需要真密钥，
 * 而且能把 401 / 404 / 429 / 5xx / 超时 / 流式 / 慢流 这些"平时很难造"的场景全都造出来。
 *
 * 两阶段（用 `PET_LLM_E2E_PHASE` 控制），阶段 2 就是"重启应用"：
 *   1 = 路径解析 → 写偏好 → 存密钥（含"换电脑自动建目录"）→ 连通性分类 → 聊天/截断/回落/取消/流式
 *   2 = 复用同一 userData + 同一密钥文件再启动一次 → 断言"密钥还在、且真的能用"（mock 会校验 Authorization）
 *
 * ⚠ 密钥路径由调用方用 `PET_LLM_KEY_FILE` 指到临时目录（否则 main.js 有安全兜底自动隔离），
 *    **绝不能让自检把测试密钥写进用户真实的 `~/.deskpet/llm.key`**。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { LlmSecret, isInsideDir } = require('./llmSecret');

/** 收集结果并打印（供 harness 抓 stdout 判定）。 */
function makeReporter(tag) {
  const rows = [];
  return {
    rows,
    ok(name, info) { rows.push({ name, ok: true, info }); console.log(`[llm-e2e] ✓ ${name}${info ? '  ' + info : ''}`); },
    bad(name, info) { rows.push({ name, ok: false, info }); console.log(`[llm-e2e] ✗ ${name}${info ? '  ' + info : ''}`); },
    expect(name, cond, info) { (cond ? this.ok : this.bad).call(this, name, info); return !!cond; },
    summary() {
      const bad = rows.filter((r) => !r.ok);
      console.log(`[llm-e2e] ${tag}: ${rows.length - bad.length}/${rows.length} 项通过`);
      if (bad.length) console.log('[llm-e2e] 失败项：' + bad.map((r) => r.name).join(' / '));
      return bad.length === 0;
    },
  };
}

/** 失败时把结果压成一行，方便一眼看出到底走了哪条路。 */
function short(r) {
  if (!r || typeof r !== 'object') return String(r);
  const m = r.meta || {};
  return `engine=${r.engine} ok=${r.ok} matched=${r.matched} reply=${JSON.stringify(String(r.reply).slice(0, 40))}`
    + ` reason=${m.fallbackReason} http=${m.httpStatus} attempts=${m.attempts} streamed=${m.streamed}`;
}

/** 造一个可控的 OpenAI 兼容 mock 服务：靠 body.model 选择行为。 */
function startMockServer(expectedKey) {
  const stats = { calls: {}, attempts: {} };
  const bump = (m) => { stats.calls[m] = (stats.calls[m] || 0) + 1; return stats.calls[m]; };
  const json = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const openaiError = (res, status, message, type) =>
    json(res, status, { error: { message, type: type || 'invalid_request_error', code: status } });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
      const model = String(body.model || '');
      const auth = String(req.headers.authorization || '');
      const url = String(req.url || '');

      // 路径错的场景（验证"地址错"分类）：任何非标准路径都当 404
      if (!url.startsWith('/v1/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>404 Not Found</body></html>');
        return;
      }
      // 密钥校验（阶段 2 靠它证明"重启后密钥文件里的密钥真的被取回来了"）
      if (expectedKey && auth !== `Bearer ${expectedKey}`) {
        bump('unauthorized');
        openaiError(res, 401, 'Authentication Fails, Your api key is invalid', 'authentication_error');
        return;
      }
      bump(model);

      if (model === 'mock-401') { openaiError(res, 401, 'Invalid API key', 'authentication_error'); return; }
      if (model === 'mock-404-model') { openaiError(res, 404, 'The model `mock-404-model` does not exist', 'invalid_request_error'); return; }
      if (model === 'mock-500') { openaiError(res, 500, 'Internal server error', 'server_error'); return; }
      if (model === 'mock-429') { openaiError(res, 429, 'Rate limit reached', 'rate_limit_error'); return; }
      if (model === 'mock-429-then-ok') {
        const n = stats.attempts[model] = (stats.attempts[model] || 0) + 1;
        if (n <= 2) { openaiError(res, 429, `Rate limit reached (attempt ${n})`, 'rate_limit_error'); return; }
        json(res, 200, { model, choices: [{ message: { role: 'assistant', content: '（重试后成功）' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } });
        return;
      }
      if (model === 'mock-slow') { /* 一直不回：测超时（15s 兜底收尾，避免句柄泄漏） */
        setTimeout(() => { try { json(res, 500, { error: { message: 'mock-slow finally gave up' } }); } catch { /* 已关闭 */ } }, 15000);
        return;
      }
      if (model === 'mock-long') {
        const content = '很长的回复'.repeat(120);   // 480 字：用来验证截断
        json(res, 200, { model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 300 } });
        return;
      }
      if (model === 'mock-ok') {
        json(res, 200, { model, choices: [{ message: { role: 'assistant', content: '（mock 回复）你好呀，我在呢' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } });
        return;
      }

      // ---- 流式 ----
      // 注意 mock-stream-slow 必须**多于 1 帧**，否则"写完第一帧就结束"就不是慢流了
      const streamModels = { 'mock-stream': 3, 'mock-stream-long': 40, 'mock-stream-slow': 5 };
      if (model in streamModels) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const parts = model === 'mock-stream-long'
          ? Array.from({ length: streamModels[model] }, (_, i) => `第${i}段`)
          : Array.from({ length: streamModels[model] }, (_, i) => `片段${i + 1}`);
        let i = 0;
        const push = () => {
          if (i < parts.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }] })}\n\n`);
            i++;
            if (i < parts.length) setTimeout(push, model === 'mock-stream-slow' ? 6000 : 30);
            else {
              res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }
        };
        push();
        return;
      }

      openaiError(res, 400, `mock 不认识模型 ${model}`, 'invalid_request_error');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, baseUrl: `http://127.0.0.1:${port}/v1`, stats, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** 主入口：传入已 init 的真实 PetApp。 */
async function runLlmE2e(app) {
  const phase = String(process.env.PET_LLM_E2E_PHASE || '1');
  // 内置 mock 服务不校验密钥内容，所以自检**不需要真密钥**（README 的口径）：给一个固定假值，
  // 否则 expectedKey 为空串 → llmSecret.set('') 返回 code=empty → "保存密钥/已配置密钥"两项必红。
  const expectedKey = String(process.env.PET_LLM_E2E_KEY || 'sk-e2e-local-mock-key-0123456789');
  const log = (...a) => console.log('[llm-e2e]', ...a);
  const mock = await startMockServer(expectedKey);
  log(`mock 服务已起：${mock.baseUrl}（phase=${phase}）`);
  const rep = makeReporter(`phase ${phase}`);
  const llmMod = require('../shared/chat/llm');   // 直连引擎模块（只看会话历史等内部状态）

  const prefsBase = {
    provider: 'custom', baseUrl: mock.baseUrl, model: 'mock-ok',
    systemPrompt: '你是测试用桌宠。', temperature: 0.5, maxChars: 120,
    historyTurns: 4, historyMaxChars: 1000, timeoutMs: 10000, retryMax: 2, retryBaseMs: 20,
    stream: false, forceFallback: false,
  };
  const send = async (patch, text) => {
    app.setLlmPrefs({ ...prefsBase, ...patch });
    return app.chatSend(text || '你好');
  };
  const lastLog = () => app.llmLog[0] || {};

  try {
    if (phase === '2') {
      // ===== 阶段 2：模拟"重启应用"（同一 userData + 同一密钥文件） =====
      const st = app.llmStatus();
      rep.expect('重启后密钥仍在（source=file）', st.key.stored === true && st.key.source === 'file',
        `source=${st.key.source} stored=${st.key.stored} path=${st.key.path}`);
      rep.expect('密钥文件仍在便携目录之外（不会跟着文件夹被拷走）', st.key.outsidePortable === true,
        `portable=${app.userDataRoot} key=${st.key.path}`);
      app.setLlmPrefs({ ...prefsBase, model: 'mock-ok' });
      const t = await app.llmTest();
      // mock 会校验 Authorization：只有真的从密钥文件取回密钥才可能成功
      rep.expect('重启后用密钥文件里的密钥连通成功', t.ok === true && t.code === 'ok', `code=${t.code} http=${t.httpStatus} ${t.detail}`);
      rep.expect('便携目录里搜不到明文密钥（settings.json 等）', !plaintextLeak(app, expectedKey), '递归扫描便携目录');

      // 额外：用户用记事本手工改密钥文件也要生效（这是"明文文件"带来的能力）
      const handPath = app.llmKeyFile;
      fs.writeFileSync(handPath, `# 用户手工改的\nKEY="${expectedKey}"\n`, 'utf8');
      const hand = new LlmSecret({ file: handPath });
      rep.expect('手工编辑密钥文件（KEY="…" 形式）也能被正确读出', hand.get() === expectedKey,
        `读回长度=${hand.get().length}`);
      return finish();
    }

    // ===== 阶段 1 =====
    // ① 密钥：独立明文文件 → **必须在便携目录之外** → 目录不存在时保存要能自动创建
    const keyPath = app.llmKeyFile;
    rep.expect('密钥路径已解析，且在便携目录之外', !!keyPath && !isInsideDir(app.userDataRoot, keyPath),
      `path=${keyPath} portable=${app.userDataRoot}`);
    app.llmSecret.clear();
    const set1 = app.llmSecret.set(expectedKey);
    rep.expect('保存密钥 → 写入独立文件', set1.ok === true && set1.code === 'stored' && fs.existsSync(keyPath),
      `code=${set1.code} path=${keyPath}`);
    const keyRaw = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : '';
    rep.expect('文件内容里确实是明文密钥（可用记事本直接改）', keyRaw.includes(expectedKey), `${keyRaw.length} 字节`);
    rep.expect('新建实例（= 重启应用）能读回密钥', new LlmSecret({ file: keyPath }).get() === expectedKey, '');
    rep.expect('便携目录里搜不到明文密钥（settings.json / debug.log / voice…）', !plaintextLeak(app, expectedKey), '递归扫描便携目录');
    rep.expect('引擎状态：已配置密钥', app.llmStatus().key.configured === true, `source=${app.llmStatus().key.source}`);

    // ①-b 「换电脑」场景：目标目录根本不存在 → 保存时自动建出整条路径（用户不需要手工建目录）
    const freshDir = path.join(path.dirname(keyPath), `fresh-${Date.now()}`);
    const freshFile = path.join(freshDir, 'sub', 'llm.key');
    rep.expect('换电脑场景：目标目录起初不存在', !fs.existsSync(freshDir), freshDir);
    const fresh = new LlmSecret({ file: freshFile });
    const setFresh = fresh.set('sk-fresh-on-new-pc');
    rep.expect('换电脑场景：保存即自动创建整条路径', setFresh.ok === true && fs.existsSync(freshFile), `code=${setFresh.code}`);
    rep.expect('换电脑场景：新路径立即可读回', new LlmSecret({ file: freshFile }).get() === 'sk-fresh-on-new-pc', '');
    try { fs.rmSync(freshDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

    // ② 连通性分类（需求：成功 / 401 / 404 地址错 / 模型不存在 / 网络不可达 要分得清）
    const cases = [
      ['mock-ok', 'ok', '正常连通'],
      ['mock-401', 'auth', '密钥错'],
      ['mock-404-model', 'model-not-found', '模型不存在'],
      ['mock-500', 'server', '服务端错误'],
    ];
    for (const [model, want, label] of cases) {
      app.setLlmPrefs({ ...prefsBase, model });
      const r = await app.llmTest();
      rep.expect(`测试连接分类：${label} → ${want}`, r.code === want, `code=${r.code} http=${r.httpStatus} ${String(r.detail).slice(0, 40)}`);
    }
    app.setLlmPrefs({ ...prefsBase, baseUrl: `http://127.0.0.1:${mock.port}/bad`, model: 'mock-ok' });
    const bad404 = await app.llmTest();
    rep.expect('测试连接分类：地址错（404 路径错）→ not-found', bad404.code === 'not-found', `code=${bad404.code}`);
    // 网络不可达：先占一个端口再放掉，保证"真的没人监听"（端口 1 属于 Fetch 禁用端口，测不出网络错误）
    const deadPort = await findClosedPort();
    app.setLlmPrefs({ ...prefsBase, baseUrl: `http://127.0.0.1:${deadPort}/v1`, model: 'mock-ok' });
    const offline = await app.llmTest();
    rep.expect('测试连接分类：网络不可达 → network', offline.code === 'network', `code=${offline.code} port=${deadPort}`);
    app.setLlmPrefs({ ...prefsBase, baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-ok' });
    const badUrl = await app.llmTest();
    rep.expect('测试连接分类：base_url 非法 → bad-url', badUrl.code === 'bad-url', `code=${badUrl.code}`);
    // 超时（3 秒，正式需求"我要用 3s 测"）
    app.setLlmPrefs({ ...prefsBase, model: 'mock-slow', timeoutMs: 3000 });
    const t0 = Date.now();
    const to = await app.llmTest();
    const dt = Date.now() - t0;
    rep.expect('测试连接分类：超时（timeoutMs=3000）', to.code === 'timeout' && dt >= 2500 && dt < 8000, `code=${to.code} 耗时=${dt}ms`);

    // ③ 切到 llm 引擎（不切的话聊天走的是 rule —— 这是最容易漏的一步）
    const sw = app.setChatEngine('llm');
    rep.expect('切换当前引擎到 llm', sw.active === 'llm', `active=${sw.active}`);

    // ③ 正常对话（非流式）
    const r1 = await send({}, '你好');
    rep.expect('非流式：LLM 出字', !!r1.reply && r1.reply.includes('mock 回复'), `reply=${JSON.stringify(String(r1.reply).slice(0, 24))}`);
    rep.expect('非流式：日志路径 = llm', lastLog().path === 'llm' && lastLog().ok === true, `path=${lastLog().path} http=${lastLog().httpStatus} tokens=${lastLog().completionTokens} 耗时=${lastLog().elapsedMs}ms`);

    // ④ 人设 + 上下文真的进了请求（用 mock 回显？→ 用「响应里是否报错」不好判断）
    //    改为直接断言 prompt 组装函数（单测已覆盖），这里只断言 systemPrompt 被采用后仍有正常回复
    const r2 = await send({ systemPrompt: '你是一只猫娘桌宠。' }, '在吗');
    rep.expect('人设生效：请求仍正常返回', !!r2.reply, `engine=${r2.engine}`);

    // ⑤ 字数截断
    const r3 = await send({ model: 'mock-long', maxChars: 30 }, '说点长的');
    rep.expect('超长回复被截断到 maxChars', String(r3.reply).length <= 31 && String(r3.reply).endsWith('…'), `len=${String(r3.reply).length}`);

    // ⑥ 调试开关：强制回落
    const r4 = await send({ forceFallback: true }, '随便说');
    rep.expect('强制回落开关 → 走 rule 引擎', r4.engine === 'rule' && r4.meta && r4.meta.degradedFrom === 'llm' && r4.meta.fallbackReason === 'force-fallback', `engine=${r4.engine} reason=${r4.meta && r4.meta.fallbackReason}`);
    rep.expect('强制回落：日志路径 = fallback', lastLog().path === 'fallback', `path=${lastLog().path}`);

    // ⑦ 401 → 回落 rule 且有回复（"桌宠照常有反应"）
    app.chatRuleAdd({ keyword: '兜底测试', reply: '（规则兜底）我在。' });
    const r5 = await send({ model: 'mock-401' }, '兜底测试');
    rep.expect('401 失败 → 回落规则引擎并给出回复', r5.engine === 'rule' && r5.reply === '（规则兜底）我在。' && r5.meta.fallbackReason === 'auth', `reason=${r5.meta && r5.meta.fallbackReason} reply=${JSON.stringify(r5.reply)}`);

    // ⑧ 5xx → 指数退避重试后仍失败 → 回落；断言"确实重试了"
    const before = mock.stats.calls['mock-500'] || 0;
    const r6 = await send({ model: 'mock-500' }, '再试试');
    const tried = (mock.stats.calls['mock-500'] || 0) - before;
    rep.expect('5xx：按 retryMax=2 重试（共 3 次尝试）后回落', tried === 3 && r6.engine === 'rule', `实际尝试 ${tried} 次 reason=${r6.meta && r6.meta.fallbackReason}`);
    rep.expect('5xx：日志记录了 attempts=3', lastLog().attempts === 3, `attempts=${lastLog().attempts}`);

    // ⑨ 429 重试后成功（第一次 429 不该直接回落）
    app.setLlmPrefs({ ...prefsBase, model: 'mock-429-then-ok', retryBaseMs: 20 });
    const r7 = await app.chatSend('重试成功吗');
    rep.expect('429：退避重试后成功（不回落）', r7.engine === 'llm' && String(r7.reply).includes('重试后成功'), `engine=${r7.engine} reply=${JSON.stringify(String(r7.reply).slice(0, 20))}`);

    // ⑩ 超时 → 回落 + 明确原因
    const t1 = Date.now();
    const r8 = await send({ model: 'mock-slow', timeoutMs: 3000 }, '超时测试');
    const dt8 = Date.now() - t1;
    rep.expect('超时 → 回落 rule（reason=timeout）', r8.engine === 'rule' && r8.meta.fallbackReason === 'timeout', `reason=${r8.meta && r8.meta.fallbackReason} 耗时=${dt8}ms`);

    // ⑪ 取消：请求中途取消 → 立刻返回，不重试
    app.setLlmPrefs({ ...prefsBase, model: 'mock-stream-slow', stream: true, timeoutMs: 10000 });
    const p9 = app.chatSend('取消测试');
    setTimeout(() => app.abortLlmInflight('e2e-cancel'), 400);
    const r9 = await p9;
    rep.expect('取消：中途取消 → 回落 rule 且 reason=aborted', r9.engine === 'rule' && r9.meta.fallbackReason === 'aborted', short(r9));

    // ⑫ 流式：打字机增量 + 最终文本（直接包住 app.streamBubble 计数——
    //    注意不能用 llm.configure({onDelta}) 注入：setLlmPrefs 会调 configureLlm 把它覆盖回去）
    let deltas = 0;
    let lastDeltaLen = 0;
    const origStreamBubble = app.streamBubble.bind(app);
    app.streamBubble = (t) => { deltas++; lastDeltaLen = String(t).length; return origStreamBubble(t); };
    const r10 = await send({ model: 'mock-stream', stream: true }, '流式测试');
    app.streamBubble = origStreamBubble;
    rep.expect('流式：收到增量（打字机）', deltas >= 2 && lastDeltaLen > 0, `增量回调 ${deltas} 次，最后长度 ${lastDeltaLen}`);
    rep.expect('流式：最终文本完整', String(r10.reply).includes('片段1') && String(r10.reply).includes('片段3'), short(r10));
    rep.expect('流式：日志路径 = llm-stream', lastLog().path === 'llm-stream', `path=${lastLog().path}`);

    // ⑬ 流式路径同样要能截断
    const r11 = await send({ model: 'mock-stream-long', stream: true, maxChars: 50 }, '长流式');
    rep.expect('流式：超长同样被截断', String(r11.reply).length <= 51 && String(r11.reply).endsWith('…'), short(r11));

    // ⑭ 流式路径同样要能超时 → 回落
    const r12 = await send({ model: 'mock-stream-slow', stream: true, timeoutMs: 3000 }, '流式超时');
    rep.expect('流式：卡住也超时回落（reason=timeout）', r12.engine === 'rule' && r12.meta.fallbackReason === 'timeout', short(r12));

    // ⑮ 流式路径同样要能取消
    app.setLlmPrefs({ ...prefsBase, model: 'mock-stream-slow', stream: true, timeoutMs: 10000 });
    const p13 = app.chatSend('流式取消');
    setTimeout(() => app.abortLlmInflight('e2e-cancel-stream'), 400);
    const r13 = await p13;
    rep.expect('流式：中途取消同样生效（reason=aborted）', r13.engine === 'rule' && r13.meta.fallbackReason === 'aborted', short(r13));

    // ⑯ 历史：多轮之后 messages 里应带上历史（mock 断言不了，改看 history 长度）
    rep.expect('会话历史已累积（供多轮上下文）', llmMod.historyLength() > 0, `history=${llmMod.historyLength()} 条`);

    return finish();
  } catch (e) {
    console.log('[llm-e2e] 抛异常：', (e && e.stack) || e);
    rep.bad('自检过程抛出异常', (e && e.message) || String(e));
    return finish();
  }

  function finish() {
    const ok = rep.summary();
    console.log(ok ? `LLM_E2E_OK (phase ${phase})` : `LLM_E2E_FAIL (phase ${phase})`);
    mock.close().then(() => { /* 关掉 mock 再退出 */ });
    return ok ? 0 : 1;
  }
}

/** 找一个"刚放掉、确定没人监听"的端口（用于造"网络不可达"）。 */
function findClosedPort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 递归扫描**便携目录**里是否出现明文密钥 —— 这是本轮改动的核心不变量：
 * 密钥文件刻意放在便携目录之外，所以"拷贝整个桌宠文件夹"不该带走任何密钥痕迹。
 * 跳过 Chromium 缓存目录与 >1MB 的文件（那些是二进制，读进来没意义还慢）。
 */
const SKIP_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'blob_storage', 'Network', 'Session Storage', 'Local Storage', 'Shared Dictionary', 'SharedStorage']);

function plaintextLeak(app, key) {
  if (!key) return false;
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p, depth + 1);
        continue;
      }
      try {
        if (fs.statSync(p).size > 1024 * 1024) continue;      // 大文件（模型/缓存）跳过
        if (fs.readFileSync(p, 'utf8').includes(key)) hits.push(p);
      } catch { /* 读不了就当没有 */ }
    }
  };
  walk(app.userDataRoot, 0);
  if (hits.length) console.log('[llm-e2e] 明文密钥出现在：' + hits.join(' , '));
  return hits.length > 0;
}

module.exports = { runLlmE2e, startMockServer };
