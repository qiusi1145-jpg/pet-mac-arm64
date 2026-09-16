# UI 风格统一指南（写给后续 AI 会话）

> 本文档是 **UI 风格的改版规范**，与 README（功能现状权威）平行，不互相替代。
> 适用前提：**除非用户特地说要某种风格的 UI**，否则一切 UI 改动必须遵守本文。
> 演进：2026-09-17 上午 Fluent 浅色 → 同日按用户指示升级为**苹果极简风**（现行标准）。

## 1. 设计基调：苹果极简（Apple Minimal，现行标准）

用户 2026-09-17 定调：**除「学习」模块外的所有页面 = 苹果极简风**——干净布局、充足留白、
系统默认字体、中性浅色配色、圆角卡片、柔和阴影；只动视觉，不动功能/交互/文案/布局结构。

**两套变量层，变量名同契约，换风格 = 换 `<link>` 的 css**：
- `src/renderer/apple.css` —— **非学习模块工具窗用**（现行标准，唯一调色入口）；
- `src/renderer/tokens.css` —— **「学习」模块用**（番茄钟/计划表），用户要求保持原样，别动。

**主色（accent）不再是写死的**：预设白名单在 `shared/uiTheme.js`（blue/purple/pink/green/
orange/graphite，Apple 系统色系），用户在「通用设置」窗切换，落盘 `settings.json uiPrefs.accent`
（清洗 `normalizeAccentPref`），保存即主进程广播 `ui:accent` → 各工具窗实时换色
（实现：`html[data-accent=…]` 覆盖 apple.css 变量）。

## 2. 窗口接入现状（2026-09-17 晚改版后）

| 窗口 | 文件 | 样式层 |
| --- | --- | --- |
| 聊天 | `chat.html` | apple.css + 变量化（气泡白卡+柔影） |
| 聊天设置 | `chatSettings.html` | 同上（含 LLM 折叠区） |
| 语音设置 | `voiceSettings.html` | 同上 |
| 待办 | `todo.html` | 同上；窗口尺寸在 `config.js todo.*` |
| 通用设置 | `generalSettings.html/.js` | 同上；**目前唯一功能 = 界面主题色** |
| 番茄钟 | `pomodoro.html` | tokens.css + 局部橙绿（**学习模块，保持原样**） |
| 学习计划表 | `planner.html` | tokens.css（**学习模块，保持原样**） |
| 学英语 | `english.css` | 独立浅色主题系统（**学习模块，保持原样**） |
| **宠物主窗** | `index.html` + `app.js` | **不接入、永远浅色化禁地**（见 §3） |

## 3. 主窗 HUD 是禁改区（最重要的一条）

宠物主窗的 HUD（状态胶囊/气泡/语音标识/电平条/进度环）是**深色半透明**，
浮在任意壁纸上，深色半透明是它的正确形态。**任何"统一成浅色"的改动都不要碰它。**
且它与像素穿透机制深度耦合（可点击元素必须进 `app.js updateUiRects()`），
样式与逻辑互相缠绕，改前必须重读 README 红线一节。

## 4. 局部色：允许，但只许"同色相、调明度"

- **番茄钟**（学习模块）：专注=橙、休息=绿（局部变量 `--ring/--ringBreak`），保持原样；
- **学英语**（学习模块）：主题 accent，保持原样；
- 新窗口加局部色的规则：色相跟随身份语义，明度拉高、饱和度压低（pastel 化），
  彩色底上的文字必须保住对比度。

## 5. 学英语的主题系统（学习模块，勿动）

主题 id 永不改名（settings 存 id）：aurora/sunset/mint/sakura/night/graphite。
2026-09-17 起全为浅色 pastel（night/graphite 语义="云雾/浅灰"），磨砂卡与柔和浓度保留。

## 6. 改 UI 的四原则（"协调不突兀"判据）

1. **只动明度/饱和度与留白，不动色相、布局结构、控件形状语义**；
2. **语义色不变量**：成功/警告/错误、专注/休息、我方/宠物气泡的区分度必须保住；
3. **保留各窗身份锚点**：番茄钟进度环、english 磨砂卡、聊天气泡三层结构；
4. **深浅不跨窗混用**：工具窗一律浅色苹果风；主窗 HUD 一律深色半透明。

## 7. 新增窗口的标准接入步骤

① `<link rel="stylesheet" href="./apple.css" />` 放在 `<style>` 之前；
② `<style>` 里颜色/圆角全部引用 `var(--xxx)`；字体用系统栈
   `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`；
③ 标题栏图标：BrowserWindow 加 `icon: this.windowIcon()`（桌宠形象，换图即换图标）；
④ 窗口尺寸登记进 `config.js`（**禁止在 main.js 硬编码**）；
⑤ 若涉及持久化字段：`shared/*.js` 纯函数白名单清洗 + `content.js defaultSettings/normalizeSettings`
   **双份同步** + 单测（参照 `shared/uiTheme.js` 与 `test/unit/uitheme.test.js`）；
⑥ 主题色跟随：渲染层加载 `uiPrefs:load` 并监听 `ui:accent` 广播（参照 `chat.js` 顶部）；
⑦ `node --check` 改过的 JS + `npm test` 全绿（L1 基准 279 例）；人工过一遍窗口（L2/L3 不自动化）。

## 8. 已知边界

- `index.html :root` 里有一份 HUD 深色变量，属于主窗，别合并进任何变量层；
- english.css 的 `--ok/--warn/--bad` 与两套变量层相近但独立定义，不强求合并；
- 主题色广播对象列表在 `main.js broadcastAccent()`——新增可换色窗口后要把它加进去；
- 学习模块三窗刻意走 tokens.css/自有 css，**用户要求冻结**；若未来解冻，同步更新本文；
- 若未来用户点名"要某种风格"，以用户当次要求为准，更新本文档后再动手。
