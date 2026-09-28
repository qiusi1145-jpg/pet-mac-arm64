'use strict';
/**
 * 「打字状态」（形态三）的纯逻辑：文本键白名单 + 打字帧交替 + 停手判定。
 * 行为线（用户 2026-09-27 明确过两遍，别改口径）：
 *   每按下一下键盘 → 打字图1 / 打字图2 交替一次；
 *   停手 idleMs（默认 1000ms）没有新按键 → 显示第三张图（不打字）。
 *
 * 全部无副作用、时间由调用方注入（渲染层传 Date.now()，单测传假时钟），所以这条
 * 行为线能在 node --test 里锁死，不依赖真去敲键盘。
 *
 * 隐私红线：跨进程只传"有一个文本键被按下"这个事实，键值不出探针、不落盘、不进日志。
 * 下面的白名单是**生成探针源码的输入**（src/main/typing.js 把它嵌进 C#），判定发生在
 * 探针内部，所以父进程连"按了哪个键"都不知道。
 */
const { CFG } = require('./config');

/** 会往文档里留下字符的键（Windows 虚拟键码区间，含端点）。
 *  刻意不算打字：Ctrl/Alt/Shift/Win 单按与组合、功能键、方向键、Tab ——
 *  否则按 Ctrl+C、切窗口也会"突然开始打字"。
 *  ⚠ "组合"这一半**不在这张表里**，得由探针自己查修饰键状态：
 *    win32 探针用 GetAsyncKeyState 查 Ctrl/Alt/Win（Shift 不排除），
 *    darwin 探针查 CGEventFlags 的 Control/Alternate/Command。
 *    两平台都在"字符键命中之后"才查，保证回调开销只加在该加的那一下。 */
const TEXT_KEY_VK_RANGES = [
  [0x08, 0x08], // Backspace
  [0x0D, 0x0D], // Enter
  [0x20, 0x20], // Space
  [0x30, 0x39], // 0-9
  [0x41, 0x5A], // A-Z
  [0x60, 0x69], // 小键盘 0-9
  [0x6E, 0x6E], // 小键盘 .
  [0xBA, 0xC0], // ; = , - . / `
  [0xDB, 0xDE], // [ \ ] '
];

/** 白名单展开成升序键码数组（探针源码里作为 HashSet 字面量嵌入）。 */
function textKeyVkList() {
  const out = [];
  for (const [a, b] of TEXT_KEY_VK_RANGES) {
    for (let v = a; v <= b; v++) out.push(v);
  }
  return out;
}

function isTextKeyVk(vk) {
  const v = Number(vk);
  if (!Number.isFinite(v)) return false;
  for (const [a, b] of TEXT_KEY_VK_RANGES) if (v >= a && v <= b) return true;
  return false;
}

/**
 * macOS 侧的等价白名单 —— **与上面 VK 表同一套语义，唯一事实来源也在这里**。
 *
 * 为什么 mac 不能沿用 VK 码：探针要构建期预编译（macOS 没有系统自带编译器，"运行期现编 C#"
 * 这招不成立），而 macOS 的虚拟键码随键盘布局变。所以 mac 探针改判**字符**：
 * `charactersIgnoringModifiers` 忽略 Shift，于是 Shift+A→a、Shift+/→/，
 * 与 Windows 的 VK 语义天然对齐（VK 表里 0x41-0x5A / 0x30-0x39 / 标点区都在）。
 *
 * 只算打字：字母、数字、标点、空格、Return、退格、向前删。
 * 一律不算：Ctrl/Alt/Cmd 单按与组合、功能键、方向键、Tab —— 与 Windows 侧完全一致。
 */
const TEXT_CHARS_MAC = 'abcdefghijklmnopqrstuvwxyz0123456789 ;=,-./`[]\x5c\x27';
// 36=Return  51=Delete(退格)  117=Forward Delete。空格在字符表里已覆盖，不重复列。
const TEXT_KEYCODES_MAC = [36, 51, 117];

/**
 * mac 探针判定规则的 JS 镜像（运行时判定发生在探针内部，这里只给单测锁语义）。
 * ⚠ 改了它必须同步 src/main/mac/keybeat.m，否则"单测绿但探针行为不同"。
 */
function isTextKeyMac({ characters, keyCode, controlHeld = false, optionHeld = false, commandHeld = false } = {}) {
  if (controlHeld || optionHeld || commandHeld) return false;
  if (Number.isFinite(keyCode) && TEXT_KEYCODES_MAC.includes(keyCode)) return true;
  if (typeof characters !== 'string') return false;
  const c = characters.toLowerCase();
  return c.length === 1 && TEXT_CHARS_MAC.includes(c);
}

/** 探针的注入参数：[可打印字符白名单, 特殊键码 CSV]。键值仍然不出探针进程。 */
function macProbeArgs() {
  return [TEXT_CHARS_MAC, TEXT_KEYCODES_MAC.join(',')];
}

/** 帧号 -1 = 不在打字 → 显示第三张图（不打字素材）。 */
const TYPING_IDLE = -1;

/** 清洗 config.typing 的两个时间参数（手改配置可能出现非法值；与 blink.js 同思路）。 */
function typingCfg(raw = CFG.typing) {
  const t = raw || {};
  const n = (v, def, lo, hi) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : def;
  };
  return {
    idleMs: n(t.idleMs, 1000, 200, 30000),
    minFlipMs: n(t.minFlipMs, 50, 0, 500),
  };
}

/** 打字机状态：phase = 当前打字帧号（0/1）或 TYPING_IDLE；deadline = 停手判定的时刻。 */
function createTypingMachine() {
  return { phase: TYPING_IDLE, lastFlip: 0, deadline: 0 };
}

/**
 * 一次打字节拍（纯函数）。返回 { s, frame, idleInMs }：
 *  - frame = 0|1：从停手状态重新开始打时固定给 0（"起手就是抬手帧"会看着别扭）；
 *  - 两次拍间隔 < minFlipMs 时不翻帧（长按自动重复约 31 次/秒，不限幅会抖成高频闪烁），
 *    但停手倒计时照样续期；
 *  - idleInMs：调用方按它重排"停手回第三张图"的定时器。
 */
function onTypingBeat(s, now, cfg = typingCfg()) {
  const starting = s.phase === TYPING_IDLE;
  const flip = starting || now - s.lastFlip >= cfg.minFlipMs;
  const phase = starting ? 0 : flip ? 1 - s.phase : s.phase;
  return {
    s: { phase, lastFlip: flip ? now : s.lastFlip, deadline: now + cfg.idleMs },
    frame: phase,
    idleInMs: cfg.idleMs,
  };
}

/**
 * 停手判定（纯函数，定时器到点调用）。返回 { s, frame, waitMs }：
 *  - waitMs > 0：还没到 idleMs（期间又来了节拍），按它再排一次；
 *  - frame = TYPING_IDLE：停手了，显示第三张图，同时**相位复位**
 *    （下一次打字重新从第 0 帧起）。
 */
function onTypingIdleCheck(s, now) {
  if (s.phase === TYPING_IDLE) return { s, frame: TYPING_IDLE, waitMs: 0 };
  const left = s.deadline - now;
  if (left > 0) return { s, frame: s.phase, waitMs: left };
  return { s: createTypingMachine(), frame: TYPING_IDLE, waitMs: 0 };
}

module.exports = {
  TEXT_KEY_VK_RANGES,
  textKeyVkList,
  isTextKeyVk,
  TEXT_CHARS_MAC,
  TEXT_KEYCODES_MAC,
  isTextKeyMac,
  macProbeArgs,
  TYPING_IDLE,
  typingCfg,
  createTypingMachine,
  onTypingBeat,
  onTypingIdleCheck,
};
