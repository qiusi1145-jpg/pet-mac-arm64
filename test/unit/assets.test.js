'use strict';
/**
 * 内置素材的一致性守卫（2026-10-02 起为手绘素材，不再是 assets:gen 画的火柴人）。
 *
 * 为什么常驻测：主图 ↔ 打字两帧 ↔ 三种自动动画帧全都按"不透明像素包围盒的底边中点"对齐
 * （app.js 的 applyBody / showFrameBody 共用这一条基准）。素材本身只要脚底或中轴偏一点，
 * 切换就会原地跳位；而"某一帧其实是另一张图/整张空白"这种错，人眼看缩略图很容易漏过去。
 *
 * 阈值全部来自实测（不是拍脑袋）：
 *   画布 2048×2048；脚底 y=1355~1357；中轴 x=1088~1089；不透明像素 925,604~952,218；
 *   与主图在重叠区差异 >20 的像素 23,874~75,273。
 * ⚠ 比较必须只看"至少一边不透明"的像素：PNG 允许全透明像素底下留着任意 RGB，
 *   逐字节全图比较会把 type2.png 报成"71% 不同"（实测踩过），而那是完全看不见的差异。
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
const TH = () => CFG.image.alphaThreshold;

/** 素材清单：主图 + 自动动画每一帧（config.autoAnim）+ 打字两帧（config.typing）。
 *  路径与应用同源（都以 src/renderer 为基准的 "../assets/…"），不会各说各话。 */
function builtinAssets() {
  const out = [{ label: '主图 pet.png', file: A('src', 'assets', 'pet.png') }];
  for (const g of CFG.autoAnim.groups) {
    for (const f of g.frames) out.push({ label: `${g.name}/${path.basename(f)}`, file: A('src', 'renderer', f) });
  }
  for (const f of CFG.typing.frames) {
    out.push({ label: `打字帧/${path.basename(f)}`, file: A('src', 'renderer', f) });
  }
  return out;
}

const cache = new Map();
function load(file) {
  if (!cache.has(file)) {
    const buf = fs.readFileSync(file);
    cache.set(file, { buf, bm: decodePng(buf) });
  }
  return cache.get(file);
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

/** 只在"至少一边不透明"的像素上，统计与主图差异超过 minDelta 的像素数 + 轮廓增减数。 */
function diffAgainstMain(main, other) {
  const t = TH();
  let big = 0, compared = 0, added = 0, removed = 0;
  for (let i = 0; i < other.data.length; i += 4) {
    const mo = main.data[i + 3] > t, oo = other.data[i + 3] > t;
    if (!mo && !oo) continue;                 // 两边都透明：底下的 RGB 是垃圾值，不比
    if (mo !== oo) { if (oo) added++; else removed++; }
    if (mo && oo) {
      compared++;
      const d = Math.max(
        Math.abs(main.data[i] - other.data[i]),
        Math.abs(main.data[i + 1] - other.data[i + 1]),
        Math.abs(main.data[i + 2] - other.data[i + 2]),
        Math.abs(main.data[i + 3] - other.data[i + 3]),
      );
      if (d > 20) big++;
    }
  }
  return { big, compared, added, removed };
}

test('内置素材齐全：主图 + 自动动画每一帧 + 打字两帧，且组数/帧数符合设计', () => {
  for (const a of builtinAssets()) {
    assert.ok(fs.existsSync(a.file), `素材缺失：${a.label} → ${a.file}`);
    assert.ok(fs.statSync(a.file).size > 0, `素材为空文件：${a.label}`);
  }
  const groups = CFG.autoAnim.groups;
  assert.ok(groups.length >= 3, `自动动画至少三组（实测三组），现在 ${groups.length}`);
  // 三种动画的帧数是 1 / 1 / 2 —— 这条设计写死在这里，素材改名/合并时测试会先叫
  assert.deepEqual(groups.map((g) => g.frames.length), [1, 1, 2],
    '三种自动动画的帧数必须是 1/1/2（用户 2026-10-02 定稿）');
  assert.equal(CFG.typing.frames.length, 2, '打字态必须恰好两张交替帧');
  assert.equal(CFG.typing.idleFrame, undefined, '第三张"不打字"图已删除：停手回主图');
});

test('全部素材同画布、有可交互像素、脚底与中轴逐张对齐', () => {
  const { bm: ref } = load(A('src', 'assets', 'pet.png'));
  for (const a of builtinAssets()) {
    const { bm } = load(a.file);
    assert.strictEqual(bm.width, ref.width, `${a.label} 画布宽与主图不同 → 缩放/对齐假设全废`);
    assert.strictEqual(bm.height, ref.height, `${a.label} 画布高与主图不同`);
    const an = analyzeBitmap(bm, TH());
    assert.ok(an.hasPixels, `${a.label} 没有可交互像素（会被判成全透明）`);
    const feet = an.bbox.y1;
    const cx = (an.bbox.x0 + an.bbox.x1) / 2;
    // 实测脚底 1355~1357、中轴 1088~1089；容差给到 4/3px（2048 画布缩到 386 显示 < 0.8px）
    assert.ok(Math.abs(feet - ref.height) <= ref.height, `${a.label} 脚底基线异常`);
    const refAn = analyzeBitmap(ref, TH());
    assert.ok(Math.abs(feet - refAn.bbox.y1) <= 4,
      `${a.label} 脚底偏离主图 ${feet - refAn.bbox.y1}px（>4）→ 换图会上下跳`);
    assert.ok(Math.abs(cx - (refAn.bbox.x0 + refAn.bbox.x1) / 2) <= 3,
      `${a.label} 中轴偏离主图 → 换图会横向跳位`);
  }
});

test('每一帧都是"同一个角色的轻微变化"：既真在动，又没变成另一张图', () => {
  const { bm: ref } = load(A('src', 'assets', 'pet.png'));
  const refAn = analyzeBitmap(ref, TH());
  const refArea = (refAn.bbox.x1 - refAn.bbox.x0) * (refAn.bbox.y1 - refAn.bbox.y0);
  for (const a of builtinAssets().slice(1)) {
    const { bm } = load(a.file);
    const d = diffAgainstMain(ref, bm);
    // 真的在动：至少 1 万个像素明显变化（实测最小 23,874）
    assert.ok(d.big > 10000, `${a.label} 与主图几乎没差别（${d.big}）→ 这帧播出来看不出来`);
    // 还是同一个角色：变化不超过重叠区的 15%（实测最大 8%），且轮廓增减 < 8%
    assert.ok(d.big < d.compared * 0.15, `${a.label} 与主图差异过大（${d.big}/${d.compared}）→ 像是另一张图`);
    assert.ok(d.added + d.removed < refArea * 0.08,
      `${a.label} 轮廓变化过大（新增 ${d.added} / 消失 ${d.removed}）→ 换图会看到剪影跳变`);
  }
});

test('素材只允许 IHDR/pHYs/IDAT/IEND：不带色彩块、不带编辑软件元数据', () => {
  // 色彩块（gAMA/iCCP/cHRM/sRGB）会让同像素显出不同色；
  // 元数据块（iTXt/tEXt/zTXt/eXIf/tIME）里是 Adobe XMP 与 EXIF —— 1~1.7KB/张的制作信息，
  // 不该随分发包出去。pHYs 只是 DPI，留着无害且不影响像素，所以放进白名单。
  const ALLOWED = ['IHDR', 'pHYs', 'IDAT', 'IEND'];
  for (const a of builtinAssets()) {
    const { buf, bm } = load(a.file);
    const extra = chunkTypes(buf).filter((t) => !ALLOWED.includes(t));
    assert.deepStrictEqual(extra, [], `${a.label} 含不该有的块 ${extra.join(',')}`);
    const w = bm.width, h = bm.height;
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      assert.strictEqual(bm.data[(y * w + x) * 4 + 3], 0, `${a.label} 角上 (${x},${y}) 不透明`);
    }
  }
});

test('主图按 petMaxDim 显示不放大，且留足 exe 图标尺寸', () => {
  const { bm } = load(A('src', 'assets', 'pet.png'));
  const plan = scalePlan(bm.width, bm.height, CFG.image.petMaxDim);
  assert.ok(plan.scale < 1, '内置主图应大于显示上限（缩样有余量）');
  assert.strictEqual(Math.max(plan.width, plan.height), CFG.image.petMaxDim);
  assert.ok(Math.min(bm.width, bm.height) >= 256, '主图短边不足 256，切不出 exe 图标的最大档');
});
