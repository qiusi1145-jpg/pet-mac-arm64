'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { IS_WIN, IS_MAC, guardPetWindow, hideFromDock } = require('../../src/main/platform');

test('平台标志互斥且与 process.platform 一致', () => {
  assert.equal(IS_WIN && IS_MAC, false);
  assert.equal(IS_WIN, process.platform === 'win32');
  assert.equal(IS_MAC, process.platform === 'darwin');
});

// 红线：非 Windows 上防护"不做"必须如实回报，不能静默成功（与语音全局键同一条规矩）
test('guardPetWindow：非 win32 返回 applied:false 且给出原因', (t) => {
  if (IS_WIN) return t.skip('本机是 win32，跳过反向断言');
  const r = guardPetWindow({ getNativeWindowHandle: () => Buffer.alloc(8) }, null, null);
  assert.equal(r.applied, false);
  assert.match(r.reason, /^platform:/);
});

test('guardPetWindow：win32 下句柄读取异常也要回报原因，不抛', (t) => {
  if (!IS_WIN) return t.skip('本机不是 win32');
  const r = guardPetWindow(
    { getNativeWindowHandle: () => { throw new Error('no handle'); } },
    { applyExStyle: () => Promise.resolve(true) },
    () => {}
  );
  assert.equal(r.applied, false);
  assert.match(r.reason, /^win32:/);
});

// macOS 上 app.dock 存在才该动手；Windows 上必须是无操作且返回 false
test('hideFromDock：非 mac 不动 app.dock', (t) => {
  if (IS_MAC) return t.skip('本机是 mac，跳过反向断言');
  let touched = false;
  const fakeApp = { dock: { hide: () => { touched = true; } } };
  assert.equal(hideFromDock(fakeApp), false);
  assert.equal(touched, false);
});

test('hideFromDock：没有 app.dock 时不抛', () => {
  assert.equal(hideFromDock({}), false);
  assert.equal(hideFromDock({ dock: null }), false);
});
