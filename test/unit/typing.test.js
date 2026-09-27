'use strict';
/**
 * 「打字状态」纯逻辑守卫（src/shared/typing.js）。
 *
 * 这里锁死的是用户定稿的行为线，一条都不许漂：
 *  每按下一下键盘 → 打字图1/图2 交替一次；停手 idleMs → 第三张图（且下次起手回到图1）。
 * 时间全部由测试注入，不依赖真键盘。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TEXT_KEY_VK_RANGES, textKeyVkList, isTextKeyVk, TYPING_IDLE,
  typingCfg, createTypingMachine, onTypingBeat, onTypingIdleCheck,
} = require('../../src/shared/typing');

const CFG = { idleMs: 1000, minFlipMs: 50 };
const T = 1_700_000_000_000;

/* ================= 键白名单 ================= */

test('白名单：字母/数字/空格/标点/回车/退格算打字', () => {
  for (const vk of [0x41, 0x5A, 0x30, 0x39, 0x20, 0x0D, 0x08, 0xBA, 0xDE, 0x60, 0x69, 0x6E]) {
    assert.ok(isTextKeyVk(vk), `0x${vk.toString(16)} 应算打字`);
  }
});

test('白名单：修饰键/功能键/方向键/Tab 都不算打字（否则按 Ctrl+C、切窗口会误触发）', () => {
  const notTyping = [
    0x10, 0x11, 0x12, // Shift / Ctrl / Alt
    0x5B, 0x5C,       // Win / 右 Win
    0x09,             // Tab（多是导航，不是输入）
    0x1B,             // Esc
    0x25, 0x26, 0x27, 0x28, // 方向键
    0x70, 0x75,       // F1~F6
    0x2C, 0x2D, 0xEF, // PrintScreen / Insert
    0xC1,             // 标点区间外的下一个键（区间右界必须正好收在 0xC0）
  ];
  for (const vk of notTyping) assert.ok(!isTextKeyVk(vk), `0x${vk.toString(16)} 不该算打字`);
  assert.ok(!isTextKeyVk('x'), '非数字输入一律 false');
  assert.ok(!isTextKeyVk(NaN), 'NaN false');
});

test('textKeyVkList 与区间表一致（探针源码由它生成，两侧不能各说各话）', () => {
  const list = textKeyVkList();
  let expect = 0;
  for (const [a, b] of TEXT_KEY_VK_RANGES) expect += b - a + 1;
  assert.equal(list.length, expect);
  assert.ok(list.every((v, i) => i === 0 || v > list[i - 1]), '必须严格升序无重复');
  assert.ok(list.every(isTextKeyVk), '展开出来的每个键码都必须被判定为打字');
});

/* ================= 打字帧交替 ================= */

test('逐键交替：四下按键的帧序是 0,1,0,1', () => {
  let s = createTypingMachine();
  const frames = [];
  for (const now of [T, T + 200, T + 400, T + 600]) {
    const r = onTypingBeat(s, now, CFG);
    s = r.s;
    frames.push(r.frame);
  }
  assert.deepEqual(frames, [0, 1, 0, 1]);
});

test('停手后再起打，固定从第 0 帧起（不能"一上来就是抬手帧"）', () => {
  let s = createTypingMachine();
  s = onTypingBeat(s, T, CFG).s;          // 0
  s = onTypingBeat(s, T + 200, CFG).s;    // 1
  s = onTypingIdleCheck(s, T + 200 + 1000).s; // 停手 1s → 回第三张图
  assert.equal(s.phase, TYPING_IDLE);
  const r = onTypingBeat(s, T + 5000, CFG);
  assert.equal(r.frame, 0);
});

test('minFlipMs 限幅：两拍间隔不足 50ms 时不翻帧，但停手倒计时照样续期', () => {
  let s = createTypingMachine();
  const a = onTypingBeat(s, T, CFG);        s = a.s;   // frame 0
  const b = onTypingBeat(s, T + 49, CFG);   s = b.s;   // 不足 50ms → 仍 0
  const c = onTypingBeat(s, T + 98, CFG);   s = c.s;   // 相对上次翻帧已满 50ms → 1
  assert.equal(a.frame, 0);
  assert.equal(b.frame, 0);
  assert.equal(c.frame, 1);
  assert.equal(b.s.lastFlip, T, '被限幅的那一拍不该推进 lastFlip');
  assert.equal(b.s.deadline, T + 49 + CFG.idleMs, '限幅只限帧，续期不停');
});

test('每拍都把停手倒计时重置为 idleMs（连打时不会中途跳回第三张图）', () => {
  let s = createTypingMachine();
  s = onTypingBeat(s, T, CFG).s;
  assert.equal(s.deadline, T + 1000);
  s = onTypingBeat(s, T + 700, CFG).s;
  assert.equal(s.deadline, T + 1700);
  // 到 T+1600 时距最后一拍只过 900ms：还没到点，且要再等 100ms
  const r = onTypingIdleCheck(s, T + 1600);
  assert.equal(r.idle === undefined, true);
  assert.equal(r.frame, s.phase);
  assert.equal(r.waitMs, 100);
});

/* ================= 停手 1 秒 → 第三张图 ================= */

test('idleMs 到期：frame = TYPING_IDLE 且相位复位', () => {
  const s = onTypingBeat(createTypingMachine(), T, CFG).s;
  const early = onTypingIdleCheck(s, T + 999);
  assert.equal(early.waitMs, 1);
  assert.notEqual(early.frame, TYPING_IDLE);
  const due = onTypingIdleCheck(s, T + 1000);
  assert.equal(due.frame, TYPING_IDLE);
  assert.equal(due.waitMs, 0);
  assert.equal(due.s.phase, TYPING_IDLE);
});

test('本来就是停手态：判一次还是 TYPING_IDLE，不产生多余动作', () => {
  const s = createTypingMachine();
  const r = onTypingIdleCheck(s, T);
  assert.equal(r.frame, TYPING_IDLE);
  assert.equal(r.waitMs, 0);
  assert.equal(r.s, s, '未起打时状态对象原样返回');
});

/* ================= config 清洗 ================= */

test('typingCfg：非法值夹到安全区间，缺失回默认', () => {
  assert.deepEqual(typingCfg({}), { idleMs: 1000, minFlipMs: 50 });
  assert.deepEqual(typingCfg({ idleMs: -5, minFlipMs: 99999 }), { idleMs: 200, minFlipMs: 500 });
  assert.deepEqual(typingCfg({ idleMs: 2500, minFlipMs: 0 }), { idleMs: 2500, minFlipMs: 0 });
  assert.deepEqual(typingCfg(null), { idleMs: 1000, minFlipMs: 50 });
});

test('默认 config 的 typing 素材路径与帧数满足形态三（两帧 + 一张不打字图）', () => {
  const { CFG: appCfg } = require('../../src/shared/config');
  const t = appCfg.typing;
  assert.equal(t.frames.length, 2, '打字态固定两张图随按键交替');
  assert.ok(t.frames.every((p) => typeof p === 'string' && p.startsWith('../')), '内置帧走渲染层相对路径规则');
  assert.ok(typeof t.idleFrame === 'string' && t.idleFrame.startsWith('../'));
  assert.equal(t.idleMs, 1000, '用户定稿：停手 1 秒回第三张图');
});

/* ================= 探针源码生成（主进程侧，src/main/typing.js） =================
 * 白名单的唯一事实来源是上面的 JS 区间表；探针（C#）只是它的投影。真机上验证过一次
 * 合成按键的时间轴与节拍逐一对齐，但"哪个键算打字"这件事在 JS 层就能锁死，不必依赖
 * 环境干净（系统级钩子会同时看到用户真人在打的字）。 */

const { probeSource, probeExeName, TypingMonitor } = require('../../src/main/typing');

test('探针里嵌的键码集合 == JS 白名单，且修饰键一个都没混进去', () => {
  const src = probeSource();
  const m = src.match(/new int\[\]\{ ([0-9,]+) \}/);
  assert.ok(m, '探针源码里找不到 HashSet 字面量（生成方式变了要同步这条测）');
  const embedded = m[1].split(',').map(Number);
  assert.deepEqual(embedded, textKeyVkList(), '探针与 shared/typing.js 的白名单不一致');
  for (const mod of [16, 17, 18, 91, 9]) { // Shift/Ctrl/Alt/Win/Tab
    assert.ok(!embedded.includes(mod), `探针白名单混进了 0x${mod.toString(16)}`);
  }
  // 探针只上报无信息量的节拍：源码里不许出现键值输出
  assert.ok(/WriteLine\("k"\)/.test(src), '探针必须只写一行 k');
  assert.ok(!/WriteLine\(.*vkCode|ToString\(\)\s*\+\s*k\.vkCode/.test(src), '探针不许把键值传出进程');
});

test('白名单一改，探针 exe 文件名就变（否则旧 exe 缓存会让改动不生效）', () => {
  const a = probeExeName(probeSource());
  assert.match(a, /^keybeat-[0-9a-f]{10}\.exe$/);
  assert.equal(a, probeExeName(probeSource()), '同源码必须同名（幂等，不重复编译）');
  assert.notEqual(a, probeExeName(probeSource() + '// 改一个字符'), '源码变化必须换名');
});

test('非 Windows 平台：available() false 且 start() 失败但不抛（菜单据此置灰，不做静默无反应）', () => {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  const m = new TypingMonitor(require('os').tmpdir());
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    assert.equal(m.available(), false);
    assert.equal(m.start(), false);
    assert.equal(m.running(), false);
    assert.match(m.status().error, /unsupported-platform/);
    m.stop(); // 没起来也不许抛
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
  assert.equal(m.status().platform, desc.value, '测试必须把 process.platform 还原');
});
