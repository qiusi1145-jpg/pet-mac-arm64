'use strict';
/**
 * 语音链路诊断（由 `npm run voice:diag` = `electron . --voice-diag` 触发）。
 *
 * 设计原则：**诊断必须跑生产代码路径**。
 * 早期版本自己搭了个窗口来测，结果"自己搭的路径通、App 真实路径不通"——诊断给了假安全感。
 * 现在改成：直接用 App 同款 `VoiceService`（同款窗口参数、同款 asr:init 载荷、同款 asr.js），
 * 只把 PetApp 换成替身（因此**不需要宠物窗**，也就不会打扰用户）。
 *
 * 报告内容：
 *   ①② 原生插件 + 关键类
 *   ③  识别模型 / KWS 模型文件 + **唤醒词音素 token 是否真在词表里**
 *   ④ ★ **真实初始化**：VoiceService.init() → 等 asr:ready，打印每一步阶段与耗时、失败原因
 *   ⑤  音频链路：init 后若按"唤醒/常听"模式会自动开麦，观察 asr:state 的 RMS（有电平 = 麦克风真在给数据）
 *   ⑥  端到端识别：读模型自带 test_wavs 跑一次真识别（不碰麦克风）
 */
const path = require('path');
const fs = require('fs');
const { app, session, ipcMain } = require('electron');
const { CFG } = require('../shared/config');
const V = require('../shared/voice');
const { VoiceService } = require('./voiceService');

let sherpa = null;

async function runVoiceDiag({ dataDir }) {
  const out = [];
  const say = (s) => { out.push(s); console.log(s); };
  const ok = (s) => say(`  ✓ ${s}`);
  const bad = (s) => say(`  ✗ ${s}`);
  const info = (s) => say(`    ${s}`);
  let fails = 0;

  say('=== 语音链路诊断（跑 App 真实初始化路径；会开麦约 3 秒） ===');
  say(`    electron ${process.versions.electron} / node ${process.versions.node} / ABI ${process.versions.modules}`);

  /* ---- ①② 原生插件 ---- */
  say('\n[1] require("sherpa-onnx-node")');
  try {
    // eslint-disable-next-line global-require
    sherpa = require('sherpa-onnx-node');
    ok('成功');
  } catch (e) {
    bad(`失败：${e && e.message}`);
    fails++;
  }
  if (sherpa) {
    const need = ['OnlineRecognizer', 'OfflineRecognizer', 'KeywordSpotter', 'Vad', 'readWave'];
    const miss = need.filter((k) => !sherpa[k]);
    if (miss.length) { bad(`关键类缺失：${miss.join(', ')}`); fails++; } else ok(`关键类齐全：${need.join(', ')}`);
  }

  /* ---- 事件收集 + 转发给 VoiceService（真实 App 里这一步由 main.js 做） ---- */
  const events = [];
  let svc = null;
  ipcMain.on('asr:event', (_e, msg) => {
    if (!msg) return;
    events.push({ ...msg, t: Date.now() });
    // ★ 必须转发给 VoiceService，否则它的 status/modelReady/阶段/audioBroadcast 全是死的
    //   （诊断早期版本漏了这一步，导致"音频链路"误报"没启动"）
    if (svc) { try { svc.onAsrMessage(msg.channel, msg.payload); } catch { /* 忽略 */ } }
  });

  /* ---- 造一个 PetApp 替身：只提供 VoiceService 需要的东西 → 不需要宠物窗 ---- */
  const voiceStates = [];
  const fakeApp = {
    userDataRoot: dataDir,
    store: { get: () => ({}), update: () => ({ saveNow: () => {} }) },
    send: () => {},
    voiceBroadcast: (ch, p) => { if (ch === 'voice:state') voiceStates.push(p); },
    pushChatMessage: () => {}, showIfHidden: () => {},
    voiceFinal: (text) => { say(`    （识别编排器收到文本：${JSON.stringify(text)}）`); },
    log: (...a) => { if (process.env.PET_DEBUG) console.log('[voice]', ...a); },
  };

  /* ---- ③ 模型文件 ---- */
  svc = new VoiceService(fakeApp);
  say('\n[2] 识别模型 / KWS 模型（走 App 同款解析逻辑）');
  const model = svc.resolveModel(null);
  if (!model.ok) { bad(`识别模型不可用：${(model.missing || []).join(', ') || model.reason}`); fails++; }
  else {
    ok(`识别模型齐全（结构 ${model.kind}）：${path.basename(model.dir)}`);
    if (model.fallbackFrom) info(`⚠ 配置档位「${model.fallbackFrom}」未安装，实际使用「${(model.entry || {}).id}」`);
  }
  const kws = svc.resolveKws();
  if (!kws.ok) { bad('KWS 模型不可用 → 唤醒不会生效'); fails++; }
  else {
    ok(`KWS 模型齐全：${path.basename(kws.dir)}`);
    const line = V.buildKeywordLine(null);
    const vocab = new Set(fs.readFileSync(kws.tokens, 'utf8').split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean));
    const chk = V.wakeTokenCheck(line, vocab);
    if (!chk.total) { bad('当前唤醒词没有音素串 → 唤醒不会生效'); fails++; }
    else if (chk.missing.length) { bad(`唤醒词「${chk.word}」有 token 不在词表：${chk.missing.join(' ')}`); fails++; }
    else ok(`唤醒词「${chk.word}」${chk.total} 个 token 全部命中词表（${vocab.size} 个 token）`);
  }

  /* ---- ④ 真实初始化（★关键：这就是 App 启动时跑的那条路径） ---- */
  say('\n[3] 真实初始化 VoiceService.init()（App 同款路径）');
  const t0 = Date.now();
  svc.installPermissionHandler();
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(true));
  svc.init();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (events.some((m) => m.channel === 'asr:ready')) break;
    if (events.some((m) => m.channel === 'asr:error' && m.payload && m.payload.fatal)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const stages = events.filter((m) => m.channel === 'asr:stage').map((m) => m.payload.stage);
  info(`阶段轨迹：${stages.length ? stages.join(' → ') : '(一个阶段都没上报 = 识别进程没跑起来或被拦在更早的地方)'}`);
  const readyEv = events.find((m) => m.channel === 'asr:ready');
  if (readyEv) {
    ok(`asr:ready（${Date.now() - t0}ms）设备 ${((readyEv.payload && readyEv.payload.devices) || []).length} 个，KWS ${readyEv.payload && readyEv.payload.kws ? '已加载' : '未加载'}`);
  } else {
    const errs = events.filter((m) => m.channel === 'asr:error').map((m) => `[${m.payload.code}] ${m.payload.message}`);
    bad(`30 秒内未 ready${errs.length ? `；错误：${errs.join(' | ')}` : ''}`);
    info(`status(): ${JSON.stringify(svc.status())}`);
    info('→ 若"阶段轨迹"停在某一步，那就是卡点；完全没轨迹说明识别进程没起来（看上面 did-fail-load / render-process-gone 日志）');
    fails++;
  }

  /* ---- ⑤ 音频链路（init 已按模式自动开麦） ---- */
  say('\n[4] 音频链路（init 后自动开麦；观察 asr:state 的 RMS）');
  if (readyEv) {
    await new Promise((r) => setTimeout(r, 3000));
    const peaks = voiceStates.map((s) => s.rms || 0);
    const peak = peaks.length ? Math.max(...peaks) : 0;
    const states = [...new Set(voiceStates.map((s) => s.state))];
    if (!peaks.length) { bad('没有任何 asr:state 回报 → 采集没启动'); fails++; }
    else {
      ok(`${peaks.length} 条状态回报，状态取值：${states.join('/')}，RMS 峰值 ${peak.toFixed(4)}`);
      if (peak < 0.002) info('⚠ 电平几乎为 0（没说话很正常）—— 真说话仍不出字时把这条数值发出来');
      else ok('有电平 → 麦克风真的在给数据');
    }
  } else info('跳过（未 ready）');

  /* ---- ⑥ 端到端识别（不需要麦克风） ---- */
  say('\n[5] 端到端识别（读模型自带 test_wavs，不碰麦克风）');
  if (model.ok && sherpa) {
    const wavDir = path.join(model.dir, 'test_wavs');
    let wav = null;
    try { wav = fs.readdirSync(wavDir).filter((n) => /\.wav$/i.test(n)).sort()[0] || null; } catch { /* 无 */ }
    if (!wav) info('跳过（该档位没有 test_wavs）');
    else {
      try {
        const mc = { tokens: model.tokens, numThreads: 1, provider: 'cpu', debug: 0 };
        if (model.kind === 'transducer') mc.transducer = { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner };
        else if (model.kind === 'zipformer2Ctc') { mc.zipformer2Ctc = { model: model.model }; if (model.bpeVocab) mc.bpeVocab = model.bpeVocab; }
        else mc.senseVoice = { model: model.model, language: 'zh', useInverseTextNormalization: 1 };
        const rec = new sherpa.OnlineRecognizer({
          featConfig: { sampleRate: CFG.voice.sampleRate, featureDim: 80 }, modelConfig: mc,
          decodingMethod: 'greedy_search', enableEndpoint: true,
          rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
        });
        // 不用 sherpa.readWave：它返回外部缓冲，Electron 里会抛
        // "External buffers are not allowed"（纯 Node 下正常）→ 自己解析 WAV。
        const wave = V.parseWavPcm16(fs.readFileSync(path.join(wavDir, wav)));
        if (!wave) throw new Error('WAV 解析失败（只支持单声道 16-bit PCM）');
        const st = rec.createStream();
        st.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
        st.inputFinished();
        while (rec.isReady(st)) rec.decode(st);
        const text = (rec.getResult(st) || {}).text || '';
        if (text.trim()) ok(`识别出中文：${JSON.stringify(text)}`);
        else { bad('识别结果为空'); fails++; }
      } catch (e) { bad(`识别失败：${(e && e.message) || e}`); fails++; }
    }
  } else info('跳过（模型不可用）');

  /* ---- 结论 ---- */
  say('\n=== 结论 ===');
  if (fails) say(`· 有 ${fails} 项未通过，按上面每条的"→"修`);
  else say('· 全部通过 → 重启桌宠后应可用（打开聊天窗按住 🎤 / 按设定键说话）');
  if (!readyEv) say('· [3] 没过 = "语音引擎还没准备好"就是这个原因；把上面「阶段轨迹」发出来即可定位');

  try { fs.writeFileSync(path.join(dataDir, '..', '.tmp-diag.txt'), out.join('\n'), 'utf8'); } catch { /* 忽略 */ }
  console.log('（完整结果也写到了项目根 .tmp-diag.txt）');

  // 收尾：关掉识别窗，避免进程残留
  try { svc.shutdown(); } catch { /* 忽略 */ }
  void app;
  return fails ? 1 : 0;
}

module.exports = { runVoiceDiag };
