#!/bin/sh
# 便携启动器（macOS）—— 双击即用，不需要单独装 Node。
# 数据（素材 / settings.json）全在 ./data，整个文件夹可以整体搬走。
# 与《启动桌宠.bat》同一套语义：直接跑 node_modules 里的 Electron，不经过 npm。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ELECTRON="$DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -x "$ELECTRON" ]; then
  echo "找不到 Electron：$ELECTRON" >&2
  echo "请先在本目录执行：npm install" >&2
  exit 1
fi

nohup "$ELECTRON" "$DIR" >/dev/null 2>&1 &
exit 0
