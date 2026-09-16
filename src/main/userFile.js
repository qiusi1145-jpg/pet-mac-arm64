'use strict';
/**
 * "用户级文件"的路径解析（主进程专用，纯函数无副作用）。
 *
 * 为什么单独一个文件：桌宠整体是**便携设计**（数据都在程序目录的 `data/` 里，拷走文件夹即用），
 * 但有两类文件**不能**跟着便携包走：
 *   · 大模型 API 密钥（`~/.deskpet/llm.key`，见 llmSecret.js）—— 拷走文件夹 = 送走密钥；
 *   · 聊天记录（`~/.deskpet/chat.json`，见 chatLog.js）—— 把文件夹发别人不该带走你的聊天内容。
 * 两处用同一套解析规则，避免各写一套跑偏（`~` 展开 / 相对路径按主目录 / 环境变量覆盖）。
 *
 * 规则（顺序即优先级）：envFile（测试与自检隔离）> file（config 配置）> defaultFile（内置默认）。
 * `~` 与 `~/x` 会展开成**用户主目录**；相对路径也按**用户主目录**解析
 * —— 刻意不按程序目录，否则又变回"跟着便携包走"了。
 */
const os = require('os');
const path = require('path');

/**
 * @param {{file?:string, defaultFile:string, homeDir?:string, envFile?:string}} opts
 * @returns {string} 规范化后的绝对路径
 */
function resolveUserFile({ file, defaultFile, homeDir, envFile } = {}) {
  const home = String(homeDir || os.homedir() || '');
  const fallback = String(defaultFile || '').trim();
  const raw = String(envFile || file || fallback).trim() || fallback;
  let p = raw;
  if (p === '~' || p === '~/' || p === '~\\') p = '';
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = p.slice(2);
  if (!p) p = fallback.replace(/^~[/\\]/, '');   // 只写了 `~` → 退回默认值的相对部分
  if (!path.isAbsolute(p)) p = path.join(home, p);
  return path.normalize(p);
}

module.exports = { resolveUserFile };
