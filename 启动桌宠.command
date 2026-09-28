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

# 日志留在 ./data/launch.log：探针/语音这类"起不来但不弹错"的问题只有 stdout 留痕。
# 实测踩过：这里重定向到 /dev/null，用户跑的是缺打字探针的旧包，界面上只有一个灰色菜单项，
# 查因只能靠翻进程树 —— 一行日志就能定位。日志随 data 一起被打包脚本排除，不会外泄。
mkdir -p "$DIR/data"
nohup "$ELECTRON" "$DIR" >> "$DIR/data/launch.log" 2>&1 &
exit 0
