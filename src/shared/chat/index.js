'use strict';
/**
 * ChatEngine 统一入口：require 本文件即完成内置引擎注册（rule + llm）。
 *
 * 用法（主进程编排器）：
 *   const chat = require('../shared/chat');
 *   const { engine, degradedFrom } = chat.selectEngine(store.get().chatEngine);
 *   const result = await engine.send(chat.makeRequest({ channel:'voice', text }));
 *
 * 加一个新引擎 = 在 ./ 下新建文件 + 在下面 require 一行。
 * llm 引擎的环境（密钥/偏好/日志/流式回调）由主进程用 `configureLlm()` 注入。
 */
const engine = require('./engine');
const { ruleEngine } = require('./rule');
const { llmEngine, llmConfig, configure: configureLlm, resetHistory } = require('./llm');

module.exports = {
  ...engine,
  ruleEngine,
  llmEngine,
  llmConfig,
  configureLlm,
  resetLlmHistory: resetHistory,
};
