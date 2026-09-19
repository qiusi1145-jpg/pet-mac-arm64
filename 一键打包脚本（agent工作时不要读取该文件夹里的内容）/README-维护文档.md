# 桌宠一键打包脚本 · 维护文档

> **给未来维护本文件夹的 agent（以及人）：**
> 平时开发应用时**不要读取本文件夹**（文件夹名即约定）。只有当应用功能更新导致打包内容变化时，才进入本文件夹按本文档维护。改动本文件夹后，**必须更新本文档的「版本记录」和对应章节**。
>
> 本文档力求自包含：不读应用源码也能完成打包维护；涉及应用侧的契约都会注明出处（文件:行号可能会漂移，按文件名找）。

---

## 1. 一句话总览

双击 `一键打包.bat`（或在项目根执行 `node "一键打包脚本（agent工作时不要读取该文件夹里的内容）/build.js"`），产出 **Windows 绿色免安装版**：

| 产物 | 位置 | 参考体积 |
| --- | --- | --- |
| 绿色文件夹（双击 `桌宠.exe` 即用，整个文件夹可拷走分发） | `<项目根>/out/桌宠-win32-x64/` | ~275 MB |
| 分发用 zip | `<项目根>/out/桌宠-win32-x64.zip` | ~189 MB |

**零新增依赖、零联网**：只使用 Node 内置模块 + Windows 自带组件（PowerShell 5.1、System.Drawing、kernel32 资源 API、System32\bsdtar）。Node 与 Electron 必须已通过项目根 `npm install` 装好。

`out/` 已在项目 .gitignore 内，产物不进仓库。

---

## 2. 文件清单

| 文件 | 作用 |
| --- | --- |
| `build.js` | 主脚本，6 步流水线（见 §3），**白名单复制清单在这里维护（§4）** |
| `make-ico.ps1` | 把 `src/assets/pet.png` 渲染成多尺寸 .ico（16~256px，规范 32bpp BMP 条目）。纯 ASCII，PowerShell 5.1 下无 BOM 也不乱码 |
| `set-exe-icon.ps1` | 把 .ico 写进 exe 的图标资源（kernel32 `UpdateResource`，内嵌 C#）。**含两个血泪坑的注释，改前先读 §6** |
| `一键打包.bat` | 双击入口。纯 ASCII：中文路径全靠 `%~dp0` 运行期解析，**不要往里写中文字面量**（cmd 按 GBK 解析 bat） |
| `README-维护文档.md` | 本文档 |

无 package.json / node_modules —— 本方案不引入任何 npm 工具（曾考虑 @electron/rcedit，实测此机器 npm 源不可用，且系统 API 方案已足够，见 §6）。

---

## 3. build.js 六步流水线

1. **预检**：Electron 运行时（`node_modules/electron/dist/electron.exe`）、`src/main/main.js`、`动画素材/`、两个 sherpa 包、图标源图是否在；打印应用/Electron/Node 版本。
2. **复制 Electron 运行时** → `out/桌宠-win32-x64/`，并把 `electron.exe` 改名 `桌宠.exe`。每次全量重建（先删旧目录与旧 zip）。
3. **白名单复制**（§4）→ `out/桌宠-win32-x64/resources/app/`。
4. **图标**：`make-ico.ps1` 生成 ico → `set-exe-icon.ps1` 写入 exe（失败仅警告不中断，exe 保留默认图标）。
5. **zip**：优先 `C:\Windows\System32\tar.exe`（bsdtar，`-a` 按扩展名出 zip，文件名 UTF-8 中文不乱码）；**必须用绝对路径**，否则在 Git Bash 环境会命中 Git 的 GNU tar（不认 zip 格式）。失败回退 PowerShell `Compress-Archive`。
6. **结构校验 + 打包信息**：核对 exe/入口/依赖/模型/zip 是否齐全（全绿即可交付）。写 `打包信息.txt`（版本、git commit、时间）进绿色文件夹根。

**注意：脚本不自动启动 exe。** 打包版没有任何自检参数，启动即拉起完整桌宠（曾试过 `--version` 冒烟，结果把完整桌宠拉起来 30 秒还污染了包内 `data/`，已移除——**不要再往回加**）。运行验收靠人工，清单见 §8。

---

## 4. 白名单复制清单（最常维护的地方）

去向统一是 `resources/app/`（= 打包版的应用根，等价于开发时的项目根）：

| 来源（项目根） | 去向（resources/app/ 下） | 原因 |
| --- | --- | --- |
| `node_modules/electron/dist/*` | `/`（exe 同级） | Electron 运行时本体 |
| `package.json` | `package.json` | Electron 找 `main` 入口、读版本 |
| `src/`（整个） | `src/` | 主进程 + 渲染层 + shared，运行时直读文件无打包器 |
| `动画素材/`（整个） | `动画素材/` | 随机特效帧（`src/shared/config.js` 以 `../../动画素材/…` 相对路径引用） |
| `tools/fetch-voice-model.js` | `tools/` | 打包版补/换语音模型用（纯 Node 无依赖；目标机需装 Node） |
| `node_modules/sherpa-onnx-node` | `node_modules/` | 语音识别 JS 封装（**运行时 dependencies 的唯一 npm 包**） |
| `node_modules/sherpa-onnx-win-x64` | `node_modules/` | 上者的 win-x64 原生二进制（`sherpa-onnx-c-api.dll`、`sherpa-onnx.node` 等） |
| `data/voice/models/*`（**排除 `_download`**） | `data/voice/models/` | 语音模型随包分发（用户拍板：换电脑开箱即用，约 +62MB） |
| ——（空目录） | `data/` | 便携数据目录占位，运行时自动填充 |

**明确不打包**：`data/` 其余内容（Chromium 缓存、日志、用户上传素材、settings.json 等用户数据）、`test/`、`tools/` 其余、`node_modules` 其余（全是 electron 自身的 dev 工具链）、`.git`、`out/`、各类 md/txt/bat。文件名含 `_download` 的目录是模型下载临时缓存，永不打包。

**应用为什么不打 asar / 不用 electron-builder**：应用是便携式设计——`src/main/main.js` 里 `APP_ROOT = app.getAppPath()`、`DATA_DIR = <APP_ROOT>/data`、`userData` 固定为 `data/`（"整个文件夹发到别的电脑双击即用"）。asar 只读，压进去后设置/统计/聊天记录全会写失败。所以代码必须保持散文件躺在 `resources/app/`，打包版的用户数据实际位于 `桌宠.exe/resources/app/data/`（与开发态的 `<项目>/data/` 是两套，互不影响）。

---

## 5. 功能更新 → 打包脚本改动对照表

| 应用侧变化 | 要改什么 |
| --- | --- |
| **新增顶层资源目录**（新素材文件夹等，运行时要读） | `build.js` 的 `copyApp()` 加一行 `copyDir(...)`，并同步 §4 表格 |
| **新增 npm 运行时 dependencies** | `build.js` 顶部 `PROD_MODULES` 数组加包名；原生/带平台二进制的包要把它实际加载的二进制子包也加上（参考 sherpa 两个包的关系），改完跑一次打包看结构校验 |
| **移除依赖** | 从 `PROD_MODULES` 删（devDependencies 不用管，本来就只复制白名单） |
| **Electron 升级** | 项目根 `npm install` 后直接重跑，脚本自动跟随 `node_modules/electron` |
| **应用改名**（package.json 的 `productName`） | 自动生效（`APP_NAME` 动态读取），exe 名、文件夹名、zip 名都跟随 |
| **桌宠主图路径调整** | `build.js` 顶部 `ICON_PNG`（用户要求：exe 图标永远用实际显示的那张 pet 主图，打包版统一叫「桌宠」） |
| **语音模型档位增删** | 无需改脚本（整个 `models/` 目录按目录名复制；缺模型只警告，语音功能在应用里优雅隐藏） |
| **想省体积** | `build.js` 顶部 `SHIP_VOICE_MODELS = false`（省 ~62MB，代价：目标机无语音，除非手动补模型） |
| **新增渲染页面/新增 shared 模块** | 通常无需改（整个 `src/` 都会打包） |

维护完跑一遍打包 + §8 验收，再按需提交（本文件夹内容应进 git）。

---

## 6. 图标写入的两个坑（踩过并修复，别再踩）

exe 图标 = `src/assets/pet.png`（桌宠主图）→ 多尺寸 ico → 写进 exe。这条链上炸过三个坑：

1. **组资源数据的 type 字段必须是 `1`，不是 `14`。** `RT_GROUP_ICON=14` 只是 Win32 调用（UpdateResource / FindResourceEx）里的**资源类型参数**；而组**数据内部**的 ICONDIR type 字段要写 `1`（图标）。写 14 的症状极具迷惑性：user32 的直读链（LookupIconIdFromDirectoryEx 等）照常工作，但 Explorer 用的 shell32 `SHDefExtractIcon` 对整个文件返回 `ERROR_INVALID_FUNCTION(1)` —— 图标"写了但显示不出来"。
2. **Shell 按"组资源的语言"解析每个图标 ID。** electron.exe 的图标组在 language 1033；RT_ICON 条目若只写了 language 0（比如新增的 64/128/256px），Shell 按 1033 找不到就整体报错。所以 `set-exe-icon.ps1` 先枚举组的语言，把**所有图标条目写到组的语言上**。
3. **不要用 `[System.Drawing.Icon]::Save()` / `GetHicon()` 生成 ico**：它产出调色板化的条目，加载器可能解析失败并静默回退默认图标。`make-ico.ps1` 用 `LockBits` 手写规范 32bpp BGRA BMP 条目（BITMAPINFOHEADER 的 `biHeight=2×h`、行序自底向上、空 AND 掩码），全尺寸都稳。

**图标验证的正确姿势**：用 `SHDefExtractIcon`（Shell 权威路径），不要用 `ExtractAssociatedIcon` / PrivateExtractIcons 下结论——前者有缓存与回退行为会骗人，后者对某些合法文件也返回 0。构建脚本之外的单测可参考本仓库历史（`out/` 里的 bisect 实验脚本已删，方法论在 git 历史里）。

**未签名提示**：exe 无数字签名，首次运行会有 SmartScreen / 杀软提醒，属正常（文档尾部有给用户的说明）。代码签名需要证书，脚本未集成；如需签名，在第 4 步之后对 `桌宠.exe` 调 signtool 即可。

---

## 7. 常见问题

- **换机器语音功能没了**：确认包里 `resources/app/data/voice/models/` 有模型目录；没有的话用目标机的 Node 跑 `node resources/app/tools/fetch-voice-model.js`（会下到该目录），或从开发机 `data/voice/models/` 拷贝（不要拷 `_download`）。
- **用户数据在哪 / 如何"重置"**：`桌宠.exe/resources/app/data/`。删掉整个 `data/` = 恢复出厂（模型也会没，记得备份 `data/voice/models`）。
- **资源管理器图标显示旧的**：Windows 图标缓存，重开资源管理器窗口/换机器即新。exe 本身的图标以 `SHDefExtractIcon` 验证为准。
- **打包报"缺少 node_modules/electron/dist/electron.exe"**：项目根先 `npm install`。
- **想出安装包（NSIS）**：本方案刻意不做（会破坏便携数据设计 + 要联网装 electron-builder）。真要做是重写，不是改这里。
- **only-x64**：Electron 运行时与 sherpa 二进制都是 win-x64，产物仅支持 64 位 Windows 10+。

---

## 8. 打包后人工验收清单（脚本不自动启动 exe，必须人工过）

- [ ] 双击 `桌宠.exe`：宠物出现，拖拽 / 拍拍 / 喂食正常
- [ ] 托盘菜单能弹出各窗口；标题栏/任务栏图标是桌宠主图（狼）
- [ ] 番茄钟：开始 → 专注 → 完成，记录/成就正常
- [ ] 学习计划表三视图、todo、学英语（词书加载）
- [ ] 聊天窗口 + 设置窗口（主题色切换）
- [ ] 语音：设置页有模型档位，识别可用（包内置了模型）
- [ ] 把整个文件夹复制到另一台电脑（或换个盘符路径）再跑一遍 —— 便携性是本打包的核心卖点

---

## 9. 版本记录

| 日期 | 变更 | 环境 |
| --- | --- | --- |
| 2026-09-19 | 初版。build.js 六步流水线 + make-ico.ps1 + set-exe-icon.ps1 + 一键打包.bat。图标链路修复三坑（组 type 字段=1、图标写组语言、弃用 Icon.Save）。验证：SHDefExtractIcon 全尺寸通过、结构校验 8/8 绿 | Electron 37.10.3 / Node v24.20.0 / Windows 10.0.26200 x64 / win-x64 产物 |
