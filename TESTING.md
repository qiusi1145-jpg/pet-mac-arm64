# 测试说明（分层）

自动化分三层，全部在当前仓库一键可跑。**红色约束（见 README / 正在运行的功能说明.md）尽量下沉到 `src/shared` 纯函数层**，
用单测直接锁死；渲染层交互用「真实启动 Electron + 注入驱动」验证端到端行为。

```bash
npm test            # L1 纯函数单测（88 个 / 14 个文件）
npm run test:smoke  # L2 真实启动冒烟
npm run test:ui     # L3 渲染层场景（19 个）
PET_UI_ONLY='bg,audio' npm run test:ui  # 调试：只跑指定场景
```

> 注：本项目 UI 层没有引入 Playwright（早期规格允许 UI 自动化降级），而是用
> Electron 自身能力（`webContents.executeJavaScript` + 测试模式下暴露的 `window.__petState`/`__petTest`
> + `PET_SCENARIO` 场景名），效果等价但零额外依赖。

## L1 纯函数单测（node --test，零 Electron）

| 文件 | 覆盖点 | 锁定的红线 |
| --- | --- | --- |
| `test/unit/pixel.test.js` | 位图分析/锚点=实体像素中心/命中 | 判定只用原始像素 |
| `test/unit/gesture.test.js` | 短点=摸头、左 3s 长按=锁、右 1.5s 长按=菜单（与锁定拆开）、拖动=跟手、甩动=带速度 release | 手势阈值集中、可注入时钟 |
| `test/unit/spring.test.js` | 呼吸波幅值(默认 ±1.5%)/周期/收敛、Q 弹过冲受控 | 动画只动表现层 |
| `test/unit/physics.test.js` | 重力/阻力/反弹/静止判定/区域夹取（含 w/h 透传回归） | 物理只在抛掷/失支撑时接管；永不越出活动区域 |
| `test/unit/snap.test.js` | 锚点靠近顶沿→吸附、底边贴顶、移动/最小化/关闭→脱落坠落 | 吸附几何 = 实体中心锚点 |
| `test/unit/status.test.js` | 默认值/喂食/互动/疲劳窗口/**短时高频扣体力 rapidInteract**/情绪滞后衰减/好感度 2%+1/里程碑/离线一次性结算/归零半透明 | 状态速率与离线结算正确；狂点有轻微代价 |
| `test/unit/region.test.js` | 工作区减任务栏、可缩放、底对齐+水平居中、夹取最小 | 活动区域语义 |
| `test/unit/settings.test.js` | 默认值/规范化（含 snapEnabled / physicsEnabled 默认开、可显式关） | 持久化字段收敛 |
| `test/unit/store.test.js` | JSON 读写、updateDeep、防抖、损坏回退 | 持久化安全 |
| `test/unit/blink.test.js` | 眨眼计划落在配置区间、rng 可复现；**多帧动画清洗**（非法帧丢弃/时长夹取/缺省回退）与**触发概率**（0 永不/1 必播/中间掷骰） | 眨眼参数集中可调 |
| `test/unit/stateVisual.test.js` | 状态图显隐取反 | 切换状态只改视觉 |
| `test/unit/overrides.test.js` | 覆盖表默认空/点分路径命中（false/null/空串也算命中）/清空；config 新增可定制字段默认值 | 无覆盖时 = 纯默认行为 |
| `test/unit/todo.test.js` | 待办清洗/到期判断（未完成+到期、按序）/催促目标加权选择（≤10min ×10、≤1h ×2、无 ♥ 返回 null）/模板替换/催促间隔区间/normalizeSettings 清洗 todos | 待办与催促选择规则 |
| `test/unit/chat.test.js` | 规则清洗/忽略大小写包含匹配/多命中取最长/无命中 null/normalizeSettings 清洗 chatRules | 聊天匹配规则 |

## L2 启动冒烟（真实 Electron）

`test/smoke/smoke.js`：干净临时 userData → 加载宠物 fixture → 断言窗口创建、渲染层 ready、
宠物解码成功、**控制台零报错**、进程正常退出。任一渲染期未捕获异常都会在 console-message 被记下导致失败。

## L3 渲染层场景（真实 Electron + 注入驱动）

`test/ui/ui.test.js` 顺序跑 **19 个场景**（每个独立进程 / 独立临时 userData；调试时用 `PET_UI_ONLY='bg,audio'` 只跑指定场景）：

- **greeting**：启动后问候气泡自动出现，文本 ∈ `config.greeting.greetings`。
- **blink**：`forceBlink` 驱动闭眼图显隐；显隐前后宠物实体像素命中不变（判定不被视觉层影响）。
- **blinkAnim**（多帧眨眼动画）：注入两帧（页面现画 canvas dataUrl，各 120ms）→ 强制播放 →
  第一帧显示、帧间 src 切换、播完恢复常态。
- **stateVisual**：toggle 换身体（主形象 ↔ 状态形象）：`bodyKind` 随切换翻转、底边中点位置连续（原地换装）、
  两种形态各自在锚点附近可命中（判定随当前身体走）、状态形态眨眼被抑制、状态数值全程不变。
- **lock**（锁定并保持始终置于顶层）：初始 floating → 长按切换路径锁屏后主进程 `lockLevel='screen-saver'`、
  托盘出现「解锁（保底入口）」、实体像素上也整窗穿透 → 解锁恢复 floating、托盘显示
  「锁定并保持始终置于顶层」、实体像素恢复可交互。
- **todo**：真实打开待办窗口 → DOM 添加“未来截止 + ♥”待办 → 渲染断言 → `mainState().todos` 持久化断言 →
  添加“已到期”待办 → 主进程 `checkDueTodos()` → 宠物窗气泡含任务名 → 点击气泡关闭 → 完成划线 → 删除。
- **reminder**：真实添加 ♥ 临期（5min）待办 → `triggerReminderNow()` → 气泡含“做完了吗”模板 →
  锁定态下触发不生效 → 解锁还原。权重选择细节由 L1 `todo.test.js` 锁定。
- **chat**：真实打开聊天 + 设置双窗口 → 添加规则（持久化断言）→ 发送命中消息 → 回复渲染在聊天窗 +
  主窗气泡 → 发送未命中消息 → 无回复气泡且主窗情绪 +2（Q 弹路径）→ 再添加更长关键词验证最长优先 →
  删除规则 → 关闭双窗口。
- **anim**：基线静止缩放≈1 → 摸头出现明显压缩 → Q 弹收敛回 1 → 待机呼吸有细微波动 → 状态胶囊折叠/展开。
- **dragPhysics**：注入抛出速度 → 物理激活且位置变化 → 落回地面回待机、`y == 活动区高 − 宠物高`。
- **snap**：注入假窗口列表、低速释放靠近其顶沿 → 吸附成功且记录句柄、宠物底边贴窗口顶；窗口移动/关闭 →
  保持吸附 / 失支撑坠落；最后清场回待机。
- **status**：强制好感度随机为“不中” → 喂食饱食 30→50/体力+5 → 摸头情绪 +2 → 状态胶囊刷新为图标+数值 →
  三值归零宠物透明度 0.45 → 任一恢复透明度回 1 → 区域面板打开后其矩形参与命中判定（指针在面板内不穿透）。
- **passthrough**（红线1/5 不反转回归）：注入“内容坐标”光标，在同一段同步 JS 里 set+read——
  光标落在宠物实体像素 → 窗口不穿透（`ignore=false`）；落在空白（无宠无 UI）→ 点击穿透（`ignore=true`）。
- **picker**（应用内选择器，背景模式——换宠已移除、宠物素材走素材根目录）：选择器打开 →
  列到 fixture 图片 → 面板参与命中判定 → 选中 `bg-160x64.png` → "把这张设为背景" →
  走真实导入/设置路径 → 面板自动关闭、背景生效。
- **bg**（bug1/bug2 背景）：设背景后高=人物高×4/3、宽按原图等比、底边贴地面、中心对人物脚底中点 →
  人物贴地横移背景跟随 → 人物悬空时背景垂直/水平都冻结 → 落地重新对齐 → 清除背景立即消失 → 再开又能显示并对齐。
- **menuClean**（bug5 右键菜单不吸人）：制造“长按右键按住残留态” → 执行弹菜单/关菜单时的清理逻辑 →
  断言手势复位（idle/无按键/无拖动/无抓取）→ 再模拟残留的鼠标移动，人物**不被吸到光标**、不残留拖动态。
- **audio**（bug3 添加音乐）：runner 现写一段静音 WAV → 打开应用内音乐选择器列到该文件 → 选中并
  “把这首加入播放列表” → 走真实拷贝进 assets → `playlist+1` → 回推列表后自动进入播放态
  （Audio 元素已建、带源、未暂停）→ 面板保持打开可连续加 → Esc 关闭。
- **physOff**（物理开关）：关掉物理后 —— 低速空中释放不坠落、甩动也不抛掷（人物停在原地）；
  但靠近假窗口顶沿低速释放仍**吸附成功**且不坠落；该窗口消失 → 解除吸附但仍不坠落。
- **rest**（「休息」菜单）：体力预置低位 → 短休息（显式 3000ms/220ms/25%↔75%）→ 开始即 active、
  透明度从下限附近起，采样跨过整周期出现明显往返（正弦到 25 与 75 两端）；休息中互动（喂食）
  不打断闪烁；结束后 `active=false`、**体力回满 100、透明度恢复 '1'**。

场景通过条件 = 全部断言成立 **且渲染层零 console.error**。

> 独立窗口（待办/聊天/聊天设置）的驱动：`runScenario` 的 ctx 提供 `waitForWin/execIn/mainState` 与
> `openTodo/openChat/openChatSettings/checkDueTodos/triggerReminderNow`，场景结束用 `window.close()` 收尾。

## 各红线分别由哪层保证

| 红线 | 自动化层 |
| --- | --- |
| 点击判定恒用当前身体（主/状态形象各自的）原始像素；动画不改判定 | L1 pixel/spring + L3 anim（drawnSy 采样）+ L3 stateVisual（换身体后仍可命中） |
| 锁定=最高置顶级+整窗穿透、托盘是保底解锁 | L1 gesture（长按产出锁动作）+ L3 lock（screen-saver 级别/托盘文本/穿透语义） |
| 物理只属于抛掷/失支撑；普通拖动 1:1 | L1 gesture(拖动) + L1 physics + L3 dragPhysics |
| 吸附锚=实体中心；弹跳不越界 | L1 snap/pixel/physics + L3 snap |
| 状态/好感度/离线结算精确 | L1 status 12 例 + L3 status 场景 |
| 背景贴地跟随/可清除 | L3 bg 场景 |
| 右键菜单弹出后不残留拖动态 | L3 menuClean 场景 |
| 应用内添加音乐并自动开播 | L3 audio 场景 |
| 右键菜单 1.5s 呼出（左键锁定仍 3s） | L1 gesture（右 1.6s→menu / <1.5s 无 / 同长左键不锁） |
| 物理开关：关掉=不抛不落、但吸附仍工作 | L1 physics（默认开语义不变）+ L3 physOff 场景 |
| 「休息」25%↔75% 正弦闪烁→结束体力回满 | L3 rest 场景 |
| 启动问候随机弹出、可点击关闭 | L3 greeting 场景 |
| 待办增删改查/持久化/到期气泡/可点击关闭 | L1 todo（清洗/到期/模板）+ L3 todo 场景 |
| 随机催促：紧迫度加权选择、锁定不生效 | L1 todo（pickReminderTodo/间隔区间）+ L3 reminder 场景 |
| 聊天：忽略大小写包含匹配、最长优先、未命中 Q 弹 | L1 chat（matchChatRule）+ L3 chat 场景（真实双窗口） |
| 多帧眨眼动画按序播放、播完恢复常态 | L1 blink（帧清洗/概率）+ L3 blinkAnim 场景 |
| 无覆盖时 = 纯默认行为（覆盖表恒为空） | L1 overrides |
| 隐藏暂停 & 离线结算 | 代码路径（onVisibility）由冒烟+L1 状态结算覆盖，端到端列 MANUAL |

## 覆盖缺口（诚实的已知边界）

- **原生主菜单 / 托盘菜单的弹出手感、真实鼠标下的穿透"顺滑切换"**无法在无头自动化里断言 → MANUAL_CHECKLIST 中列为高优先手动项。
  `menuClean` 场景只验证了“菜单弹出/关闭后的手势清理逻辑”，并未真的弹一次原生菜单（自动化弹会卡住等用户选）。
  托盘/主菜单的**文本与结构**由 L3 lock（`_trayMenuItems` 断言）与 L3 todo/reminder/chat（走真实菜单动作路径）间接覆盖。
- **音频“真实出声”与自动下一首**：`audio` 场景用一段静音 WAV 验证了“能解码并进入播放态”，但扬声器真出声、
  放完自动切歌要靠真实音频设备 → 仍列 MANUAL。
- **背景/吸附在真实鼠标拖抛下的手感**：`bg` 场景用注入的位置驱动，真实“拖起悬空→背景冻结→落地重对齐”的视觉手感应人工过一遍。
- **区域编辑面板的加减宽高**会真实改窗口尺寸，只做了“面板参与命中判定”的自动化，按钮行为列 MANUAL。
- **催促的真实 25~30 分钟节奏**：自动化用 `triggerReminderNow()` 直接触发，随机间隔本身由 L1 区间断言锁定，
  “真实等 25 分钟弹一次”只能人工观察（或临时把 `reminder.minIntervalMs/maxIntervalMs` 改小验证）。
