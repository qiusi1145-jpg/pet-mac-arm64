'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultSettings, normalizeSettings,
  normalizeTodo, normalizeTodos, findDueTodos, pickReminderTodo, formatTask, randomReminderDelay,
  normalizeChatRules, matchChatRule,
} = require('../../src/shared/content');
const { CFG } = require('../../src/shared/config');

/* ================= 设置 schema ================= */

test('normalizeSettings: null/垃圾输入回退默认', () => {
  assert.deepEqual(normalizeSettings(null), defaultSettings());
  assert.deepEqual(normalizeSettings('oops'), defaultSettings());
  assert.deepEqual(normalizeSettings(42), defaultSettings());
});

test('normalizeSettings: 不透明度被夹到 [0.1,1.0]，类型错误回退', () => {
  const s = normalizeSettings({ background: { opacity: 5 } });
  assert.equal(s.background.opacity, 1);
  const s2 = normalizeSettings({ background: { opacity: 'x' } });
  assert.equal(s2.background.opacity, 0.8);
  const s3 = normalizeSettings({ background: { opacity: 0.05 } });
  assert.equal(s3.background.opacity, 0.1);
});

test('normalizeSettings: 未知/畸形字段被丢弃，合法字段保留', () => {
  const s = normalizeSettings({
    locked: true,
    playlist: [{ path: 'a.mp3', title: 't' }, { path: '' }, 'junk'],
    pos: { x: 10.5, y: -3 },
    region: { width: 1200, height: 'bad' },
  });
  assert.equal(s.locked, true);
  assert.equal(s.playlist.length, 1);
  assert.deepEqual(s.pos, { x: 10.5, y: -3 });
  assert.equal(s.region.width, 1200);
  assert.equal(s.region.height, null);
});

test('normalizeSettings: snapEnabled / physicsEnabled 默认开，可显式关', () => {
  assert.equal(defaultSettings().snapEnabled, true);
  assert.equal(defaultSettings().physicsEnabled, true);
  assert.equal(normalizeSettings({}).snapEnabled, true);
  assert.equal(normalizeSettings({}).physicsEnabled, true);
  assert.equal(normalizeSettings({ snapEnabled: false }).snapEnabled, false);
  assert.equal(normalizeSettings({ physicsEnabled: false }).physicsEnabled, false);
});

/* ================= 待办 ================= */

test('待办清洗：非法字段回退默认，空文本丢弃', () => {
  const t = normalizeTodo({ text: '  写周报  ', due: 'x', done: 1, important: 'yes' });
  assert.equal(t.text, '写周报');
  assert.equal(t.due, null);
  assert.equal(t.done, true);
  assert.equal(t.important, true);
  assert.ok(t.id.length > 0);
  assert.equal(normalizeTodo({ text: '   ' }), null);
  assert.equal(normalizeTodo(null), null);
  assert.equal(normalizeTodo({ text: 'a' }).due, null);
});

test('待办清洗：保留合法 id 与截止时间', () => {
  const t = normalizeTodo({ id: 'abc', text: '取快递', due: 12345 });
  assert.equal(t.id, 'abc');
  assert.equal(t.due, 12345);
});

test('待办列表清洗：丢弃非法项', () => {
  const out = normalizeTodos([{ text: 'a' }, null, { text: '' }, 'x', { text: 'b', done: true }]);
  assert.deepEqual(out.map((t) => t.text), ['a', 'b']);
  assert.deepEqual(normalizeTodos('nope'), []);
});

test('到期判断：只含未完成且到期的，按截止时间升序', () => {
  const now = 1_000_000_000_000;
  const todos = [
    { id: 'a', text: 'a', due: now - 500, done: false },
    { id: 'b', text: 'b', due: now + 999, done: false },
    { id: 'c', text: 'c', due: now - 900, done: false },
    { id: 'd', text: 'd', due: now - 100, done: true },
    { id: 'e', text: 'e', due: null, done: false },
  ];
  const due = findDueTodos(todos, now);
  assert.deepEqual(due.map((t) => t.id), ['c', 'a']);
});

test('催促选择：无 ♥ 待办返回 null', () => {
  const now = Date.now();
  const todos = [{ id: 'a', text: 'a', important: false, done: false }];
  assert.equal(pickReminderTodo(todos, now, () => 0.5), null);
});

test('催促选择：紧迫（≤10min/已过期）权重远高于远期', () => {
  const now = 1_000_000_000_000;
  const urgent = { id: 'a', text: '急', due: now + 5 * 60 * 1000, done: false, important: true };
  const far = { id: 'b', text: '远', due: now + 3 * 24 * 60 * 60 * 1000, done: false, important: true };
  assert.equal(pickReminderTodo([urgent, far], now, () => 0.5).id, 'a');
  assert.equal(pickReminderTodo([urgent, far], now, () => 0.95).id, 'b');
});

test('催促选择：1h 内权重翻倍', () => {
  const now = 1_000_000_000_000;
  const soon = { id: 's', text: 'soon', due: now + 30 * 60 * 1000, done: false, important: true };
  const far = { id: 'f', text: 'far', due: now + 3 * 24 * 60 * 60 * 1000, done: false, important: true };
  assert.equal(pickReminderTodo([soon, far], now, () => 0.5).id, 's');
  assert.equal(pickReminderTodo([soon, far], now, () => 0.7).id, 'f');
});

test('催促选择：已完成/不重要的不参与', () => {
  const now = Date.now();
  const todos = [
    { id: 'a', text: 'a', due: now - 1, done: true, important: true },
    { id: 'b', text: 'b', due: now - 1, done: false, important: false },
  ];
  assert.equal(pickReminderTodo(todos, now, () => 0.5), null);
});

test('提醒模板：{task} 替换', () => {
  assert.equal(formatTask("主人，'{task}' 做完了吗？", '写周报'), "主人，'写周报' 做完了吗？");
  assert.equal(formatTask('主人，该做“{task}”了！', '取快递'), '主人，该做“取快递”了！');
});

test('催促间隔：随机落在 25~30 分钟配置区间内', () => {
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const d = randomReminderDelay(() => r);
    assert.ok(d >= CFG.reminder.minIntervalMs && d <= CFG.reminder.maxIntervalMs + 1e-9);
  }
  assert.ok(CFG.reminder.minIntervalMs >= 25 * 60 * 1000 && CFG.reminder.maxIntervalMs <= 30 * 60 * 1000);
});

test('settings：todos 字段持久化往返（normalizeSettings 清洗）', () => {
  const out = normalizeSettings({
    todos: [
      { id: 't1', text: '写周报', due: 123, done: false, important: true },
      { text: '' },
      null,
    ],
  });
  assert.equal(out.todos.length, 1);
  assert.equal(out.todos[0].text, '写周报');
  assert.equal(out.todos[0].important, true);
  assert.equal(normalizeSettings({ todos: 'bad' }).todos.length, 0);
  assert.deepEqual(normalizeSettings({}).todos, []);
});

/* ================= 聊天规则 ================= */

test('聊天规则清洗：空/非法项丢弃，keyword 首尾空白裁剪', () => {
  const out = normalizeChatRules([
    { keyword: ' 你好 ', reply: '嗨！' },
    { keyword: '', reply: 'x' },
    { keyword: 'a', reply: '' },
    null,
    'x',
    { keyword: 'b', reply: '回复b' },
  ]);
  assert.deepEqual(out, [
    { keyword: '你好', reply: '嗨！' },
    { keyword: 'b', reply: '回复b' },
  ]);
  assert.deepEqual(normalizeChatRules('nope'), []);
});

test('聊天匹配：忽略大小写的包含匹配', () => {
  const rules = [{ keyword: 'hello', reply: 'hi' }];
  assert.equal(matchChatRule(rules, 'say HELLO to me').reply, 'hi');
  assert.equal(matchChatRule(rules, 'say hell no'), null);
});

test('聊天匹配：同时命中多条用关键词最长的', () => {
  const rules = [
    { keyword: '你好', reply: '短' },
    { keyword: '你好呀', reply: '长' },
    { keyword: '好呀', reply: '中' },
  ];
  assert.equal(matchChatRule(rules, '你好呀').reply, '长');
  assert.equal(matchChatRule(rules, '你好').reply, '短');
});

test('聊天匹配：无命中返回 null；空输入返回 null', () => {
  const rules = [{ keyword: '在吗', reply: '在' }];
  assert.equal(matchChatRule(rules, '今天天气不错'), null);
  assert.equal(matchChatRule(rules, ''), null);
  assert.equal(matchChatRule(rules, null), null);
});

test('settings：chatRules 字段持久化往返', () => {
  const out = normalizeSettings({ chatRules: [{ keyword: 'hi', reply: 'hello' }, { bad: 1 }] });
  assert.equal(out.chatRules.length, 1);
  assert.equal(out.chatRules[0].keyword, 'hi');
  assert.deepEqual(normalizeSettings({}).chatRules, []);
});
