'use strict';
/**
 * LLM 密钥文件（**主进程专用**）。
 *
 * 用户 2026-09-15 决策：**不用密钥保险箱（safeStorage / Windows DPAPI）**，
 * 改成一个**独立的明文密钥文件**，位置固定在**便携目录之外**。
 *
 * 三条硬约束：
 *  ① 不落 settings.json —— 独立文件，默认 `<用户主目录>/.deskpet/llm.key`
 *     （`config.chatEngine.engines.llm.keyFile` 可改；也可用环境变量 `PET_LLM_KEY_FILE` 覆盖，测试用）。
 *  ② ★ **不随机子迁移** —— 路径刻意放在桌宠程序目录（便携 `data/`）**之外**：
 *     把整个桌宠文件夹拷到别的电脑**不会**带走密钥；换电脑后第一次保存密钥时
 *     由 `set()` 的 `mkdirSync(recursive)` **自动创建目录与文件**（用户不需要手工建路径）。
 *  ③ 永不进日志/错误信息 —— 本文件只在 `get()` 里交出密钥；日志只写"发生了什么事"。
 *
 * ⚠ 明文存放的安全边界（如实告知，README 也写了）：任何能读到你 Windows 用户目录的人
 *   都能看到这个文件。这是"不加密、可直接用记事本改"换来的便利，是用户明确选择的方案；
 *   所以真正的红线只剩一条：**它绝不能出现在会被拷来拷去的 portable 目录里**。
 *
 * `resolveKeyFile()` / `parseKeyText()` / `isInsideDir()` 是**纯函数**，
 * 可被 node:test 直接单测（不需要 Electron）。
 */
const fs = require('fs');
const path = require('path');
const { resolveUserFile } = require('./userFile');

/** 默认密钥文件（`~` = 用户主目录）。刻意在便携目录之外 —— 见文件头 ②。 */
const DEFAULT_KEY_FILE = '~/.deskpet/llm.key';

/** 密钥最大长度（防御：粘错一大段文本进来）。 */
const MAX_KEY_LEN = 400;

/**
 * 纯函数：算出密钥文件的**绝对路径**（不碰文件系统，可单测）。
 * 路径规则与"聊天记录文件"共用一套实现（见 ./userFile.js）。
 * @param {{keyFile?:string, homeDir?:string, envFile?:string}} opts
 * @returns {string} 规范化后的绝对路径
 */
function resolveKeyFile({ keyFile, homeDir, envFile } = {}) {
  return resolveUserFile({ file: keyFile, defaultFile: DEFAULT_KEY_FILE, homeDir, envFile });
}

/**
 * 纯函数：child 是否位于 parent 目录之内（含相等）。
 * 用途：断言"密钥文件不在便携目录里"（这是本轮改动的核心不变量，e2e 与单测都靠它）。
 */
function isInsideDir(parent, child) {
  const a = path.resolve(String(parent || ''));
  const b = path.resolve(String(child || ''));
  if (!a || !b) return false;
  if (a === b) return true;
  const rel = path.relative(a, b);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 单行、去引号、去首尾空白的密钥文本。 */
function normalizeKeyInput(v) {
  if (typeof v !== 'string') return '';
  let s = v.trim();
  const nl = s.indexOf('\n');
  if (nl >= 0) s = s.slice(0, nl).trim();          // 多行只取第一行（防"粘了一大段"）
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * 纯函数：解析密钥文件正文 → 密钥（读不出返回 ''）。
 * 规则（故意做得"能用手改"）：
 *   · 忽略以 `#` 开头的注释行与空行；
 *   · 容忍 `KEY=xxx` / `apiKey=xxx` / `OPENAI_API_KEY=xxx` 这类前缀（有 = 号就取右边）；
 *   · 去掉成对引号；取**第一行**有效内容。
 */
function parseKeyText(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    let v = s;
    const eq = v.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.slice(0, eq).trim())) v = v.slice(eq + 1);
    const key = normalizeKeyInput(v);
    if (key) return key;
  }
  return '';
}

/** 纯函数：把密钥渲染成落盘内容（带中文说明头，方便用户用记事本直接改）。 */
function formatKeyText(apiKey) {
  return [
    '# 桌宠 · 大模型 API 密钥',
    '# 明文保存，仅本机使用。',
    '# 这个文件**不在桌宠的程序目录里** —— 把桌宠文件夹拷到别的电脑不会带走它，',
    '# 换电脑后在这里填上新的密钥即可（保存时会自动创建所在目录）。',
    '# 想手工改也行：以 # 开头的行会被忽略，下面任意一行写密钥就生效（可写 KEY=xxx）。',
    '',
    apiKey,
    '',
  ].join('\n');
}

class LlmSecret {
  /**
   * @param {{file:string, log?:Function}} opts file = 密钥文件绝对路径（用 resolveKeyFile() 算）
   */
  constructor({ file, log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.cache = undefined;    // undefined = 还没读过；'' = 没有；其它 = 已读到的密钥
    this.lastError = '';
  }

  /** 密钥来源：'file'（本机密钥文件）| 'none'。 */
  source() {
    return this.get() ? 'file' : 'none';
  }

  /** 状态 —— 给设置面板用。**只回"有没有"与路径，永不回密钥本身**。 */
  status() {
    const exists = fs.existsSync(this.file);
    const has = !!this.get();
    return {
      stored: exists && has,     // 文件在且能解析出密钥
      exists,                    // 文件是否存在（存在但解析不出 → 用户手改坏了）
      source: has ? 'file' : 'none',
      path: this.file,
      dir: path.dirname(this.file),
      error: this.lastError,     // '' | 'io'（读不了）| 'empty-file'（文件里没有有效密钥）
    };
  }

  /**
   * 取密钥（内存缓存；读不到不抛异常，返回 '' 并记 lastError）。
   * @returns {string}
   */
  get() {
    if (this.cache !== undefined) return this.cache;
    this.cache = '';
    this.lastError = '';
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      // 文件不存在 = 正常状态（还没配密钥），不算错误
      if (!e || e.code !== 'ENOENT') {
        this.lastError = 'io';
        this.log('llm secret read failed:', (e && e.message) || e);
      }
      return this.cache;
    }
    const key = parseKeyText(text);
    if (!key) {
      // 文件在、但没有有效内容（用户手工改坏了 / 只剩注释）
      this.lastError = 'empty-file';
      return this.cache;
    }
    this.cache = key;
    return this.cache;
  }

  /**
   * 保存密钥 → 写入独立文件（**目录不存在会自动创建**，这就是"换电脑写入即生成路径"）。
   * @returns {{ok:boolean, code:string, status:Object}}
   */
  set(apiKey) {
    const key = normalizeKeyInput(apiKey);
    if (!key) return { ok: false, code: 'empty', status: this.status() };
    if (key.length > MAX_KEY_LEN) return { ok: false, code: 'too-long', status: this.status() };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      // 原子替换：避免写一半断电留下半个文件（读的时候解析不出密钥 = 用户会以为"设了没用"）
      fs.writeFileSync(tmp, formatKeyText(key), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      // POSIX 上收权限；Windows 基本无效（不报错就行）
      try { fs.chmodSync(this.file, 0o600); } catch { /* 忽略 */ }
      this.cache = key;
      this.lastError = '';
      this.log('llm key stored (plain file, outside portable dir):', this.file);
      return { ok: true, code: 'stored', status: this.status() };
    } catch (e) {
      this.log('llm key write failed:', (e && e.message) || e);
      return { ok: false, code: 'io', status: this.status() };
    }
  }

  /** 清除密钥（文件 + 内存缓存）。 */
  clear() {
    this.cache = '';
    this.lastError = '';
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } catch (e) {
      this.log('llm key clear failed:', (e && e.message) || e);
      return { ok: false, code: 'io', status: this.status() };
    }
    this.log('llm key cleared');
    return { ok: true, code: 'cleared', status: this.status() };
  }

  /** 丢掉内存缓存（测试/换路径用；正常流程不需要）。 */
  invalidate() { this.cache = undefined; }
}

module.exports = {
  LlmSecret,
  resolveKeyFile,
  parseKeyText,
  formatKeyText,
  normalizeKeyInput,
  isInsideDir,
  DEFAULT_KEY_FILE,
  MAX_KEY_LEN,
};
