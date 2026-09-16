'use strict';
/**
 * rule 引擎：把现有的「关键词 → 回复」包装成 ChatEngine（纯函数，可单测）。
 *
 * 关键约束：**行为与迁移前的 main.js chatSend() 逐字一致**——
 *   · 空输入 / 全空白 → { ok:false, matched:false, reply:null }（不触发表情）
 *   · 命中 → { ok:true, matched:true, reply, meta:{keyword} }
 *   · 未命中 → { ok:true, matched:false, reply:null }
 * 匹配算法本身仍用 content.matchChatRule（原地不动，忽略大小写"包含"、多命中取最长关键词）。
 *
 * 规则从哪来：`req.context.chatRules`（由编排器注入 settings.chatRules）。
 * 这样引擎保持无状态纯函数，单测可直接喂 context，不需要 mock store。
 */
const { matchChatRule } = require('../content');
const { registerEngine, lastUserText, normalizeResult } = require('./engine');

const ENGINE_ID = 'rule';

/**
 * @param {{ rules?: Array }} [ctx]  归一化后的 context（含 chatRules）
 * @returns {import('./engine').ChatResult}
 */
function send(req) {
  const input = String(lastUserText(req) == null ? '' : lastUserText(req)).slice(0, 500);
  if (!input.trim()) return normalizeResult({ ok: false, matched: false, reply: null }, ENGINE_ID);
  const rules = (req && req.context && Array.isArray(req.context.chatRules)) ? req.context.chatRules : [];
  const rule = matchChatRule(rules, input);
  if (rule) {
    return normalizeResult({
      ok: true, matched: true, reply: rule.reply,
      meta: { keyword: rule.keyword },
    }, ENGINE_ID);
  }
  return normalizeResult({ ok: true, matched: false, reply: null }, ENGINE_ID);
}

const ruleEngine = {
  id: ENGINE_ID,
  label: '关键词规则（离线，当前实现）',
  capabilities: { streaming: false, context: false, tools: false, offline: true },
  available: () => true,
  send,
};

registerEngine(ruleEngine);

module.exports = { ruleEngine, ruleSend: send, RULE_ENGINE_ID: ENGINE_ID };
