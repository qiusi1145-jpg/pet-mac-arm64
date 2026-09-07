'use strict';
/**
 * 活动区域计算（纯函数）。
 *
 * 活动区域定义：屏幕上的一块矩形区域，宠物只在该区域内活动；宠物窗口 == 该区域，
 * 背景图铺满该区域。区域默认 = 主屏去掉任务栏的工作区；可调大小，始终保持
 * “贴屏幕底部 + 水平居中”。区域变化时主窗口随之 setBounds。
 */
const { clamp } = require('./util');

/**
 * 计算默认区域设置：填满整个工作区。
 * @param {{x,y,width,height}} wa 工作区（屏幕坐标，已排除任务栏）
 * @returns {{width:number,height:number}}
 */
function defaultRegionSettings(wa) {
  return { width: wa.width, height: wa.height };
}

/**
 * 根据工作区与区域尺寸设置，计算区域矩形（屏幕坐标、整数、贴底水平居中）。
 * @param {{x,y,width,height}} wa
 * @param {{width:number,height:number}} s
 * @param {number} [petMaxDim] 宠物最大边长，用于保证区域不至于放不下宠物。
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function computeRegion(wa, s, petMaxDim = 0) {
  const minW = Math.max(200, Math.min(wa.width, petMaxDim + 40));
  const minH = Math.max(200, Math.min(wa.height, petMaxDim + 40));
  const width = Math.round(clamp(Math.round(s.width), minW, wa.width));
  const height = Math.round(clamp(Math.round(s.height), minH, wa.height));
  const x = Math.round(wa.x + (wa.width - width) / 2);
  const y = Math.round(wa.y + (wa.height - height)); // 底边对齐 wa 底边
  return { x, y, width, height };
}

/** 区域是否包含某个矩形（用于判断宠物/指针是否越界）。 */
function rectContains(r, x, y) {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/** 把点夹回区域内部。 */
function clampPointToRegion(r, x, y, margin = 0) {
  return {
    x: clamp(x, r.x + margin, r.x + r.width - margin),
    y: clamp(y, r.y + margin, r.y + r.height - margin),
  };
}

/** 工作区切掉 taskbar：screen.getPrimaryDisplay().workArea 已经去掉任务栏。这里提供重算入口（备用）。 */

module.exports = {
  defaultRegionSettings,
  computeRegion,
  rectContains,
  clampPointToRegion,
};
