'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../src/main/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-store-'));
  return { store: new Store(dir), dir };
}

test('Store: 默认值、更新可链式、落盘可回读', () => {
  const { store, dir } = tmpStore();
  assert.equal(store.get().locked, false);
  store.update({ locked: true }).saveNow();
  const s2 = new Store(dir);
  s2.load();
  assert.equal(s2.get().locked, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Store: updateDeep 合并嵌套字段且可链式保存', () => {
  const { store, dir } = tmpStore();
  store.updateDeep('pet', { path: 'a.png' }).saveNow();
  const s2 = new Store(dir);
  s2.load();
  assert.equal(s2.get().pet.path, 'a.png');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Store: 损坏的 JSON 不崩溃，回退默认值', () => {
  const { store, dir } = tmpStore();
  store.saveNow();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{bad json', 'utf8');
  const s2 = new Store(dir);
  s2.load();
  assert.equal(s2.get().locked, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
