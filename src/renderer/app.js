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
  GestureTracker, springParams, integrateSpring, impulse,
  step: physicsStep, atRest: physicsAtRest, chooseSnapTarget, shouldDetach, normCol,
} = require('../shared/motion');
const { normalizeBlinkFrames, shouldPlayBlinkAnim } = require('../shared/blink');
const statusM = require('../shared/status');
const { normalizeVisualMode, nextVisualMode, VISUAL_MODES } = statusM;
const {
  TYPING_IDLE, typingCfg, createTypingMachine, onTypingBeat, onTypingIdleCheck,
} = require('../shared/typing');

const $ = (id) => document.getElementById(id);
const worldEl = $('world'), petWrap = $('petWrap'), petEl = $('pet');
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
  blink: { visible: false, endTimer: null, playing: false, timer: 0 }, // timer = 下一次眨眼心跳
  blinkBody: null, // 降级单图眨眼的“帧身体”（src/assets/blink.png 解码；null = 不可用）
  stateVisual: { mode: 'main' },  // 当前形态：main=主形象，state=状态形象，type=打字状态（三张图）
  mainBody: null,      // 主形象"身体"：解码位图/锚点/尺寸（当前 app.pet 指向活动身体）
  stateBody: null,     // 状态形象"身体"（预载 src/assets/state.png 或 config 覆盖；null = 切换不可用）
  // ---- 打字状态（形态三：config.typing 的三张图 + 探针节拍） ----
  typeBodies: [],      // 打字两帧身体（[0]=图1、[1]=图2，每按一下键盘交替一次）；不足 2 = 该形态不可用
  typeIdleBody: null,  // "不打字"图（图3）身体：进入形态三的默认显示，也是停手 idleMs 后的显示
  typing: {            // 帧机状态见 shared/typing.js（纯函数，单测锁死行为线）
    machine: createTypingMachine(),
    timer: 0,          // 停手判定定时器（到点跑 onTypingIdleCheck）
    cfg: typingCfg(),  // { idleMs, minFlipMs }
  },
  // ---- 随机特效动画（config.js effectAnim.groups：动画1/动画2 等，整帧替换的随机小动画） ----
  effectFx: {
    groups: [],     // [{ name, frames: [帧身体+durationMs] }]；frames 空 = 功能关闭
    timer: null,    // 15~25s 随机“再试”定时器
    playing: false,
    rng: null,      // 组选择随机源（测试可注入）；null = Math.random
  },
  // ---- 可定制值（config.js 驱动，initCustomConfig 启动时载入） ----
  blinkAnim: { frames: [], probability: 1 },  // 多帧眨眼动画（帧身体数组）；frames 空 = 降级旧 blink.png
  stateImagePath: null,                       // 状态图覆盖路径（相对 data/ 或绝对）；null = 内置
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
 *  像素级碰撞盒）。主形象/状态形象/眨眼帧/特效帧都走这条管线；body.bitmap 是该形态
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
  // 载入主形象 = 回到主形态（换宠后吸附/抛掷状态复位；打字帧机一并复位）
  app.stateVisual.mode = 'main';
  stopTyping();
  app.phys = null;
  app.dragging = false;
  app.snap = null; ensureSnapPollStop();
  syncPlacement();
  return true;
}

/** 把"身体"显示到本体 <img> 上：显示尺寸 = 身体尺寸，缩放原点 = 该身体的锚点。
 *  原图直通（body.src），浏览器按显示尺寸高质量光栅化 —— 与特效帧同一条管线，无发糊。 */
function drawBody(body) {
  petEl.src = body.src;
  petEl.style.width = body.w + 'px';
  petEl.style.height = body.h + 'px';
  petWrap.style.width = body.w + 'px';
  petWrap.style.height = body.h + 'px';
  petEl.style.transformOrigin = `${body.anchor.x}px ${body.anchor.y}px`;
}

/**
 * 预载状态形象（第二具身体）：内置 src/assets/state.png 或配置覆盖路径。
 * 失败 → 状态切换不可用（保持主形态）；只在控制台 warn（不进错误计数）。
 */
async function loadStateBody() {
  try {
    app.stateBody = await decodeImageAnyPath(app.stateImagePath || '../assets/state.png');
  } catch (e) {
    app.stateBody = null;
    if (app.stateVisual.mode === 'state') setVisualMode('main'); // 正显示它却加载失败 → 退回主形态
    console.warn('[pet] 状态形象加载失败（切换状态将不可用）', e && e.message ? e.message : e);
  }
}

/**
 * 预载打字状态的三具身体（config.typing：两张打字帧 + 一张"不打字"图）。
 * 半组残缺比没有更难看（连打时会闪缺一帧），所以任一帧失败就整组作废；
 * 作废后 visualAvailable('type')=false → 菜单选了也回主形态，并在控制台说明原因。
 */
async function loadTypingBodies() {
  const paths = (CFG.typing && CFG.typing.frames) || [];
  const bodies = [];
  for (const p of paths) {
    try { bodies.push(await decodeImageAnyPath(p)); } catch (e) {
      console.warn('[pet] 打字帧加载失败（打字状态不可用）', p, e && e.message ? e.message : e);
      bodies.length = 0;
      break;
    }
  }
  app.typeBodies = bodies.slice(0, 2);
  try {
    app.typeIdleBody = await decodeImageAnyPath(CFG.typing.idleFrame);
  } catch (e) {
    app.typeIdleBody = null;
    console.warn('[pet] "不打字"图加载失败（打字状态不可用）', e && e.message ? e.message : e);
  }
  if (app.stateVisual.mode === 'type' && !visualAvailable('type')) setVisualMode('main');
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
  const c = petEl.style;
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

function setBlinkVisible(v) {
  // 眨眼/特效帧属于”主宠物形象”：其它形态（状态图 / 打字状态）下不显示
  if (v && app.stateVisual.mode !== 'main') v = false;
  app.blink.visible = !!v;
  if (blinkEl) blinkEl.style.display = app.blink.visible ? 'block' : 'none';
}

/* ================= 叠加帧（眨眼 / 随机特效动画：整帧“接管”本体显示） =================
 * 帧素材是“包含完整宠物的整图” → 从第一帧起隐藏本体、播完恢复（防双影）。
 * 红线不受影响：判定/物理始终用 app.pet 的真实身体位图，叠加只是显示层。
 * 叠加层自身不做缩放：待机不再有呼吸形变，图层切换两侧都是原始尺度（q 弹进行中由
 * canStartOverlay 挡掉，不会出现"本体被压扁、换上的帧却是圆的"）。 */

/** 显示一帧：帧与本体按“碰撞盒底边中点”对齐（脚底原地不动）。
 *  注入的测试帧（只有 src/durationMs）回退为铺满本体（兼容旧拉伸显示）。 */
function showFrameBody(fb) {
  const p = app.pet;
  if (!p) return;
  const fw = fb.w || p.w, fh = fb.h || p.h;
  const fcol = fb.col || { ox: 0, oy: 0, w: fw, h: fh };
  const bx = p.col.ox + p.col.w / 2, by = p.col.oy + p.col.h;
  const fx = fcol.ox + fcol.w / 2, fy = fcol.oy + fcol.h;
  blinkEl.style.left = `${bx - fx}px`;
  blinkEl.style.top = `${by - fy}px`;
  blinkEl.style.width = `${fw}px`;
  blinkEl.style.height = `${fh}px`;
  blinkEl.src = fb.src;
}

function overlayBusy() { return app.blink.playing || app.effectFx.playing; }

/** 播放期间暂停透明度变化（休息闪烁/归零半透明都走这里）；播完由 finish 恢复。 */
function applyPetOpacity() {
  if (!app.pet || overlayBusy()) return;
  petWrap.style.opacity = petOpacityNow();
}

/** 立即停止叠加帧播放，恢复本体显示（拖动/切形态/隐藏/抛掷时调用）。
 *  特效调度器无条件重排：上面刚 clearTimeout 过，不补排就等于一次打断把特效永久掐断。 */
function abortOverlayPlayback() {
  if (app.blink.endTimer) { clearTimeout(app.blink.endTimer); app.blink.endTimer = null; }
  if (app.effectFx.timer) { clearTimeout(app.effectFx.timer); app.effectFx.timer = null; }
  const wasPlaying = overlayBusy();
  app.blink.playing = false;
  app.effectFx.playing = false;
  setBlinkVisible(false);
  if (app.pet) petEl.style.display = '';
  if (wasPlaying) applyPetOpacity();
  scheduleEffectTry();
}

/** 依次播放叠加帧（每帧显示各自 durationMs，播完恢复本体）。
 *  每帧开始前重新检查：宠物在/主形态/未隐藏/未拖动 —— 异常即终止。 */
function playOverlayFrames(frames, done) {
  let i = 0;
  const step = () => {
    app.blink.endTimer = null;
    if (!app.pet || app.stateVisual.mode !== 'main' || app.paused || app.dragging || i >= frames.length) {
      finishOverlayPlayback();
      if (done) done();
      return;
    }
    showFrameBody(frames[i]);
    petEl.style.display = 'none'; // 帧是完整整图：从第一帧起隐藏本体（防双影）
    setBlinkVisible(true);
    app.blink.endTimer = setTimeout(step, frames[i].durationMs);
    i += 1;
  };
  step();
}

function finishOverlayPlayback() {
  if (app.blink.endTimer) { clearTimeout(app.blink.endTimer); app.blink.endTimer = null; }
  setBlinkVisible(false);
  if (app.pet) petEl.style.display = '';
  applyPetOpacity(); // 播放中暂停的透明度变化，播完恢复
}

/* ================= 视觉形态（三态：主宠物图 / 状态图 / 打字状态） =================
 * 切换形态 = 换一具身体：每种形态都是完整解码的"身体"（各自位图/锚点/尺寸），app.pet 指向
 * 当前身体 → 像素判定/拖动/抛掷/吸附/背景跟随/气泡爱心定位等全部作用于它。
 * 换身体保持"底边中点"位置连续（原地换装；吸附中切换仍挂原窗口顶沿）。
 * 目标形态的身体没加载成功 → 一律退回主形态并如实回报勾选态（不"选了却没反应"）。 */

/** 形态 → 默认展示的身体（打字形态的默认是第三张图：不打字）。 */
function visualBody(mode) {
  if (mode === 'state') return app.stateBody;
  if (mode === 'type') return app.typeIdleBody;
  return app.mainBody;
}

/** 形态可用性：主形态总可用；状态形态要状态图；打字形态要两张打字帧 + 一张不打字图。 */
function visualAvailable(mode) {
  if (mode === 'state') return !!app.stateBody;
  if (mode === 'type') return app.typeBodies.length === 2 && !!app.typeIdleBody;
  return true;
}

/** 当前活动身体是哪一具（诊断 / 测试快照）。 */
function bodyKindOf(b) {
  if (!b) return null;
  if (b === app.mainBody) return 'main';
  if (b === app.stateBody) return 'state';
  if (b === app.typeIdleBody) return 'typeIdle';
  const i = app.typeBodies.indexOf(b);
  return i >= 0 ? `type${i + 1}` : 'unknown';
}

/** 把当前身体换成 next：底边中点连续（同尺寸就是纯换图）。
 *  切形态与打字帧交替共用这一条路径。 */
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

/** 回报主进程当前形态（菜单单选项勾选态依据 + 决定打字探针启停）。 */
function syncVisualMode() {
  ipcRenderer.send('state:visualSync', { mode: app.stateVisual.mode });
}

function setVisualMode(mode) {
  let want = normalizeVisualMode(mode);
  if (!visualAvailable(want)) want = 'main';
  if (want === app.stateVisual.mode && app.pet === visualBody(want)) { syncVisualMode(); return; }
  abortOverlayPlayback(); // 叠加帧属于主形象：切形态前停掉眨眼/特效并恢复本体
  stopTyping();           // 进/出打字态都要复位帧机与停手定时器
  if (!applyBody(visualBody(want))) { syncVisualMode(); return; }
  app.stateVisual.mode = want;
  petEl.style.transform = ''; // 清掉旧身体的缩放形变（弹簧下一帧按新身体重算）
  if (want !== 'main') setBlinkVisible(false); // 闭眼图属于主形象：其它形态不眨眼
  syncVisualMode();
}

/** 轮换到下一个可用形态（菜单是直达项，这条给测试钩子/循环用）。 */
function toggleVisualMode() {
  let m = app.stateVisual.mode;
  for (let i = 0; i < VISUAL_MODES.length; i++) {
    m = nextVisualMode(m);
    if (visualAvailable(m)) break;
  }
  setVisualMode(m);
  return app.stateVisual.mode;
}

/* ================= 打字状态（形态三）：每按一下键盘换一帧，停手 idleMs 回第三张图 ==========
 * 节拍来源：主进程键盘探针 → typing:beat。交替/限幅/停手判定的纯逻辑在 shared/typing.js，
 * 行为线由单测锁死，不依赖真敲键盘。
 * 中文/英文一律同一套判定：只认"有没有文本键被按下"，不检测输入法候选窗（候选窗类名随
 * 输入法与版本而变，且"候选窗跟随光标"模式下根本没有独立窗口可查）。 */

function onTypingBeatReceived() {
  if (app.stateVisual.mode !== 'type' || !visualAvailable('type')) return;
  const r = onTypingBeat(app.typing.machine, Date.now(), app.typing.cfg);
  app.typing.machine = r.s;
  applyBody(app.typeBodies[r.frame]);
  armTypingIdle(r.idleInMs);
}

/** 停手倒计时：每一拍都重排（先 clearTimeout 再排，与特效调度器同一条"幂等重排"红线）。 */
function armTypingIdle(ms) {
  if (app.typing.timer) clearTimeout(app.typing.timer);
  app.typing.timer = setTimeout(typingIdleCheck, Math.max(16, Math.round(ms)));
}

function typingIdleCheck() {
  app.typing.timer = 0;
  if (app.stateVisual.mode !== 'type') return;
  const r = onTypingIdleCheck(app.typing.machine, Date.now());
  app.typing.machine = r.s;
  if (r.frame === TYPING_IDLE) { applyBody(app.typeIdleBody); return; }
  armTypingIdle(r.waitMs); // 判定前又来了节拍 → 按剩余时间再排一次
}

function stopTyping() {
  if (app.typing.timer) { clearTimeout(app.typing.timer); app.typing.timer = 0; }
  app.typing.machine = createTypingMachine();
}

/** 当前显示第几张打字图（-1 = 第三张"不打字"图）。 */
function typingFrameIndex() {
  if (app.stateVisual.mode !== 'type') return TYPING_IDLE;
  return app.pet === app.typeIdleBody ? TYPING_IDLE : app.typeBodies.indexOf(app.pet);
}

/* ================= 眨眼与随机特效动画（两条独立心跳，互斥：谁在播另一方就跳过） ==========
 * 触发不再依赖呼吸零点：眨眼 3~8s 随机一次、特效 15~25s 随机一次，到点直接播；
 * 被占用（拖动/飞行/手势/睡觉/切形态/隐藏/另一方在播）就顺延，不排队堆积。 */

function canStartOverlay() {
  // 休息（睡觉时透明度正弦闪烁）期间不起播：眨眼/特效帧是整幅不透明的"换一具身体"，
  // 会把睡颜的半透明顶掉一瞬（视觉上=睡着的人突然闪一下又不透明了）。
  return !!app.pet && app.stateVisual.mode === 'main' && !app.paused && !overlayBusy() &&
    !(app.rest && app.rest.active) &&
    !app.dragging && !app.phys && !app.gtr.isInteracting;
}

/** 眨眼的下一次心跳。 */
function scheduleBlink() {
  if (app.blink.timer) clearTimeout(app.blink.timer);
  app.blink.timer = 0;
  const min = CFG.blink.minIntervalMs, max = CFG.blink.maxIntervalMs;
  const delay = Math.max(0, min) + Math.random() * Math.max(0, max - min);
  app.blink.timer = setTimeout(() => { app.blink.timer = 0; tryBlink(); }, delay);
}

/** 心跳到点：能播就播一次眨眼，随后无条件排下一次（占用中就等于这次没眨，顺延）。 */
function tryBlink() {
  if (canStartOverlay()) {
    const multi = app.blinkAnim.frames.length > 0;
    const frames = multi ? app.blinkAnim.frames : (app.blinkBody ? [app.blinkBody] : []);
    // 多帧动画模式保留 blinkAnim.probability（这次要不要演一遍）；单图降级到点就眨
    if (frames.length && (!multi || shouldPlayBlinkAnim(app.blinkAnim.probability))) {
      app.blink.playing = true;
      playOverlayFrames(frames, () => { app.blink.playing = false; });
    }
  }
  scheduleBlink();
}

/** 随机特效动画：每次播完/跳过后在 min~max 间隔随机“再试”。 */
function scheduleEffectTry() {
  if (app.effectFx.timer) clearTimeout(app.effectFx.timer);
  app.effectFx.timer = null;
  if (!app.effectFx.groups.length) return;
  const min = CFG.effectAnim.minIntervalMs, max = CFG.effectAnim.maxIntervalMs;
  const delay = Math.max(0, min) + Math.random() * Math.max(0, max - min);
  app.effectFx.timer = setTimeout(() => { app.effectFx.timer = null; effectTry(); }, delay);
}

/** 到点“再试”：占用中直接顺延一轮，空闲就立刻起播（本体不做待机缩放，切换不跳）。 */
function effectTry() {
  if (!app.effectFx.groups.length) return;
  if (!canStartOverlay()) { scheduleEffectTry(); return; }
  startEffectPlayback();
}

function startEffectPlayback() {
  const groups = app.effectFx.groups;
  if (!groups.length || !app.pet) return;
  const rng = app.effectFx.rng || Math.random;
  const group = groups[Math.min(groups.length - 1, Math.floor(rng() * groups.length))];
  app.effectFx.playing = true;
  playOverlayFrames(group.frames, () => {
    app.effectFx.playing = false;
    scheduleEffectTry(); // 播完 → 排下一次随机再试
  });
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

/** 释放后的路由：甩动 -> 抛掷；低速 -> 尝试吸附到窗口顶沿，否则从当前位置坠落。 */
function routeRelease(rel) {
  emit('drag'); // 拖动结束仍计一次主动互动（保留原行为）
  if (app.locked || !app.pet) return;
  const thrown = rel.speed >= CFG.physics.throwSpeedThreshold;
  // 宠物本就在地面休息（碰撞盒贴地）-> 不重新启动物理（避免原地小跳）
  const onFloor = app.pet.pos.y >= app.worldH - colBottomOff(app.pet) - 1;
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
  // 碰撞盒底边贴窗口顶：contentY = (screenTop - originY) - 碰撞盒底边偏移，夹回区域顶。
  const contentTop = Math.max(0, target.top - app.worldOrigin.y);
  p.pos.y = contentTop - colBottomOff(p);
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
      abortOverlayPlayback(); // 拖动接管：停掉眨眼/特效叠加帧，放弃挂起的特效本轮
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
  ipcRenderer.on('state:visual', (_e, { mode }) => setVisualMode(mode));
  // 打字状态（形态三）：主进程键盘探针每命中一个文本键推一拍 → 换一帧（逻辑见 shared/typing.js）
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
    blinkPlaying: app.blink.playing,
    fxAnim: { groups: app.effectFx.groups.length, playing: app.effectFx.playing },
    visualMode: app.stateVisual.mode,
    stateBodyReady: !!app.stateBody,
    // 形态三：三张图的到位情况 + 帧机当前状态（frame=-1 表示正显示"不打字"那张）
    typingReady: { frames: app.typeBodies.length, idle: !!app.typeIdleBody },
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

/** 单帧路径 → 解码成"帧身体"（位图/锚点/碰撞盒 + 显示时长）。 */
async function decodeFramePath(p, durationMs) {
  return { ...(await decodeImageAnyPath(p)), durationMs };
}

/** 启动时按 config.js 载入"可定制值"（config.js 是唯一定制入口）：
 *  多帧眨眼帧 / 随机特效帧 → 解码成帧身体数组（单帧失败跳过，整组失败禁用该组）；
 *  状态切换图只存原始路径（loadStateBody 会按路径 asset:readImage）。 */
async function initCustomConfig() {
  const frames = [];
  for (const f of normalizeBlinkFrames(CFG.blinkAnim.frames)) {
    try { frames.push(await decodeFramePath(f.path, f.durationMs)); } catch { /* 单帧失败跳过 */ }
  }
  if (frames.length) {
    app.blinkAnim.frames = frames;
    const prob = Number(CFG.blinkAnim.probability);
    app.blinkAnim.probability = Number.isFinite(prob) ? clamp(prob, 0, 1) : 1;
  }
  app.stateImagePath = CFG.stateImage.path || null;
  // 随机特效动画组
  for (const g of (CFG.effectAnim.groups || [])) {
    if (!g || !Array.isArray(g.frames) || !g.frames.length) continue;
    const fm = Number(g.frameMs) > 0 ? Number(g.frameMs) : CFG.blinkAnim.defaultFrameMs;
    const bodies = [];
    for (const p of g.frames) {
      try { bodies.push(await decodeFramePath(p, fm)); } catch { break; } // 整组放弃（半组会显示残缺）
    }
    if (bodies.length === g.frames.length) app.effectFx.groups.push({ name: g.name || 'fx', frames: bodies });
  }
  // 降级单图眨眼（未配置多帧时使用；缺失只是不眨，不影响其它功能）。
  // 必须自带 durationMs（playOverlayFrames 按帧取时长，undefined 会让眨眼瞬间闪没）。
  try {
    app.blinkBody = { ...(await decodeImageSrc('../assets/blink.png', CFG.image.petMaxDim)), durationMs: CFG.blink.frameMs };
  } catch { app.blinkBody = null; }
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
  await initCustomConfig(); // 可定制值要在 loadPet/loadStateBody（状态身体路径）之前就位

  // 宠物主图路径由主进程统一解析（素材根目录 pet.png > settings 旧值 > 内置主图）
  const petPath = initInfo.petPath;
  if (petPath) {
    const img = await ipcRenderer.invoke('asset:readImage', petPath);
    if (img) await loadPet(img.dataUrl);
    else { hintEl.style.display = 'block'; } // 读取失败是 #hint 的唯一用途（显示错误信息）
  } else {
    hintEl.style.display = 'block';
  }
  void loadStateBody(); // 预载状态形象（第二具身体）；失败只是切换状态不可用，不影响主形象
  void loadTypingBodies(); // 预载形态三（打字两帧 + 不打字图）；失败则该形态自动不可用
  refreshPill();

  app.ready = true;
  window.__petReady = true;
  window.__pet = app;
  // 眨眼心跳照常起（UI 场景要能等到一次"没人调用"的自动眨眼）；特效仍只在真实运行时随机触发，
  // 测试里由 __petTest.playEffect() 手动驱动，免得整帧替换撞上别的场景断言。
  scheduleBlink();
  if (!app.testMode) scheduleEffectTry();
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
      forceBlink(visible) { setBlinkVisible(!!visible); },
      // 多帧眨眼动画驱动（测试/调试）：frames=[{src:dataUrl,durationMs}]，probability 0~1
      setBlinkAnim(frames, probability) {
        app.blinkAnim.frames = (Array.isArray(frames) ? frames : [])
          .filter((f) => f && f.src)
          .map((f) => ({ src: f.src, durationMs: clamp(Number(f.durationMs) || 150, 30, 5000) }));
        app.blinkAnim.probability = clamp(Number(probability == null ? 1 : probability), 0, 1);
      },
      // 眨眼心跳开关：UI 场景先关掉再做精确断言，最后打开等一次真实的自动眨眼
      setBlinkHeartbeat(on) {
        if (on) scheduleBlink();
        else { if (app.blink.timer) clearTimeout(app.blink.timer); app.blink.timer = 0; }
      },
      // 立即播放一次眨眼（跳过心跳等待；忙/睡觉/状态形态/无帧 → false）
      playBlinkAnim() {
        if (!canStartOverlay()) return false;
        const frames = app.blinkAnim.frames.length ? app.blinkAnim.frames : (app.blinkBody ? [app.blinkBody] : []);
        if (!frames.length) return false;
        app.blink.playing = true;
        playOverlayFrames(frames, () => { app.blink.playing = false; });
        return true;
      },
      // —— 随机特效动画驱动（测试/调试）：注入帧组 + 立即起播（跳过 15~25s 与零点等待）——
      setEffectFrames(frames) {
        app.effectFx.groups = (Array.isArray(frames) && frames.length)
          ? [{
              name: 'test',
              frames: frames
                .filter((f) => f && f.src)
                .map((f) => ({ src: f.src, durationMs: clamp(Number(f.durationMs) || 150, 30, 5000) })),
            }]
          : [];
      },
      playEffect() {
        if (!app.effectFx.groups.length || !canStartOverlay()) return false;
        startEffectPlayback();
        return true;
      },
      toggleStateVisual: () => toggleVisualMode(),
      setVisualMode: (m) => { setVisualMode(m); return app.stateVisual.mode; },
      // 形态三驱动入口：注入一次"打字节拍"（等价于主进程探针上报，UI 场景不必真敲键盘，
      // 也不会读到机器上真人正在打的字）；返回值 = 当前第几张打字图（-1=不打字图）。
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
