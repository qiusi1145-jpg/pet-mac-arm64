# 桌宠 macOS 移植方案（工作文档）

> 状态：**规划中，尚未动工**。本文 = 这次移植的唯一交接入口，含现状盘点 / 已定决策 / 删除面 /
> 风险清单 / 分批计划 / **需要你补充的信息** / **需要你做的事**。
> 基线：Windows 分支 `master`，commit `77d3b5f`（2026-09-28）。
> 关联文档：README.md（当前功能权威）、版本日志.md（沿革）、bug修炼手册.md（踩坑复盘）。

---

## 0. 一页结论

- 技术栈：**Electron 37 + 纯 JS**，64 个源文件。渲染层业务逻辑 100% 平台无关。
- Windows 耦合只集中在 **3 个文件**：`src/main/winenum.js`、`src/main/typing.js`、`main.js` 里 5 处分支。
- **已决定删除「窗口顶沿吸附」** → macOS 侧最大的阻塞点（窗口枚举 / 屏幕录制权限）**整体消失**。
- **语音排二期** → 原生 `.node` + 麦克风 entitlements + DYLD 这三个坑一期完全不碰。
- 打字状态探针未授权即置灰（既有能力，`typing.js:92` 已经对非 win32 返回 `available()=false`）
  → **一期不需要写任何 macOS 原生代码**。
- 因此一期的全部风险都落在「透明置顶穿透窗 + 不冻结别的窗口」这一条上，
  而这条 **在你的 Intel/AMD macOS VM 上就能验证**（它测的是 macOS API 行为，与 CPU 架构无关）。

---

## 1. 已定决策（本轮确认，不要回头再议）

| # | 决策 | 内容 | 理由 |
| --- | --- | --- | --- |
| D1 | 分发形态 | **解开的文件夹 + `.command` 启动**，不做 `.app` | 保住现有「整个文件夹拷走即用」的便携语义（`data/` 就在应用旁边）；`.app` 会让 `app.getAppPath()` 变成包内只读且写文件破坏签名 |
| D2 | 权限降级 | 未授权 → **菜单项置灰 + 写明原因 + 引导授权**，不静默失败 | 与既有红线一致（语音全局键注册失败要如实回报、缺素材优雅隐藏） |
| D3 | 语音 | **排二期，代码不删** | 见 §2 |
| D4 | 吸附 | **删除**（本文 §3 是完整删除面） | macOS 上代价过高（见 §2） |
| D5 | 打字状态（形态三） | **保留**，但 macOS 实现排二期 | 一期靠 D2 自动置灰，零成本 |
| D6 | 验证环境 | 现阶段只有 **Intel/AMD 机上的 macOS VM（x86_64）** | 决定了 §7 的分工与 §5 R4 这个必须留到真机的盲区 |

**关于 D3 为什么不直接删**：语音代码全留、macOS 一期只「不装模型」即可 —— 现有降级矩阵已保证缺模型时
`asr.js` 加载失败 → 主进程禁用语音并提示「语音模型未安装」，应用不崩。留着的代价≈0；
删要动 8 个文件、12 个 `voice:*` IPC 通道，并拆掉 `voice-wiring.test.js`（正是它抓出过
2026-09-15「漏调 `startVoice()`」那次事故）这条回归门禁。另外 `.onnx` 模型文件跨平台，
将来启用直接拷 `data/voice/models/` 即可，不必重下 160MB。

---

## 2. 为什么「删吸附」能把移植难度砍掉大半

吸附在 macOS 上需要「枚举其它窗口的位置和标题」，Windows 侧是 `EnumWindows` + `GetWindowRect` +
`DWMWA_CLOAKED`（`winenum.js:14-44`）。macOS 对应方案是预编译一个 Swift/ObjC helper 调
`CGWindowListCopyWindowInfo`，代价：

1. **必须构建期预编译并随包分发** —— macOS 没有系统自带编译器，`winenum.js` / `typing.js` 那套
   「用 csc.exe 运行期现编 C#」的零原生依赖范式**在 mac 上根本不成立**。
2. **macOS 14+ 无「屏幕录制」权限时 `kCGWindowName` / `kCGWindowOwnerName` 返回空串** → 标题过滤退化。
3. 坐标原点左下、多空间/全屏 Space、`kCGWindowLayer` 语义与「cloaked 标签页」不对等 → 脱落检测要重做。
4. 引入签名问题（arm64 强制签名，见 §4）。

删掉吸附之后：**这 4 条全部作废**，macOS 一期唯一的原生 helper 需求只剩打字探针，而它按 D5 排到二期。

---

## 3. 吸附删除面（**动手前先逐条核对**）

⚠ **头号陷阱**：`winenum.js` 里同时住着两件事 —— 吸附用的窗口枚举，和**防冻结用的
`applyExStyle`（写 `WS_EX_TOOLWINDOW`）**。后者是 README「不冻结其它窗口三层防护」的根治手段，
**必须保留**。只删前者。

| 文件 | 行 | 删什么 | 注意 |
| --- | --- | --- | --- |
| `src/main/winenum.js` | 14–44, 93–114, 160–190, 193–201 | `CS_SOURCE` 枚举源码、`ensure()`、`list()`、`parse()`、`isSystemWindow()` | **保留** `STYLE_SOURCE` / `ensureStyle()` / `applyExStyle()` / `findCsc()` |
| `src/main/main.js` | 34, 151, 299–301, 640–646, 1615–1622 | import 里的 `isSystemWindow`、`this.winEnum = new WinEnum`、`winEnum.ensure()`、`enumerate:windows` handler、托盘「窗口顶沿吸附」勾选项 | `this.winEnum.applyExStyle(...)`（383–388）**不动** |
| `src/renderer/app.js` | 85–90, 271 局部, 785–812 的吸附分支, 813–约 900 | `snap` / `snapEnabled` / `snapPollTimer` / `_snapWinOverride` / `fetchWindows` / `attemptSnap` / `ensureSnapPoll*` / `snapPollTick` / `grabSnapped` / `snapAnchorScreen` | `routeRelease()`（785）**不能整删**：它是「甩出→抛掷 / 低速→坠落」的路由，删吸附分支后要保留「低速 → 原地坠落」语义 |
| `src/shared/motion.js` | 338–369, 384 | `chooseSnapTarget()`、`shouldDetach()` 及导出 | 其余物理/手势/弹簧函数不动 |
| `src/shared/config.js` | 70–73, 176–180 | `snapProximityY`、`snapMarginX`、整块 `snapPoll` | config 深冻结，删键要同步删注释 |
| `src/shared/content.js` | 32, 87 | `snapEnabled` 默认值与清洗 | **持久化兼容**：老 `settings.json` 里残留的 `snapEnabled` 键要靠清洗函数忽略掉，不能报错 |
| `src/main/uiScenarios.js` | 723–765（`snap` 场景）、1074–1134 内「物理关·吸附仍工作」③④段 | 整场景删除 → **场景数 22 → 21** | 场景总数有断言，删后要同步所有计数（含 README 与 `ui.test.js`） |
| `test/unit/motion.test.js` | ~28 处 | 吸附目标选择 / 脱落判定用例 | |
| `test/unit/content.test.js` | ~4 处 | `snapEnabled` 清洗用例 | 建议改留 1 例：断言老数据里的 `snapEnabled` 被安全忽略 |
| `test/ui/ui.test.js` | 引用处 | 场景清单 | |
| `README.md` | 标题段、57–70 交互速查两行、72–96 托盘描述、97–148 特色功能、495–540 关键机制 | 所有「吸附」叙述 | |
| `data/settings.json`、`data/winenum/` | | 运行期产物 | `data/winenum/` 里只剩 `winstyle.exe` 有用，`winenum.exe` 是死产物 |

**可选（需你点头）**：把 `winenum.js` 改名为 `winstyle.js`（它只剩「改窗口扩展样式」一个职责了），
并同步 `typing.js:28` 的 `findCsc` import。不改名也行，但文件名的"枚举"含义会变成误导。

**连带效应**：物理模拟关闭那条场景（1074 起）原本靠注入「没有窗口」来避免吸附干扰，删吸附后
这段干扰天然消失，该场景要相应简化（不是简单删行，断言 `st.snap === null` 全部作废）。

---

## 4. 硬事实清单（移植全程会反复撞到，全部已核实）

1. **`setIgnoreMouseEvents(true, {forward:true})` 的 `forward` 在 macOS 上支持**
   （Electron 官方文档标 `_macOS_ _Windows_`，非 Windows 独有）。而且本项目命中判定本来就走
   主进程 16ms IPC 推光标（`app.js:1007`），不依赖 forward → **核心红线机制可平移，且有双保险**。
2. **`focusable` / `setSkipTaskbar` 在 macOS 上同样是受支持的 API**（文档标 `_macOS_ _Windows_`）。
   但「点击不抢前台」这条在 mac 上必须实测确认，不能照文档相信。
3. **`Tray` 的 `double-click` 事件在 macOS 上不发出**（Electron 文档明确）。
   → 现有「左键双击托盘显示宠物」要改成 `click` 或菜单项。
4. **`disable-features=CalculateNativeWinOcclusion` 是 Windows 特性名**（`main.js:112`）。
   macOS 的窗口遮挡走 `NSWindowOcclusionState` 另一套 → 这个开关在 mac 上无效，
   防「自己被判遮挡 → rAF 停转 → 桌宠点不动」要靠既有的 `backgroundThrottling:false` + 光标 IPC 兜底，
   **并且必须实测**。
5. **`WS_EX_TOOLWINDOW` 在 macOS 无对应位**（`main.js:383–388`）。替代机制：
   `app.dock.hide()` / `LSUIElement` + 窗口 `collectionBehavior`。这是三层防护里唯一要换实现的。
6. **arm64 macOS 拒绝加载任何无签名二进制**（Big Sur 起强制，x86_64 无此约束）。
   → 所有 mac helper 与 Electron 二进制至少要 `codesign -s -` ad-hoc 签名。
   **这是 VM 验证的最大盲区**：在 x86 VM 上漏了签名不会报错，只在 M2 上表现为「已损坏，无法打开」。
   缓解：打包流程里把签名做成强制步骤 + 加一条自检断言。
7. **quarantine**：从 AirDrop/浏览器/压缩包带来的文件带 `com.apple.quarantine` → Gatekeeper 拦。
   `git clone` 不设该属性。→ **在 Mac 上 clone，不要拷文件夹过去。**
   `.command` 还需可执行位，用 `git update-index --chmod=+x` 让 git 带过去。
8. **架构不是问题，环境才是。** 但**绝不允许**把 VM 里 `npm install` 出来的产物拷去 M2
   （装的是 `darwin-x64`，架构不对）。跨架构产出用：
   `npm install --os=darwin --cpu=arm64` + `ELECTRON_SKIP_BINARY_DOWNLOAD=1 electron_config_arch=arm64 node node_modules/electron/install.js`。
   这样组出来的 arm64 文件夹**结构正确但一次都没运行过**，只能当半成品。
9. ~~**sherpa-onnx 有 M2 原生包**：…但 darwin 上加载要设 `DYLD_LIBRARY_PATH`…→ 二期实测点。~~
   **已实测推翻（2026-09-28）**：`npm install` 在 darwin 上自动装 `sherpa-onnx-darwin-x64`
   （含 `libonnxruntime.dylib` 等），且 `require('sherpa-onnx-node')` **无需设 `DYLD_LIBRARY_PATH`**
   即可加载 —— `voice:e2e` 的 `require-ok → recognizer-ok → kws-ok → ready-sent` 全链走通。
   addon.js 里那句 DYLD 提示只是它加载失败时的兜底建议，不是前提条件。
10. ~~**`getUserMedia` 读 bundle 的 `NSMicrophoneUsageDescription`，`electron .` 拿不到权限**。~~
    **已实测推翻（2026-09-28）**：Electron 37 自带的 `Electron.app/Contents/Info.plist`
    **已经声明了** `NSMicrophoneUsageDescription`（值 "This app needs access to the microphone"），
    所以 `electron .` 直接跑就能过权限、拿到活动音频轨。⇒ **D1「不做 .app」不阻塞语音**，这条原以为的
    冲突不存在。仍要留意的只有 TCC 首次授权弹窗。
11. **Retina 2x 可以不靠真机验**：`--force-device-scale-factor=2` 强拉 `devicePixelRatio`，
    覆盖像素命中判定与碰撞盒的缩放路径。
12. macOS 自带 `curl` 与 `tar`（bsdtar）→ `tools/fetch-voice-model.js:61,135` 硬编码
    `C:/Windows/System32/*.exe` 改成先试裸命令即可。

---

## 5. 逐功能可移植性判定

| 功能 | 判定 | macOS 侧要做的事 |
| --- | --- | --- |
| 像素级点击穿透 / 光标 IPC 推送 | ✅ 可平移 | 仅 R4/R5 需实测 |
| 拖动 1:1、抛掷物理、落地/贴墙碰撞盒 | ✅ 无需改 | — |
| 状态系统、眨眼、随机特效、形态切换 | ✅ 无需改 | — |
| 打字状态（形态三） | ⚠ 二期 | 一期 `available()=false` 自动置灰（已实现） |
| 窗口顶沿吸附 | ❌ **删除** | §3 |
| 待办 / 随机催促 / 番茄钟 / 学习计划表 / 学英语 | ✅ 无需改 | — |
| 聊天规则引擎 + LLM（HTTPS/SSE）+ 聊天记录 + 密钥文件 | ✅ 无需改 | `chmod` 在 win 无效、mac 有效，保留 |
| 7 个工具窗、单实例锁 | ✅ 无需改 | — |
| 背景图 / BGM 播放列表 / BGM 闪避 | ✅ 无需改 | — |
| 活动区域设置、应用内素材选择器 | ✅ 无需改 | `pickerRoots()` 用 `app.getPath`，天然跨平台 |
| 托盘 | ⚠ 需改 | template 图 + `double-click` 替代（R3） |
| 语音（离线识别 + 唤醒 + PTT） | ⏸ 二期 | R9/R10 |
| 全局键 PTT | ⏸ 随语音二期 | mac 上注册热键可能需辅助功能权限 |
| `.bat` 启动器 / 打包脚本 | ❌ 重写 | `.command` + mac 打包 |
| `migrateLegacyPortableData()`（`main.js:205–235`） | ✅ 不崩 | mac 上 `getPath('appData')` 指 `~/Library/Application Support`，有 `existsSync` 保护；可保留或顺手删 |

---

## 6. 分批实施计划

### 批次 A：删吸附（**在 Windows 上做完整回归后才能开始移植**）
1. 按 §3 逐文件删除，`routeRelease` 保留「低速 → 坠落」。
2. 文档同步：README（标题段/交互速查/托盘/特色功能/关键机制）、版本日志新增一条删除记录（写明"macOS 移植决策 D4"）。
3. 场景数 22 → 21 的所有计数断言同步。
4. **验收**：`npm run test` 全绿 → `npm run test:smoke` 通过 → `npm run test:ui` 21/21 →
   Windows 上人工确认「物理关闭时低速松手 = 悬在原地」这条既有行为没变。
5. 单独提交一次，commit 信息只讲删吸附。**这是移植前的干净基线。**

### 批次 B：平台分派骨架（不需要任何 mac 环境）
1. `winenum.js` → 拆出 `applyExStyle`（保留）与已删的枚举（A 批已完成）；`findCsc` 归位。
2. `typing.js` 已具备 `available()/start()/stop()/'beat'` 契约，**不动逻辑**，只把注释里的
   macOS 落地条件补全（构建期预编译、辅助功能引导 API 名）。
3. `main.js` 5 处 `process.platform === 'win32'` 分支补 mac 分支：dock 隐藏 / collectionBehavior /
   遮挡特性名 / skipTaskbar 语义。
4. 新增 `src/main/platform.js` 集中所有平台判定（目前散在 3 个文件里），避免以后到处 `if`。

### 批次 C：mac 壳层
1. `.command` 启动器（+ `git update-index --chmod=+x`）。
2. `fetch-voice-model.js` 去 System32 硬编码。
3. `index.html` 字体栈补 `"PingFang SC"` 打头（现 `"Microsoft YaHei"` 优先，mac 上会退到默认无衬线）。
4. 托盘 template 图（黑白 alpha，18pt @1x/2x）+ `double-click` 替代入口。
5. 便携 `data/` 在 mac 上的路径校验（非 ASCII 目录名、`os.tmpdir()`、`chmod 600`）。

### 批次 D：验证脚手架（决定协作效率的一批）
`tools/mac-verify.sh` —— 一条命令跑完并把结果打成可贴回来的报告：
- 阶段 0 环境：`sw_vers` / `node -v` / `npm -v` / `uname -m` / `codesign -dv` 结果 / 有无 quarantine
- 阶段 1 静态：`npm run test`（纯函数单测，与平台无关，**必须全绿**）
- 阶段 2 启动：冒烟 + 21 个 UI 场景（`--force-device-scale-factor=2` 再跑一遍，覆盖 Retina 路径）
- 阶段 3 **穿透与冻结探针**（本次移植的核心风险）：mac 上开一个播放 GIF 的浏览器标签 →
  反复点击宠物 → 断言 GIF 不停、宠物不点不动；输出前后帧时间戳对比
- 阶段 4 吸附残留检查：确认全仓无 `enumerate:windows` 调用路径
- 阶段 5 托盘/菜单：托盘菜单项文本 dump，供与 `_trayMenuItems` 断言比对

### 批次 E（二期）：打字状态探针 + 语音 + 真机终验
arm64 helper（Swift + `NSEvent`/`CGEventTap`）+ ad-hoc 签名 + `isTrustedAccessibilityClient` 引导；
语音的 plist/entitlements/DYLD；在真实 M2 上跑一遍全量。

---

## 7. 验证分工（基于 D6：只有 Intel/AMD 上的 x86_64 macOS VM）

**关键判断：这次移植的风险是「macOS API 行为」，不是「CPU 架构」。**
删吸附 + 语音退二期 + 打字探针置灰之后，一期不再需要任何 mac 原生二进制，
所以 —— **一期 100% 的验证需求，x86_64 VM 都能覆盖。** 这是本轮决策换来的最大收益。

| VM 能真实验到 | VM 验不到（必须留到 M2 真机） |
| --- | --- |
| 透明置顶覆盖全工作区窗口的渲染与合成 | M2 GPU 驱动下的合成差异 |
| `setIgnoreMouseEvents` + `forward` 实际行为 | 真实麦克风/扬声器音频链（→ 语音二期） |
| **不冻结其它 Chromium 窗口**（最高风险项） | arm64 原生 helper / `.node` 的加载与**签名**（R6 盲区） |
| 菜单栏 template 图标、`double-click` 缺失 | Gatekeeper 在真机的实际表现（clone vs 拷贝，R7） |
| 遮挡冻结是否复发（R4） | 性能/发热特征 |
| 全部单测 / 冒烟 / 21 个 UI 场景 | |
| Retina 2x 路径（`--force-device-scale-factor=2` 模拟） | |
| 辅助功能权限弹窗与引导流程（二期时才需要） | |

**协作协议**：我在 Windows 改代码 → 你在 VM `git pull && ./tools/mac-verify.sh` →
把完整输出（或 `data/debug.log`）贴回来 → 我定位修。mac 专属的编译、签名、权限三类问题
我在这边无法自证，必须有你在 VM 上跑出来的日志。

**终验（批次 E 之前必须有一次）**：三选一，按成本排序 ——
① 找有 M2 的人当场跑一次，带 U 盘 + 预写的验证脚本，15 分钟出结果（最省）；
② 按小时租云上 Apple Silicon，只在收尾用 1–2 小时做终验（别拿它做日常迭代）；
③ 二手 M2 Mac mini 起步款（若判断这个应用会长期迭代）。

---

## 8. 需要你补充的信息

按重要性排序，**前 3 条不定我没法开工**：

1. **批次 A 删吸附是否影响 Windows 版使用？** 也就是：这次移植后 Windows 版还要不要继续维护、
   两平台是否共用同一份代码（我倾向"共用 + 平台分派"，删吸附对两平台同时生效）。
   若你其实想保 Windows 的吸附、只在 mac 上不做 —— 那 §3 要改成「运行时平台门禁」而不是删除，
   工作量与风险都不同，**必须先说明**。
2. **VM 的 guest macOS 版本**（`sw_vers` 输出）。macOS 13 以下没有按 app 的「屏幕录制」TCC 那套，
   14+ 才有；影响二期判定，也影响 Electron 37 的最低系统支持。
3. **虚拟化宿主**（VMware Workstation / Fusion、VirtualBox、UTM、Hyper-V）。
   影响：VMware 能透传宿主麦克风（语音二期可顺带验一部分），VirtualBox 基本不行；
   也影响 macOS guest 的 GPU 加速可用性 —— 而这正是本项目的核心风险点。
4. **VM 里能否联网访问 GitHub Releases 与 npm**（国内网络环境下这条经常不成立，
   要提前准备镜像：`ELECTRON_MIRROR` 项目 README 里已有）。
5. **目标 macOS 最低支持版本**（只要 M2 上现在的系统，还是要覆盖 macOS 12/13？影响特性可用性判断）。
6. **是否要求同时产出 arm64 与 x86_64 两份包**（你自用只要 arm64；若还要发给别人可能有 Intel Mac）。
7. **`winenum.js` 是否同意改名 `winstyle.js`**（§3 末尾的可选项）。
8. **一期范围确认**：批次 A+B+C+D 一次做完再上 VM，还是每批做完都上 VM 验一次？
   （我建议后者，穿透那条越早发现越早止损。）

## 9. 你需要做的事

**准备阶段（现在就能做，与我的进度无关）**
- [ ] 回答 §8 的 1–4 条。
- [ ] VM 里装好 Command Line Tools：`xcode-select --install`（一期不需要 Xcode 本体，二期编 helper 才要）。
- [ ] VM 里装 Node LTS（你 Windows 侧是 v24，VM 装同大版本以免行为差异），并确认
      `npm -v ≥ 9.4`（批次 E 跨架构产出要用 `--os/--cpu`）。
- [ ] 建一个 mac 用的 git 远端（或让 VM 能访问本机 git 服务）。**注意：mac 侧一律 `git clone`，
      不要拷文件夹/压缩包过去**（R7 quarantine）。
- [ ] 在 VM 里 `git clone` 本项目 → `npm install`（此时会拉 `sherpa-onnx-darwin-x64`，约 22MB；
      若网络不通先只做 §8 第 4 条的排查）。
- [ ] 确认 VM 能显示播放 GIF 的浏览器（批次 D 阶段 3 的对照组要用）以及能截图。

**我这边并行推进（不需要你等）**
- [ ] 批次 A 删吸附 + Windows 全量回归。
- [ ] 批次 B/C 平台分派与 mac 壳层。
- [ ] 批次 D `mac-verify.sh`（含阶段 3 穿透探针，这条最需要你那边能跑通）。

**你准备好之后告诉我，我把 §8 的答案补进本文并开工批次 A。**

---

## 10. 首轮 VM 实测记录（2026-09-28，macOS 15.3 x86_64 / VMware / Workstation + unlocker）

环境：macOS **15.3**、x86_64、8GB、130GB 可用；宿主 Core Ultra 7 255HX；网络 npm registry 与 github 均 200。
接入方式：**SSH 免密直连**（`~/.ssh/config` 别名 `macvm`），我可在宿主侧直接执行与取证。

### 10.1 结果

| 项 | 结果 |
| --- | --- |
| `npm run test`（纯函数单测） | ✅ **310 通过 / 0 失败** |
| `npm run test:smoke` | ✅ **SMOKE PASS**，`consoleErrors=0` |
| `npm run test:ui` | ⚠ **仅 `snap` 一个场景失败，其余全过** |
| 应用真实启动（`npm start`） | ✅ 区域/窗口/页面/语音降级全部正常，**桌宠实际在显示**（见 10.3） |
| Electron 37 + `sherpa-onnx-darwin-x64` | ✅ 均装上了 |

`snap` 失败得**干净**，正是删除吸附前想要的基线证据：

```
[winenum] 编译失败（吸附将不可用）： csc.exe not found
[scenario] 断言失败: 吸附后实体底边贴窗口顶(y=143≈168)
```
不崩进程、不污染其它场景、`consoleErrors=0`。`typing` 场景也 PASS（TEST_MODE 走注入节拍，不碰真钩子）。

### 10.2 新增的硬事实（补进 §4，编号续）

13. **`workArea` 在 mac 上返回 `y=25`**（菜单栏被正确扣除），`x=0 w=1024 h=682`。区域计算无需改。
14. **从 SSH 会话调 `screencapture` 看不到任何窗口内容**（无「屏幕录制」TCC 权限 → 只给桌面和菜单栏，
    窗口一律空白）。**这不是渲染 bug。** 取证要改用 Electron 自身 `webContents.capturePage()`
    （不需要任何权限），或在 VM 的 Terminal.app 里跑一次并授予屏幕录制。
    ⚠ 这条是本轮最大的踩坑点：一度让我误判成"宠物窗没显示"。
15. **透明 + `focusable:false` + `screen-saver` 层级 + `show:false`→`ready-to-show`→`show()` 这套
    在 macOS 上完全成立**：`ready-to-show` 正常触发、`isVisible=true`、自截像素与预期精确吻合。
    带不带 `focusable:false` 渲染结果一致。→ **穿透窗这条核心红线在 mac 上没有被破坏。**
16. **Electron 二进制从 GitHub Releases 下载会被服务端中断**（`ReadError: The server aborted pending request`，
    `npm install` 退出码 1）。必须带 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
17. **CLT 可以完全静默安装**，不必点 GUI 弹窗：
    `touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-product && softwareupdate --list`
    → `sudo softwareupdate -i "Command Line Tools for Xcode-16.4"`（约 750MB，几分钟）。
18. **Node 可装进家目录免 sudo**：官方 `darwin-x64` tarball 解到 `~/.local/node` + 写 `~/.zprofile`。
    本轮装到 v24.21.0，与 Windows 侧同大版本。
19. **npm 在 darwin 上会自动装 `sherpa-onnx-darwin-x64`**（实测在位，含 `libonnxruntime.dylib` 等）。
    → 印证 §5 判断：M2 上会自动拿 `darwin-arm64`，**不需要我们自己编译或配包**。
20. **语音降级链在 mac 上按设计工作**：缺模型只报
    `[voice] init: no-model 缺模型文件：<...>/data/voice/models/sherpa-onnx-streaming-zh-int8-2025-06-30`，
    服务照常启动、不崩。→ D3「语音代码全留、一期不启用」这条决策已被实测验证成立。
21. 首次运行 `data/` 不存在时，**内置素材能自动加载**（`petLoaded=true pet=220x220`），
    不需要先跑 `assets:gen`。便携目录在 mac 上正常创建。

### 10.3 关于"看不到宠物"

排查过程（结论：**没有 bug，是取证工具的问题**）：
① 全屏截图纯白 → ② 对照发现**不跑应用时桌面也是纯白**（VM 空壁纸），排除"透明渲染成白" →
③ 独立 Electron 探针画红块，`isVisible=true` 但 `screencapture` 仍截不到 →
④ 改用 `capturePage()` 自截并数像素，红块 35200px（=220×160 精确吻合）、描边 1336px、PNG 1490B（背景透明）
→ 判定窗口内容一直正常，`screencapture` 因缺屏幕录制权限而对所有窗口失明（见 §4 第 14 条）。

**待办**：给 VM 里的 Terminal.app 授予「屏幕录制」，之后 `screencapture` 才能作为可视化取证手段使用。

### 10.5 批次 A/B/C/D 已完成（2026-09-28）

**批次 A 删吸附**：见 §3 全量执行。`winenum.js` 只保留样式工具（文件名有意不改，头部注释写明职责已变）。
`routeRelease` 保留「物理开·低速→轻坠」「物理关→原地停」两条语义。
**批次 B 平台分派**：新增 `src/main/platform.js`（`process.platform` 判断收口于此一文件）——
`applyStartupSwitches` / `hideFromDock` / `guardPetWindow`。macOS 上 `guardPetWindow` 返回
`{applied:false, reason:"platform:darwin"}` 并**如实落日志**，不静默。新增 `test/unit/platform.test.js`。
**批次 C 壳层**：`启动桌宠.command` / `启动桌宠-调试.command`（LF、shebang、可执行位）；
托盘 macOS 走 **template 图**（36px @2x、纯黑+alpha，系统按菜单栏深浅自动染色）；
**`double-click` 在 mac 上不发出 → 改绑 `click`**；字体栈补 `"PingFang SC"` 打头（9 处）；
`fetch-voice-model.js` 的 `findCurl/findTar` 改为先试裸命令。
**批次 D 脚手架**：`tools/verify-vm.sh`，8 段（环境 → 单测 → 冒烟 → UI（含 `--force-device-scale-factor=2`
复跑覆盖 Retina）→ 语音 e2e → 吸附残留 → 平台防护回报 → 启动器/权限声明），末行给 `✅/❌` 汇总。
配套给 `test/ui/ui.test.js` 加了 `PET_CHROMIUM_ARGS` 注入口（原本无法把 Chromium 开关传进场景进程）。

### 10.6 两平台最终回归（同一份代码）

| | Windows | macOS 15.3 VM |
| --- | --- | --- |
| 单测 | 310：309 通过 / 1 平台反向跳过 / **0 失败** | 310：308 通过 / 2 平台反向跳过 / **0 失败** |
| 冒烟 | PASS | PASS |
| UI 场景 | 21/21 PASS | 21/21 PASS（默认缩放 + `devicePixelRatio=2` 各一遍） |
| `voice:e2e` | —（未在本轮重跑） | **VOICE_E2E_OK** |
| `verify-vm.sh` | 不适用 | **✅ 全部通过** |

视觉取证（宿主侧截 VMware 窗口）：火柴人正常显示且**压在系统设置窗口之上**（`screen-saver` 层级生效）、
状态胶囊 `80 ⚡100 🍖79` 渲染正常、**Dock 里的 Electron 图标已被 `app.dock.hide()` 收掉**。

### 10.7 顺带修掉的一个既有缺陷（不是移植引入）

**低帧率下抛掷物理永远回不了待机**。原地板判定用「撞击前速度 > `stopSpeedY`(40)」区分回弹/贴地，
但帧率越低、一步里重力攒下的速度越大（`2600/30 ≈ 87`），于是稳定顶穿阈值 →
宠物卡在"贴地小弹跳"的极限环里（实测 macOS 软件渲染 ~30fps 必现，`y` 正好停在地面、`vy≈-32` 反复弹）。
60fps 只是侥幸收敛，**低帧率的 Windows 机器同样会中**。
改为用「回弹能弹起的高度」判收敛（`v²/2g < settleBouncePx` 即直接贴地），与帧率无关。
新增回归：`物理：低帧率下也必须收敛到贴地静止`，在 60/30/15fps 下各跑一遍并限 4 秒内收敛。

## 11. 遗留：只有真实 M2 能回答的问题

| # | 事项 | 为什么 VM 答不了 | 需要做什么 |
| --- | --- | --- | --- |
| L1 | **会不会冻结其它 Chromium 窗口** → **已改成自动断言（2026-09-29）** | 原来只能"有真机的人肉眼盯 GIF"，结论不可重放、改一次窗口层级就得重看 | UI 场景新增 `occlusion`：在待办窗里跑 `requestAnimationFrame` 计数，分"宠物窗隐藏/显示且在动"两种状态各采样 1.5s，断言①对照组确实在画（`>=10` 帧，否则测量本身不可信）②被测态没冻结（`>0`）③掉帧不超过对照组一半 ④恢复显示后帧率回来。**边界**：帧率是间接指标，抓得住"完全冻结/严重掉帧"，抓不住"合成正确但视觉有薄影/毛刺"——那部分仍需人眼 |
| L2 | **语音进入对话后采集不起帧** | VM 虚拟声卡 `peak=0`（静音），分不清是 mac 采集管线问题还是无声源 | 真机上跑 `voice:e2e`，看 🎤 之后 `state` 是否变 `decoding`；不变则查 `asr.js` 的 `ensureCapture/beginUtt` |
| L3 | ~~arm64 强制签名~~ **已关闭（2026-09-29，真 M1 CI 全绿）** | x86_64 不校验签名，VM 上漏签名不报错 | GitHub Actions `macos-15`（真 M1）上原生出包 + 对分发包跑完 L1/L2/L3：20/20 Mach-O 签名有效、`SMOKE_OK`、`UI_ALL_PASS`。见 §12.4 与 `.github/workflows/mac-arm64.yml` |
| L4 | ~~辅助功能权限与打字探针（形态三）~~ **已完成 2026-09-28** | VM 里就能真验（辅助功能弹窗正常），已验通 | 见 §13 |
| L5 | **真机 macOS 小版本** | VM 是 15.3，目标机大概率 26.x | 能碰到那台 M2 Pro 时先跑 `sw_vers` 回填，按该版本重点复验 L1/L2 |

---

## 12. 打包与分发（ad-hoc 签名路线，0 费用）

决策：**不买 99 刀开发者账号，走 ad-hoc 签名**，接受"每次更新重弹一次 TCC 授权"这个代价。

### 12.1 为什么必须签

Apple Silicon 上内核 + AMFI **强制要求所有 Mach-O 有有效签名**，未签名直接 `Killed: 9`
（`Code Signature Invalid` / `load code signature error 2`）。这是内核层，
**「系统设置 → 仍要打开」绕不过它** —— 那个按钮只绕 Gatekeeper。ad-hoc（`codesign -s -`）即可满足。

### 12.2 `tools/mac-package.sh` 的三条硬规矩（都是踩出来的）

1. **顺序只能"由内向外、外层最后、签完不再碰"。**
   实测反例：先 `--deep` 签外层、再逐个重签内部 `.dylib` → 外层封印被打破，
   `codesign --verify --deep --strict` 报 `a sealed resource is missing or invalid`。
2. **`--deep` 有盲区，必须补签。** 实测它**不签** `X.framework/Versions/A/Libraries/*.dylib`
   （libEGL / libGLESv2 / libffmpeg / libvk_swiftshader）和 `Resources/ShipIt` —— 共 5 个。
   这些要在 `--deep` **之前**单独签。
3. **路径带空格，遍历必须 `-print0` + `read -d ''`。** 实测 `for f in $(find)` 把
   `Electron Framework.framework` 切碎，报一串假"签名失败"。

### 12.3 假绿灯教训（脚本设计红线）

第一版的"逐个 Mach-O 校验"因遍历写法错误**实际扫描 0 个文件却打印 ✓**。
所以第 5 段现在有硬守卫：**`TOT == 0` 直接判失败**。任何"检查"若可能静默不执行，
就必须让它扫不到东西时报错，而不是报通过。

### 12.4 产物与验收

`sh tools/mac-package.sh [arm64|x86_64]` → `dist/桌宠-mac-<arch>/`（实测 317MB）。
不带 `data/`（用户数据首启自建）、不带语音模型（缺模型时按设计优雅隐藏语音）。

VM 里出 x86_64 包，并**对分发包本身**（不是开发树）跑完整验证：

```
319 单测（317 通过 / 2 平台反向跳过 / 0 失败）· SMOKE_OK · UI_ALL_PASS ×2（含 devicePixelRatio=2）
✓ 全部 Mach-O 签名有效（共扫描 20 个）· ✓ Electron.app 递归严格校验通过
✓ 包内无隔离属性残留 · ✅ verify-vm.sh 全部通过
```

> ⚠ 上面这块是**验收清单**，不是"每次都全绿"的存档。2026-09-29 为查形态三重出的
> x86_64 包目前只跑到：签名 20/20 ✓、包内 L1 单测 317 通过 / 0 失败 ✓；
> L2 smoke 与 L3 UI 还没在这份新包上重跑（它们会抢单实例锁，必须等宠物退出后再跑）。

**M2 出包**：在 Apple Silicon 机器上直接 `sh tools/mac-package.sh`（默认按本机架构出 arm64）。
交叉出包（在 Intel/VM 上 `sh tools/mac-package.sh arm64`）能产出**结构正确但从未运行过**的包，
只能预先备货，不能替代真机验证。

### 12.5 写给最终用户的话（发版时随包附上）

- 放到 `~/桌宠` 这类路径，**别放桌面 / 文档** —— iCloud 同步会改文件、破坏签名，症状正是"已损坏，无法打开"。
- 首次双击若被拦：**别照"系统设置 → 仍要打开"写给用户** —— 那条只对 `.app` / 安装包成立，
  我们的启动器是 `.command`，实测被拦后没有任何 GUI 放行入口，见 §12.5.1。
- 用微信 / QQ 传这个文件夹通常不加隔离属性，用户完全无感；浏览器下载才需要走上一条。
- ⚠ 若启用语音：**ad-hoc 的 Designated Requirement 绑在具体那份代码哈希上**（Apple TN3127 原文），
  所以每次更新后麦克风授权会重新询问一次。**不用语音就没有这个代价。**

#### 12.5.1 补充实测（2026-09-29）：`.command` 被隔离时**没有**「仍要打开」

VM 里给 `启动桌宠.command` 手工加上 `com.apple.quarantine` 后，双击弹的是截图那种
**只有「完成 / 移到废纸篓」两个按钮**的框。命令行侧的实测判定：

```
spctl -a -vvv 启动桌宠.command   →  rejected / source=no usable signature   （要等约 6 分钟才返回）
open          启动桌宠.command   →  _LSOpenURLsWithCompletionHandler() failed with error -128
xattr 文件                          →  com.apple.quarantine 依然在（被拒不会清掉属性，重试还是同样结果）
```

查 Apple 官方《在 Mac 上安全地打开 App》(support/102445)：这套放行机制的适用对象写的是
**"Mac App、插件和安装器软件包"** —— 纯脚本不在其中，所以 §12.5 第二条那句"点仍要打开"
**对 `.command` 不成立**，别照它写给用户。

用户侧真正可用的三条路（按省事程度排）：
1. **传输方式避开隔离属性**：微信 / QQ / 网盘分享链接、AirDrop 都不打 quarantine 标记；
   浏览器下载（Safari/Chrome）会打。发版时把"请用网盘/微信传，不要放浏览器直链"写进说明。
2. **一行命令清掉**（对已隔离的文件夹最有效，也是唯一对所有文件类型都成立的）：
   `xattr -dr com.apple.quarantine ~/桌宠-mac-arm64`
3. **改成 `.app` 外壳**（把启动脚本塞进 `桌宠.app/Contents/MacOS/`）——这样才落到 Apple 那套
   "App" 的适用范围里，「仍要打开」和右键→打开都能用。**代价**：要走 `.app` 就得处理
   bundle 结构 / Info.plist / 图标，且 TCC 授权项会从 "Electron" 变成正式应用名（更干净）。
   目前**没有**做，需要用户拍板（见 §8 待确认项）。

`tools/mac-package.sh` 第 [4] 步仍然清隔离属性 —— 它保证的是**出包这一侧**不带隔离，
传输那一侧加回来的不在它管辖范围内。


---

## 13. 形态三（打字状态）macOS 探针 —— 已完成

### 13.1 关键发现：`addGlobalMonitorForEvents` 在无 nib 的命令行工具里收不到事件

第一版探针用 `NSEvent addGlobalMonitorForEventsMatchingMask:`。**实测：注册成功、返回非 nil、
进程活着、`AXIsProcessTrusted()` 返回 true，但一个事件都收不到**（真人敲 15+ 下，输出 0 字节）。
中途还试过补 `NSApplicationLoad()`（`NSApp` 在 `sharedApplication` 之前是 nil，那句激活策略
其实是对 nil 发消息）——仍然 0 节拍。

改用 **`CGEventTapCreate(kCGHIDEventTap, ..., kCGEventTapOptionListenOnly, ...)` + 把
MachPort 显式挂进当前 runloop**，不经 AppKit 事件派发，**立刻通了：真人敲一轮，捕获 152 个节拍**。

红线反而更硬：`kCGEventTapOptionListenOnly` **按定义只能旁听、不能拦截或改写**，
所以"绝不错过、绝不吞键"是结构保证，比 Windows 靠写对 `CallNextHookEx` 更可靠。

### 13.2 隐私协议

探针 stdout 只允许三个单字符协议位：`k`（有一个文本键被按下）、`t`/`n`（自检的 TCC 信任状态）。
`test/unit/typing.test.js` 里有一条穷举式不变式守着：**每条写语句的字符字面量必须全在
{k,t,n,'\n'} 内且至少有一个** —— 任何把键码/字符内容往 stdout 发的写法（包括发变量）都会立刻红。

白名单仍由 `src/shared/typing.js` 生成、经 argv 注入，**唯一事实来源没有分裂**。
mac 侧改判"字符"而非"VK 码"（macOS 键码随布局变），用 `CGEventKeyboardGetUnicodeString`
取当前修饰状态下的字符并转小写，语义与 Windows 的 VK 表对齐（Shift+A→a、Shift+/→/）。

### 13.3 权限与置灰（三态，不静默）

`available()` 只看"helper 在不在"是**不够的**——未授权时事件不来且系统不报错。
所以菜单标签三态：`（缺 csc.exe）` / `（探针文件缺失）` / `（本平台不支持）` / `（需授权辅助功能）` / 正常。
原因文案由 `TypingMonitor.unavailableReason()` 单一给出（菜单置灰用 `available()`，
两者由单测锁死为同一判断），不再把"包没打全"和"平台不支持"混成一句。
探针在但缺权限时**保持可点**，点它是去弹系统授权框引导，而不是静默切过去。

### 13.4 复验方式

`sh tools/typing-live-test.sh`（默认 15 秒窗口）——**必须真人按键**：
VM 里 `osascript ... keystroke` 在 SSH 会话下会整段挂死（System Events 起不来、
自动化授权框弹不出来），那是驱动方式的限制，不是探针问题；真机上探针由 GUI 会话里的
主进程拉起，不存在这个限制。所以 `verify-vm.sh` 第 8 段默认只做静态检查 + 信任状态如实回报，
真人节拍验证要显式 `LIVE_TYPING=1`。

2026-09-29 补：换 `CGEventPost(kCGHIDEventTap, …)` 直投 HID 层**也不行** —— 不报错、
`POSTED=20` 全成功，但探针收到 0 个节拍。原因同上：SSH 进程不在窗口服务器会话里。
所以"SSH 下敲不到键"永远是环境结论，不能拿来判探针好坏。

### 13.5 修饰键口径（已定案，不再是待拍板项）

用户 2026-09-28 选 ①：Windows 探针加 `GetAsyncKeyState` 查 Ctrl/Alt/Win（用异步态，
因为低级钩子回调里本线程按键状态**尚未更新**），与 mac 侧的 `kCGEventFlagMask*` 判定对齐。
Shift 仍算打字（Shift+A 就是在打 A）。两平台一致性由 `test/unit/typing.test.js` 的
"两边都排除 Ctrl/Alt/Cmd"穷举断言守着。

## 14. 事故记录：形态三"打字没反应"= 用户跑的是旧包（2026-09-29）

**现象**：VM 里选/试「打字状态」，两张打字帧始终不出现。

**取证**（不猜，先看进程和文件）：
- `ps -o pid,lstart,command` → 在跑的是 `~/deskpet/dist/桌宠-mac-x86_64`，**21:33 启动**；
- 该目录 21:27 装配，而形态三 mac 探针是 23:36 的 `c36a67b` 才落地；
- 包里 `src/main/mac/` **整个目录不存在**，`src/main/typing.js` 还是
  `unsupported-platform(darwin)` 的版本 → `available()` 恒 false → 菜单项置灰。
即：**代码没问题，是启动错了文件夹**（`~/deskpet` 是早期同步的旧树，`~/macfinal` 才是当前树）。

**顺带查清的两件事**：
1. 当前包的探针链路实测是通的：用生产模块 `src/main/typing.js` 起一次性 Electron 宿主，
   `AX_MAIN=true / available=true / start=true / probeTrusted=true` —— helper 由 Electron
   拉起时同样拿到「辅助功能」信任（与 Terminal 单独跑探针是两条不同的 TCC 归属，必须分开验）。
2. 差点被带偏：`verify-vm.sh` 在 `/tmp/axcheck.js` 留了个残留脚本，Electron 解析命令行
   参数时"先文件后目录"，于是 `Electron /tmp/axcheck`（我的测试目录）跑的是那个残留脚本，
   打出一行莫名的 `trusted`。已改成 `mktemp -d` + 用完即删。

**修掉的三个真实缺陷**（都不是"探针收不到键"，但都是这次查不下去的原因）：
- `启动桌宠.command` 把 stdout/stderr 丢进 `/dev/null` → 现在落 `./data/launch.log`；
  探针起不来、语音起不来这类"不弹错"的问题只有这里有留痕。
- `unavailableReason()` 区分「探针文件缺失」与「本平台不支持」（见 §13.3）。
- `verify-vm.sh` 的临时脚本残留（见上）。

**给分发流程加的规矩**：出包后**只保留一个** `dist/桌宠-mac-<arch>`，旧的直接删；
否则用户（和我）会误启动旧包，而旧包的表现和新包 bug 的表现一模一样。

