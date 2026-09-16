'use strict';
/** 聊天设置窗口：维护“关键词 → 回复”规则（添加/删除），持久化到 settings.json。
 *  另含「回复引擎」选择——引擎可扩展（rule = 现有关键词规则；llm = 预留，未实现）。
 *  引擎不可用时由主进程的 selectEngine 自动回落 rule，这里只负责展示与切换。 */
const { ipcRenderer } = require('electron');

const listEl = document.getElementById('list');
const kwEl = document.getElementById('keyword');
const rpEl = document.getElementById('reply');
const engineEl = document.getElementById('engine');
const engineTipEl = document.getElementById('engineTip');
let rules = [];

function render() {
  listEl.textContent = '';
  if (!rules.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '还没有规则。添加一条，桌宠就会说话了！';
    listEl.appendChild(d);
  }
  for (const r of rules) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.keyword = r.keyword;

    const kw = document.createElement('div');
    kw.className = 'kw'; kw.textContent = r.keyword;
    const rp = document.createElement('div');
    rp.className = 'rp'; rp.textContent = r.reply;
    const del = document.createElement('button');
    del.className = 'delBtn'; del.title = '删除这条规则'; del.textContent = '✕';

    row.append(kw, rp, del);
    listEl.appendChild(row);
  }
}

listEl.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('delBtn')) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const res = await ipcRenderer.invoke('chatRules:remove', row.dataset.keyword);
  if (res && res.ok) { rules = res.rules; render(); }
});

async function add() {
  const res = await ipcRenderer.invoke('chatRules:add', { keyword: kwEl.value, reply: rpEl.value });
  if (res && res.ok) {
    rules = res.rules;
    kwEl.value = ''; rpEl.value = '';
    render();
  }
  kwEl.focus();
}

document.getElementById('addBtn').addEventListener('click', add);
kwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') rpEl.focus(); });
rpEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

ipcRenderer.on('chatRules:changed', (_e, { rules: r }) => { rules = r; render(); });

(async () => {
  rules = await ipcRenderer.invoke('chatRules:load');
  render();
})();

/* ================= 回复引擎（ChatEngine 注册表） ================= */

const ENGINE_TIP = {
  rule: '离线关键词规则：输入里包含某个关键词就按对应回复说话。默认。',
  llm: '大模型：OpenAI 兼容接口（DeepSeek / OpenAI / 本地 Ollama 都能接）。密钥存在本机加密文件里；'
    + '调用失败会**自动回落到关键词规则**，不会让桌宠不说话。',
};

async function renderEngines() {
  let info = null;
  try { info = await ipcRenderer.invoke('chatEngine:list'); } catch { return; }
  if (!info || !Array.isArray(info.engines)) return;
  engineEl.textContent = '';
  for (const e of info.engines) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.available ? e.label : `${e.label} · 不可用`;
    engineEl.appendChild(o);
  }
  engineEl.value = info.active;
  engineTipEl.textContent = ENGINE_TIP[info.active] || '';
}

engineEl.addEventListener('change', async () => {
  const id = engineEl.value;
  try {
    const res = await ipcRenderer.invoke('chatEngine:set', id);
    if (res && res.ok) {
      engineEl.value = res.active;
      engineTipEl.textContent = ENGINE_TIP[res.active] || '';
      renderEngines();
    }
  } catch { /* 切不了就保持原样 */ }
});

renderEngines();

/* ================= 大模型（LLM）：密钥 / 偏好 / 连通性 / 请求日志 =================
 * 安全约定：本窗口只负责"收集用户输入"和"显示状态"——
 *   · 密钥通过 IPC 交给主进程写进**本机独立密钥文件**（默认 `~/.deskpet/llm.key`，
 *     明文，**刻意放在桌宠便携目录之外**：拷走整个桌宠文件夹不会带走密钥），
 *     渲染层不留明文（输入框用完即清）；
 *   · 状态查询只回"有没有配置 + 文件在哪"，从不回密钥内容（主进程 llmStatus() 保证）。 */

const L = {
  provider: document.getElementById('llmProvider'),
  baseUrl: document.getElementById('llmBaseUrl'),
  model: document.getElementById('llmModel'),
  key: document.getElementById('llmKey'),
  keySave: document.getElementById('llmKeySave'),
  keyClear: document.getElementById('llmKeyClear'),
  keyReveal: document.getElementById('llmKeyReveal'),
  keyStatus: document.getElementById('llmKeyStatus'),
  persona: document.getElementById('llmPersona'),
  temp: document.getElementById('llmTemp'),
  maxChars: document.getElementById('llmMaxChars'),
  timeout: document.getElementById('llmTimeout'),
  history: document.getElementById('llmHistory'),
  retry: document.getElementById('llmRetry'),
  stream: document.getElementById('llmStream'),
  forceFallback: document.getElementById('llmForceFallback'),
  save: document.getElementById('llmSave'),
  test: document.getElementById('llmTest'),
  testResult: document.getElementById('llmTestResult'),
  keyPath: document.getElementById('llmKeyPath'),
  logs: document.getElementById('llmLogs'),
  logClear: document.getElementById('llmLogClear'),
};

let llmPresets = [];
let llmLogs = [];

/** 填充表单（只在 refresh / 保存成功后调用，避免打断用户正在输入的内容） */
function fillLlmForm(prefs, presets) {
  llmPresets = Array.isArray(presets) ? presets : [];
  if (!L.provider.options.length) {
    for (const p of llmPresets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label || p.id;
      L.provider.appendChild(o);
    }
  }
  L.provider.value = prefs.provider;
  L.baseUrl.value = prefs.baseUrl || '';
  L.model.value = prefs.model || '';
  L.persona.value = prefs.systemPrompt || '';
  L.temp.value = String(prefs.temperature);
  L.maxChars.value = String(prefs.maxChars);
  L.timeout.value = String(prefs.timeoutMs);
  L.history.value = String(prefs.historyTurns);
  L.retry.value = String(prefs.retryMax);
  L.stream.checked = !!prefs.stream;
  L.forceFallback.checked = !!prefs.forceFallback;
}

/** 表单 → 偏好对象（主进程还会再白名单 + 夹取一次，这里只是尽力给对） */
function readLlmForm() {
  return {
    provider: L.provider.value,
    baseUrl: L.baseUrl.value,
    model: L.model.value,
    systemPrompt: L.persona.value,
    temperature: Number(L.temp.value),
    maxChars: Number(L.maxChars.value),
    timeoutMs: Number(L.timeout.value),
    historyTurns: Number(L.history.value),
    retryMax: Number(L.retry.value),
    stream: L.stream.checked,
    forceFallback: L.forceFallback.checked,
  };
}

function renderKeyStatus(key) {
  if (!key) { L.keyStatus.textContent = ''; return; }
  const bits = [];
  if (key.source === 'file') bits.push('密钥：已保存到本机密钥文件');
  else bits.push('密钥：未设置');
  if (key.envSet) bits.push(`环境变量 ${key.envName} 已设置（可作后备）`);
  // 文件在、但解析不出密钥 → 多半是用户手工改坏了（我们提示去改回来，而不是让他猜）
  if (key.error === 'empty-file') bits.push('⚠ 密钥文件里没有有效内容（可能被手工改坏了），请重新保存一次');
  if (key.error === 'io') bits.push('⚠ 密钥文件读取失败（检查文件权限）');
  // 不该发生：路径落到便携目录里就等于"拷走文件夹 = 送走密钥"。真出现就明确报警。
  if (key.path && key.outsidePortable === false) bits.push('⚠ 密钥文件位于桌宠程序目录内，会随文件夹一起被拷走！请改 config 的 keyFile');
  L.keyStatus.textContent = bits.join('　');
  // 路径直接展示（这是明文文件，用户可以自己拿记事本改）
  L.keyPath.textContent = key.path
    ? `${key.stored ? '已保存到' : '保存后将写入'}：${key.path}${key.outsidePortable === false ? '（⚠ 在程序目录内）' : '（在程序目录之外，不随文件夹拷走）'}`
    : '';
}

const LOG_PATH_LABEL = { llm: '大模型', 'llm-stream': '大模型·流式', fallback: '回落', retry: '重试中' };

function renderLogs(list) {
  llmLogs = Array.isArray(list) ? list.slice(0, 50) : [];
  L.logs.textContent = '';
  if (!llmLogs.length) {
    const d = document.createElement('div');
    d.className = 'none';
    d.textContent = '还没有请求记录。';
    L.logs.appendChild(d);
    return;
  }
  for (const e of llmLogs) {
    const row = document.createElement('div');
    row.className = 'lg';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(e.ts).toTimeString().slice(0, 8);
    const p = document.createElement('span');
    p.className = `p ${e.path || ''}`;
    p.textContent = LOG_PATH_LABEL[e.path] || e.path || '-';
    const d = document.createElement('span');
    d.className = 'd';
    const bits = [];
    if (e.httpStatus) bits.push(`HTTP ${e.httpStatus}`);
    if (e.elapsedMs != null) bits.push(`${e.elapsedMs}ms`);
    if (e.attempts > 1) bits.push(`尝试${e.attempts}次`);
    if (e.promptTokens || e.completionTokens) bits.push(`tok ${e.promptTokens || 0}/${e.completionTokens || 0}`);
    if (e.replyChars) bits.push(`${e.replyChars}字`);
    if (e.truncated) bits.push('已截断');
    if (e.code) bits.push(e.code);
    if (e.note) bits.push(e.note);
    if (e.detail) bits.push(String(e.detail).slice(0, 40));
    d.textContent = bits.join(' · ');
    d.title = d.textContent;
    row.append(t, p, d);
    L.logs.appendChild(row);
  }
}

const TEST_HINT = {
  ok: '连接成功',
  'no-key': '还没有保存密钥',
  'no-base-url': '请先填 base_url',
  'no-model': '请先填模型名',
  auth: '密钥无效或无权限（401）—— 检查密钥是否复制完整',
  'not-found': '接口地址不对（404）—— base_url 通常要带 /v1',
  'model-not-found': '模型名不存在 —— 检查拼写或账号权限',
  'rate-limit': '触发限流（429）—— 稍等再试',
  server: '服务端错误（5xx）—— 服务商侧问题，稍后再试',
  network: '网络不可达 —— 检查网络/域名/端口（本地服务确认已启动）',
  'bad-url': 'base_url 不合法 —— 检查协议与端口（如 127.0.0.1:1 这类端口被浏览器规范禁用）',
  timeout: '请求超时 —— 可把「超时(ms)」调大',
  'bad-response': '响应无法解析 —— 对方可能不是 OpenAI 兼容接口',
  aborted: '已取消',
};

function showTestResult(r) {
  const ok = !!(r && r.ok);
  L.testResult.className = ok ? 'ok' : 'err';
  if (!r) { L.testResult.textContent = ''; return; }
  const detail = r.detail ? `（${String(r.detail).slice(0, 80)}）` : '';
  L.testResult.textContent = `${TEST_HINT[r.code] || r.code}　HTTP ${r.httpStatus || '-'}　${r.elapsedMs}ms${detail}`;
}

async function refreshLlm() {
  let s = null;
  try { s = await ipcRenderer.invoke('llm:status'); } catch { return; }
  if (!s) return;
  fillLlmForm(s.prefs, s.presets);
  renderKeyStatus(s.key);
  renderLogs(s.logs);
  if (s.active === 'llm' && !s.llmAvailable && s.unavailableReason) {
    L.testResult.className = 'err';
    L.testResult.textContent = `当前不可用：${TEST_HINT[s.unavailableReason] || s.unavailableReason}`;
  }
}

// 选服务商 → 带出预设的 base_url / 模型名（自定义留空则不覆盖）
L.provider.addEventListener('change', () => {
  const p = llmPresets.find((x) => x.id === L.provider.value);
  if (!p) return;
  if (p.baseUrl) L.baseUrl.value = p.baseUrl;
  if (p.model) L.model.value = p.model;
});

L.keySave.addEventListener('click', async () => {
  const key = String(L.key.value || '').trim();
  if (!key) { L.testResult.className = 'err'; L.testResult.textContent = '请先粘贴密钥。'; return; }
  let r = null;
  try { r = await ipcRenderer.invoke('llm:key:set', key); } catch { /* 主进程异常 */ }
  L.key.value = '';   // ★ 输入框不留明文
  if (!r) { L.testResult.className = 'err'; L.testResult.textContent = '保存失败（主进程无响应）'; return; }
  if (r.ok) {
    L.testResult.className = 'ok';
    L.testResult.textContent = `密钥已保存到本机密钥文件（不在 settings.json 里）：${(r.status && r.status.key.path) || ''}`;
  } else if (r.code === 'io') {
    L.testResult.className = 'err';
    L.testResult.textContent = '密钥文件写入失败（检查磁盘/权限）。';
  } else {
    L.testResult.className = 'err';
    L.testResult.textContent = `保存失败：${r.code}`;
  }
  if (r.status) { renderKeyStatus(r.status.key); renderLogs(r.status.logs); }
  await renderEngines();
});

// 「打开密钥文件位置」：把他的密钥文件（或目录）在资源管理器里打开 —— 明文文件，允许用户自己改
L.keyReveal.addEventListener('click', async () => {
  let r = null;
  try { r = await ipcRenderer.invoke('llm:key:reveal'); } catch { /* 忽略 */ }
  if (r && r.ok) {
    L.testResult.className = '';
    L.testResult.textContent = r.code === 'revealed' ? '已在资源管理器中选中密钥文件。' : '已打开密钥文件所在目录（还没有密钥文件，保存后才会生成）。';
  } else {
    L.testResult.className = 'err';
    L.testResult.textContent = `打不开：${(r && (r.code + ' ' + (r.detail || ''))) || '主进程无响应'}`;
  }
});

L.keyClear.addEventListener('click', async () => {
  let r = null;
  try { r = await ipcRenderer.invoke('llm:key:clear'); } catch { /* 忽略 */ }
  L.testResult.className = '';
  L.testResult.textContent = r && r.ok ? '已清除本机保存的密钥。' : '清除失败';
  if (r && r.status) renderKeyStatus(r.status.key);
  await renderEngines();
});

L.save.addEventListener('click', async () => {
  let s = null;
  try { s = await ipcRenderer.invoke('llm:prefs:save', readLlmForm()); } catch { /* 忽略 */ }
  if (!s) { L.testResult.className = 'err'; L.testResult.textContent = '保存失败（主进程无响应）'; return; }
  fillLlmForm(s.prefs, s.presets);
  renderKeyStatus(s.key);
  L.testResult.className = 'ok';
  L.testResult.textContent = '设置已保存。';
  await renderEngines();   // 可用性可能变了（引擎下拉里的"不可用"标记）
});

L.test.addEventListener('click', async () => {
  L.test.disabled = true;
  L.testResult.className = '';
  L.testResult.textContent = '正在测试…';
  let r = null;
  try { r = await ipcRenderer.invoke('llm:test'); } catch { /* 忽略 */ }
  L.test.disabled = false;
  if (!r || !r.result) { L.testResult.className = 'err'; L.testResult.textContent = '测试失败（主进程无响应）'; return; }
  showTestResult(r.result);
  if (r.status) renderKeyStatus(r.status.key);
});

L.logClear.addEventListener('click', async () => {
  try { await ipcRenderer.invoke('llm:log:clear'); } catch { /* 忽略 */ }
  renderLogs([]);
});

// 主进程每完成一次请求就推一条 → 面板实时更新（不需要轮询）
ipcRenderer.on('llm:log:appended', (_e, entry) => {
  if (!entry) return;
  renderLogs([entry, ...llmLogs].slice(0, 50));
});

/* ================= 聊天记录（独立 json，在便携目录之外） =================
 * 记录由主进程持有与写入，这里只做两件事：显示"存了多少条、存在哪" + 清空。
 * 清空做成**两步确认**（按钮自己变成"确定清空？"）而不是弹原生对话框：
 * 原生 confirm 会阻塞渲染进程，UI 自动化场景里点了就会卡住。 */
const logStatusEl = document.getElementById('logStatus');
const logClearBtn = document.getElementById('logClear');
let logClearArmed = 0;

async function refreshLogStatus() {
  let st = null;
  try { st = await ipcRenderer.invoke('chat:history:status'); } catch { /* 忽略 */ }
  if (!st) { logStatusEl.textContent = '（读取不到聊天记录状态）'; return; }
  logStatusEl.textContent = st.count
    ? `已保存 ${st.count} 条（上限 ${st.max}）　位置：${st.path}`
    : `还没有聊天记录　保存位置：${st.path}`;
}

function disarmLogClear() {
  if (logClearArmed) { clearTimeout(logClearArmed); logClearArmed = 0; }
  logClearBtn.textContent = '清空聊天记录';
}

logClearBtn.addEventListener('click', async () => {
  if (!logClearArmed) {   // 第一次点：只是"举手"
    logClearBtn.textContent = '确定清空？（3 秒内再点一次）';
    logClearArmed = setTimeout(disarmLogClear, 3000);
    return;
  }
  disarmLogClear();
  let r = null;
  try { r = await ipcRenderer.invoke('chat:history:clear'); } catch { /* 忽略 */ }
  await refreshLogStatus();
  logStatusEl.textContent = r && r.ok
    ? `已清空。${logStatusEl.textContent}`
    : '清空失败（可能是文件被占用/无权限）';
});

refreshLogStatus();

refreshLlm();
