#!/bin/sh
# 打字探针的真人按键验证（形态三在 macOS 上的端到端证据）。
#
# 这个脚本**必须走生产链路**（src/main/typing.js 的 TypingMonitor），不许自己 spawn 探针
# 再裸数 stdout —— 上一版就是这么写的：探针少写了一个换行，父进程的 readline 一行都切不出来，
# 而脚本按字符数 `tr -cd k` 照样数到 56 个，于是"实测通过"和"界面无反应"同时成立。
# 现在计数的是应用真正会收到的 beat 事件，测出来的就是真的。
#
# 为什么必须真人按键：VM 里 `osascript ... keystroke` 在 SSH 会话下会直接挂死
#   （System Events 起不来 / 自动化授权弹不出来）；换成 CGEventPost 直投 HID 层也不报错，
#   但探针收到 0 个。那是 SSH 会话不在窗口服务器事件流里的限制，不是探针的问题。
#
# 用法：sh tools/typing-live-test.sh [等待秒数，默认 15]
#   跑起来后**立刻在虚拟机里连续敲 10 下以上**字母/数字（别只按修饰键、别在密码框）。
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/node/bin:$PATH"
SECS=${1:-15}

if [ ! -x src/main/mac/keybeat ]; then
  echo "❌ 没有 src/main/mac/keybeat —— 先跑 sh tools/build-mac-helper.sh"
  exit 1
fi

node -e '
const { TypingMonitor } = require(process.cwd() + "/src/main/typing.js");
const m = new TypingMonitor(require("os").tmpdir());
if (!m.available()) { console.log("UNAVAILABLE " + m.unavailableReason()); process.exit(2); }
let n = 0;
m.on("beat", () => { n++; process.stdout.write("BEAT " + n + "\n"); });
if (!m.start()) { console.log("START_FAILED " + m.status().error); process.exit(3); }
console.log("PROBE_PID " + (m.child && m.child.pid));
setTimeout(() => {
  const st = m.status();
  console.log("TRUSTED " + st.probeTrusted);   // 探针自检回来的行（readline 能读到 = 行协议通了）
  console.log("TOTAL " + n);
  m.stop();
  if (st.probeTrusted === false) { console.log("UNTRUSTED 未授予「辅助功能」→ 事件不会到达且不报错"); process.exit(4); }
  process.exit(n > 0 ? 0 : 1);
}, Number(process.argv[1] || 15) * 1000);
' "$SECS"
RC=$?

echo ""
case "$RC" in
  0) echo "✓ 应用侧收到节拍 —— 探针到渲染层的整条链路可用" ;;
  1) echo "❌ 0 个节拍：探针活着但事件没到（查「辅助功能」授权 / 是否跑在 GUI 会话里）" ;;
  2) echo "❌ 本平台探针不可用（见上面 UNAVAILABLE 的原因）" ;;
  3) echo "❌ 探针起不来（见上面 START_FAILED 的原因）" ;;
  4) echo "❌ 探针未被「辅助功能」信任：系统设置 → 隐私与安全性 → 辅助功能 勾选后重跑" ;;
  *) echo "❌ 未知退出码 $RC" ;;
esac
exit "$RC"
