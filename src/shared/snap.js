'use strict';
/**
 * 吸附判定（纯几何函数）。红线的根基：
 *  - 吸附锚点 = 图片实体像素的大致中心（由 pixel.analyzeBitmap 计算）。
 *  - 锚点水平位于某窗口范围内且贴近其顶沿 → 吸附：实体底边贴窗口顶。
 *
 * 窗口几何使用屏幕坐标（与主进程枚举结果一致）。
 * win 形状：{ handle, left, top, right, bottom, title }，矩形的 top 即其顶沿。
 */
const { CFG } = require('./config');

/**
 * 在所有候选窗口里选一个吸附目标。
 * @param {{x:number,y:number}} anchor 锚点（屏幕坐标）
 * @param {Array} wins 候选窗口（已过滤掉自身/桌面/极小窗口）
 * @returns {object|null} 命中的窗口；找不到返回 null
 */
function chooseSnapTarget(anchor, wins, opts = {}) {
  const P = { ...CFG.physics, ...opts };
  let best = null;
  let bestScore = Infinity;
  for (const w of wins) {
    const { left, top, right } = w;
    // 锚点水平需落在窗口范围内（允许一点余量）
    if (anchor.x < left - P.snapMarginX || anchor.x > right + P.snapMarginX) continue;
    // 贴近顶沿：垂直距离越小越优先；仅接受“位于顶沿附近”（上方/下方均可，常见是刚好落下）
    const dy = Math.abs(anchor.y - top);
    if (dy <= P.snapProximityY) {
      const score = dy; // 垂直最贴者优先
      if (score < bestScore) {
        bestScore = score;
        best = w;
      }
    }
  }
  return best;
}

/**
 * 贴顶位置：给定目标窗口顶沿与宠物高度，返回宠物“底边贴窗口顶”时的宠物左上角屏幕 y。
 */
function attachTopY(winTop, petH) {
  return winTop - petH;
}

/**
 * 吸附中是否应解除（窗口消失/最小化/移动）——由主进程轮询后判断。
 * @returns {boolean} true = 需要坠落
 */
function shouldDetach(snapped, winNow) {
  if (!winNow) return true;
  if (snapped.minimized !== winNow.minimized && winNow.minimized) return true;
  // 窗口几何发生变化（移动/大小）→ 脱离（规格：移动即从原位坠落）
  const moved =
    Math.abs(winNow.left - snapped.left) > 1 ||
    Math.abs(winNow.top - snapped.top) > 1 ||
    Math.abs(winNow.right - snapped.right) > 1 ||
    Math.abs(winNow.bottom - snapped.bottom) > 1;
  return moved;
}

module.exports = { chooseSnapTarget, attachTopY, shouldDetach };
