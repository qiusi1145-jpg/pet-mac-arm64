'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeChatRules, matchChatRule } = require('../../src/shared/chat');
const { normalizeSettings } = require('../../src/shared/settings');

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
