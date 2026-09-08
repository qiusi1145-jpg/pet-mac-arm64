'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { setOverrides, getOverrides, ov } = require('../../src/shared/overrides');
const { CFG } = require('../../src/shared/config');

test('覆盖表：默认为空 → ov 全部回退 fallback', () => {
  setOverrides(null);
  assert.equal(getOverrides(), null);
  assert.equal(ov('greeting.greetings', CFG.greeting.greetings), CFG.greeting.greetings);
  assert.equal(ov('menu.items.rest.label', 'X'), 'X');
});

test('覆盖表：点分路径命中，命中值可为 false/null/空串（显式覆盖语义）', () => {
  setOverrides({
    menu: { items: { rest: { label: '歇会儿', visible: false } } },
    stateImage: { path: null },
    chat: { strings: { opening: '' } },
  });
  assert.equal(ov('menu.items.rest.label', '休息'), '歇会儿');
  assert.equal(ov('menu.items.rest.visible', true), false); // false 也是命中
  assert.equal(ov('stateImage.path', 'default.png'), null); // null 也是命中
  assert.equal(ov('chat.strings.opening', 'x'), '');        // 空串也是命中
  assert.equal(ov('menu.items.feed.label', '喂食'), '喂食'); // 未覆盖 → 回退
  assert.equal(ov('todo.remindTemplate', 'T'), 'T');        // 缺中间层 → 回退
  setOverrides(null);
});

test('覆盖表：setOverrides(非对象) 视为清空', () => {
  setOverrides({ a: { b: 1 } });
  assert.ok(getOverrides());
  setOverrides('bad');
  assert.equal(getOverrides(), null);
  setOverrides(undefined);
  assert.equal(getOverrides(), null);
});

test('config 默认值：新增可定制字段存在且结构正确', () => {
  assert.equal(CFG.menu.items.rest.label, '休息');
  assert.equal(CFG.menu.items.musicAdd.label, '添加音乐…');
  assert.ok(CFG.chat.strings.opening.length > 0);
  assert.ok(CFG.chat.strings.missNotice.length > 0);
  assert.deepEqual(CFG.blinkAnim.frames, []); // 无帧 = 降级旧版眨眼
  assert.equal(CFG.stateImage.path, null);
  assert.equal(CFG.pet.path, null);
});
