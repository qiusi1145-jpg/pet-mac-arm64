# UI 风格统一指南（写给后续 AI 会话）

> 本文档是 **UI 风格的改版规范**，与 README（功能现状权威）平行，不互相替代。
> 适用前提：**除非用户特地说要某种风格的 UI**，否则一切 UI 改动必须遵守本文。
> 首次落地：2026-09-17「Fluent 浅色统一改版」（git 提交见版本日志）。

## 1. 设计基调：明亮浅色（Fluent 风）

用户 2026-09-17 定调：**全项目工具窗统一为明亮浅色**，颜色宁浅勿浓。
参考体系 = Windows 11 Fluent 浅色（与项目原有的 Windows 原生右键菜单/托盘气质一致）。

**唯一的调色入口是 `src/renderer/tokens.css`**（:root CSS 变量层）。各窗口 `<style>`
只允许引用 `var(--xxx)`，**禁止再写死色值**。改配色 = 只改 tokens.css 一处。

当前 token 速查（改版后以此为准，改动请同步更新本表）：

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#f6f8fa` | 窗口底色 |
| `--card` / `--card-border` | `#ffffff` / `#e6e9ee` | 卡片底/描边 |
| `--hairline` | `#eef1f4` | 更浅的分隔线 |
| `--text` / `--text-2` / `--text-3` | `#2b3137` / `#6b7480` / `#98a1ab` | 主/次/提示文字 |
| `--accent` / `--accent-strong` / `--accent-weak` | `#4a90d9` / `#3a7cc4` / `#e9f2fb` | 主色（旧 #2f9bff 的降饱和版）/ hover / 淡底 |
| `--btn-bg` / `--btn-border` / `--input-border` | `#f1f3f5` / `#d7dce2` / `#d3d9df` | 控件 |
| `--ok / --warn / --bad`（各配 `*-bg`） | `#3fa06c` / `#b97a1c` / `#cc4b44` | 语义色 |
| `--r-sm / --r-md / --r-lg / --r-pill` | `6 / 8 / 12 / 999px` | 圆角两档+胶囊 |

## 2. 窗口接入现状（2026-09-17 改版后）

| 窗口 | 文件 | 接入方式 |
| --- | --- | --- |
| 聊天 | `chat.html` | tokens.css + 变量化 |
| 聊天设置 | `chatSettings.html` | 同上（含 LLM 折叠区） |
| 语音设置 | `voiceSettings.html` | 同上 |
| 待办 | `todo.html` | 同上；窗口尺寸在 `config.js todo.windowWidth/Height` |
| 番茄钟 | `pomodoro.html` | tokens.css + **局部色**（见 §4）；底色奶油白 `#fff8f4` |
| 学习计划表 | `planner.html` | tokens.css + 变量化 |
| 学英语 | `english.css` | 独立主题系统（见 §5），语义色与 tokens 同基调 |
| **宠物主窗** | `index.html` + `app.js` | **不接入、永远浅色化禁地**（见 §3） |

## 3. 主窗 HUD 是禁改区（最重要的一条）

宠物主窗的 HUD（状态胶囊/气泡/语音标识/电平条/进度环）是**深色半透明**，
浮在任意壁纸上，深色半透明是它的正确形态。**任何"统一成浅色"的改动都不要碰它。**
且它与像素穿透机制深度耦合（可点击元素必须进 `app.js updateUiRects()`），
样式与逻辑互相缠绕，改前必须重读 README 红线一节。

## 4. 局部色：允许，但只许"同色相、调明度"

个别窗口保留自己的身份色（这是特性不是 bug）：
- **番茄钟**：专注=橙、休息=绿（`--ring/--ringBreak/--pom` 等局部变量，浅色化后约
  `#f2a37c / #8fd0ba`，底色奶油白）；
- **学英语**：主题 accent（见 §5）。

给新窗口加局部色的规则：**色相跟随身份语义，明度拉高、饱和度压低**（pastel 化），
按钮上的文字若在彩色底上必须保住对比度（白字配中低饱和 accent，或改用深字）。

## 5. 学英语的主题系统

- 机制：CSS 变量 + `body[data-theme]` 切换（`english.css` 顶部）+ `english.js` 顶部
  `THEMES` 预设（色板预览用）。两处必须同步改。
- **主题 id 永不改名**（aurora/sunset/mint/sakura/night/graphite）：settings 里存的是 id，
  改名 = 用户偏好丢失。要换风格只换 id 下的色值。
- 2026-09-17 起 6 套全部是浅色 pastel（night/graphite 语义已变为"云雾/浅灰"浅色变体，
  显示名在 english.js THEMES 的 `name` 字段）。
- 「柔和/标准」浓度 = `--softVeil`（白纱叠加），机制保留。

## 6. 改 UI 的四原则（"协调不突兀"判据）

1. **只动明度/饱和度，不动色相与布局**——布局、控件形状、信息结构不变；
2. **语义色不变量**：成功/警告/错误、专注/休息、我方/宠物气泡的区分度必须保住；
3. **保留各窗身份锚点**：番茄钟进度环、english 磨砂卡、聊天气泡三层结构；
4. **深浅不跨窗混用**：工具窗一律浅色；主窗 HUD 一律深色半透明。

## 7. 新增窗口的标准接入步骤

① `<link rel="stylesheet" href="./tokens.css" />` 放在 `<style>` 之前；
② `<style>` 里颜色全部换成 `var(--xxx)`，圆角用 `--r-sm/--r-md`；
③ 窗口尺寸登记进 `config.js` 对应节点（**禁止在 main.js 硬编码**）；
④ `node --check` 改过的 JS + `npm test` 全绿（L1 276 例基准）；
⑤ 人工过一遍窗口（L2/L3 不在本机自动化跑，会弹置顶窗抢鼠标）。

## 8. 已知边界

- `index.html :root` 里有一份 HUD 深色变量，属于主窗，别合并进 tokens.css；
- english.css 的 `--ok/--warn/--bad` 与 tokens.css 数值相近但独立定义
  （english 需在磨砂卡上工作），不强求合并；
- 若未来用户点名"要某种风格"（如暗色、具体品牌风），以用户当次要求为准，
  更新本文档后再动手。
