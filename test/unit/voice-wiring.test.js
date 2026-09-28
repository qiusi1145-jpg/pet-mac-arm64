'use strict';
/**
 * 语音服务「启动接线」回归测试（L1：纯 Node + electron 桩；不建真窗口、不碰鼠标、不需要麦克风/模型）。
 *
 * 为什么必须有这个文件（2026-09-15）：
 *   用户报「重启应用后仍然显示语音引擎没准备好，请稍后再试」。
 *   真因是 `PetApp.init()` **从头到尾没有调用过 `startVoice()`** → `this.voice` 恒为 null
 *   → 所有语音 IPC 都走"优雅不可用"分支。功能代码全都在，就是**最后一公里没接线**。
 *
 *   这类 bug 有个讨厌的特点：现有两层测试都抓不到 ——
 *     · L1 纯函数单测：只测 shared/* 的计算，不碰启动流程；
 *     · `npm run voice:diag` 诊断：它自己 `new VoiceService()`，**绕过了主进程的启动接线**，
 *       于是"诊断全绿 + 应用永远用不了"可以同时成立（上一轮就是这么被骗过去的）。
 *   唯一能抓住它的办法：**把主进程真正 boot 一遍，再断言语音服务确实被拉起来了** —— 就是本文件。
 *
 * 覆盖点：
 *   ①启动接线：init() 后 this.voice 必须存在，且 asr:event 转发已注册（回归本次事故）
 *   ②模型层：有模型 → 建隐藏识别窗 + 下发 asr:init（payload 正确）；无模型 → 优雅隐藏（不建窗）
 *   ③就绪链路：渲染侧回 asr:ready → status().available=true → voice:start 放行
 *   ④自愈（重试机制）：未启动时 voice:status 自动补启；识别进程卡死/加载失败 → 受控重建
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'src', 'main', 'main.js');

/* ===================== electron 桩 ===================== */

/** 造一个"够用"的 BrowserWindow：记下构造参数、loadFile 目标、发出去的 IPC、注册的事件回调。 */
function makeWin(opts) {
  const sent = [];
  const handlers = {};
  const add = (bag, ev, fn) => { (bag[ev] = bag[ev] || []).push(fn); };
  const wc = {
    send: (ch, payload) => sent.push({ ch, payload }),
    executeJavaScript: async () => ({}),
    on: (ev, fn) => add(handlers, `wc:${ev}`, fn),
    once: (ev, fn) => add(handlers, `wc:${ev}`, fn),
    setWindowOpenHandler: () => {},
    getURL: () => 'file:///asr.html',
  };
  const target = {
    _opts: opts, _sent: sent, _handlers: handlers, _loaded: '',
    id: 1,
    webContents: wc,
    isDestroyed: () => !!target._destroyed,
    isVisible: () => true,
    loadFile: (p) => { target._loaded = String(p); },
    on: (ev, fn) => add(handlers, ev, fn),
    once: (ev, fn) => add(handlers, ev, fn),
    destroy: () => { target._destroyed = true; },
    getNativeWindowHandle: () => Buffer.alloc(8),
    // 触发本窗口注册过的事件（模拟 Electron 真实回调）
    emit: (ev, ...args) => { for (const fn of (handlers[ev] || [])) fn(...args); },
    emitWc: (ev, ...args) => { for (const fn of (handlers[`wc:${ev}`] || [])) fn(...args); },
  };
  // 其它成员（setIgnoreMouseEvents / moveTop / setBounds …）一律当作空实现
  return new Proxy(target, {
    get(t, prop) { return (prop in t) ? t[prop] : () => {}; },
  });
}

/** 装上 electron 桩并**全新 boot** 一次 main.js（清掉 src/* 的模块缓存，保证每次都是干净启动）。 */
function loadMainWithStub(userDataDir) {
  const fe = {
    app: {
      getAppPath: () => ROOT,
      getPath: (k) => (k === 'userData' ? userDataDir : path.join(userDataDir, 'appdata')),
      setPath: () => {},
      commandLine: { appendSwitch: () => {} },
      disableHardwareAcceleration: () => {},
      requestSingleInstanceLock: () => true,
      whenReady: () => new Promise(() => {}), // 永不 resolve：PetApp 由测试自己 new，避免自动启动
      on: () => {}, once: () => {}, quit: () => {}, exit: () => () => {},
      setAppUserModelId: () => {}, getVersion: () => '37.0.0',
    },
    BrowserWindow: function (opts) { const w = makeWin(opts); fe._windows.push(w); return w; },
    ipcMain: {
      handle: (ch, fn) => fe._handlers.set(ch, fn),
      on: (ch, fn) => fe._on.set(ch, fn),
      removeHandler: () => {}, removeAllListeners: () => {},
    },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
    Tray: function () { return { setToolTip() {}, on() {}, setContextMenu() {}, destroy() {} }; },
    Menu: { buildFromTemplate: () => ({ items: [], popup: () => {} }), setApplicationMenu: () => {} },
    nativeImage: { createFromBitmap: () => ({ resize: () => ({}), setTemplateImage: () => {} }) },
    globalShortcut: {
      // 记录"注册了哪个全局键 + 回调" —— 让测试能真的"按一下"（不必依赖真实键盘）
      register: (acc, fn) => { fe._shortcuts.push(acc); fe._shortcutHandlers[acc] = fn; return true; },
      unregister: (acc) => {
        fe._shortcuts = fe._shortcuts.filter((a) => a !== acc);
        delete fe._shortcutHandlers[acc];
      },
      unregisterAll: () => { fe._shortcuts = []; fe._shortcutHandlers = {}; },
    },
    session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
    _windows: [], _handlers: new Map(), _on: new Map(), _shortcuts: [], _shortcutHandlers: {},
  };
  const orig = Module._load;
  Module._load = function (req) { return req === 'electron' ? fe : orig.apply(this, arguments); };
  try {
    for (const k of Object.keys(require.cache)) {
      if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
    }
    return { main: require(MAIN), fe };
  } finally {
    Module._load = orig;
  }
}

/** 造一份"够真"的假模型，让 resolveModel 能通过（CTC 档：单文件 + tokens + bbpe）。 */
function writeFakeModel(userDataDir) {
  const { CFG } = require(path.join(ROOT, 'src', 'shared', 'config'));
  const entry = (CFG.voice.models || []).find((m) => m.kind === 'zipformer2Ctc')
    || (CFG.voice.models || [])[1];
  assert.ok(entry, 'config.voice.models 里应有一个 CTC 档位');
  const dir = path.join(userDataDir, 'voice', 'models', entry.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.int8.onnx'), 'fake-onnx');
  fs.writeFileSync(path.join(dir, 'tokens.txt'), '<blk> 0\n你 1\n');
  fs.writeFileSync(path.join(dir, 'bbpe.model'), 'fake-bpe');
  return entry;
}

/** boot 一个 PetApp：与语音接线无关的启动项（16ms 光标推送/定时器/编译枚举器）换成空实现。 */
async function boot({ withModel = false, settings = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-voice-wiring-'));
  if (settings) fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(settings), 'utf8');
  const modelEntry = withModel ? writeFakeModel(tmp) : null;
  const prevEnv = process.env.PET_USERDATA;
  process.env.PET_USERDATA = tmp;
  const { main, fe } = loadMainWithStub(tmp);
  process.env.PET_USERDATA = prevEnv;
  const p = new main.PetApp();
  p.winEnum = { ensure() {}, list: async () => [] };
  p.startCursorPush = () => {};
  p.startTodoChecker = () => {};
  p.scheduleReminder = () => {};
  p.scheduleEnglishReminder = () => {};
  await p.init();
  return {
    p, fe, tmp, modelEntry,
    asrWindows: () => fe._windows.filter((w) => String(w._loaded).endsWith('asr.html')),
    dispose() {
      try { p.voice && p.voice.shutdown(); } catch { /* 忽略 */ }
      try { p.store.flush(); } catch { /* 忽略 */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    },
  };
}

/* ===================== ① 启动接线（本次事故的回归测试） ===================== */

test('① 启动接线：init() 必须真的把语音服务拉起来（回归 startVoice 未被调用）', async () => {
  const ctx = await boot();
  try {
    assert.ok(ctx.p.voice, 'init() 之后 this.voice 必须存在 —— 为 null 就等于"语音永远用不了"');
    assert.ok(ctx.p.voice instanceof require(path.join(ROOT, 'src', 'main', 'voiceService')).VoiceService,
      'this.voice 应是 VoiceService 实例');
    assert.ok(ctx.fe._on.has('asr:event'),
      '必须注册 asr:event 转发（识别进程 → 主进程的唯一入口），否则 asr:ready 收不到 → 永远 not-ready');
  } finally { ctx.dispose(); }
});

test('①-b 重复调用 startVoice() 不应重复注册 asr:event（避免一份事件被分发多次）', async () => {
  const ctx = await boot();
  try {
    const before = ctx.fe._on.get('asr:event');
    ctx.p.startVoice();
    assert.equal(ctx.fe._on.get('asr:event'), before, 'asr:event 应保持同一个处理函数（幂等）');
    assert.ok(ctx.p.voice, '重复启动后仍然有语音服务');
  } finally { ctx.dispose(); }
});

/* ===================== ② 模型层：建窗 / 优雅隐藏 ===================== */

test('② 有模型：建**隐藏**识别窗并下发 asr:init（payload 指向真实模型路径）', async () => {
  const ctx = await boot({ withModel: true });
  try {
    assert.ok(ctx.p.voice, '有模型时语音服务必须存在');
    assert.equal(ctx.p.voice.available, true, '有模型 → available 应为 true');
    const wins = ctx.asrWindows();
    assert.equal(wins.length, 1, '应且只应建 1 个识别宿主窗');
    assert.equal(wins[0]._opts.show, false, '识别宿主窗必须隐藏（不出现在用户眼前）');
    assert.equal(wins[0]._opts.webPreferences.backgroundThrottling, false,
      '隐藏窗不能被节流，否则采集/推理停摆');

    wins[0].emitWc('did-finish-load');            // 模拟页面加载完成
    const init = wins[0]._sent.map((s) => s.ch).indexOf('asr:init');
    assert.ok(init >= 0, 'did-finish-load 后必须下发 asr:init');
    const payload = wins[0]._sent[init].payload;
    assert.equal(payload.sampleRate, 16000);
    assert.equal(payload.model.kind, 'zipformer2Ctc', 'CTC 档位要按 zipformer2Ctc 下发（不是 transducer 三件套）');
    assert.ok(fs.existsSync(payload.model.tokens), 'tokens 路径必须真实存在');
    assert.ok(payload.model.single && fs.existsSync(payload.model.single), '单文件模型路径必须真实存在');
    assert.ok(payload.model.bpeVocab, 'CTC 必须带 BPE 词表，否则认不出字');
    assert.equal(ctx.p.voice.fallbackFrom, require(path.join(ROOT, 'src', 'shared', 'config')).CFG.voice.model,
      '配置的档位没装 → 应自动用已装好的档位顶替，并记下 fallbackFrom（UI 要说清楚）');
  } finally { ctx.dispose(); }
});

test('②-b 无模型：**不建窗**，available=false / reason=no-model（优雅隐藏，其余功能照常）', async () => {
  const ctx = await boot();
  try {
    assert.ok(ctx.p.voice, '没模型也要有语音服务对象（只是不可用）——否则状态无从查询');
    const st = ctx.p.voice.status();
    assert.equal(st.available, false);
    assert.equal(st.reason, 'no-model');
    assert.equal(ctx.asrWindows().length, 0, '没模型不该建识别窗（省内存）');
  } finally { ctx.dispose(); }
});

/* ===================== ③ 就绪链路 ===================== */

test('③ 就绪链路：asr:ready → available=true → voice:start 放行 → 下发 asr:start', async () => {
  const ctx = await boot({ withModel: true });
  try {
    const win = ctx.asrWindows()[0];
    win.emitWc('did-finish-load');
    const forward = ctx.fe._on.get('asr:event');   // 主进程收到的唯一转发入口

    // 就绪前：status 不可用，voice:start 应回绝（不是静默失败）
    assert.equal(ctx.p.voice.status().available, false, '渲染侧还没回报 ready 前不可用');
    const early = ctx.fe._handlers.get('voice:start')(null, {});
    assert.equal(early.ok, false, '未就绪时必须明确回绝');
    assert.equal(early.error, 'loading', '刚启动、还在加载窗口内 → 应报"稍等"，而不是笼统的"没准备好"');

    // 渲染侧回报 ready
    forward(null, { channel: 'asr:ready', payload: { devices: [{ deviceId: 'a', label: '麦' }] } });
    assert.equal(ctx.p.voice.status().available, true, '收到 asr:ready 后必须变为可用');

    const r = ctx.fe._handlers.get('voice:start')(null, {});
    assert.equal(r.ok, true, '就绪后 voice:start 必须放行');
    assert.ok(win._sent.some((s) => s.ch === 'asr:start'), '必须把 asr:start 下发给识别进程');
  } finally { ctx.dispose(); }
});

/* ===================== ④ 自愈 / 重试机制 ===================== */

test('③-b 超过等待窗口仍未 ready：「稍等」必须降级成「没准备好」并触发受控重建', async () => {
  const ctx = await boot({ withModel: true });
  try {
    const { CFG } = require(path.join(ROOT, 'src', 'shared', 'config'));
    ctx.p.voice.initStartedAt = Date.now() - (CFG.voice.readyTimeoutMs + 1000);  // 假装已经卡了很久
    const r = ctx.fe._handlers.get('voice:start')(null, {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not-ready', '真卡住时不能再骗用户"稍等 1~3 秒"');
    assert.equal(ctx.p.voice.readyRetries, 1, '应触发一次受控重建');
  } finally { ctx.dispose(); }
});

test('④ 未启动时 voice:status 应自动补启语音服务（不许停在 not-initialized）', async () => {
  const ctx = await boot({ withModel: true });
  try {
    ctx.p.voice = null;                       // 模拟"因为任何原因没启动"
    const st = ctx.fe._handlers.get('voice:status')();
    assert.ok(ctx.p.voice, 'voice:status 应顺手把语音服务补起来（惰性自愈）');
    assert.notEqual(st.reason, 'not-initialized', '补启后不该再报 not-initialized');
  } finally { ctx.dispose(); }
});

test('④-b 识别进程活着但迟迟不 ready → ensureReady 必须重建（不许无限等下去）', async () => {
  const ctx = await boot({ withModel: true });
  try {
    assert.equal(ctx.asrWindows().length, 1);
    const first = ctx.asrWindows()[0];
    // 强制重试（用户点"重试" / 看门狗超时都走这条）：旧进程必须**立刻**被拆掉
    ctx.p.voice.ensureReady(true);
    assert.equal(first.isDestroyed(), true, '卡住的旧进程要先销毁（否则留一个半死的进程占着麦克风）');
    await new Promise((r) => setTimeout(r, 900));   // 等退避后的重建
    assert.equal(ctx.asrWindows().length, 2, '卡死状态下必须重建识别进程，而不是继续等');
    assert.equal(ctx.p.voice.readyRetries, 1, '重建次数要记账');
  } finally { ctx.dispose(); }
});

test('④-c 识别页面加载失败（did-fail-load）→ 受控重建，不留下"永远没准备"的死局', async () => {
  const ctx = await boot({ withModel: true });
  try {
    const win = ctx.asrWindows()[0];
    win.emitWc('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///asr.html');
    assert.equal(ctx.p.voice.error.length > 0, true, '必须把失败原因记下来（供状态查询/日志）');
    await new Promise((r) => setTimeout(r, 900));   // 等重建定时器
    assert.ok(ctx.asrWindows().length >= 2, '加载失败应触发一次受控重建');
    assert.ok(ctx.p.voice.readyRetries <= require(path.join(ROOT, 'src', 'shared', 'config')).CFG.voice.readyMaxRetries,
      '重建次数必须有上限（防死循环刷屏/刷 CPU）');
  } finally { ctx.dispose(); }
});

test('④-d 有模型但从未 ready → 必须排好看门狗（让"没准备好"有明确的超时与原因）', async () => {
  const ctx = await boot({ withModel: true });
  try {
    assert.ok(ctx.p.voice.readyWatch, '必须排 ready 看门狗定时器');
  } finally { ctx.dispose(); }
});

/* ===================== ⑤ 用户真实配置（快照 = 用户 data/settings.json 的 voice 字段） =====================
 * 价值：前 4 组用例都跑在"默认/无偏好"上；用户的实际配置是「配置档位 zipformer-zh-int8 未装（只有轻量档）
 * + 旧版 mode='both' + 全局键 Control+3」。这是离"用户下一次重启"最近的一次模拟，
 * 同时验证**旧设置的迁移**（mode → wake.enabled）与**按键说话恢复后全局键开机即注册**。 */

const USER_VOICE_SNAPSHOT = {
  enabled: true, mode: 'both', model: 'zipformer-zh-int8', deviceId: '',
  wake: { word: '桌宠桌宠', tokens: '', boost: 1.5, threshold: 0.25 },
  ptt: { local: 'Control+Shift+Space', globalKey: 'Control+3' },
  duckBgm: true, showPartial: true,
};

test('⑤ 用户真实配置：档位自动顶替 + 旧 mode 迁移成后台唤醒 + 不再抢任何全局键', async () => {
  const ctx = await boot({ withModel: true, settings: { voice: USER_VOICE_SNAPSHOT } });
  try {
    // ready 之前：档位顶替/唤醒开关这些"配置层"的事实就应该已经成立
    const pre = ctx.p.voice.status();
    assert.equal(pre.available, false, '渲染侧尚未回报 ready，暂不可用');
    assert.equal(pre.configuredModel, 'zipformer-zh-int8', '用户配置的档位如实上报');
    assert.equal(pre.model, 'small-ctc-zh-int8', '配置档位未装 → 自动顶替为已装的轻量档');
    assert.equal(pre.fallbackFrom, 'zipformer-zh-int8');
    assert.equal(pre.wakeEnabled, true, "旧 mode='both' 应迁移成「后台唤醒开」（唤醒词保留）");
    assert.equal(pre.dialog, false, '语音对话是运行期开关，重启后默认关闭（常态是打字）');
    // ★ 按键说话已恢复：用户老设置里的全局键（Control+3）**开机即注册**。
    //   旧缺陷：只在"在设置窗点保存"那一刻才注册 → 重启即失效、用户按了毫无反应。
    assert.deepEqual(ctx.fe._shortcuts, ['Control+3'],
      '用户自己设的全局键必须**开机即注册**（Control+3）');
    // 渲染侧回报 ready 后 → 可用
    const win = ctx.asrWindows()[0];
    assert.ok(win, '用户配置下应建识别窗');
    win.emitWc('did-finish-load');
    ctx.fe._on.get('asr:event')(null, { channel: 'asr:ready', payload: { devices: [] } });
    assert.equal(ctx.p.voice.status().available, true, 'ready 之后必须可用');
  } finally { ctx.dispose(); }
});

test('⑤-b 用户唤醒词没填音素串 → 应回落到内置词库（不依赖 Python）', async () => {
  const ctx = await boot({ withModel: true, settings: { voice: USER_VOICE_SNAPSHOT } });
  try {
    const V = require(path.join(ROOT, 'src', 'shared', 'voice'));
    const line = V.buildKeywordLine(USER_VOICE_SNAPSHOT);
    assert.ok(line && line.includes('@桌宠桌宠'), `内置词库应给出音素串，实际：${line}`);
    assert.ok(ctx.p.voice.writeKeywordsFile(USER_VOICE_SNAPSHOT), '应能落盘 keywords.txt 供 KWS 加载');
  } finally { ctx.dispose(); }
});

test('⑤-c 关掉后台唤醒 → 识别进程收到 wakeEnabled=false（不再常驻占麦克风）', async () => {
  const ctx = await boot({ withModel: true, settings: { voice: { ...USER_VOICE_SNAPSHOT, mode: 'ptt' } } });
  try {
    const win = ctx.asrWindows()[0];
    win.emitWc('did-finish-load');
    const init = win._sent.find((s) => s.ch === 'asr:init');
    assert.ok(init, '应下发 asr:init');
    assert.equal(init.payload.wakeEnabled, false, "旧 mode='ptt'（用户从没用过唤醒词）→ 不后台监听");
    assert.equal(ctx.p.voice.status().wakeEnabled, false);
  } finally { ctx.dispose(); }
});

/* ===================== ⑥ 语音对话：🎤 进入/退出 + 提交后停麦等模型 =====================
 * 取代原来的"全局快捷键"用例（PTT 已取消）。三条关键语义：
 *  ① 进入对话 → 下发 asr:start{session:'dialog'}；
 *  ② 说完一句 → 提交给模型；**等模型期间不做识别**（识别进程已停麦）；
 *  ③ 模型回复落地后 → 自动 asr:resume 继续听（不需要任何点击）；退出对话要停。 */

test('⑥ 语音对话：🎤 进入/退出 + 提交后停麦等模型 + 回复到了自动续听', async () => {
  const ctx = await boot({ withModel: true, settings: { voice: USER_VOICE_SNAPSHOT } });
  try {
    const win = ctx.asrWindows()[0];
    win.emitWc('did-finish-load');
    ctx.fe._on.get('asr:event')(null, { channel: 'asr:ready', payload: { devices: [] } });

    // ① 进入语音对话
    const r1 = ctx.p.startVoiceDialog();
    assert.equal(r1.ok, true);
    assert.equal(ctx.p.voice.status().dialog, true);
    const starts = win._sent.filter((s) => s.ch === 'asr:start');
    assert.equal(starts.length, 1, '应下发一次 asr:start');
    assert.equal(starts[0].payload.session, 'dialog', '必须声明是语音对话（连续多轮）');

    // ② 说完一句 → 提交给模型 + 进入"在想"（这期间不做识别）
    const p = ctx.fe._on.get('asr:event')(null, {
      channel: 'asr:final', payload: { text: '帮我查一下明天的天气' },
    });
    assert.equal(ctx.p.voice.status().thinking, true, '提交后应进入"在想"状态');
    assert.ok(win._sent.filter((s) => s.ch === 'asr:resume').length === 0, '还没回复就不该恢复采集');

    // ③ 模型回复落地 → 自动恢复听（asr:resume），且不切回非语音模式
    await p;   // handleFinal 内部等 voiceFinal 完成
    assert.equal(ctx.p.voice.status().thinking, false);
    assert.equal(ctx.p.voice.status().dialog, true, '回复后仍留在语音对话里（不切回打字）');
    assert.ok(win._sent.some((s) => s.ch === 'asr:resume'), '必须自动叫识别进程接着听');

    // ④ 再点 🎤 → 退出对话
    ctx.p.stopVoiceDialog();
    assert.equal(ctx.p.voice.status().dialog, false);
    assert.ok(win._sent.some((s) => s.ch === 'asr:stop'), '退出对话要停采集');
  } finally { ctx.dispose(); }
});

test('⑥-b 过短的一句话（"啊"）不许请求大模型，但语音对话必须继续听', async () => {
  const ctx = await boot({ withModel: true, settings: { voice: USER_VOICE_SNAPSHOT } });
  try {
    const win = ctx.asrWindows()[0];
    win.emitWc('did-finish-load');
    ctx.fe._on.get('asr:event')(null, { channel: 'asr:ready', payload: { devices: [] } });
    ctx.p.startVoiceDialog();
    const before = win._sent.filter((s) => s.ch === 'asr:resume').length;
    // 识别进程判定"太短"时不会发 asr:final，只发 asr:discard
    ctx.fe._on.get('asr:event')(null, { channel: 'asr:discard', payload: { reason: 'too-short-audio', text: '啊' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctx.p.voice.status().thinking, false, '过短不该进入"等模型"（根本没请求）');
    assert.equal(win._sent.filter((s) => s.ch === 'asr:resume').length, before + 1,
      '过短也必须恢复采集，否则语音会永久哑掉');
  } finally { ctx.dispose(); }
});

/* ===================== ⑦ 全局按键触发语音（2026-09-16 晚按用户要求恢复） =====================
 * 用户要的是"按键触发**全局**语音识别"。恢复后它与语音对话**共存**（不再互斥）：
 *   · 全局键（任何窗口）＝ 按一下进入 / 再按一下退出 —— Electron 的 `globalShortcut` **只有 keydown、
 *     没有 keyup**，所以系统层面不可能做成"按住"；
 *   · 聊天窗内的键 ＝ 真·按住（松开立即提交这一句）。
 * 下面的用例既验"注册了"，也验"按下去真的能用"—— 后者才是用户能感知到的东西。 */

test('⑦ 全局按键：按一下进入语音对话、再按一下退出', async () => {
  const ctx = await boot({ withModel: true, settings: { voice: USER_VOICE_SNAPSHOT } });
  try {
    const win = ctx.asrWindows()[0];
    win.emitWc('did-finish-load');
    ctx.fe._on.get('asr:event')(null, { channel: 'asr:ready', payload: { devices: [] } });

    // 注册只是手段，"按下能用"才是目的 → 用桩记录的回调真的按一下
    const press = ctx.fe._shortcutHandlers['Control+3'];
    assert.equal(typeof press, 'function', '用户设的全局键必须注册**并带回调**');

    press();
    assert.equal(ctx.p.voice.isDialogOn(), true, '按一下全局键应进入语音对话（等价于点 🎤）');
    assert.ok(win._sent.some((s) => s.ch === 'asr:start' && s.payload && s.payload.session === 'dialog'),
      '应下发 asr:start{session:dialog}');

    press();
    assert.equal(ctx.p.voice.isDialogOn(), false, '再按一下应退出语音对话');
    assert.ok(win._sent.some((s) => s.ch === 'asr:stop'), '退出应下发 asr:stop');
  } finally { ctx.dispose(); }
});

test('⑦-b 按住说话（聊天窗内）：松开 → flush 立即提交这一句，但**不退出**会话', async () => {
  const ctx = await boot({ withModel: true, settings: { voice: USER_VOICE_SNAPSHOT } });
  try {
    const win = ctx.asrWindows()[0];
    win.emitWc('did-finish-load');
    ctx.fe._on.get('asr:event')(null, { channel: 'asr:ready', payload: { devices: [] } });
    ctx.p.startVoiceDialog();
    // 渲染层"松开键" → 主进程 voice:flush → 转发 asr:flush
    ctx.fe._handlers.get('voice:flush')(null);
    assert.ok(win._sent.some((s) => s.ch === 'asr:flush'), '松开应下发 asr:flush（立即提交，不等 1.2 秒静音）');
    assert.equal(ctx.p.voice.isDialogOn(), true, 'flush **不退出**会话，下一句照常接着听');
  } finally { ctx.dispose(); }
});
