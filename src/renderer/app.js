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
 * 表现层只用 CSS transform 做 q 弹缩放（无待机呼吸），动画变形不改变任何判定。
 */
const { ipcRenderer } = require('electron');
const nodePath = require('path');
const { CFG } = require('../shared/config');
const { clamp } = require('../shared/util');
const { analyzeBitmap, hitTestPixel, scalePlan } = require('../shared/geom');
const {
  GestureTracker, springParams, integrateSpring, impulse, settleSpring,
  step: physicsStep, atRest: physicsAtRest, normCol,
} = require('../shared/motion');
const { normalizeAutoAnim, nextDelayMs, shouldAnimate, pickGroupIndex } = require('../shared/autoAnim');
const statusM = require('../shared/status');
const {
  TYPING_IDLE, typingCfg, createTypingMachine, onTypingBeat, onTypingIdleCheck,
} = require('../shared/typing');

const $ = (id) => document.getElementById(id);
const worldEl = $('world'), petWrap = $('petWrap'), petEl = $('pet');
const fxEl = $('fx'), ringWrap = $('ringWrap'), ringArc = $('ringArc');
const pillEl = $('pill');
const bubbleEl = $('bubble');
// 整帧替换用的叠加层（原名 #blink —— 它早就不是"眨眼专用"了，自动动画三种都走这里）
const overlayEl = $('overlay');
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

  pet: null,           // {src,w,h,bitmap,anchor,col,pos} —— 判定/物理只认这个“身体”，与显示解耦
  uiRects: [],         // 可交互 UI 矩形（状态胶囊、面板），参与 isInteractableAt 判定
  forceInteractive: false, // 弹层/菜单打开时强制整窗可交互（瞬态）

  // ---- 动画（只有 q 弹弹簧；待机不做任何缩放）----
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
  // ---- 显示：只有一种形态，靠"是否在打字"自动切换，用户不再手动选 ----
  mainBody: null,      // 主形象身体（app.pet 恒指向"当前正在显示的那一具"）
  // ---- 自动动画（原「眨眼」+「随机特效」两套调度合并；config.autoAnim） ----
  autoAnim: {
    // cfg.groups 是**唯一**的组来源：启动时把里面的 path 就地换成解码好的帧身体，
    // 于是"掷概率/随机选组"的纯函数与"实际播什么"永远看同一份数据，不会出现下标错位。
    cfg: normalizeAutoAnim(), // {minIntervalMs,maxIntervalMs,chance,frameMs,groups}
    timer: 0,          // 下一次"到点"的定时器
    playing: false,    // 正在播整帧序列
    frameTimer: null,  // 当前帧的换帧定时器
    visible: false,    // 叠加层显示中（= 本体被隐藏中）
    enabled: false,    // 心跳总闸：测试模式默认关，否则断言时机不可控
    rng: null,         // 随机源（测试可注入）；null = Math.random
  },
  // ---- 打字（config.typing 两帧 + 探针节拍；判定逻辑在 shared/typing.js，一字未改） ----
  typeBodies: [],      // 打字两帧身体（[0]=图1、[1]=图2）；不足 2 = 打字切换不可用
  typing: {            // 帧机状态见 shared/typing.js（纯函数，单测锁死行为线）
    machine: createTypingMachine(),
    timer: 0,          // 停手判定定时器（到点跑 onTypingIdleCheck → 回主图）
    cfg: typingCfg(),  // { idleMs, minFlipMs }
  },
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

/** 把已加载的 Image 解码成一具"身体"：等比缩放 → 位图分析（透明判定 + 实体像素中心锚点 +
 *  像素级碰撞盒）。主图 / 打字两帧 / 自动动画各帧都走这条管线；body.bitmap 是该身体
 *  像素级判定的唯一来源，body.src（原图）交给 <img> 由浏览器按显示尺寸高质量光栅化。 */
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
  const b = analysis.bbox;
  return {
    src: img.src, w: width, h: height, bitmap: imageData, anchor: analysis.anchor,
    // 像素级碰撞盒：不透明像素包围盒（本地位移/尺寸）。物理落地/贴墙/吸附贴顶/背景贴地
    // 全以它为准（透明边距不参与碰撞，落地不再“悬空”）。
    col: { ox: b.x0, oy: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 },
    pos: null,
  };
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
  // 与物理边界同一语义：按碰撞盒（不透明像素）夹取，透明边距允许悬出区域边缘。
  // 若按整图夹取，会把“碰撞盒贴地落地”的宠物提离地面（透明边距高度），破坏贴地判定。
  const col = normCol(p);
  p.pos.x = clamp(p.pos.x, -col.ox, Math.max(-col.ox, app.worldW - col.w - col.ox));
  p.pos.y = clamp(p.pos.y, -col.oy, Math.max(-col.oy, app.worldH - col.h - col.oy));
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
  petEl.style.transform = '';
  hintEl.style.display = 'none';
  app.anim.spr = { x: { s: 1, v: 0 }, y: { s: 1, v: 0 } };
  // 载入主形象 = 回到主图（换宠后抛掷状态复位；打字帧机与正在播的动画一并复位）
  stopTyping();
  abortOverlayPlayback();
  app.phys = null;
  app.dragging = false;
  syncPlacement();
  return true;
}

/** 把"身体"显示到本体 <img> 上：显示尺寸 = 身体尺寸，缩放原点 = 该身体的锚点。
 *  原图直通（body.src），浏览器按显示尺寸高质量光栅化 —— 与叠加帧同一条管线，无发糊。 */
function drawBody(body) {
  petEl.src = body.src;
  petEl.style.width = body.w + 'px';
  petEl.style.height = body.h + 'px';
  petWrap.style.width = body.w + 'px';
  petWrap.style.height = body.h + 'px';
  petEl.style.transformOrigin = `${body.anchor.x}px ${body.anchor.y}px`;
}

/**
 * 预载打字两帧（config.typing.frames）。半组残缺比没有更难看（连打时会闪缺一帧），
 * 所以任一帧失败就整组作废 → typingAvailable()=false → 打字时保持主图并在控制台说明原因。
 * 停手后回**主图**（原来的第三张"不打字"图已随形态系统一起删除）。
 */
async function loadTypingBodies() {
  const paths = (CFG.typing && CFG.typing.frames) || [];
  const bodies = [];
  for (const p of paths) {
    try { bodies.push(await decodeImageAnyPath(p)); } catch (e) {
      console.warn('[pet] 打字帧加载失败（打字时不会切换素材）', p, e && e.message ? e.message : e);
      bodies.length = 0;
      break;
    }
  }
  app.typeBodies = bodies.slice(0, 2);
}

/**
 * 预载自动动画的各组帧（config.autoAnim.groups：三种动画 = 三组，帧数 1 / 1 / 2）。
 * 与打字帧同一条红线：一组里任一帧失败就整组作废（播到一半缺帧比不播更难看）；
 * 全部组都作废则 autoAnim.groups 为空 → 调度器不再起播（功能自然关闭，不会报错刷屏）。
 */
async function loadAnimGroups() {
  const cfg = app.autoAnim.cfg;
  const out = [];
  for (const g of cfg.groups) {
    const frames = [];
    let ok = true;
    for (const p of g.frames) {
      try { frames.push({ ...(await decodeImageAnyPath(p)), durationMs: cfg.frameMs }); } catch (e) {
        console.warn('[pet] 动画帧加载失败（该组作废）', g.name, p, e && e.message ? e.message : e);
        ok = false;
        break;
      }
    }
    if (ok && frames.length) out.push({ name: g.name, frames });
  }
  // 就地替换：cfg.groups 从"路径组"变成"帧身体组"，形状不变（{name, frames:[...]}），
  // 所以下游 pickGroupIndex / playOverlayFrames 不需要知道这次替换发生过。
  app.autoAnim.cfg = { ...cfg, groups: out };
}

function syncPlacement() {
  const p = app.pet;
  if (p) petWrap.style.transform = `translate3d(${p.pos.x}px, ${p.pos.y}px, 0)`;
  layoutBg(); // 背景贴地 + 人物居中跟随 → 人物一移动背景即刷新
}

/* ================= 事件总线（Phase 4 状态层） ================= */

function emit(kind, data) { for (const fn of app.bus) { try { fn(kind, data); } catch (e) { console.error(e); } } }

/* ================= 动画（q 弹 / 爱心） ================= */

function setScale(sx, sy) {
  const c = sx === 1 && sy === 1 ? '' : `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  petEl.style.transform = c;
  // 叠加帧（自动动画接管期间显示的 element）必须吃同一个缩放：本体那时是隐藏的，
  // 只写 #pet 的话 ① 动画期间摸头/落地这一下 q 弹完全看不见，② 播完交还本体的瞬间
  // 会突然冒出一个"压扁到一半"的身体 —— 肉眼就是"动画结束时闪一下"。
  // 两边 origin 用各自的 anchor（内置素材同画布 → 数值相同，所以缩放后仍逐像素重合）。
  overlayEl.style.transform = c;
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

/**
 * 聊天气泡定位（所有气泡共用：问候/提醒/催促/聊天回复）。
 *
 * ★ 必须**给宠物头顶的语音提示条让位**（用户 2026-09-16 反馈）。
 *   原因：语音提示条（含绿色电平条）锚在 `宠物y - 26`、高约 24px → 占 `y-26 .. y-2`；
 *   气泡原本锚在 `y - 气泡高 - 8`，一行气泡高约 36px → 占 `y-44 .. y-8`。
 *   两者**重叠 18px**，而气泡 z-index(9) 又高于提示条(8) → 互相盖住、看起来反复闪动。
 *   现在把提示条占的高度算进偏移：提示条在时气泡整体上移，提示条收起后再落回来。
 * @returns {boolean} 是否真的排了（气泡没显示时返回 false）
 */
function layoutBubble() {
  if (!bubbleEl || !app.pet) return false;
  if (!bubbleEl.classList.contains('show')) return false;
  const p = app.pet;
  const reserve = voiceReserveHeight();
  bubbleEl.style.left = `${clamp(p.pos.x + p.anchor.x - bubbleEl.offsetWidth / 2, 6, Math.max(6, app.worldW - bubbleEl.offsetWidth - 6))}px`;
  bubbleEl.style.top = `${clamp(p.pos.y - reserve - bubbleEl.offsetHeight - 8, 6, Math.max(6, app.worldH - bubbleEl.offsetHeight - 6))}px`;
  return true;
}

function showBubble(text, durationMs) {
  if (!bubbleEl || !app.pet) return;
  bubbleEl.textContent = String(text || '');
  bubbleEl.classList.add('show');
  layoutBubble();
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

/* ================= 语音状态指示（红线：纯视觉，不进 uiRects） ================= */

const voiceEl = $('voice');
const voiceTxtEl = voiceEl ? voiceEl.querySelector('.vt') : null;
const voiceBarEl = voiceEl ? voiceEl.querySelector('.bar > i') : null;
// 语音侧状态（主进程 voice:state / voice:partial 推来；呈现规则：只在 decoding 时显示）
const voiceState = { state: 'idle', rms: 0, partial: '' };

function setVoiceState(patch) {
  Object.assign(voiceState, patch || {});
  layoutVoiceIndicator();
}

/**
 * "在听/在识别"小指示：跟着宠物头顶走。
 * ★ 呈现规则（用户定调，2026-09-15）：**被动等待唤醒时不显示任何东西** ——
 *   后台监听是安静的，桌面不该常驻一个"说 XX 叫我"的小窗；
 *   只有真正进入对话（被唤醒词唤醒 / 按键说话，即 state='decoding'）才出现。
 * 注意它是 **pointer-events:none** 的纯视觉元素，且**故意不进 updateUiRects()** ——
 * 它不是可点目标，不能给像素穿透判定添新矩形（红线）。
 */
function layoutVoiceIndicator() {
  if (!voiceEl) return;
  const on = voiceState.state === 'decoding';
  const wasOn = voiceEl.classList.contains('on');
  voiceEl.classList.toggle('on', on);
  // ★ 显示/隐藏切换时要把气泡重新排一次：语音条占的那点高度要"还回去"（否则气泡悬空或跳位）
  if (on !== wasOn) {
    if (layoutBubble()) updateUiRects(); // 气泡参与命中判定，位置变了就得同步矩形
  }
  if (!on) return;
  const label = voiceState.partial ? `听到：${voiceState.partial}` : '在听…';
  if (voiceTxtEl) voiceTxtEl.textContent = label;
  if (voiceBarEl) voiceBarEl.style.width = `${Math.min(100, Math.round(voiceState.rms * 500))}%`;
  const p = app.pet;
  const w = voiceEl.offsetWidth || 120;
  voiceEl.style.left = `${clamp(p.pos.x + p.anchor.x - w / 2, 6, Math.max(6, app.worldW - w - 6))}px`;
  voiceEl.style.top = `${clamp(p.pos.y - 26, 6, Math.max(6, app.worldH - 26))}px`;
}

/**
 * 语音提示条当前占掉的高度（不可见 → 0）。
 * 气泡定位要把它算进去 —— 见 layoutBubble() 的注释（两个元素重叠是用户实际看到的 bug）。
 */
function voiceReserveHeight() {
  if (!voiceEl || !voiceEl.classList.contains('on')) return 0;
  return (voiceEl.offsetHeight || 24) + 6;
}

/** 语音"在听"期间压低 BGM（否则麦克风会把自己的音乐收进去污染识别）。 */
function duckAudio(on) {
  const el = app.audio.el;
  if (!el) return;
  el.volume = on ? Math.min(app.audio.volume, CFG.audio.duckVolume) : app.audio.volume;
}

function setOverlayVisible(v) {
  app.autoAnim.visible = !!v;
  if (overlayEl) overlayEl.style.display = app.autoAnim.visible ? 'block' : 'none';
}

/* ================= 叠加帧（自动动画整帧“接管”本体显示；打字两帧走换身体而非这里） =========
 * 帧素材是"包含完整宠物的整图" → 接管期间隐藏本体、播完恢复（防双影）。
 * 红线不受影响：判定/物理始终用 app.pet 的真实身体位图，叠加只是显示层。
 * 叠加层**吃与本体同一个 q 弹缩放**（setScale 两边一起写）—— 否则动画期间摸头看不见反馈，
 * 播完交还本体的瞬间还会冒出一个"压扁到一半"的身体。起播仍要求弹簧已收敛
 * （canStartOverlay 里查），免得在明显形变中途换图。 */

/** 显示一帧：帧与本体按“不透明像素包围盒的底边中点”对齐（脚底原地不动）。
 *  注入的测试帧（只有 src/durationMs，没有 col）回退为铺满本体。 */
function showFrameBody(fb) {
  const p = app.pet;
  if (!p) return;
  const fw = fb.w || p.w, fh = fb.h || p.h;
  const fcol = fb.col || { ox: 0, oy: 0, w: fw, h: fh };
  const bx = p.col.ox + p.col.w / 2, by = p.col.oy + p.col.h;
  const fx = fcol.ox + fcol.w / 2, fy = fcol.oy + fcol.h;
  overlayEl.style.left = `${bx - fx}px`;
  overlayEl.style.top = `${by - fy}px`;
  overlayEl.style.width = `${fw}px`;
  overlayEl.style.height = `${fh}px`;
  // q 弹的缩放原点跟着走（注入的测试帧没有 anchor → 退回本体的，二者同画布时本来也一样）
  const fa = fb.anchor || p.anchor;
  overlayEl.style.transformOrigin = `${fa.x}px ${fa.y}px`;
  overlayEl.src = fb.src;
}

function overlayBusy() { return !!app.autoAnim.playing; }

/** 播放期间暂停透明度变化（休息闪烁/归零半透明都走这里）；播完由 finish 恢复。 */
function applyPetOpacity() {
  if (!app.pet || overlayBusy()) return;
  petWrap.style.opacity = petOpacityNow();
}

/** 停止叠加帧播放，把显示交还本体（拖动/抛掷/隐藏/要切打字时调用）。
 *  心跳重排走 armAnimTry()：它自带 `enabled` 闸，所以"测试模式不自动跑动画"这个前提
 *  不会再被一次拖动悄悄打破（旧实现无条件重排特效调度器，是串扰来源）。
 *  force=true：立刻交接、不等解码 —— 被打字接管时"下一键必须马上看到"压过"绝不空一帧"。 */
function abortOverlayPlayback(force) {
  if (app.autoAnim.frameTimer) { clearTimeout(app.autoAnim.frameTimer); app.autoAnim.frameTimer = null; }
  const wasPlaying = overlayBusy();
  app.autoAnim.playing = false;
  if (force) restoreBodyNow(); else restoreBodyFromOverlay();
  if (wasPlaying) applyPetOpacity();
  armAnimTry();
}

/** 把显示交还本体：隐藏叠加层与显示本体必须在**同一拍**写进 CSS，中途两样都看不见就是空帧。 */
function restoreBodyNow() {
  setOverlayVisible(false);
  if (app.pet) petEl.style.display = '';
}

/**
 * 交还本体的"不空帧"版本：先确认本体这一张图解码到位，再撤叠加层。
 * 本体在叠加层播放期间是 display:none，位图会被浏览器丢掉（实测重新显示前还要再解码 8~29ms）——
 * 先撤叠加层就会出现同样的"闪一下"；反过来"先显示本体再撤叠加层"则会双影（透明区漏出本体）。
 * 所以：等解码（这期间叠加层照常显示，画面完好）→ 同一拍交接；兜底时限到就直接交接。
 */
function restoreBodyFromOverlay() {
  if (!app.pet) { setOverlayVisible(false); return; }
  decodeReady(() => petEl.decode()).then(restoreBodyNow);
}

/**
 * 等一张图解码到位再往下走；失败/超时都照常 resolve（宁可交接慢，也绝不把显示卡在半路）。
 * 时限用 config.image.decodeWaitMs：真解码一次实测 25~37ms，留的是"异常兜底"的余量。
 */
function decodeReady(run) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; clearTimeout(guard); resolve(); };
    const guard = setTimeout(done, CFG.image.decodeWaitMs);
    let p;
    try { p = run(); } catch { done(); return; }
    if (p && typeof p.then === 'function') p.then(done, done); else done();
  });
}

/** 把显示交给当前这一帧（隐藏本体 + 显示叠加层，同样同一拍完成）。 */
function revealFrame() {
  petEl.style.display = 'none';   // 帧是完整整图：接管期间隐藏本体（防双影）
  setOverlayVisible(true);
}

/**
 * 交接给某一帧：**先让浏览器把这一帧解码到位**，再换显示。
 *
 * 为什么必须等（用户 2026-10-02 反馈的"眨眼时整张图明显闪一下"）：素材是 2048 见方的手绘 PNG，
 * 冷解码实测 25~37ms，本机 240Hz 下就是 6~8 个渲染帧。原来的顺序是"挂 src → 立刻隐藏本体 →
 * 显示叠加层"，那几帧里本体已经没了、叠加层还没有位图可画 → 屏幕上**没有人物** = 明显的闪一下
 * （而且是"有时候"：位图在不在解码缓存里取决于内存压力与多久没显示过，实测冷 37ms / 热 4ms）。
 * 解码期间本体照常显示，所以既不空也不会双影；起播只晚报到 ≤37ms，肉眼读作"正常起播"。
 * ⚠ `img.complete` 不能当就绪信号 —— 实测 complete=true 时 decode() 仍要 25~33ms：
 *   complete 只说明字节到手，不说明位图可画，只有 decode() 本身算数。
 */
function handoffToFrame() {
  return decodeReady(() => overlayEl.decode()).then(() => {
    // 解码期间可能已被打字/拖动/隐藏接管，或本轮已放弃 —— 一律以那边为准，这里不再改显示
    if (!overlayBusy() || !app.pet || app.paused || app.dragging || isTypingNow()) return false;
    revealFrame();
    return true;
  });
}

/** 依次播放叠加帧（每帧显示各自 durationMs，播完恢复本体）。
 *  每帧开始前重新检查：宠物在/未隐藏/未拖动/未在打字 —— 异常即终止。 */
function playOverlayFrames(frames, done) {
  let i = 0;
  const stop = () => {
    if (!overlayBusy()) return;   // 已被 abort/打字/拖动接管：显示由那边恢复，这里不能再动
    finishOverlayPlayback();
    if (done) done();
  };
  const step = () => {
    app.autoAnim.frameTimer = null;
    if (!app.pet || app.paused || app.dragging || isTypingNow() || i >= frames.length) { stop(); return; }
    const fb = frames[i];
    i += 1;
    showFrameBody(fb);            // 只把这一帧挂到叠加层上 —— 此刻**本体仍在显示**，屏幕不会空
    handoffToFrame().then((ok) => {
      if (!ok) { stop(); return; }
      app.autoAnim.frameTimer = setTimeout(step, fb.durationMs);
    });
  };
  step();
}

function finishOverlayPlayback() {
  if (app.autoAnim.frameTimer) { clearTimeout(app.autoAnim.frameTimer); app.autoAnim.frameTimer = null; }
  restoreBodyFromOverlay();
  applyPetOpacity(); // 播放中暂停的透明度变化，播完恢复
}

/* ================= 身体切换（只有一种形态；打字两帧是唯一的"换身体"场景） =========
 * app.pet 指向当前显示的身体 → 像素判定/拖动/抛掷/背景跟随/气泡爱心定位全部作用于它。
 * 连续性基准用"整图底边中点"。前提是所有身体**同画布、同脚底、同中轴** —— 这条契约
 * 由 test/unit/assets.test.js 逐张常驻守卫（画布尺寸相同 + 脚底差 ≤4px + 中轴差 ≤3px）。
 * ⚠ 不要改成按不透明包围盒(col)对齐：那样一来本函数与 showFrameBody 两套基准，
 *   主图与内置打字帧画布不同时（UI 测试就是 96px 夹具配 386px 素材）会测出 126px 的跳位，
 *   实测踩过。契约在测试里守，比在这里做"更聪明"的对齐更稳。 */

/** 当前活动身体是哪一具（诊断 / 测试快照）。 */
function bodyKindOf(b) {
  if (!b) return null;
  if (b === app.mainBody) return 'main';
  const i = app.typeBodies.indexOf(b);
  return i >= 0 ? `type${i + 1}` : 'unknown';
}

/** 把当前身体换成 next：整图底边中点连续（同画布就是纯换图，脚底不动）。 */
function applyBody(next) {
  const old = app.pet;
  if (!next) return false;
  if (old && old.pos) {
    const bottom = old.pos.y + old.h;
    const cx = old.pos.x + old.w / 2;
    next.pos = { x: Math.round(cx - next.w / 2), y: Math.round(bottom - next.h) };
  }
  app.pet = next;
  drawBody(next);
  clampPetIntoWorld(next);
  syncPlacement();
  return true;
}

/** 打字两帧齐了才可能自动切换；缺帧就一直是主图（不"选了却没反应"）。 */
function typingAvailable() { return app.typeBodies.length === 2; }

/** 现在是否处于"正在打字"中（帧机相位不是停手）。 */
function isTypingNow() { return app.typing.machine.phase !== TYPING_IDLE; }

/* ================= 打字显示：每按一下键盘在两张打字图之间交替，停手 idleMs 回主图 ==========
 * 节拍来源：主进程键盘探针 → typing:beat。交替/限幅/停手判定的纯逻辑在 shared/typing.js，
 * 行为线由单测锁死，不依赖真敲键盘。**这次改版只动"显示哪张图"，判定逻辑一字未改。**
 * 中文/英文一律同一套判定：只认"有没有文本键被按下"，不检测输入法候选窗。 */

function onTypingBeatReceived() {
  if (!typingAvailable()) return;
  // 动画正在播 → 立刻中止让位给打字帧（"只要还在打字，就只在这两张之间切换"）
  // force=true：这一路**不等解码** —— 下一个按键必须马上看到，优先级高于"绝不空一帧"。
  if (overlayBusy()) abortOverlayPlayback(true);
  const r = onTypingBeat(app.typing.machine, Date.now(), app.typing.cfg);
  app.typing.machine = r.s;
  applyBody(app.typeBodies[r.frame]);
  armTypingIdle(r.idleInMs);
}

/** 停手倒计时：每一拍都重排（先 clearTimeout 再排，幂等重排红线与动画心跳同一条）。 */
function armTypingIdle(ms) {
  if (app.typing.timer) clearTimeout(app.typing.timer);
  app.typing.timer = setTimeout(typingIdleCheck, Math.max(16, Math.round(ms)));
}

function typingIdleCheck() {
  app.typing.timer = 0;
  const r = onTypingIdleCheck(app.typing.machine, Date.now());
  app.typing.machine = r.s;
  if (r.frame === TYPING_IDLE) { applyBody(app.mainBody); return; } // 停手 → 回主图
  armTypingIdle(r.waitMs); // 判定前又来了节拍 → 按剩余时间再排一次
}

function stopTyping() {
  if (app.typing.timer) { clearTimeout(app.typing.timer); app.typing.timer = 0; }
  app.typing.machine = createTypingMachine();
  // 停手判定被打断时（隐藏/换宠/退出）不许把人留在抬手帧上
  if (app.mainBody && app.pet && app.typeBodies.indexOf(app.pet) >= 0) applyBody(app.mainBody);
}

/** 当前显示第几张打字图（-1 = 没在打字，显示主图）。 */
function typingFrameIndex() {
  if (!app.pet) return TYPING_IDLE;
  const i = app.typeBodies.indexOf(app.pet);
  return i >= 0 ? i : TYPING_IDLE;
}

/* ================= 自动动画调度（一条心跳；原「眨眼」+「随机特效」两条合并） =========
 * 每 6~7 秒到点一次 → 先按 chance 掷一次（不中就什么也不做，等下一次）→ 命中后随机挑一组
 * 整帧序列播完。掷概率/选组/区间计算都在 shared/autoAnim.js 的纯函数里，由单测锁死。
 * 被占用就跳过本轮、顺延，绝不排队堆积。 */

/** q 弹弹簧是否已收敛回原尺寸。叠加层现在吃的是**同一个** scale（setScale 两边一起写），
 *  这条闸门保留是为了别在明显形变（>1%）中途换图 —— 那会让新图跟着一起扭，读作跳形
 *  （摸头/落地后最容易撞上）。 */
function springSettled() {
  const s = app.anim.spr;
  return Math.abs(s.x.s - 1) <= 0.01 && Math.abs(s.y.s - 1) <= 0.01;
}

function canStartOverlay() {
  // 休息（睡觉时透明度正弦闪烁）期间不起播：动画帧是整幅不透明的"换一具身体"，
  // 会把睡颜的半透明顶掉一瞬（视觉上=睡着的人突然闪一下又不透明了）。
  return !!app.pet && !app.paused && !overlayBusy() &&
    !(app.rest && app.rest.active) &&
    !app.dragging && !app.phys && !app.gtr.isInteracting &&
    !isTypingNow() &&          // 打字中不播动画：打字优先占住显示
    springSettled();
}

function animRng() { return app.autoAnim.rng || Math.random; }

/** 排下一次"到点"。enabled 闸：测试模式默认不自动跑（否则断言时机不可控），
 *  且重复调用幂等 —— abortOverlayPlayback 会调它，不能因为一次拖动就把该关着的心跳打开。 */
function armAnimTry() {
  if (!app.autoAnim.enabled) return;
  if (app.autoAnim.timer) clearTimeout(app.autoAnim.timer);
  app.autoAnim.timer = setTimeout(animTry, nextDelayMs(app.autoAnim.cfg, animRng()));
}

/** 到点：先掷 chance，再看是不是真有空；任一不满足都只顺延，不计失败。 */
function animTry() {
  app.autoAnim.timer = 0;
  const cfg = app.autoAnim.cfg;
  if (!shouldAnimate(cfg, animRng()) || !canStartOverlay()) { armAnimTry(); return; }
  const gi = pickGroupIndex(cfg, animRng());
  const group = gi >= 0 && cfg.groups[gi] ? cfg.groups[gi] : null;
  if (!group) { armAnimTry(); return; }
  app.autoAnim.playing = true;
  playOverlayFrames(group.frames, () => {
    app.autoAnim.playing = false;
    armAnimTry(); // 播完 → 排下一次到点
  });
}

/** 手动起播一组（测试钩子与"立刻演示一次"用）：占用中一律拒绝并返回 false。 */
function playAnimGroup(index) {
  const groups = app.autoAnim.cfg.groups;
  if (!groups.length) return false;
  const gi = Number.isFinite(Number(index))
    ? Math.min(groups.length - 1, Math.max(0, Math.floor(Number(index)))) : 0;
  if (!app.pet || overlayBusy() || isTypingNow()) return false;
  app.autoAnim.playing = true;
  playOverlayFrames(groups[gi].frames, () => {
    app.autoAnim.playing = false;
    armAnimTry();
  });
  return true;
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
  // settleSpring：偏离只剩千分位时吸附回**精确**的 1 —— 否则每帧还在往 CSS 里写
  // scale(1, 1.0001) 这种值，浏览器就每帧把整张图重新光栅化一次（肉眼看到的"弹完之后闪+抖"，
  // 根因与实测数字见 motion.settleSpring 的注释）。
  A.spr.x = settleSpring(integrateSpring(A.spr.x, dt, P), P);
  A.spr.y = settleSpring(integrateSpring(A.spr.y, dt, P), P);
  // 待机不做任何缩放（原"呼吸波"已删除）：只有 q 弹（摸头/喂食/落地）会让形状短暂变形
  setScale(A.spr.x.s, A.spr.y.s);
  updateRing(dt);
}

/* ================= 物理（抛掷/坠落；吸附 Phase 3 接入） ================= */

/** 碰撞盒底边相对 pos 的偏移（不透明像素的下缘）：落地/贴地判定全以它为准。 */
function colBottomOff(p) { return p.col.oy + p.col.h; }

function physState() {
  return {
    x: app.pet.pos.x, y: app.pet.pos.y, vx: 0, vy: 0, grounded: false,
    w: app.pet.w, h: app.pet.h, col: { ...app.pet.col },
  };
}

function startPhys(vel) {
  abortOverlayPlayback(); // 抛掷/坠落接管身体：停掉眨眼/特效叠加帧
  const s = physState();
  s.vx = vel.vx; s.vy = vel.vy;
  app.phys = { s, prev: { grounded: false }, bounceCount: 0 };
}

function stopPhys() { app.phys = null; }

function tickPhysics(dt) {
  if (!app.pet || !app.phys) return;
  const w = { w: app.worldW, h: app.worldH };
  const res = physicsStep(app.phys.s, dt, w);
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
  // 已静止 & 实体像素贴地（碰撞盒底边触地）-> 结束物理，回待机
  if (physicsAtRest(res.s) && res.s.y >= app.worldH - colBottomOff(app.pet) - 0.5) stopPhys();
}

/** 释放后的路由：甩动 -> 抛掷；低速 -> 从当前位置坠落。 */
function routeRelease(rel) {
  emit('drag'); // 拖动结束仍计一次主动互动（保留原行为）
  if (app.locked || !app.pet) return;
  const thrown = rel.speed >= CFG.physics.throwSpeedThreshold;
  // 宠物本就在地面休息（碰撞盒贴地）-> 不重新启动物理（避免原地小跳）
  const onFloor = app.pet.pos.y >= app.worldH - colBottomOff(app.pet) - 1;
  if (onFloor && !thrown) return;

  // 物理完全禁用：甩出与低速释放都停在松手位置（无重力、不下坠）
  if (!app.physicsEnabled) return;
  if (thrown) { startPhys({ vx: rel.vx, vy: rel.vy }); return; }
  // 低速释放：轻轻滑落/下坠
  startPhys({ vx: rel.vx * 0.25, vy: 0 });
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
      abortOverlayPlayback(); // 拖动接管：停掉眨眼/特效叠加帧，放弃挂起的特效本轮
      app.phys = null; // 抓取瞬间终止飞行
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

function bindIpc() {
  ipcRenderer.on('cursor:pos', (e, p) => {
    app.cursor = p; app.cursorKnown = true;
    // 命中判定与 rAF 解耦兜底：光标是主进程 IPC 推送（不受页面节流/遮挡停转影响），
    // 收到即驱动一次穿透判定（手册 #12：悬停响应不能只挂在会被系统节流的循环上）。
    syncHitTest();
  });
  ipcRenderer.on('lock:change', (_e, { locked }) => { app.locked = locked; app.ignoreSent = null; syncHitTest(); });
  ipcRenderer.on('app:visibility', (_e, { visible }) => onVisibility(visible));
  ipcRenderer.on('region:changed', (_e, { regionScreen }) => applyRegion(regionScreen));
  ipcRenderer.on('ui:openRegionEditor', () => openRegionEditor());
  ipcRenderer.on('ui:openPicker', (_e, { kind }) => openPetPicker(kind));
  // 打字：主进程键盘探针每命中一个文本键推一拍 → 在两张打字图之间交替（逻辑见 shared/typing.js）
  ipcRenderer.on('typing:beat', () => onTypingBeatReceived());
  // ---- 气泡类：启动问候之外的待办提醒 / 随机催促 / 聊天回复 ----
  ipcRenderer.on('bubble:todo', (_e, { text, ms }) => showBubble(text, ms));
  ipcRenderer.on('bubble:reminder', (_e, { text, ms }) => showBubble(text, ms));
  ipcRenderer.on('bubble:chat', (_e, { text, ms }) => showBubble(text, ms));
  // 番茄钟完成一个专注 → 桌宠回体力/情绪（数值夹取与持久化走同一套）
  ipcRenderer.on('pet:reward', (_e, patch) => rewardPet(patch));
  // ---- 语音（识别在独立隐藏进程；这里只做视觉反馈与 BGM 闪避）----
  ipcRenderer.on('voice:state', (_e, p) => {
    setVoiceState({ state: (p && p.state) || 'idle', rms: (p && p.rms) || 0, partial: '' });
  });
  ipcRenderer.on('voice:partial', (_e, p) => setVoiceState({ partial: (p && p.text) || '' }));
  ipcRenderer.on('audio:duck', (_e, p) => duckAudio(!!(p && p.on)));
  // 原生右键菜单关闭后：清掉可能残留的按键/手势态（修复“菜单选完人物被吸到鼠标”）
  ipcRenderer.on('menu:closed', () => cleanupMenuGesture());
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
  ipcRenderer.on('bg:opacity', (_e, { opacity }) => setBgOpacity(opacity));
  ipcRenderer.on('bg:clear', () => setBgPath(null)); // “清除背景”真正把当前显示的背景清掉
  ipcRenderer.on('audio:list', (_e, { playlist }) => setPlaylist(playlist));
  ipcRenderer.on('audio:toggle', () => audioToggle());
  ipcRenderer.on('audio:next', () => audioNext());
  ipcRenderer.on('audio:prev', () => audioPrev());
  ipcRenderer.on('audio:stop', () => audioStop());
}

function onVisibility(visible) {
  app.visible = visible;
  app.paused = !visible;
  if (visible) {
    startStatusTimers();
    if (app.status) { // 隐藏期间：默认**冻结**（不挨饿），见 config.status.decayWhileAway
      app.status = resumeAfterAway(app.status, Date.now());
      applyStatusVisual();
      refreshPill();
      persistStatus(true);
    }
  } else {
    stopStatusTimers();
    abortOverlayPlayback(); // 隐藏：停掉叠加帧与挂起的特效（恢复显示后由调度器重新再试）
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

// ---------- 状态系统（每秒结算 + 归零半透明 + 好感度） ----------
// "不在你面前"的时段默认**冻结**（不结算），见 config.status.decayWhileAway 与 status.js freezeStatus()。

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
  // 透明度作用于整个宠物容器：主图/状态图两种形态统一生效（叠加帧播放期间暂停变化）
  applyPetOpacity();
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
  if (app.pet && !overlayBusy()) petWrap.style.opacity = String(minOp);
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
  applyPetOpacity(); // 叠加帧播放中内部会跳过写入（透明度变化暂停，播完恢复）
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

/**
 * 番茄钟等"外部奖励"入口：给情绪/体力/好感度加增量（各夹到自身上限），走与互动同一套
 * 视觉刷新 + 持久化。负值也可（将来做"熬夜扣体力"）。
 * 好感度（2026-09-17 起番茄钟奖励走这里）：跨过里程碑档位（每 20 点）会触发爱心上浮，
 * 与互动掷好感共用同一套动画（否则"好感涨了没反馈"）。
 */
function rewardPet(patch) {
  if (!app.status || !patch) return;
  const next = { ...app.status };
  if (Number.isFinite(patch.energy)) next.energy = clamp(next.energy + patch.energy, 0, 100);
  if (Number.isFinite(patch.mood)) next.mood = clamp(next.mood + patch.mood, 0, 100);
  let levels = [];
  if (Number.isFinite(patch.affinity) && patch.affinity !== 0) {
    const before = Number(next.affinity) || 0;
    const after = clamp(before + patch.affinity, 0, CFG.status.affinityCap);
    next.affinity = after;
    levels = statusM.crossedMilestone(before, after);
  }
  next.lastTs = Date.now();
  app.status = next;
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
  // 宠物未在拖动/飞行时顺带记住位置
  if (app.pet && !app.dragging && !app.phys) {
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
  // 只有人物“站在地面”（碰撞盒贴地）才更新背景的水平中心；空中保持上一次（人物落地后重新对齐）
  const grounded = p && p.pos.y >= app.worldH - colBottomOff(p) - 1.5;
  if (p && grounded) app.bgCX = p.pos.x + p.col.ox + p.col.w / 2;
  else if (app.bgCX == null) app.bgCX = p ? p.pos.x + p.col.ox + p.col.w / 2 : app.worldW / 2;
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
  // 音量固定用 config 默认（CFG.audio.volumeDefault），无音量 UI/持久化。
  app.audio.playlist = (s.playlist || []).filter((t) => t && t.path);
  app.audio.index = app.audio.playlist.length ? 0 : -1;
  initStatus(s.status);
  startStatusTimers();
  app.bus.add(onStatusInteract);
}

function initStatus(saved) {
  const now = Date.now();
  // 启动时同样**不结算离线时长**（默认冻结）：关掉电脑过一夜，第二天打开不该看到一只
  // 情绪/饱食被算到 0 的宠物（用户 2026-09-16 反馈"别让桌宠在后台挨饿"）。
  // 想恢复旧行为（离线也流逝）把 config.status.decayWhileAway 设为 true。
  app.status = resumeAfterAway(normStatusSnap(saved, now), now);
  app._lastStatusPersist = now;
  applyStatusVisual();
  refreshPill();
  persistStatus(true);
}

/** 桌宠"重新出现在你面前"时怎么处理那段时间：默认冻结（抹掉），可选按旧行为结算。 */
function resumeAfterAway(snapshot, now) {
  return CFG.status.decayWhileAway
    ? statusM.settleStatus(snapshot, now)
    : statusM.freezeStatus(snapshot, now);
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
    pet: p ? { w: p.w, h: p.h, x: p.pos.x, y: p.pos.y, anchor: { ...p.anchor }, col: { ...p.col } } : null,
    animScale: p ? { sx: app.anim.spr.x.s, sy: app.anim.spr.y.s } : null, // 弹簧即最终缩放（无呼吸叠加）
    // 吸附 / 抛掷 状态快照
    phys: app.phys ? {
      x: app.phys.s.x, y: app.phys.s.y, vx: app.phys.s.vx, vy: app.phys.s.vy,
      grounded: app.phys.s.grounded,
    } : null,
    physicsEnabled: app.physicsEnabled,
    rest: app.rest ? { ...app.rest } : null,
    pillCollapsed: pillEl.classList.contains('collapsed'),
    cursor: { ...app.cursor, known: app.cursorKnown },
    // Phase 4
    status: app.status ? { ...app.status } : null,
    derived: v,
    greetings: CFG.greeting.greetings || [],
    bubbleVisible: !!(bubbleEl && bubbleEl.classList.contains('show')),
    // 自动动画（原 blinkAnim / blinkPlaying / fxAnim 三个快照字段合并而来）
    autoAnim: {
      groups: app.autoAnim.cfg.groups.length,
      chance: app.autoAnim.cfg.chance,
      frameMs: app.autoAnim.cfg.frameMs,
      intervalMs: [app.autoAnim.cfg.minIntervalMs, app.autoAnim.cfg.maxIntervalMs],
      playing: app.autoAnim.playing,
      visible: app.autoAnim.visible,
      armed: !!app.autoAnim.timer,   // 心跳是否已排（测试要能区分"没到点"与"没在排"）
      enabled: !!app.autoAnim.enabled,
    },
    // 打字：两帧到位情况 + 帧机当前状态（frame=-1 表示没在打字，正显示主图）
    typingReady: { frames: app.typeBodies.length },
    typingFrame: typingFrameIndex(),
    typingMachine: { ...app.typing.machine },
    typingCfg: { ...app.typing.cfg },
    bodyKind: bodyKindOf(app.pet), // 当前活动身体
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
    voice: { ...voiceState },
    voiceIndicatorOn: !!(voiceEl && voiceEl.classList.contains('on')),
    audio: {
      hasEl: !!app.audio.el, playing: !!app.audio.playing, index: app.audio.index,
      paused: !!(app.audio.el && app.audio.el.paused), playlistCount: app.audio.playlist.length,
      volume: app.audio.volume,
    },
  };
}

/** 任意素材路径 → 解码成一具身体。
 *  "../" 开头 = 相对渲染层目录（src/renderer/）的内置素材（含 ../../动画素材/…），直读文件；
 *  其余相对 data/ 或绝对路径，经主进程 asset:readImage（含 ICC 剥离）读取。 */
async function decodeImageAnyPath(p) {
  if (typeof p === 'string' && p.startsWith('../')) {
    return decodeImageSrc(p, CFG.image.petMaxDim);
  }
  const img = await ipcRenderer.invoke('asset:readImage', p);
  if (!img) throw new Error('图片读取失败');
  return decodeImageDataUrl(img.dataUrl, CFG.image.petMaxDim);
}

/** 启动时按 config.js 载入"可定制值"。
 *  原来这里解三批（多帧眨眼 / 特效组 / 降级单图眨眼），合并成自动动画之后只剩一批。 */
async function initCustomConfig() {
  await loadAnimGroups();
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

  // 读取折叠状态 + 物理开关（托盘可关）
  if (initInfo.settings && initInfo.settings.pillCollapsed) pillEl.classList.add('collapsed');
  app.physicsEnabled = !(initInfo.settings && initInfo.settings.physicsEnabled === false);
  phase4Init(initInfo.settings, initInfo.workArea);
  updateUiRects();
  await initCustomConfig(); // 自动动画的帧组要在 loadPet 之前就位（解码失败要能安静降级）

  // 宠物主图路径由主进程统一解析（素材根目录 pet.png > settings 旧值 > 内置主图）
  const petPath = initInfo.petPath;
  if (petPath) {
    const img = await ipcRenderer.invoke('asset:readImage', petPath);
    if (img) await loadPet(img.dataUrl);
    else { hintEl.style.display = 'block'; } // 读取失败是 #hint 的唯一用途（显示错误信息）
  } else {
    hintEl.style.display = 'block';
  }
  void loadTypingBodies(); // 预载打字两帧；缺帧则打字时保持主图，不影响其它功能
  refreshPill();

  app.ready = true;
  window.__petReady = true;
  window.__pet = app;
  // 动画心跳只在真实运行时自动起：6~7 秒 + 80% 概率的随机时机放进 UI 断言里不可控。
  // 测试要验"自动触发"这条路径，用 __petTest.setAutoAnimHeartbeat(true) + 注入随机源，
  // 而不是靠等 —— 这也是旧实现里"特效不在测试模式自动跑"的同一条选择。
  if (!app.testMode) {
    app.autoAnim.enabled = true;
    armAnimTry();
  }
  setTimeout(() => {
    const list = CFG.greeting.greetings || [];
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
      // —— 自动动画驱动（测试/调试）——
      // 注入组帧覆盖现有组：测试用纯色 dataURL（没有位图/col → showFrameBody 走退化分支）
      setAnimGroups(groups) {
        const gs = (Array.isArray(groups) ? groups : [])
          .map((g) => ({
            name: String((g && g.name) || '动画'),
            frames: (g && Array.isArray(g.frames) ? g.frames : [])
              .filter((f) => f && f.src)
              .map((f) => ({ src: f.src, durationMs: clamp(Number(f.durationMs) || app.autoAnim.cfg.frameMs, 30, 5000) })),
          }))
          .filter((g) => g.frames.length);
        app.autoAnim.cfg = { ...app.autoAnim.cfg, groups: gs };
        return gs.length;
      },
      // 改调度参数（区间/概率）：UI 场景用它把"6~7 秒一次"压成几百毫秒，
      // 同时把概率设成 0 或 1，让"到点该不该播"变成可精确断言的事。
      setAnimCfg(patch) {
        const p = patch && typeof patch === 'object' ? patch : {};
        const c = app.autoAnim.cfg;
        const next = { ...c };
        if (Number.isFinite(Number(p.minIntervalMs))) next.minIntervalMs = Number(p.minIntervalMs);
        if (Number.isFinite(Number(p.maxIntervalMs))) next.maxIntervalMs = Number(p.maxIntervalMs);
        if (Number.isFinite(Number(p.chance))) next.chance = Math.min(1, Math.max(0, Number(p.chance)));
        if (Number.isFinite(Number(p.frameMs))) next.frameMs = Number(p.frameMs);
        if (next.maxIntervalMs < next.minIntervalMs) next.maxIntervalMs = next.minIntervalMs;
        app.autoAnim.cfg = next;
        return { chance: next.chance, minIntervalMs: next.minIntervalMs, maxIntervalMs: next.maxIntervalMs };
      },
      // 心跳开关（含 enabled 总闸）：先关掉做精确断言，再打开验"自动到点"这条路径
      setAutoAnimHeartbeat(on) {
        app.autoAnim.enabled = !!on;
        if (on) armAnimTry();
        else if (app.autoAnim.timer) { clearTimeout(app.autoAnim.timer); app.autoAnim.timer = 0; }
        return !!app.autoAnim.timer;
      },
      // 注入随机源，把"掷概率 + 选组 + 区间"变成可复现序列；传空恢复 Math.random
      setAnimRng(seq) {
        if (Array.isArray(seq) && seq.length) {
          let i = 0;
          app.autoAnim.rng = () => seq[i++ % seq.length];
        } else app.autoAnim.rng = null;
      },
      // 立刻播第 index 组（跳过 6~7 秒与掷概率；忙/正在打字/无组 → false）
      playAnim(index = 0) { return playAnimGroup(index); },
      // 走一次完整"到点"判定（含 chance 与占用检查），用来验"该不该播"
      animTickOnce() { animTry(); return { playing: app.autoAnim.playing, armed: !!app.autoAnim.timer }; },
      // 打字驱动入口：注入一次"打字节拍"（等价于主进程探针上报，UI 场景不必真敲键盘，
      // 也不会读到机器上真人正在打的字）；返回值 = 当前第几张打字图（-1=主图，没在打字）。
      typingBeat() { onTypingBeatReceived(); return typingFrameIndex(); },
      // 把停手倒计时改短（UI 场景用它验"停手回第三张图"，不必死等 config 的 1s）
      setTypingIdleMs(ms) {
        app.typing.cfg = { ...app.typing.cfg, idleMs: clamp(Math.round(ms), 200, 30000) };
        return app.typing.cfg.idleMs;
      },
      showBubble: (text, ms) => showBubble(text, ms),
      hideBubble: () => hideBubble(),
      forcePhys(vx, vy) { startPhys({ vx, vy }); },
      animState() { return { sx: app.anim.spr.x.s, sy: app.anim.spr.y.s, ring: app.anim.ringVisible }; },
      drag(dx, dy) { if (app.pet) { app.pet.pos.x += dx; app.pet.pos.y += dy; clampPetIntoWorld(app.pet); syncPlacement(); } },
      // 拖放定位钩子（抛掷/背景等场景用）
      placePet(x, y) { if (app.pet) { app.pet.pos.x = x; app.pet.pos.y = y; syncPlacement(); } },
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
          petCX: p ? p.pos.x + p.col.ox + p.col.w / 2 : null, // 脚底中点 = 碰撞盒中心（与 layoutBg 同一语义）
          petGround: p ? p.pos.y >= app.worldH - colBottomOff(p) - 1.5 : false,
          worldH: app.worldH,
        };
      },
    };
  }
  app.raf = requestAnimationFrame(frame);
}

init().catch((e) => { console.error('[app] init 失败', e); });
