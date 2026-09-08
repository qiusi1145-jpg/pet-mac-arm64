'use strict';
/**
 * 渲染层控制器（Phase 2：手势判定 + 全部动画）。
 *
 * 像素级点击穿透核心（红线段 1）：
 *  - 主进程每 ~16ms 推送真实光标位置 -> cursor。
 *  - 每帧判断“光标下是否是可交互点”（宠物实体像素 / 打开的 UI 矩形）。
 *  - 是 -> 请求关闭忽略（win 接收鼠标）；否 -> 开启忽略（点击穿透）。
 *  - 锁定态下无论如何穿透；托盘是解锁保底。
 *
 * 动画/物理与“判定区域”完全解耦：判定只用 pet.bitmap 原始像素；
 * 表现层用 CSS transform（缩放果冻/呼吸），动画变形不改变任何判定。
 */
const { ipcRenderer } = require('electron');
const nodePath = require('path');
const { CFG } = require('../shared/config');
const { analyzeBitmap, hitTestPixel, scalePlan } = require('../shared/pixel');
const { GestureTracker } = require('../shared/gesture');
const { springParams, integrateSpring, impulse, breathe } = require('../shared/spring');
const physics = require('../shared/physics');
const { chooseSnapTarget, shouldDetach } = require('../shared/snap');
const { planBlink, shouldPlayBlinkAnim } = require('../shared/blink');
const { nextStateVisual } = require('../shared/stateVisual');
const statusM = require('../shared/status');
const { clamp } = require('../shared/util');

const $ = (id) => document.getElementById(id);
const worldEl = $('world'), petWrap = $('petWrap'), petCanvas = $('pet');
const fxEl = $('fx'), ringWrap = $('ringWrap'), ringArc = $('ringArc');
const pillEl = $('pill');
const bubbleEl = $('bubble');
const blinkEl = $('blink');
const bgEl = $('bg'), regionPanel = $('panel'), panelDims = $('panelDims');
const hintEl = $('hint');
const petPickerEl = $('petPicker');
const pkTitle = $('pkTitle'), pkHint = $('pkHint'), pkFolders = $('pkFolders'),
  pkPathInput = $('pkPathInput'), pkList = $('pkList'), pkPreview = $('pkPreview'),
  pkPrevMsg = $('pkPrevMsg'), pkErr = $('pkErr'), pkUse = $('pkUse');

// 渲染层错误计数（冒烟/UI 测试断言控制台无报错）
window.__petErrors = 0;
const origErr = console.error;
console.error = (...a) => { window.__petErrors++; origErr.apply(console, a); };

const RING_CIRC = 2 * Math.PI * 30;

const app = {
  testMode: false,
  ready: false,
  locked: false,
  visible: true,
  paused: false,

  worldOrigin: { x: 0, y: 0 },
  worldW: 1,
  worldH: 1,

  cursor: { x: 0, y: 0 },
  cursorKnown: false,
  ignoreSent: null,
  buttonDown: false,

  pet: null,           // {canvas,ctx,bitmap,w,h,anchor,pos}
  uiRects: [],         // 可交互 UI 矩形（状态胶囊、面板），参与 isInteractableAt 判定
  forceInteractive: false, // 弹层/菜单打开时强制整窗可交互（瞬态）

  // ---- 动画 ----
  anim: {
    spr: { x: { s: 1, v: 0 }, y: { s: 1, v: 0 } }, // q 弹弹簧
    ringVisible: false,
  },

  // ---- 手势 ----
  gtr: new GestureTracker(),
  pressWasPet: false,
  grabOffset: null,
  dragging: false,

  // ---- 物理 ----
  phys: null,          // {s, landedTick}

  // ---- 吸附（Phase 3）----
  snap: null,             // 当前吸附窗口的屏幕几何 {handle,left,top,right,bottom,minimized}
  snapEnabled: true,      // 是否允许吸附新窗口（托盘可关）
  snapPollTimer: 0,       // 吸附后的脱落轮询定时器
  snapPollBusy: false,
  _snapWinOverride: null, // UI 测试注入的窗口列表（默认走 IPC 枚举）

  // ---- 物理模拟总开关（托盘可关）----
  physicsEnabled: true,
  // “休息”闪烁状态：{active,start,dur,period,min,max,opacity}；null=未在休息。
  rest: null,

  // ---- Phase 4：状态 / 背景 / BGM ----
  status: null,           // 状态快照（status.js 的原始结构）
  statusTimer: 0,         // 每秒结算定时器
  _lastStatusPersist: 0,
  affinityRng: null,      // 好感度随机源（测试可注入）；null=Math.random
  workArea: null,         // 主屏工作区（区域还原用）
  bgPath: null,
  bgOpacity: CFG.ui.bgDefaultOpacity,
  bgNat: null,   // 背景图自然尺寸 {w,h}（图片加载后才有）
  bgCX: null,    // 背景图底边中点的 x（内容坐标，人物空中时保持不动）
  audio: {                // BGM
    el: null, playlist: [], index: -1, playing: false, volume: CFG.audio.volumeDefault,
  },
  regionPanelOpen: false,
  // 应用内选择器（选背景/选音乐，绕开这台机器上失灵的原生文件对话框）
  petPickerOpen: false,
  bubbleTimer: null,
  blink: { visible: false, timer: null, endTimer: null },
  stateVisual: { visible: false },  // 当前形态：false=主形象，true=状态形象
  mainBody: null,      // 主形象"身体"：解码位图/锚点/尺寸（当前 app.pet 指向活动身体）
  stateBody: null,     // 状态形象"身体"（预载 src/assets/state.png 或配置覆盖；null = 切换不可用）
  // ---- 可定制值（来自 app:init 的 dev 块；无开发者模式时 = config.js 默认值） ----
  greetings: null,                            // 启动问候语列表（覆盖后）
  blinkAnim: { frames: [], probability: 1 },  // 多帧眨眼动画；frames 空 = 降级旧 blink.png
  stateImagePath: null,                       // 状态图覆盖（dataUrl）；null = 内置 src/assets/state.png
  petPickerKind: 'bg',    // 'bg' | 'audio'（换宠已移除）
  petPickerDir: null,
  petPickerCur: null,     // 当前选中的源文件路径
  pkBusy: false,

  raf: 0,
  lastT: 0,
  // 阶段内事件总线（Phase 4 状态层订阅“任意互动”）
  bus: new Set(),
};

/* ================= 几何/判定 ================= */

const nowMs = () => performance.now();
function contentOf(e) { return { x: e.clientX, y: e.clientY }; }
function cursorToContent(p) { return { x: p.x - app.worldOrigin.x, y: p.y - app.worldOrigin.y }; }

function petRect(p) { return { x: p.pos.x, y: p.pos.y, w: p.w, h: p.h }; }
function pointInRect(px, py, r) { return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h; }

function isInteractableAt(cx, cy) {
  for (const r of app.uiRects) if (pointInRect(cx, cy, r)) return true;
  if (!app.pet) return false;
  return isOverPetPixels(cx, cy);
}

function isOverPetPixels(cx, cy) {
  const p = app.pet;
  const dx = cx - p.pos.x, dy = cy - p.pos.y;
  if (dx < 0 || dy < 0 || dx >= p.w || dy >= p.h) return false;
  return hitTestPixel(p.bitmap, dx, dy, CFG.image.alphaThreshold);
}

function requestIgnore(interactive) {
  // interactive=true -> 窗口接收鼠标（不穿透）；false -> 点击穿透。
  // 锁定态永远穿透（托盘是唯一解锁入口）。
  const want = app.locked ? true : interactive;
  if (app.ignoreSent === want) return;
  app.ignoreSent = want;
  ipcRenderer.send('win:setIgnore', want);
}

function updateUiRects() {
  // 状态胶囊（始终存在；折叠与否改变矩形）+ 区域编辑面板 / 图片选择器（打开时）
  const els = [pillEl];
  if (app.regionPanelOpen && regionPanel) els.push(regionPanel);
  if (app.petPickerOpen && petPickerEl) els.push(petPickerEl);
  app.uiRects.length = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) app.uiRects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
}

function syncHitTest() {
  if (app.paused || app.locked) { requestIgnore(true); return; }
  const forced = app.buttonDown || app.dragging || app.gtr.isInteracting || app.forceInteractive;
  if (forced) { requestIgnore(false); return; }
  const c = cursorToContent(app.cursor);
  requestIgnore(!isInteractableAt(c.x, c.y));
}

/* ================= 宠物加载 ================= */

/** 把已加载的 Image 解码成一具"身体"：等比缩放 → 位图分析（透明判定 + 实体像素中心锚点）。
 *  主形象与状态形象都走这条管线，各自的 bitmap 是该形态像素级判定的唯一来源。 */
function decodeImageObject(img, maxDim) {
  const { width, height } = scalePlan(img.naturalWidth, img.naturalHeight, maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const analysis = analyzeBitmap(imageData, CFG.image.alphaThreshold);
  if (!analysis.hasPixels) throw new Error('图片看起来是全透明的（没有可交互像素）');
  return { canvas, ctx, w: width, h: height, bitmap: imageData, anchor: analysis.anchor, pos: null };
}

async function decodeImageDataUrl(dataUrl, maxDim) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片解码失败')); img.src = dataUrl; });
  return decodeImageObject(img, maxDim);
}

async function decodeImageSrc(src, maxDim) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片解码失败')); img.src = src; });
  return decodeImageObject(img, maxDim);
}

function defaultPetPos(w, h) {
  return { x: Math.round((app.worldW - w) / 2), y: Math.round(app.worldH - h - 6) };
}

function clampPetIntoWorld(p) {
  p.pos.x = clamp(p.pos.x, 0, Math.max(0, app.worldW - p.w));
  p.pos.y = clamp(p.pos.y, 0, Math.max(0, app.worldH - p.h));
}

async function loadPet(dataUrl) {
  let p;
  try { p = await decodeImageDataUrl(dataUrl, CFG.image.petMaxDim); }
  catch (e) {
    console.error('[pet] 加载失败', e.message);
    hintEl.style.display = 'block';
    hintEl.textContent = e.message + ' —— 请检查素材文件后重启应用';
    return false;
  }
  const old = app.pet && app.pet.pos;
  p.pos = old || defaultPetPos(p.w, p.h);
  app.mainBody = p;
  app.pet = p;
  drawBody(p);
  clampPetIntoWorld(p);
  blinkEl.src = '../assets/blink.png'; // 旧版单图眨眼（无多帧配置时降级用）
  petCanvas.style.transform = '';
  hintEl.style.display = 'none';
  app.anim.spr = { x: { s: 1, v: 0 }, y: { s: 1, v: 0 } };
  // 载入主形象 = 回到主形态（换宠后吸附/抛掷状态复位）
  app.stateVisual.visible = false;
  app.phys = null;
  app.dragging = false;
  app.snap = null; ensureSnapPollStop();
  syncPlacement();
  return true;
}

/** 把"身体"画到显示画布上：画布尺寸 = 身体尺寸，缩放原点 = 该身体的锚点。 */
function drawBody(body) {
  petCanvas.width = body.w;
  petCanvas.height = body.h;
  const ctx = petCanvas.getContext('2d');
  ctx.drawImage(body.canvas, 0, 0);
  petWrap.style.width = body.w + 'px';
  petWrap.style.height = body.h + 'px';
  petCanvas.style.transformOrigin = `${body.anchor.x}px ${body.anchor.y}px`;
}

/**
 * 预载状态形象（第二具身体）：内置 src/assets/state.png 或配置覆盖路径（dataUrl 解码）。
 * 失败 → 状态切换不可用（保持主形态）；只在控制台 warn（不进错误计数）。
 */
async function loadStateBody() {
  try {
    const body = app.stateImagePath
      ? await (async () => {
          const img = await ipcRenderer.invoke('asset:readImage', app.stateImagePath);
          if (!img) throw new Error('状态图读取失败');
          return decodeImageDataUrl(img.dataUrl, CFG.image.petMaxDim);
        })()
      : await decodeImageSrc('../assets/state.png', CFG.image.petMaxDim);
    app.stateBody = body;
    if (app.stateVisual.visible) setStateVisible(true); // 运行中重载（dev:update）：按当前形态换上新身体
  } catch (e) {
    app.stateBody = null;
    if (app.stateVisual.visible && app.mainBody) { // 正显示状态形象但新身体不可用 → 退回主形态
      app.stateVisual.visible = false;
      app.pet = app.mainBody;
      drawBody(app.pet);
      syncPlacement();
    }
    console.warn('[pet] 状态形象加载失败（切换状态将不可用）', e && e.message ? e.message : e);
  }
}

function syncPlacement() {
  const p = app.pet;
  if (p) petWrap.style.transform = `translate3d(${p.pos.x}px, ${p.pos.y}px, 0)`;
  layoutBg(); // 背景贴地 + 人物居中跟随 → 人物一移动背景即刷新
}

/* ================= 事件总线（Phase 4 状态层） ================= */

function emit(kind, data) { for (const fn of app.bus) { try { fn(kind, data); } catch (e) { console.error(e); } } }

/* ================= 动画（呼吸 / q 弹 / 爱心） ================= */

function setScale(sx, sy) {
  const c = petCanvas.style;
  c.transform = sx === 1 && sy === 1 ? '' : `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
}

/** 注入一次 q 弹（magnitude 压缩冲量大小，如 headpat 用 CFG 值）。 */
function pulse(mag) {
  const A = app.anim;
  A.spr.y = impulse(A.spr.y, -mag);
  A.spr.x = impulse(A.spr.x, mag * 0.35); // 压扁时轻微横向扩张
}

function pulseFeed() { pulse(CFG.anim.headpatImpulse * 1.15); emit('feed'); }
function pulseHeadpat() { pulse(CFG.anim.headpatImpulse); emit('headpat'); }
function pulseLand() { pulse(CFG.anim.headpatImpulse * CFG.anim.landImpulseMult); }

function spawnHeart(cx, cy, level = 1) {
  const h = document.createElement('div');
  h.className = 'heart';
  const size = CFG.ui.heartSizeBase + CFG.ui.heartSizePerLevel * (level - 1);
  h.style.cssText = `left:${cx}px;top:${cy}px;color:${CFG.ui.heartColor};font-size:${size}px;--dur:${CFG.anim.heartFloatMs}ms;--dx:${(Math.random() - 0.5) * 24}px;`;
  h.textContent = CFG.ui.heartGlyph;
  fxEl.appendChild(h);
  h.addEventListener('animationend', () => h.remove());
}

function showBubble(text, durationMs) {
  if (!bubbleEl || !app.pet) return;
  bubbleEl.textContent = String(text || '');
  bubbleEl.classList.add('show');
  const p = app.pet;
  bubbleEl.style.left = `${clamp(p.pos.x + p.anchor.x - bubbleEl.offsetWidth / 2, 6, Math.max(6, app.worldW - bubbleEl.offsetWidth - 6))}px`;
  bubbleEl.style.top = `${clamp(p.pos.y - bubbleEl.offsetHeight - 8, 6, Math.max(6, app.worldH - bubbleEl.offsetHeight - 6))}px`;
  updateUiRects(); // 气泡参与命中判定：指针在其上窗口可交互（可点击关闭）
  if (app.bubbleTimer) clearTimeout(app.bubbleTimer);
  app.bubbleTimer = setTimeout(hideBubble, Math.max(0, durationMs ?? CFG.greeting.durationMs));
}

function hideBubble() {
  if (!bubbleEl) return;
  if (!bubbleEl.classList.contains('show')) return;
  bubbleEl.classList.remove('show');
  if (app.bubbleTimer) { clearTimeout(app.bubbleTimer); app.bubbleTimer = null; }
  updateUiRects();
}

function setBlinkVisible(v) {
  // 眨眼图属于“主宠物形象”：状态图形态下不显示眨眼
  if (v && app.stateVisual.visible) v = false;
  app.blink.visible = !!v;
  if (blinkEl) blinkEl.style.display = app.blink.visible ? 'block' : 'none';
}

/**
 * 切换形态 = 换一具身体：主形象与状态形象都是完整解码的"身体"（各自位图/锚点/尺寸），
 * app.pet 指向当前身体 → 像素判定/拖动/抛掷/吸附/呼吸/背景跟随/气泡爱心定位等全部作用于它。
 * 切换保持"底边中点"位置连续（原地换装；吸附中切换仍挂原窗口顶沿）。
 * 状态形象未成功加载（stateBody=null）时切换请求无效，维持主形态并回报同步。
 */
function setStateVisible(v) {
  const want = !!v;
  if (want && (!app.stateBody || !app.mainBody)) { ipcRenderer.send('state:visualSync', { useState: false }); return; }
  if (app.stateVisual.visible === want) { ipcRenderer.send('state:visualSync', { useState: app.stateVisual.visible }); return; }
  const old = app.pet;
  const next = want ? app.stateBody : app.mainBody;
  if (old && next && old.pos) {
    // 底边中点连续：换身体前后"站在原地"
    const bottom = old.pos.y + old.h;
    const cx = old.pos.x + old.w / 2;
    next.pos = { x: Math.round(cx - next.w / 2), y: Math.round(bottom - next.h) };
  }
  app.pet = next;
  app.stateVisual.visible = want;
  drawBody(next);
  clampPetIntoWorld(next);
  petCanvas.style.transform = ''; // 清掉旧身体的缩放形变（弹簧下一帧按新身体重算）
  if (want) setBlinkVisible(false); // 闭眼图属于主形象：状态形态不眨眼
  syncPlacement();
  // 回报主进程当前形态（菜单单选项勾选态依据）
  ipcRenderer.send('state:visualSync', { useState: app.stateVisual.visible });
}

function toggleStateVisual() {
  setStateVisible(nextStateVisual(app.stateVisual.visible));
  return app.stateVisual.visible;
}

function scheduleBlink() {
  if (!app.pet) return;
  const plan = planBlink();
  app.blink.timer = setTimeout(() => {
    // 状态图形态下不眨眼（闭眼图属于主宠物形象），只推进下一次计划
    if (app.stateVisual.visible) { scheduleBlink(); return; }
    // 多帧动画模式：按整体触发概率掷骰，命中则依次播放帧序列；未命中保持常态。
    if (app.blinkAnim.frames.length) {
      if (shouldPlayBlinkAnim(app.blinkAnim.probability)) playBlinkAnimSequence();
      else scheduleBlink();
      return;
    }
    // 降级：原有单图眨眼（blink.png），时长走随机区间
    setBlinkVisible(true);
    app.blink.endTimer = setTimeout(() => {
      setBlinkVisible(false);
      app.blink.endTimer = null;
      scheduleBlink();
    }, plan.durationMs);
  }, plan.intervalMs);
}

/**
 * 依次播放眨眼动画帧（每帧显示各自的 durationMs，播完恢复常态）。
 * 每帧开始前重新检查：宠物还在/不在状态图形态/帧列表仍存在 —— 异常即终止并恢复计划。
 * 动画只动叠加图层（#blink），不影响任何交互判定。
 */
function playBlinkAnimSequence() {
  let i = 0;
  const step = () => {
    const frames = app.blinkAnim.frames;
    if (!app.pet || app.stateVisual.visible || i >= frames.length) {
      setBlinkVisible(false);
      app.blink.endTimer = null;
      scheduleBlink();
      return;
    }
    blinkEl.src = frames[i].src;
    setBlinkVisible(true);
    const dur = frames[i].durationMs;
    i += 1;
    app.blink.endTimer = setTimeout(step, dur);
  };
  step();
}

function updateRing(dt) {
  const g = app.gtr.snapshot();
  const show = !app.locked && (g.mode === 'ring' || (g.mode === 'press' && g.button === 0 && g.holdProgress > 0));
  if (show) {
    const p = app.pet;
    const cx = p.pos.x + p.anchor.x;
    const cy = p.pos.y + p.anchor.y - p.h * 0.3;
    ringWrap.style.left = cx + 'px';
    ringWrap.style.top = cy + 'px';
    ringWrap.style.display = 'block';
    const prog = clamp(g.holdProgress, 0, 1);
    ringArc.style.strokeDashoffset = String(RING_CIRC * (1 - prog));
  } else if (app.anim.ringVisible || ringWrap.style.display === 'block') {
    ringWrap.style.display = 'none';
  }
  app.anim.ringVisible = show;
}

function tickAnimations(dt, ms) {
  if (!app.pet) return;
  const A = app.anim;
  const P = springParams();
  A.spr.x = integrateSpring(A.spr.x, dt, P);
  A.spr.y = integrateSpring(A.spr.y, dt, P);
  // 拖动/飞行中不做待机呼吸
  const idle = !app.phys && !app.dragging;
  const br = idle ? breathe(ms) : { x: 1, y: 1 };
  const sx = A.spr.x.s * br.x;
  const sy = A.spr.y.s * br.y;
  setScale(sx, sy);
  A.drawnScale = { x: sx, y: sy };
  updateRing(dt);
}

/* ================= 物理（抛掷/坠落；吸附 Phase 3 接入） ================= */

function physState() {
  return { x: app.pet.pos.x, y: app.pet.pos.y, vx: 0, vy: 0, grounded: false, w: app.pet.w, h: app.pet.h };
}

function startPhys(vel) {
  const s = physState();
  s.vx = vel.vx; s.vy = vel.vy;
  app.phys = { s, prev: { grounded: false }, bounceCount: 0 };
}

function stopPhys() { app.phys = null; }

function tickPhysics(dt) {
  if (!app.pet || !app.phys) return;
  const w = { w: app.worldW, h: app.worldH };
  const res = physics.step(app.phys.s, dt, w);
  app.pet.pos.x = res.s.x;
  app.pet.pos.y = res.s.y;
  app.phys.s = res.s;
  // 落地/撞边触发的 Q 弹
  if (res.landed && res.s.grounded) {
    const impact = app.phys.prevVy > 0 ? app.phys.prevVy : 0;
    if (impact > 300) pulseLand();
    else pulse(Math.min(2, CFG.anim.headpatImpulse * 0.4));
  }
  if (res.hitWall || res.hitCeiling) pulse(1.2);
  app.phys.prevVy = res.s.vy;
  // 已静止 & 在地面 -> 结束物理，回待机
  if (physics.atRest(res.s) && res.s.y >= app.worldH - app.pet.h - 0.5) stopPhys();
}

/** 释放后的路由：甩动 -> 抛掷；低速 -> 尝试吸附到窗口顶沿，否则从当前位置坠落。 */
function routeRelease(rel) {
  emit('drag'); // 拖动结束仍计一次主动互动（保留原行为）
  if (app.locked || !app.pet) return;
  const thrown = rel.speed >= CFG.physics.throwSpeedThreshold;
  // 宠物本就在地面休息 -> 不重新启动物理（避免原地小跳）
  const onFloor = app.pet.pos.y >= app.worldH - app.pet.h - 1;
  if (onFloor && !thrown) return;

  if (!app.physicsEnabled) {
    // 物理完全禁用：甩出也原地停；低速释放只在贴近窗口顶沿时才吸附，否则悬在原位不下坠。
    if (thrown) return;
    void (async () => {
      if (app.snapEnabled && await attemptSnap()) return;
      // 吸附不上 → 停在松手位置（无重力）
    })();
    return;
  }

  if (thrown) { startPhys({ vx: rel.vx, vy: rel.vy }); return; }
  // 低速释放：先试着吸附到窗口顶沿；吸附失败则轻轻滑落/下坠
  void (async () => {
    if (app.snapEnabled && await attemptSnap()) return;
    if (!app.pet) return;
    startPhys({ vx: rel.vx * 0.25, vy: 0 });
  })();
}

/* ================= 吸附（窗口顶沿） ================= */

/** 锚点（实体像素中心近似）的屏幕坐标。 */
function snapAnchorScreen() {
  const p = app.pet;
  return {
    x: p.pos.x + p.anchor.x + app.worldOrigin.x,
    y: p.pos.y + p.anchor.y + app.worldOrigin.y,
  };
}

async function fetchWindows() {
  if (app._snapWinOverride !== null) return app._snapWinOverride;
  try { return await ipcRenderer.invoke('enumerate:windows'); }
  catch { return []; }
}

/** 找候选窗口并吸附；成功返回 true。 */
async function attemptSnap() {
  if (!app.pet || app.locked) return false;
  const target = chooseSnapTarget(snapAnchorScreen(), await fetchWindows());
  if (!target) return false;
  // 吸附前若用户已开始新的拖动/手势，则放弃本次吸附（枚举是异步的）
  if (app.buttonDown || app.gtr.isInteracting || app.dragging) return false;
  applySnap(target);
  return true;
}

function applySnap(target) {
  const p = app.pet;
  app.phys = null;
  // 底边贴窗口顶：contentY = (screenTop - originY) - petH，夹回区域顶。
  const contentTop = Math.max(0, target.top - app.worldOrigin.y);
  p.pos.y = contentTop - p.h;
  p.pos.x = clamp(p.pos.x, 0, Math.max(0, app.worldW - p.w));
  app.snap = {
    handle: target.id, left: target.left, top: target.top,
    right: target.right, bottom: target.bottom, minimized: !!target.minimized,
  };
  syncPlacement();
  ensureSnapPoll();
}

function ensureSnapPoll() {
  if (app.snapPollTimer || app.paused) return;
  app.snapPollTimer = setInterval(() => { void snapPollTick(); }, CFG.snapPoll.followPollMs);
}

function ensureSnapPollStop() {
  if (app.snapPollTimer) { clearInterval(app.snapPollTimer); app.snapPollTimer = 0; }
}

/** 用户抓取已吸附的宠物：解除吸附但不触发坠落（宠物被拎在手里）。 */
function grabFromSnap() {
  if (!app.snap) return;
  app.snap = null;
  ensureSnapPollStop();
}

/** 吸附中轮询：窗口被移动/最小化/关闭 → 失去支撑坠落。 */
async function snapPollTick() {
  if (!app.snap || app.snapPollBusy || app.paused || !app.pet) return;
  app.snapPollBusy = true;
  try {
    const wins = await fetchWindows();
    const now = wins.find((w) => String(w.id) === String(app.snap.handle)) || null;
    if (!now || shouldDetach(app.snap, now)) {
      detachFall();
    }
  } finally { app.snapPollBusy = false; }
}

/** 失去支撑：解除吸附并从当前位置开始自由坠落。
 *  物理开关关闭时不坠落 —— 解除吸附，人物就停在原地。 */
function detachFall() {
  const reason = 'unsnap';
  const snap = app.snap;
  app.snap = null;
  ensureSnapPollStop();
  if (snap && app.pet && app.physicsEnabled) {
    startPhys({ vx: 0, vy: 0 }); // 仅重力下坠（不来自抛掷）
  }
}

/* ================= 手势驱动 ================= */

function beginPress(e) {
  const c = contentOf(e);
  app.pressWasPet = isOverPetPixels(c.x, c.y);
  app.grabOffset = app.pressWasPet && app.pet ? { x: c.x - app.pet.pos.x, y: c.y - app.pet.pos.y } : null;
  if (app.pressWasPet) {
    app.gtr.pointerDown({ x: c.x, y: c.y, t: nowMs(), button: e.button });
  }
}

function onMouseMove(e) {
  const c = contentOf(e);
  const g = app.gtr.snapshot();
  if (!g.mode || g.mode === 'idle') return;
  app.gtr.pointerMove({ x: c.x, y: c.y, t: nowMs() });
  if (app.gtr.snapshot().dragging) {
    if (!app.dragging) {
      app.dragging = true;
      app.phys = null; grabFromSnap(); // 抓取瞬间终止飞行并解除吸附（拎在手里）
    }
    followDrag(c);
  }
}

function followDrag(c) {
  if (!app.grabOffset || !app.pet) return;
  const p = app.pet;
  p.pos.x = c.x - app.grabOffset.x;
  p.pos.y = c.y - app.grabOffset.y;
  clampPetIntoWorld(p);
  syncPlacement();
}

function onMouseUp(e) {
  app.buttonDown = false;
  if (app.gtr.isInteracting) app.gtr.pointerUp({ t: nowMs() });
  if (app.dragging) { app.dragging = false; }
  syncHitTest();
}

function processActions(acts) {
  for (const a of acts) {
    if (a.type === 'tap') pulseHeadpat();
    else if (a.type === 'longpress-toggle') { pulseHeadpat(); toggleLock(); }
    else if (a.type === 'menu') requestMainMenu();
    else if (a.type === 'release') routeRelease(a);
  }
}

function toggleLock() {
  const next = !app.locked;
  app.locked = next;
  app.gtr.reset();
  app.dragging = false;
  app.ignoreSent = null;
  syncHitTest();
  ipcRenderer.send('ui:lock', next);
}

/* ================= 事件绑定 ================= */

window.addEventListener('mousedown', (e) => {
  // 气泡（问候/提醒/催促）：点击任意位置提前关闭
  if (bubbleEl && bubbleEl.classList.contains('show')) hideBubble();
  app.buttonDown = true;
  if (!app.locked && (e.button === 0 || e.button === 2) && !isOverUiRect(contentOf(e))) beginPress(e);
  syncHitTest();
});
window.addEventListener('mousemove', (e) => { if (app.buttonDown || app.gtr.isInteracting) onMouseMove(e); });
window.addEventListener('mouseup', (e) => onMouseUp(e));
window.addEventListener('mouseleave', () => { app.buttonDown = false; });
window.addEventListener('blur', () => { app.buttonDown = false; });
document.addEventListener('contextmenu', (e) => e.preventDefault());

function isOverUiRect(c) {
  for (const r of app.uiRects) if (pointInRect(c.x, c.y, r)) return true;
  return false;
}

/* ================= 主循环 ================= */

function frame(ts) {
  app.raf = requestAnimationFrame(frame);
  const dt = app.lastT ? Math.min(0.05, (ts - app.lastT) / 1000) : 0.016;
  app.lastT = ts;
  if (app.paused) { requestIgnore(true); return; }

  app.gtr.tick(nowMs());
  processActions(app.gtr.drainActions());
  tickPhysics(dt);
  tickAnimations(dt, ts);
  tickRest();            // “休息”透明度正弦闪烁（含结束判定）
  syncPlacement();
  syncHitTest();
}

/* ================= IPC ================= */

function applyRegion(regionScreen) {
  app.worldOrigin = { x: regionScreen.x, y: regionScreen.y };
  app.worldW = regionScreen.width;
  app.worldH = regionScreen.height;
  updateUiRects();
  if (app.pet) { clampPetIntoWorld(app.pet); syncPlacement(); }
  refreshRegionDims();
}

/**
 * 应用"可定制值"热更新（开发者模式保存后由主进程推送 dev:update；无开发者模式时无发送方）。
 * 覆盖字段结构同 app:init 的 dev 块；pet 路径变化需重启（loadPet 在启动时解析）。
 */
async function applyDevUpdate(patch) {
  if (!patch || typeof patch !== 'object') return;
  try {
    if (Array.isArray(patch.greetings) && patch.greetings.length) app.greetings = patch.greetings;
    if (patch.blinkAnim && typeof patch.blinkAnim === 'object') {
      const frames = [];
      for (const f of patch.blinkAnim.frames || []) {
        if (!f || !f.path) continue;
        const img = await ipcRenderer.invoke('asset:readImage', f.path);
        if (img) frames.push({ src: img.dataUrl, durationMs: clamp(Number(f.durationMs) || 150, 30, 5000) });
      }
      app.blinkAnim.frames = frames;
      const prob = Number(patch.blinkAnim.probability);
      app.blinkAnim.probability = Number.isFinite(prob) ? clamp(prob, 0, 1) : 1;
      setBlinkVisible(false); // 播放中改配置：终止当前帧序列（step 下一拍会发现列表已换/为空）
    }
    if ('stateImagePath' in patch) {
      app.stateImagePath = patch.stateImagePath || null;
      void loadStateBody(); // 重新解码状态身体（dev:update 当前无发送方，保留兼容）
    }
  } catch (e) { console.error('[dev] 应用可定制值失败', e && e.message ? e.message : e); }
}

function bindIpc() {
  ipcRenderer.on('cursor:pos', (e, p) => { app.cursor = p; app.cursorKnown = true; });
  ipcRenderer.on('lock:change', (_e, { locked }) => { app.locked = locked; app.ignoreSent = null; syncHitTest(); });
  ipcRenderer.on('app:visibility', (_e, { visible }) => onVisibility(visible));
  ipcRenderer.on('region:changed', (_e, { regionScreen }) => applyRegion(regionScreen));
  ipcRenderer.on('ui:openRegionEditor', () => openRegionEditor());
  ipcRenderer.on('ui:openPicker', (_e, { kind }) => openPetPicker(kind));
  // 可定制值热更新（开发者模式保存后推送；平时无发送方）
  ipcRenderer.on('dev:update', (_e, patch) => { void applyDevUpdate(patch); });
  ipcRenderer.on('state:visual', (_e, { useState }) => setStateVisible(!!useState));
  // ---- 气泡类：启动问候之外的待办提醒 / 随机催促 / 聊天回复 ----
  ipcRenderer.on('bubble:todo', (_e, { text, ms }) => showBubble(text, ms));
  ipcRenderer.on('bubble:reminder', (_e, { text, ms }) => showBubble(text, ms));
  ipcRenderer.on('bubble:chat', (_e, { text, ms }) => showBubble(text, ms));
  // 原生右键菜单关闭后：清掉可能残留的按键/手势态（修复“菜单选完人物被吸到鼠标”）
  ipcRenderer.on('menu:closed', () => cleanupMenuGesture());
  // 吸附开关同步（托盘）
  ipcRenderer.on('snap:enabled', (_e, { enabled }) => { app.snapEnabled = !!enabled; });
  // 物理开关同步（托盘）：关闭瞬间若正在飞行/坠落 → 原地冻结（物理完全禁用）
  ipcRenderer.on('physics:enabled', (_e, { enabled }) => {
    app.physicsEnabled = !!enabled;
    if (!app.physicsEnabled && app.phys) stopPhys();
  });
  // ---- Phase 4：主菜单动作 / 背景 / BGM ----
  ipcRenderer.on('pet:action', (_e, a) => {
    if (!a) return;
    if (a.type === 'feed') pulseFeed();
    else if (a.type === 'headpat') pulseHeadpat(); // 聊天未命中关键词 → 模拟被点击（Q 弹 + 情绪变化）
    else if (a.type === 'resetStatus') resetStatus();
    else if (a.type === 'rest') startRest();
  });
  ipcRenderer.on('bg:set', (_e, { path }) => setBgPath(path));
  ipcRenderer.on('bg:opacity', (_e, { opacity }) => setBgOpacity(opacity));
  ipcRenderer.on('bg:clear', () => setBgPath(null)); // “清除背景”真正把当前显示的背景清掉
  ipcRenderer.on('audio:list', (_e, { playlist }) => setPlaylist(playlist));
  ipcRenderer.on('audio:toggle', () => audioToggle());
  ipcRenderer.on('audio:next', () => audioNext());
  ipcRenderer.on('audio:prev', () => audioPrev());
  ipcRenderer.on('audio:stop', () => audioStop());
  ipcRenderer.on('audio:vol', (_e, { volume }) => setVolume(volume));
}

function onVisibility(visible) {
  app.visible = visible;
  app.paused = !visible;
  if (visible) {
    startStatusTimers();
    if (app.status) { // 隐藏期间的离线结算
      app.status = statusM.settleStatus(app.status, Date.now());
      applyStatusVisual();
      refreshPill();
      persistStatus(true);
    }
  } else {
    stopStatusTimers();
    if (app.audio.playing && app.audio.el) app.audio.el.pause();
    requestIgnore(true);
  }
}

pillEl.addEventListener('click', () => {
  pillEl.classList.toggle('collapsed');
  ipcRenderer.send('settings:save', { pillCollapsed: pillEl.classList.contains('collapsed') });
  updateUiRects();
});

// 气泡本体点击关闭（窗口级 mousedown 已兜底“点任意位置关闭”）
bubbleEl.addEventListener('click', hideBubble);

/* ================= Phase 4：状态 / 背景 / BGM / 区域 ================= */

// ---------- 状态系统（每秒结算 + 离线结算 + 归零半透明 + 好感度） ----------

function normStatusSnap(raw, now) {
  if (!raw || typeof raw !== 'object') return statusM.createDefaultStatus(now);
  const d = statusM.createDefaultStatus(now);
  const n = { ...d, ...raw };
  for (const k of ['mood', 'energy', 'satiety', 'affinity']) n[k] = clamp(Number(n[k]) || 0, 0, 100);
  if (!Number.isFinite(n.lastTs)) n.lastTs = now;
  if (!Number.isFinite(n.lastActive)) n.lastActive = now;
  if (!Array.isArray(n.interactions)) n.interactions = [];
  return n;
}

/** 当前应显示的宠物透明度：
 *  - 休息中 → 用当前闪烁值（tickRest 每帧更新）；
 *  - 否则任一状态归零 → lowOpacity；正常 → '1'。
 * applyStatusVisual（每秒结算/互动/重置）统一走这里，避免每 1s 的状态刷新打断休息闪烁。 */
function petOpacityNow() {
  if (app.rest && app.rest.active) return String(app.rest.opacity);
  if (!app.status) return '1';
  const v = statusM.deriveStatus(app.status);
  return v.low ? String(CFG.status.lowOpacity) : '1';
}

function applyStatusVisual() {
  if (!app.pet || !app.status) return;
  // 透明度作用于整个宠物容器：主图/状态图两种形态统一生效
  petWrap.style.opacity = petOpacityNow();
  const v = statusM.deriveStatus(app.status);
  pillEl.classList.toggle('low', v.low);
}

// ---------- “休息”（右键菜单：透明度在 25%↔75% 间正弦渐变，durationMs 结束体力回满） ----------
// 规格（用户两次澄清）：透明度要“缓慢、平滑”地变化 → 用正弦（不是生硬线性往返）在
// opacityMin~opacityMax 间往返；30s 结束时体力回满、闪烁停止、透明度恢复正常。

/** 在 [0, period) 内返回 0..1..0 平滑往返值（正弦渐变）。 */
function restWave(op, elapsed) {
  const ph = (elapsed % op.period) / op.period; // 0..1
  const k = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2); // 0→1→0 平滑（正弦渐变）
  return op.min + (op.max - op.min) * k;
}

function beginRest(durMs, periodMs, minOp, maxOp) {
  app.rest = {
    active: true,
    start: Date.now(),
    dur: durMs,
    period: periodMs,
    min: minOp,
    max: maxOp,
    opacity: minOp, // 一进入休息从最淡开始渐变
  };
  if (app.pet) petWrap.style.opacity = String(minOp);
}

/** 菜单“休息”→ 用默认时长/周期/上下限开始休息。已在休息中则忽略（不叠加）。 */
function startRest() {
  if (app.rest && app.rest.active) return;
  beginRest(CFG.rest.durationMs, CFG.rest.blinkPeriodMs, CFG.rest.opacityMin, CFG.rest.opacityMax);
}

/** 每帧推进：透明度按正弦渐变；到达时长 → 结束并体力回满。 */
function tickRest() {
  const r = app.rest;
  if (!r || !r.active) return;
  const elapsed = Date.now() - r.start;
  if (elapsed >= r.dur) { finishRest(); return; }
  r.opacity = restWave(r, elapsed);
  if (app.pet) petWrap.style.opacity = String(r.opacity);
}

/** 休息结束：停止闪烁；体力回满；透明度恢复正常（状态驱动的值）。 */
function finishRest() {
  if (!app.rest) return;
  app.rest = null;
  if (app.status) {
    app.status = { ...app.status, energy: clamp(CFG.rest.energyRefill, 0, 100) };
    applyStatusVisual();
    refreshPill();
    persistStatus(true);
  }
}

const MOOD_ICON = '☺', ENERGY_ICON = '⚡', SATIETY_ICON = '🍖';

function refreshPill() {
  const txt = pillEl.querySelector('.txt');
  if (!app.status) { txt.textContent = ''; return; }
  const v = statusM.deriveStatus(app.status);
  const h = v.affinity > 0 ? `  ♥${v.affinity}` : '';
  txt.textContent = `${MOOD_ICON} ${v.mood}  ${ENERGY_ICON} ${v.energy}  ${SATIETY_ICON} ${v.satiety}${h}`;
  pillEl.title =
    `情绪 ${v.mood}  体力 ${v.energy}  饱食 ${v.satiety}  好感 ${v.affinity}` +
    (v.low ? '（某状态归零 → 宠物半透明）' : '');
  pillEl.classList.toggle('low', v.low);
}

/** 互动总线 → 状态：喂食用 feed()，其余主动互动（摸头/拖动结束）用 rapidInteract()
 * （= 互动 + 短时高频按比例扣少量体力），随后掷好感度。 */
function onStatusInteract(kind) {
  if (!app.status) return;
  const now = Date.now();
  let st = kind === 'feed'
    ? statusM.feed(app.status, now)
    : statusM.rapidInteract(app.status, now);
  const rng = app.affinityRng || Math.random;
  const roll = statusM.rollAffinity(st, rng);
  let levels = [];
  if (roll.rolled) {
    st = { ...st, affinity: roll.affinity };
    if (roll.level && roll.level.length) levels = roll.level;
  }
  app.status = st;
  if (levels.length && app.pet) {
    for (const lv of levels) {
      spawnHeart(
        app.pet.pos.x + app.pet.anchor.x,
        app.pet.pos.y + 6,
        Math.round(lv / CFG.status.affinityMilestoneStep)
      );
    }
  }
  applyStatusVisual();
  refreshPill();
  persistStatus(true);
}

function statusTick() {
  if (app.paused || !app.status) return;
  app.status = statusM.settleStatus(app.status, Date.now());
  applyStatusVisual();
  refreshPill();
  persistStatus(false);
}

function startStatusTimers() {
  if (app.statusTimer) return;
  app.statusTimer = setInterval(statusTick, 1000);
}
function stopStatusTimers() {
  if (app.statusTimer) { clearInterval(app.statusTimer); app.statusTimer = 0; }
}

function persistStatus(force) {
  const now = Date.now();
  if (!force && now - app._lastStatusPersist < CFG.status.persistIntervalMs) return;
  app._lastStatusPersist = now;
  const patch = { status: app.status };
  // 宠物未在拖动/飞行/吸附时顺带记住位置
  if (app.pet && !app.dragging && !app.phys && !app.snap) {
    patch.pos = { x: app.pet.pos.x, y: app.pet.pos.y };
  }
  ipcRenderer.send('settings:save', patch);
}

function resetStatus() {
  app.status = statusM.createDefaultStatus(Date.now());
  applyStatusVisual();
  refreshPill();
  persistStatus(true);
}

// ---------- 背景 ----------
// 背景显示规则（2026-09-05 需求修订）：
//   “背景贴地 + 跟人物居中” —— 背景图底边始终落在活动区域地面；人物站在地面上时，
//   背景水平跟随人物脚底中点（图片底边中点 = 人物脚底中点）；人物被抛起/拎高时，
//   背景水平与垂直都不动，落地后再对齐。图片高度自动 = 人物显示高 × bgPetHScale。

function layoutBg() {
  const p = app.pet;
  if (!app.bgOn || !app.bgNat || !(app.bgNat.w > 0) || !(app.bgNat.h > 0)) return;
  let petH = p ? p.h : CFG.image.petMaxDim; // 还没有宠物时按最大显示高预估
  let bgH = Math.max(1, Math.round(petH * CFG.ui.bgPetHScale));
  let bgW = Math.max(1, Math.round(bgH * (app.bgNat.w / app.bgNat.h)));
  // 超出活动区域时等比缩回（极宽/极高图不至于撑爆窗口）
  if (bgW > app.worldW) { bgW = app.worldW; bgH = Math.max(1, Math.round(bgW * app.bgNat.h / app.bgNat.w)); }
  if (bgH > app.worldH) { bgH = app.worldH; bgW = Math.max(1, Math.round(bgH * app.bgNat.w / app.bgNat.h)); }
  // 只有人物“站在地面”才更新背景的水平中心；空中保持上一次（人物落地后重新对齐）
  const grounded = p && p.pos.y >= app.worldH - p.h - 1.5;
  if (p && grounded) app.bgCX = p.pos.x + p.w / 2;
  else if (app.bgCX == null) app.bgCX = p ? p.pos.x + p.w / 2 : app.worldW / 2;
  const left = Math.round(app.bgCX - bgW / 2);
  const top = Math.max(0, app.worldH - bgH); // 底边贴地面
  bgEl.style.width = bgW + 'px';
  bgEl.style.height = bgH + 'px';
  bgEl.style.left = left + 'px';
  bgEl.style.top = top + 'px';
}

async function applyBg(path) {
  const img = await ipcRenderer.invoke('asset:readImage', path);
  if (!img) { clearBg(); return; }
  bgEl.onload = () => {
    app.bgNat = { w: bgEl.naturalWidth || 0, h: bgEl.naturalHeight || 0 };
    app.bgCX = null;
    layoutBg();
  };
  bgEl.src = img.dataUrl;
  bgEl.style.opacity = String(app.bgOpacity);
  app.bgOn = true;
  app.bgNat = null;   // 自然尺寸等 onload 再定（避免用旧图尺寸）
  app.bgCX = null;
}
function clearBg() {
  app.bgOn = false;
  app.bgNat = null;
  app.bgCX = null;
  bgEl.onload = null;
  bgEl.removeAttribute('src');
  bgEl.style.opacity = '0';
  bgEl.style.width = '0';
  bgEl.style.height = '0';
}
function setBgPath(path) {
  app.bgPath = path || null;
  if (app.bgPath) void applyBg(app.bgPath); else clearBg();
  ipcRenderer.send('settings:save', { background: { path: app.bgPath, opacity: app.bgOpacity } });
}
function setBgOpacity(o) {
  app.bgOpacity = clamp(o, CFG.ui.bgOpacityMin, CFG.ui.bgOpacityMax);
  if (app.bgOn) bgEl.style.opacity = String(app.bgOpacity);
  ipcRenderer.send('settings:save', { background: { path: app.bgPath, opacity: app.bgOpacity } });
}

// ---------- BGM（本地文件循环播放） ----------

function guessAudioMime(p) {
  const e = (p.split('.').pop() || '').toLowerCase();
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac' })[e] || 'audio/mpeg';
}
function ensureAudio() {
  if (app.audio.el) return app.audio.el;
  const el = new Audio();
  el.volume = app.audio.volume;
  el.addEventListener('ended', () => audioNext());
  el.addEventListener('error', () => {
    // 解码失败/文件损坏 → 跳过下一首；限频避免整表损坏时死循环
    const now = Date.now();
    if (now - (app.audio.lastErrAt || 0) < 800) return;
    app.audio.lastErrAt = now;
    audioNext();
  });
  app.audio.el = el;
  return el;
}
async function playIndex(i) {
  const list = app.audio.playlist;
  if (!list.length) return;
  if (i < 0) i = list.length - 1;
  if (i >= list.length) i = 0;
  app.audio.index = i;
  const el = ensureAudio();
  const r = await ipcRenderer.invoke('asset:readAudio', list[i].path);
  if (!r || !r.bytes) { app.audio.index = -1; return; }
  try {
    const url = URL.createObjectURL(new Blob([new Uint8Array(r.bytes)], { type: guessAudioMime(list[i].path) }));
    el.src = url;
    app.audio.playing = true;
    void el.play();
  } catch (e) { console.error('[audio] 播放失败', e.message); }
}
function audioToggle() {
  if (!app.audio.playlist.length) return;
  const el = ensureAudio();
  if (el.paused) {
    if (!el.src) { void playIndex(app.audio.index >= 0 ? app.audio.index : 0); }
    else { void el.play(); app.audio.playing = true; }
  } else { el.pause(); app.audio.playing = false; }
}
function audioNext() { void playIndex(app.audio.index + 1); }
function audioPrev() { void playIndex(app.audio.index - 1); }
function audioStop() {
  if (app.audio.el) { app.audio.el.pause(); app.audio.el.removeAttribute('src'); }
  app.audio.playing = false;
}
function setPlaylist(list) {
  app.audio.playlist = (list || []).filter((t) => t && t.path);
  if (!app.audio.playlist.length) { app.audio.index = -1; audioStop(); }
  else if (app.audio.index >= app.audio.playlist.length || app.audio.index < 0) app.audio.index = 0;
}
function setVolume(v) {
  app.audio.volume = clamp(v, 0, 1);
  if (app.audio.el) app.audio.el.volume = app.audio.volume;
  ipcRenderer.send('settings:save', { volume: app.audio.volume });
}

// ---------- 活动区域编辑面板 ----------

function regionDimsText() { return `${app.worldW}×${app.worldH}`; }
function refreshRegionDims() { if (panelDims) panelDims.textContent = regionDimsText(); }
function openRegionEditor() {
  if (app.petPickerOpen) closePetPicker();   // 一次只开一个浮层
  app.regionPanelOpen = true;
  regionPanel.style.display = 'block';
  refreshRegionDims();
  updateUiRects();
}
function closeRegionEditor() {
  app.regionPanelOpen = false;
  regionPanel.style.display = 'none';
  updateUiRects();
}
async function regionResizeBy(k) {
  const step = CFG.region.resizeStep;
  let w = app.worldW, h = app.worldH;
  if (k === 'w-') w -= step; else if (k === 'w+') w += step;
  else if (k === 'h-') h -= step; else if (k === 'h+') h += step;
  const r = await ipcRenderer.invoke('region:resize', w, h);
  applyRegion(r.regionScreen);
  refreshRegionDims();
}
async function regionResetToWorkArea() {
  if (!app.workArea) return;
  const r = await ipcRenderer.invoke('region:resize', app.workArea.width, app.workArea.height);
  applyRegion(r.regionScreen);
  refreshRegionDims();
}
regionPanel.addEventListener('click', (e) => {
  const k = e.target && e.target.getAttribute ? e.target.getAttribute('data-k') : null;
  if (!k) return;
  if (k === 'close') closeRegionEditor();
  else if (k === 'reset') void regionResetToWorkArea();
  else void regionResizeBy(k);
});

/* ================= 换宠 / 背景 应用内图片选择器 =================
 * 这台机器上原生文件对话框（dialog.showOpenDialogSync）确认后拿不到所选路径，
 * 换成在宠物窗里自己列文件夹、列图片、预览、导入 —— 完全不碰系统对话框。
 * 面板是普通 .interactive DOM，指针在上面窗口不穿透（走 uiRects + isInteractableAt）。 */

function pkSetErr(msg) { pkErr.textContent = msg || ''; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pkSetMsg(msg) { pkPrevMsg.textContent = msg || ''; pkPrevMsg.style.display = 'block'; }
function clearPkPreview() { pkPreview.querySelectorAll('img').forEach((i) => i.remove()); pkPrevMsg.style.display = 'block'; }

async function previewPickerFile(p) {
  if (app.petPickerKind === 'audio') {
    // 音频没有缩略图：显示文件名作为“预览”，并提示可连续添加
    clearPkPreview();
    pkSetMsg(`已选择：${nodePath.basename(p)} —— 点“加入播放列表”即可（可连续添加多首，Esc 结束）`);
    return;
  }
  pkSetMsg('预览加载中…');
  try {
    const img = await ipcRenderer.invoke('asset:readImage', p);
    if (!img) { pkSetMsg('无法读取这张图片'); return; }
    clearPkPreview();
    const el = document.createElement('img');
    el.alt = ''; el.draggable = false;
    el.src = img.dataUrl;
    pkPreview.appendChild(el);
    pkPrevMsg.style.display = 'none';
  } catch (e) { pkSetMsg('预览失败'); }
}

function renderPickerRoots(roots) {
  pkFolders.textContent = '';
  for (const r of roots) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pk-chip';
    b.textContent = r.label; b.title = r.path; b.dataset.dir = r.path;
    pkFolders.appendChild(b);
  }
}

function selectPickerFile(p) {
  app.petPickerCur = p;
  pkList.querySelectorAll('.pk-item').forEach((el) => el.classList.toggle('sel', el.dataset.path === p));
  pkUse.disabled = false;
  pkSetErr('');
  if (p) void previewPickerFile(p);
}

function renderPickerFiles(files) {
  pkList.textContent = '';
  if (!files.length) {
    const d = document.createElement('div');
    d.className = 'pk-empty';
    d.textContent = app.petPickerKind === 'audio'
      ? '这个文件夹里没有音乐（MP3 / WAV / OGG / FLAC / M4A / AAC）'
      : '这个文件夹里没有图片（PNG）';
    pkList.appendChild(d);
    return;
  }
  for (const f of files) {
    const it = document.createElement('div');
    it.className = 'pk-item';
    it.textContent = f.name;
    it.title = f.path;
    it.dataset.path = f.path;
    pkList.appendChild(it);
  }
}

function pickerEmptyMsg() {
  return app.petPickerKind === 'audio' ? '在列表里点一首，预览文件名' : '在列表里点一张图片预览';
}

async function loadPickerDir(dir) {
  if (!dir || app.pkBusy) return;
  pkSetErr('');
  app.petPickerDir = dir;
  app.petPickerCur = null;
  pkUse.disabled = true;
  pkPathInput.value = dir;
  clearPkPreview(); pkSetMsg(pickerEmptyMsg());
  pkList.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'pk-empty'; loading.textContent = '读取中…';
  pkList.appendChild(loading);
  let res;
  const req = app.petPickerKind === 'audio' ? { dir, kind: 'audio' } : dir;
  try { res = await ipcRenderer.invoke('picker:list', req); }
  catch (e) { res = { ok: false, error: '' + (e && e.message ? e.message : e) }; }
  if (res && res.ok) {
    renderPickerFiles(res.files || []);
  } else {
    pkList.textContent = '';
    const d = document.createElement('div');
    d.className = 'pk-empty';
    d.textContent = '无法打开该文件夹' + (res && res.error ? '：' + escapeHtml(res.error) : '');
    pkList.appendChild(d);
  }
  updateUiRects(); // 高度随内容变化 → 重新量参与命中判定的矩形
}

/** 音频模式“把这首加入播放列表”：拷贝进 assets → 追加到列表 → 若当前没在播则自动播这首。 */
async function addPickedAudio(p) {
  const added = await ipcRenderer.invoke('audio:addFiles', [p]);
  if (!added) { pkSetErr('添加失败，这个文件可能打不开，换一个试试'); return; }
  await new Promise((r) => setTimeout(r, 150)); // 等主进程回推 audio:list 刷新本地列表
  const el = app.audio.el;
  const nothingLoaded = !app.audio.playing && (!el || !el.src);
  if (nothingLoaded && app.audio.playlist.length) {
    void playIndex(app.audio.playlist.length - 1); // 自动播刚加的这一首
  }
  clearPkPreview();
  pkSetMsg(`已加入播放列表（共 ${app.audio.playlist.length} 首）—— 可继续点选添加，Esc 结束`);
  app.petPickerCur = null;
  pkUse.disabled = true;
}

/** 把当前选中的文件真正用起来；图片/背景成功后关闭面板，音频留在面板里可连续添加。 */
async function applyPicker() {
  const p = app.petPickerCur;
  const kind = app.petPickerKind;
  if (!p || app.pkBusy) return;
  app.pkBusy = true;
  pkUse.disabled = true;
  pkSetErr('');
  try {
    if (kind === 'bg') {
      const dest = await ipcRenderer.invoke('asset:importBg', p);
      if (dest) { setBgPath(dest); closePetPicker(); }
      else pkSetErr('背景设置失败，请换一张试试');
    } else {
      // kind === 'audio'
      await addPickedAudio(p);
    }
  } catch (e) {
    pkSetErr('失败：' + (e && e.message ? e.message : e));
    pkUse.disabled = !app.petPickerCur;
  } finally {
    app.pkBusy = false;
    syncHitTest();
  }
}

function openPetPicker(kind, initialDir) {
  const kindVal = kind === 'audio' ? 'audio' : 'bg'; // 换宠已移除：只余 背景/音乐
  const isBg = kindVal === 'bg', isAudio = kindVal === 'audio';
  app.petPickerKind = kindVal;
  if (app.regionPanelOpen) closeRegionEditor();
  pkTitle.textContent = isAudio ? '添加音乐' : '选择背景图片';
  pkHint.textContent = isAudio
    ? '（MP3 / WAV / OGG / FLAC / M4A / AAC）'
    : '（仅 PNG，铺在桌宠后面的图，高度自动按人物缩放）';
  pkUse.textContent = isAudio ? '把这首加入播放列表' : '把这张设为背景';
  app.petPickerOpen = true;
  petPickerEl.style.display = 'flex';
  // 选择器里有路径输入框（Esc 关闭也要键盘）→ 临时恢复窗口可激活；关闭时还原。
  // 平时不可激活（focusable:false）是为了点击宠物不抢前台，避免其它窗口的动画被
  // Chromium 遮挡检测冻结（见 main.js createWindow 注释）。
  ipcRenderer.send('win:setFocusable', true);
  app.petPickerCur = null;
  pkUse.disabled = true;
  pkSetErr('');
  clearPkPreview(); pkSetMsg('读取文件夹…');
  updateUiRects();
  void (async () => {
    let roots = [];
    try { roots = await ipcRenderer.invoke('picker:roots'); } catch (e) { roots = []; }
    renderPickerRoots(roots);
    const first = initialDir || (roots.length ? roots[0].path : '');
    if (first) await loadPickerDir(first);
    else {
      pkList.textContent = '';
      const d = document.createElement('div');
      d.className = 'pk-empty'; d.textContent = '找不到可用的图片文件夹';
      pkList.appendChild(d);
      updateUiRects();
    }
  })();
}

function closePetPicker() {
  if (!app.petPickerOpen) return;
  app.petPickerOpen = false;
  app.petPickerKind = 'bg';
  app.petPickerCur = null;
  pkUse.disabled = true;
  petPickerEl.style.display = 'none';
  clearPkPreview();
  updateUiRects();
  ipcRenderer.send('win:setFocusable', false); // 键盘浮层关闭 → 恢复“不可激活”
  syncHitTest();
}

function bindPetPicker() {
  petPickerEl.addEventListener('click', (e) => {
    if (app.pkBusy) return;
    const btn = e.target.closest('[data-pk]');
    if (btn) {
      const k = btn.dataset.pk;
      if (k === 'close') closePetPicker();
      else if (k === 'go') { const v = pkPathInput.value.trim(); if (v) void loadPickerDir(v); }
      else if (k === 'up') { const cur = app.petPickerDir; if (cur) { const par = nodePath.dirname(cur); if (par && par !== cur) void loadPickerDir(par); } }
      else if (k === 'refresh') { if (app.petPickerDir) void loadPickerDir(app.petPickerDir); }
      else if (k === 'use') void applyPicker();
      return;
    }
    const chip = e.target.closest('.pk-chip');
    if (chip && chip.dataset.dir) { void loadPickerDir(chip.dataset.dir); return; }
    const item = e.target.closest('.pk-item');
    if (item && item.dataset.path) selectPickerFile(item.dataset.path);
  });
  pkPathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = pkPathInput.value.trim(); if (v) void loadPickerDir(v); }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.petPickerOpen && !app.pkBusy) closePetPicker();
  });
}
bindPetPicker();

// ---------- 主菜单（右键长按触发；由主进程弹原生 Windows 风格菜单） ----------

/**
 * 弹出原生主菜单前的“手势清理”（bug #5：长按右键弹菜单后，Windows 常把松开右键
 * 的事件吞掉，渲染层会残留 buttonDown=true + 手势仍停在按住态；于是下一次鼠标一经过
 * 宠物，onMouseMove 就把这当作一次“拖动”，把宠物拽到光标位置 → 表现为“选任何菜单项
 * 后人物被吸到鼠标并吸附”。所以在请求弹菜单那一瞬就把所有按压/拖动/抓取态复位，
 * 菜单关闭时（menu:closed）再兜底清一次。
 */
function cleanupMenuGesture() {
  app.gtr.reset();
  app.buttonDown = false;
  app.dragging = false;
  app.grabOffset = null;
  app.ignoreSent = null;
  syncHitTest();
}

function requestMainMenu() {
  cleanupMenuGesture();
  ipcRenderer.send('menu:open');
}

// ---------- 初始化 ----------

function phase4Init(settings, workArea) {
  const s = settings || {};
  app.workArea = workArea ? { width: workArea.width, height: workArea.height } : null;
  if (s.background) {
    app.bgPath = s.background.path || null;
    app.bgOpacity = clamp(
      typeof s.background.opacity === 'number' ? s.background.opacity : CFG.ui.bgDefaultOpacity,
      CFG.ui.bgOpacityMin, CFG.ui.bgOpacityMax
    );
  }
  if (app.bgPath) void applyBg(app.bgPath);
  app.audio.volume = clamp(typeof s.volume === 'number' ? s.volume : CFG.audio.volumeDefault, 0, 1);
  app.audio.playlist = (s.playlist || []).filter((t) => t && t.path);
  app.audio.index = app.audio.playlist.length ? 0 : -1;
  initStatus(s.status);
  startStatusTimers();
  app.bus.add(onStatusInteract);
}

function initStatus(saved) {
  const now = Date.now();
  app.status = statusM.settleStatus(normStatusSnap(saved, now), now); // 启动即离线结算
  app._lastStatusPersist = now;
  applyStatusVisual();
  refreshPill();
  persistStatus(true);
}

/* ================= 测试钩子 ================= */

function testState() {
  const p = app.pet;
  const v = app.status ? statusM.deriveStatus(app.status) : null;
  return {
    ready: app.ready, testMode: app.testMode, locked: app.locked, paused: app.paused,
    petLoaded: !!p, dragging: app.dragging, physActive: !!app.phys,
    interactive: app.ignoreSent === false,
    world: { w: app.worldW, h: app.worldH },
    pet: p ? { w: p.w, h: p.h, x: p.pos.x, y: p.pos.y, anchor: { ...p.anchor } } : null,
    animScale: p ? (() => {
      const d = app.anim.drawnScale || { x: 1, y: 1 };
      return { sx: app.anim.spr.x.s, sy: app.anim.spr.y.s, drawnSy: d.y, drawnSx: d.x };
    })() : null,
    // 吸附 / 抛掷 状态快照
    phys: app.phys ? {
      x: app.phys.s.x, y: app.phys.s.y, vx: app.phys.s.vx, vy: app.phys.s.vy,
      grounded: app.phys.s.grounded,
    } : null,
    snap: app.snap ? { ...app.snap } : null,
    snapEnabled: app.snapEnabled,
    physicsEnabled: app.physicsEnabled,
    rest: app.rest ? { ...app.rest } : null,
    pillCollapsed: pillEl.classList.contains('collapsed'),
    cursor: { ...app.cursor, known: app.cursorKnown },
    // Phase 4
    status: app.status ? { ...app.status } : null,
    derived: v,
    greetings: CFG.greeting.greetings || [],
    bubbleVisible: !!(bubbleEl && bubbleEl.classList.contains('show')),
    blinkAnim: { frames: app.blinkAnim.frames.length, probability: app.blinkAnim.probability },
    stateVisualVisible: app.stateVisual.visible,
    stateBodyReady: !!app.stateBody,
    bodyKind: app.pet === app.stateBody ? 'state' : 'main', // 当前活动身体
    pillText: pillEl.querySelector('.txt').textContent,
    petOpacity: p ? petWrap.style.opacity : null,
    bgOn: !!app.bgOn,
    bgPath: app.bgPath || null,
    bgRect: (() => {
      if (!app.bgOn) return null;
      const r = bgEl.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, bottom: r.top + r.height };
    })(),
    regionPanelOpen: !!app.regionPanelOpen,
    petPickerOpen: !!app.petPickerOpen,
    audio: {
      hasEl: !!app.audio.el, playing: !!app.audio.playing, index: app.audio.index,
      paused: !!(app.audio.el && app.audio.el.paused), playlistCount: app.audio.playlist.length,
      volume: app.audio.volume,
    },
  };
}

/** 启动时应用"可定制值"（app:init 的 dev 块）→ 填 app.greetings / app.blinkAnim / app.stateImagePath。
 *  无开发者模式（也无固化文件）时字段值 = config.js 默认 → 行为与旧版完全一致。 */
async function applyDevInit(dev) {
  const d = dev && typeof dev === 'object' ? dev : {};
  if (Array.isArray(d.greetings) && d.greetings.length) app.greetings = d.greetings;
  app.blinkAnim = { frames: [], probability: 1 };
  if (d.blinkAnim && Array.isArray(d.blinkAnim.frames)) {
    const frames = [];
    for (const f of d.blinkAnim.frames) {
      if (!f || !f.path) continue;
      const img = await ipcRenderer.invoke('asset:readImage', f.path);
      if (img) frames.push({ src: img.dataUrl, durationMs: clamp(Number(f.durationMs) || 150, 30, 5000) });
    }
    if (frames.length) {
      app.blinkAnim.frames = frames;
      const prob = Number(d.blinkAnim.probability);
      app.blinkAnim.probability = Number.isFinite(prob) ? clamp(prob, 0, 1) : 1;
    }
  }
  if (d.stateImagePath) {
    const img = await ipcRenderer.invoke('asset:readImage', d.stateImagePath);
    if (img) app.stateImagePath = img.dataUrl;
  }
}

async function init() {
  const st = document.documentElement.style;
  st.setProperty('--pillBg', CFG.ui.pillBg);
  st.setProperty('--pillText', CFG.ui.pillText);
  st.setProperty('--ringColor', CFG.ui.ringColor);

  const initInfo = await ipcRenderer.invoke('app:init');
  app.testMode = initInfo.testMode;
  app.locked = initInfo.locked;
  applyRegion(initInfo.regionScreen);

  bindIpc();
  window.addEventListener('resize', () => applyRegion({ x: app.worldOrigin.x, y: app.worldOrigin.y, width: window.innerWidth, height: window.innerHeight }));
  window.dispatchEvent(new Event('petinit'));

  // 读取折叠状态 + 吸附/物理开关（托盘可关）
  if (initInfo.settings && initInfo.settings.pillCollapsed) pillEl.classList.add('collapsed');
  app.snapEnabled = !(initInfo.settings && initInfo.settings.snapEnabled === false);
  app.physicsEnabled = !(initInfo.settings && initInfo.settings.physicsEnabled === false);
  phase4Init(initInfo.settings, initInfo.workArea);
  updateUiRects();
  await applyDevInit(initInfo.dev); // 可定制值要在 loadPet/loadStateBody（状态身体路径）/scheduleBlink 之前就位

  // 宠物主图路径由主进程统一解析（开发者配置覆盖 > 素材根目录 pet.png > settings 旧值 > 内置占位图）
  const petPath = initInfo.petPath;
  if (petPath) {
    const img = await ipcRenderer.invoke('asset:readImage', petPath);
    if (img) await loadPet(img.dataUrl);
    // 占位图也照常显示，但保留提示条引导自定义（loadPet 会先隐藏提示条，这里再打开）
    if (!img || initInfo.petIsPlaceholder) hintEl.style.display = 'block';
  } else {
    hintEl.style.display = 'block';
  }
  void loadStateBody(); // 预载状态形象（第二具身体）；失败只是切换状态不可用，不影响主形象
  refreshPill();

  app.ready = true;
  window.__petReady = true;
  window.__pet = app;
  scheduleBlink();
  setTimeout(() => {
    const list = app.greetings || CFG.greeting.greetings || [];
    if (list.length) showBubble(list[Math.floor(Math.random() * list.length)], CFG.greeting.durationMs);
  }, CFG.greeting.delayMs);
  if (app.testMode) {
    window.__petState = () => testState();
    window.__petTest = {
      state: testState,
      petScreenRect: () => (app.pet ? petRect(app.pet) : null),
      isInteractableAt, cursorToContent,
      // UI 自动化驱动入口（绕过真实鼠标事件）
      headpat() { pulseHeadpat(); },
      pulse(m) { pulse(m); },
      feed() { pulseFeed(); },
      toggleLock() { toggleLock(); },
      heart(level = 1) { const p = app.pet; if (p) spawnHeart(p.pos.x + p.anchor.x, p.pos.y + 10, level); },
      forceBlink(visible) { setBlinkVisible(!!visible); },
      // 多帧眨眼动画驱动（测试/调试）：frames=[{src:dataUrl,durationMs}]，probability 0~1
      setBlinkAnim(frames, probability) {
        app.blinkAnim.frames = (Array.isArray(frames) ? frames : [])
          .filter((f) => f && f.src)
          .map((f) => ({ src: f.src, durationMs: clamp(Number(f.durationMs) || 150, 30, 5000) }));
        app.blinkAnim.probability = clamp(Number(probability == null ? 1 : probability), 0, 1);
      },
      playBlinkAnim() {
        if (!app.blinkAnim.frames.length || !app.pet) return false;
        playBlinkAnimSequence();
        return true;
      },
      toggleStateVisual: () => toggleStateVisual(),
      showBubble: (text, ms) => showBubble(text, ms),
      hideBubble: () => hideBubble(),
      forcePhys(vx, vy) { startPhys({ vx, vy }); },
      animState() { return { sx: app.anim.spr.x.s, sy: app.anim.spr.y.s, ring: app.anim.ringVisible }; },
      drag(dx, dy) { if (app.pet) { app.pet.pos.x += dx; app.pet.pos.y += dy; clampPetIntoWorld(app.pet); syncPlacement(); } },
      // 拖放定位钩子（吸附/抛掷/背景等场景用）
      placePet(x, y) { if (app.pet) { app.pet.pos.x = x; app.pet.pos.y = y; syncPlacement(); } },
      // 吸附测试驱动：注入窗口列表 / 直接尝试吸附 / 触发脱落检查
      setSnapWindows(wins) { app._snapWinOverride = wins; },
      trySnap: () => attemptSnap(),
      pollSnap: () => snapPollTick(),
      detach: () => detachFall(),
      snapInfo: () => app.snap ? { ...app.snap } : null,
      // 物理/释放路由钩子
      setPhysicsEnabled(v) { app.physicsEnabled = !!v; if (!app.physicsEnabled && app.phys) stopPhys(); },
      releaseRel(vx, vy, speed) { routeRelease({ vx, vy, speed: speed == null ? Math.hypot(vx, vy) : speed }); },
      // Phase 4：状态 / 面板 测试钩子
      resetStatus: () => resetStatus(),
      setStatus(partial) { if (app.status) { app.status = { ...app.status, ...partial, lastTs: Date.now() }; applyStatusVisual(); refreshPill(); } },
      setAffinityRng(rng) { app.affinityRng = typeof rng === 'function' ? rng : (() => (rng == null ? 0 : rng)); },
      openRegionPanel: () => openRegionEditor(),
      closeRegionPanel: () => closeRegionEditor(),
      // 应用内选择器测试钩子：openPicker(kind, dir?)（dir 指定起始文件夹，使场景确定性）
      openPicker: (kind, dir) => openPetPicker(kind || 'bg', dir),
      closePicker: () => closePetPicker(),
      pickerFiles: () => ({ dir: app.petPickerDir, names: Array.from(pkList.querySelectorAll('.pk-item')).map((el) => el.textContent) }),
      statusPersist() { persistStatus(true); },
      // —— “休息”钩子：restState 观测；restStart 走默认（30s，仅冒烟用）；restShort 用短时长/快周期测闪烁与回满 ——
      restState: () => (app.rest
        ? { active: app.rest.active, start: app.rest.start, dur: app.rest.dur, period: app.rest.period, min: app.rest.min, max: app.rest.max, elapsed: Date.now() - app.rest.start, opacity: app.rest.opacity }
        : { active: false, opacity: petWrap.style.opacity }),
      restStart: () => startRest(),
      restShort(durMs, periodMs, minOp, maxOp) {
        beginRest(durMs, periodMs, minOp == null ? CFG.rest.opacityMin : minOp, maxOp == null ? CFG.rest.opacityMax : maxOp);
      },
      // 穿透语义回归钩子：注入“内容坐标”光标并立即同步一次命中判定
      setCursorContent(x, y) { app.cursor = { x: x + app.worldOrigin.x, y: y + app.worldOrigin.y }; app.cursorKnown = true; syncHitTest(); },
      ignoreNow: () => app.ignoreSent,
      // —— 菜单手势清理回归（bug5：菜单弹出/关闭后不能残留按键态把人物拽走）——
      menuCleanup: () => cleanupMenuGesture(),
      menuState: () => ({ idle: app.gtr.isIdle, buttonDown: app.buttonDown, dragging: app.dragging, grabOffset: app.grabOffset, ignore: app.ignoreSent }),
      beginPress(button, x, y) { app.buttonDown = true; app.gtr.pointerDown({ x, y, t: nowMs(), button }); },
      strayMove(x, y) { app.buttonDown = true; if (app.buttonDown || app.gtr.isInteracting) onMouseMove({ clientX: x, clientY: y }); app.buttonDown = false; },
      petPos: () => (app.pet ? { x: app.pet.pos.x, y: app.pet.pos.y } : null),
      // —— 背景：真实导入→设置 / 清除 / 读取几何（bug1：贴地+居中跟随；bug2：可清除可再开）——
      async setBgFromPath(src) { const dest = await ipcRenderer.invoke('asset:importBg', src); if (!dest) return false; setBgPath(dest); return true; },
      clearBg: () => setBgPath(null),
      bgGeom: () => {
        const p = app.pet;
        return {
          bgOn: !!app.bgOn,
          bgRect: app.bgOn ? (() => { const r = bgEl.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, bottom: r.top + r.height }; })() : null,
          petCX: p ? p.pos.x + p.w / 2 : null,
          petGround: p ? p.pos.y >= app.worldH - p.h - 1.5 : false,
          worldH: app.worldH,
        };
      },
    };
  }
  app.raf = requestAnimationFrame(frame);
}

init().catch((e) => { console.error('[app] init 失败', e); });
