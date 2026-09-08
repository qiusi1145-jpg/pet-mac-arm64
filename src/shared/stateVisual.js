'use strict';

/** 切换“状态图”可见性。只影响视觉，不影响任何状态数值或点击判定。 */
function nextStateVisual(visible) {
  return !visible;
}

module.exports = { nextStateVisual };
