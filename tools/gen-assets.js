'use strict';
/**
 * 内置素材的**占位图**生成器：火柴人（线条 + 一张脸）。
 *
 * ⚠ src/assets/ 里现在放的是**正式手绘素材**（2048 见方画布），本脚本只在文件缺失时补一张
 *   320 见方的火柴人占位，且**绝不覆盖已存在的图**（幂等，见 main() 里的 existsSync 分支）。
 *   出图清单共 7 张，路径全部取自 config（生成器 / assets.test.js 守卫 / 应用加载三方同源）：
 *     src/assets/pet.png      主图 = 站姿 + 睁眼
 *     src/assets/anim1.png    自动动画①（单帧）
 *     src/assets/anim2.png    自动动画②（单帧）
 *     src/assets/anim3-1.png / anim3-2.png  自动动画③（两帧）
 *     src/assets/type1.png    打字帧1 = 双手搭在"键盘"横线上（略低头）
 *     src/assets/type2.png    打字帧2 = 右手抬起（每按一下键盘与图1 交替一次）
 *   占位姿势只是"能动就行"，与手绘美术不是同一套；真图缺失才会生成，别指望它出美术效果。
 *
 * 一致性红线（脚本末尾自检 + test/unit/assets.test.js 常驻守卫）：
 *  - 同一画布、同一脚底基线、同一中轴 → 换图/插帧不跳位；所以姿势一律左右对称，
 *    挥手帧举起的右手也不越过站姿手部的横向范围（否则包围盒中轴随手掌摆）；
 *  - 只写 IHDR/IDAT/IEND，无色彩档案块（否则与无档案素材出现肉眼色差）；
 *  - 线条实心段 alpha=255，远高于 CFG.image.alphaThreshold（透明处点击穿透）。
 *
 * 用法：npm run assets:gen   （产出提交进仓库，应用运行时不依赖本脚本；重跑幂等）
 */
const fs = require('fs');
const path = require('path');
const { encodePng, decodePng } = require('../src/shared/png');
const { analyzeBitmap } = require('../src/shared/geom');
const { CFG } = require('../src/shared/config');

const ROOT = path.join(__dirname, '..');
const SIZE = 320;      // 占位图画布边长（显示上限 CFG.image.petMaxDim 现为 270，320 略大 → 会被缩到 270）。
                       // 改这个数要连骨架坐标一起缩放（全按 320 写死）；正式手绘是 2048，两者别混用。
const SS = 4;          // 超采样倍数（细线条靠它抗锯齿）
const CX = 160;        // 中轴
const INK = [52, 58, 68];
const W = 9;           // 线条粗细（头圈/躯干/四肢共用）
const HW = W / 2;
const HEAD_R = 30;

/* ================= 覆盖率基元（都按"到中心线的距离"给一个 alpha） ================= */

const distSeg = (x, y, ax, ay, bx, by) => {
  const bax = bx - ax, bay = by - ay;
  const dd = bax * bax + bay * bay || 1e-6;
  let h = ((x - ax) * bax + (y - ay) * bay) / dd;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  return Math.hypot(x - (ax + bax * h), y - (ay + bay * h));
};
const ramp = (d) => (d <= -0.5 ? 1 : d >= 0.5 ? 0 : 0.5 - d); // 1px 过渡带
/** 圆头端点的粗线段 = 火柴人的一节肢体。 */
const stroke = (a, b) => (x, y) => ramp(distSeg(x, y, a[0], a[1], b[0], b[1]) - HW);
/** 指定半宽的线段（"键盘"横线要比肢体细，否则像一根杠铃）。 */
const strokeW = (a, b, hw) => (x, y) => ramp(distSeg(x, y, a[0], a[1], b[0], b[1]) - hw);
/** 圆环 = 头。 */
const ring = (c, r) => (x, y) => ramp(Math.abs(Math.hypot(x - c[0], y - c[1]) - r) - HW);
/** 实心点 = 眼睛（与另两个基元同向：中心线内为负 → 不透明）。 */
const dot = (c, r) => (x, y) => ramp(Math.hypot(x - c[0], y - c[1]) - r);
/** 圆环取 [a0,a1] 度的一段 = 笑嘴 / 闭眼线（角度 0=右、90=下）。 */
const arc = (c, r, a0, a1, w) => (x, y) => {
  const dx = x - c[0], dy = y - c[1];
  let a = Math.atan2(dy, dx) * 180 / Math.PI;
  if (a < 0) a += 360;
  if (a < a0 || a > a1) return 0;
  return ramp(Math.abs(Math.hypot(dx, dy) - r) - w / 2);
};

/* ================= 骨架：站姿基准，各姿势只改端点 ================= */
/* 每条肢体 = [肩/髋, 肘/膝, 手/脚] 三个端点；只写左侧，右侧镜像（非对称姿势另给 armR）。 */

const IDLE = {
  head: [CX, 62], neck: [CX, 92], hip: [CX, 198],
  armL: [[CX, 112], [126, 152], [114, 190]],
  legL: [[CX, 198], [138, 248], [133, 295]],
};
const POSES = {
  idle: IDLE,
  armsUp: { ...IDLE, armL: [[CX, 112], [128, 84], [120, 50]] },
  // 挥手：左臂照旧垂着（它的横向范围是包围盒左边界），右臂举到肩侧三帧摆动；
  // 三帧右臂外沿都刻意顶到同一横向位置，否则包围盒中轴会随手掌摆进摆出而偏 → 插帧瞬间人物横移
  wave: [
    { ...IDLE, armR: [[CX, 112], [202, 94], [208, 62]] },
    { ...IDLE, armR: [[CX, 112], [206, 98], [188, 66]] },
    { ...IDLE, armR: [[CX, 112], [204, 96], [210, 72]] },
  ],
  // 打字两帧：图1 双手搭在"键盘"横线上、图2 右手抬起（每按一下键盘两者交替），停手回主图。
  // 两张都刻意保持左右横向对称：包围盒中轴一偏，换帧瞬间人物会横移；腿一律沿用 IDLE，
  // 脚底基线才逐张相同（换图原地不动）。kb:true = 画键盘横线。
  type1: { ...IDLE, head: [CX, 68], neck: [CX, 96], armL: [[CX, 112], [130, 150], [142, 168]], kb: true },
  type2: { ...IDLE, head: [CX, 68], neck: [CX, 96], armL: [[CX, 112], [130, 150], [142, 168]],
    armR: [[CX, 112], [190, 150], [178, 136]], kb: true },
  // 起跳三帧：脚底基线不动，靠屈膝/伸直/低头表达蓄力-上冲-落地
  jump: [
    { ...IDLE, head: [CX, 74], neck: [CX, 104], hip: [CX, 206],
      armL: [[CX, 120], [128, 156], [136, 192]], legL: [[CX, 206], [132, 250], [133, 295]] },
    { ...IDLE, head: [CX, 52], neck: [CX, 82], hip: [CX, 194],
      armL: [[CX, 100], [126, 68], [120, 34]], legL: [[CX, 194], [140, 244], [135, 295]] },
    { ...IDLE, head: [CX, 78], neck: [CX, 108], hip: [CX, 210],
      armL: [[CX, 124], [120, 160], [108, 190]], legL: [[CX, 210], [130, 252], [133, 295]] },
  ],
};
const mir = (pts) => pts.map(([x, y]) => [2 * CX - x, y]);

/** 姿势 → 线条采样函数数组。 */
function figure(P) {
  const armL = P.armL || IDLE.armL, armR = P.armR || mir(armL);
  const legL = P.legL || IDLE.legL, legR = mir(legL);
  const f = [ring(P.head, HEAD_R), stroke(P.neck, P.hip)];
  for (const a of [armL, armR]) f.push(stroke(a[0], a[1]), stroke(a[1], a[2]));
  for (const l of [legL, legR]) f.push(stroke(l[0], l[1]), stroke(l[1], l[2]));
  // "键盘"横线：左右各伸出一点但关于中轴对称（不对称会让换帧时人物横移）
  if (P.kb) f.push(strokeW([112, 176], [208, 176], 3));
  return f;
}

/** 脸：睁眼 = 两个点，闭眼 = 两条下弯短弧；嘴一律同一条笑弧。 */
const FACE = {
  mouth: [arc([CX, 60], 13, 25, 155, 4.4)],
  open: [dot([149, 55], 4), dot([171, 55], 4)],
  closed: [arc([149, 51], 8, 25, 155, 4), arc([171, 51], 8, 25, 155, 4)],
};

/* ================= 光栅化 ================= */

function render(body, face) {
  const feats = [...body, ...FACE.mouth, ...face];
  const bm = { width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4) };
  const inv = 1 / (SS * SS);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let A = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS, y = py + (sy + 0.5) / SS;
          let m = 0;
          for (const f of feats) { const c = f(x, y); if (c > m) m = c; }
          A += m;
        }
      }
      const a = A * inv;
      if (a <= 0) continue;
      const o = (py * SIZE + px) * 4;
      bm.data[o] = INK[0]; bm.data[o + 1] = INK[1]; bm.data[o + 2] = INK[2];
      bm.data[o + 3] = a >= 1 ? 255 : Math.round(a * 255);
    }
  }
  return bm;
}

/* ================= 出图清单 ================= */

/* 出图清单（2026-10-02 单形态改版后）：
 *  src/assets/ 里现在是**正式手绘素材**，本脚本只在文件缺失时补一张火柴人占位，
 *  绝不覆盖已存在的图（见 main() 里的 existsSync 分支）—— 之前是无条件 writeFileSync，
 *  谁跑一次 `npm run assets:gen` 就会把正式美术洗成占位图。
 *  路径全部取自 config（生成器 / assets.test.js 守卫 / 应用加载三方同源）。 */
const SHOTS = [
  { name: '主图', file: path.join('src', 'assets', 'pet.png'), pose: POSES.idle, face: FACE.open },
];
// 自动动画的三种（帧数 1/1/2）：路径取 config.autoAnim.groups
CFG.autoAnim.groups.forEach((g, gi) => {
  g.frames.forEach((fp, fi) => {
    const pose = [POSES.idle, POSES.armsUp, POSES.wave, POSES.jump][(gi * 2 + fi) % 4];
    SHOTS.push({
      name: `${g.name} 第${fi + 1}帧`,
      file: path.join(ROOT, 'src', 'renderer', fp), pose, face: fi % 2 ? FACE.closed : FACE.open,
    });
  });
});
// 打字两帧：路径取 config.typing.frames（第三张"不打字"图已删除，停手回主图）
{
  const poses = [POSES.type1, POSES.type2];
  const files = CFG.typing.frames || [];
  if (files.length !== poses.length) {
    throw new Error(`config.typing 需要恰好 2 张打字帧，实际 ${files.length} 项`);
  }
  files.forEach((fp, i) => SHOTS.push({
    name: `打字帧${i + 1}`, file: path.join(ROOT, 'src', 'renderer', fp), pose: poses[i], face: FACE.open,
  }));
}

function chunksOf(buf) {
  const out = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    out.push(buf.toString('ascii', off + 4, off + 8));
    off += 12 + len;
    if (out[out.length - 1] === 'IEND') break;
  }
  return out;
}

function main() {
  const t0 = Date.now();
  const rows = [];
  const made = [];
  const skipped = [];
  let ref = null;
  for (const s of SHOTS) {
    const abs = path.isAbsolute(s.file) ? s.file : path.join(ROOT, s.file);
    // 已存在的图一律不动：src/assets/ 里是正式手绘素材，覆盖一次就没了
    if (fs.existsSync(abs)) { skipped.push(s.name); continue; }
    const buf = encodePng(render(figure(s.pose), s.face));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    const back = decodePng(buf);
    const an = analyzeBitmap(back, CFG.image.alphaThreshold);
    if (!an.hasPixels) throw new Error(`${s.name} 全透明，没有可交互像素`);
    const bad = chunksOf(buf).filter((c) => c !== 'IHDR' && c !== 'IDAT' && c !== 'IEND');
    if (bad.length) throw new Error(`${s.name} 含色彩档案块：${bad.join(',')}`);
    const feet = an.bbox.y1, cx = (an.bbox.x0 + an.bbox.x1) / 2;
    if (!ref) ref = { name: s.name, feet, cx };
    made.push(s.name);
    rows.push({ name: s.name, file: path.relative(ROOT, abs).split(path.sep).join('/'),
      dim: `${back.width}×${back.height}`, kb: (buf.length / 1024).toFixed(1),
      bbox: `${an.bbox.x0},${an.bbox.y0}→${an.bbox.x1},${an.bbox.y1}`, feet, cx: cx.toFixed(1) });
  }
  if (rows.length) {
    console.table(rows);
    const off = rows.filter((r) => r.feet !== ref.feet || Math.abs(r.cx - ref.cx) > 2);
    console.log(`新生成 ${made.length} 张；基准：脚底 y=${ref.feet}、中轴 x=${ref.cx.toFixed(1)}（${ref.name}）；偏离对齐的：${off.length ? off.map((d) => d.name).join(', ') : '无'}`);
    if (off.length) process.exitCode = 1;
  }
  // 跨素材的一致性（同画布 / 脚底 / 中轴 / 无色彩块）由 test/unit/assets.test.js 常驻守卫，
  // 这里不重复判 —— 占位图与手绘图混在一条基准里比反而会误报。
  console.log(`新生成 ${made.length} 张，跳过已存在 ${skipped.length} 张（共 ${SHOTS.length}），用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (skipped.length) console.log(`  已存在、未覆盖：${skipped.join(', ')}`);
}

main();
