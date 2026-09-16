'use strict';
/**
 * 聊天记录（**主进程专用**）—— 独立 json 文件，明文，**刻意放在便携目录之外**。
 *
 * 用户 2026-09-16 决策（原话）：「独立 json 文件，只保存在本机就行（不用过度编程做加密，
 * 不随应用迁移能保护用户隐私就行）」→ 默认 `~/.deskpet/chat.json`（与密钥文件同目录，
 * 路径规则共用 ./userFile.js）。这样**拷走/发出整个桌宠文件夹不会带走聊天记录**。
 *
 * 三条纪律：
 *  ① **主进程是唯一写入方**，渲染层只负责渲染。
 *     以前是"文字路径渲染层自己画 + 语音路径主进程推"两条路并存；一旦记录要落盘，
 *     两条路必然出现"界面上有、记录里没有"（或反过来）的不一致，所以统一收口到主进程。
 *  ② **原子写**（tmp + rename）：写一半断电不会留下半个 json —— 坏 json 在读的一侧等于记录全丢。
 *  ③ **有上限**（默认 500 条，config.chat.logMax）：这是"翻阅用的台账"，不是数据库；
 *     超出丢最旧的。文件名/格式都很朴素，用户拿记事本也能看懂。
 *
 * `resolveLogFile()` / `pickEntries()` / `normalizeEntry()` 是纯函数，可被 node:test 直接单测。
 */
const fs = require('fs');
const path = require('path');
const { resolveUserFile } = require('./userFile');

/** 默认记录文件（`~` = 用户主目录；刻意在便携目录之外）。 */
const DEFAULT_LOG_FILE = '~/.deskpet/chat.json';

/** 单条文本上限（防御：粘贴一长段进来把文件撑爆）。 */
const MAX_TEXT_LEN = 2000;
/** 记录上限的默认值与绝对上界（上界防手改 config 写成 999999 把内存/文件撑爆）。 */
const DEFAULT_MAX = 500;
const MAX_MAX = 5000;

/**
 * 纯函数：规范化"记录上限"。
 * 规则：**合法值原样尊重**（比如就想只留 3 条也行）；非法值（0/负数/NaN）退回默认 500；
 * 超过 MAX_MAX 则夹住。刻意不设下限 —— 设了会出现"填 3 实际留 20"这种莫名行为。
 */
function normalizeMax(max) {
  const n = Number(max);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX;
  return Math.min(MAX_MAX, Math.floor(n));
}

/** 纯函数：解析记录文件的绝对路径（规则见 userFile.js）。 */
function resolveLogFile({ logFile, homeDir, envFile } = {}) {
  return resolveUserFile({ file: logFile, defaultFile: DEFAULT_LOG_FILE, homeDir, envFile });
}

/** 纯函数：把任意输入清洗成一条记录，非法返回 null。 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 只认字符串与数字；对象/数组这类"看不出来是什么"的输入直接丢掉（别把 [object Object] 写进记录）
  const rawText = typeof raw.text === 'string' ? raw.text
    : (typeof raw.text === 'number' ? String(raw.text) : '');
  const t = rawText.length > MAX_TEXT_LEN ? rawText.slice(0, MAX_TEXT_LEN) : rawText;
  if (!t.trim()) return null;
  const who = raw.who === 'pet' || raw.who === 'me' ? raw.who : 'sys';
  const ts = Number.isFinite(Number(raw.ts)) && Number(raw.ts) > 0 ? Number(raw.ts) : Date.now();
  return { ts, who, text: t };
}

/** 纯函数：按上限裁剪（保留**最新**的 max 条）。 */
function pickEntries(list, max) {
  const n = normalizeMax(max);
  const arr = Array.isArray(list) ? list : [];
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

class ChatLog {
  /**
   * @param {{file:string, max?:number, log?:Function}} opts file = 记录文件绝对路径（用 resolveLogFile 算）
   */
  constructor({ file, max = DEFAULT_MAX, log = () => {} } = {}) {
    this.file = file;
    this.max = normalizeMax(max);
    this.log = log;
    this.list = [];
    this.loaded = false;
    this.lastError = '';
  }

  /**
   * 读盘进内存。**坏文件不当致命错误**：解析失败就按空记录启动（并记原因），
   * 桌宠照常能用 —— 记录没了比"应用起不来"轻得多。
   */
  load() {
    this.loaded = true;
    this.list = [];
    this.lastError = '';
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (!e || e.code !== 'ENOENT') { this.lastError = 'io'; this.log('chat log read failed:', (e && e.message) || e); }
      return this.list;
    }
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : []);
      this.list = pickEntries(arr.map(normalizeEntry).filter(Boolean), this.max);
    } catch (e) {
      this.lastError = 'corrupt';
      this.log('chat log corrupt, start empty:', (e && e.message) || e);
      this.list = [];
    }
    return this.list;
  }

  /** 保证已读盘（首次访问自动 load，调用方不用记顺序）。 */
  ensureLoaded() {
    if (!this.loaded) this.load();
    return this.list;
  }

  /** 全部记录（副本，防止外部改到内部数组）。 */
  entries() {
    return this.ensureLoaded().slice();
  }

  size() {
    return this.ensureLoaded().length;
  }

  isEmpty() {
    return this.size() === 0;
  }

  /**
   * 追加一条并立即落盘。
   * @returns {{ok:boolean, code:string, entry?:Object}}
   */
  append(who, text, ts = Date.now()) {
    const entry = normalizeEntry({ who, text, ts });
    if (!entry) return { ok: false, code: 'empty' };
    this.ensureLoaded();
    this.list.push(entry);
    this.list = pickEntries(this.list, this.max);
    return this.save() ? { ok: true, code: 'appended', entry } : { ok: false, code: 'io', entry };
  }

  /** 清空（内存 + 文件）。 */
  clear() {
    this.ensureLoaded();
    this.list = [];
    return this.save() ? { ok: true, code: 'cleared' } : { ok: false, code: 'io' };
  }

  /** 原子落盘（tmp + rename）。 */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });   // 换电脑后第一次写入即建出路径
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.list, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* Windows 上基本无效，忽略 */ }
      this.lastError = '';
      return true;
    } catch (e) {
      this.lastError = 'io';
      this.log('chat log write failed:', (e && e.message) || e);
      return false;
    }
  }

  /** 状态（给设置窗/自检看：存在与否、条数、路径、错误码）。 */
  status() {
    return {
      path: this.file,
      count: this.size(),
      max: this.max,
      error: this.lastError,
      exists: fs.existsSync(this.file),
    };
  }
}

module.exports = { ChatLog, resolveLogFile, normalizeEntry, pickEntries, DEFAULT_LOG_FILE, MAX_TEXT_LEN };
