'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ACCENTS, DEFAULT_ACCENT, normalizeAccentPref } = require('../../src/shared/uiTheme');

test('uiTheme: 预设齐全且默认 blue', () => {
  assert.equal(DEFAULT_ACCENT, 'blue');
  for (const id of ['blue', 'purple', 'pink', 'green', 'orange', 'graphite']) {
    assert.ok(ACCENTS[id], id);
    assert.match(ACCENTS[id].color, /^#[0-9a-f]{6}$/i);
    assert.ok(ACCENTS[id].label);
  }
});

test('uiTheme: 合法 accent 原样保留', () => {
  assert.deepEqual(normalizeAccentPref({ accent: 'purple' }), { accent: 'purple' });
  assert.deepEqual(normalizeAccentPref({ accent: 'graphite' }), { accent: 'graphite' });
});

test('uiTheme: 非法/缺省/类型错误一律回退默认', () => {
  assert.deepEqual(normalizeAccentPref({ accent: 'rainbow' }), { accent: 'blue' });
  assert.deepEqual(normalizeAccentPref({ accent: 42 }), { accent: 'blue' });
  assert.deepEqual(normalizeAccentPref({ accent: null }), { accent: 'blue' });
  assert.deepEqual(normalizeAccentPref(null), { accent: 'blue' });
  assert.deepEqual(normalizeAccentPref('blue'), { accent: 'blue' });
  assert.deepEqual(normalizeAccentPref(undefined), { accent: 'blue' });
});
