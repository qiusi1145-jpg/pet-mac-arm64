#!/bin/sh
# 构建 macOS 打字探针（src/main/mac/keybeat.m → keybeat）。
#
# 为什么必须构建期编译而不是像 Windows 那样运行期现编：macOS **没有系统自带编译器**，
# "用 csc.exe 现场编一段 C# 出来"这套零原生依赖的范式在那边根本不成立。
# 所以 helper 必须随包分发，并且**要纳入 ad-hoc 签名**（见 tools/mac-package.sh 第 3 段——
# Apple Silicon 上无签名的可执行文件会被内核直接杀掉）。
#
# 用法：sh tools/build-mac-helper.sh [--force]
set -u
cd "$(dirname "$0")/.." || exit 1
SRC=src/main/mac/keybeat.m
OUT=src/main/mac/keybeat

if [ ! -f "$SRC" ]; then echo "❌ 找不到源码 $SRC"; exit 1; fi
case "$(uname -s)" in
  Darwin) : ;;
  *) echo "⚠ 非 macOS，跳过（helper 只能在 mac 上编）"; exit 0 ;;
esac
if [ "${1:-}" != "--force" ] && [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  echo "✓ helper 已是最新：$OUT"; exit 0
fi

if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find clang >/dev/null 2>&1; then
  echo "❌ 找不到 clang。先装 Xcode 命令行工具：xcode-select --install"
  exit 1
fi

# 只用 CoreGraphics/ApplicationServices 的 CGEventTap，不链 Cocoa —— 探针不经 AppKit
# 事件派发（实测 addGlobalMonitorForEvents 对无 nib 命令行工具收不到事件）。
xcrun clang -fobjc-arc -Os -Wall -framework ApplicationServices -o "$OUT" "$SRC" || { echo "❌ 编译失败"; exit 1; }
chmod +x "$OUT"
echo "✓ 已编译 $OUT（$(codesign -dvv "$OUT" 2>&1 | grep -c . > /dev/null; file -b "$OUT" | cut -c1-40)）"
