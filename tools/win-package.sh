#!/bin/sh
# Windows 打包脚本 —— 产出**双击即用的 桌宠.exe**（标准 Electron 分发布局，不是 .bat + 源码树）。
#
# 用法：
#   sh tools/win-package.sh            # 默认 x64
#   sh tools/win-package.sh x64
#
# 产出布局：
#   dist/桌宠-win-x64/
#     桌宠.exe                    ← 用户双击的就是它（electron.exe 改名，PE 架构在 [6] 真验）
#     *.dll / *.pak / locales/    ← Electron 运行时（摊平，与官方打包产物同构）
#     resources/app/              ← 应用本体（package.json + src/ + 生产依赖），Electron 自动从这里起
#     resources/app/data/         ← 用户数据（设置/素材副本/日志/语音模型），整目录搬走数据跟着走
#     启动桌宠-调试.bat            ← 带控制台启动（PET_DEBUG=1），排查用
#
# 与 mac 侧同一条纪律：全量替换装配 → 装配后自检 → **把测试打到这个 exe 上**，三步缺一不算打完。
#
# ⚠ 刻意不带（每条都有原因，不是嫌麻烦）：
#   · resources/app/data/ 里的任何东西 —— 上一版就是包内 data/assets/pet/pet.png 把新主图盖成了旧火柴人。
#   · 语音模型（161MB）—— 缺模型时应用按设计优雅隐藏语音，不该由安装包代下载。
#   · node_modules/electron、dev 依赖 —— exe 已经摊平在包根，再带一份 node_modules 等于把应用装两遍，
#     两份代码迟早漂移（这是所有"改了没生效"类事故的共同来源）。
#   · .git/ out/ dist/ 新逻辑新素材/ 一键打包脚本*/
set -u
ARCH=${1:-x64}
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
OUT="$ROOT/dist/桌宠-win-$ARCH"
APP="$OUT/resources/app"
FAILED=0
die()  { echo "❌ $*" >&2; FAILED=1; }
ok()   { echo "✓ $*"; }
warn() { echo "⚠ $*"; }

case "$ARCH" in
  x64) WANT_MACHINE=34404; SHERPA=sherpa-onnx-win-x64 ;;   # 0x8664
  x86) WANT_MACHINE=332;   SHERPA=sherpa-onnx-win-ia32 ;;  # 0x014c
  *) echo "架构参数只能是 x64 或 x86（收到：$ARCH）"; exit 2 ;;
esac

echo "########## 桌宠 Windows 打包：$ARCH（双击 exe）##########"
echo "源目录: $ROOT"
echo "产出:   $OUT"

# ---------- 1. 源树红线自检 ----------
echo ""; echo "===== [1] 源树自检 ====="
for f in src/assets/pet.png src/assets/anim1.png src/assets/anim2.png src/assets/anim3-1.png \
         src/assets/anim3-2.png src/assets/type1.png src/assets/type2.png src/shared/autoAnim.js; do
  [ -s "$ROOT/$f" ] || die "源树缺 $f —— 对应功能在包里会静默失效"
done
for f in src/assets/blink.png src/assets/state.png src/assets/type-idle.png src/shared/blink.js; do
  [ -e "$ROOT/$f" ] && die "源树还留着已删除的 $f —— 会被一起拷进包"
done
[ -s "$ROOT/node_modules/electron/dist/electron.exe" ] || die "开发树里没有 node_modules/electron/dist/electron.exe，没东西可摊平"
[ "$FAILED" -eq 0 ] || { echo "源树自检没过，先修源树再打包。"; exit 1; }
ok "内置素材 7 张齐全，旧素材/旧模块不在源树，Electron 运行时在位"

# ---------- 2. 全量替换装配（先删干净，只替换一部分是偷懒）----------
echo ""; echo "===== [2] 清空并装配 ====="
rm -rf "$OUT" || die "清不出干净目录：$OUT"
mkdir -p "$OUT" || exit 1
cp -R "$ROOT/node_modules/electron/dist/." "$OUT/" || die "摊平 Electron 运行时失败"
mkdir -p "$APP" || exit 1
mv "$OUT/electron.exe" "$OUT/桌宠.exe" || die "改不出 桌宠.exe"
# default_app 是靠命令行参数找应用的兜底逻辑；有了 resources/app 就不该再有它，
# 留着只会让"到底起的哪份代码"变成第二个问题（包内若残留第二份 src，就是这种漂移的温床）。
if [ -f "$OUT/resources/default_app.asar" ]; then
  rm -f "$OUT/resources/default_app.asar" && ok "已移除 resources/default_app.asar（入口唯一）"
else
  warn "没有 default_app.asar（新版布局可能变了，确认一下 exe 确实会从 resources/app 起）"
fi
for item in src package.json package-lock.json README.md 版本日志.md; do
  [ -e "$ROOT/$item" ] && cp -R "$ROOT/$item" "$APP/$item" || die "拷贝失败：$item"
done
mkdir -p "$APP/data"
printf '@echo off\r\nrem 调试启动：留住控制台看 [main] 日志。正常使用时直接双击 桌宠.exe 即可。\r\ncd /d "%%~dp0"\r\nset PET_DEBUG=1\r\n"%%~dp0桌宠.exe" %%*\r\npause\r\n' > "$OUT/启动桌宠-调试.bat"
ok "运行时 + resources/app（src/文档/空 data/）+ 调试启动器就位"

# ---------- 3. 生产依赖（按 package.json 走，不手写清单）----------
echo ""; echo "===== [3] 生产依赖 ====="
node -e '
const fs = require("fs"), path = require("path");
const ROOT = process.cwd(), APP = process.argv[1], ARCH = process.argv[2], SHERPA = process.argv[3];
const NM = path.join(ROOT, "node_modules");
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
const pkg = read(path.join(ROOT, "package.json"));
// 从 package.json 声明的依赖出发做闭包遍历：dependencies 全收，optionalDependencies 只在
// "本机真的装了"时收（否则会把 darwin/linux 的平台包也拖进来），并强制收本平台那份原生包。
const queue = Object.keys(pkg.dependencies || {});
if (fs.existsSync(path.join(NM, SHERPA))) queue.push(SHERPA);
const seen = new Set(), missing = [];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const from = path.join(NM, name);
  if (!fs.existsSync(from)) { missing.push(name); continue; }
  fs.cpSync(from, path.join(APP, "node_modules", name), { recursive: true });
  const p = read(path.join(from, "package.json"));
  for (const d of Object.keys(p.dependencies || {})) queue.push(d);
  for (const d of Object.keys(p.optionalDependencies || {})) if (fs.existsSync(path.join(NM, d))) queue.push(d);
}
for (const n of [...seen].sort()) console.log("  带进包：" + n);
if (missing.length) { console.error("  声明了但本机没装：" + missing.join(", ")); process.exit(3); }
' "$APP" "$ARCH" "$SHERPA"
[ $? -eq 0 ] || die "生产依赖拷贝失败（package.json 里声明的依赖本机不全在）"
# 不止解析路径：**真的在包内加载一次**原生模块（缺一个 .dll 就在这里暴露，而不是等用户开语音）
if [ -s "$APP/node_modules/sherpa-onnx-node/package.json" ]; then
  node -e '
    const m = require(process.argv[1] + "/node_modules/sherpa-onnx-node");
    const k = Object.keys(m);
    if (!k.length) process.exit(4);
    console.log("✓ 包内加载 sherpa-onnx-node 成功，导出 " + k.length + " 项");
  ' "$APP" || die "包内加载不动语音原生模块（多半是缺了本平台的 sherpa-onnx-win-*.dll）"
else
  warn "包内没有 sherpa-onnx-node（package.json 已不声明？）—— 语音将不可用，其余功能不受影响"
fi

# ---------- 4. 排除项复核 ----------
echo ""; echo "===== [4] 排除项复核 ====="
for bad in "$APP/data/assets" "$APP/语音模块" "$APP/新逻辑新素材" "$OUT/.git" "$OUT/out"; do
  [ -e "$bad" ] && die "包里出现了不该有的 $bad"
done
[ -e "$OUT/src" ] && die "包根还残留一份 src/ —— 与 resources/app/src 是两份代码，迟早漂移"
[ -e "$OUT/node_modules" ] && die "包根还残留 node_modules/（exe 已摊平，不该再带第二套依赖）"
ok "用户数据 / 语音模型 / 源素材 / 第二份代码 均未随包出去"

# ---------- 5. 包内自检 ----------
echo ""; echo "===== [5] 包内自检 ====="
EXE="$OUT/桌宠.exe"
if [ ! -f "$EXE" ]; then
  die "入口不存在：$EXE"
else
  off=$(od -An -j60 -N4 -tu4 < "$EXE" | tr -d ' \n')
  machine=$(od -An -j$((off + 4)) -N2 -tu2 < "$EXE" | tr -d ' \n')
  [ "$machine" = "$WANT_MACHINE" ] && ok "桌宠.exe 就位，PE 机器型 = $machine（目标 $ARCH）" \
    || die "桌宠.exe 机器型 = ${machine:-没读到}，目标是 $ARCH（应为 $WANT_MACHINE）—— 用户双击会报「不是有效的 Win32 应用」"
fi
[ -s "$APP/package.json" ] || die "resources/app/package.json 不在 —— exe 找不到入口，双击只会打开默认页"
N1=$(find "$ROOT/src" -type f | wc -l | tr -d ' '); N2=$(find "$APP/src" -type f | wc -l | tr -d ' ')
[ "$N2" = "0" ] && die "自检根本没扫到文件，不能当成通过"
[ "$N1" = "$N2" ] && ok "resources/app/src 文件数与源树一致（$N2）" \
  || die "src 文件数不一致：源树 $N1 vs 包内 $N2 —— 拷贝被吞了"
for f in src/renderer/index.html src/main/main.js src/shared/config.js src/assets/pet.png src/assets/anim3-2.png; do
  [ -s "$APP/$f" ] || die "包内缺 $f"
done
du -sh "$OUT" 2>/dev/null | awk '{print "  当前体积: "$1}'

# ---------- 6. 把测试打到这个 exe 上 ----------
# 开发树里的 harness + PET_ELECTRON_BIN 指向包内 exe：验的是交付物本身，不是开发树。
echo ""; echo "===== [6] 跑交付物（L2 冒烟硬门 + L1 三个视觉场景）====="
if PET_ELECTRON_BIN="$EXE" node test/smoke/smoke.js > out/win-exe-smoke.log 2>&1; then
  grep -q "SMOKE_OK" out/win-exe-smoke.log \
    && ok "桌宠.exe：$(grep -o 'animGroups=[0-9]* typeFrames=[0-9]*' out/win-exe-smoke.log | head -1) 冒烟硬门通过" \
    || die "退出码 0 但日志里没有 SMOKE_OK —— 判据没落到实处"
else
  die "桌宠.exe 冒烟失败，详见 out/win-exe-smoke.log（末 15 行）"; tail -15 out/win-exe-smoke.log
fi
if PET_ELECTRON_BIN="$EXE" PET_UI_ONLY=anim,autoAnim,typing node test/ui/ui.test.js > out/win-exe-ui.log 2>&1 \
   && grep -q "UI_ALL_PASS" out/win-exe-ui.log; then
  ok "桌宠.exe：L1 视觉场景全过（$(grep -c 'SCENARIO .* PASS' out/win-exe-ui.log) 个；$(grep -o '缩放串最后改写于 [0-9.]*s' out/win-exe-ui.log | head -1)）"
else
  die "桌宠.exe 的 L1 没过，详见 out/win-exe-ui.log"; grep -E "SCENARIO|断言失败" out/win-exe-ui.log | tail -12
fi

# ---------- 7. 汇总 ----------
echo ""; echo "########## 汇总 ##########"
du -sh "$OUT" 2>/dev/null | awk '{print "包体积: "$1}'
if [ "$FAILED" -eq 0 ]; then
  ok "打包完成：$OUT（用户双击 桌宠.exe）"
  echo ""
  echo "分发（Windows）："
  echo "  · 整个 $OUT 目录压成 zip 发出去；解压到任意文件夹，双击「桌宠.exe」即可，免安装、免 Node"
  echo "  · 排查问题用「启动桌宠-调试.bat」（留住控制台看 [main] 日志）"
  echo "  · 用户数据在 resources\\app\\data\\（设置、素材副本、日志）；整个文件夹可以直接搬走"
  echo "  · 语音默认不可用；要语音就把模型放进 resources\\app\\data\\voice\\models\\"
  echo "  · 换主图 = 覆盖 resources\\app\\src\\assets\\pet.png（画布/留白与内置素材不同会让打字换图跳位，见 README「换图即定制」）"
  echo "  ⚠ 图标与 exe 版本信息仍是 Electron 默认（改这两样要 rcedit，本机没有且需要联网下载）。"
  echo "    要「带图标的单文件 Setup.exe 安装包」就说一声，我加 electron-builder 走 NSIS。"
  exit 0
else
  die "打包有问题，见上面 ❌ 项"
  exit 1
fi
