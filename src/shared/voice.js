'use strict';
/**
 * 语音纯函数层（无 DOM / 无 Electron / 无原生插件 → 可用 node:test 单测）。
 *
 * 分四块：
 *  ① 偏好清洗：settings.voice（模式/模型/设备/唤醒词）——手改 settings 不能把功能改坏；
 *  ② 唤醒词 → sherpa-onnx 关键词串（KWS 吃音素串，不是中文原文；本项目不依赖 Python，
 *     所以内置词库在 config.voice.wake.builtin 里预先做好映射）；
 *  ③ 识别文本归一化（去空白/句读，供匹配与显示）；
 *  ④ PCM 分帧 / RMS 电平 / 端点判定（说话结束检测）——全部纯计算。
 *
 * 本文件不引用任何 Electron / sherpa 符号：真正的推理在 renderer/asr.js。
 */

/**
 * @typedef {Object} VoiceWakePrefs
 * @property {boolean} enabled 要不要**在后台监听唤醒词**（true = 麦克风常驻；用户可关）
 * @property {string} word     唤醒词原文（显示用）
 * @property {string} tokens   音素串；空 = 由内置词库按 word 查表
 * @property {number} boost    keywords.txt 的 :boost（越大越易触发）
 * @property {number} threshold keywords.txt 的 #threshold（越大越严）
 *
 * @typedef {Object} VoicePrefs
 * @property {boolean} enabled
 * @property {string} model
 * @property {string} deviceId  '' = 系统默认
 * @property {VoiceWakePrefs} wake
 * @property {{local:string, globalKey:string}} ptt
 *   按键说话键位：`local` = 聊天窗内**按住说话**（松开立即提交）；`globalKey` = 全局
 *   **按一下进入语音对话 / 再按一下退出**（空 = 不注册）。
 *   ⚠ Electron `globalShortcut` **只有 keydown、没有 keyup** → 全局键不可能做成"按住"，
 *   只能是"按一下切换"；真·按住只在应用窗口内（那里有 keyup）。
 * @property {boolean} duckBgm
 * @property {boolean} showPartial
 *
 * 【2026-09-16 结构变更】原 `mode`（按键 / 唤醒 / 唤醒+按键 / 常听）已移除：
 *  · 「常听」升级为**语音对话**：由聊天窗 🎤 进入/退出（运行期开关，不需持久化）；
 *  · 持久化里只剩 `wake.enabled`（后台唤醒监听）与 `ptt`（键位）。
 *  · ⚠ 按键说话**曾于当晚一度取消、随即按用户要求恢复** —— 现在它与语音对话**共存**，
 *    不是互斥关系：对话是"会话状态"，按键只是进入/退出与"提前提交"的快捷方式。
 */

/** 懒取 config（避免模块加载顺序耦合；config 是深冻结的只读表）。 */
function cfg() {
  // eslint-disable-next-line global-require
  return require('./config').CFG.voice;
}

/* ================= ① 偏好清洗 ================= */

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 旧设置迁移：`settings.voice.mode`（'ptt' | 'wake' | 'both' | 'open'）→ `wake.enabled`。
 *
 * 背景（2026-09-16 用户决策）：**按键说话（PTT）取消**；「常听」升级为由聊天窗 🎤 进入/退出的
 * **语音对话**（运行期开关，不需要持久化）。于是持久化里只剩一个真正要记住的开关：
 * **要不要在后台监听唤醒词**（它意味着麦克风常驻）。
 *  · 'wake' / 'both' → 用户手里本来就用唤醒词 → 保留；
 *  · 'ptt' / 'open'  → 没用（或用的常听，已被语音对话取代）→ 不后台监听。
 * 迁移只发生在**读入**时；写回时 mode 自然消失（白名单里已经没有它）。
 */
function legacyWakeEnabled(mode, dflt = true) {
  if (mode === 'wake' || mode === 'both') return true;
  if (mode === 'ptt' || mode === 'open') return false;
  return dflt;
}

/**
 * 清洗 settings.voice。返回 null 表示"用户没设置过"（一切走 config 默认）。
 * 白名单策略：model 必须命中 config.voice.models（防手改指向任意路径）；
 * 布尔开关只认 `=== false`（缺省即开启）。
 */
function normalizeVoicePrefs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = cfg();
  const modelIds = (c.models || []).map((m) => m.id);
  const wakeRaw = (raw.wake && typeof raw.wake === 'object') ? raw.wake : {};
  const word = typeof wakeRaw.word === 'string' && wakeRaw.word.trim()
    ? wakeRaw.word.trim().slice(0, 20) : c.wake.word;
  const tokens = typeof wakeRaw.tokens === 'string' ? wakeRaw.tokens.trim().slice(0, 200) : '';
  return {
    enabled: raw.enabled !== false,
    model: modelIds.includes(raw.model) ? raw.model : c.model,
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId.slice(0, 200) : '',
    wake: {
      // 旧设置只有 mode、没有 enabled → 走迁移兜底
      enabled: typeof wakeRaw.enabled === 'boolean'
        ? wakeRaw.enabled
        : legacyWakeEnabled(raw.mode, c.wake.enabled !== false),
      word,
      tokens,
      boost: clampNum(wakeRaw.boost, 0.1, 10, c.wake.boost),
      threshold: clampNum(wakeRaw.threshold, 0.01, 1, c.wake.threshold),
    },
    // 键位走 accelerator 白名单：非法/畸形一律丢弃（手改 settings 写坏键位，
    // 不能让它变成"瞎抢键"）。globalKey 空 = 不注册全局键。
    ptt: {
      local: normalizeAccelerator(raw.ptt && raw.ptt.local) || c.ptt.local,
      globalKey: (raw.ptt && raw.ptt.globalKey) ? normalizeAccelerator(raw.ptt.globalKey) : '',
    },
    duckBgm: raw.duckBgm !== false,
    showPartial: raw.showPartial !== false,
  };
}

/** 是否要在后台监听唤醒词（= 麦克风常驻）。读偏好，没设置过就用 config 默认。 */
function wakeEnabledOf(prefs) {
  const n = normalizeVoicePrefs(prefs);
  return n ? n.wake.enabled !== false : cfg().wake.enabled !== false;
}

/**
 * 这句该不该发给大模型？（用户 2026-09-16："仅发出'啊'声或其他过短语句时不向大模型发起请求"）
 *
 * 两个条件**同时**满足才算一句有效的话（阈值见 config.voice.dialog）：
 *  ① 有效人声时长 ≥ minSpeechMs —— "啊"一声大约只有 200~300ms 的 voiced；
 *  ② 去掉标点后 ≥ minChars 个字 —— 挡住"嗯""哦"这类单字噪声。
 * 纯函数，可单测。返回 reason 便于排查（也便于 UI 说清"为什么没理你"）。
 * @param {{voicedMs?:number, text?:string, thresholds?:Object}} opts
 * @returns {{ok:boolean, reason:string, chars:number, voicedMs:number}}
 */
function judgeUtterance({ voicedMs = 0, text = '', thresholds } = {}) {
  const d = (thresholds && thresholds.dialog) || cfg().dialog || {};
  const minMs = Math.max(0, Number(d.minSpeechMs) || 0);
  const minChars = Math.max(1, Number(d.minChars) || 1);
  const ms = Math.max(0, Number(voicedMs) || 0);
  const chars = normalizeTranscript(text).replace(/[^\p{L}\p{N}]/gu, '').length;
  if (!chars) return { ok: false, reason: 'empty', chars, voicedMs: ms };
  if (ms < minMs) return { ok: false, reason: 'too-short-audio', chars, voicedMs: ms };
  if (chars < minChars) return { ok: false, reason: 'too-short-text', chars, voicedMs: ms };
  return { ok: true, reason: '', chars, voicedMs: ms };
}

/* ================= ② 唤醒词 → 关键词串 ================= */

/**
 * 剥掉关键词行里可能混进来的装饰：`:boost`、`#threshold`、`@显示词`，只留音素 token。
 *
 * 为什么需要：官方 `keywords.txt` **允许省略 boost/threshold 的短格式**
 * （`x iǎo ài t óng x ué @小爱同学`），而我们在文档/诊断里正是让用户"抄官方那一行"过来。
 * 若不剥掉，粘进来的 `@小爱同学` 会被当成一个 token → 关键词永远匹配不上。
 */
function stripKeywordDecorations(s) {
  return String(s == null ? '' : s)
    .replace(/@\S*.*$/, '')              // 显示词及其之后
    .replace(/[#:]\s*[0-9.]+/g, ' ')     // boost / threshold 标记
    .replace(/\s+/g, ' ')
    .trim();
}

/** 当前唤醒词对应的音素串：优先用户手填（会剥掉粘贴进来的装饰），其次内置词库查表，都没有则 ''。 */
function wakeTokensOf(prefs) {
  const c = cfg();
  const wake = (prefs && prefs.wake) || {};
  if (typeof wake.tokens === 'string' && wake.tokens.trim()) return stripKeywordDecorations(wake.tokens);
  const word = (wake.word || c.wake.word || '').trim();
  const hit = (c.wake.builtin || []).find((b) => b.word === word);
  return hit && hit.tokens ? stripKeywordDecorations(hit.tokens) : '';
}

/**
 * 生成 sherpa-onnx KWS 的 keywords.txt 单行：
 *   `<token> <token> ... :<boost> #<threshold> @<显示文本>`
 * 无语素串（词库未收录且用户没手填）→ 返回 ''，调用方应降级为"按键触发"并给设置窗提示。
 */
function buildKeywordLine(prefs) {
  const tokens = wakeTokensOf(prefs);
  if (!tokens) return '';
  const c = cfg();
  const wake = (prefs && prefs.wake) || {};
  const boost = clampNum(wake.boost, 0.1, 10, c.wake.boost);
  const threshold = clampNum(wake.threshold, 0.01, 1, c.wake.threshold);
  const word = (wake.word || c.wake.word || '').trim();
  return `${tokens} :${boost} #${threshold} @${word}`;
}

/* ================= ③ 识别文本归一化 ================= */

/**
 * 归一化转写文本：全角空格→半角、压缩空白、去掉首尾句读。
 * 用于①显示②关键词匹配（规则匹配是"包含"语义，句读会干扰）。
 */
function normalizeTranscript(text) {
  return String(text == null ? '' : text)
    .replace(/[\u3000\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[，。！？、；：,.!?;:]+/, '')
    .replace(/[，。！？、；：,.!?;:]+$/, '');
}

/** 是否"听清了"（空/纯标点视为没听清 → 不调聊天引擎，避免空话触发表情）。 */
function isMeaningfulTranscript(text) {
  const t = normalizeTranscript(text);
  return t.replace(/[^\p{L}\p{N}]/gu, '').length > 0;
}

/* ================= ④ PCM / 电平 / 端点 ================= */

/** 一帧的采样点数（frameMs 毫秒 @ sampleRate）。 */
function frameSize(sampleRate, frameMs = 20) {
  return Math.max(1, Math.round((Number(sampleRate) || 16000) * (Number(frameMs) || 20) / 1000));
}

/** 均方根电平（0~1 量纲的近似；Float32 音频样本范围 ±1）。 */
function rmsOf(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * 端点检测器（说完了吗）：连续静音 ≥ silenceMs → 'end'；总时长 ≥ maxMs → 'timeout'。
 * 纯状态机，便于单测（真实音频不参与测试，与"测试模式不依赖真麦克风"的思路一致）。
 *
 * push(rms, ms) 返回：
 *   'silence' 还没开口 | 'speech' 正在说 | 'end' 说完了（该提交） | 'timeout' 超时截断
 */
function createEndpointer(opts = {}) {
  const chunkMs = Number(opts.chunkMs) > 0 ? Number(opts.chunkMs) : 20;
  const silenceMs = Number(opts.silenceMs) > 0 ? Number(opts.silenceMs) : 800;
  const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : 15000;
  const minSpeechMs = Number(opts.minSpeechMs) > 0 ? Number(opts.minSpeechMs) : 150;
  const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : 0.02;
  let elapsed = 0, silence = 0, speechMs = 0, speaking = false;
  let endedEvent = null; // 终态事件（'end' | 'timeout'），结束后一直回报同一个
  return {
    push(rms, ms = chunkMs) {
      if (endedEvent) return endedEvent;
      elapsed += ms;
      const voiced = rms >= threshold;
      if (voiced) { speaking = true; speechMs += ms; silence = 0; }
      else if (speaking) { silence += ms; }
      if (speaking && silence >= silenceMs) { endedEvent = 'end'; return 'end'; }
      if (elapsed >= maxMs) { endedEvent = 'timeout'; return 'timeout'; }
      return speaking ? 'speech' : 'silence';
    },
    /** 有效语音时长（用于过滤"咳一声"这类超短触发）。 */
    get speechMs() { return speechMs; },
    get speaking() { return speaking; },
    get elapsedMs() { return elapsed; },
    /** 太短（只够一声噪音）→ 丢弃，别当一句话提交。 */
    isTooShort() { return speechMs < minSpeechMs; },
    reset() { elapsed = 0; silence = 0; speechMs = 0; speaking = false; endedEvent = null; },
  };
}

/* ================= ⑤ PTT 快捷键（键位解析 / 校验 / 匹配） =================
 * 目标：让用户在设置窗里「点一下 → 按一个键 → 就记下来」，而不是手写 accelerator 字符串。
 * 统一用**物理键（KeyboardEvent.code）**映射，避免键盘布局差异；
 * 产出的是 Electron accelerator 语法（'Control+Shift+Space' / 'F2'），主进程直接拿去 globalShortcut。
 * 两边共用同一套：主进程注册用 accelerator，渲染层匹配用 matchesAccelerator —— 不会各写一套而跑偏。
 */

/** 修饰键顺序（规范化时固定成这个顺序，保证 'shift+ctrl+space' 与 'Control+Shift+Space' 等价）。 */
const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Super'];
const MOD_ALIAS = {
  ctrl: 'Control', control: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  super: 'Super', cmd: 'Super', command: 'Super', meta: 'Super', win: 'Super',
};
/** 允许作为「主键」的名字（Electron accelerator 白名单的常用子集）。 */
const MAIN_KEYS = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `num${i}`),
  'Space', 'Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`',
  'Plus', 'numadd', 'numsub', 'nummult', 'numdiv', 'numdec',
]);

/** 物理键 code → accelerator 主键名（US 布局；不支持返回 ''）。 */
function keyNameFromCode(code) {
  if (!code) return '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const map = {
    Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape', Tab: 'Tab',
    Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  };
  return map[code] || '';
}

/** 只按修饰键（Ctrl / Shift / Alt / Win 本身）不算一次有效按键。 */
function isModifierCode(code) {
  return /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(String(code || ''));
}

/**
 * 从一次键盘事件里取出 accelerator。
 * @param {{code?:string,ctrlKey?:boolean,altKey?:boolean,shiftKey?:boolean,metaKey?:boolean}} ev
 * @returns {string} 形如 'Control+Shift+Space' / 'F2'；只按修饰键或无法识别 → ''
 */
function acceleratorFromEvent(ev) {
  if (!ev || isModifierCode(ev.code)) return '';
  const key = keyNameFromCode(ev.code);
  if (!key) return '';
  const mods = [];
  if (ev.ctrlKey) mods.push('Control');
  if (ev.altKey) mods.push('Alt');
  if (ev.shiftKey) mods.push('Shift');
  if (ev.metaKey) mods.push('Super');
  return mods.concat([key]).join('+');
}

/**
 * 规范化 accelerator：别名归一（ctrl→Control）、修饰键去重且固定顺序、主键校验。
 * 非法输入返回 ''（也被 normal./手改 settings 的兜底用）。
 */
function normalizeAccelerator(str) {
  if (typeof str !== 'string' || !str.trim()) return '';
  const parts = str.split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const mods = [];
  let main = '';
  for (const p of parts) {
    const alias = MOD_ALIAS[p.toLowerCase()];
    if (alias) { if (!mods.includes(alias)) mods.push(alias); continue; }
    if (main) return ''; // 出现两个主键 → 非法
    main = p;
  }
  if (!main) return '';
  // 主键大小写归一：单字母大写、numN 小写 n、其余首字母大写（F1/Space/Up…）
  let key = main;
  if (/^[a-zA-Z]$/.test(key)) key = key.toUpperCase();
  else if (/^num[0-9]$/i.test(key)) key = 'num' + key.slice(3);
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = 'F' + key.slice(1);
  else {
    const hit = [...MAIN_KEYS].find((k) => k.toLowerCase() === key.toLowerCase());
    if (!hit) return '';
    key = hit;
  }
  if (!MAIN_KEYS.has(key)) return '';
  return MOD_ORDER.filter((m) => mods.includes(m)).concat([key]).join('+');
}

/** 规范化后是否合法（供 UI 实时提示）。 */
function isValidAccelerator(str) {
  return !!normalizeAccelerator(str);
}

/** 这次键盘事件是否命中该 accelerator（渲染层"按住说话"用；与主进程注册的是同一套语法）。 */
function matchesAccelerator(acc, ev) {
  const want = normalizeAccelerator(acc);
  if (!want) return false;
  const got = acceleratorFromEvent(ev);
  return !!got && got === want;
}

/** 人读的键位显示（'Control+Shift+Space' → 'Ctrl + Shift + Space'）。 */
function prettyAccelerator(acc) {
  const n = normalizeAccelerator(acc);
  if (!n) return '未设置';
  const alias = { Control: 'Ctrl', Super: 'Win' };
  return n.split('+').map((p) => alias[p] || p).join(' + ');
}

/**
 * 唤醒词音素串 vs KWS 词表核对。
 *
 * 为什么必须有这个：KWS 的关键词是**音素 token 串**，只要有一个 token 不在模型词表里，
 * 该关键词就**永远匹配不上** —— 而模型照常加载成功、不报任何错。这是"唤醒不了"
 * 最隐蔽的原因，只能拿真实词表核对。
 *
 * @param {string} line          keywords.txt 形式的一行（`tokens :boost #threshold @词`）
 * @param {Iterable<string>} vocabTokens  KWS 模型 tokens.txt 里的 token 集合
 * @returns {{ total:number, missing:string[], word:string }}
 */
function wakeTokenCheck(line, vocabTokens) {
  const raw = String(line || '').trim();
  if (!raw) return { total: 0, missing: [], word: '' };
  const word = raw.includes('@') ? String(raw.split('@').pop()).trim() : '';
  // 长格式（tokens :b #t @词）与官方短格式（tokens @词）都要能剥干净
  const core = stripKeywordDecorations(raw);
  const tokens = core.split(/\s+/).filter(Boolean);
  const vocab = vocabTokens instanceof Set ? vocabTokens : new Set(vocabTokens || []);
  return { total: tokens.length, missing: tokens.filter((t) => !vocab.has(t)), word };
}

/* ================= ⑥ WAV 解析（自检脚本用；纯函数、可单测） =================
 * 为什么不用 sherpa-onnx 自带的 readWave：它返回 **C++ 侧的外部缓冲**，而 Electron 禁止外部缓冲，
 * 直接抛 "External buffers are not allowed"（纯 Node 下反而正常）。自己解析 44 字节头 + PCM16 最稳。
 */

/**
 * 解析 **单声道 16-bit PCM** 的 WAV → Float32 采样（-1~1）。
 * 支持带/不带 fmt 扩展块的常规文件；遇到非 16-bit 或非单声道返回 null（不做重采样）。
 * @param {Buffer|Uint8Array} buf
 * @returns {{ sampleRate:number, samples:Float32Array }|null}
 */
function parseWavPcm16(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 44) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) return null;       // 'RIFF'
  if (dv.getUint32(8, false) !== 0x57415645) return null;       // 'WAVE'
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= b.length) {
    const id = dv.getUint32(off, false);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 0x666d7420) {                                     // 'fmt '
      fmt = {
        audioFormat: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === 0x64617461) {                              // 'data'
      dataOff = body;
      dataLen = Math.min(size, b.length - body);
    }
    off = body + size + (size % 2); // 块按偶数字节对齐
  }
  if (!fmt || dataOff < 0) return null;
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16 || fmt.channels !== 1) return null;
  const n = Math.floor(dataLen / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(dataOff + i * 2, true) / 32768;
  return { sampleRate: fmt.sampleRate, samples: out };
}

module.exports = {
  normalizeVoicePrefs,
  wakeEnabledOf,
  legacyWakeEnabled,
  judgeUtterance,
  wakeTokensOf,
  buildKeywordLine,
  wakeTokenCheck,
  stripKeywordDecorations,
  parseWavPcm16,
  normalizeTranscript,
  isMeaningfulTranscript,
  frameSize,
  rmsOf,
  createEndpointer,
  acceleratorFromEvent,
  normalizeAccelerator,
  isValidAccelerator,
  matchesAccelerator,
  prettyAccelerator,
  keyNameFromCode,
  isModifierCode,
};
