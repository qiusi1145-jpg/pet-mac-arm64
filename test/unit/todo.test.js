'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeTodo, normalizeTodos, findDueTodos, pickReminderTodo, formatTask, randomReminderDelay } = require('../../src/shared/todo');
const { normalizeSettings } = require('../../src/shared/settings');
const { CFG } = require('../../src/shared/config');

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
    { id: 'd', text: 'd', due: now - 100, done: true },   // 已完成不算
    { id: 'e', text: 'e', due: null, done: false },        // 无截止不算
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
  // 总权重 11：rng=0.5 → 5.5 落在 urgent(10)；rng=0.95 → 10.45-10=0.45 落在 far
  assert.equal(pickReminderTodo([urgent, far], now, () => 0.5).id, 'a');
  assert.equal(pickReminderTodo([urgent, far], now, () => 0.95).id, 'b');
});

test('催促选择：1h 内权重翻倍', () => {
  const now = 1_000_000_000_000;
  const soon = { id: 's', text: 'soon', due: now + 30 * 60 * 1000, done: false, important: true };
  const far = { id: 'f', text: 'far', due: now + 3 * 24 * 60 * 60 * 1000, done: false, important: true };
  // 总权重 3：rng=0.5 → 1.5 落在 soon(2)；rng=0.7 → 2.1-2=0.1 落在 far
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
      { text: '' }, // 非法 → 丢弃
      null,
    ],
  });
  assert.equal(out.todos.length, 1);
  assert.equal(out.todos[0].text, '写周报');
  assert.equal(out.todos[0].important, true);
  assert.equal(normalizeSettings({ todos: 'bad' }).todos.length, 0);
  assert.deepEqual(normalizeSettings({}).todos, []);
});
