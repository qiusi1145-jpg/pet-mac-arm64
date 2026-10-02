'use strict';
/**
 * 自动动画（原「眨眼」+「随机特效」合并）的纯函数守卫。
 * 行为线（用户 2026-10-02 定）：每 6~7 秒到点一次 → 80% 概率播 → 命中后随机挑一组
 * （三种动画 = 三组，帧数 1/1/2），每帧 150ms，播完回主图。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeAutoAnim, nextDelayMs, shouldAnimate, pickGroupIndex,
} = require('../../src/shared/autoAnim');
const { CFG } = require('../../src/shared/config');

const G3 = (over = {}) => normalizeAutoAnim({
  minIntervalMs: 6000, maxIntervalMs: 7000, chance: 0.8, frameMs: 150,
  groups: [{ name: 'a', frames: ['x.png'] }, { name: 'b', frames: ['y.png'] }, { name: 'c', frames: ['z1.png', 'z2.png'] }],
  ...over,
});

test('默认配置：6~7 秒一次、80% 概率、每帧 150ms、三组帧数 1/1/2', () => {
  const c = normalizeAutoAnim();
  assert.equal(c.minIntervalMs, 6000);
  assert.equal(c.maxIntervalMs, 7000);
  assert.equal(c.chance, 0.8);
  assert.equal(c.frameMs, 150);
  assert.deepEqual(c.groups.map((g) => g.frames.length), [1, 1, 2]);
});

test('配置清洗：区间写反不许产生负等待，概率与时长夹到合法区间', () => {
  const rev = normalizeAutoAnim({ minIntervalMs: 9000, maxIntervalMs: 1000, groups: [{ name: 'a', frames: ['x'] }] });
  assert.ok(rev.maxIntervalMs >= rev.minIntervalMs, `区间被写反却没纠正：${rev.minIntervalMs}~${rev.maxIntervalMs}`);
  assert.equal(normalizeAutoAnim({ chance: 5, groups: [{ name: 'a', frames: ['x'] }] }).chance, 1, 'chance 上界没夹');
  assert.equal(normalizeAutoAnim({ chance: -2, groups: [{ name: 'a', frames: ['x'] }] }).chance, 0, 'chance 下界没夹');
  assert.equal(normalizeAutoAnim({ chance: 'abc', groups: [{ name: 'a', frames: ['x'] }] }).chance, 0.8, '非法概率应回默认');
  assert.equal(normalizeAutoAnim({ frameMs: 1, groups: [{ name: 'a', frames: ['x'] }] }).frameMs, 30, 'frameMs 下界');
  assert.equal(normalizeAutoAnim({ frameMs: 99999, groups: [{ name: 'a', frames: ['x'] }] }).frameMs, 5000, 'frameMs 上界');
});

test('配置清洗：空组、无 path 的帧、非数组一律丢掉（半组会显示残缺）', () => {
  const c = normalizeAutoAnim({
    groups: [
      { name: 'ok', frames: ['a.png', '', null, 'b.png'] },
      { name: 'empty', frames: [] },
      { name: 'bad', frames: 'not-array' },
      null,
    ],
  });
  assert.equal(c.groups.length, 1);
  assert.deepEqual(c.groups[0].frames, ['a.png', 'b.png']);
  assert.deepEqual(normalizeAutoAnim(null).groups, []);
  assert.deepEqual(normalizeAutoAnim({ groups: 'x' }).groups, []);
});

test('到点等待落在 [min,max] 区间内（含两端），且随机源异常时不炸', () => {
  const c = G3();
  assert.equal(nextDelayMs(c, () => 0), 6000);
  assert.equal(nextDelayMs(c, () => 1), 7000);
  assert.equal(nextDelayMs(c, () => 0.5), 6500);
  for (const bad of [undefined, NaN, -1, 2, 'x', null]) {
    const d = nextDelayMs(c, () => bad);
    assert.ok(d >= 6000 && d <= 7000, `随机源给 ${String(bad)} 时等待算成 ${d}，跑出区间了`);
  }
});

test('掷概率：0 永不播、1 必播、0.8 按 rng 判；没有可播的组一律不播', () => {
  assert.equal(shouldAnimate(G3({ chance: 0 }), () => 0.01), false, 'chance=0 却播了');
  assert.equal(shouldAnimate(G3({ chance: 1 }), () => 0.999), true);
  assert.equal(shouldAnimate(G3({ chance: 0.8 }), () => 0.79), true);
  assert.equal(shouldAnimate(G3({ chance: 0.8 }), () => 0.81), false);
  assert.equal(shouldAnimate(G3({ chance: 1, groups: [] }), () => 0), false, '无组还报要播');
});

test('随机选组：下标必须落在组内，越界与非法都收口', () => {
  const c = G3();
  assert.equal(pickGroupIndex(c, () => 0), 0);
  assert.equal(pickGroupIndex(c, () => 0.34), 1);
  assert.equal(pickGroupIndex(c, () => 0.999), 2);
  assert.equal(pickGroupIndex(c, () => NaN), 0, '非法随机值应退回第一组而不是越界');
  assert.equal(pickGroupIndex(G3({ groups: [] }), () => 0.5), -1);
});

test('旧的三套调度配置不许复活：眨眼 / 随机特效 / 多帧眨眼动画 / 呼吸', () => {
  assert.equal(CFG.blink, undefined, 'CFG.blink 仍在 —— 应与 autoAnim 合并，不是并存');
  assert.equal(CFG.effectAnim, undefined, 'CFG.effectAnim 仍在');
  assert.equal(CFG.blinkAnim, undefined, 'CFG.blinkAnim 仍在');
  assert.equal(CFG.stateImage, undefined, '形态二已删除，stateImage 不该还在');
  assert.equal(require('fs').existsSync(require('path').join(__dirname, '../../src/shared/blink.js')), false,
    'shared/blink.js 应随合并一起删除，避免留下第二套事实来源');
  assert.equal(CFG.anim && CFG.anim.breatheAmplitude, undefined, '待机呼吸已删，不该回来');
  assert.equal(CFG.autoAnim && CFG.autoAnim.groups.length >= 3, true, 'autoAnim 三组是本次改版的核心配置');
});
