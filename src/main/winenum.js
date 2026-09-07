'use strict';
/**
 * 窗口枚举（主进程）：用于“吸附到其它窗口”的候选与吸附后的跟随/脱落检测。
 *
 * 方案：不依赖任何原生 Node 模块 —— 用 .NET Framework 自带 csc.exe 把内置的
 * 一小段 C#（Win32 EnumWindows）一次性编译成 exe 到 userData 下，之后每次
 * spawn 该 exe 解析输出即可（单次约几毫秒）。编译失败则降级为空列表并告警
 * （吸附功能失效，但应用其余功能不受影响）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CS_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Text;
class WinEnum {
  delegate bool EProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out bool v, int sz);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  static string Clean(string s){ s=(s??"").Replace('\\t',' ').Replace('\\r',' ').Replace('\\n',' '); return s; }
  static bool Visit(IntPtr h, IntPtr l){
    if(!IsWindowVisible(h)) return true;
    RECT r; GetWindowRect(h, out r);
    if(r.Right<=r.Left || r.Bottom<=r.Top) return true;      // 退化/最小化放到负坐标
    bool iconic = IsIconic(h);
    bool cloaked = false;
    DwmGetWindowAttribute(h, 14, out cloaked, Marshal.SizeOf(typeof(bool))); // DWMWA_CLOAKED
    if(cloaked) return true;                                   // 隐藏标签页等：吸附无意义
    var t = new StringBuilder(512); GetWindowText(h, t, 512);
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    Console.WriteLine(h.ToInt64()+"\\t"+Clean(c.ToString())+"\\t"+Clean(t.ToString())+"\\t"+r.Left+"\\t"+r.Top+"\\t"+r.Right+"\\t"+r.Bottom+"\\t"+(iconic?"1":"0"));
    return true;
  }
  static int Main(){ EnumWindows(Visit, IntPtr.Zero); return 0; }
}
`;

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

class WinEnum {
  constructor(userData) {
    this.userData = userData;
    this.exe = null;
    this.compileError = null;
  }

  /** 确保已编译出枚举 exe；返回是否可用。 */
  ensure(userData = this.userData) {
    if (this.exe) return true;
    const dir = path.join(userData, 'winenum');
    const exe = path.join(dir, 'winenum.exe');
    if (fs.existsSync(exe)) { this.exe = exe; return true; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const src = path.join(dir, 'winenum.cs');
      fs.writeFileSync(src, CS_SOURCE, 'utf8');
      const csc = findCsc();
      if (!csc) throw new Error('csc.exe not found');
      const r = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, src], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'compile fail').slice(0, 400));
      this.exe = exe;
      return true;
    } catch (e) {
      this.compileError = e.message;
      console.error('[winenum] 编译失败（吸附将不可用）：', e.message);
      return false;
    }
  }

  /**
   * 枚举可见顶层窗口。返回形如：
   * [{ id, cls, title, left, top, right, bottom, minimized }]
   * 过滤掉无尺寸的。系统外壳等留给调用方过滤。
   */
  list(userData = this.userData) {
    if (!this.ensure(userData)) return [];
    try {
      const out = execFileSync(this.exe, [], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20 });
      const wins = [];
      for (const line of out.split(/\r?\n/)) {
        const p = line.split('\t');
        if (p.length < 8) continue;
        const [id, cls, title, left, top, right, bottom, mini] = p;
        const L = Number(left), T = Number(top), R = Number(right), B = Number(bottom);
        if (!Number.isFinite(L + T + R + B)) continue;
        if (R <= L || B <= T) continue;
        wins.push({
          id, cls, title,
          left: L, top: T, right: R, bottom: B,
          minimized: mini === '1',
        });
      }
      return wins;
    } catch (e) {
      console.error('[winenum] enumerate failed', e.message);
      return [];
    }
  }
}

/** 系统外壳/无关窗口的排除。仅过滤确定是桌面/任务栏的系统表面。 */
function isSystemWindow(w) {
  const cls = (w.cls || '').toLowerCase();
  const title = (w.title || '').toLowerCase();
  if (cls === 'progman' || cls === 'workerw' || cls === 'shelldll_defview' || cls === 'shell_traywnd') return true;
  if (cls === 'windows.ui.core.corewindow') return true;
  if (title === 'program manager') return true;
  return false;
}

module.exports = { WinEnum, isSystemWindow };
