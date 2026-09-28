'use strict';
/**
 * 平台差异的唯一入口。
 *
 * 规矩：`process.platform` 的判断只准写在这里。主进程别处再出现平台分支，就要顺手挪进来 ——
 * 散落的 `if (win32)` 是移植最容易漏改的东西（吸附当初就住在两个职责共用一个文件里）。
 */

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/**
 * 启动期 Chromium 开关（必须在 app ready 之前调用）。
 *
 * Windows：`CalculateNativeWinOcclusion` 会把"被完全遮挡的本窗"（透明巨窗常会被这么判）
 *   按 hidden 处理 → rAF 停转 → 实测症状"桌宠点不动 + 浮层关不掉"同时出现。直接禁掉该特性。
 * macOS：这是 Windows 专属的特性名，传了也没人认；mac 的遮挡走 AppKit 的
 *   `NSWindow.occlusionState`，而它**按不透明区域计算** —— 一个像素级透明的窗口不构成遮挡物。
 *   所以 mac 侧不需要等价开关，靠渲染层的 `backgroundThrottling:false` + 主进程光标 IPC
 *   驱动命中判定这两条兜底（见 README「像素穿透」红线）。**这条推断仍需真机验证**（VM 无 Metal）。
 */
function applyStartupSwitches(app) {
  if (IS_WIN) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

/**
 * macOS 没有任务栏，`skipTaskbar` 无处生效，图标会占一个 Dock 位 —— 桌宠不该占。
 * 转成 accessory 策略后 Dock 图标消失，但窗口仍可正常显示与接收输入（accessory ≠ 不能成 key）。
 *
 * ⚠ 副作用记在这里，二期要用到：accessory 策略下系统权限弹窗（麦克风 TCC）可能不会自己到前台。
 *   届时需要临时 `app.dock.show()` 再弹，或整体切回 regular。
 */
function hideFromDock(app) {
  if (!IS_MAC || !app.dock) return false;
  try {
    app.dock.hide();
    return true;
  } catch { return false; }
}

/**
 * 宠物窗建好之后的平台专属防护。
 *
 * Windows：写 `WS_EX_TOOLWINDOW`（Chromium 系应用的遮挡检测会永久跳过工具窗口，根治"点宠物
 *   把别的浏览器标签冻住"）。走 `winenum.js` 现编的 winstyle.exe，HWND 从原生句柄小端 64 位读。
 * macOS：没有"工具窗口位"这个概念，透明窗本身就不算遮挡物（见 applyStartupSwitches 的说明），
 *   所以这里**什么都不做** —— 不做静默失败：调用方要拿到 `applied:false` + 原因，写进诊断。
 *
 * @returns {{applied:boolean, reason:string}}
 */
function guardPetWindow(win, winEnum, log) {
  if (!IS_WIN) return { applied: false, reason: `platform:${process.platform}` };
  try {
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
    winEnum.applyExStyle(hwnd, 0x80, 0); // WS_EX_TOOLWINDOW
    return { applied: true, reason: 'WS_EX_TOOLWINDOW' };
  } catch (e) {
    if (log) log('applyExStyle failed', e && e.message);
    return { applied: false, reason: `win32:${(e && e.message) || 'unknown'}` };
  }
}

/**
 * macOS「辅助功能」权限查询 —— 形态三（打字状态）的前置条件。
 *
 * 为什么不能只判断"探针在不在"：未授权时 `addGlobalMonitorForEvents` **照样注册成功**，
 * 但事件永远不来，而且系统不报错。所以必须显式查信任状态，否则就是"选了没反应"的死局。
 *
 * @param {object} systemPreferences Electron 的 systemPreferences（由调用方注入，便于单测）
 * @param {boolean} prompt 是否顺带弹系统授权框 —— 只在用户**主动**选形态三时传 true，
 *   启动/刷新菜单时传 false（不要没事就弹框骚扰用户）。
 * @returns {{known:boolean, trusted:boolean}} known=false 表示本平台/本版本无此概念，不拦。
 */
function accessibilityTrusted(systemPreferences, prompt = false) {
  if (!IS_MAC || !systemPreferences
    || typeof systemPreferences.isTrustedAccessibilityClient !== 'function') {
    return { known: false, trusted: true };
  }
  return { known: true, trusted: !!systemPreferences.isTrustedAccessibilityClient(prompt) };
}

module.exports = { IS_WIN, IS_MAC, applyStartupSwitches, hideFromDock, guardPetWindow, accessibilityTrusted };
