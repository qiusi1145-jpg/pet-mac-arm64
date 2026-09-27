'use strict';
/**
 * 打字监听（主进程）：告诉渲染层"有一个文本键被按下了"，仅此而已。
 *
 * 平台分派（形态三的可移植性设计：上层只认 start/stop/'beat'，换平台只换这个文件）：
 *  - win32：用 .NET Framework 自带的 csc.exe 把下面一小段 C#（WH_KEYBOARD_LL 低级键盘钩子）
 *    编译成探针 exe 常驻 spawn，钩子里每命中一个文本键就往 stdout 写一行 `k`。
 *    与 winenum.js 同一条"零原生依赖"路子（不引入任何 npm 原生模块）。
 *  - 其它平台（含 macOS）：available() 返回 false —— 菜单项直接置灰，不做静默无反应。
 *    macOS 落地时要单独准备预编译探针（stock macOS 没有系统自带编译器，"运行期现场编译"
 *    这招在那边不成立），且未授予「辅助功能」权限时事件不会到达，需要引导用户授权。
 *
 * 三条硬约束（改这里前先读懂）：
 *  1. 隐私：探针只输出 `k`，**键值不跨进程**（判定用的白名单在生成源码时嵌进探针里，
 *     父进程收到的仍然只是"有没有按键"）；不写文件、不进日志。
 *  2. 不吞键：钩子恒 CallNextHookEx 且不返回非零，其它程序照常收到每一个键。
 *  3. 只在选中形态三时存在：start/stop 由主进程按形态与窗口可见性驱动，切走即 kill，
 *     系统里不留任何全局钩子。探针回调必须极快（超过系统 LowLevelHooksTimeout 会被静默摘钩），
 *     所以回调里只有一次 HashSet 查表 + 一次 Write。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { findCsc } = require('./winenum');
const { textKeyVkList } = require('../shared/typing');

const WM_KEYDOWN = 0x0100;
const WH_KEYBOARD_LL = 13;

/** 文本键白名单在生成期嵌进探针：Node 侧 shared/typing.js 是唯一事实来源（可单测）。 */
function probeSource() {
  const vks = textKeyVkList().join(',');
  return `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
class KeyBeat {
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hWnd, int f1, int f2);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int px; public int py; }
  [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public int vkCode; public int scanCode; public int flags; public int time; public IntPtr extraInfo; }
  // 委托必须由静态字段持有：只交给 SetWindowsHookEx 的局部变量会被 GC 回收，
  // 之后系统回调进来时委托已死 → 探针进程直接崩（.NET 封送的经典坑）。
  static HookProc Proc;
  static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0 && (int)wParam == ${WM_KEYDOWN}) {
      var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      if (Text.Contains(k.vkCode)) Console.Out.WriteLine("k"); // 只报"有一个文本键被按下"
    }
    return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);  // 绝不错过、绝不吞键
  }
  static readonly HashSet<int> Text = new HashSet<int>(new int[]{ ${vks} });
  static int Main() {
    Proc = Callback;
    IntPtr hook = SetWindowsHookEx(${WH_KEYBOARD_LL}, Proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) return 3;
    MSG m; // 低级钩子的回调在装钩子的线程上派发，必须有消息泵
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
    UnhookWindowsHookEx(hook);
    return 0;
  }
}
`;
}

/** 源码变一版就换一个文件名：避免旧探针 exe 被缓存下来继续用（白名单改了却不生效）。 */
function probeExeName(src) {
  return `keybeat-${crypto.createHash('sha1').update(src).digest('hex').slice(0, 10)}.exe`;
}

class TypingMonitor extends EventEmitter {
  constructor(userData) {
    super();
    this.userData = userData;
    this.child = null;
    this.lines = null;
    this.error = null;      // 最近一次失败原因（null = 没失败过）
    this.compileMs = 0;     // 首次编译耗时（诊断用）
  }

  /** 本平台能否监听打字（不代表已启动）。 */
  available() {
    return process.platform === 'win32' && !!findCsc();
  }

  running() { return !!this.child; }

  status() {
    return {
      platform: process.platform,
      available: this.available(),
      running: this.running(),
      error: this.error,
      compileMs: this.compileMs,
    };
  }

  /** 确保探针 exe 已编译（幂等，返回路径或 null）。同步编译与 winenum.js 一致：只在 start 时走一次。 */
  ensureExe() {
    const src = probeSource();
    const dir = path.join(this.userData, 'typing');
    const exe = path.join(dir, probeExeName(src));
    if (fs.existsSync(exe)) return exe;
    const t0 = Date.now();
    fs.mkdirSync(dir, { recursive: true });
    const cs = path.join(dir, probeExeName(src).replace(/\.exe$/, '.cs'));
    fs.writeFileSync(cs, src, 'utf8');
    const csc = findCsc();
    if (!csc) throw new Error('csc.exe not found');
    const r = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, cs],
      { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'compile fail').slice(0, 400));
    this.compileMs = Date.now() - t0;
    return exe;
  }

  /** 启动监听（幂等）。@returns {boolean} 是否已在监听 */
  start() {
    if (this.child) return true;
    if (process.platform !== 'win32') {
      this.error = `unsupported-platform(${process.platform})`;
      return false;
    }
    try {
      const exe = this.ensureExe();
      const child = spawn(exe, [], {
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.on('error', (e) => {
        this.error = `spawn:${e.message}`;
        console.error('[typing] 打字探针启动失败：', this.error);
        this._teardown();
      });
      child.on('exit', (code) => {
        // stop() 会先把 this.child 置空，所以这里只有"自己退了"才会走到这条
        const unexpected = this.child === child;
        this._teardown();
        if (unexpected) {
          this.error = `probe-exited(${code})`;
          console.error('[typing] 打字探针意外退出，形态三停在"不打字"素材：', this.error);
        }
      });
      // 探针每命中一个文本键写一行 k；其它行一律忽略（不认识的当噪声，协议要扩再往上加）
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (l) => { if (l.trim() === 'k') this.emit('beat'); });
      this.child = child;
      this.lines = lines;
      this.error = null;
      return true;
    } catch (e) {
      this.error = e.message;
      console.error('[typing] 打字监听启动失败（形态三将停在"不打字"素材）：', e.message);
      return false;
    }
  }

  /** 停止监听（幂等）：杀掉探针，系统里的低级钩子随进程一起消失。 */
  stop() {
    const child = this.child;
    this._teardown();
    if (!child) return;
    try { child.kill(); } catch { /* 已经退了 */ }
  }

  _teardown() {
    if (this.lines) { this.lines.close(); this.lines = null; }
    this.child = null;
  }
}

module.exports = { TypingMonitor, probeSource, probeExeName };
