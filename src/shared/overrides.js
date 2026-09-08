'use strict';
/**
 * 运行期覆盖注册表（核心模块，与开发者模式解耦；交付后保留但始终为空表）。
 *
 * 设计：少数"可定制文案/配置"（主菜单文本与可见性、问候语、聊天文案、提醒模板、
 * 眨眼动画、素材路径等）的读取统一走 `ov(path, cfgValue)`：先查运行期覆盖表，
 * 查不到（或从未设置）再回退 `config.js` 的默认值。
 *
 * - 覆盖表默认为 null —— 此时所有 ov() 都返回 CFG 默认值，行为与"纯默认"完全一致。
 * - 覆盖表的写入方（原开发者模式，2026-09-08 已随交付移除）不复存在，当前恒为空表。
 * - 交付固化的自定义值由"固化配置到代码"脚本写进 src/shared/baked-defaults.json，
 *   由 config.js 在模块加载时合并为新默认值 —— 同样不经过本表、不依赖开发者模式文件夹。
 *
 * 路径语法：点分字符串（'menu.items.rest.label'）。命中语义 = 路径上每一层都存在
 * （hasOwnProperty），最终值即使是 null/false/'' 也算命中（用于显式"恢复默认/关闭"）。
 */

let data = null;

/** 写入整张覆盖表（传 null/非对象 = 清空）。由开发者模式在启动与保存时调用。 */
function setOverrides(obj) {
  data = obj && typeof obj === 'object' ? obj : null;
}

/** 读取当前覆盖表（可能为 null）。 */
function getOverrides() {
  return data;
}

/** 读一个值：覆盖表命中 → 返回覆盖值；否则返回 fallback。 */
function ov(path, fallback) {
  if (!data) return fallback;
  let cur = data;
  for (const k of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) {
      return fallback;
    }
    cur = cur[k];
  }
  return cur === undefined ? fallback : cur;
}

module.exports = { setOverrides, getOverrides, ov };
