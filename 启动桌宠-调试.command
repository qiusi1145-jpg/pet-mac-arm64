#!/bin/sh
# 调试启动器（macOS）：留住前台，日志直接打在终端里（PET_DEBUG=1）。
# 与《启动桌宠-调试.bat》同一套语义。日志同时会落到 ./data/debug.log。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ELECTRON="$DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -x "$ELECTRON" ]; then
  echo "找不到 Electron：$ELECTRON" >&2
  echo "请先在本目录执行：npm install" >&2
  exit 1
fi

cd "$DIR" || exit 1
PET_DEBUG=1 exec "$ELECTRON" .
