'use strict';
/**
 * 手势判定（纯逻辑，不依赖 DOM）。红线的根基：
 *  - 手势判定的阈值全部来自 CFG，测试用“合成鼠标事件序列 → 期望动作”。
 *  - 长按 3s = 锁定切换；右键长按 1.5s = 主菜单；短点 = 摸头；拖动 = 1:1 跟随；
 *    快速甩动释放 = 抛出（由渲染层依据 release 的 vx/vy 启动物理）。
 *
 * 所有方法都不触碰 DOM / 时间源；时间与坐标由调用者喂入，便于测试。
 *
 * 事件形状：{ type:'down'|'move'|'up', x, y, t, button }  button: 0=左 2=右
 * action 语义：
 *   'tap'                  -> 左键短点（摸头）
 *   'longpress-toggle'     -> 左键长按达标（锁定切换），附带 progress 到达 1
 *   'menu'                 -> 右键长按达标（打开主菜单）
 *   'release'              -> 拖动结束，带 { vx, vy, speed, moved }（是否甩动由渲染层/阈值判断）
 */
const { CFG } = require('./config');

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
    if (this.mode === MODE_DRAG) {
      // 拖动跟随目标：渲染层直接读 last；这里只记录
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

    // 左键：先 ring 反馈
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

module.exports = {
  GestureTracker,
  simulate,
  LEFT, RIGHT,
  MODE_IDLE, MODE_PRESS, MODE_RING, MODE_DRAG,
};
