#!/bin/sh
# 构建 macOS 打字探针（src/main/mac/keybeat.m → keybeat）。
#
# 为什么必须构建期编译而不是像 Windows 那样运行期现编：macOS **没有系统自带编译器**，
# "用 csc.exe 现场编一段 C# 出来"这套零原生依赖的范式在那边根本不成立。
# 所以 helper 必须随包分发，并且**要纳入 ad-hoc 签名**（见 tools/mac-package.sh 第 3 段——
# Apple Silicon 上无签名的可执行文件会被内核直接杀掉）。
#
# 用法：sh tools/build-mac-helper.sh [--force] [arm64|x86_64]
#   不传架构就按本机。交叉出 arm64 包时**必须显式传 arm64**，否则会产出一个
#   x86_64 的 helper 塞进 arm64 分发包里（M2 上要么走 Rosetta 要么直接崩）。
set -u
cd "$(dirname "$0")/.." || exit 1
SRC=src/main/mac/keybeat.m
OUT=src/main/mac/keybeat
FORCE=""
ARCH="$(uname -m)"
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    arm64|x86_64) ARCH="$a" ;;
  esac
done

if [ ! -f "$SRC" ]; then echo "❌ 找不到源码 $SRC"; exit 1; fi
case "$(uname -s)" in
  Darwin) : ;;
  *) echo "⚠ 非 macOS，跳过（helper 只能在 mac 上编）"; exit 0 ;;
esac
if [ -z "$FORCE" ] && [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ] \
   && file -b "$OUT" | grep -q "$ARCH"; then
  echo "✓ helper 已是最新且是 $ARCH：$OUT"; exit 0
fi

if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find clang >/dev/null 2>&1; then
  echo "❌ 找不到 clang。先装 Xcode 命令行工具：xcode-select --install"
  exit 1
fi

# 只用 CoreGraphics/ApplicationServices 的 CGEventTap，不链 Cocoa —— 探针不经 AppKit
# 事件派发（实测 addGlobalMonitorForEvents 对无 nib 命令行工具收不到事件）。
xcrun clang -arch "$ARCH" -fobjc-arc -Os -Wall -framework ApplicationServices -o "$OUT" "$SRC" \
  || { echo "❌ 编译失败（arch=$ARCH）"; exit 1; }
chmod +x "$OUT"
# 产物架构必须真的对得上：交叉编译时"编成功了但架构错了"是最难查的那类问题
file -b "$OUT" | grep -q "$ARCH" \
  || { echo "❌ 产物架构不是 $ARCH：$(file -b "$OUT")"; exit 1; }
echo "✓ 已编译 $OUT（$(file -b "$OUT" | cut -c1-46)）"
