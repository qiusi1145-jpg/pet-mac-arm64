#!/bin/sh
# macOS 侧验证脚手架 —— 一条命令跑完整个移植回归，输出可直接贴回给 Agent 的报告。
# 用法：cd <项目目录> && sh tools/verify-vm.sh
#   跳过某段：SKIP_UI=1 sh tools/verify-vm.sh   （UI 场景最耗时，改动只碰 shared 时可用）
#
# 设计原则（与项目红线一致）：
#  · 每段都**如实回报**，失败不吞、不"静默跳过"；
#  · 环境信息先落盘，否则后面红了也分不清是代码问题还是环境问题；
#  · 只报事实与数字，判断交给人。
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
OUT=${VERIFY_OUT:-/tmp/deskpet-verify}
mkdir -p "$OUT"
REPORT="$OUT/report.txt"
: > "$REPORT"
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
run() { # run <标签> <命令...>
  L=$1; shift
  say ""
  say "===== $L ====="
  "$@" >> "$OUT/raw.log" 2>&1; C=$?
  tail -n "${TAIL:-26}" "$OUT/raw.log" | tee -a "$REPORT"
  say "--- $L 退出码=$C ---"
  return $C
}
: > "$OUT/raw.log"
export PATH="$HOME/.local/node/bin:$PATH"

say "########## 桌宠 macOS 移植验证 ##########"
say "时间: $(date '+%F %T')"
say "项目: $ROOT"

# ---------- 0. 环境 ----------
say ""
say "===== [0] 环境 ====="
{
  echo "macOS   : $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  echo "架构    : $(uname -m)   CPU: $(sysctl -n machdep.cpu.brand_string)"
  echo "内存    : $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
  echo "node    : $(node -v 2>&1)   npm: $(npm -v 2>&1)"
  echo "git     : $(git --version 2>&1 | head -1)"
  echo "Electron: $(node -e 'process.stdout.write(require("electron").trim())' 2>&1)"
  echo "磁盘可用: $(df -g . | tail -1 | awk '{print $4}') GB"
} 2>&1 | tee -a "$REPORT"

# 三条"只在真机/只在 arm64 才会暴露"的红线，提前打印，避免拿 VM 的绿灯当结论
say ""
say "-- 环境告警（VM 覆盖不到的东西，别当成已通过）--"
if [ "$(uname -m)" = "x86_64" ]; then
  say "⚠ 当前是 x86_64：所有 darwin-arm64 原生包与 arm64 强制签名（codesign）这条路径**未被验证**"
fi
if system_profiler SPAudioDataType 2>/dev/null | grep -q "Virtual"; then
  say "⚠ 检测到虚拟音频设备：语音'真的说话'这条只能在真机验"
fi
say "⚠ VMware/VirtualBox 的 macOS guest 没有 Metal 硬件加速 → 透明窗合成/遮挡冻结的结论不可信，必须真机复验"

# ---------- 1. 单测 ----------
FAILS=""
npm run test > "$OUT/unit.log" 2>&1 || true
U=$(grep -E "^ℹ (tests|pass|fail|skipped)" "$OUT/unit.log" | tr '\n' ' ')
say ""; say "===== [1] 纯函数单测 ====="; say "$U"
echo "$U" | grep -qE "fail [1-9]" && FAILS="$FAILS 单测"

# ---------- 2. 冒烟 ----------
say ""; run "[2] 冒烟 test:smoke" npm run test:smoke || FAILS="$FAILS 冒烟"

# ---------- 3. UI 场景（含 Retina 路径复跑）----------
if [ "${SKIP_UI:-0}" = "1" ]; then
  say ""; say "===== [3] UI 场景 —— SKIP_UI=1 已跳过 ====="
else
  say ""; run "[3a] UI 场景（默认缩放）" npm run test:ui || FAILS="$FAILS UI"
  TAIL=8 say ""; run "[3b] UI 场景（devicePixelRatio=2，模拟 Retina）" \
    env PET_CHROMIUM_ARGS=--force-device-scale-factor=2 npm run test:ui || FAILS="$FAILS UI@2x"
fi

# ---------- 4. 语音端到端 ----------
if [ -d data/voice/models ]; then
  say ""; run "[4] 语音 voice:e2e" npm run voice:e2e || FAILS="$FAILS 语音e2e"
else
  say ""; say "===== [4] 语音 —— data/voice/models 不存在，按'未安装'降级，跳过 ====="
fi

# ---------- 5. 吸附残留检查（应彻底删净）----------
say ""; say "===== [5] 吸附残留检查 ====="
# content.test.js 里那条是**故意保留**的兼容性测试（老 settings.json 残留 snapEnabled 被忽略），不算残留
LEFT=$(grep -rn "enumerate:windows\|attemptSnap\|chooseSnapTarget\|snapEnabled\|winEnum.list" src test 2>/dev/null \
  | grep -v "^test/unit/content.test.js:")
if [ -n "$LEFT" ]; then say "⚠ 仍有吸附引用："; printf '%s\n' "$LEFT" | tee -a "$REPORT"; FAILS="$FAILS 吸附残留"; else say "✓ 吸附代码已删净"; fi

# ---------- 6. 平台分派自检 ----------
say ""; say "===== [6] 平台防护如实回报（不许静默）====="
node -e 'const p=require("./src/main/platform");
  console.log("IS_WIN="+p.IS_WIN+" IS_MAC="+p.IS_MAC+" platform="+process.platform);' 2>&1 | tee -a "$REPORT"
# guardPetWindow 的回报只在 PET_DEBUG 下落日志，这里专门起一次把它逼出来
# （macOS 没有 coreutils 的 `timeout`，用 后台 + sleep + pkill 代替）
# 必须先清场：上一段留下的实例会占住单实例锁，让这次启动直接 quit（实测踩过）
pkill -f "deskpet/node_modules/electron" 2>/dev/null; sleep 2
PET_DEBUG=1 npm start > "$OUT/guard.log" 2>&1 &
sleep 10
pkill -f "deskpet/node_modules/electron" 2>/dev/null
sleep 1
G=$(grep -a "window guard" "$OUT/guard.log" | head -1)
if [ -n "$G" ]; then say "✓ $G"; else say "❌ 没拿到 window guard 回报（防护路径没跑到？别当通过）"; FAILS="$FAILS 平台防护回报"; fi

# ---------- 7. 启动器与权限声明 ----------
say ""; say "===== [7] 启动器 / 权限声明 ====="
for f in 启动桌宠.command 启动桌宠-调试.command; do
  if [ -f "$f" ]; then
    [ -x "$f" ] && say "✓ $f 存在且可执行" || say "⚠ $f 缺可执行位 → chmod +x ${f}（并 git update-index --chmod=+x）"
    head -1 "$f" | grep -q '^#!/bin/sh' && say "✓ $f shebang 正常" || say "⚠ $f shebang 缺失/异常"
    case $(head -2 "$f" | tail -1) in *$'\r'*) say "⚠ $f 是 CRLF 行尾，macOS 会拒绝执行" ;; *) say "✓ $f 行尾 LF" ;; esac
  else say "⚠ $f 不存在"; fi
done
MP=node_modules/electron/dist/Electron.app/Contents/Info.plist
if [ -f "$MP" ]; then
  V=$(plutil -extract NSMicrophoneUsageDescription raw "$MP" 2>/dev/null)
  [ -n "$V" ] && say "✓ Electron bundle 已声明 NSMicrophoneUsageDescription" || say "⚠ 缺 NSMicrophoneUsageDescription → getUserMedia 会被静默拒绝"
  say "签名: $(codesign -dv node_modules/electron/dist/Electron.app 2>&1 | head -1)"
fi

# ---------- 8. 打字探针（形态三）----------
say ""; say "===== [8] 打字探针 keybeat ====="
HB=src/main/mac/keybeat
if [ ! -f "$HB" ]; then
  say "⚠ 没有 $HB —— 形态三在 mac 上会置灰。构建：sh tools/build-mac-helper.sh"
  FAILS="$FAILS 打字探针未构建"
else
  file -b "$HB" | grep -q Mach-O && say "✓ 探针是 Mach-O：$(file -b "$HB" | cut -c1-46)" || say "❌ $HB 不是可执行 Mach-O"
  codesign --verify "$HB" >/dev/null 2>&1 && say "✓ 探针已签名（arm64 上无签名会被内核杀）" \
    || say "⚠ 探针未签名 —— 分发包里必须由 mac-package.sh 补签"
  # 信任状态如实打印：未授权是环境状态，不是代码 bug，所以不判失败，但必须看得见。
  # 临时脚本必须放独立目录并用完就删：留在 /tmp/axcheck.js 会让 Electron 把命令行参数
  # `/tmp/axcheck`（目录）按"先文件后目录"的规则解析成这个残留脚本 —— 实测跑出来一个
  # 莫名其妙的 "trusted"，查了半天以为探针没起来，其实是别人的输出。
  AXDIR=$(mktemp -d)
  cat > "$AXDIR/axcheck.js" <<'JSEOF'
const { app, systemPreferences } = require('electron');
app.whenReady().then(() => {
  console.log(systemPreferences.isTrustedAccessibilityClient(false) ? 'trusted' : 'untrusted');
  app.exit(0);
});
JSEOF
  TRUST=$(./node_modules/.bin/electron "$AXDIR/axcheck.js" 2>/dev/null | grep -aoE 'trusted|untrusted' | tail -1)
  rm -rf "$AXDIR"
  say "辅助功能信任：${TRUST:-查询失败}（untrusted 时事件不会到达且不报错，菜单会显示「需授权辅助功能」）"
  # ⚠ 这里**不**合成按键：SSH 会话下 System Events 起不来、整段挂死；换成 CGEventPost
  #   直投 HID 层也不报错但**一个节拍都收不到**（实测过），因为 SSH 进程不在窗口服务器
  #   会话里。真人按键验证走 tools/typing-live-test.sh，需要人配合，所以不并进自动流程。
  if [ "${LIVE_TYPING:-0}" = "1" ]; then
    say "-- LIVE_TYPING=1：跑真人按键验证（接下来 15 秒请在虚拟机里连续敲 10 下以上键）--"
    sh tools/typing-live-test.sh 18 >> "$OUT/raw.log" 2>&1 \
      && say "✓ 探针端到端捕获到节拍（形态三在 macOS 上可用）" \
      || { say "❌ 探针收不到节拍，见 $OUT/raw.log"; FAILS="$FAILS 打字探针"; }
  else
    say "— 节拍实测需真人按键，默认跳过；要跑：LIVE_TYPING=1 sh tools/verify-vm.sh"
  fi
fi

# ---------- 汇总 ----------
say ""
say "########## 汇总 ##########"
if [ -n "$FAILS" ]; then say "❌ 失败段:$FAILS"; else say "✅ 全部通过"; fi
say "完整原始输出: $OUT/raw.log   报告: $REPORT"
[ -n "$FAILS" ] && exit 1
exit 0
