'use strict';
/**
 * 物理模拟（纯函数）。红线的根基：
 *  - 物理（重力/惯性/反弹）只在“抛掷释放”和“失去支撑坠落”时运行。
 *  - 普通拖动由渲染层做 1:1 跟随，绝不经过这里的积分。
 *  - 抛掷反弹后宠物必须始终留在活动区域内。
 *
 * 坐标系：活动区域内部坐标，区域左上角为 (0,0)，宽 world.w、高 world.h。
 * 宠物用其“左上角”表示位置，尺寸 w×h。
 * 状态形如 { x, y, vx, vy, grounded }（单位 px / px·s⁻¹）。
 */
const { CFG } = require('./config');
const { clamp } = require('./util');

/** 从释放状态发起一次弹道（速度由手势层给）。 */
function launch(pos, vx, vy) {
  return { x: pos.x, y: pos.y, vx, vy, grounded: false };
}

/**
 * 前进一步。
 * @param {object} s 物理状态
 * @param {number} dt 秒
 * @param {{w:number,h:number}} world 活动区域逻辑大小
 * @param {object} [opts] 覆盖物理参数（测试注入）
 * @returns {{s:object, landed:boolean, hitWall:boolean, hitCeiling:boolean}}
 */
function step(s, dt, world, opts = {}) {
  const P = { ...CFG.physics, ...opts };
  const o = {
    x: s.x, y: s.y, vx: s.vx || 0, vy: s.vy || 0,
    grounded: !!s.grounded,
    w: s.w, h: s.h,   // 必须带出尺寸，否则下一步 maxX/maxY = NaN，所有边界钳制失效
  };
  const landed = false;
  let hitWall = false, hitCeiling = false;

  // 重力（只在飞行时；贴地后不持续积累）
  if (!o.grounded) o.vy += P.gravity * dt;

  // 空气阻力 / 地面摩擦
  const drag = o.grounded ? (P.groundDrag || P.drag) : P.drag;
  const dec = Math.max(0, 1 - drag * dt);
  o.vx *= dec;

  // 积分
  let nx = o.x + o.vx * dt;
  let ny = o.y + o.vy * dt;

  // ---- 水平边界反弹 ----
  const maxX = world.w - s.w;
  if (nx > maxX) {
    if (o.vx > 0) { o.vx = -o.vx * P.restitution; hitWall = true; }
    nx = maxX;
  } else if (nx < 0) {
    if (o.vx < 0) { o.vx = -o.vx * P.restitution; hitWall = true; }
    nx = 0;
  }

  // ---- 天花板 ----
  const maxY = world.h - s.h;
  if (ny < 0) {
    if (o.vy < 0) { o.vy = -o.vy * P.restitution; hitCeiling = true; }
    ny = 0;
  }

  // ---- 地板 ----
  let floorTouched = false;
  if (ny > maxY) {
    floorTouched = true;
    if (o.vy > 0) {
      const speedY = Math.abs(o.vy);
      // 大速度 → 回弹；小速度 → 直接贴地。
      if (speedY > P.stopSpeedY) {
        o.vy = -o.vy * P.restitution;
        hitWall = hitWall; // 落地事件用 landed 标记
        ny = maxY;
      } else {
        o.vy = 0;
        o.grounded = true;
        ny = maxY;
      }
    } else {
      o.vy = 0;
      o.grounded = true;
      ny = maxY;
    }
  }

  // 贴地后若横移速度低于阈值 → 停下（回待机的前置条件）。
  if (o.grounded && Math.abs(o.vx) <= P.stopSpeedX) o.vx = 0;

  // 防御性保证宠物不越界。
  o.x = clamp(nx, 0, maxX);
  o.y = clamp(ny, 0, maxY);

  const nowLanded = floorTouched && !landed && (!s.grounded);
  return { s: o, landed: nowLanded, hitWall, hitCeiling };
}

/** 便捷：是否已达到“贴地静止”可回待机的状态。 */
function atRest(s, opts = {}) {
  const P = { ...CFG.physics, ...opts };
  return !!s.grounded && Math.abs(s.vx) <= P.stopSpeedX && Math.abs(s.vy) <= P.stopSpeedY;
}

/** 事件式循环：跑 N 步到静止或达到步数上限，返回 {final, landedCount}。 */
function runUntilRest(init, world, opts = {}, maxSteps = 10000) {
  let s = init;
  let landedCount = 0;
  for (let i = 0; i < maxSteps; i++) {
    const r = step(s, 1 / 60, world, opts);
    if (r.landed) landedCount++;
    s = r.s;
    if (atRest(s, opts) && s.y >= world.h - s.h - 0.5) break;
  }
  return { final: s, landedCount };
}

module.exports = { launch, step, atRest, runUntilRest };
