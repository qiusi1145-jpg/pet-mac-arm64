'use strict';
/**
 * 语音采集 + 识别（跑在**隐藏渲染进程**里；不是主进程、也不是宠物窗）。
 *
 * 为什么单独一个进程：
 *   · 主进程每 16ms 推光标、驱动像素穿透判定 —— 一次同步 ONNX 推理就会让"点不动"复发；
 *   · 与宠物窗隔离 —— 推理再重也不会抖到动画/命中判定；
 *   · 采集与推理同处一进程 → **PCM 一次都不跨进程**（路线 A 最大的工程优势）。
 *
 * 数据流：
 *   getUserMedia → AudioWorklet(20ms 帧) → ①KWS 唤醒检测 ②识别流 → 端点判定
 *   文本经 ipcRenderer.send('asr:event', …) 交给主进程 → ChatOrchestrator（channel='voice'）
 *
 * 依赖 sherpa-onnx-node（Node-API 原生插件）。加载失败**不抛给用户**，而是回报
 * asr:error{fatal} → 主进程降级（禁用语音并提示），其余功能完全不受影响。
 */
const { ipcRenderer } = require('electron');
const V = require('../shared/voice');

const send = (channel, payload) => ipcRenderer.send('asr:event', { channel, payload });
const dbg = (...a) => { if (process.env.PET_DEBUG) console.log('[asr]', ...a); };
/** 阶段上报：任何一步卡住都能在主进程日志里指出卡在哪（否则只剩一句"还没准备好"）。 */
const stage = (s) => { dbg('stage:', s); send('asr:stage', { stage: s }); };

let sherpa = null;
let cfg = null;
let recognizer = null;      // OnlineRecognizer | OfflineRecognizer
let kws = null;             // KeywordSpotter
let stream = null;          // 识别流
let kwsStream = null;
let media = null;
let audioCtx = null;
let srcNode = null;
let tapNode = null;         // 采集节点（worklet 或 scriptprocessor）
let capturing = false;
let utt = false;            // 当前是否在采集"一句话"
let wakeArmed = false;      // 是否启用唤醒词监听（被动等待）
// ★ 会话（2026-09-16 取代原来的 4 种"触发方式"）：
//   null      = 没有语音会话（只可能还有后台唤醒监听）
//   'dialog'  = 聊天窗 🎤 进入的**语音对话**：自动连续多轮，提交后停麦等模型，回复到了自动续听
//   'oneshot' = 唤醒词叫醒后的**一轮**问答（说完就回到被动等待）
let session = null;
let voicedMs = 0;           // 本句的"有效人声"累计毫秒（用于"过短不请求大模型"判定）
let lastPartial = '';
let endpointer = null;
let lastState = '';
let stateThrottle = 0;

/** 一帧的毫秒数（与 pcm-worklet / ScriptProcessor 的分帧一致，用于人声时长统计）。 */
const FRAME_MS = 20;
/** RMS 超过它就算"这一帧有人在说话"（与 beginUtt 里给端点检测的阈值保持一致）。 */
const VOICE_RMS = 0.02;

/* ================= 初始化 ================= */

function loadSherpa() {
  try {
    // eslint-disable-next-line global-require
    sherpa = require('sherpa-onnx-node');
    return true;
  } catch (e) {
    send('asr:error', { code: 'require-failed', message: (e && e.message) || 'native addon load failed', fatal: true });
    return false;
  }
}

/**
 * sherpa 流式端点规则（单位：秒）。**由 config.voice.endpointSilenceMs 推导**，不再写死：
 *  · rule1 = 还没解出任何 token 时的静音上限（纯环境音/噪音）→ 取 2 倍，别急着在噪音里收尾；
 *  · rule2 = 已经解出内容后的静音上限 → **就是用户体感的"说完停多久"**（当前默认 1.2s）；
 *  · rule3 = 单句硬上限（防呆，单位是帧数）。
 * 以前这里是硬编码 2.4/1.2，于是设置里的"静音多久算说完"其实对流式识别**完全无效**。
 */
function endpointRules() {
  const sec = Math.max(0.3, (Number(cfg.endpointSilenceMs) || 1200) / 1000);
  return {
    rule1MinTrailingSilence: Math.round(sec * 2 * 10) / 10,
    rule2MinTrailingSilence: Math.round(sec * 10) / 10,
    rule3MinUtteranceLength: 20,
  };
}

function buildRecognizer() {
  const sr = cfg.sampleRate;
  const featConfig = { sampleRate: sr, featureDim: 80 };
  const kind = cfg.model.kind || (cfg.model.streaming ? 'transducer' : 'senseVoice');
  if (kind === 'transducer') {
    recognizer = new sherpa.OnlineRecognizer({
      featConfig,
      modelConfig: {
        transducer: { encoder: cfg.model.encoder, decoder: cfg.model.decoder, joiner: cfg.model.joiner },
        tokens: cfg.model.tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      ...endpointRules(),
    });
  } else if (kind === 'zipformer2Ctc') {
    // 流式 CTC：**单文件**模型（不是三件套）；tokens 是 BPE，必须一起给 bpeVocab，否则认不出字
    recognizer = new sherpa.OnlineRecognizer({
      featConfig,
      modelConfig: {
        zipformer2Ctc: { model: cfg.model.single },
        tokens: cfg.model.tokens,
        ...(cfg.model.bpeVocab ? { bpeVocab: cfg.model.bpeVocab } : {}),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      ...endpointRules(),
    });
  } else {
    // SenseVoice 等：非流式（说完再出字），靠自己的端点判定决定何时送识别
    const OfflineRecognizer = sherpa.OfflineRecognizer;
    if (!OfflineRecognizer) throw new Error('该构建不含 OfflineRecognizer（非流式档位不可用）');
    recognizer = new OfflineRecognizer({
      featConfig,
      modelConfig: {
        senseVoice: { model: cfg.model.single, language: 'zh', useInverseTextNormalization: 1 },
        tokens: cfg.model.tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    });
  }
  stream = recognizer.createStream();
}

function buildKws() {
  kws = null;
  kwsStream = null;
  if (!cfg.kws || !cfg.kws.keywordsFile) return;
  if (!sherpa.KeywordSpotter) return;
  try {
    kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: cfg.sampleRate, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: cfg.kws.encoder, decoder: cfg.kws.decoder, joiner: cfg.kws.joiner },
        tokens: cfg.kws.tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile: cfg.kws.keywordsFile,
      keywordsScore: cfg.kws.boost,
      keywordsThreshold: cfg.kws.threshold,
      maxActivePaths: 4,
      numTrailingBlanks: 1,
    });
    kwsStream = kws.createStream();
    dbg('kws ready', cfg.kws.keywordsFile);
  } catch (e) {
    kws = null; kwsStream = null;
    send('asr:error', { code: 'kws-failed', message: (e && e.message) || 'kws init failed', fatal: false });
  }
}

/** 唤醒/常听模式需要持续占用麦克风；仅 PTT 时按需开。 */
/**
 * 是否需要"麦克风常驻"（= 后台被动监听唤醒词）。
 * 语音对话是**运行期会话**（session='dialog'），不靠这个判断，见 micShouldStayOn()。
 */
function wantsContinuousMic() {
  return cfg.wakeEnabled !== false;
}

/** 当前这一刻麦克风该不该保持开着（决定 finishUtt 之后要不要停采集）。 */
function micShouldStayOn() {
  if (session === 'dialog') return false;   // 语音对话：提交后**停麦**等模型，由 asr:resume 重新开
  return wantsContinuousMic();
}

/** 重新计算"是否在被动等待唤醒"：语音对话进行中不监听唤醒词（否则自己的话会被当成唤醒词）。 */
function armWake() {
  wakeArmed = !!cfg.wakeEnabled && session !== 'dialog';
}

/* ================= 采集 ================= */

async function ensureCapture() {
  if (capturing) return true;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: cfg.deviceId ? { exact: cfg.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (e) {
    send('asr:error', { code: 'no-mic', message: (e && e.message) || 'microphone unavailable', fatal: false });
    return false;
  }
  try {
    audioCtx = new AudioContext({ sampleRate: cfg.sampleRate });
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    srcNode = audioCtx.createMediaStreamSource(media);
    await attachTap();
    capturing = true;
    // 不再额外报一次 'idle'：第一帧到达时就会报正确的状态，
    // 否则宠物窗的"在听"标识会先闪一下再亮（多余的一次状态抖动）。
    armTapWatchdog();
    return true;
  } catch (e) {
    send('asr:error', { code: 'audio-init', message: (e && e.message) || 'audio init failed', fatal: false });
    return false;
  }
}

/**
 * 采集节点。两条路径，**以"是否真收到帧"为准**，不假设哪条一定行：
 *   ① AudioWorklet —— 不占主线程（首选）
 *   ② ScriptProcessorNode —— 兼容性兜底（已废弃但到处都能跑）
 * 实测教训：某些环境里 AudioWorklet 的 `process()` **压根不会被调用**（模块加载成功、图也接了，
 * 就是 0 帧，且不报任何错）→ 于是这里挂一个看门狗：1.5 秒内没收到帧就自动换成 ②。
 */
let tapKind = '';      // 'worklet' | 'script' | ''
let frameCount = 0;    // 收到的音频帧数（回退判定 + 诊断用）
let tapWatchdog = 0;

async function attachTap() {
  try {
    await audioCtx.audioWorklet.addModule('./pcm-worklet.js');
    tapNode = new AudioWorkletNode(audioCtx, 'pcm-worklet');
    tapNode.port.onmessage = (ev) => { if (ev.data) onFrame(ev.data); };
    srcNode.connect(tapNode);
    // ★ 必须把 worklet 接进"通向 destination"的图里！Chromium 只驱动能到达输出端的音频节点，
    //   光 connect(srcNode → worklet) 而 worklet 不连下游 → process() 不会被调用、一帧都拿不到。
    //   用 0 增益 sink 兜到 destination：图是通的、完全静音、不会外放。
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    tapNode.connect(sink);
    sink.connect(audioCtx.destination);
    tapKind = 'worklet';
    dbg('using AudioWorklet');
    return;
  } catch (e) {
    dbg('AudioWorklet 不可用，改用 ScriptProcessor：', e && e.message);
  }
  attachScriptTap();
}

/** 兜底路径：ScriptProcessorNode（回调在主线程，但兼容性最好；实测本机只有它能出声）。 */
function attachScriptTap() {
  tapKind = 'script';
  tapNode = audioCtx.createScriptProcessor(1024, 1, 1); // 48k 下约 21ms；浏览器会自动重采样到 16k
  tapNode.onaudioprocess = (ev) => {
    const ch = ev.inputBuffer.getChannelData(0);
    onFrame(new Float32Array(ch)); // 必须复制：inputBuffer 会被复用
  };
  srcNode.connect(tapNode);
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  tapNode.connect(sink);
  sink.connect(audioCtx.destination);
  dbg('using ScriptProcessor');
}

/** 看门狗：起采 1.5 秒仍 0 帧 → 说明这条路径根本没被驱动，换另一条重试一次。 */
function armTapWatchdog() {
  if (tapWatchdog) clearTimeout(tapWatchdog);
  tapWatchdog = setTimeout(() => {
    tapWatchdog = 0;
    if (frameCount > 0) return;
    dbg(`⚠ ${tapKind} 路径 1.5 秒 0 帧 → 自动回退`);
    send('asr:stage', { stage: `tap-fallback-from-${tapKind}` });
    try { if (tapNode) { tapNode.port && (tapNode.port.onmessage = null); tapNode.disconnect(); } } catch { /* 忽略 */ }
    tapNode = null;
    if (audioCtx && srcNode) attachScriptTap();
  }, 1500);
}

function stopCapture() {
  if (tapWatchdog) { clearTimeout(tapWatchdog); tapWatchdog = 0; }
  try { if (tapNode) { tapNode.port && (tapNode.port.onmessage = null); tapNode.onaudioprocess = null; tapNode.disconnect(); } } catch { /* 已断开 */ }
  try { if (srcNode) srcNode.disconnect(); } catch { /* 已断开 */ }
  try { if (media) media.getTracks().forEach((t) => t.stop()); } catch { /* 已结束 */ }
  try { if (audioCtx) audioCtx.close(); } catch { /* 已关闭 */ }
  tapNode = null; srcNode = null; media = null; audioCtx = null;
  tapKind = ''; frameCount = 0;
  capturing = false;
}

/* ================= 帧处理 ================= */

function onFrame(frame) {
  frameCount++;
  if (frameCount === 1) stage(`tap-${tapKind}-active`); // 第一条帧到了 → 证明采集路径真的在工作
  if (tapWatchdog && frameCount > 0) { clearTimeout(tapWatchdog); tapWatchdog = 0; }
  const rms = V.rmsOf(frame);
  // 状态回报（节流：约每 100ms 一次，别让 IPC 变成负担）
  const now = Date.now();
  if (now - stateThrottle > 100) {
    stateThrottle = now;
    reportState(utt ? 'decoding' : (wakeArmed ? 'listening' : 'idle'), rms, true);
  }
  // ① 唤醒词（只在"没在说一句话"时听，避免把自己的话当作唤醒词）
  if (kws && kwsStream && wakeArmed && !utt) feedKws(frame);
  // ② 识别
  if (!utt) return;
  // 有效人声计时：给"过短不请求大模型"用（这帧有声音就记 20ms）
  if (rms >= VOICE_RMS) voicedMs += FRAME_MS;
  feedAsr(frame, rms);
}

function feedKws(frame) {
  try {
    kwsStream.acceptWaveform({ samples: frame, sampleRate: cfg.sampleRate });
    while (kws.isReady(kwsStream)) kws.decode(kwsStream);
    const r = kws.getResult(kwsStream);
    if (r && r.keyword) {
      kws.reset(kwsStream);
      onWake(r.keyword);
    }
  } catch (e) {
    dbg('kws feed failed', e && e.message);
  }
}

/**
 * 唤醒词命中 → 开始"一轮"问答（session='oneshot'）。
 * 语音对话（session='dialog'）进行中不会走到这里：那时 wakeArmed=false，
 * 否则自己的话很容易被当成唤醒词。
 */
function onWake(keyword) {
  dbg('wake detected', keyword);
  send('asr:wake', { word: keyword });
  if (!session) session = 'oneshot';
  beginUtt();
}

function feedAsr(frame, rms) {
  try {
    if (cfg.model.streaming) {
      stream.acceptWaveform({ samples: frame, sampleRate: cfg.sampleRate });
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const text = (recognizer.getResult(stream) || {}).text || '';
      if (cfg.showPartial && text && text !== lastPartial) {
        lastPartial = text;
        send('asr:partial', { text });
      }
      if (recognizer.isEndpoint(stream)) finishUtt();
    } else {
      // 非流式（SenseVoice）：整段攒着，靠自己算的端点决定何时送识别
      stream.acceptWaveform({ samples: frame, sampleRate: cfg.sampleRate });
      const ev = endpointer.push(rms);
      if (ev === 'end' || ev === 'timeout') finishUtt();
    }
  } catch (e) {
    send('asr:error', { code: 'decode', message: (e && e.message) || 'decode failed', fatal: false });
    utt = false;
  }
}

function beginUtt() {
  if (utt) return;
  // 复位识别流：换一句话必须从干净状态开始（否则上一句的文本会粘过来）
  try { recognizer.reset(stream); } catch { /* 部分实现对 reset 无实现 */ }
  lastPartial = '';
  voicedMs = 0;
  endpointer = V.createEndpointer({
    silenceMs: cfg.endpointSilenceMs,
    maxMs: cfg.maxRecordMs,
    threshold: VOICE_RMS,
  });
  utt = true;
  reportState('decoding', 0, true);
}

/**
 * 结束一句话：取最终文本 → 判"够不够一句话" → 交主进程 → 按会话类型决定采集怎么走。
 *
 * ★ 两条关键规则（2026-09-16 用户定调）：
 *  ① **过短不请求大模型**：仅"啊"一声或一两个字（如"嗯"）→ 发 `asr:discard`，主进程不调引擎，
 *     只在状态条上轻提示。判定见 shared/voice.js judgeUtterance()（时长 + 字数双条件）。
 *  ② **语音对话里提交后要停麦**（等模型回复，这期间不做识别），由主进程 `asr:resume` 叫回来续听。
 */
function finishUtt() {
  if (!utt) return;
  utt = false;
  let text = '';
  try {
    if (cfg.model.streaming) {
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      text = (recognizer.getResult(stream) || {}).text || '';
      recognizer.reset(stream);
    } else if (endpointer && !endpointer.isTooShort()) {
      recognizer.decode(stream);
      text = (recognizer.getResult(stream) || {}).text || '';
      stream = recognizer.createStream();
    } else {
      stream = recognizer.createStream(); // 太短（咳一声）：丢弃
    }
  } catch (e) {
    dbg('finish failed', e && e.message);
  }
  lastPartial = '';
  const clean = V.normalizeTranscript(text);
  const judged = V.judgeUtterance({ voicedMs, text, thresholds: cfg });
  voicedMs = 0;
  const keepMic = micShouldStayOn();
  reportState(keepMic ? 'listening' : 'idle', 0, true);
  if (judged.ok) send('asr:final', { text: clean, raw: text });
  else send('asr:discard', { reason: judged.reason, text: clean });
  // 采集策略：语音对话 → 停麦等模型；其它情况看"是否后台监听唤醒词"
  if (!keepMic) stopCapture();
}

function reportState(state, rms, force) {
  if (!force && state === lastState) return;
  lastState = state;
  send('asr:state', { state, rms: rms || 0 });
}

/* ================= 主进程指令 ================= */

ipcRenderer.on('asr:init', async (_e, payload) => {
  cfg = payload;
  stage('init-received');
  if (!loadSherpa()) { stage('require-failed'); return; }
  stage('require-ok');
  try {
    buildRecognizer();
  } catch (e) {
    stage('model-load-failed');
    send('asr:error', { code: 'model-load', message: (e && e.message) || 'model load failed', fatal: true });
    return;
  }
  stage('recognizer-ok');
  buildKws();
  stage(kws ? 'kws-ok' : 'kws-skipped');
  armWake();
  // 设备枚举**不能挡住 ready**：无权限/驱动异常时它可能长时间不返回。
  // 先报 ready（后面的可用性由 status/错误回报体现），枚举最多等 3 秒。
  devices = await listDevices();
  stage('devices-ok');
  send('asr:ready', { devices, kws: !!kws, wakeEnabled: wantsContinuousMic() });
  stage('ready-sent');
  if (wantsContinuousMic()) await ensureCapture();
});

let devices = [];

/** 枚举音频输入设备（最多等 3 秒；失败/超时返回空数组，绝不阻塞就绪）。 */
async function listDevices() {
  try {
    const list = await Promise.race([
      navigator.mediaDevices.enumerateDevices(),
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    if (!list) return [];
    return list.filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `麦克风 ${i + 1}` }));
  } catch {
    return [];
  }
}

ipcRenderer.on('asr:prewarm', async () => {
  // 预热：构造空白流跑一次空解码，把算子/内存池先热起来（首次说话少等 1~2s）
  if (!recognizer) return;
  try {
    const s = recognizer.createStream();
    s.acceptWaveform({ samples: new Float32Array(cfg.sampleRate / 10), sampleRate: cfg.sampleRate });
    while (recognizer.isReady(s)) recognizer.decode(s);
    dbg('prewarmed');
  } catch (e) { dbg('prewarm failed', e && e.message); }
});

ipcRenderer.on('asr:start', async (_e, opts) => {
  if (!recognizer) { send('asr:error', { code: 'not-ready', message: 'recognizer not ready', fatal: false }); return; }
  // 'dialog' = 聊天窗 🎤 进入的语音对话（连续多轮）；其余一律当"单轮"
  session = (opts && opts.session) === 'dialog' ? 'dialog' : 'oneshot';
  if (opts && opts.deviceId && opts.deviceId !== cfg.deviceId) {
    cfg.deviceId = opts.deviceId;
    stopCapture();
  }
  armWake();
  if (!(await ensureCapture())) return;
  beginUtt();
});

/** 退出语音会话（🎤 再点一次）：立刻结束当前这句、按"是否后台唤醒"决定麦克风留不留。 */
ipcRenderer.on('asr:stop', () => {
  session = null;
  armWake();
  if (utt) finishUtt();
  else if (!wantsContinuousMic()) stopCapture();
});

/**
 * 立即提交当前这一句（聊天窗内**「按住说话」松开**时用）。
 * 用户松手就是"我说完了" —— 不该再罚他等 1.2 秒静音断句。
 * 与 asr:stop 的区别：**不退出会话**，提交完照常由主进程 asr:resume 接着听下一句。
 * （若这句话太短，finishUtt 内部会走"过短丢弃"分支，不会去打扰大模型。）
 */
ipcRenderer.on('asr:flush', () => {
  if (utt) finishUtt();
});

/**
 * ★ 语音对话的"接着听"：模型回复到了（或这轮被判定为过短而丢弃）之后由主进程叫醒。
 * 只有仍在 dialog 里才响应 —— 用户可能已经点了 🎤 退出。
 */
ipcRenderer.on('asr:resume', async () => {
  if (session !== 'dialog') return;
  if (!(await ensureCapture())) return;
  if (!utt) beginUtt();
});

ipcRenderer.on('asr:reconfigure', async (_e, payload) => {
  const prev = cfg;
  cfg = payload;
  const modelChanged = !prev || prev.model.streaming !== cfg.model.streaming ||
    prev.model.encoder !== cfg.model.encoder || prev.model.single !== cfg.model.single;
  try {
    if (modelChanged) {
      stopCapture();
      buildRecognizer();
    }
    buildKws();
  } catch (e) {
    send('asr:error', { code: 'reconfigure', message: (e && e.message) || 'reconfigure failed', fatal: false });
    return;
  }
  const wasWaking = wakeArmed;
  armWake();
  if (cfg.deviceId !== prev.deviceId) { stopCapture(); }
  // 语音对话进行中：麦克风的开关由会话逻辑管（别在这里把它关掉 / 重开成被动监听）
  if (session !== 'dialog') {
    if (wakeArmed || wasWaking) await ensureCapture();
    if (!wakeArmed) stopCapture();
  }
  send('asr:ready', { devices: [], kws: !!kws, wakeEnabled: wantsContinuousMic(), reconfigured: true });
});

window.addEventListener('beforeunload', () => { try { stopCapture(); } catch { /* 退出中 */ } });
