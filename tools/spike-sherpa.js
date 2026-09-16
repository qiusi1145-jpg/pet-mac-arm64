'use strict';
/**
 * 语音自检（**不需要麦克风、不需要窗口**，纯 Node 就能跑）——`npm run voice:spike`
 *
 * 四步：
 *   ① 能否 require sherpa-onnx-node（Node-API ABI 是否兼容当前运行时）
 *   ② 关键类是否齐全（OnlineRecognizer / OfflineRecognizer / KeywordSpotter / Vad）
 *   ③ 模型 / 唤醒词模型文件是否齐全 + **唤醒词音素 token 是否真在 KWS 词表里**
 *   ④ ★ **端到端真识别**：读模型自带的 test_wavs/*.wav，喂给识别器，打印识别出的文本
 *      —— 这一步不碰麦克风也能证明"整条识别链路是通的"，是排查"识别不了"最直接的证据。
 *
 * 用 Electron 运行时跑同一条命令也安全（不建窗口）：
 *   node tools/spike-sherpa.js            # 系统 Node
 *   npm run voice:spike:electron          # Electron 运行时（验证 ABI 兼容）
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { CFG } = require(path.join(ROOT, 'src', 'shared', 'config'));
const V = require(path.join(ROOT, 'src', 'shared', 'voice'));
const { VoiceService } = require(path.join(ROOT, 'src', 'main', 'voiceService'));

const say = (s) => console.log(s);
const ok = (s) => say(`  ✓ ${s}`);
const bad = (s) => say(`  ✗ ${s}`);
const info = (s) => say(`    ${s}`);

let fails = 0;

/** 只提供自检所需能力的 PetApp 替身（resolveModel/resolveKws 只用这些）。 */
const fakeApp = {
  userDataRoot: path.join(ROOT, 'data'),
  store: { get: () => ({}) },
  send: () => {}, voiceBroadcast: () => {}, pushChatMessage: () => {},
  showIfHidden: () => {}, voiceFinal: () => {}, log: () => {},
};

say('=== 语音自检（不需要麦克风） ===');
say(`    运行时：node ${process.versions.node} / electron ${process.versions.electron || '(非 Electron)'} / ABI ${process.versions.modules}`);

/* ---- ① require ---- */
say('\n[1] require("sherpa-onnx-node")');
let sherpa = null;
try {
  // eslint-disable-next-line global-require
  sherpa = require('sherpa-onnx-node');
  ok('成功');
} catch (e) {
  bad(`失败：${e && e.message}`);
  info('→ 该运行时下路线 A 不可用（换运行时，或退回路线 B：官方预编译 exe）');
  process.exit(1);
}

/* ---- ② 关键类 ---- */
say('\n[2] 关键类');
for (const k of ['OnlineRecognizer', 'OfflineRecognizer', 'KeywordSpotter', 'Vad', 'readWave']) {
  if (sherpa[k]) ok(k); else { bad(`${k} 缺失`); fails++; }
}

/* ---- ③ 模型文件 + 唤醒词 token ---- */
const svc = new VoiceService(fakeApp);
say('\n[3] 模型文件');
const model = svc.resolveModel(null);
if (!model.ok) {
  bad(`识别模型不可用：${(model.missing || []).join(', ') || model.reason}`);
  info('→ `npm run voice:fetch`（断点续传）；慢网加 `-- --model small-ctc-zh-int8`（解压约 25MB）');
  fails++;
} else {
  ok(`识别模型齐全（结构 ${model.kind}）：${path.basename(model.dir)}`);
  if (model.fallbackFrom) info(`⚠ 配置的档位「${model.fallbackFrom}」未安装，实际使用「${(model.entry || {}).id}」`);
}
const kws = svc.resolveKws();
if (!kws.ok) {
  bad('唤醒词(KWS)模型不可用 → 唤醒功能不会生效');
  info('→ `npm run voice:fetch -- --kws`（注意它在 kws-models 这个 release，不在 asr-models）');
  fails++;
} else {
  ok(`KWS 模型齐全：${path.basename(kws.dir)}`);
  const line = V.buildKeywordLine(null);
  const vocab = new Set(fs.readFileSync(kws.tokens, 'utf8').split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean));
  const chk = V.wakeTokenCheck(line, vocab);
  if (!line) { bad('当前唤醒词没有音素串 → 唤醒必然不生效'); fails++; }
  else if (chk.missing.length) {
    bad(`唤醒词「${chk.word}」有 token 不在词表里：${chk.missing.join(' ')} → 永远匹配不上`);
    fails++;
  } else ok(`唤醒词「${chk.word}」${chk.total} 个 token 全部命中词表（${vocab.size} 个 token）`);
  info(`关键词串：${line}`);
}

/* ---- ④ 端到端真识别（不需要麦克风） ---- */
say('\n[4] 端到端识别（模型自带 test_wavs，不碰麦克风）');
if (model && model.ok) {
  const wavDir = path.join(model.dir, 'test_wavs');
  let wav = null;
  try {
    wav = fs.readdirSync(wavDir).filter((n) => /\.wav$/i.test(n)).sort()[0] || null;
  } catch { /* 没有 test_wavs */ }
  if (!wav) {
    info(`跳过：${path.relative(ROOT, wavDir)} 里没有 wav`);
  } else {
    const wavPath = path.join(wavDir, wav);
    try {
      const featConfig = { sampleRate: CFG.voice.sampleRate, featureDim: 80 };
      const mc = { tokens: model.tokens, numThreads: 1, provider: 'cpu', debug: 0 };
      if (model.kind === 'transducer') {
        mc.transducer = { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner };
      } else if (model.kind === 'zipformer2Ctc') {
        mc.zipformer2Ctc = { model: model.model };
        if (model.bpeVocab) mc.bpeVocab = model.bpeVocab;
      } else {
        mc.senseVoice = { model: model.model, language: 'zh', useInverseTextNormalization: 1 };
      }
      const rec = new sherpa.OnlineRecognizer({
        featConfig, modelConfig: mc, decodingMethod: 'greedy_search',
        enableEndpoint: true, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
      });
      // 不用 sherpa.readWave：Electron 里它返回外部缓冲会抛 "External buffers are not allowed"；
      // 自己解析 WAV（单声道 16-bit PCM）最稳，两种运行时都通。
      const wave = V.parseWavPcm16(fs.readFileSync(wavPath));
      if (!wave) throw new Error('WAV 解析失败（只支持单声道 16-bit PCM）');
      const stream = rec.createStream();
      stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
      stream.inputFinished();
      while (rec.isReady(stream)) rec.decode(stream);
      const text = (rec.getResult(stream) || {}).text || '';
      info(`音频：${wav}（${(wave.samples.length / wave.sampleRate).toFixed(1)} 秒 @ ${wave.sampleRate}Hz）`);
      if (text.trim()) ok(`识别出中文：${JSON.stringify(text)}`);
      else { bad('识别结果为空 → 模型能加载但出不了字（检查 tokens 与 bpeVocab 是否配套）'); fails++; }
    } catch (e) {
      bad(`识别失败：${(e && e.message) || e}`);
      fails++;
    }
  }
} else {
  info('跳过（模型不可用）');
}

say(`\n=== 结论：${fails ? `${fails} 项未通过，见上面每条的 → 提示` : '全部通过（含端到端识别出中文）'} ===`);
process.exit(fails ? 1 : 0);
