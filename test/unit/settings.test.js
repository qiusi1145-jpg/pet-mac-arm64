'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, defaultSettings } = require('../../src/shared/settings');

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
    volume: 0.4,
    playlist: [{ path: 'a.mp3', title: 't' }, { path: '' }, 'junk'],
    pos: { x: 10.5, y: -3 },
    region: { width: 1200, height: 'bad' },
  });
  assert.equal(s.locked, true);
  assert.equal(s.volume, 0.4);
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

test('volume 被夹到 [0,1]', () => {
  assert.equal(normalizeSettings({ volume: 3 }).volume, 1);
  assert.equal(normalizeSettings({ volume: -1 }).volume, 0);
});
