'use strict';
/**
 * 动作与运动模型（纯函数，可单测）：手势判定 → 抛掷/坠落物理 → 弹簧(q 弹) → 窗口吸附。
 * 红线：阈值全来自 config；物理只在“抛掷释放”与“失去支撑坠落”运行；普通拖动是 1:1
 * 跟随、绝不经过这里的积分；抛掷反弹后宠物必须始终留在活动区域内。
 */

const { CFG } = require('./config');
const { clamp } = require('./util');

/* ================= 手势判定 ================= */

const LEFT = 0, RIGHT = 2;

const MODE_IDLE = 'idle';
const MODE_PRESS = 'press';   // 按键刚按下，尚未决定是 tap / 长按 / 拖动
const MODE_RING = 'ring';     // 左键按住超过 ringDelay，进度圈反馈中（尚未达到 3s）
const MODE_DRAG = 'drag';     // 已判定为拖动

class GestureTracker {
  constructor(opts = {}) {
    this.cfg = { ...CFG.image, ...opts }; // tapMaxMs / dragTolerance / ringDelayMs / longPressMs / menuPressMs
    this.reset();
  }

  reset() {
    this.mode = MODE_IDLE;
    this.button = null;
    this.start = null;      // {x,y,t}
    this.last = null;       // {x,y,t} 最近一次位置
    this.samples = [];      // 最近若干 {x,y,t}（用于算释放速度）
    this.actions = [];      // 未消费的动作队列
    this.tapLocked = false; // 已由长按触发，忽略本次释放
    this.holdProgress = 0;  // 长按进度 0..1
    this.ringShown = false;
    return this;
  }

  /** 供外部读取未消费动作，并清空。 */
  drainActions() {
    const a = this.actions;
    this.actions = [];
    return a;
  }

  pointerDown({ x, y, t, button }) {
    if (this.mode !== MODE_IDLE) return this.snapshot(); // 已有按键进行中则忽略新按键
    this.button = button;
    this.mode = MODE_PRESS;
    this.start = { x, y, t };
    this.last = { x, y, t };
    this.samples = [{ x, y, t }];
    this.tapLocked = false;
    this.holdProgress = 0;
    this.ringShown = false;
    return this.snapshot();
  }

  pointerMove({ x, y, t }) {
    if (this.mode === MODE_IDLE) return this.snapshot();
    // 采样（无论处于哪种按住模式）用于释放速度
    this.samples.push({ x, y, t });
    const MAX_SAMPLES = 10;
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    if (this.mode === MODE_PRESS || this.mode === MODE_RING) {
      const dist = Math.hypot(x - this.start.x, y - this.start.y);
      if (dist > this.cfg.dragTolerance) {
        // 超过容差 → 转拖动（取消 tap/长按）
        this.mode = MODE_DRAG;
      }
    }
    this.last = { x, y, t };
    return this.snapshot();
  }

  /**
   * 时间推进（长按进度 / 触发长按）。没有鼠标事件时也要每帧调它。
   */
  tick(t) {
    if (this.mode !== MODE_PRESS && this.mode !== MODE_RING) return this.snapshot();
    const holdMs = t - this.start.t;

    if (this.button === RIGHT) {
      // 右键长按只负责弹主菜单，阈值独立（menuPressMs=1.5s），不与左键锁定的 3s 冲突。
      if (holdMs >= this.cfg.menuPressMs && !this.tapLocked) {
        this.tapLocked = true;
        this.actions.push({ type: 'menu', t });
      }
      this.holdProgress = Math.min(1, holdMs / this.cfg.menuPressMs);
      return this.snapshot();
    }

    // 左键：先 ring 反馈（processActions 不消费 'ring'，进度环由渲染层据 snapshot 绘制）
    if (!this.ringShown && holdMs >= this.cfg.ringDelayMs) {
      this.ringShown = true;
      this.mode = MODE_RING;
      this.actions.push({ type: 'ring', t });
    }
    this.holdProgress = this.mode === MODE_RING
      ? Math.min(1, Math.max(0, (holdMs - this.cfg.ringDelayMs) / Math.max(1, this.cfg.longPressMs - this.cfg.ringDelayMs)))
      : 0;

    if (holdMs >= this.cfg.longPressMs && !this.tapLocked) {
      this.tapLocked = true;
      this.holdProgress = 1;
      this.actions.push({ type: 'longpress-toggle', t });
    }
    return this.snapshot();
  }

  pointerUp({ t }) {
    if (this.mode === MODE_IDLE) return this.snapshot();
    const wasDrag = this.mode === MODE_DRAG;
    const holdMs = t - this.start.t;
    const produced = [];

    // 左键拖动结束：给出 release 动作（含甩动速度）
    if (wasDrag && this.button === LEFT) {
      const v = this._releaseVelocity();
      produced.push({
        type: 'release', t,
        vx: v.vx, vy: v.vy, speed: Math.hypot(v.vx, v.vy),
        moved: true,
        start: this.start, last: this.last,
        duration: holdMs,
      });
    } else if (!this.tapLocked && this.button === LEFT && this.mode === MODE_PRESS && !wasDrag) {
      // 短点 = 摸头
      if (holdMs <= this.cfg.tapMaxMs) {
        produced.push({ type: 'tap', t, x: this.start.x, y: this.start.y });
      }
      // 按住过久但没触发长按就松开 → 忽略（什么都不做）
    }
    // 右键单击：无动作（右键仅长按有意义）
    this.reset();
    this.actions.push(...produced);
    return this.snapshot();
  }

  /** 计算释放时的速度（最后 ~100ms 的平均速度，单位 px/s）。 */
  _releaseVelocity() {
    const s = this.samples;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const cutoffT = this.last.t - 100;
    let i = s.length - 1;
    while (i > 0 && s[i].t >= cutoffT) i--;
    const a = s[i], b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  snapshot() {
    return {
      mode: this.mode,
      button: this.button,
      holdProgress: this.holdProgress,
      ringShown: this.ringShown,
      start: this.start,
      last: this.last,
      dragging: this.mode === MODE_DRAG,
    };
  }

  get isIdle() { return this.mode === MODE_IDLE; }
  get isInteracting() { return this.mode !== MODE_IDLE; }
}

/**
 * 便捷：重放一段合成事件序列（可选最后加 tick 到 T），返回产生的全部动作。
 * events: Array<{type,x?,y?,t,button?}>
 */
function simulate(events, { untilT, opts } = {}) {
  const tr = new GestureTracker(opts);
  const out = [];
  for (const e of events) {
    if (e.type === 'down') tr.pointerDown(e);
    else if (e.type === 'move') tr.pointerMove(e);
    else if (e.type === 'up') tr.pointerUp(e);
    else if (e.type === 'tick') tr.tick(e.t);
  }
  if (untilT !== undefined) tr.tick(untilT);
  out.push(...tr.drainActions());
  return out;
}

/* ================= 果冻动画（q 弹弹簧） ================= */

/** 无参数版本（直接用 config 的 q 弹弹簧）——供 renderer 复用同一套常数。 */
function springParams() {
  const f = CFG.anim.squishFrequency; // “回弹频率感”(Hz，越大越抖)
  const w0 = 2 * Math.PI * f;
  const damp = CFG.anim.squishDamping; // 阻尼比 ζ（<1 欠阻尼=有Q弹过冲）
  return { w0, damp };
}

/**
 * 弹簧积分一步（阻尼隐式 + 半隐式欧拉，数值稳定）。
 * @returns {{s:number,v:number}}
 */
function integrateSpring({ s, v }, dt, { w0, damp }) {
  const k = w0 * w0;
  const c = 2 * damp * w0;           // 阻尼系数
  const vn = (v + k * (1 - s) * dt) / (1 + c * dt); // 阻尼向后差分，稳定
  let ns = s + vn * dt;
  let nv = vn;
  if (!Number.isFinite(ns) || !Number.isFinite(nv)) {
    ns = 1; nv = 0; // 数值发散保护
  }
  return { s: ns, v: nv };
}

/** 冲量：给弹簧注入初速度（正值=放大即拉伸、负值=压缩）。 */
function impulse(st, amount) {
  return { s: st.s, v: st.v + amount };
}

/* ================= 物理（抛掷 / 坠落） =================
 * 坐标系：活动区域内部坐标，区域左上角为 (0,0)，宽 world.w、高 world.h。
 * 宠物用其“左上角”表示位置，尺寸 w×h。
 * 状态形如 { x, y, vx, vy, grounded, w, h, col }（单位 px / px·s⁻¹）。
 * col = 像素级碰撞盒 { ox, oy, w, h }（不透明像素包围盒，相对 pos 的偏移/尺寸）：
 * 边界钳制/落地/贴墙/贴顶全部以碰撞盒为准，透明边距允许悬出边界（落地不再“悬空”、
 * 贴墙不再被透明边距顶住）。col 缺失时回退整图包围盒 {0,0,w,h}（兼容旧调用方）。
 */

/** 规范化碰撞盒：非法/缺失回退整图。 */
function normCol(s) {
  const c = s.col;
  if (c && Number.isFinite(c.ox) && Number.isFinite(c.oy) &&
      Number.isFinite(c.w) && Number.isFinite(c.h) && c.w > 0 && c.h > 0) {
    return { ox: c.ox, oy: c.oy, w: c.w, h: c.h };
  }
  return { ox: 0, oy: 0, w: s.w, h: s.h };
}

/**
 * 前进一步。
 * @param {object} s 物理状态
 * @param {number} dt 秒
 * @param {{w,h}} world 活动区域逻辑大小
 * @param {object} [opts] 覆盖物理参数（测试注入）
 * @returns {{s:object, landed:boolean, hitWall:boolean, hitCeiling:boolean}}
 */
function step(s, dt, world, opts = {}) {
  const P = { ...CFG.physics, ...opts };
  const col = normCol(s);
  const o = {
    x: s.x, y: s.y, vx: s.vx || 0, vy: s.vy || 0,
    grounded: !!s.grounded,
    w: s.w, h: s.h,   // 必须带出尺寸，否则下一步 maxX/maxY = NaN，所有边界钳制失效
    col: { ...col },  // 碰撞盒同样跨步自带（返回值自包含红线）
  };
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

  // ---- 边界（全部以碰撞盒为准）----
  const minX = -col.ox;
  const maxX = world.w - col.w - col.ox;
  if (nx > maxX) {
    if (o.vx > 0) { o.vx = -o.vx * P.restitution; hitWall = true; }
    nx = maxX;
  } else if (nx < minX) {
    if (o.vx < 0) { o.vx = -o.vx * P.restitution; hitWall = true; }
    nx = minX;
  }

  // ---- 天花板 ----
  const minY = -col.oy;
  const maxY = world.h - col.h - col.oy;
  if (ny < minY) {
    if (o.vy < 0) { o.vy = -o.vy * P.restitution; hitCeiling = true; }
    ny = minY;
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

  // 防御性保证宠物不越界（透明边距允许悬出，见 minX/minY）。
  o.x = clamp(nx, minX, maxX);
  o.y = clamp(ny, minY, maxY);

  const landed = floorTouched && !s.grounded; // 首次触地事件（用于落地压扁反馈）
  return { s: o, landed, hitWall, hitCeiling };
}

/** 便捷：是否已达到“贴地静止”可回待机的状态。 */
function atRest(s, opts = {}) {
  const P = { ...CFG.physics, ...opts };
  return !!s.grounded && Math.abs(s.vx) <= P.stopSpeedX && Math.abs(s.vy) <= P.stopSpeedY;
}

/* ================= 窗口吸附 =================
 * 窗口几何使用屏幕坐标（与主进程枚举结果一致）：{ handle,left,top,right,bottom,title }。
 */

/**
 * 在所有候选窗口里选一个吸附目标。
 * 锚点水平位于窗口范围内（允许一点余量）且垂直贴近顶沿 → 候选；垂直最贴者优先。
 * @param {{x,y}} anchor 锚点（屏幕坐标）
 * @param {Array} wins 候选窗口（已过滤掉自身/桌面/极小窗口）
 * @returns {object|null}
 */
function chooseSnapTarget(anchor, wins, opts = {}) {
  const P = { ...CFG.physics, ...opts };
  let best = null;
  let bestScore = Infinity;
  for (const w of wins) {
    const { left, top, right } = w;
    if (anchor.x < left - P.snapMarginX || anchor.x > right + P.snapMarginX) continue;
    const dy = Math.abs(anchor.y - top);
    if (dy <= P.snapProximityY) {
      const score = dy;
      if (score < bestScore) {
        bestScore = score;
        best = w;
      }
    }
  }
  return best;
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

module.exports = {
  GestureTracker,
  simulate,
  LEFT, RIGHT,
  MODE_IDLE, MODE_PRESS, MODE_RING, MODE_DRAG,
  springParams,
  integrateSpring,
  impulse,
  step,
  atRest,
  normCol,
  chooseSnapTarget,
  shouldDetach,
};
