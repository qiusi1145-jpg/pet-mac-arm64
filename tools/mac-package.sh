#!/bin/sh
# macOS 便携包打包脚本（ad-hoc 签名路线，不花一分钱、不要开发者账号）
#
# 用法：
#   sh tools/mac-package.sh                 # 按本机架构出包（在 M2 上跑就出 arm64）
#   sh tools/mac-package.sh arm64           # 交叉出 arm64 包（在 Intel/VM 上也能构建，但**跑不了**）
#   sh tools/mac-package.sh x86_64
#
# 为什么签名必须在 mac 上做：`codesign` 是 macOS 工具，Windows 侧没有。
# 为什么必须"逐个 Mach-O 校验"：**Apple Silicon 拒绝加载任何无签名可执行文件**
#   （症状 `Killed: 9` / `Code Signature Invalid`，内核层，用户侧无法绕过）。
#   Electron.app 内部的 `--deep` 能覆盖，但 node_modules 里的 .node / .dylib
#   在 bundle **外面**，`--deep` 管不到 —— 漏一个，M2 上就是一开就崩。
set -u
ARCH=${1:-$(uname -m)}
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
OUT="$ROOT/dist/桌宠-mac-$ARCH"
FAILED=0
die() { echo "❌ $*" >&2; FAILED=1; }
ok()  { echo "✓ $*"; }
warn(){ echo "⚠ $*"; }

case "$ARCH" in
  arm64|x86_64) : ;;
  *) echo "架构参数只能是 arm64 或 x86_64（收到：$ARCH）"; exit 2 ;;
esac

# npm 按目标架构装可选原生依赖（npm ≥ 9.4）；Electron 二进制的架构由这个变量决定
case "$ARCH" in arm64) NPM_CPU=arm64; EA=arm64 ;; *) NPM_CPU=x64; EA=x64 ;; esac
# GitHub Releases 在国内/VM 里常被中断（实测踩过 ReadError），默认走镜像；已设则尊重
: "${ELECTRON_MIRROR:=https://npmmirror.com/mirrors/electron/}"; export ELECTRON_MIRROR

echo "########## 桌宠 mac 打包：$ARCH ##########"
echo "源目录: $ROOT"
echo "产出:   $OUT"

# ---------- 0. 先构建打字探针 ----------
# 必须在装配**之前**：build-mac-helper.sh 把产物放在源树的 src/main/mac/keybeat，
# 装配靠整目录拷贝带上它 —— 先拷后编的话分发包里根本没有探针（实测踩过，
# 用户机上形态三会静默置灰）。也必须在签名之前，否则签名扫不到它。
echo ""; echo "===== [0] 构建打字探针 keybeat（目标架构 $ARCH）====="
sh tools/build-mac-helper.sh --force "$ARCH" || die "打字探针编译失败（形态三在 mac 上会置灰）"
[ -f src/main/mac/keybeat ] || die "编译后源树里仍没有 src/main/mac/keybeat"
# 交叉出包时最容易踩的坑：helper 悄悄按本机架构编了。产物架构必须显式核对。
file -b src/main/mac/keybeat | grep -q "$ARCH" \
  || die "helper 架构不是 $ARCH：$(file -b src/main/mac/keybeat)"
ok "探针已就位（源树，$ARCH）"

# ---------- 1. 装配 ----------
# 只带运行需要的东西。刻意不带：node_modules（下面重装）、data（用户数据，首启自动建）、
# out、.git、测试报告、语音模型（161MB，缺模型时应用按设计优雅隐藏语音）。
echo ""; echo "===== [1] 装配文件树 ====="
rm -rf "$OUT"; mkdir -p "$OUT"
for item in src test tools README.md package.json package-lock.json \
            启动桌宠.command 启动桌宠-调试.command 动画素材 UI风格统一指南.md macOS移植方案.md; do
  [ -e "$ROOT/$item" ] || { warn "跳过不存在的 $item"; continue; }
  cp -R "$ROOT/$item" "$OUT/$item"
done
[ -d "$OUT/data" ] || mkdir -p "$OUT/data"
ok "文件树就位"

# ---------- 2. 装依赖（按目标架构）----------
echo ""; echo "===== [2] npm install（--os=darwin --cpu=$NPM_CPU）====="
# ⚠ 不能加 --omit=dev：Electron 本身就在 devDependencies 里，跳了就没有可执行文件
# ⚠ 架构必须在 npm install **之前**就设好：electron 的 postinstall 按当时的配置下载二进制，
#   装完再补一次 install.js 没用（它发现 dist 已存在就直接跳过）——
#   实测这样会产出"arm64 包里塞 x86_64 Electron"的半成品，M2 用户只能靠 Rosetta 跑。
export ELECTRON_ARCH="$EA" electron_config_arch="$EA" npm_config_arch="$EA"
rm -rf "$OUT/node_modules"
( cd "$OUT" && npm install --no-audit --no-fund --os=darwin --cpu="$NPM_CPU" ) || die "npm install 失败"
EB="$OUT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -f "$EB" ] || die "找不到 Electron 主程序：$EB"
EB_ARCH=$(file -b "$EB" | grep -oE 'arm64|x86_64' | head -1)
if [ "$EB_ARCH" = "$ARCH" ]; then
  ok "Electron 主程序就位，架构与目标一致（$ARCH）"
else
  die "Electron 架构是 ${EB_ARCH:-未知}，目标是 $ARCH —— 发出去 M2 用户只能跑 Rosetta"
fi

# 便携包的启动器要能双击
chmod +x "$OUT"/*.command 2>/dev/null
ok "启动器可执行位已置"

# ---------- 1.5 确认探针真的进了分发包 ----------
# ⚠ 这里原来写成「die() 之后仍然无条件打印 ✓」—— 自己造了个假绿灯，正是本脚本反对的东西。
#   成功/失败必须走同一个 if 的两个分支，不许在断言之后直接说"通过"。
echo ""; echo "===== [1.5] 探针是否随包就位 ====="
if [ -f "$OUT/src/main/mac/keybeat" ]; then
  ok "分发包内含打字探针：src/main/mac/keybeat"
else
  die "分发包里没有 src/main/mac/keybeat —— 形态三在用户机上会静默置灰"
fi

# ---------- 3. ad-hoc 签名 ----------
echo ""; echo "===== [3] ad-hoc 签名（codesign -s -）====="
APP="$OUT/node_modules/electron/dist/Electron.app"
LIST="$OUT/.signlist"; FAILS="$OUT/.signfail"
: > "$LIST"; : > "$FAILS"

# ① 先签 bundle **外面**的可执行文件：npm 装进来的 .node/.dylib，以及我们自己的 keybeat 探针。
#    （--deep 只处理 .app 内部的嵌套代码，这些它一概看不到）
find "$OUT" -path "*Electron.app" -prune -o \
     \( -type f \( -name '*.node' -o -name '*.dylib' -o -perm -u+x \) \) -print0 2>/dev/null \
| while IFS= read -r -d '' f; do
    file -b "$f" 2>/dev/null | grep -q 'Mach-O' || continue
    printf '%s\n' "$f" >> "$LIST"
    codesign --force --sign - "$f" >/dev/null 2>&1 || printf '%s\n' "$f" >> "$FAILS"
  done

# ② 先补 `--deep` 的盲区：`X.framework/Versions/A/Libraries/*.dylib` 与 `Resources/` 里的可执行文件
#    （实测 --deep 不签这些，M2 上会被内核当场杀掉）。必须在 --deep **之前**做，反过来会破封印。
find "$APP" -type f \( -name '*.dylib' -o -name '*.node' -o -perm -u+x \) -print0 2>/dev/null \
| while IFS= read -r -d '' f; do
    case "$f" in
      */Contents/MacOS/*) continue ;;   # 主程序：外层 .app 负责
      */Versions/A/*/*)   : ;;          # Libraries/ Helpers/ 里的 → 要签
      */Versions/A/*)     continue ;;   # framework 主二进制：签 framework 时负责
    esac
    file -b "$f" 2>/dev/null | grep -q 'Mach-O' || continue
    printf '%s\n' "$f" >> "$LIST"
    codesign --force --sign - "$f" >/dev/null 2>&1 || printf '%s\n' "$f" >> "$FAILS"
  done

# ③ bundle 整体交给 --deep（由内向外处理 framework 与 `Electron Helper*.app` 等嵌套 bundle）
#    ⚠ **签完绝不再碰内部文件**：之前先 --deep、再逐个重签内部 .dylib，直接把外层封印打破，
#      报 "a sealed resource is missing or invalid"。顺序错了比不签更糟。
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || printf '%s\n' "$APP" >> "$FAILS"

N=$(wc -l < "$LIST" | tr -d ' '); SIGNFAIL=$(wc -l < "$FAILS" | tr -d ' ')
[ "$SIGNFAIL" != "0" ] && sed 's/^/  ✗ /' "$FAILS" | head -10
rm -f "$LIST" "$FAILS"
[ "$SIGNFAIL" = "0" ] && ok "ad-hoc 签名完成（由内向外，共 $N 个原生文件 + 外层 .app）" \
                     || die "$SIGNFAIL 个文件签名失败（arm64 上会 Killed: 9）"

# ---------- 4. 清隔离属性 ----------
echo ""; echo "===== [4] 清 com.apple.quarantine ====="
xattr -dr com.apple.quarantine "$OUT" 2>/dev/null
Q=$(xattr -rs com.apple.quarantine "$OUT" 2>/dev/null | wc -l | tr -d ' ')
[ "$Q" = "0" ] && ok "包内无隔离属性残留（用户拿到大概率不用过 Gatekeeper）" \
               || warn "仍有 $Q 处隔离属性，分发前再跑一次 xattr -dr"

# ---------- 5. 签名完整性校验（arm64 的生死线）----------
echo ""; echo "===== [5] 校验：包内所有 Mach-O 是否都有有效签名 ====="
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 && ok "Electron.app 递归严格校验通过" \
  || die "Electron.app 校验失败：$(codesign --verify --deep --strict "$APP" 2>&1 | head -1)"

# 用 `file` 认 Mach-O（比手搓魔数可靠），-print0 管道喂给校验循环
LIST="$OUT/.macholist"; BAD="$OUT/.machobad"
: > "$LIST"; : > "$BAD"
find "$OUT" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0 2>/dev/null \
| while IFS= read -r -d '' f; do
    file -b "$f" 2>/dev/null | grep -q 'Mach-O' || continue
    printf '%s\n' "$f" >> "$LIST"
    codesign --verify --verbose=1 "$f" >/dev/null 2>&1 && continue
    # 验不过：分不清是"无签名"还是"签名被改坏"，两种在 arm64 上都是当场被内核杀
    printf '%s | %s\n' "$f" "$(codesign --verify "$f" 2>&1 | head -1)" >> "$BAD"
  done
TOT=$(wc -l < "$LIST" | tr -d ' '); NBAD=$(wc -l < "$BAD" | tr -d ' ')
if [ "$TOT" = "0" ]; then
  die "一个 Mach-O 都没扫到 —— 校验根本没跑起来，**不能当成通过**（上一版就在这儿假绿灯过）"
elif [ "$NBAD" = "0" ]; then
  ok "全部 Mach-O 签名有效（共扫描 $TOT 个）"
else
  echo "以下 Mach-O 无签名或签名失效，M2 上会直接 Killed: 9："
  sed "s|$OUT/|  ✗ |" "$BAD" | head -20
  die "$NBAD/$TOT 个 Mach-O 签名不可用"
fi
rm -f "$LIST" "$BAD"

# ---------- 6. 汇总 ----------
echo ""; echo "########## 汇总 ##########"
du -sh "$OUT" 2>/dev/null | awk '{print "包体积: "$1}'
if [ "$FAILED" -eq 0 ]; then
  ok "打包完成：$OUT"
  echo ""
  echo "分发前请注意（写给用户）："
  echo "  · 让用户放到 ~/桌宠 这类路径，**别放桌面/文档**（iCloud 同步会破坏签名 → 报「已损坏，无法打开」）"
  echo "  · 首次双击若被 Gatekeeper 拦：**别写「系统设置 → 仍要打开」** —— 那套放行只对 .app/安装包"
  echo "    生效，我们的启动器是 .command，实测被拦后只有「完成/移到废纸篓」（见 macOS移植方案.md §12.5.1）。"
  echo "    可行做法：用网盘/微信传（不打隔离标记），或让用户跑 xattr -dr com.apple.quarantine <文件夹>"
  echo "  · 用微信/QQ 传文件通常不加隔离属性，用户完全无感"
  [ "$ARCH" != "$(uname -m)" ] && echo "  ⚠ 本机是 $(uname -m)，这份是给 $ARCH 的，本机跑不了 —— 拿去对应架构的机器上验"
  exit 0
else
  die "打包有问题，见上面 ❌ 项"
  exit 1
fi
