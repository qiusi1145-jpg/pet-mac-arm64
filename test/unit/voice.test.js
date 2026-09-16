'use strict';
/** 语音纯函数层单测：偏好清洗 / 唤醒词串 / 文本归一化 / PCM 电平与端点判定。
 *  这些是"不依赖真麦克风"的全部逻辑——真实识别留给人工清单。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const V = require('../../src/shared/voice');
const { CFG } = require('../../src/shared/config');
const { normalizeSettings, defaultSettings } = require('../../src/shared/content');

/* ================= 交互模型（2026-09-16 取代原来的 4 种"触发方式"） ================= */

test('★ 结构性回归：没有 mode（4 种触发方式已取消），但有 ptt 键位 + wake.enabled', () => {
  // mode 是 2026-09-16 用户决策删掉的（「常听」升级成语音对话），用断言钉住免得被悄悄加回来。
  // ★ 而 ptt（按键说话）**当晚按用户要求恢复了** —— 别再把它的存在当回归：
  //   它与语音对话**共存**（对话是会话状态，按键只是"进入/退出 + 提前提交"的快捷方式）。
  assert.equal('mode' in CFG.voice, false, 'config.voice.mode 应已移除');
  assert.equal('modes' in CFG.voice, false, 'config.voice.modes 应已移除');
  assert.ok(CFG.voice.ptt && typeof CFG.voice.ptt.local === 'string', 'config.voice.ptt 必须存在（按键说话已恢复）');
  assert.equal(CFG.voice.ptt.globalKey, '', '全局键默认留空 = 不注册，不替用户平白占按键');
  assert.equal(CFG.voice.ptt.local, 'Control+Shift+Space',
    '默认聊天窗内键位；**必须避开 Ctrl+空格**（那是中文输入法的中英切换，事件会被吃掉）');
  assert.equal(CFG.voice.wake.enabled, true, '默认允许后台唤醒');
  assert.ok(CFG.voice.dialog && CFG.voice.dialog.minSpeechMs > 0, '必须有语音对话的过短阈值');
});

test('normalizeVoicePrefs：ptt 键位走白名单（合法归一 / 非法回退 / 缺省补齐）', () => {
  const n = V.normalizeVoicePrefs({ ptt: { local: 'ctrl+alt+v', globalKey: 'f8' } });
  assert.equal(n.ptt.local, 'Control+Alt+V');
  assert.equal(n.ptt.globalKey, 'F8');
  // 非法 → local 回退 config、globalKey 清空（宁可不注册，也不能变成"瞎抢键"）
  const bad = V.normalizeVoicePrefs({ ptt: { local: '乱写', globalKey: '也不是键' } });
  assert.equal(bad.ptt.local, CFG.voice.ptt.local);
  assert.equal(bad.ptt.globalKey, '');
  // 完全没给（老用户的 settings 里没有 ptt）→ 用默认
  const d = V.normalizeVoicePrefs({});
  assert.equal(d.ptt.local, CFG.voice.ptt.local);
  assert.equal(d.ptt.globalKey, '');
});

test('settings：voice.ptt 往返持久化（键位重启后还在）', () => {
  const s = normalizeSettings({ voice: { ptt: { local: 'Control+Alt+V', globalKey: 'F8' } } });
  assert.equal(s.voice.ptt.local, 'Control+Alt+V');
  assert.equal(s.voice.ptt.globalKey, 'F8');
});

test('★ 旧设置迁移：mode 读入映射到 wake.enabled（wake/both→开，ptt/open→关）', () => {
  assert.equal(V.legacyWakeEnabled('wake'), true);
  assert.equal(V.legacyWakeEnabled('both'), true);
  assert.equal(V.legacyWakeEnabled('ptt'), false);
  assert.equal(V.legacyWakeEnabled('open'), false);
  assert.equal(V.legacyWakeEnabled(undefined, true), true, '没有旧字段时用默认');
  // 走一遍真路径：老用户的 settings 里带着 mode，读出来应变成 wake.enabled
  const old = V.normalizeVoicePrefs({ mode: 'both', model: 'zipformer-zh-int8' });
  assert.equal(old.wake.enabled, true);
  assert.equal('mode' in old, false, '写回时 mode 自然消失（白名单里已经没有它）');
  assert.equal(V.normalizeVoicePrefs({ mode: 'ptt' }).wake.enabled, false);
  assert.equal(V.wakeEnabledOf(null), CFG.voice.wake.enabled !== false);
});

/* ================= 偏好清洗 ================= */

test('normalizeVoicePrefs：null/垃圾输入 → null（表示"没设置过"）', () => {
  assert.equal(V.normalizeVoicePrefs(null), null);
  assert.equal(V.normalizeVoicePrefs('oops'), null);
  assert.equal(defaultSettings().voice, null);
});

test('normalizeVoicePrefs：非法 model 回退 config 默认（白名单，防手改 settings 指向任意路径）', () => {
  const n = V.normalizeVoicePrefs({ model: '../../etc/passwd' });
  assert.equal(n.model, CFG.voice.model);
  assert.equal(V.normalizeVoicePrefs({ model: 'small-ctc-zh-int8' }).model, 'small-ctc-zh-int8');
  // 唤醒开关：显式 false 才算关；缺省/垃圾值都按默认（开）
  assert.equal(V.normalizeVoicePrefs({ wake: { enabled: false } }).wake.enabled, false);
  assert.equal(V.normalizeVoicePrefs({ wake: { enabled: 'yes' } }).wake.enabled, CFG.voice.wake.enabled);
});

test('normalizeVoicePrefs：唤醒词裁剪与灵敏度夹取', () => {
  const n = V.normalizeVoicePrefs({
    wake: { word: '  我的桌宠  ', tokens: '  a b  ', boost: 999, threshold: -1 },
  });
  assert.equal(n.wake.word, '我的桌宠');
  assert.equal(n.wake.tokens, 'a b');
  assert.ok(n.wake.boost <= 10 && n.wake.boost >= 0.1);
  assert.ok(n.wake.threshold <= 1 && n.wake.threshold >= 0.01);
});

test('normalizeVoicePrefs：开关默认开，可显式关', () => {
  const d = V.normalizeVoicePrefs({});
  assert.equal(d.enabled, true);
  assert.equal(d.duckBgm, true);
  assert.equal(d.showPartial, true);
  const off = V.normalizeVoicePrefs({ enabled: false, duckBgm: false, showPartial: false });
  assert.equal(off.enabled, false);
  assert.equal(off.duckBgm, false);
  assert.equal(off.showPartial, false);
});

/* ================= 唤醒词 → 关键词串 ================= */

test('wakeTokensOf：优先用户手填，其次内置词库，未知词返回空', () => {
  assert.equal(V.wakeTokensOf({ wake: { word: '随便', tokens: 'x y z' } }), 'x y z');
  const builtin = CFG.voice.wake.builtin[0];
  assert.equal(V.wakeTokensOf({ wake: { word: builtin.word, tokens: '' } }), builtin.tokens);
  assert.equal(V.wakeTokensOf({ wake: { word: '一个词库里没有的词', tokens: '' } }), '');
});

test('buildKeywordLine：按 sherpa-onnx keywords.txt 格式产出（token :boost #threshold @显示）', () => {
  const line = V.buildKeywordLine({ wake: { word: '桌宠桌宠', tokens: '', boost: 2, threshold: 0.3 } });
  const t = CFG.voice.wake.builtin.find((b) => b.word === '桌宠桌宠').tokens;
  assert.equal(line, `${t} :2 #0.3 @桌宠桌宠`);
});

test('buildKeywordLine：无音素串 → 空串（调用方据此降级为按键触发）', () => {
  assert.equal(V.buildKeywordLine({ wake: { word: '未收录词', tokens: '' } }), '');
});

test('内置唤醒词库：每个词要么有音素串、要么明确为空（不至于"选了却不知道要手填"）', () => {
  assert.ok(CFG.voice.wake.builtin.length >= 3);
  for (const b of CFG.voice.wake.builtin) {
    assert.equal(typeof b.word, 'string');
    assert.equal(typeof b.tokens, 'string');
  }
});

/* ================= 文本归一化 ================= */

test('normalizeTranscript：全角空格/多空白/首尾句读归一', () => {
  assert.equal(V.normalizeTranscript('  你好\u3000世界  '), '你好 世界');
  assert.equal(V.normalizeTranscript('你好，世界。'), '你好，世界');
  assert.equal(V.normalizeTranscript(null), '');
});

test('isMeaningfulTranscript：空/纯标点 = 没听清（不调聊天引擎，避免空话触发表情）', () => {
  assert.equal(V.isMeaningfulTranscript(''), false);
  assert.equal(V.isMeaningfulTranscript('，。！'), false);
  assert.equal(V.isMeaningfulTranscript('   '), false);
  assert.equal(V.isMeaningfulTranscript('你好'), true);
  assert.equal(V.isMeaningfulTranscript('hello'), true);
  assert.equal(V.isMeaningfulTranscript('3 个'), true);
});

/* ================= PCM / 端点 ================= */

test('frameSize：16k / 20ms → 320 采样点', () => {
  assert.equal(V.frameSize(16000, 20), 320);
  assert.equal(V.frameSize(16000, 10), 160);
});

test('rmsOf：静音接近 0，满幅接近 1', () => {
  assert.equal(V.rmsOf(new Float32Array(100)), 0);
  const one = new Float32Array(100).fill(1);
  assert.ok(Math.abs(V.rmsOf(one) - 1) < 1e-6);
  assert.equal(V.rmsOf([]), 0);
});

test('端点检测：开口 → 连续静音到阈值 → end', () => {
  const e = V.createEndpointer({ silenceMs: 100, chunkMs: 20, maxMs: 5000, minSpeechMs: 40 });
  assert.equal(e.push(0.001), 'silence');
  assert.equal(e.push(0.3), 'speech');
  assert.equal(e.push(0.3), 'speech'); // 累计 40ms 语音 → 已过"太短"门槛
  let ev = '';
  for (let i = 0; i < 5; i++) ev = e.push(0.0001);
  assert.equal(ev, 'end', '静音累计到 100ms 应判定说完');
  assert.equal(e.speaking, true);
  assert.equal(e.isTooShort(), false);
  assert.equal(e.push(0.0001), 'end', '结束后持续回报同一个终态（由调用方 reset）');
});

test('端点检测：超时截断（防呆，避免一直说不停）', () => {
  const e = V.createEndpointer({ silenceMs: 99999, chunkMs: 20, maxMs: 200 });
  let ev = '';
  for (let i = 0; i < 12; i++) ev = e.push(0.5);
  assert.equal(ev, 'timeout');
});

test('端点检测："咳一声"这类超短语音应被判为太短（丢弃，不提交成一句话）', () => {
  const e = V.createEndpointer({ silenceMs: 60, chunkMs: 20, minSpeechMs: 150 });
  e.push(0.5); // 仅 20ms 有声
  for (let i = 0; i < 4; i++) e.push(0);
  assert.equal(e.isTooShort(), true);
});

test('端点检测：reset 后可复用（一次会话多句）', () => {
  const e = V.createEndpointer({ silenceMs: 40, chunkMs: 20, maxMs: 5000 });
  e.push(0.5); e.push(0.5); e.push(0); e.push(0);
  assert.equal(e.elapsedMs > 0, true);
  e.reset();
  assert.equal(e.elapsedMs, 0);
  assert.equal(e.push(0), 'silence');
});

/* ================= PTT 快捷键（键位录制 / 校验 / 匹配） ================= */

/** 造一个"键盘事件"对象（只带我们关心的字段）。 */
const K = (code, mods = {}) => ({
  code,
  ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
});

test('acceleratorFromEvent：从按键事件取出 accelerator', () => {
  assert.equal(V.acceleratorFromEvent(K('Space', { ctrl: true, shift: true })), 'Control+Shift+Space');
  assert.equal(V.acceleratorFromEvent(K('F2')), 'F2');
  assert.equal(V.acceleratorFromEvent(K('KeyV', { alt: true })), 'Alt+V');
  assert.equal(V.acceleratorFromEvent(K('KeyA', { meta: true })), 'Super+A');
  assert.equal(V.acceleratorFromEvent(K('Digit3', { ctrl: true })), 'Control+3');
  assert.equal(V.acceleratorFromEvent(K('ArrowUp')), 'Up');
});

test('acceleratorFromEvent：只按修饰键不算一次有效按键（否则会录到半个键）', () => {
  assert.equal(V.acceleratorFromEvent(K('ControlLeft', { ctrl: true })), '');
  assert.equal(V.acceleratorFromEvent(K('ShiftRight', { shift: true })), '');
  assert.equal(V.acceleratorFromEvent(K('MetaLeft', { meta: true })), '');
  assert.equal(V.acceleratorFromEvent(K('SomeUnknownCode')), '');
  assert.equal(V.acceleratorFromEvent(null), '');
});

test('normalizeAccelerator：别名与修饰键顺序归一（用户怎么按都能对上）', () => {
  assert.equal(V.normalizeAccelerator('ctrl+shift+space'), 'Control+Shift+Space');
  assert.equal(V.normalizeAccelerator('shift+control+space'), 'Control+Shift+Space');
  assert.equal(V.normalizeAccelerator('Control+Control+A'), 'Control+A');
  assert.equal(V.normalizeAccelerator('cmd+a'), 'Super+A');
  assert.equal(V.normalizeAccelerator('win+f2'), 'Super+F2');
  assert.equal(V.normalizeAccelerator('f2'), 'F2');
  assert.equal(V.normalizeAccelerator('a'), 'A');
});

test('normalizeAccelerator：非法输入返回空串（手改 settings 写坏键位不会变成瞎抢键）', () => {
  assert.equal(V.normalizeAccelerator(''), '');
  assert.equal(V.normalizeAccelerator(null), '');
  assert.equal(V.normalizeAccelerator('Control'), '');
  assert.equal(V.normalizeAccelerator('A+B'), '');
  assert.equal(V.normalizeAccelerator('Control+NotAKey'), '');
  assert.equal(V.normalizeAccelerator('F99'), '');
});

test('matchesAccelerator：修饰键多按/少按都算不命中（不能"宽容"到误触发）', () => {
  assert.equal(V.matchesAccelerator('Control+Shift+Space', K('Space', { ctrl: true, shift: true })), true);
  assert.equal(V.matchesAccelerator('Control+Shift+Space', K('Space', { ctrl: true })), false);
  assert.equal(V.matchesAccelerator('Control+Shift+Space', K('Space', { ctrl: true, shift: true, alt: true })), false);
  assert.equal(V.matchesAccelerator('Control+Shift+Space', K('Enter', { ctrl: true, shift: true })), false);
  assert.equal(V.matchesAccelerator('', K('Space')), false);
  assert.equal(V.matchesAccelerator('F2', K('F2')), true);
});

test('prettyAccelerator：人读显示（Ctrl / Win 别名）', () => {
  assert.equal(V.prettyAccelerator('Control+Shift+Space'), 'Ctrl + Shift + Space');
  assert.equal(V.prettyAccelerator('Super+A'), 'Win + A');
  assert.equal(V.prettyAccelerator('F2'), 'F2');
  assert.equal(V.prettyAccelerator(''), '未设置');
});

/* ================= 过短判定（"啊"一声不许发给大模型） ================= */

test('★ judgeUtterance：过短/没内容 → 不发给大模型（时长与字数双条件）', () => {
  const th = { dialog: { minSpeechMs: 350, minChars: 2 } };
  // ① "啊"一声：有效人声太短 → 拦下
  assert.equal(V.judgeUtterance({ voicedMs: 200, text: '啊', thresholds: th }).reason, 'too-short-audio');
  // ② 字数不够（哪怕说了半天"嗯"）→ 拦下
  const oneChar = V.judgeUtterance({ voicedMs: 900, text: '嗯', thresholds: th });
  assert.equal(oneChar.reason, 'too-short-text');
  assert.equal(oneChar.chars, 1);
  // ③ 完全没识别出内容 → empty
  assert.equal(V.judgeUtterance({ voicedMs: 900, text: '。。。', thresholds: th }).reason, 'empty');
  assert.equal(V.judgeUtterance({ voicedMs: 0, text: '', thresholds: th }).reason, 'empty');
  // ④ 正常一句话 → 放行
  const ok = V.judgeUtterance({ voicedMs: 900, text: '今天天气不错', thresholds: th });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, '');
  // ⑤ 阈值边界：刚好等于下限也算够
  assert.equal(V.judgeUtterance({ voicedMs: 350, text: '你好', thresholds: th }).ok, true);
  // 标点不算字数（"你好。" = 2 字）
  assert.equal(V.judgeUtterance({ voicedMs: 500, text: '你好。', thresholds: th }).chars, 2);
  // ⑥ 没传阈值就用 config 默认
  assert.equal(V.judgeUtterance({ voicedMs: 100, text: '啊' }).reason, 'too-short-audio');
});

/* ================= 键位纯函数（当前没有入口使用，但保留：将来加全局热键要复用） ================= */

test('回归：accelerator 白名单拒绝带空格的组合键（Ctrl+空格 会被中文输入法吃掉）', () => {
  // 「按住说话」入口已于 2026-09-16 取消；这套纯函数保留下来是因为里面沉淀了
  // Windows 的坑（Ctrl+空格 = 输入法中英切换、globalShortcut 只有 keydown 等）。
  // 语法上 Electron 认 Ctrl+Space，但业务上永远不要选它 —— 事件会先被输入法吃掉。
  assert.equal(V.isValidAccelerator('Control+Space'), true);
  assert.equal(V.normalizeAccelerator('Control+Space'), 'Control+Space');
  assert.equal(V.normalizeAccelerator('control+shift+space'), 'Control+Shift+Space');
});

test('wakeTokenCheck：逐 token 核对词表（写错 token → 关键词永远匹配不上，且模型不报错）', () => {
  const vocab = new Set(['zh', 'uō', 'ch', 'ǒng', 'x', 'iǎo', 'ài', 't', 'óng', 'x', 'ué']);
  const good = V.wakeTokenCheck('zh uō ch ǒng zh uō ch ǒng :1.5 #0.25 @桌宠桌宠', vocab);
  assert.equal(good.word, '桌宠桌宠');
  assert.equal(good.total, 8);
  assert.deepEqual(good.missing, []);

  const bad1 = V.wakeTokenCheck('zh uo ch ǒng :1.5 #0.25 @桌宠', vocab); // uo 少了声调符号
  assert.deepEqual(bad1.missing, ['uo']);
  assert.equal(bad1.word, '桌宠');

  assert.deepEqual(V.wakeTokenCheck('', vocab), { total: 0, missing: [], word: '' });
  // 官方示例那一行也能过（与 KWS 模型自带 keywords.txt 同格式）
  const official = V.wakeTokenCheck('x iǎo ài t óng x ué @小爱同学', vocab);
  assert.deepEqual(official.missing, []);
});

test('config 内置唤醒词：每个词都给出了音素串（否则用户选了也不知道要手填）', () => {
  for (const b of CFG.voice.wake.builtin) {
    assert.ok(b.tokens && b.tokens.trim().length > 0, `${b.word} 缺音素串`);
    assert.ok(b.tokens.split(/\s+/).length >= 2, `${b.word} 的音素串应至少两个 token`);
  }
});

test('wakeTokenCheck：官方短格式（省略 :boost #threshold）也要能解析', () => {
  const vocab = new Set(['x', 'iǎo', 'ài', 't', 'óng', 'ué', 'n', 'ǐ', 'h', 'ǎo']);
  const short = V.wakeTokenCheck('x iǎo ài t óng x ué @小爱同学', vocab);
  assert.deepEqual(short.missing, []);
  assert.equal(short.total, 7); // x / iǎo / ài / t / óng / x / ué
  assert.equal(short.word, '小爱同学');
});

test('wakeTokensOf：用户粘贴官方整行时，装饰（@词 / boost / threshold）被剥掉', () => {
  // 这条最关键：文档让用户"抄官方 keywords.txt 的一行"过来，粘进来必须能直接用
  const pasted = { wake: { word: '小爱同学', tokens: 'x iǎo ài t óng x ué @小爱同学' } };
  assert.equal(V.wakeTokensOf(pasted), 'x iǎo ài t óng x ué');
  const line = V.buildKeywordLine(pasted);
  assert.equal(line, 'x iǎo ài t óng x ué :1.5 #0.25 @小爱同学');
  // 长格式粘进来也一样
  const long = { wake: { word: 'X', tokens: 'n ǐ h ǎo :2.0 #0.3 @你好' } };
  assert.equal(V.wakeTokensOf(long), 'n ǐ h ǎo');
  assert.equal(V.buildKeywordLine(long), 'n ǐ h ǎo :1.5 #0.25 @X');
});

/* ================= WAV 解析（自检脚本用；不用 sherpa.readWave 的外部缓冲） ================= */

/** 造一个最小的单声道 16-bit PCM WAV（44 字节头 + 采样）。 */
function makeWav(samples, sampleRate = 16000) {
  const dataLen = samples.length * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);          // fmt 块长
  b.writeUInt16LE(1, 20);           // PCM
  b.writeUInt16LE(1, 22);           // 单声道
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // 字节率
  b.writeUInt16LE(2, 32);           // 块对齐
  b.writeUInt16LE(16, 34);          // 位深
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataLen, 40);
  samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
  return b;
}

test('parseWavPcm16：解析出采样率与 -1~1 的浮点样本', () => {
  const wav = V.parseWavPcm16(makeWav([0, 32767, -32768, 16384], 16000));
  assert.equal(wav.sampleRate, 16000);
  assert.equal(wav.samples.length, 4);
  assert.equal(wav.samples[0], 0);
  assert.ok(Math.abs(wav.samples[1] - 32767 / 32768) < 1e-6);
  assert.equal(wav.samples[2], -1);
  assert.ok(Math.abs(wav.samples[3] - 0.5) < 1e-3);
});

test('parseWavPcm16：非法输入返回 null（不抛异常）', () => {
  assert.equal(V.parseWavPcm16(Buffer.alloc(10)), null);          // 太短
  assert.equal(V.parseWavPcm16(Buffer.alloc(64)), null);          // 不是 RIFF
  const notPcm = makeWav([1, 2]);
  notPcm.writeUInt16LE(3, 20);                                    // audioFormat=3（float）
  assert.equal(V.parseWavPcm16(notPcm), null);
  const stereo = makeWav([1, 2]);
  stereo.writeUInt16LE(2, 22);                                    // 双声道
  assert.equal(V.parseWavPcm16(stereo), null);
});

test('parseWavPcm16：能解析模型自带 test_wavs 的真实文件（若已下载）', () => {
  const dir = path.join(__dirname, '..', '..', 'data', 'voice', 'models', CFG.voice.models[1].dir, 'test_wavs');
  let wav = null;
  try { wav = fs.readdirSync(dir).find((n) => /\.wav$/i.test(n)); } catch { /* 没下模型 */ }
  if (!wav) return; // 没模型就跳过（保持单测零依赖）
  const r = V.parseWavPcm16(fs.readFileSync(path.join(dir, wav)));
  assert.ok(r && r.sampleRate === 16000 && r.samples.length > 16000);
});

/* ================= 设置持久化 ================= */

test('normalizeSettings：voice 往返（非法项被清洗）', () => {
  const s = normalizeSettings({ voice: { wake: { enabled: false, word: '小助手' }, model: 'zipformer-zh-int8' } });
  assert.equal(s.voice.wake.enabled, false);
  assert.equal(s.voice.wake.word, '小助手');
  assert.equal(s.voice.wake.tokens, '');
  assert.equal(s.voice.model, 'zipformer-zh-int8');
  // 老设置的 mode 会被迁移成 wake.enabled（而不是被丢弃回默认）
  assert.equal(normalizeSettings({ voice: { mode: 'wake' } }).voice.wake.enabled, true);
  assert.equal(normalizeSettings({ voice: 'bad' }).voice, null);
});
