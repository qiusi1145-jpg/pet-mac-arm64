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

    // 基线：弹簧静止归 1（读弹簧 sy；绘制缩放=弹簧×呼吸，呼吸另测）
    const base = await js('window.__petState().animScale.sy');
    results.push({ name: '基线弹簧 sy≈1', ok: Math.abs(base - 1) < 0.03 });

    // 摸头 → sy 出现明显压缩（Q 弹）
    await js('window.__petTest.headpat()');
    let minSy = 1;
    for (let i = 0; i < 14; i++) {
      await sleep(45);
      const s = await js('window.__petState().animScale.drawnSy');
      if (s < minSy) minSy = s;
    }
    results.push({ name: `摸头压缩明显(min=${minSy.toFixed(3)}<0.95)`, ok: minSy < 0.95 });

    // 一段时间后弹簧收敛回 1（动画没有失控/停止）；呼吸是独立叠加波，不干扰此判断
    await sleep(2400);
    const after = await js('window.__petState().animScale.sy');
    results.push({ name: `Q弹弹簧收敛回 1(|${after.toFixed(3)}-1|<0.04)`, ok: Math.abs(after - 1) < 0.04 });

    // 待机呼吸在动：采一个整周期以上（满周期必含一个波峰+波谷 → 跨幅≈2A）
    let lo = 1, hi = 1;
    for (let i = 0; i < 48; i++) { await sleep(100); const v = await js('window.__petState().animScale.drawnSy'); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    results.push({ name: `呼吸在动(hi-lo=${(hi - lo).toFixed(4)} 期望≈0.03)`, ok: hi - lo > 0.02 });

    // 状态胶囊折叠/展开
    await js('document.getElementById("pill").click()');
    const c1 = await js('window.__petState().pillCollapsed');
    await js('document.getElementById("pill").click()');
    const c2 = await js('window.__petState().pillCollapsed');
    results.push({ name: `胶囊折叠=${c1}→展开=${c2}`, ok: c1 === true && c2 === false });

    return assertMap(results);
  },

  /** 眨眼：视觉层闭眼图可显示/隐藏，且判定区域不因此变化。 */
  async blink(ctx) {
    const { js } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const r = await js(`(() => {
      const T = window.__petTest;
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
    return r.visible && r.hidden && r.hitWhileVisible === true && r.hitWhileHidden === true;
  },

  /** 状态图：只切换视觉层，不改变点击判定。 */
  async stateVisual(ctx) {
    const { js } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const r = await js(`(() => {
      const T = window.__petTest;
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
      const status0 = T.state().status;
      const shown = T.toggleStateVisual();
      const visible = document.getElementById('state').style.display === 'block';
      const hitWhileVisible = T.isInteractableAt(hit.x, hit.y);
      const status1 = T.state().status;
      const hiddenAgain = !T.toggleStateVisual();
      const hitWhileHidden = T.isInteractableAt(hit.x, hit.y);
      const status2 = T.state().status;
      return { shown, visible, hitWhileVisible, status1, hiddenAgain, hitWhileHidden, status2, status0 };
    })()`);
    const sameStatus = (a, b) => a && b &&
      a.mood === b.mood && a.energy === b.energy && a.satiety === b.satiety && a.affinity === b.affinity;
    return r.shown === true && r.visible === true && r.hitWhileVisible === true &&
      r.hiddenAgain === true && r.hitWhileHidden === true &&
      sameStatus(r.status0, r.status1) && sameStatus(r.status0, r.status2);
  },

  /**
   * 锁定并保持始终置于顶层（功能 4）：锁定 → 主进程置顶级别切换为 screen-saver、
   * 整窗强制穿透（即使光标在宠物实体像素上）、托盘出现“解锁（保底入口）”；
   * 解锁 → 恢复 floating 常规置顶与正常穿透语义、托盘文本更新。
   */
  async lock(ctx) {
    const { js, sleep, mainState } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    let ms = mainState();
    results.push({ name: `初始未锁定且为常规置顶(level=${ms.lockLevel})`, ok: ms.locked === false && ms.lockLevel === 'floating' });

    // 锁定（渲染层长按 3s 的切换路径）
    await js('window.__petTest.toggleLock()');
    await sleep(200);
    ms = mainState();
    results.push({ name: `锁定后用最高置顶级别(level=${ms.lockLevel})`, ok: ms.locked === true && ms.lockLevel === 'screen-saver' });
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

    // 解锁：恢复常规置顶 + 穿透语义 + 托盘文本
    await js('window.__petTest.toggleLock()');
    await sleep(200);
    ms = mainState();
    results.push({ name: `解锁恢复常规置顶(level=${ms.lockLevel})`, ok: ms.locked === false && ms.lockLevel === 'floating' });
    results.push({ name: '托盘文本为“锁定并保持始终置于顶层”', ok: ms.trayLabels.includes('锁定并保持始终置于顶层') });
    const unlockedHit = await js(probe);
    results.push({ name: '解锁后实体像素恢复可交互', ok: !!unlockedHit && unlockedHit.ignore === false && unlockedHit.interactive === true });

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

    // 等它落地回待机（最多 9s），最终静止在地面
    try {
      await waitFor(js, 'window.__petState().physActive === false', 9000, '物理结束');
    } catch (e) {
      const dbg = await js(`(() => { const s = window.__petState(); return { phys: s.phys, pet: s.pet, world: s.world, pre: ${JSON.stringify(pre)} }; })()`);
      console.error(`[scenario] dragPhysics 超时，最后状态: ${JSON.stringify(dbg)}`);
      throw e;
    }
    const st = await js('window.__petState()');
    const floorY = st.world.h - st.pet.h;
    results.push({
      name: `落地回待机且在地面(y=${st.pet.y.toFixed(0)}≈${Math.round(floorY)})`,
      ok: Math.abs(st.pet.y - floorY) < 3,
    });
    return assertMap(results);
  },

  /** 窗口吸附：低速释放靠近某窗口顶沿 → 挂到该顶沿；窗口消失 → 失去支撑坠落。 */
  async snap(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    const st0 = await js('window.__petState()');
    const anchor = st0.pet.anchor;      // 实体像素中心（内容坐标）
    const petH = st0.pet.h;
    const winTop = 260;                 // 假窗口顶沿（屏幕坐标，region 在 0,0）
    // 摆好宠物：让锚点恰落在窗口顶沿附近
    const placeY = winTop - anchor.y - 8;
    await js(`window.__petTest.placePet(${st0.pet.x}, ${placeY})`);
    await js(`window.__petTest.setSnapWindows([{ id:'fake-win', cls:'Notepad', title:'test', left:0, top:${winTop}, right:${st0.world.w}, bottom:900, minimized:false }])`);

    const snapped = await js('window.__petTest.trySnap()');
    results.push({ name: '低速靠近窗口顶沿 → 吸附成功', ok: snapped === true });
    const info = await js('window.__petTest.snapInfo()');
    results.push({ name: '吸附记录窗口句柄', ok: !!info && info.handle === 'fake-win' });
    // 底边贴窗口顶：pet.y(内容) = (top - originY) - petH = winTop - petH
    const st = await js('window.__petState()');
    results.push({
      name: `吸附后底边贴窗口顶(y=${st.pet.y.toFixed(0)}≈${winTop - petH})`,
      ok: Math.abs(st.pet.y - (winTop - petH)) < 1,
    });

    // 窗口仍在 → 不脱落
    await js('window.__petTest.pollSnap()');
    await sleep(30);
    const still = await js('window.__petTest.snapInfo()');
    results.push({ name: '窗口未移动/关闭 → 保持吸附', ok: !!still });

    // 窗口消失 → 失去支撑坠落（物理接管）
    await js('window.__petTest.setSnapWindows([])');
    await js('window.__petTest.pollSnap()');
    await sleep(40);
    const st2 = await js('window.__petState()');
    results.push({ name: `窗口消失 → 解除吸附并坠落(phys=${st2.physActive})`, ok: st2.physActive === true && !st2.snap });

    await js('window.__petTest.setSnapWindows(null)');
    // 等落地回待机（不要残留物理/吸附干扰后续）
    await waitFor(js, 'window.__petState().physActive === false', 8000, '落地静止');
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
   * 应用内图片选择器（更换宠物不再依赖系统文件对话框，红线1不回归）：
   * 打开 → 列到 fixture 图片 → 面板参与命中判定 → 选中并“设为宠物”→ 走真实
   * 导入/解码/替换路径 → 替换成功且面板自动关闭。
   */
  async picker(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];
    const dir = nodePath.dirname(process.env.PET_PET_PATH);

    await js(`window.__petTest.openPicker('pet', ${JSON.stringify(dir)})`);
    await waitFor(js, `window.__petTest.pickerFiles().names.length > 0`, 6000, 'picker 列到图片');
    const st = await js(`(() => {
      const T = window.__petTest;
      const rect = document.getElementById('petPicker').getBoundingClientRect();
      const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return { open: T.state().petPickerOpen, hit: T.isInteractableAt(c.x, c.y), names: T.pickerFiles().names };
    })()`);
    results.push({ name: `选择器已打开 open=${st.open}`, ok: st.open === true });
    results.push({ name: '选择器面板参与命中（指针在其上不穿透）', ok: st.hit === true });
    results.push({ name: `列到 fixture 图片(${st.names && st.names.length})`, ok: Array.isArray(st.names) && st.names.some((n) => /pet-96/.test(n)) });

    // 选中 pet-96.png（fixtures 里还有全透明的 blank-16，别点到它）→ 点“把这张设为宠物”
    const petName = nodePath.basename(process.env.PET_PET_PATH);
    await js(`(() => {
      const rows = Array.from(document.querySelectorAll('#petPicker .pk-item'));
      const row = rows.find((el) => el.textContent === ${JSON.stringify(petName)}) || rows[0];
      row.click();
    })()`);
    await sleep(120);
    await js(`document.getElementById('pkUse').click()`);
    await waitFor(js, `window.__petState().petPickerOpen === false`, 8000, '替换成功后选择器自动关闭');
    const okPet = await js(`window.__petState().petLoaded`);
    results.push({ name: '替换后宠物仍处于加载态', ok: okPet === true });

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
    const groundY = st.world.h - st.pet.h;
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
   * 物理模拟开关（新功能）：关闭后释放/甩动都不再启动物理，人物停在原地不下坠；
   * 但“低速贴近窗口顶沿 → 吸附”仍工作（吸附独立于物理开关）；已吸附窗口消失时也不坠落。
   */
  async physOff(ctx) {
    const { js, sleep } = ctx;
    await waitFor(js, 'window.__petReady && window.__petState().petLoaded', 12000, 'renderer ready + pet');
    const results = [];

    // 关掉物理；先注入“没有窗口”，避免吸附误触影响“停原地”的断言
    await js('window.__petTest.setPhysicsEnabled(false)');
    await js('window.__petTest.setSnapWindows([])');
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
      ok: st.physActive === false && Math.abs(st.pet.y - airY) < 0.5 && st.snap === null,
    });

    // ③ 物理关下吸附仍工作：靠近假窗口顶沿、低速释放（走 routeRelease）→ 吸上，且不坠落
    const anchor = st.pet.anchor;
    const petH = st.pet.h;
    const winTop = 180;
    const placeY = winTop - anchor.y - 8;
    await js(`window.__petTest.placePet(${x0}, ${placeY})`);
    await js(`window.__petTest.setSnapWindows([{ id:'fake-win', cls:'Notepad', title:'test', left:0, top:${winTop}, right:${st.world.w}, bottom:900, minimized:false }])`);
    await js('window.__petTest.releaseRel(0, 0, 60)'); // 低速 → routeRelease 仍尝试吸附
    await waitFor(js, 'window.__petTest.snapInfo() !== null', 3000, '物理关·低速释放仍可吸附');
    const info = await js('window.__petTest.snapInfo()');
    st = await js('window.__petState()');
    results.push({
      name: `物理关·吸附仍工作(handle=${info && info.handle}, phys=${st.physActive})`,
      ok: !!info && info.handle === 'fake-win' && st.physActive === false,
    });

    // ④ 假窗口消失 → 解除吸附；但物理关 → 不坠落（悬在原处）
    const snappedY = st.pet.y;
    await js('window.__petTest.setSnapWindows([])');
    await js('window.__petTest.pollSnap()');
    await sleep(150);
    st = await js('window.__petState()');
    results.push({
      name: `物理关·吸附解除但不坠落(y=${st.pet.y.toFixed(0)}≈${snappedY.toFixed(0)}, snap=${!!st.snap})`,
      ok: st.snap === null && st.physActive === false && Math.abs(st.pet.y - snappedY) < 0.5,
    });

    await js('window.__petTest.setSnapWindows(null)');
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
};

module.exports = { scenarios, waitFor };
