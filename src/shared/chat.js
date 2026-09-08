'use strict';
/** 聊天回复规则（纯函数）：结构清洗 + 关键词匹配（忽略大小写，多命中取最长关键词）。 */

/** 规则列表清洗：keyword/reply 均非空字符串才保留。 */
function normalizeChatRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const keyword = typeof r.keyword === 'string' ? r.keyword.trim().slice(0, 100) : '';
    const reply = typeof r.reply === 'string' ? r.reply.slice(0, 500) : '';
    if (!keyword || !reply) continue;
    out.push({ keyword, reply });
  }
  return out;
}

/**
 * 匹配规则：忽略大小写，输入文本“包含”某关键词即触发；
 * 同时命中多个时返回关键词最长的那条；无命中返回 null。
 */
function matchChatRule(rules, input) {
  const text = String(input || '').toLowerCase();
  if (!text) return null;
  let best = null;
  for (const r of rules || []) {
    if (!r || typeof r.keyword !== 'string' || !r.keyword) continue;
    if (!text.includes(r.keyword.toLowerCase())) continue;
    if (!best || r.keyword.length > best.keyword.length) best = r;
  }
  return best;
}

module.exports = { normalizeChatRules, matchChatRule };
