'use strict';
/**
 * 待办清单纯逻辑：结构清洗 / 到期判断 / 催促目标选择（权重按紧迫度）。
 * 只做数据处理，不做任何 IO；持久化由 store.js，UI 由待办窗口完成。
 */

/** 单条待办清洗：非法字段回退默认，text 为空则丢弃（返回 null）。 */
function normalizeTodo(t) {
  if (!t || typeof t !== 'object') return null;
  const text = typeof t.text === 'string' ? t.text.trim().slice(0, 200) : '';
  if (!text) return null;
  const due = Number.isFinite(t.due) ? t.due : null;
  return {
    id: typeof t.id === 'string' && t.id ? t.id : `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    text,
    due,
    done: !!t.done,
    important: !!t.important,
  };
}

/** 列表清洗：丢弃非法项。 */
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const n = normalizeTodo(t);
    if (n) out.push(n);
  }
  return out;
}

/** 未完成且已到截止时间的待办（按截止时间升序，最紧迫在前）。 */
function findDueTodos(todos, now) {
  return (todos || [])
    .filter((t) => !t.done && t.due != null && t.due <= now)
    .sort((a, b) => a.due - b.due);
}

/**
 * 挑选随机催促目标：仅 ♥ 未完成待办；截止时间越近权重越高 ——
 * 已过期/剩余 ≤ urgentMs → urgentWeight（大幅提升）；剩余 ≤ soonMs → soonWeight（翻倍）；
 * 无截止时间权重 1。加权随机（rng 可注入以便测试）。
 */
function pickReminderTodo(todos, now, rng = Math.random) {
  const { CFG } = require('./config');
  const pool = (todos || []).filter((t) => !t.done && t.important);
  if (!pool.length) return null;
  const weights = pool.map((t) => {
    if (t.due == null) return 1;
    const left = t.due - now;
    if (left <= 0 || left <= CFG.reminder.urgentMs) return CFG.reminder.urgentWeight;
    if (left <= CFG.reminder.soonMs) return CFG.reminder.soonWeight;
    return 1;
  });
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** 用模板生成提醒文案（{task} 替换为待办内容）。 */
function formatTask(template, task) {
  return String(template || '{task}').replace('{task}', task);
}

module.exports = { normalizeTodo, normalizeTodos, findDueTodos, pickReminderTodo, formatTask };
