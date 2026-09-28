'use strict';
/**
 * 窗口扩展样式修改器（主进程，仅 win32）。
 *
 * 用途只有一个：给宠物窗写 `WS_EX_TOOLWINDOW` —— README「不冻结其它 Chromium 窗口」三层防护的
 * 根治手段（Chromium 系应用的遮挡检测会永久跳过工具窗口）。**不是**窗口枚举：吸附功能已于
 * 2026-09-28 随 macOS 移植决策整体删除，原先住在这个文件里的 EnumWindows 那半已移除。
 *
 * 方案沿用"零原生依赖"：用 .NET Framework 自带 csc.exe 把下面一小段 C# 一次性编译成 exe
 * 到 userData 下，之后每次 spawn 该 exe（编译失败则静默跳过，只是少一层防护，不影响功能）。
 *
 * 文件名保留 `winenum.js` 只为少改引用（`typing.js` 从这里借 `findCsc`）；名字与职责已不符。
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

/** 找 .NET Framework 的 csc.exe（Windows 11 自带 4.x）。 */
function findCsc() {
  const windir = process.env.windir || 'C:\\Windows';
  const bases = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319'),
  ];
  for (const b of bases) {
    const p = path.join(b, 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  // 兜底：PATH 里找
  const r = spawnSync('where', ['csc.exe'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    const p = r.stdout.split(/\r?\n/).find((s) => s && s.trim());
    if (p) return p.trim();
  }
  return null;
}

/** 窗口扩展样式修改小工具（编译一次常驻复用）：winstyle.exe <hwnd十进制> <要加的位> <要清的位> */
const STYLE_SOURCE = `
using System;
using System.Runtime.InteropServices;
class WinStyle {
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  static int Main(string[] args) {
    if (args.Length < 3) return 2;
    var h = new IntPtr(long.Parse(args[0]));
    var add = unchecked((int)long.Parse(args[1]));
    var remove = unchecked((int)long.Parse(args[2]));
    var cur = GetWindowLong(h, -20); // GWL_EXSTYLE
    SetWindowLong(h, -20, (cur | add) & ~remove);
    return 0;
  }
}
`;

class WinEnum {
  constructor(userData) {
    this.userData = userData;
    this.styleExe = null;
  }

  /** 确保已编译出样式修改 exe；返回 exe 路径或 null。 */
  ensureStyle(userData = this.userData) {
    if (this.styleExe) return this.styleExe;
    const dir = path.join(userData, 'winenum');
    const exe = path.join(dir, 'winstyle.exe');
    if (fs.existsSync(exe)) { this.styleExe = exe; return exe; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const src = path.join(dir, 'winstyle.cs');
      fs.writeFileSync(src, STYLE_SOURCE, 'utf8');
      const csc = findCsc();
      if (!csc) throw new Error('csc.exe not found');
      const r = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, src], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'compile fail').slice(0, 400));
      this.styleExe = exe;
      return exe;
    } catch (e) {
      console.error('[winenum] 样式工具编译失败：', e.message);
      return null;
    }
  }

  /**
   * 修改窗口扩展样式（异步，不阻塞主进程）。
   * addMask / removeMask：要置位 / 要清位的掩码（十进制字符串或 number）。
   */
  applyExStyle(hwndDec, addMask, removeMask) {
    const exe = this.ensureStyle();
    if (!exe) return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile(exe, [String(hwndDec), String(addMask), String(removeMask)], { windowsHide: true }, (err) => {
        if (err) console.error('[winenum] applyExStyle failed', err.message);
        resolve(!err);
      });
    });
  }
}

module.exports = { WinEnum, findCsc };
