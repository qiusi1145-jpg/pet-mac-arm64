'use strict';
/**
 * 像素级判定 + 活动区域几何（纯函数，可单测）。
 *
 * 红线：点击判定永远基于“原始图片像素”：透明处穿透、有像素处可交互；任何动画变形都
 * 不得改变判定区域。判定一律用基于原始像素的位图数据，与 CSS/画布动画表现完全解耦。
 *
 * 位图数据约定：{ width, height, data }，data 为 RGBA（每像素 4 字节，0-255），
 * 行主序、不 premultiply —— 与 Canvas getImageData / 自实现 PNG 解码器输出一致。
 */
const { CFG } = require('./config');
const { clamp } = require('./util');

/**
 * 分析位图，得到不透明区域包围盒与锚点。
 * 锚点 = 实体像素包围盒的大致中心（横纵都取中点），坐标在“图像像素坐标系”。
 * @returns {{hasPixels:boolean, bbox:{x0,y0,x1,y1}|null, anchor:{x,y}|null}}
 */
function analyzeBitmap(bitmap, threshold = CFG.image.alphaThreshold) {
  const { width: w, height: h, data } = bitmap;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { hasPixels: false, bbox: null, anchor: null };
  // bbox 采用“半开区间” [x0,x1)；anchor = 不透明像素横纵中点。
  const bbox = { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
  const anchor = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  return { hasPixels: true, bbox, anchor };
}

/**
 * 像素命中检测：判断图像内像素坐标 (x,y) 是否“有像素”。x,y 可为小数（内部取整）。
 * 越界一律视为不命中（穿透）。
 */
function hitTestPixel(bitmap, x, y, threshold = CFG.image.alphaThreshold) {
  const w = bitmap.width, h = bitmap.height;
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const xi = Math.floor(x), yi = Math.floor(y);
  return bitmap.data[(yi * w + xi) * 4 + 3] >= threshold;
}

/**
 * 缩放计划：超大图等比缩小到 maxDim；本来就不超的图保持原尺寸（不放大）。
 * @returns {{scale,width,height}}
 */
function scalePlan(srcW, srcH, maxDim) {
  if (!(srcW > 0) || !(srcH > 0)) return { scale: 0, width: 0, height: 0 };
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  return {
    scale,
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

/**
 * 生成一张纯色（可选带不透明子矩形）的 RGBA 位图 —— 用于单元测试与 UI 测试夹具。
 */
function makeBitmap(width, height, fill = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[o] = fill ? fill[0] : 255;
    data[o + 1] = fill ? fill[1] : 255;
    data[o + 2] = fill ? fill[2] : 255;
    data[o + 3] = fill ? fill[3] : 255;
  }
  return { width, height, data };
}

/** 在 makeBitmap 基础上把某矩形区域写为指定 RGBA（用于造“已知形状”夹具）。 */
function paintRect(bitmap, x0, y0, x1, y1, rgba) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (y < 0 || x < 0 || y >= bitmap.height || x >= bitmap.width) continue;
      const o = (y * bitmap.width + x) * 4;
      bitmap.data[o] = rgba[0];
      bitmap.data[o + 1] = rgba[1];
      bitmap.data[o + 2] = rgba[2];
      bitmap.data[o + 3] = rgba[3];
    }
  }
  return bitmap;
}

/* ================= 活动区域几何 ================= */

/**
 * 计算默认区域设置：填满整个工作区（屏幕坐标，已排除任务栏）。
 */
function defaultRegionSettings(wa) {
  return { width: wa.width, height: wa.height };
}

/**
 * 根据工作区与区域尺寸设置，计算区域矩形（屏幕坐标、整数、贴底水平居中）。
 * @param {{x,y,width,height}} wa 工作区
 * @param {{width:number,height:number}} s 区域尺寸设置
 * @param {number} [petMaxDim] 宠物最大边长，用于保证区域不至于放不下宠物。
 * @returns {{x,y,width,height}}
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

module.exports = {
  analyzeBitmap,
  hitTestPixel,
  scalePlan,
  makeBitmap,
  paintRect,
  defaultRegionSettings,
  computeRegion,
};
