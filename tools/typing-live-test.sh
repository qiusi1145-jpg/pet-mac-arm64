#!/bin/sh
# 打字探针的真人按键验证（形态三在 macOS 上的端到端证据）。
#
# 为什么必须真人按键：VM 里 `osascript ... keystroke` 在 SSH 会话下会直接挂死
#   （System Events 起不来 / 自动化授权弹不出来），合成按键这条路在 SSH 驱动的
#   环境里走不通 —— 那是驱动方式的限制，不是探针的问题。
#
# 用法：sh tools/typing-live-test.sh [等待秒数，默认 15]
#   跑起来后**立刻在虚拟机里连续敲 10 下以上**字母/数字（别只按修饰键、别在密码框）。
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$PATH"
SECS=${1:-15}
OUT=/tmp/deskpet-typing-live.txt
rm -f "$OUT"

if [ ! -x src/main/mac/keybeat ]; then
  echo "❌ 没有 src/main/mac/keybeat —— 先跑 sh tools/build-mac-helper.sh"
  exit 1
fi

node -e '
const { spawn } = require("child_process");
const fs = require("fs");
const { macProbeArgs } = require(process.cwd() + "/src/shared/typing");
const fd = fs.openSync("/tmp/deskpet-typing-live.txt", "w");
const p = spawn("src/main/mac/keybeat", macProbeArgs(), { stdio: ["ignore", fd, "ignore"], detached: true });
p.unref();
console.log("PROBE_PID=" + p.pid);
' || { echo "❌ 探针启动失败"; exit 1; }

sleep 1
PID=$(pgrep -f "mac/keybeat" | head -1)
[ -n "$PID" ] || { echo "❌ 探针没起来"; exit 1; }

SELF=$(head -1 "$OUT" 2>/dev/null)
case "$SELF" in
  t) echo "✓ 探针自检：已被「辅助功能」信任" ;;
  n) echo "❌ 探针自检：未信任辅助功能 → 事件不会到达。去 系统设置 → 隐私与安全性 → 辅助功能 勾选后重跑"
     kill "$PID" 2>/dev/null; exit 1 ;;
  *) echo "❌ 探针没报自检行（可能建不起 event tap）"; kill "$PID" 2>/dev/null; exit 1 ;;
esac

echo ""
echo ">>> 现在有 ${SECS} 秒：请在虚拟机里随便找个能打字的地方，连续敲 10 下以上字母/数字 <<<"
echo ""
sleep "$SECS"
kill "$PID" 2>/dev/null

N=$(tr -cd 'k' < "$OUT" | wc -c | tr -d ' ')
if [ "$N" -gt 0 ]; then
  echo "✓ 捕获节拍 $N 个 —— 探针端到端可用（形态三在 macOS 上真的能跑）"
  exit 0
fi
echo "❌ 捕获 0 个节拍 —— 探针活着但收不到事件，见 $OUT"
exit 1
