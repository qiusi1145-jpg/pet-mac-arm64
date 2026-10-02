#!/bin/sh
# 桌宠 arm64 真机验收（自包含：不联网、不需要 node/npm）
#
# 用法（云 Mac 上，只用一个短命令，路径可用 Tab 补全）：
#   1) 浏览器登录 GitHub → 打开 Actions 那次 run → 下载 artifact `pet-mac-arm64`
#      → 双击它，旁边会解出 桌宠-mac-arm64.zip（留在「下载」里即可）
#   2) 浏览器再打开下面这个链接，把脚本也存进「下载」：
#      https://raw.githubusercontent.com/qiusi1145-jpg/pet-mac-arm64/master/tools/m2-verify.command
#   3) 打开「终端」（Cmd+Space 输 terminal 回车），敲：
#      sh ~/Down<Tab>/m2-verify.command
#
# 结果打印在屏幕上，同时写入 ~/m2-report.txt —— 把这个文件传回来就能判读。
set -u
D="$HOME/Downloads"
OUT="$HOME/m2test"
RPT="$HOME/m2-report.txt"
: > "$RPT"
say() { printf '%s\n' "$*" | tee -a "$RPT"; }

say "########## 桌宠 arm64 真机验收 $(date '+%F %T') ##########"
say "[0] 机器"
say "  uname -m : $(uname -m)   ← 必须是 arm64"
say "  sw_vers  : $(sw_vers -productName) $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
say "  CPU      : $(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
say "  内存      : $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"

# 免登录的 artifact 直链（GitHub 签发的临时签名地址，约 10 分钟后自动失效；
# 只授予读这一个压缩包，过期即死。云机登不上 GitHub 时靠它把包拉下来。）
PKG_URL="https://productionresultssa11.blob.core.windows.net/actions-results/231fd485-52c5-812c-a26d-4cf7c113d074/workflow-job-run-eae421b2-06fc-57d0-ae64-52b81585a4aa/artifacts/390d2e489d2c11bdf725f5544110a10cb1bf8e6a5d1cff7f1247c0225cd7d1c3.zip?rscd=attachment%3B+filename%3D%22pet-mac-arm64.zip%22&rsct=application%2Fzip&se=2026-10-02T16%3A32%3A48Z&sig=CaabK3eO5v84IGsy7znbwZ76e2dLyy8bD9NXIdjnfJ8%3D&ske=2026-10-02T18%3A08%3A48Z&skoid=ca7593d4-ee42-46cd-af88-8b886a2f84eb&sks=b&skt=2026-10-02T14%3A08%3A48Z&sktid=398a6654-997b-47e9-b12b-9515b896b4de&skv=2025-11-05&sp=r&spr=https&sr=b&st=2026-10-02T16%3A22%3A43Z&sv=2025-11-05"

Z=""
# 只认"里面真的是应用包"的那个 zip：artifact 外层压缩包解开后才是 桌宠-mac-arm64.zip，
# 两者名字都含 mac-arm64，按名字顺序挑会挑错（挑错的表现是解压后没有包目录）。
# ToDesk/浏览器会把文件落在各处（下载、桌面、home 根、传输子目录），所以按"里面真的是应用包"来找，
# 而不是赌路径 —— 传一半的残包过不了这道检查，不会被误当成品。
for f in "$D/桌宠-mac-arm64.zip" "$D"/*/桌宠-mac-arm64.zip "$HOME/Desktop/桌宠-mac-arm64.zip"          "$HOME/Desktop"/*/桌宠-mac-arm64.zip "$HOME/桌宠-mac-arm64.zip"          $(find "$HOME" -maxdepth 3 -name '桌宠-mac-arm64*.zip' 2>/dev/null | head -8); do
  [ -f "$f" ] || continue
  unzip -l "$f" 2>/dev/null | grep -q '桌宠-mac-arm64/' || continue
  Z="$f"; break
done
if [ -z "$Z" ]; then
  say "[!] 「下载」里没有现成的包，改用免登录直链自己下载（117MB，可能要一两分钟）…"
  curl -L --fail -m 900 -o "$D/桌宠-mac-arm64.zip" "$PKG_URL" 2>>"$RPT"     && say "  ✓ 下载完成：$(du -h "$D/桌宠-mac-arm64.zip" | awk '{print $1}')"     || say "  ❌ 下载失败（多半是直链过期了）—— 让我重新签发一次"
  for f in "$D/桌宠-mac-arm64.zip" "$D"/*/桌宠-mac-arm64.zip; do
    [ -f "$f" ] || continue
    unzip -l "$f" 2>/dev/null | grep -q '桌宠-mac-arm64/' || continue
    Z="$f"; break
  done
fi
if [ -z "$Z" ]; then
  say "❌ 「下载」里没找到 桌宠-mac-arm64.zip。"
  say "   请先在浏览器里登录 GitHub，打开 Actions run 页面点 Artifacts 里的 pet-mac-arm64 下载，"
  say "   再**双击**它解出一个文件夹，把里面的 桌宠-mac-arm64.zip 拖到「下载」根目录，然后重跑本脚本。"
  say "报告已写入 $RPT"; exit 1
fi
say "[1] 包与校验和"
say "  文件 : $Z  ($(du -h "$Z" | awk '{print $1}'))"
GOT=$(shasum -a 256 "$Z" | awk '{print $1}')
say "  sha256: $GOT"
say "  期望  : 48356f0e0d58e4ae5d2c959f913a8c11d66549c45cb8e546982b9548436cb552"
[ "$GOT" = "48356f0e0d58e4ae5d2c959f913a8c11d66549c45cb8e546982b9548436cb552" ] \
  && say "  ✓ 校验和一致（就是 CI 那次出的包）" || say "  ⚠ 校验和不一致：可能是别的 commit 出的包，把上面两行记下来"

say "[2] 解包 + 清隔离"
rm -rf "$OUT"; mkdir -p "$OUT"
unzip -q "$Z" -d "$OUT" || { say "❌ 解压失败"; exit 1; }
PKG=$(find "$OUT" -maxdepth 1 -type d -name '桌宠-mac*' | head -1)
[ -n "$PKG" ] || { say "❌ 解压后没找到包目录"; exit 1; }
xattr -dr com.apple.quarantine "$PKG" 2>/dev/null
say "  包目录 : $PKG"
say "  隔离属性残留: $(xattr -rs com.apple.quarantine "$PKG" 2>/dev/null | wc -l | tr -d ' ') 处（应为 0）"
if [ -f "$PKG/src/main/mac/keybeat" ]; then
  say "  ✓ 打字探针在位：$(file -b "$PKG/src/main/mac/keybeat")"
else
  say "  ❌ 包里没有 src/main/mac/keybeat —— 打字状态在 mac 上会不可用"
fi

say "[3] 代码签名（arm64 漏一个就是启动即 Killed: 9）"
APP="$PKG/node_modules/electron/dist/Electron.app"
if [ -d "$APP" ]; then
  codesign --verify --deep --strict "$APP" >/dev/null 2>&1 \
    && say "  ✓ Electron.app 递归严格校验通过" \
    || say "  ❌ Electron.app 校验失败：$(codesign --verify --deep --strict "$APP" 2>&1 | head -1)"
else
  say "  ❌ 找不到 $APP"
fi
TOT=0; BAD=0
for f in $(find "$PKG" -path "*Electron.app" -prune -o -type f \( -name '*.node' -o -name '*.dylib' -o -perm -u+x \) -print 2>/dev/null); do
  file -b "$f" 2>/dev/null | grep -q 'Mach-O' || continue
  TOT=$((TOT + 1))
  codesign --verify "$f" >/dev/null 2>&1 || { BAD=$((BAD + 1)); say "    ✗ 无签名/失效: ${f#"$PKG"/}"; }
done
if [ "$TOT" = "0" ]; then
  say "  ❌ bundle 外一个 Mach-O 都没扫到 —— 检查没跑起来，**不能算通过**"
elif [ "$BAD" = "0" ]; then
  say "  ✓ bundle 外 Mach-O 全部签名有效（共 $TOT 个）"
else
  say "  ❌ $BAD/$TOT 个 Mach-O 签名不可用"
fi

say "[4] 真机启动"
chmod +x "$PKG"/*.command 2>/dev/null
open "$PKG/启动桌宠.command" 2>/dev/null || say "  ⚠ open 失败，请手动双击 启动桌宠.command"
say "  等 12 秒让它起来…"; sleep 12
N=$(ps -eo command | grep -c "[桌]宠-mac-arm64/node_modules/electron/dist/Electron.app")
if [ "${N:-0}" -ge 3 ]; then
  say "  ✓ 起来了：Electron 进程 ${N} 个（主 + GPU + 网络 + 渲染）→ arm64 强制签名这条通过"
else
  say "  ❌ 只数到 ${N:-0} 个进程，疑似启动即被杀，看第 [5] 步日志"
fi
P=$(ps -eo command | grep -c "[k]eybeat")
say "  打字探针进程数: ${P:-0}（≥1 表示常驻监听已起来）"

say "[5] 崩溃 / 签名拒绝日志（近 5 分钟）"
L=$(log show --last 5m --style compact --predicate 'eventMessage CONTAINS "Code Signature" OR eventMessage CONTAINS "Killed" OR process == "taskgated"' 2>/dev/null | grep -c "Code Signature\|Killed")
say "  相关行数: ${L:-0}（0 = 没记录到异常）"
log show --last 5m --style compact --predicate 'eventMessage CONTAINS "Code Signature" OR eventMessage CONTAINS "Killed"' 2>/dev/null | tail -6 | sed 's/^/    /' | tee -a "$RPT" >/dev/null

say "[6] 便携数据"
[ -f "$PKG/data/settings.json" ] && say "  ✓ 包内 data/settings.json 已生成（便携语义正常）" \
                                || say "  ⚠ 还没生成 data/settings.json（刚启动或写入被拒）"
say "  辅助功能：系统设置 → 隐私与安全性 → 辅助功能，确认对应项已勾选（未授权时打字不换图**且不报错**）"

say ""
say "########## 结论摘要 ##########"
grep -E "✓|❌|✗|sha256|期望|进程数|隔离|相关行数" "$RPT" | tail -16 | tee -a /dev/null
say ""
say "还要人眼确认这 4 条（脚本判不了观感）："
say "  a) 点人物摸头 → 弹完之后不再闪/抖"
say "  b) 等 6~7 秒自动动画 → 换帧那一瞬人物不整块消失"
say "  c) 敲键盘 → 两张打字图交替，停手约 1 秒回主图"
say "  d) 大小与 Windows 版一致（已调到原来的 70%）"
say ""
say "完整报告：$RPT —— 把这个文件传回来即可。"
