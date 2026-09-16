'use strict';
/**
 * 语音服务（主进程侧）：模型状态 / 识别进程生命周期 / 降级 / 权限放行。
 *
 * ★ 铁律：**推理绝不放主进程**。主进程每 16ms 推光标驱动像素穿透判定（"点得动"的命脉），
 * 一次同步 ONNX 推理就能把它抖成"点不动"。所以采集 + 推理都在一个**专用隐藏渲染进程**
 * （renderer/asr.html）里完成 → **PCM 一次都不跨进程**，主进程只收文本。
 *
 * 本文件只做编排：
 *   ① 找模型（data/voice/models/<dir>/）→ 缺则 available=false（功能优雅隐藏，不崩不卡）
 *   ② 建隐藏窗口、装载 asr.js、下发 asr:init（模型路径 / 采样率 / 触发方式 / 唤醒词串）
 *   ③ 收 asr:ready|state|partial|final|error|wake → 转发宠物窗视觉反馈 + 投聊天编排器
 *   ④ 崩溃有限次重启（3 次 / 10 分钟），超限禁用并提示
 *
 * 与现有架构的一致性：窗口参数、事件命名（`xxx:yyy`）、"深度不可用就优雅隐藏"的套路
 * 全部照抄 project 既有做法（见 winenum.js / english 的"该难度暂无数据"）。
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { CFG } = require('../shared/config');
const V = require('../shared/voice');

/** 在模型目录里按文件名特征找文件（不硬编码 epoch 号，换模型版本不会断）。 */
function findModelFile(dir, patterns) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const p of patterns) {
    const hit = names.find((n) => p.test(n));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** 找 onnx 文件里体积最大的那个（encoder 通常是最大的；用作兜底判定）。 */
function largestOnnx(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const onnx = names.filter((n) => /\.onnx$/i.test(n));
  if (!onnx.length) return null;
  let best = null, bestSize = -1;
  for (const n of onnx) {
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.size > bestSize) { bestSize = st.size; best = n; }
    } catch { /* 忽略 */ }
  }
  return best ? path.join(dir, best) : null;
}

class VoiceService {
  /**
   * @param {import('./main').PetApp} app 主进程 PetApp（借用 store / send / voiceFinal / log）
   */
  constructor(petApp) {
    this.app = petApp;
    this.root = path.join(petApp.userDataRoot, 'voice');
    // 模型目录。`PET_VOICE_MODELS` 是**自检/测试专用**：让 `--voice-e2e` 在没有模型副本的
    // 临时 userData 里也能指向项目的 data/voice/models（否则为了跑一次自检还得建目录链接）。
    this.modelsRoot = process.env.PET_VOICE_MODELS
      ? path.resolve(process.env.PET_VOICE_MODELS)
      : path.join(this.root, 'models');
    this.win = null;
    this.ready = false;
    this.modelReady = false;
    this.kwsReady = false;
    this.available = false;
    this.reason = 'not-initialized';
    this.error = '';
    this.lastState = 'idle';
    this.lastRms = 0;
    this.deviceList = [];
    this.restarts = [];
    this.prewarmTimer = 0;
    this.readyWatch = 0;       // 识别进程"迟迟不 ready"的看门狗
    this.initStartedAt = 0;    // 本次 init 的起始时刻（算"卡了多久"）
    this.readyRetries = 0;     // 因"卡住/加载失败"触发的重建次数（有上限，防死循环）
    this.retryTimer = 0;       // 重建的退避定时器
    this.lastStage = '';       // 识别进程最后上报到的阶段（排查用）
    // ★ 语音对话会话（聊天窗 🎤 进入/退出）。与"被动等待唤醒"是两回事：
    //   dialog=false 时可能仍在后台监听唤醒词（wakeEnabled）。
    this.dialog = false;
    this.thinking = false;      // 已提交、正在等模型回复（这期间不做识别）——给 UI 显示"在想…"
    this.resumeTimer = 0;       // 等模型的兜底定时器（防"模型卡住 → 语音永久哑掉"）
    this.pendingInfo = null;   // 已下发但尚未 ready 的 init 信息
    this._ducking = false;
  }

  log(...a) { if (process.env.PET_DEBUG) console.log('[voice]', ...a); }

  /* ---------------- 权限：放行 media（不加这段 getUserMedia 会直接被 reject） ---------------- */

  installPermissionHandler() {
    try {
      session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        if (permission === 'media' || permission === 'audioCapture') { callback(true); return; }
        callback(true); // 本应用是本地工具，其余权限一并放行（避免隐藏窗里出现静默失败）
      });
      // 设备标签需要权限；这里显式声明不启用 media 的"系统选择器"限制
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || true);
      this.log('permission handler installed');
    } catch (e) {
      this.log('installPermissionHandler failed', e && e.message);
    }
  }

  /* ---------------- 模型解析 ---------------- */

  modelEntry(prefs) {
    const id = (prefs && prefs.model) || CFG.voice.model;
    const list = CFG.voice.models || [];
    return list.find((m) => m.id === id) || list[0] || null;
  }

  /** 检查单个档位的文件是否齐全（按 kind 分三种结构，别一律当成 transducer 三件套）。 */
  resolveOne(entry) {
    if (!entry) return { ok: false, reason: 'no-model', missing: ['config.voice.models 为空'] };
    const dir = path.join(this.modelsRoot, entry.dir);
    if (!fs.existsSync(dir)) return { ok: false, reason: 'no-model', dir, missing: [dir], entry };
    const tokens = path.join(dir, 'tokens.txt');
    const missing = [];
    if (!fs.existsSync(tokens)) missing.push('tokens.txt');
    const kind = entry.kind || (entry.streaming ? 'transducer' : 'senseVoice');

    if (kind === 'transducer') {
      // encoder / decoder / joiner 三件套（文件名含 epoch/chunk 号，用特征匹配）
      const encoder = findModelFile(dir, [/^encoder.*\.onnx$/i, /encoder/i]);
      const decoder = findModelFile(dir, [/^decoder.*\.onnx$/i, /decoder/i]);
      const joiner = findModelFile(dir, [/^joiner.*\.onnx$/i, /joiner/i]);
      if (!encoder) missing.push('encoder*.onnx');
      if (!decoder) missing.push('decoder*.onnx');
      if (!joiner) missing.push('joiner*.onnx');
      if (missing.length) return { ok: false, reason: 'no-model', dir, missing, entry };
      return { ok: true, kind, streaming: true, dir, tokens, encoder, decoder, joiner, entry };
    }

    // CTC（zipformer2-ctc）/ SenseVoice：单文件
    const model = findModelFile(dir, [/^model.*\.onnx$/i, /^.*\.onnx$/i]) || largestOnnx(dir);
    if (!model) missing.push('model*.onnx');
    if (missing.length) return { ok: false, reason: 'no-model', dir, missing, entry };
    // CTC 档位的 tokens 常是 BPE，需要配套 bbpe.model（缺了不影响加载判定，但会认不出字）
    const bpe = findModelFile(dir, [/^bbpe\.model$/i, /\.model$/i]);
    return { ok: true, kind, streaming: kind === 'zipformer2Ctc', dir, tokens, model, bpeVocab: bpe || null, entry };
  }

  /**
   * 解析识别模型。
   * **配置的档位没装时，自动改用"其它已装好的档位"**，并标 `fallbackFrom` 让 UI 说清楚
   * —— 否则会出现最容易让人困惑的一幕：模型明明下好了，App 却报"未安装"（因为下的是另一个档位）。
   */
  resolveModel(prefs) {
    const want = this.modelEntry(prefs);
    const first = this.resolveOne(want);
    if (first.ok) return first;
    for (const m of (CFG.voice.models || [])) {
      if (!want || m.id === want.id) continue;
      const alt = this.resolveOne(m);
      if (alt.ok) { alt.fallbackFrom = want ? want.id : ''; this.log('model fallback', alt.fallbackFrom, '→', m.id); return alt; }
    }
    return first;
  }

  /** 解析唤醒词（KWS）模型目录；缺则唤醒不可用（不影响按键/常听）。 */
  resolveKws() {
    const dirName = CFG.voice.kwsModel;
    if (!dirName) return { ok: false };
    const dir = path.join(this.modelsRoot, dirName);
    if (!fs.existsSync(dir)) return { ok: false, dir };
    const encoder = findModelFile(dir, [/^encoder.*\.onnx$/i, /encoder/i]);
    const decoder = findModelFile(dir, [/^decoder.*\.onnx$/i, /decoder/i]);
    const joiner = findModelFile(dir, [/^joiner.*\.onnx$/i, /joiner/i]);
    const tokens = path.join(dir, 'tokens.txt');
    if (!encoder || !decoder || !joiner || !fs.existsSync(tokens)) return { ok: false, dir };
    return { ok: true, dir, encoder, decoder, joiner, tokens };
  }

  /** 把当前唤醒词写成 KWS 需要的 keywords.txt（内容变了才重写）。 */
  writeKeywordsFile(prefs) {
    const line = V.buildKeywordLine(prefs);
    if (!line) return null;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const file = path.join(this.root, 'keywords.txt');
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const next = line + '\n';
      if (prev !== next) fs.writeFileSync(file, next, 'utf8');
      return file;
    } catch (e) {
      this.log('writeKeywordsFile failed', e && e.message);
      return null;
    }
  }

  /* ---------------- 生命周期 ---------------- */

  /** 启动时调用：解析模型 → 决定是否建识别进程。 */
  init() {
    const prefs = this.app.store.get().voice || null;
    const enabled = !prefs || prefs.enabled !== false;
    if (!CFG.voice.enabled || !enabled) { this.available = false; this.reason = 'disabled'; this.log('init: disabled'); return; }
    const m = this.resolveModel(prefs);
    if (!m.ok) {
      this.available = false;
      this.reason = 'no-model';
      this.error = `缺模型文件：${(m.missing || []).join(', ')}`;
      this.log('init: no-model', this.error);
      return;
    }
    this.available = true;
    this.reason = '';
    this.modelReady = false;
    this.initStartedAt = Date.now();
    this.activeModelId = (m.entry && m.entry.id) || '';
    this.fallbackFrom = m.fallbackFrom || '';
    const kws = this.resolveKws();
    this.kwsReady = !!kws.ok;
    this.log(`init: model=${this.activeModelId} kind=${m.kind} kws=${this.kwsReady}${this.fallbackFrom ? ` (fallback from ${this.fallbackFrom})` : ''}`);
    this.createAsrWindow(m, kws, prefs);
    // 看门狗：识别进程迟迟不 ready（页面加载失败 / 原生插件卡住 / 渲染进程悄悄没了）
    // 不能只写一句日志就算完 —— 那正是"语音引擎还没准备好"变成哑谜的原因。
    // 这里超时后**触发一次受控重建**（有次数上限，见 rebuild()）。
    this.armReadyWatch();
    // 预热：避免用户第一次说话干等 1~2 秒
    const delay = Math.max(0, Number(CFG.voice.prewarmMs) || 0);
    if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
    this.prewarmTimer = setTimeout(() => this.sendToAsr('asr:prewarm'), delay);
  }

  /** 排 ready 看门狗；到点仍未就绪 → 记录并触发受控重建。 */
  armReadyWatch() {
    if (this.readyWatch) clearTimeout(this.readyWatch);
    const limit = Math.max(1000, Number(CFG.voice.readyTimeoutMs) || 20000);
    this.readyWatch = setTimeout(() => {
      this.readyWatch = 0;
      if (this.modelReady) return;
      const waited = Date.now() - (this.initStartedAt || Date.now());
      this.log(`init: ⚠ 识别进程 ${waited}ms 未回报 asr:ready（最后阶段：${this.lastStage || '无'}）→ 重建`);
      this.error = `识别进程 ${Math.round(waited / 1000)} 秒未就绪（最后阶段：${this.lastStage || '无'}）`;
      this.reason = 'not-ready';
      this.rebuild('ready-timeout');
    }, limit);
  }

  /**
   * 受控重建识别进程。
   * 三层自愈的第二层（第一层 = main.js 的惰性补启，第三层 = onAsrCrash 的崩溃重启）：
   * **卡住**（不崩也不 ready）是最难发现的一种失败 —— 不重建就会永久停在"没准备好"。
   * @param {string} reason 触发原因（只进日志）
   */
  rebuild(reason) {
    const max = Math.max(0, Number(CFG.voice.readyMaxRetries) || 3);
    if (this.readyRetries >= max) {
      // 上限保护：绝不在坏状态里无限重建（刷 CPU / 刷日志）
      this.reason = 'crashed';
      this.error = this.error || `识别进程反复未能就绪（已自动重建 ${this.readyRetries} 次后停止）`;
      this.log(`rebuild(${reason}): 已达上限 ${max} 次，停止自动重建`);
      return;
    }
    this.readyRetries++;
    this.log(`rebuild(${reason}): 第 ${this.readyRetries}/${max} 次重建识别进程`);
    // ① 立刻拆掉卡住的进程（它可能半死还占着麦克风；留着只会让状态更乱）
    if (this.readyWatch) { clearTimeout(this.readyWatch); this.readyWatch = 0; }
    try { if (this.win && !this.win.isDestroyed()) this.win.destroy(); } catch { /* 已销毁 */ }
    this.win = null;
    this.ready = false;
    this.modelReady = false;
    this.lastStage = '';
    this.thinking = false;
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = 0; }
    // ② 退避一小会儿再重建（别在同一个坏状态下瞬间疯狂重试）
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = Math.max(0, Number(CFG.voice.retryDelayMs) || 600);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = 0;
      try { this.init(); } catch (e) { this.log('rebuild failed', e && e.message); }
    }, delay);
  }

  /**
   * 尽力让识别进程就绪：被调用时如果还没 ready（模型后装、进程崩过、首次加载慢、进程卡住），
   * 就**重建/重走 init**，而不是回一句"没准备好"了事。
   * @param {boolean} [force] true = 立刻重建（用户主动重试 / 看门狗到点）；
   *                          false = 还在合理等待窗口内就先继续等（避免把"正在加载"误判成"卡住"）
   * @returns {boolean} 现在是否可用
   */
  ensureReady(force) {
    if (this.available && this.modelReady) return true;
    if (!this.available && this.reason === 'no-model') return false; // 连模型都没有：重建多少次都一样
    const alive = !!(this.win && !this.win.isDestroyed());
    if (alive && !force) {
      const limit = Math.max(1000, Number(CFG.voice.readyTimeoutMs) || 20000);
      const waited = Date.now() - (this.initStartedAt || 0);
      if (waited < limit) { this.log(`ensureReady: 进程在，继续等（已等 ${waited}ms / ${limit}ms）`); return false; }
      this.log('ensureReady: 等待已超时 → 重建');
    } else {
      this.log(`ensureReady: ${force ? '强制' : ''}重建（进程${alive ? '在但未就绪' : '不存在'}）`);
    }
    this.rebuild(force ? 'user-retry' : 'stuck');
    return false;
  }

  createAsrWindow(model, kws, prefs) {
    if (this.win && !this.win.isDestroyed()) return;
    const w = new BrowserWindow({
      width: 420, height: 200,
      show: false,              // 隐藏：不需要用户看到（音频与推理同处一进程，PCM 不跨进程）
      skipTaskbar: true,
      frame: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false, // 隐藏窗也不能被节流，否则采集/推理停摆
        spellcheck: false,
      },
    });
    this.win = w;
    w.loadFile(path.join(__dirname, '..', 'renderer', 'asr.html'));
    w.webContents.on('did-finish-load', () => {
      this.pendingInfo = this.buildInitPayload(model, kws, prefs);
      w.webContents.send('asr:init', this.pendingInfo);
      this.log('asr window loaded, init sent');
    });
    // 页面都没加载成功的话，后面必是"语音引擎还没准备好" —— 必须把原因记下来**并重建**
    // （以前只记日志不重试 → 一次偶发加载失败 = 本次开机语音全废，用户只能重启应用）
    w.webContents.on('did-fail-load', (_e, code, desc, url) => {
      this.error = `识别进程页面加载失败：${desc} (${code}) ${url || ''}`;
      this.log('asr window did-fail-load', this.error);
      this.reason = 'not-ready';
      this.rebuild('did-fail-load');
    });
    w.webContents.on('render-process-gone', (_e, details) => {
      this.error = `识别进程异常退出：${(details && details.reason) || 'unknown'}`;
      this.log('asr render-process-gone', this.error);
      this.onAsrCrash(this.error);
    });
    // 把识别进程自己的 console 转发到主进程 → 一起进 debug.log（否则渲染侧卡住时主进程一无所知）
    w.webContents.on('console-message', (_e, _level, message) => {
      if (process.env.PET_DEBUG) console.log('[asr/renderer]', message);
    });
    w.on('closed', () => { if (this.win === w) this.win = null; });
    this.bindAsrEvents(w);
  }

  buildInitPayload(model, kws, prefs) {
    const kw = kws.ok ? {
      dir: kws.dir, encoder: kws.encoder, decoder: kws.decoder, joiner: kws.joiner, tokens: kws.tokens,
      keywordsFile: this.writeKeywordsFile(prefs),
      word: (prefs && prefs.wake && prefs.wake.word) || CFG.voice.wake.word,
      boost: (V.normalizeVoicePrefs(prefs) || V.normalizeVoicePrefs({})).wake.boost,
      threshold: (V.normalizeVoicePrefs(prefs) || V.normalizeVoicePrefs({})).wake.threshold,
    } : null;
    const p = V.normalizeVoicePrefs(prefs);
    return {
      sampleRate: CFG.voice.sampleRate,
      // ★ 2026-09-16：原来这里是 4 选 1 的 mode（按键/唤醒/唤醒+按键/常听）。
      //   现在只剩"要不要后台监听唤醒词"；「语音对话」是运行期会话（asr:start session='dialog'），
      //   不通过 init 下发。
      wakeEnabled: V.wakeEnabledOf(prefs),
      deviceId: (p && p.deviceId) || '',
      showPartial: !p || p.showPartial !== false,
      endpointSilenceMs: CFG.voice.endpointSilenceMs,
      maxRecordMs: CFG.voice.maxRecordMs,
      dialog: { ...CFG.voice.dialog },
      duckBgm: !p || p.duckBgm !== false,
      model: {
        kind: model.kind || (model.streaming ? 'transducer' : 'senseVoice'),
        streaming: model.streaming,
        tokens: model.tokens,
        encoder: model.encoder,
        decoder: model.decoder,
        joiner: model.joiner,
        single: model.model,
        bpeVocab: model.bpeVocab || '',
      },
      kws: kw,
      strings: { ...CFG.voice.strings, word: (kw && kw.word) || CFG.voice.wake.word },
    };
  }

  sendToAsr(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  bindAsrEvents(w) {
    const wc = w.webContents;
    wc.on('ipc-message', () => {}); // 占位：事件统一走下面的 ipcMain 转发（见 attachIpc）
    void wc;
  }

  /** 由 main.js 的 ipcMain 统一转发进来（语音进程 → 主进程）。 */
  onAsrMessage(channel, payload) {
    switch (channel) {
      case 'asr:stage':
        // 阶段上报：卡在哪一步一目了然（PET_DEBUG=1 时打印）
        this.lastStage = (payload && payload.stage) || '';
        this.log('asr stage:', this.lastStage);
        break;
      case 'asr:ready':
        this.ready = true;
        this.modelReady = true;
        this.deviceList = (payload && payload.devices) || [];
        this.error = '';
        this.reason = '';
        this.initStartedAt = 0;
        this.readyRetries = 0;   // 成功一次就把重建配额还回去（别让偶发失败累积成"停用"）
        if (this.readyWatch) { clearTimeout(this.readyWatch); this.readyWatch = 0; }
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = 0; }
        this.log('asr ready, devices=', this.deviceList.length);
        // 语音对话在进程重建（模型热重载/崩溃自愈）后要**自动接上**：
        // 用户点过 🎤 就说明他想继续对话，不该因为一次重建就悄悄退出。
        if (this.dialog) this.sendToAsr('asr:start', { session: 'dialog' });
        break;
      case 'asr:state':
        this.lastState = (payload && payload.state) || 'idle';
        this.lastRms = (payload && payload.rms) || 0;
        // 视觉反馈（宠物窗"在听"标识 + 聊天窗"正在输入"）+ BGM 闪避（听时压低自己的音乐）
        this.app.voiceBroadcast('voice:state', { state: this.lastState, rms: this.lastRms });
        this.applyDucking(this.lastState !== 'idle');
        break;
      case 'asr:partial':
        if (payload && payload.text) this.app.voiceBroadcast('voice:partial', { text: payload.text });
        break;
      case 'asr:wake':
        this.app.voiceBroadcast('voice:wake', { word: (payload && payload.word) || '' });
        this.app.showIfHidden();
        break;
      case 'asr:final':
        // 返回 Promise 是为了可测（自检/接线测试能 await 这一轮对话真的走完了）
        return this.handleFinal(payload);
      case 'asr:discard':
        // ★ 过短/没内容（"啊"一声、只说了"嗯"）：**不请求大模型**（用户要求），
        //   只在状态条上轻提示；语音对话里必须继续听，否则会永久哑掉。
        this.app.voiceBroadcast('voice:discard', { reason: (payload && payload.reason) || '' });
        this.afterUtterance();
        break;
      case 'asr:error':
        this.error = (payload && payload.message) || 'unknown';
        this.log('asr error', payload && payload.code, this.error);
        if (payload && payload.fatal) this.onAsrCrash(this.error);
        break;
      default:
        break;
    }
  }

  /**
   * 识别到一句 → 走聊天编排器（与打字同源：唯一差别是 channel='voice'）。
   *
   * ★ 语音对话（用户 2026-09-16 需求）在本函数里闭环：
   *   提交给模型 → **等待期间不做识别**（识别进程已停麦）→ 回复到了 `asr:resume` 继续听。
   *   失败/超时/被判定过短也都会走到 afterUtterance()，保证"绝不会卡死"。
   */
  handleFinal(payload) {
    const raw = (payload && payload.text) || '';
    const text = V.normalizeTranscript(raw);
    const st = CFG.voice.strings;
    this.applyDucking(false);
    if (!V.isMeaningfulTranscript(text)) {
      // 没听清：不调聊天引擎（避免"空话触发表情"），只给个轻提示
      this.app.send('bubble:chat', { text: st.empty, ms: 3000 });
      this.app.pushChatMessage(st.empty, 'sys');
      this.afterUtterance();
      return;
    }
    // ★ 把"我说的那句"也写进聊天窗（否则对话只有桌宠的回复，读起来像自言自语）
    this.app.pushChatMessage(text, 'me');
    if (!this.dialog) {
      // 唤醒词叫醒的**单轮**问答：不用等模型，说完就回到被动等待
      return Promise.resolve(this.app.voiceFinal(text)).catch(() => {}).finally(() => this.afterUtterance());
    }
    // 语音对话：等模型 → 再接着听
    this.thinking = true;
    this.broadcastDialog();
    // 兜底定时器：万一 voiceFinal 永不落地（极端情况），也不能让语音永久哑掉
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.log('dialog resume timeout, 强制恢复采集');
      this.thinking = false;
      this.afterUtterance();
    }, Math.max(3000, Number(CFG.voice.dialog.resumeTimeoutMs) || 30000));
    // 返回这个 Promise：调用方（IPC 转发 / 自检 / 接线测试）能 await "这一轮真的走完了"。
    // 注意 afterUtterance 在 finally 里 → 无论成功、回落、失败都会恢复听。
    return Promise.resolve(this.app.voiceFinal(text)).catch(() => {}).finally(() => {
      this.thinking = false;
      this.afterUtterance();
    });
  }

  /**
   * 一句话处理完了 → 决定"接下来怎么听"。
   *  · 语音对话中：叫识别进程恢复采集（asr:resume），自动开始下一句（无需任何点击）；
   *  · 不在对话中：什么都不用做（识别进程自己按 wakeEnabled 决定是否继续被动监听）。
   */
  afterUtterance() {
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = 0; }
    if (this.dialog && this.available && this.modelReady) this.sendToAsr('asr:resume');
    this.broadcastDialog();
  }

  /** 语音对话状态广播（聊天窗用它渲染"语音对话中 / 在想…"）。 */
  broadcastDialog() {
    this.app.voiceBroadcast('voice:dialog', {
      on: !!this.dialog,
      thinking: !!this.thinking,
      wakeEnabled: V.wakeEnabledOf(this.app.store.get().voice),
    });
  }

  /** 听/识别期间压低 BGM（否则自己的音乐会被麦克风收进去污染识别）。 */
  applyDucking(on) {
    if (on === this._ducking) return;
    const prefs = V.normalizeVoicePrefs(this.app.store.get().voice);
    if (prefs && prefs.duckBgm === false) return;
    this._ducking = on;
    this.app.send('audio:duck', { on });
  }

  /* ---------------- 崩溃恢复（3 次 / 10 分钟，照 bug修炼手册 的退避思路） ---------------- */

  onAsrCrash(reason) {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 10 * 60 * 1000);
    if (this.restarts.length >= 3) {
      this.available = false;
      this.reason = 'crashed';
      this.error = `语音进程反复失败，已停用：${reason}`;
      this.log('voice disabled after repeated failures');
      return;
    }
    this.restarts.push(now);
    this.ready = false;
    this.modelReady = false;
    this.thinking = false;
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = 0; }
    // ⚠ 故意**不动 this.dialog**：用户点过 🎤 就是想继续对话，重建后由 asr:ready 自动接上。
    if (this.readyWatch) { clearTimeout(this.readyWatch); this.readyWatch = 0; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = 0; }
    if (this.win && !this.win.isDestroyed()) { this.win.destroy(); this.win = null; }
    setTimeout(() => { try { this.init(); } catch (e) { this.log('restart failed', e && e.message); } }, 1200);
  }

  /* ---------------- 对外接口（main.js 的 IPC 直接转发到这里） ---------------- */

  status() {
    const want = (this.modelEntry(this.app.store.get().voice) || {}).id || CFG.voice.model;
    const limit = Math.max(1000, Number(CFG.voice.readyTimeoutMs) || 20000);
    // loading = 模型齐全、确实在加载（还在合理等待窗口内）→ UI 该说"稍等"而不是"不可用"
    const loading = this.available && !this.modelReady && this.initStartedAt > 0 &&
      (Date.now() - this.initStartedAt < limit);
    return {
      available: this.available && this.modelReady,
      engine: CFG.voice.engine,
      model: this.activeModelId || want,
      configuredModel: want,        // 配置里选的档位
      fallbackFrom: this.fallbackFrom || '', // 非空 = 配置的档位没装，正在用别的档位顶替
      modelReady: this.modelReady,
      loading,
      kwsReady: this.kwsReady,
      retries: this.readyRetries,
      stage: this.lastStage,
      reason: this.reason,
      error: this.error,
      state: this.lastState,
      // 语音对话会话（取代原来的 mode）：dialog = 是否在连续对话中；thinking = 正在等模型
      dialog: !!this.dialog,
      thinking: !!this.thinking,
      wakeEnabled: V.wakeEnabledOf(this.app.store.get().voice),
    };
  }

  devices() {
    return { ok: true, devices: this.deviceList.slice() };
  }

  /** 进入语音对话（聊天窗 🎤）。进入后自动连续多轮，直到 stopDialog()。 */
  startDialog(opts) {
    if (!this.available || !this.modelReady) {
      return { ok: false, error: this.reason === 'no-model' ? 'no-model' : 'not-ready' };
    }
    this.dialog = true;
    this.thinking = false;
    this.sendToAsr('asr:start', { session: 'dialog', deviceId: (opts && opts.deviceId) || '' });
    this.broadcastDialog();
    return { ok: true };
  }

  /** 退出语音对话（🎤 再点一次）。若开着后台唤醒，麦克风会留在被动监听状态。 */
  stopDialog() {
    this.dialog = false;
    this.thinking = false;
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = 0; }
    this.sendToAsr('asr:stop');
    this.applyDucking(false);
    this.broadcastDialog();
    return { ok: true };
  }

  /** 是否正在语音对话（取代原来的 isUserActive）。 */
  isDialogOn() {
    return !!this.dialog;
  }

  /**
   * 立即提交当前这一句（不等静音断句）。
   * 用途：聊天窗内「按住说话」**松开**时 —— 用户松手就是"我说完了"，
   * 不该再罚他等 config.voice.endpointSilenceMs（1.2 秒）才提交。
   * 与 stopDialog() 的区别：**不退出会话**，提交完由 asr:resume 继续听。
   */
  flushUtt() {
    this.sendToAsr('asr:flush');
    return { ok: true };
  }

  /** 偏好变化（唤醒词/唤醒开关/设备/档位）→ 重建 init（换档位要重载模型，换唤醒词只需重写关键词）。 */
  applyPrefs(prefs) {
    if (!this.available) return;
    const m = this.resolveModel(prefs);
    if (!m.ok) { this.available = false; this.reason = 'no-model'; return; }
    const kws = this.resolveKws();
    this.kwsReady = !!kws.ok;
    this.sendToAsr('asr:reconfigure', this.buildInitPayload(m, kws, prefs));
    this.broadcastDialog();   // 唤醒开关变了 → 聊天窗的状态提示也要跟着变
  }

  /** 用户主动重试（语音聊天设置里的"重试"按钮）：立刻重建识别进程。 */
  retry() {
    this.readyRetries = 0;   // 用户主动请求 = 重新给满配额
    this.restarts = [];      // 也清掉"崩溃冷却"计数，否则被停用后再也起不来
    this.error = '';
    if (this.available && this.modelReady) { this.rebuild('user-retry'); return this.status(); }
    this.ensureReady(true);
    return this.status();
  }

  shutdown() {
    if (this.prewarmTimer) { clearTimeout(this.prewarmTimer); this.prewarmTimer = 0; }
    if (this.readyWatch) { clearTimeout(this.readyWatch); this.readyWatch = 0; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = 0; }
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = 0; }
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.dialog = false;
    this.thinking = false;
  }
}

module.exports = { VoiceService, findModelFile };
