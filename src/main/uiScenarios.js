'use strict';
/**
 * UI 自动化场景（在主进程内跑，用 executeJavaScript 驱动真实渲染层）。
 * 说明：本项目 UI 自动化采用“Electron 内直接驱动（executeJavaScript + window.__petTest）
 * 而非 Playwright”，以降低依赖与搭建成本（PRD 允许降级到前两层测试 + 冒烟）。
 * 场景返回 true 表示通过。
 *
 * 每个场景：`module.exports.scenarios = { name: async (ctx) => boolean }`
 * ctx = { js(expr):Promise<any>, sleep(ms):Promise<void> }
 */
const nodePath = require('path');

function assertMap(results) {
  const bad = results.filter((x) => !x.ok);
  if (bad.length) {
    console.error('[scenario] 断言失败:', bad.map((b) => b.name).join(', '));
    return false;
  }
  return true;
}

async function waitFor(js, condExpr, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await js(condExpr);
    if (v) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`等待超时: ${what}`);
}

/** 在待办窗口里把 #due 输入框设为 now+offsetMs 的本地时间（datetime-local 分钟精度）。 */
function setDueInput(offsetMs) {
  return `(() => {
    const d = new Date(Date.now() + ${offsetMs});
    const pad = (n) => String(n).padStart(2, '0');
    document.getElementById('due').value =
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  })()`;
}

const scenarios = {
  /** 启动问候：桌宠启动后应自动弹出一条随机问候气泡。 */
  async greeting(ctx) {
    await waitFor(ctx.js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    await waitFor(ctx.js, `document.getElementById('bubble').classList.contains('show')`, 3000, '启动问候气泡');
    const text = await ctx.js(`document.getElementById('bubble').textContent`);
    const list = await ctx.js(`window.__petState().greetings`);
    return typeof text === 'string' && text.length > 0 && Array.isArray(list) && list.includes(text);
  },

  /** 动画：摸头产生压缩 q 弹并收敛；胶囊点击折叠/展开。 */
  async anim(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');

    const results = [];

    // 基线：弹簧静止归 1（待机不再有任何缩放）
    const base = await js('window.__petState().animScale.sy');
    results.push({ name: '基线弹簧 sy≈1', ok: Math.abs(base - 1) < 0.03 });

    // 摸头 → sy 出现明显压缩（Q 弹）
    await js('window.__petTest.headpat()');
    let minSy = 1;
    for (let i = 0; i < 14; i++) {
      await sleep(45);
      const s = await js('window.__petState().animScale.sy');
      if (s < minSy) minSy = s;
    }
    results.push({ name: `摸头压缩明显(min=${minSy.toFixed(3)}<0.95)`, ok: minSy < 0.95 });

    // 一段时间后弹簧收敛回 1（动画没有失控/停止）
    await sleep(2400);
    const after = await js('window.__petState().animScale.sy');
    results.push({ name: `Q弹弹簧收敛回 1(|${after.toFixed(3)}-1|<0.04)`, ok: Math.abs(after - 1) < 0.04 });

    // 待机彻底静止：原"呼吸在动"断言的反向版本 —— 呼吸波删掉后，静止人物不该再有任何缩放起伏
    let lo = 1, hi = 1;
    for (let i = 0; i < 30; i++) { await sleep(50); const v = await js('window.__petState().animScale.sy'); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    results.push({ name: `待机无任何缩放(hi-lo=${(hi - lo).toFixed(6)} 期望 0)`, ok: hi - lo < 1e-6 });

    // 状态胶囊折叠/展开
    await js('document.getElementById("pill").click()');
    const c1 = await js('window.__petState().pillCollapsed');
    await js('document.getElementById("pill").click()');
    const c2 = await js('window.__petState().pillCollapsed');
    results.push({ name: `胶囊折叠=${c1}→展开=${c2}`, ok: c1 === true && c2 === false });

    return assertMap(results);
  },

  /** 眨眼：视觉层闭眼图可显示/隐藏，且判定区域不因此变化；
   *  降级单图眨眼走真实播放路径（整帧接管本体 → 播完恢复，时长来自 blink.frameMs）；
   *  最后打开随机心跳，等一次"没人调用"的自动眨眼。 */
  async blink(ctx) {
    const { js } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const r = await js(`(() => {
      const T = window.__petTest;
      T.setBlinkHeartbeat(false);   // 前两段要精确断言，先停掉随机心跳
      const s = T.state();
      const p = s.pet;
      let hit = null;
      outer:
      for (let dy = -10; dy <= 10; dy++) {
        for (let dx = -10; dx <= 10; dx++) {
          const x = p.x + Math.round(p.anchor.x) + dx;
          const y = p.y + Math.round(p.anchor.y) + dy;
          if (T.isInteractableAt(x, y)) { hit = { x, y }; break outer; }
        }
      }
      T.forceBlink(true);
      const visible = document.getElementById('blink').style.display === 'block';
      const hitWhileVisible = T.isInteractableAt(hit.x, hit.y);
      T.forceBlink(false);
      const hidden = document.getElementById('blink').style.display === 'none';
      const hitWhileHidden = T.isInteractableAt(hit.x, hit.y);
      return { visible, hidden, hitWhileVisible, hitWhileHidden };
    })()`);
    if (!(r.visible && r.hidden && r.hitWhileVisible === true && r.hitWhileHidden === true)) return false;

    // 降级单图眨眼（真实播放路径）：起播 → 本体隐藏、叠加显示 → ~frameMs 后恢复本体
    const seq = await js(`(async () => {
      const T = window.__petTest;
      const started = T.playBlinkAnim();
      await new Promise((r2) => setTimeout(r2, 50));
      const mid = T.state();
      const bodyHidden = document.getElementById('pet').style.display === 'none';
      const blinkShown = document.getElementById('blink').style.display === 'block';
      await new Promise((r2) => setTimeout(r2, 400)); // 150ms 帧时长 + 余量
      const end = T.state();
      const bodyBack = document.getElementById('pet').style.display !== 'none';
      const blinkHidden = document.getElementById('blink').style.display === 'none';
      return { started, playingMid: mid.blinkPlaying, bodyHidden, blinkShown,
        done: !end.blinkPlaying, bodyBack, blinkHidden };
    })()`);
    if (!(seq && seq.started === true && seq.playingMid === true && seq.bodyHidden === true &&
      seq.blinkShown === true && seq.done === true && seq.bodyBack === true && seq.blinkHidden === true)) return false;

    // 自动触发链路（blink.min~maxIntervalMs 心跳 → 播 blinkBody）：这段 2026-09-10 起被注释关闭过，
    // 期间没有任何测试变红 —— 所以必须真的等到一次"没人调用"的眨眼，而不是只测播放机制。
    const auto = await js(`(async () => {
      const T = window.__petTest;
      T.setBlinkHeartbeat(true);
      for (let i = 0; i < 400; i++) {   // 16s：最长间隔 8s + 余量，等不到就是心跳没接上
        if (T.state().blinkPlaying) return { ok: true };
        await new Promise((r2) => setTimeout(r2, 40));
      }
      return { ok: false };
    })()`);
    return auto && auto.ok === true;
  },

  /** 眨眼动画（多帧）：依次播放两帧、帧间切换 src、播完恢复常态。 */
  async blinkAnim(ctx) {
    const { js } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const seq = await js(`(async () => {
      const T = window.__petTest;
      const mk = (color) => {
        const c = document.createElement('canvas'); c.width = 8; c.height = 8;
        const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 8, 8);
        return c.toDataURL('image/png');
      };
      T.setBlinkAnim([
        { src: mk('#ff0000'), durationMs: 120 },
        { src: mk('#00ff00'), durationMs: 120 },
      ], 1);
      const started = T.playBlinkAnim();
      await new Promise((r2) => setTimeout(r2, 60));   // t≈60：第一帧显示中
      const firstVisible = document.getElementById('blink').style.display === 'block';
      const firstSrc = document.getElementById('blink').src;
      await new Promise((r2) => setTimeout(r2, 120));  // t≈180：第二帧显示中
      const secondSrc = document.getElementById('blink').src;
      await new Promise((r2) => setTimeout(r2, 250));  // t≈430：已播完恢复
      const doneHidden = document.getElementById('blink').style.display === 'none';
      const st = T.state();
      T.setBlinkAnim([], 1);
      return { started, firstVisible, firstSrc, secondSrc, doneHidden, frames: st.blinkAnim.frames };
    })()`);
    return seq && seq.started === true && seq.frames === 2 &&
      seq.firstVisible === true && seq.doneHidden === true && seq.firstSrc !== seq.secondSrc;
  },

  /** 随机特效动画：注入帧 → 整帧接管本体（本体隐藏、叠加层显示）、播放中判定不变、
   *  与眨眼互斥（特效播放中眨眼拒绝起播）、播完恢复本体。 */
  async fxAnim(ctx) {
    const { js } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const r = await js(`(async () => {
      const T = window.__petTest;
      const mk = (color) => {
        const c = document.createElement('canvas'); c.width = 8; c.height = 8;
        const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 8, 8);
        return c.toDataURL('image/png');
      };
      T.setEffectFrames([
        { src: mk('#ff0000'), durationMs: 120 },
        { src: mk('#00ff00'), durationMs: 120 },
        { src: mk('#0000ff'), durationMs: 120 },
      ]);
      const s0 = T.state();
      const anchorPt = { x: s0.pet.x + Math.round(s0.pet.anchor.x), y: s0.pet.y + Math.round(s0.pet.anchor.y) };
      const hitBefore = T.isInteractableAt(anchorPt.x, anchorPt.y);
      const started = T.playEffect();
      await new Promise((r2) => setTimeout(r2, 60));   // 播放中
      const playingMid = T.state().fxAnim.playing;
      const blinkShownMid = document.getElementById('blink').style.display === 'block';
      const bodyHiddenMid = document.getElementById('pet').style.display === 'none';
      const hitMid = T.isInteractableAt(anchorPt.x, anchorPt.y); // 红线：判定仍用真实身体位图
      const blinkRejected = T.playBlinkAnim() === false;         // 互斥：特效播放中眨眼不起播
      await new Promise((r2) => setTimeout(r2, 480));  // 3 帧 ×120ms + 余量 → 播完
      const st = T.state();
      const bodyBack = document.getElementById('pet').style.display !== 'none';
      const blinkHiddenEnd = document.getElementById('blink').style.display === 'none';
      T.setEffectFrames([]);
      return { started, playingMid, blinkShownMid, bodyHiddenMid, hitBefore, hitMid,
        blinkRejected, done: !st.fxAnim.playing, bodyBack, blinkHiddenEnd };
    })()`);
    return r && r.started === true && r.playingMid === true && r.blinkShownMid === true &&
      r.bodyHiddenMid === true && r.hitBefore === true && r.hitMid === true &&
      r.blinkRejected === true && r.done === true && r.bodyBack === true && r.blinkHiddenEnd === true;
  },

  /** 状态切换 = 换一具身体：状态形象有自己的位图/锚点/尺寸，判定等一切随当前身体走；
   *  切换保持底边中点位置连续（原地换装）；闭眼图属于主形象 → 非主形态不眨眼；不影响状态数值。
   *  三态改造后这里验"主 ↔ 状态"直达（打字态另有 typing 场景）。 */
  async stateVisual(ctx) {
    const { js } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const r = await js(`(() => {
      const T = window.__petTest;
      const findHit = () => {                 // 在“当前身体”锚点附近找可交互点（判定随身体走）
        const p = T.state().pet;
        for (let dy = -10; dy <= 10; dy++) {
          for (let dx = -10; dx <= 10; dx++) {
            const x = p.x + Math.round(p.anchor.x) + dx;
            const y = p.y + Math.round(p.anchor.y) + dy;
            if (T.isInteractableAt(x, y)) return { x, y };
          }
        }
        return null;
      };
      const bottomCenter = () => { const p = T.state().pet; return { b: p.y + p.h, cx: p.x + p.w / 2 }; };
      const s0 = T.state();
      const hit0 = findHit();
      const bc0 = bottomCenter();
      const shownMode = T.setVisualMode('state');
      const st1 = T.state();
      const bc1 = bottomCenter();
      const hit1 = findHit();
      const blinkSuppressed = (() => {        // 闭眼图属于主形象 → 非主形态不眨眼
        T.forceBlink(true);
        const suppressed = document.getElementById('blink').style.display !== 'block';
        T.forceBlink(false);
        return suppressed;
      })();
      const status1 = st1.status;
      const backMode = T.setVisualMode('main');
      const st2 = T.state();
      const bc2 = bottomCenter();
      const hit2 = findHit();
      const status2 = st2.status;
      return { status0: s0.status, shownMode, mode1: st1.visualMode, bodyKind: st1.bodyKind,
        stateBodyReady: st1.stateBodyReady, bc0, bc1, hit1, blinkSuppressed, status1,
        backMode, mode2: st2.visualMode, bodyBack: st2.bodyKind, bc2, hit0, hit2, status2 };
    })()`);
    const near = (a, b, eps = 1.5) => Math.abs(a - b) <= eps;
    const sameStatus = (a, b) => a && b &&
      a.mood === b.mood && a.energy === b.energy && a.satiety === b.satiety && a.affinity === b.affinity;
    return r.shownMode === 'state' && r.mode1 === 'state' && r.stateBodyReady === true && r.bodyKind === 'state' &&
      near(r.bc1.b, r.bc0.b) && near(r.bc1.cx, r.bc0.cx) &&          // 底边中点连续（原地换装）
      !!r.hit0 && !!r.hit1 && !!r.hit2 &&                            // 两种形态都可命中（判定随身体走）
      r.blinkSuppressed === true &&
      r.backMode === 'main' && r.mode2 === 'main' && r.bodyBack === 'main' &&
      near(r.bc2.b, r.bc0.b) && near(r.bc2.cx, r.bc0.cx) &&          // 切回位置仍连续
      sameStatus(r.status1, r.status0) && sameStatus(r.status2, r.status0); // 切形态不动状态数值
  },

  /** 形态三（打字状态）三张图：进入即显示"不打字"图（图3）；每注入一次打字节拍在图1/图2
   *  之间交替一次；停手超过阈值回到图3，且**再按一下必须从图1 起**（相位复位）。
   *  节拍由 __petTest.typingBeat() 注入 —— TEST_MODE 下主进程不装真键盘钩子（低级钩子会读到
   *  机器上真人在打的字，断言就没法确定），钩子本身另由 tools 侧的真机验证 + typing.test.js
   *  的纯函数/探针源码断言覆盖。 */
  async typing(ctx) {
    const { js, sleep, mainState, mainMenu } = ctx;
    // 入口先验：「切换状态」子菜单必须是三项（用户能不能选到形态三，全看这一项）
    const stateSub = (mainMenu().find((m) => m.id === 'state') || {}).children || [];
    if (stateSub.join(',') !== 'stateMain,stateAlt,stateType') {
      console.error('[typing] 主菜单「切换状态」子项不对：', stateSub.join(','));
      return false;
    }
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const ready = await js('window.__petState().typingReady');
    if (!ready || ready.frames !== 2 || !ready.idle) {
      console.error('[typing] 形态三素材未就位（frames/idle 缺失），场景无意义');
      return false;
    }
    // 阈值调短到 300ms：场景不必死等 config 的 1s（1s 这条默认值由 typing.test.js 锁死）
    await js('window.__petTest.setTypingIdleMs(300)');
    const r = await js(`(() => {
      const T = window.__petTest;
      const bc = () => { const p = T.state().pet; return { b: p.y + p.h, cx: p.x + p.w / 2 }; };
      const s0 = T.state(); const bc0 = bc();
      const mode0 = s0.visualMode;
      const got = T.setVisualMode('type');
      const s1 = T.state(); const bc1 = bc();
      const blinkSuppressed = (() => {
        T.forceBlink(true);
        const ok = document.getElementById('blink').style.display !== 'block';
        T.forceBlink(false);
        return ok;
      })();
      return { mode0, got, mode1: s1.visualMode, body1: s1.bodyKind, frame1: s1.typingFrame,
        bc0, bc1, blinkSuppressed };
    })()`);
    // 三下按键（间隔 > minFlipMs=50 才会真翻帧）→ 帧号必须是 0,1,0
    const frames = [];
    for (let i = 0; i < 3; i++) {
      frames.push(await js('window.__petTest.typingBeat()'));
      await sleep(70);
    }
    await sleep(80);
    const mid = await js('window.__petState()');
    await sleep(360); // 停手越过 300ms 阈值
    const after = await js(`(() => { const s = window.__petState();
      return { frame: s.typingFrame, body: s.bodyKind, bc: { b: s.pet.y + s.pet.h, cx: s.pet.x + s.pet.w / 2 } }; })()`);
    const again = await js('window.__petTest.typingBeat()');   // 再起打 → 必须从图1（帧 0）
    await sleep(120); // 等 visualSync 回到主进程
    const msType = mainState();
    const back = await js(`(() => { const T = window.__petTest;
      const m = T.setVisualMode('main'); const s = T.state();
      return { m, body: s.bodyKind, frame: s.typingFrame, mode: s.visualMode }; })()`);
    await sleep(120);
    const msBack = mainState();
    const near = (a, b, eps = 1.5) => Math.abs(a - b) <= eps;
    return r.mode0 === 'main' && r.got === 'type' && r.mode1 === 'type' &&
      r.body1 === 'typeIdle' && r.frame1 === -1 &&                    // 进形态三先显示第三张图
      near(r.bc1.b, r.bc0.b) && near(r.bc1.cx, r.bc0.cx) &&           // 换图原地不动
      r.blinkSuppressed === true &&
      frames.join(',') === '0,1,0' && mid.typingFrame === 0 &&        // 逐键交替（第三下回到图1）
      near(mid.pet.y + mid.pet.h, r.bc0.b) &&
      after.frame === -1 && after.body === 'typeIdle' &&              // 停手 → 第三张图
      near(after.bc.b, r.bc0.b) && near(after.bc.cx, r.bc0.cx) &&
      again === 0 &&                                                  // 再起打从图1 起
      msType.visualMode === 'type' &&
      msType.typing && msType.typing.running === false &&             // 测试模式不装真钩子
      back.m === 'main' && back.mode === 'main' && back.body === 'main' && back.frame === -1 &&
      msBack.visualMode === 'main' && msBack.typing.running === false;
  },

  /**
   * 锁定语义（功能 4）：置顶级别恒为最高档 screen-saver（锁定/解锁差异只在整窗穿透），
   * 锁定 → 整窗强制穿透（即使光标在宠物实体像素上）、托盘出现“解锁（保底入口）”；
   * 解锁 → 恢复正常穿透语义、托盘文本更新。
   */
  async lock(ctx) {
    const { js, sleep, mainState } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    let ms = mainState();
    results.push({ name: `初始未锁定且为最高置顶(level=${ms.lockLevel})`, ok: ms.locked === false && ms.lockLevel === 'screen-saver' });

    // 锁定（渲染层长按 3s 的切换路径）
    await js('window.__petTest.toggleLock()');
    await sleep(200);
    ms = mainState();
    results.push({ name: `锁定后仍为最高置顶(level=${ms.lockLevel})`, ok: ms.locked === true && ms.lockLevel === 'screen-saver' });
    results.push({ name: '锁定后托盘出现“解锁（保底入口）”', ok: ms.trayLabels.includes('解锁（保底入口）') });

    // 锁定态：光标落在宠物实体像素上也整窗穿透
    const probe = `(() => {
      const T = window.__petTest;
      const s = T.state(); const p = s.pet;
      let solid = null;
      outer:
      for (let dy = -10; dy <= 10; dy++) {
        for (let dx = -10; dx <= 10; dx++) {
          const x = p.x + Math.round(p.anchor.x) + dx;
          const y = p.y + Math.round(p.anchor.y) + dy;
          if (T.isInteractableAt(x, y)) { solid = { x, y }; break outer; }
        }
      }
      if (!solid) return null;
      T.setCursorContent(solid.x, solid.y);
      return { ignore: T.ignoreNow(), interactive: T.state().interactive };
    })()`;
    const lockedHit = await js(probe);
    results.push({ name: '锁定态实体像素上也整窗穿透', ok: !!lockedHit && lockedHit.ignore === true && lockedHit.interactive === false });

    // 解锁：恢复常规穿透语义 + 托盘文本（置顶级别恒为最高档）
    await js('window.__petTest.toggleLock()');
    await sleep(200);
    ms = mainState();
    results.push({ name: `解锁保持最高置顶(level=${ms.lockLevel})`, ok: ms.locked === false && ms.lockLevel === 'screen-saver' });
    results.push({ name: '托盘文本为“锁定并保持始终置于顶层”', ok: ms.trayLabels.includes('锁定并保持始终置于顶层') });
    const unlockedHit = await js(probe);
    results.push({ name: '解锁后实体像素恢复可交互', ok: !!unlockedHit && unlockedHit.ignore === false && unlockedHit.interactive === true });

    return assertMap(results);
  },

  /**
   * 待办清单（功能 3）：打开独立待办窗口 → 真实 DOM 添加（含截止时间/♥）→ 列表渲染 →
   * 持久化到 settings → 到期待办触发检查 → 主窗气泡“主人，该做…”→ 完成划线 → 删除。
   */
  async todo(ctx) {
    const { js, sleep, execIn, waitForWin, mainState } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    ctx.openTodo();
    await waitForWin('todoWin');

    // ① 添加：未来截止 + ♥
    await execIn('todoWin', `document.getElementById('text').value = '写周报'`);
    await execIn('todoWin', setDueInput(2 * 60 * 1000));
    await execIn('todoWin', `document.getElementById('important').checked = true`);
    await execIn('todoWin', `document.getElementById('addBtn').click()`);
    await sleep(200);
    const rowsExpr = `Array.from(document.querySelectorAll('#list .row')).map((r) => ({
      txt: r.querySelector('.txt').textContent,
      imp: r.querySelector('.impBtn').textContent === '♥',
      done: r.classList.contains('done'),
    }))`;
    let rows = await execIn('todoWin', rowsExpr);
    results.push({ name: `添加待办并渲染(${JSON.stringify(rows[0] || null)})`, ok: rows.length === 1 && rows[0].txt === '写周报' && rows[0].imp === true && rows[0].done === false });

    // ② 持久化：settings.json 的 todos 字段（id/text/due/important 齐全）
    let st = mainState();
    results.push({
      name: '待办持久化到 settings',
      ok: Array.isArray(st.todos) && st.todos.length === 1 &&
        st.todos[0].text === '写周报' && st.todos[0].important === true && st.todos[0].due != null,
    });

    // ③ 到期待办 → 主进程检查 → 主窗气泡（真实 checkDueTodos 路径）
    await execIn('todoWin', `document.getElementById('text').value = '取快递'`);
    await execIn('todoWin', setDueInput(-1000));
    await execIn('todoWin', `document.getElementById('addBtn').click()`);
    await sleep(200);
    ctx.checkDueTodos();
    await waitFor(js, `document.getElementById('bubble').classList.contains('show') && document.getElementById('bubble').textContent.includes('取快递')`, 5000, '到期气泡出现');
    results.push({ name: '到期待办弹出“主人，该做…”气泡', ok: true });

    // ④ 点击气泡可关闭
    await js(`document.getElementById('bubble').click()`);
    await sleep(80);
    const bubbleGone = await js(`!document.getElementById('bubble').classList.contains('show')`);
    results.push({ name: '点击气泡关闭', ok: bubbleGone === true });

    // ⑤ 标记完成 → 划线
    await execIn('todoWin', `document.querySelector('#list .row .doneCk').click()`);
    await sleep(200);
    rows = await execIn('todoWin', rowsExpr);
    st = mainState();
    results.push({ name: `标记完成划线(done=${rows[0].done})`, ok: rows[0].done === true && st.todos[0].done === true });

    // ⑥ 删除
    await execIn('todoWin', `document.querySelector('#list .row .delBtn').click()`);
    await sleep(200);
    rows = await execIn('todoWin', rowsExpr);
    st = mainState();
    results.push({ name: `删除待办(剩 ${rows.length} 行)`, ok: rows.length === 1 && rows[0].txt === '取快递' && st.todos.length === 1 });

    return assertMap(results);
  },

  /**
   * 随机催促（功能 6）：♥ 且临近截止的待办触发催促 → 主窗气泡“主人，'xxx' 做完了吗？”；
   * 锁定状态下触发不生效（解锁后恢复正常）。触发动作走真实 triggerReminderNow
   * （即 25~30min 随机定时器到点执行的那个函数）；权重选择逻辑由单元测试覆盖。
   */
  async reminder(ctx) {
    const { js, sleep, execIn, waitForWin } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    // 经真实待办窗口添加一条 ♥ 且剩余 5 分钟的待办（≤10min → 大幅加权）
    ctx.openTodo();
    await waitForWin('todoWin');
    await execIn('todoWin', `document.getElementById('text').value = '背单词'`);
    await execIn('todoWin', setDueInput(5 * 60 * 1000));
    await execIn('todoWin', `document.getElementById('important').checked = true`);
    await execIn('todoWin', `document.getElementById('addBtn').click()`);
    await sleep(250);
    await execIn('todoWin', `window.close()`);

    // 触发一次催促（定时器到点时的动作）→ 气泡含模板文案
    ctx.triggerReminderNow();
    await waitFor(js, `document.getElementById('bubble').classList.contains('show') && document.getElementById('bubble').textContent.includes('背单词')`, 5000, '催促气泡出现');
    const text = await js(`document.getElementById('bubble').textContent`);
    results.push({ name: `催促气泡按模板生成(${text})`, ok: text.includes('做完了吗') });

    // 锁定状态下不催促
    await js(`window.__petTest.hideBubble()`);
    await js('window.__petTest.toggleLock()');
    await sleep(200);
    ctx.triggerReminderNow();
    await sleep(150);
    const none = await js(`!document.getElementById('bubble').classList.contains('show')`);
    results.push({ name: '锁定状态下触发不生效', ok: none === true });

    // 解锁还原（不残留锁定态）
    await js('window.__petTest.toggleLock()');
    await sleep(200);
    const unlocked = await js(`window.__petState().locked === false`);
    results.push({ name: '场景结束恢复解锁', ok: unlocked === true });

    return assertMap(results);
  },

  /**
   * 聊天（功能 7）：真实聊天窗 + 聊天设置窗 —— 添加规则（持久化）→ 发送命中消息 →
   * 回复渲染在聊天窗 + 主窗气泡同步 → 发送未命中消息 → 主窗 Q 弹（情绪变化）且无回复气泡 →
   * 最长关键词优先 → 删除规则 → 关闭窗口。
   */
  async chat(ctx) {
    const { js, sleep, execIn, waitForWin, mainState } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];
    await js('window.__petTest.setAffinityRng(0.99)'); // 关掉随机爱心，避免干扰断言

    // 打开聊天 + 设置窗口（真实菜单动作路径）
    ctx.openChat();
    ctx.openChatSettings();
    await waitForWin('chatWin');
    await waitForWin('chatSettingsWin');

    // ① 添加规则：你好 → 嗨，主人！
    await execIn('chatSettingsWin', `document.getElementById('keyword').value = '你好'`);
    await execIn('chatSettingsWin', `document.getElementById('reply').value = '嗨，主人！'`);
    await execIn('chatSettingsWin', `document.getElementById('addBtn').click()`);
    await sleep(250);
    let st = mainState();
    results.push({
      name: '聊天规则持久化到 settings',
      ok: Array.isArray(st.chatRules) && st.chatRules.some((r) => r.keyword === '你好' && r.reply === '嗨，主人！'),
    });

    const lastPetReply = `(() => {
      const els = document.querySelectorAll('#msgs .msg.pet');
      return els.length ? els[els.length - 1].textContent : null;
    })()`;

    // ② 命中：聊天窗发送 → 回复渲染 + 主窗气泡
    await execIn('chatWin', `document.getElementById('input').value = '你好呀'`);
    await execIn('chatWin', `document.getElementById('sendBtn').click()`);
    let replyShown = false;
    for (let i = 0; i < 40 && !replyShown; i++) {
      await sleep(100);
      replyShown = await execIn('chatWin', `${lastPetReply} === '嗨，主人！'`);
    }
    results.push({ name: '命中关键词 → 回复渲染在聊天窗', ok: replyShown === true });
    await waitFor(js, `document.getElementById('bubble').classList.contains('show') && document.getElementById('bubble').textContent.includes('嗨，主人！')`, 4000, '聊天回复气泡');
    results.push({ name: '主窗气泡同步显示桌宠回复', ok: true });
    await js(`window.__petTest.hideBubble()`);

    // ③ 未命中：无回复气泡，主窗 Q 弹 + 情绪变化
    const mood0 = (await js('window.__petState().status')).mood;
    await execIn('chatWin', `document.getElementById('input').value = 'xkcd乱入词'`);
    await execIn('chatWin', `document.getElementById('sendBtn').click()`);
    await sleep(300);
    const st2 = await js('window.__petState()');
    const noBubble = await js(`!document.getElementById('bubble').classList.contains('show')`);
    results.push({ name: `未命中 → 情绪变化(${mood0}→${st2.status.mood})且无回复气泡`, ok: st2.status.mood >= mood0 + 1.5 && noBubble === true });

    // ④ 最长关键词优先：再添加 你好呀 → 咦，叫我？
    await execIn('chatSettingsWin', `document.getElementById('keyword').value = '你好呀'`);
    await execIn('chatSettingsWin', `document.getElementById('reply').value = '咦，叫我？'`);
    await execIn('chatSettingsWin', `document.getElementById('addBtn').click()`);
    await sleep(250);
    await execIn('chatWin', `document.getElementById('input').value = '你好呀'`);
    await execIn('chatWin', `document.getElementById('sendBtn').click()`);
    let longHit = false;
    for (let i = 0; i < 40 && !longHit; i++) {
      await sleep(100);
      longHit = await execIn('chatWin', `${lastPetReply} === '咦，叫我？'`);
    }
    results.push({ name: '多命中时用最长关键词的回复', ok: longHit === true });

    // ⑤ 删除规则（按 keyword）→ 持久化
    await execIn('chatSettingsWin', `document.querySelector('#list .row .delBtn').click()`);
    await sleep(250);
    st = mainState();
    results.push({ name: `删除规则(剩 ${st.chatRules.length} 条)`, ok: st.chatRules.length === 1 && st.chatRules[0].keyword === '你好呀' });

    // ⑥ 语音"正在输入"显示（不依赖麦克风/模型：由主进程广播驱动，与真实语音走同一条通道）
    const liveExpr = `(() => {
      const l = document.getElementById('live');
      return { hidden: l.hidden, cls: l.className, txt: l.querySelector('.txt').textContent,
               bar: l.querySelector('.bar > i').style.width };
    })()`;
    // ★ 呈现规则（用户定调）：被动等待唤醒（listening）时一切安静——后台监听不扰动界面；
    //   只有真正进入对话（decoding，被唤醒/按键说话）才出现反馈。
    ctx.voiceBroadcast('voice:state', { state: 'listening', rms: 0.2 });
    await sleep(150);
    let live = await execIn('chatWin', liveExpr);
    results.push({ name: '聊天窗：被动等待唤醒时不显示输入条', ok: live.hidden === true });
    results.push({ name: '宠物：被动等待唤醒时不显示"在听"指示', ok: (await js('window.__petState().voiceIndicatorOn')) === false });

    ctx.voiceBroadcast('voice:state', { state: 'decoding', rms: 0.3 });
    await sleep(150);
    live = await execIn('chatWin', liveExpr);
    results.push({ name: `聊天窗：说话时出现"正在输入"条(${live.txt})`, ok: live.hidden === false && live.txt.includes('正在识别') });
    results.push({ name: `聊天窗：电平条随音量走(${live.bar})`, ok: parseFloat(live.bar) > 0 });
    results.push({ name: '宠物：进入对话（被唤醒/按键）时显示"在听"指示', ok: (await js('window.__petState().voiceIndicatorOn')) === true });

    ctx.voiceBroadcast('voice:partial', { text: '今天天气' });
    await sleep(150);
    live = await execIn('chatWin', liveExpr);
    results.push({ name: `聊天窗：实时字幕(${live.txt})`, ok: live.txt.includes('今天天气') });

    // ② 语音提示条与聊天气泡**不许重叠**（用户 2026-09-16 反馈：两者都锚在宠物头顶同一处，
    //   一行气泡会盖住提示条 24px 里的 18px，看着"互相冲突、反复闪动"）。
    const overlapExpr = `(() => {
      const b = document.getElementById('bubble');
      const v = document.getElementById('voice');
      const show = b.classList.contains('show');
      const on = v.classList.contains('on');
      const rb = b.getBoundingClientRect();
      const rv = v.getBoundingClientRect();
      const dy = Math.min(rb.bottom, rv.bottom) - Math.max(rb.top, rv.top);
      const dx = Math.min(rb.right, rv.right) - Math.max(rb.left, rv.left);
      // 矩形无条件返回：语音条收起后仍要能量气泡落回的位置（ready 只表示气泡在显示）
      return { ready: show, on, overlap: (show && on && dy > 0 && dx > 0) ? Math.round(dy) : 0,
               b: [Math.round(rb.top), Math.round(rb.bottom)],
               v: [Math.round(rv.top), Math.round(rv.bottom)] };
    })()`;
    ctx.bubble('重叠检查用气泡', 8000);
    await sleep(200);
    const nvOn = await js(overlapExpr);
    results.push({
      name: `宠物：语音条与气泡不重叠(气泡 ${(nvOn.b || []).join('..')} / 语音条 ${(nvOn.v || []).join('..')})`,
      ok: nvOn.ready === true && nvOn.on === true && nvOn.overlap === 0 && nvOn.b[1] < nvOn.v[0],
    });
    const bubbleTopWhenVoiceOn = nvOn.ready ? nvOn.b[0] : 0;

    ctx.voiceBroadcast('voice:state', { state: 'idle', rms: 0 });
    await sleep(150);
    live = await execIn('chatWin', liveExpr);
    results.push({ name: '聊天窗：说完后自动收起', ok: live.hidden === true });
    // 语音条收起后气泡要落回原位（否则会一直悬在半空）
    const nvOff = await js(overlapExpr);
    results.push({
      name: `宠物：语音条收起后气泡落回(顶 ${bubbleTopWhenVoiceOn} → ${(nvOff.b || [])[0]})`,
      ok: nvOff.ready === true && nvOff.b[0] > bubbleTopWhenVoiceOn,
    });

    // ⑦ 识别出的"我说的那句"进入对话（who='me'）
    ctx.pushChatMessage('我说的话', 'me');
    await sleep(150);
    const meMsg = await execIn('chatWin', `(() => {
      const els = document.querySelectorAll('#msgs .msg.me');
      return els.length ? els[els.length - 1].textContent : null;
    })()`);
    results.push({ name: `聊天窗：我(语音)说的那句进入对话(${meMsg})`, ok: meMsg === '我说的话' });

    // ⑧ 语音对话的呈现（2026-09-16）：进入后要有"在听/在想"反馈，退出后回到安静
    ctx.voiceBroadcast('voice:dialog', { on: true, thinking: false });
    await sleep(150);
    const dlg = await execIn('chatWin', liveExpr);
    results.push({ name: `聊天窗：语音对话中显示状态条(${dlg.txt})`, ok: dlg.hidden === false && dlg.txt.includes('语音对话') });
    ctx.voiceBroadcast('voice:dialog', { on: true, thinking: true });
    await sleep(150);
    const think = await execIn('chatWin', liveExpr);
    results.push({ name: `聊天窗：等模型期间显示"在想…"(${think.txt})`, ok: think.txt.includes('在想') });
    ctx.voiceBroadcast('voice:dialog', { on: false, thinking: false });
    await sleep(150);
    const off = await execIn('chatWin', liveExpr);
    results.push({ name: '聊天窗：退出语音对话后状态条消失', ok: off.hidden === true });

    // ⑨ 过短没发给模型 → 状态条上给一句提示（而不是假装没发生）
    ctx.voiceBroadcast('voice:dialog', { on: true, thinking: false });
    ctx.voiceBroadcast('voice:discard', { reason: 'too-short-audio', text: '啊' });
    await sleep(150);
    const disc = await execIn('chatWin', liveExpr);
    results.push({ name: `聊天窗：过短时提示没听清(${disc.txt})`, ok: disc.txt.includes('没听清') });
    ctx.voiceBroadcast('voice:dialog', { on: false, thinking: false });

    // ⑧ 关闭窗口（不残留）
    await execIn('chatWin', `window.close()`);
    await execIn('chatSettingsWin', `window.close()`);
    await sleep(200);

    return assertMap(results);
  },

  /** 抛掷物理：注入速度→宠物真实飞动并最终落地回待机。 */
  async dragPhysics(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    const pre = await js('window.__petState().pet.y');
    await js('window.__petTest.forcePhys(700, -800)');
    await sleep(250);
    const phys1 = await js('window.__petState().physActive');
    const midY = await js('window.__petState().pet.y');
    results.push({ name: `抛掷后物理激活(phys=${phys1})`, ok: phys1 === true });
    results.push({ name: '抛掷确实改变了位置', ok: Math.abs(midY - pre) > 2 });

    // 等它落地回待机（最多 9s），最终静止在地面（像素级碰撞：碰撞盒底边贴地）
    try {
      await waitFor(js, 'window.__petState().physActive === false', 9000, '物理结束');
    } catch (e) {
      const dbg = await js(`(() => { const s = window.__petState(); return { phys: s.phys, pet: s.pet, world: s.world, pre: ${JSON.stringify(pre)} }; })()`);
      console.error(`[scenario] dragPhysics 超时，最后状态: ${JSON.stringify(dbg)}`);
      throw e;
    }
    const st = await js('window.__petState()');
    const colBottom = st.pet.col.oy + st.pet.col.h;
    const floorY = st.world.h - colBottom;
    results.push({
      name: `落地回待机且实体贴地(y=${st.pet.y.toFixed(0)}≈${Math.round(floorY)})`,
      ok: Math.abs(st.pet.y - floorY) < 3,
    });
    return assertMap(results);
  },

  /** 状态系统 + 区域面板：喂食涨饱食、互动涨情绪、归零半透明、面板参与命中判定。 */
  async status(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    // 强制好感度不命中，避免随机爱心干扰数值断言
    await js('window.__petTest.setAffinityRng(0.99)');

    // 预设低值 → 喂食：饱食 +20、体力 +5、情绪 +2
    await js('window.__petTest.setStatus({ mood: 40, energy: 60, satiety: 30 })');
    await js('window.__petTest.feed()');
    await sleep(80);
    let st = await js('window.__petState().status');
    results.push({ name: `喂食后饱食 30→${st.satiety}`, ok: st.satiety >= 50 && st.satiety <= 51 });
    results.push({ name: `喂食后情绪 40→${st.mood}`, ok: st.mood >= 42 });
    results.push({ name: `喂食后体力 60→${st.energy}`, ok: st.energy >= 65 });

    // 摸头（主动互动）：情绪 +2
    const m0 = st.mood;
    await js('window.__petTest.headpat()');
    await sleep(80);
    st = await js('window.__petState().status');
    results.push({ name: `摸头情绪 ${m0}→${st.mood}`, ok: st.mood >= m0 + 2 });

    // 状态胶囊文本已刷新为“图标+数值”格式
    const pillTxt = await js('window.__petState().pillText');
    results.push({ name: `胶囊显示数值(=${pillTxt})`, ok: /\d/.test(pillTxt) && pillTxt.includes('☺') && pillTxt.includes('🍖') });

    // 归零 → 半透明；任一 >0 → 恢复不透明
    await js('window.__petTest.setStatus({ mood: 0, energy: 0, satiety: 0 })');
    const low = await js('window.__petState()');
    results.push({ name: `归零半透明 opacity=${low.petOpacity} low=${low.derived.low}`, ok: low.derived.low === true && low.petOpacity === '0.45' });
    await js('window.__petTest.setStatus({ mood: 50, energy: 50, satiety: 50 })');
    const ok = await js('window.__petState()');
    results.push({ name: `恢复不透明 opacity=${ok.petOpacity}`, ok: ok.derived.low === false && ok.petOpacity === '1' });

    // 区域面板：打开后参与命中判定（指针在面板内不穿透）
    const before = await js('window.__petState().regionPanelOpen');
    await js('window.__petTest.openRegionPanel()');
    const after = await js(`(() => {
      const r = document.getElementById('panel').getBoundingClientRect();
      const s = window.__petState();
      const c = window.__petTest.cursorToContent({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      return { open: s.regionPanelOpen, hit: window.__petTest.isInteractableAt(c.x, c.y) };
    })()`);
    results.push({ name: `面板打开 open=${before}→${after.open}`, ok: after.open === true });
    results.push({ name: '面板区域命中判定为可交互', ok: after.hit === true });
    await js('window.__petTest.closeRegionPanel()');
    const closed = await js('window.__petState().regionPanelOpen');
    results.push({ name: `面板关闭 ${after.open}→${closed}`, ok: closed === false });

    return assertMap(results);
  },

  /**
   * 点击穿透语义（红线 1/5）：光标落在宠物实体像素 → 窗口可交互（ignore=false）；
   * 落在空白（无宠无 UI）→ 点击穿透（ignore=true）。请求与判定不反转。
   * 在同一段同步 JS 里 set+read，避免真实光标推送在帧间覆盖注入值。
   */
  async passthrough(ctx) {
    const { js } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const r = await js(`(() => {
      const T = window.__petTest;
      const s = T.state();
      const p = s.pet;
      // 找一个必然在宠物实体像素内的点（先扫描到可交互点）
      let solid = null;
      outer:
      for (let dy = -10; dy <= 10; dy++) {
        for (let dx = -10; dx <= 10; dx++) {
          const x = p.x + Math.round(p.anchor.x) + dx;
          const y = p.y + Math.round(p.anchor.y) + dy;
          if (T.isInteractableAt(x, y)) { solid = { x, y }; break outer; }
        }
      }
      T.setCursorContent(solid.x, solid.y);
      const onPet = { ignore: T.ignoreNow(), interactive: T.state().interactive };
      T.setCursorContent(30, s.world.h - 60); // 宠物上方、胶囊之外的一处空白
      const empty = { ignore: T.ignoreNow(), interactive: T.state().interactive };
      return { solid, onPet, empty };
    })()`);
    const ok = r.solid &&
      r.onPet.ignore === false && r.onPet.interactive === true &&
      r.empty.ignore === true && r.empty.interactive === false;
    console.log(`[passthrough] 结果 ${JSON.stringify(r)}`);
    return ok;
  },

  /**
   * 应用内图片选择器（背景模式 —— "更换宠物"已移除，宠物素材走素材根目录）：
   * 打开 → 列到 fixture 图片 → 面板参与命中判定 → 选中"设为背景" → 真实导入/设置路径 →
   * 背景生效且面板自动关闭。
   */
  async picker(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];
    const bgSrc = process.env.PET_BG_PATH;
    if (!bgSrc) { console.error('[scenario] 缺 PET_BG_PATH'); return false; }
    const dir = nodePath.dirname(bgSrc);
    const bgName = nodePath.basename(bgSrc);

    await js(`window.__petTest.openPicker('bg', ${JSON.stringify(dir)})`);
    await waitFor(js, `window.__petTest.pickerFiles().names.length > 0`, 6000, 'picker 列到图片');
    const st = await js(`(() => {
      const T = window.__petTest;
      const rect = document.getElementById('petPicker').getBoundingClientRect();
      const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return { open: T.state().petPickerOpen, hit: T.isInteractableAt(c.x, c.y), names: T.pickerFiles().names };
    })()`);
    results.push({ name: `选择器已打开 open=${st.open}`, ok: st.open === true });
    results.push({ name: '选择器面板参与命中（指针在其上不穿透）', ok: st.hit === true });
    results.push({ name: `列到 fixture 图片(${st.names && st.names.length})`, ok: Array.isArray(st.names) && st.names.some((n) => n === bgName) });

    // 选中背景图 → "把这张设为背景" → 真实导入/设置路径 → 面板自动关闭、背景生效
    await js(`(() => {
      const rows = Array.from(document.querySelectorAll('#petPicker .pk-item'));
      const row = rows.find((el) => el.textContent === ${JSON.stringify(bgName)}) || rows[0];
      row.click();
    })()`);
    await sleep(120);
    await js(`document.getElementById('pkUse').click()`);
    await waitFor(js, `window.__petState().petPickerOpen === false`, 8000, '设置背景成功后选择器自动关闭');
    const bgOn = await js(`window.__petState().bgOn`);
    results.push({ name: '背景已生效(bgOn=true)', ok: bgOn === true });

    return assertMap(results);
  },

  /**
   * 背景贴地 + 随人物居中（bug1）与清除/再开（bug2）：
   *   设背景后 → 高=人物高×4/3、宽按原图等比、底边贴地面、中心对人物脚底中点；
   *   人物贴地横移 → 背景跟随；人物悬空 → 背景垂直/水平都停住；落地 → 重新对齐；
   *   清除背景 → 显示消失；再设同一张 → 又能显示并对齐。
   */
  async bg(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];
    const bgSrc = process.env.PET_BG_PATH;
    if (!bgSrc) { console.error('[scenario] 缺 PET_BG_PATH'); return false; }

    const st = await js('window.__petState()');
    // “站在地面”= 碰撞盒（不透明像素）贴地，不是整图贴地（透明边距悬在地面下）
    const groundY = st.world.h - (st.pet.col.oy + st.pet.col.h);
    const x0 = Math.max(0, Math.round(st.world.w / 2 - st.pet.w / 2));
    await js(`window.__petTest.placePet(${x0}, ${groundY})`); // 先摆到地面，背景才能“贴人物底边”

    const okBg = await js(`window.__petTest.setBgFromPath(${JSON.stringify(bgSrc)})`);
    results.push({ name: '设置背景成功(真实导入→显示)', ok: okBg === true });
    await waitFor(js, `window.__petTest.bgGeom().bgOn && window.__petTest.bgGeom().bgRect && window.__petTest.bgGeom().bgRect.width > 0`, 6000, '背景加载并完成布局');

    const g = await js('window.__petTest.bgGeom()');
    const petH = st.pet.h;
    const expH = petH * (4 / 3);
    results.push({ name: `背景高=人物高×4/3(${Math.round(g.bgRect.height)}≈${Math.round(expH)})`, ok: Math.abs(g.bgRect.height - expH) <= 2 });
    results.push({ name: `宽按原图等比(宽高比≈${(g.bgRect.width / g.bgRect.height).toFixed(2)})`, ok: Math.abs(g.bgRect.width / g.bgRect.height - 160 / 64) < 0.02 });
    results.push({ name: `底边贴地面(bottom=${Math.round(g.bgRect.bottom)})`, ok: Math.abs(g.bgRect.bottom - st.world.h) <= 1.5 });
    results.push({ name: `背景中心对人物底边中点(|Δcx|=${Math.abs(g.bgRect.cx - g.petCX).toFixed(1)})`, ok: Math.abs(g.bgRect.cx - g.petCX) <= 1.5 });

    // 贴地横移 → 背景水平跟随（Δcx≈+150）
    const cx0 = g.bgRect.cx;
    await js('window.__petTest.drag(150, 0)');
    await sleep(60);
    const g2 = await js('window.__petTest.bgGeom()');
    results.push({
      name: `贴地横移→背景跟随(Δcx=${Math.round(g2.bgRect.cx - cx0)})`,
      ok: Math.abs(g2.bgRect.cx - (cx0 + 150)) <= 1.5 && Math.abs(g2.bgRect.cx - g2.petCX) <= 1.5,
    });

    // 垂直拎起（同 x、离地 200）→ 背景底边仍贴地、top 不变
    const cxAir = g2.bgRect.cx;
    const topAir = g2.bgRect.top;
    const petL = Math.round(cxAir - st.pet.w / 2);
    await js(`window.__petTest.placePet(${petL}, ${groundY - 200})`);
    await sleep(60);
    const g3 = await js('window.__petTest.bgGeom()');
    results.push({ name: '人物悬空→背景底边仍贴地、垂直不动', ok: Math.abs(g3.bgRect.top - topAir) <= 1.5 && Math.abs(g3.bgRect.bottom - st.world.h) <= 1.5 });

    // 空中横移 +120 → 背景水平不再跟随（人物 cx 变，背景 cx 不变）
    await js(`window.__petTest.placePet(${petL + 120}, ${groundY - 200})`);
    await sleep(60);
    const g4 = await js('window.__petTest.bgGeom()');
    results.push({
      name: '空中横移→背景不跟随(冻结)',
      ok: Math.abs(g4.bgRect.cx - cxAir) <= 1.5 && Math.abs(g4.bgRect.cx - g4.petCX) > 20,
    });

    // 落地（新位置）→ 背景重新对齐人物
    await js(`window.__petTest.placePet(${petL + 120}, ${groundY})`);
    await sleep(60);
    const g5 = await js('window.__petTest.bgGeom()');
    results.push({
      name: '落地→背景重新对齐(跟随到新位置)',
      ok: Math.abs(g5.bgRect.cx - g5.petCX) <= 1.5 && Math.abs(g5.bgRect.cx - cxAir) > 20,
    });

    // bug2：清除背景 → 立即消失；再开 → 又能正常显示并对齐
    await js('window.__petTest.clearBg()');
    const off = await js('window.__petTest.bgGeom()');
    results.push({ name: '清除背景生效(不再显示)', ok: off.bgOn === false && off.bgRect === null });
    const ok2 = await js(`window.__petTest.setBgFromPath(${JSON.stringify(bgSrc)})`);
    results.push({ name: '清除后能重新打开背景', ok: ok2 === true });
    await waitFor(js, `window.__petTest.bgGeom().bgOn && window.__petTest.bgGeom().bgRect && window.__petTest.bgGeom().bgRect.width > 0`, 6000, '背景重新加载');
    const g6 = await js('window.__petTest.bgGeom()');
    results.push({
      name: '重开后显示正常且对齐',
      ok: g6.bgOn === true && Math.abs(g6.bgRect.cx - g6.petCX) <= 1.5 && Math.abs(g6.bgRect.bottom - st.world.h) <= 1.5,
    });

    return assertMap(results);
  },

  /**
   * 右键菜单“不吸人”（bug5）：长按右键弹原生菜单时 Windows 常吞掉右键抬起，渲染层会
   * 残留“按键按住 / 手势进行中”，于是下一次鼠标移动就被当成拖动 → 人物被拽到光标。
   * 修复 = 弹菜单前 & 菜单关闭后清理手势态。这里直接验证清理逻辑 + 清理后再移动不移动人物。
   */
  async menuClean(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    const p = await js('window.__petState().pet');
    const cx = p.x + Math.round(p.anchor.x);
    const cy = p.y + Math.round(p.anchor.y);
    const solid = await js(`window.__petTest.isInteractableAt(${cx}, ${cy})`);
    results.push({ name: '按下点落在宠物实体像素(右键场景)', ok: solid === true });

    const before = await js('window.__petTest.petPos()');
    // 模拟“长按右键弹菜单”→ 主菜单弹出瞬间渲染层通常还停在按压态（右 mouseup 被吞）
    await js(`window.__petTest.beginPress(2, ${cx}, ${cy})`);
    const residue = await js('window.__petTest.menuState()');
    results.push({ name: '右键按住 → 残留按压态', ok: residue.buttonDown === true && residue.idle === false });

    // 弹菜单 / 菜单关闭时执行的清理
    await js('window.__petTest.menuCleanup()');
    const clean = await js('window.__petTest.menuState()');
    results.push({
      name: '清理后手势复位(idle/无按键/无拖动/无抓取)',
      ok: clean.idle === true && clean.buttonDown === false && clean.dragging === false && clean.grabOffset === null,
    });

    // 关键回归：清理后即使指针越过宠物，人物也不能被拖/吸到光标
    await js(`window.__petTest.strayMove(${cx + 60}, ${cy + 8})`);
    await sleep(40);
    const pos = await js('window.__petTest.petPos()');
    const after = await js('window.__petTest.menuState()');
    results.push({ name: '残留移动不把人物吸走', ok: Math.abs(pos.x - before.x) < 0.001 && Math.abs(pos.y - before.y) < 0.001 });
    results.push({ name: '不残留拖动状态', ok: after.dragging === false });

    return assertMap(results);
  },

  /**
   * 应用内“添加音乐”（bug3）：不再走系统文件对话框，改成与“添加图片”完全一致的面板
   * 流程 —— 打开音乐选择器 → 列到音频 → 选中 → “把这首加入播放列表” → 真实拷贝进
   * assets → 播放列表 +1 → 回推列表 → 若当前没在播则自动开播。面板保持打开可连续加。
   */
  async audio(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];
    const dir = process.env.PET_AUDIO_DIR;
    const fname = nodePath.basename(process.env.PET_AUDIO_PATH || '');
    if (!dir || !fname) { console.error('[scenario] 缺 PET_AUDIO_DIR / PET_AUDIO_PATH'); return false; }

    await js(`window.__petTest.openPicker('audio', ${JSON.stringify(dir)})`);
    await waitFor(js, `window.__petTest.pickerFiles().names.length > 0`, 6000, '音频选择器列到文件');
    const listed = await js(`window.__petTest.pickerFiles().names`);
    results.push({ name: `音乐选择器列出音频(${fname})`, ok: Array.isArray(listed) && listed.some((n) => n === fname) });

    // 选中并点“把这首加入播放列表”
    await js(`(() => {
      const rows = Array.from(document.querySelectorAll('#petPicker .pk-item'));
      const row = rows.find((el) => el.textContent === ${JSON.stringify(fname)}) || rows[0];
      row.click();
    })()`);
    await sleep(120);
    await js(`document.getElementById('pkUse').click()`);

    // 真实链路：audio:addFiles → 拷贝进 assets → playlist +1 → audio:list 回推
    await waitFor(js, `window.__petState().audio.playlistCount >= 1`, 6000, '加入播放列表');
    const a1 = await js('window.__petState().audio');
    results.push({ name: `加入播放列表(playlistCount=${a1.playlistCount})`, ok: a1.playlistCount >= 1 });

    // 若当前没在播则自动开播：Audio 元素已建、带源、处于播放态
    await waitFor(js, `(() => { const a = window.__petState().audio; return a.hasEl && a.paused === false; })()`, 6000, '自动开播');
    const a2 = await js('window.__petState().audio');
    results.push({ name: '自动开播(playing、未暂停)', ok: a2.hasEl === true && a2.playing === true && a2.paused === false });

    // 音频面板不自动关（像换图/换背景那样可连续加）；Esc 可关
    const open = await js('window.__petState().petPickerOpen');
    results.push({ name: '面板保持打开(可连续添加)', ok: open === true });
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    const closed = await js('window.__petState().petPickerOpen');
    results.push({ name: 'Esc 关闭面板', ok: closed === false });

    return assertMap(results);
  },

  /**
   * 物理模拟开关：关闭后释放/甩动都不再启动物理，人物停在原地不下坠；
   * 重新打开后同一位置的低速释放应当正常坠落（验证开关真的接回了路由）。
   */
  async physOff(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    await js('window.__petTest.setPhysicsEnabled(false)');
    let st = await js('window.__petState()');
    results.push({ name: '物理开关已关闭(physicsEnabled=false)', ok: st.physicsEnabled === false });

    const groundY = st.world.h - st.pet.h;
    const x0 = Math.max(0, Math.round(st.world.w / 2 - st.pet.w / 2));
    const airY = groundY - 240;

    // ① 低速空中释放 → 不坠落，悬在原地
    await js(`window.__petTest.placePet(${x0}, ${airY})`);
    await js('window.__petTest.releaseRel(0, 0, 50)');
    await sleep(400);
    st = await js('window.__petState()');
    results.push({
      name: `物理关·低速空中释放不坠落(y=${st.pet.y.toFixed(0)}≈${airY}, phys=${st.physActive})`,
      ok: st.physActive === false && Math.abs(st.pet.y - airY) < 0.5,
    });

    // ② 甩动释放 → 也不抛掷，仍原地停
    await js('window.__petTest.releaseRel(1500, -1500, 2200)');
    await sleep(400);
    st = await js('window.__petState()');
    results.push({
      name: `物理关·甩动也不抛(phys=${st.physActive}, y不变)`,
      ok: st.physActive === false && Math.abs(st.pet.y - airY) < 0.5,
    });

    // ③ 重新打开物理 → 同一位置的低速释放应当坠落并回到地面（开关确实接回路由）
    await js('window.__petTest.setPhysicsEnabled(true)');
    await js(`window.__petTest.placePet(${x0}, ${airY})`);
    await js('window.__petTest.releaseRel(0, 0, 60)');
    await waitFor(js, 'window.__petState().physActive === true', 3000, '物理关恢复后低速释放启动物理');
    await waitFor(js, 'window.__petState().physActive === false', 8000, '落地静止');
    st = await js('window.__petState()');
    // 像素级碰撞：落地静止位 = 区域高 - 碰撞盒底边偏移（不是 区域高 - 图高）
    const colBottom = st.pet.col.oy + st.pet.col.h;
    const landY = st.world.h - colBottom;
    results.push({
      name: `物理开·低速释放坠落并落地(y=${st.pet.y.toFixed(0)}≈${Math.round(landY)})`,
      ok: Math.abs(st.pet.y - landY) < 3,
    });

    return assertMap(results);
  },

  /**
   * “休息”（新功能，右键菜单）：透明度在 25%↔75% 间正弦渐变往返，结束时体力回满、
   * 闪烁停止、透明度恢复正常 1。自动化用短时长/快周期（restShort）验证，不真等 30s；
   * 闪烁证据 = 采样 petOpacity 跨过完整周期出现明显高低变化。
   */
  async rest(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];
    await js('window.__petTest.setAffinityRng(0.99)');

    // 预置低体力，结束时应回满 100
    await js('window.__petTest.setStatus({ energy: 12 })');
    await sleep(80);
    let st = await js('window.__petState()');
    results.push({ name: `预置低体力 energy=${st.status.energy.toFixed(0)}`, ok: st.status.energy <= 13 });

    // 短休息：dur 3000ms、period 220ms（跨多个正弦往返，有足够窗口做“中途互动”检查），上下限显式 25%/75%
    await js('window.__petTest.restShort(3000, 220, 0.25, 0.75)');
    const r0 = await js('window.__petTest.restState()');
    results.push({
      name: '开始休息(active=true, 从下限附近起)',
      ok: r0.active === true && r0.min === 0.25 && r0.max === 0.75 && r0.opacity <= 0.30,
    });

    // 采样透明度 ~300ms（>1 个周期）→ 应有从低到高的明显往返（正弦到两端）
    let lo = 1, hi = 0;
    for (let i = 0; i < 12; i++) {
      await sleep(25);
      const s = await js('window.__petTest.restState()');
      if (!s.active) break;
      lo = Math.min(lo, s.opacity);
      hi = Math.max(hi, s.opacity);
    }
    results.push({
      name: `闪烁往返 25↔75(lo=${lo.toFixed(3)} hi=${hi.toFixed(3)})`,
      ok: hi - lo > 0.30 && lo <= 0.40 && hi >= 0.60,
    });

    // 休息中互动（喂食）→ onStatusInteract 会 applyStatusVisual，但不得打断闪烁/复位不透明
    await js('window.__petTest.feed()');
    await sleep(80);
    const mid = await js('window.__petTest.restState()');
    results.push({
      name: '休息中互动后仍 active、透明度仍在 [0.25,0.75]',
      ok: mid.active === true && mid.opacity >= 0.249 && mid.opacity <= 0.751,
    });

    // 等结束：闪烁停、体力回满、透明度恢复 1
    await waitFor(js, 'window.__petTest.restState().active === false', 3000, '休息结束');
    st = await js('window.__petState()');
    const rr = await js('window.__petTest.restState()');
    results.push({
      name: `休息结束体力回满 energy=${st.status.energy.toFixed(1)}、opacity=${st.petOpacity}`,
      ok: st.status.energy >= 99.5 && st.petOpacity === '1' && rr.active === false,
    });

    return assertMap(results);
  },

  /**
   * 学习菜单三件套（2026-09-14 新增）：主菜单结构 + 番茄钟 + 学习计划表 + 语音聊天设置。
   *  · 主菜单：一级「学习」就位（学英语/番茄钟/学习计划表），学英语**已从聊天子菜单移出**，聊天新增语音聊天设置
   *  · 番茄钟：默认 25:00 → 开始计时 → 暂停 → 自定义时长 → 落盘 settings.pomodoro
   *  · 计划表：添加 → 渲染 → 落盘 settings.planner → 勾选完成 → 删除；右下角桌宠主图装饰已加载
   *  · 语音设置：后台唤醒开关 + 唤醒词 + **按键说话键位（点一下→按键→录制）** → 保存 →
 *    落盘 settings.voice，并给出关键词串预览
   * 说明：本场景**不依赖语音模型/麦克风**（语音只验设置面板与持久化），任何机器都能跑。
   */
  async learn(ctx) {
    const { js, sleep, execIn, waitForWin, mainState } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    // ---------- ① 主菜单结构 ----------
    const menu = (ctx.mainMenu() || []).filter((m) => m.id);
    const byId = Object.fromEntries(menu.map((m) => [m.id, m]));
    results.push({ name: '主菜单：新增一级「学习」', ok: !!byId.learn && byId.learn.label === '学习' });
    results.push({
      name: `主菜单：学习 ▸ ${byId.learn ? byId.learn.children.join('/') : '(缺失)'}`,
      ok: !!byId.learn && JSON.stringify(byId.learn.children) === JSON.stringify(['english', 'pomodoro', 'planner']),
    });
    results.push({
      name: `主菜单：聊天 ▸ ${byId.chat ? byId.chat.children.join('/') : '(缺失)'}`,
      ok: !!byId.chat && JSON.stringify(byId.chat.children) === JSON.stringify(['chatOpen', 'chatSettings', 'voiceSettings']),
    });
    const order = menu.map((m) => m.id);
    results.push({ name: '主菜单：学习紧跟聊天之后（学英语已移出聊天）', ok: order.indexOf('learn') === order.indexOf('chat') + 1 });

    // ---------- ② 番茄钟 ----------
    ctx.openPomodoro();
    await waitForWin('pomodoroWin');
    const clock0 = await execIn('pomodoroWin', `document.getElementById('clock').textContent`);
    results.push({ name: `番茄钟：默认时长 25:00（实际 ${clock0}）`, ok: clock0 === '25:00' });
    const chips = await execIn('pomodoroWin', `Array.from(document.querySelectorAll('#preFocus .chip')).map((b) => b.textContent)`);
    results.push({ name: `番茄钟：预设快捷按钮(${chips.join('/')})`, ok: Array.isArray(chips) && chips.length >= 3 });

    await execIn('pomodoroWin', `document.getElementById('toggleBtn').click()`);
    await sleep(600);
    const runningLbl = await execIn('pomodoroWin', `document.getElementById('toggleBtn').textContent`);
    const clock1 = await execIn('pomodoroWin', `document.getElementById('clock').textContent`);
    results.push({ name: `番茄钟：开始计时(按钮=${runningLbl} 显示=${clock1})`, ok: runningLbl === '暂停' && clock1 !== clock0 });
    await execIn('pomodoroWin', `document.getElementById('toggleBtn').click()`); // 暂停
    await sleep(150);
    const pausedLbl = await execIn('pomodoroWin', `document.getElementById('toggleBtn').textContent`);
    results.push({ name: `番茄钟：可暂停(按钮=${pausedLbl})`, ok: pausedLbl === '继续' });

    // 自定义时长 → 保存 → 落盘
    await execIn('pomodoroWin', `(() => { const i = document.getElementById('inFocus'); i.value = '33'; i.dispatchEvent(new Event('change')); })()`);
    await execIn('pomodoroWin', `document.getElementById('saveBtn').click()`);
    await sleep(350);
    let st = mainState();
    const clock2 = await execIn('pomodoroWin', `document.getElementById('clock').textContent`);
    results.push({ name: '番茄钟：自定义时长落盘 settings.pomodoro', ok: !!(st.pomodoro && st.pomodoro.focusMin === 33) });
    results.push({ name: `番茄钟：改时长后倒计时同步 33:00（实际 ${clock2}）`, ok: clock2 === '33:00' });

    // ---------- ③ 学习计划表（含桌宠主图装饰） ----------
    ctx.openPlanner();
    await waitForWin('plannerWin');
    await execIn('plannerWin', `document.getElementById('text').value = '背 50 个单词'`);
    await execIn('plannerWin', `document.getElementById('addBtn').click()`);
    await sleep(350);
    const rowsExpr = `Array.from(document.querySelectorAll('#list .row')).map((r) => ({
      tx: r.querySelector('.tx').textContent, done: r.classList.contains('done'),
    }))`;
    let rows = await execIn('plannerWin', rowsExpr);
    results.push({ name: `计划表：添加并渲染(${JSON.stringify(rows[0] || null)})`, ok: rows.length === 1 && rows[0].tx === '背 50 个单词' && rows[0].done === false });
    st = mainState();
    results.push({
      name: '计划表：持久化到 settings.planner',
      ok: !!(st.planner && st.planner.items.length === 1 && st.planner.items[0].text === '背 50 个单词' && /^\d{4}-\d{2}-\d{2}$/.test(st.planner.items[0].date)),
    });

    const deco = await execIn('plannerWin', `(() => {
      const d = document.getElementById('deco');
      return { src: (d.getAttribute('src') || '').slice(0, 16), h: Math.round(d.getBoundingClientRect().height),
               pe: getComputedStyle(d).pointerEvents };
    })()`);
    results.push({ name: `计划表：桌宠主图缩小作装饰(高=${deco.h}px, ${deco.src}…)`, ok: deco.src.startsWith('data:image') && deco.h > 8 });
    results.push({ name: '计划表：装饰层不吃鼠标事件（纯装饰）', ok: deco.pe === 'none' });

    await execIn('plannerWin', `document.querySelector('#list .row .ck').click()`);
    await sleep(350);
    rows = await execIn('plannerWin', rowsExpr);
    st = mainState();
    results.push({ name: '计划表：勾选完成（划线 + 落盘）', ok: rows[0].done === true && st.planner.items[0].done === true });
    const prog = await execIn('plannerWin', `document.getElementById('prog').textContent`);
    results.push({ name: `计划表：当天进度显示(${prog})`, ok: /完成 1\/1/.test(prog) });

    await execIn('plannerWin', `document.querySelector('#list .row .delBtn').click()`);
    await sleep(350);
    rows = await execIn('plannerWin', rowsExpr);
    st = mainState();
    results.push({ name: '计划表：删除条目', ok: rows.length === 0 && st.planner.items.length === 0 });

    // ---------- ④ 语音聊天设置 ----------
    ctx.openVoiceSettings();
    await waitForWin('voiceSettingsWin');
    // 2026-09-16：不再有"4 种触发方式"（升级成语音对话）；**按键说话当晚恢复**（键位 + 全局键都回来了）
    const wakeOn = await execIn('voiceSettingsWin', `document.getElementById('wakeEnabled').checked`);
    results.push({ name: `语音设置：后台唤醒默认开(${wakeOn})`, ok: wakeOn === true });
    const noModes = await execIn('voiceSettingsWin', `document.querySelectorAll('input[name=vmode]').length`);
    results.push({ name: '语音设置：没有"触发方式"单选（已升级为语音对话）', ok: noModes === 0 });
    // 键位框必须在；默认键位必须是 Ctrl+Shift+Space，**不能**是 Ctrl+空格（那是输入法的中英切换）
    const key0 = await execIn('voiceSettingsWin', `document.getElementById('keyLocal').textContent`);
    results.push({ name: `语音设置：聊天窗内键位框(${key0})`, ok: key0 === 'Ctrl + Shift + Space' });
    const keyG0 = await execIn('voiceSettingsWin', `document.getElementById('keyGlobal').textContent`);
    results.push({ name: '语音设置：全局键默认"未设置"（不替用户占按键）', ok: /未设置/.test(keyG0) });

    // 键位录制：点一下框 → 按一个键 → 记下来（用合成事件驱动，**不需要真按键**）
    await execIn('voiceSettingsWin', `document.getElementById('keyGlobal').click()`);
    const recTxt = await execIn('voiceSettingsWin', `document.getElementById('keyGlobal').textContent`);
    results.push({ name: `语音设置：点击后进入录制态(${recTxt})`, ok: recTxt === '请按键…' });
    // 只按修饰键应被拒绝（否则会录到"半个键"）
    await execIn('voiceSettingsWin', `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft', ctrlKey: true, bubbles: true, cancelable: true })); })()`);
    const stillRec = await execIn('voiceSettingsWin', `document.getElementById('keyGlobal').textContent`);
    results.push({ name: '语音设置：只按修饰键不记录（需再配一个主键）', ok: stillRec === '请按键…' });
    await execIn('voiceSettingsWin', `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F8', bubbles: true, cancelable: true })); })()`);
    const keyG = await execIn('voiceSettingsWin', `document.getElementById('keyGlobal').textContent`);
    results.push({ name: `语音设置：全局键被记录为(${keyG})`, ok: keyG === 'F8' });

    await execIn('voiceSettingsWin', `(() => { const w = document.getElementById('wakeWord'); w.value = '小助手'; w.dispatchEvent(new Event('input')); })()`);
    await sleep(150);
    const kwLine = await execIn('voiceSettingsWin', `document.getElementById('kwLine').textContent`);
    results.push({ name: `语音设置：唤醒词音素串预览(${kwLine.slice(0, 46)}…)`, ok: kwLine.includes('@小助手') && !kwLine.includes('（空）') });

    // 关掉后台唤醒 + 保留刚录的全局键 → 一起落盘
    await execIn('voiceSettingsWin', `(() => { const c = document.getElementById('wakeEnabled'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
    await execIn('voiceSettingsWin', `document.getElementById('saveBtn').click()`);
    await sleep(400);
    st = mainState();
    results.push({
      name: '语音设置：唤醒开关 + 唤醒词 + 全局键位落盘 settings.voice',
      ok: !!(st.voice && st.voice.wake.enabled === false && st.voice.wake.word === '小助手'
        && st.voice.wake.tokens === '' && st.voice.ptt && st.voice.ptt.globalKey === 'F8'
        && !('mode' in st.voice)),
    });
    await execIn('voiceSettingsWin', `document.getElementById('revertBtn').click()`); // 还原默认
    await sleep(400);
    results.push({ name: '语音设置：可一键还原默认', ok: mainState().voice === null });

    // ---------- 收尾：关窗 ----------
    await execIn('pomodoroWin', `window.close()`);
    await execIn('plannerWin', `window.close()`);
    await execIn('voiceSettingsWin', `window.close()`);
    await sleep(200);

    return assertMap(results);
  },

  /**
   * L1：透明 + 置顶的宠物窗**不许**让其它 Chromium 窗口掉帧或冻结。
   *
   * 原来这条只能"有真机的人打开两个窗口用肉眼盯"，结论不可重放、改一次窗口层级就得重看一遍。
   * 这里把它换成可数的事：在被测窗口里跑一个 requestAnimationFrame 计数循环，分两种状态各采样一段
   *    ① 宠物窗**隐藏**（对照组）② 宠物窗**显示且在动**（被测状态）
   * ② 塌到接近 0、或比对照组掉一半以上，就是冻结/严重掉帧。
   *
   * ⚠ 两个必须守住的前提，否则测出来的是假数据：
   *  - **隐藏页会被 Chromium 节流 rAF**，所以采样期间被测窗口必须真的显示着（不能最小化/移出屏幕）。
   *    因此先拿对照组的帧率当"测量本身可信"的门槛：对照组本来就不画的话，② 怎么低都不算结论。
   *  - 宠物窗有常驻渲染循环（呼吸/弹簧），"在动"是它本来就有的状态，不需要额外驱动。
   */
  async occlusion(ctx) {
    const { js, sleep, execIn, waitForWin, mainState } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];
    const MS = 1500;

    ctx.openTodo();
    await waitForWin('todoWin');
    await sleep(300);

    // 计数器装在待办窗里：它是个普通不透明窗口，正是"被置顶透明窗压在下面"的那一方
    await execIn('todoWin', `(() => {
      window.__frames = 0; window.__rafOn = true;
      (function loop() { if (!window.__rafOn) return; window.__frames++; requestAnimationFrame(loop); })();
      return true;
    })()`);
    const sample = async () => {
      await execIn('todoWin', 'window.__frames = 0');
      await sleep(MS);
      return await execIn('todoWin', 'window.__frames');
    };

    // ② 先测被测态（宠物窗一启动就是显示着的），再关它测对照组，最后必须开回来，
    //    否则这条场景会把后面复用的窗口留在隐藏态。
    const withPet = await sample();
    ctx.hidePet();
    await sleep(300);
    const noPet = await sample();
    ctx.showPet();
    await sleep(300);
    const backAgain = await sample();

    await execIn('todoWin', 'window.__rafOn = false');

    results.push({ name: `对照组真的在画（宠物窗隐藏时 ${noPet} 帧/${MS}ms）—— 不然这测量不可信`, ok: noPet >= 10 });
    results.push({ name: `宠物窗显示且在动时另一窗口没有冻结（${withPet} 帧）`, ok: withPet > 0 });
    results.push({ name: `掉帧不超过对照组的一半（${withPet} vs 对照 ${noPet}）`, ok: withPet >= noPet * 0.5 });
    results.push({ name: `宠物窗重新显示后帧率恢复（${backAgain} 帧）`, ok: backAgain >= noPet * 0.5 });
    results.push({ name: '收尾时宠物窗已恢复显示', ok: mainState().visible === true });

    await execIn('todoWin', `window.close()`);
    return assertMap(results);
  },
};

module.exports = { scenarios, waitFor };
