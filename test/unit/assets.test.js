'use strict';
/**
 * 内置占位素材的一致性守卫（火柴人，由 npm run assets:gen 生成）。
 *
 * 为什么常驻测：换形态、插眨眼帧、播特效帧都按"包围盒底边中点"对齐（app.js
 * applyBody / showFrameBody —— 打字状态三张图的交替也走 applyBody），素材本身只要脚底或
 * 中轴偏一点，切换就会原地跳位；
 * 带色彩档案块则会让同像素的不同素材出现肉眼色差（见 util.js stripPngColorChunks）。
 * 这些都不是跑单测能顺带发现的，所以按文件锁死。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { decodePng } = require('../../src/shared/png');
const { analyzeBitmap, scalePlan } = require('../../src/shared/geom');
const { CFG } = require('../../src/shared/config');

const ROOT = path.join(__dirname, '..', '..');
const A = (...p) => path.join(ROOT, ...p);

/** 素材清单：三张主素材 + 形态三三张图（config.typing）+ config.effectAnim 的全部特效帧
 *  （路径与应用同源，不会各说各话）。 */
function builtinAssets() {
  const fx = [];
  for (const g of CFG.effectAnim.groups) {
    for (const f of g.frames) fx.push({ label: `${g.name}/${path.basename(f)}`, file: A('src', 'renderer', f) });
  }
  const ty = (CFG.typing.frames || []).concat([CFG.typing.idleFrame]).map((f, i) => ({
    label: `打字态${i < 2 ? `图${i + 1}` : '·不打字图'}`, file: A('src', 'renderer', f),
  }));
  return [
    { label: '主图 pet.png', file: A('src', 'assets', 'pet.png') },
    { label: '状态图 state.png', file: A('src', 'assets', 'state.png') },
    { label: '眨眼图 blink.png', file: A('src', 'assets', 'blink.png') },
    ...ty,
    ...fx,
  ];
}

function load(file) {
  const buf = fs.readFileSync(file);
  return { buf, bm: decodePng(buf) };
}

/** PNG 顶层块名（按 chunk 结构走，不看像素）。 */
function chunkTypes(buf) {
  const types = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    types.push(buf.toString('ascii', off + 4, off + 8));
    off += 12 + len;
    if (types[types.length - 1] === 'IEND') break;
  }
  return types;
}

test('内置素材齐全：主图/状态图/眨眼图 + 形态三三张图 + config 声明的每一帧特效', () => {
  for (const a of builtinAssets()) {
    assert.ok(fs.existsSync(a.file), `素材缺失：${a.label} → ${a.file}`);
    assert.ok(fs.statSync(a.file).size > 0, `素材为空文件：${a.label}`);
  }
  assert.ok(CFG.effectAnim.groups.length > 0, '特效组被清空会让 smoke 的 fxGroups>0 断言失去意义');
  // 形态三的构成写死在这里：两张打字帧（随按键交替）+ 一张不打字图（停手后显示）
  assert.equal(CFG.typing.frames.length, 2, '打字态必须恰好两张交替帧');
  assert.equal(builtinAssets().length, 6 + CFG.effectAnim.groups.reduce((n, g) => n + g.frames.length, 0));
});

test('全部素材同画布、有可交互像素、脚底与中轴逐张对齐', () => {
  let ref = null;
  for (const a of builtinAssets()) {
    const { bm } = load(a.file);
    assert.strictEqual(bm.width, 320, `${a.label} 画布宽`);
    assert.strictEqual(bm.height, 320, `${a.label} 画布高`);
    const an = analyzeBitmap(bm, CFG.image.alphaThreshold);
    assert.ok(an.hasPixels, `${a.label} 没有可交互像素（会被判成全透明）`);
    const feet = an.bbox.y1;
    const cx = (an.bbox.x0 + an.bbox.x1) / 2;
    if (!ref) ref = { label: a.label, feet, cx };
    assert.strictEqual(feet, ref.feet, `${a.label} 脚底基线偏离 ${ref.label}（${feet} ≠ ${ref.feet}）→ 换形态/插帧会上下跳`);
    // 中轴允许 3px（320 画布 → 220 显示不足 2px）：单手挥手的帧只有一侧手臂举起，包围盒天然略偏
    assert.ok(Math.abs(cx - ref.cx) < 3, `${a.label} 中轴偏离 ${ref.label}（${cx} ≠ ${ref.cx}）→ 会横向跳位`);
  }
});

test('素材不含色彩档案块，且四角全透明（透明处点击穿透）', () => {
  for (const a of builtinAssets()) {
    const { buf, bm } = load(a.file);
    const extra = chunkTypes(buf).filter((t) => t !== 'IHDR' && t !== 'IDAT' && t !== 'IEND');
    assert.deepStrictEqual(extra, [], `${a.label} 含额外块 ${extra.join(',')}（gAMA/iCCP/cHRM/sRGB 会导致色差）`);
    for (const [x, y] of [[0, 0], [319, 0], [0, 319], [319, 319]]) {
      assert.strictEqual(bm.data[(y * bm.width + x) * 4 + 3], 0, `${a.label} 角上 (${x},${y}) 不透明`);
    }
  }
});

test('眨眼图与主图只差眼睛区域：身体轮廓必须逐像素一致', () => {
  const pet = load(A('src', 'assets', 'pet.png')).bm;
  const blink = load(A('src', 'assets', 'blink.png')).bm;
  assert.strictEqual(pet.data.length, blink.data.length);
  // 眼睛带：主图睁眼椭圆 y≈57~67，闭眼下弯弧 clip 到 y≈60~70，各留 AA 余量
  const BAND = { x0: 120, y0: 48, x1: 200, y1: 78 };
  let diff = 0;
  for (let y = 0; y < pet.height; y++) {
    for (let x = 0; x < pet.width; x++) {
      const o = (y * pet.width + x) * 4;
      const same = pet.data[o] === blink.data[o] && pet.data[o + 1] === blink.data[o + 1] &&
        pet.data[o + 2] === blink.data[o + 2] && pet.data[o + 3] === blink.data[o + 3];
      if (same) continue;
      diff++;
      const inBand = x >= BAND.x0 && x <= BAND.x1 && y >= BAND.y0 && y <= BAND.y1;
      assert.ok(inBand, `眼睛带之外第 (${x},${y}) 像素不同 → 眨眼会改变身体轮廓`);
    }
  }
  assert.ok(diff > 200, `眼睛区域几乎没差别（${diff} 像素）→ 眨眼看不出来`);
});

test('主图按 petMaxDim 显示不放大，且留足 exe 图标尺寸', () => {
  const { bm } = load(A('src', 'assets', 'pet.png'));
  const plan = scalePlan(bm.width, bm.height, CFG.image.petMaxDim);
  assert.ok(plan.scale < 1, '内置主图应大于显示上限（缩样有余量）');
  assert.strictEqual(Math.max(plan.width, plan.height), CFG.image.petMaxDim);
  assert.ok(Math.min(bm.width, bm.height) >= 256, '主图短边不足 256，切不出 exe 图标的最大档');
});
