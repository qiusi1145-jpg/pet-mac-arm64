'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { nextStateVisual } = require('../../src/shared/stateVisual');

test('状态图可见性：开关返回相反的视觉状态', () => {
  assert.equal(nextStateVisual(false), true);
  assert.equal(nextStateVisual(true), false);
});
