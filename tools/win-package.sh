#!/bin/sh
# Windows 便携包（免安装）装配脚本 —— 与 mac 侧 tools/mac-package.sh 同一条思路：
#   全量替换装配 → 装配后自检 → **真跑一遍包里的产物**，三步缺一不算打完。
#
# 用法：
#   sh tools/win-package.sh            # 默认 x64
#   sh tools/win-package.sh x64
#
# 产出目录就是「启动桌宠.bat」期望的布局，用户整目录拷走双击即可，不需要 Node、不需要 npm：
#   dist/桌宠-win-x64/
#     启动桌宠.bat / 启动桌宠-调试.bat
#     node_modules/electron/dist/electron.exe   ← 双击跑的就是它（PE 架构在 [5] 里真验）
#     src/  package.json  package-lock.json     ← 应用本体（launcher 传 "%~dp0."）
#     test/ 工具与文档                            ← 包内就能跑回归
#     data/                                       ← 空的用户数据目录
#
# ⚠ 刻意**不带**的东西（带了会出事，见每条后面的原因）：
#   · data/          —— 用户数据 + 可能残留的旧素材。上一版就是因为包里 data/assets/pet/pet.png
#                       盖住了新内置主图，用户看到的还是旧火柴人。
#   · 语音模块/       —— 161MB 模型；缺模型时应用按设计优雅隐藏语音，不该由安装包代下载。
#   · 新逻辑新素材/ 一键打包脚本*/ .git/ out/ dist/ —— 源材料/外部工具/仓库噪声，不是运行时。
set -u
ARCH=${1:-x64}
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
OUT="$ROOT/dist/桌宠-win-$ARCH"
FAILED=0
die()  { echo "❌ $*" >&2; FAILED=1; }
ok()   { echo "✓ $*"; }
warn() { echo "⚠ $*"; }

case "$ARCH" in
  x64) WANT_MACHINE=34404 ;;      # 0x8664
  x86) WANT_MACHINE=332 ;;        # 0x014c
  *) echo "架构参数只能是 x64 或 x86（收到：$ARCH）"; exit 2 ;;
esac

echo "########## 桌宠 Windows 打包：$ARCH ##########"
echo "源目录: $ROOT"
echo "产出:   $OUT"

# ---------- 1. 源树红线自检 ----------
# 装配前先看源树本身完不完整：缺帧 → 组作废（动画少一种）；残留旧素材/旧模块 → 包里带着
# 已删除的实现，用户机上表现为"旧图盖新图"或加载歧义。宁可不打，也不要打出个半成品。
echo ""; echo "===== [1] 源树自检 ====="
NEED="src/assets/pet.png src/assets/anim1.png src/assets/anim2.png src/assets/anim3-1.png src/assets/anim3-2.png src/assets/type1.png src/assets/type2.png src/shared/autoAnim.js"
for f in $NEED; do
  [ -s "$ROOT/$f" ] || die "源树缺 $f —— 对应功能在包里会静默失效"
done
for f in src/assets/blink.png src/assets/state.png src/assets/type-idle.png src/shared/blink.js; do
  [ -e "$ROOT/$f" ] && die "源树还留着已删除的 $f —— 单形态改版前它会被一起拷进包"
done
[ -s "$ROOT/启动桌宠.bat" ] || die "源树没有 启动桌宠.bat（launcher 是包的入口）"
[ "$FAILED" -eq 0 ] || { echo "源树自检没过，先修源树再打包。"; exit 1; }
ok "内置素材 7 张齐全，旧素材/旧模块已确认不在源树"

# ---------- 2. 全量替换装配 ----------
echo ""; echo "===== [2] 装配文件树（先 rm -rf 再拷：只替换一部分是偷懒）====="
rm -rf "$OUT" || die "清不出干净目录：$OUT"
mkdir -p "$OUT" || exit 1
for item in src test tools package.json package-lock.json README.md 版本日志.md \
            UI风格统一指南.md 启动桌宠.bat 启动桌宠-调试.bat; do
  if [ -e "$ROOT/$item" ]; then
    cp -R "$ROOT/$item" "$OUT/$item" || die "拷贝失败：$item"
  else
    warn "源树没有 $item，跳过"
  fi
done
mkdir -p "$OUT/data"
ok "文件树就位（src/test/tools + 两个启动器 + 空 data/）"

# ---------- 3. 运行时依赖 ----------
# 整目录带 node_modules：里面有 electron 运行时（launcher 直接指向它）与 sherpa 的 win 原生包。
# 不带 npm 缓存/软链之外的东西，所以直接拷源树的 node_modules，然后 [5] 核对可执行文件真的在。
echo ""; echo "===== [3] 运行时依赖（node_modules，含 Electron 运行时）====="
cp -R "$ROOT/node_modules" "$OUT/node_modules" || die "node_modules 拷贝失败"
ok "node_modules 就位"

# ---------- 4. 刻意排除项复核 ----------
echo ""; echo "===== [4] 排除项复核（不该在包里的东西，一个都不许在）====="
for bad in "$OUT/data/assets" "$OUT/语音模块" "$OUT/新逻辑新素材" "$OUT/.git" "$OUT/out" "$OUT/dist"; do
  if [ -e "$bad" ]; then
    die "包里出现了不该有的 $bad"
  fi
done
ok "用户数据 / 语音模型 / 源素材 / 仓库噪声 均未随包出去"

# ---------- 5. 包内自检 ----------
echo ""; echo "===== [5] 包内自检 ====="
EXE="$OUT/node_modules/electron/dist/electron.exe"
if [ ! -f "$EXE" ]; then
  die "launcher 指向的可执行文件不在包里：$EXE —— 这个包双击必然报错"
else
  off=$(od -An -j60 -N4 -tu4 < "$EXE" | tr -d ' \n')
  machine=$(od -An -j$((off + 4)) -N2 -tu2 < "$EXE" | tr -d ' \n')
  if [ "$machine" = "$WANT_MACHINE" ]; then
    ok "electron.exe 就位，PE 机器型 = $machine（目标 $ARCH）"
  else
    die "electron.exe 机器型 = ${machine:-没读到}，目标是 $ARCH（应为 $WANT_MACHINE）—— 发出去用户双击是「不是有效的 Win32 应用」"
  fi
fi
# launcher 真的能找到它（路径写死 node_modules\electron\dist\electron.exe）
grep -q "node_modules.electron.dist.electron.exe" "$OUT/启动桌宠.bat" 2>/dev/null \
  || warn "启动桌宠.bat 里的路径写法与预期不符，检查 launcher"
for f in src/renderer/index.html src/main/main.js src/shared/config.js; do
  [ -s "$OUT/$f" ] || die "包内缺 $f"
done
N1=$(find "$ROOT/src" -type f | wc -l | tr -d ' '); N2=$(find "$OUT/src" -type f | wc -l | tr -d ' ')
if [ "$N1" = "$N2" ]; then ok "src/ 文件数与源树一致（$N2）"; else die "src/ 文件数不一致：源树 $N1 vs 包内 $N2 —— 拷贝被吞了"; fi
if [ "$N2" = "0" ]; then die "自检根本没扫到文件，不能当成通过"; fi

# ---------- 6. 真跑包内产物 ----------
# 用**包里的** node_modules 跑包里的测试：require('electron') 从包目录解析，起的就是交付物本身。
echo ""; echo "===== [6] 跑包内产物（L2 冒烟硬门 + L1 三个视觉场景）====="
( cd "$OUT" && node test/fixtures/gen.js >/dev/null 2>&1 )
if ( cd "$OUT" && node test/smoke/smoke.js ) > "$OUT/../win-smoke.log" 2>&1; then
  grep -q "SMOKE_OK" "$OUT/../win-smoke.log" \
    && ok "$(grep -o 'animGroups=[0-9]* typeFrames=[0-9]*' "$OUT/../win-smoke.log" | head -1) 冒烟硬门通过" \
    || die "冒烟退出码 0 但日志里没有 SMOKE_OK —— 判据没落到实处"
else
  die "包内冒烟失败，详见 dist/win-smoke.log（末 15 行）"; tail -15 "$OUT/../win-smoke.log"
fi
if ( cd "$OUT" && env PET_UI_ONLY=anim,autoAnim,typing node test/ui/ui.test.js ) > "$OUT/../win-ui.log" 2>&1 \
   && grep -q "UI_ALL_PASS" "$OUT/../win-ui.log"; then
  ok "包内 L1 视觉场景全过：$(grep -c 'SCENARIO .* PASS' "$OUT/../win-ui.log") 个（$(grep -o '缩放串最后改写于 [0-9.]*s' "$OUT/../win-ui.log" | head -1)）"
else
  die "包内 L1 视觉场景没过，详见 dist/win-ui.log"; grep -E "SCENARIO|断言失败" "$OUT/../win-ui.log" | tail -12
fi

# ---------- 7. 汇总 ----------
echo ""; echo "########## 汇总 ##########"
du -sh "$OUT" 2>/dev/null | awk '{print "包体积: "$1}'
if [ "$FAILED" -eq 0 ]; then
  ok "打包完成：$OUT"
  echo ""
  echo "分发（Windows）："
  echo "  · 整目录压缩发给用户，解压到任意路径，双击「启动桌宠.bat」；报错了用「启动桌宠-调试.bat」（留控制台看 [main] 日志）"
  echo "  · 免安装、免 Node；用户数据都在包内 data/ 里，整个文件夹可以直接搬走"
  echo "  · 语音默认不可用（包里按设计不带 161MB 模型）；要语音就把 语音模块 放进包根目录后重启"
  echo "  · 换主图 = 覆盖 src/assets/pet.png（或与内置素材同画布同留白的图，否则打字换图会跳位，见 README「换图即定制」）"
  exit 0
else
  die "打包有问题，见上面 ❌ 项"
  exit 1
fi
