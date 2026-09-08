# 调参指南（TUNING.md）

所有可调参数都集中在 **`src/shared/config.js`**（模块加载时深冻结，运行期不可改；想调就改文件后重启）。
下表是每个参数的作用与改法建议。改完请跑 `npm test`，若涉及物理/吸附/动画再跑 `npm run test:ui`。

## `image` —— 图片 / 交互几何

| 参数 | 默认 | 作用 | 手感 |
| --- | --- | --- | --- |
| `petMaxDim` | 220 | 上传宠物等比缩放到的最大边长（CSS px） | 调大 → 宠物更大，同时活动区域最小值随之变大（region 会夹取） |
| `bgMaxDim` | 4096 | 背景图缩放上限，防超大图内存爆炸 | 不必常调 |
| `alphaThreshold` | 20 | 判定“不透明实体像素”的 alpha 阈值（0-255） | 调低 → 更淡的像素也算可点；建议别低于 10 |
| `tapMaxMs` | 450 | 短点算“摸头”的最长按住时长 | 调大 → 手慢点也触发摸头；过大会和长按打架 |
| `dragTolerance` | 5 | 位移超过该值才算拖动（否则保持点按） | 调大 → 手抖更不易误拖 |
| `ringDelayMs` | 500 | 左键按住多久后出现进度环 | 进度环的“预备反馈”时机 |
| `longPressMs` | 3000 | **左键**长按多久触发锁定切换 | 只影响锁定；右键菜单时长见 `menuPressMs` |
| `menuPressMs` | 1500 | **右键**长按多久弹出主菜单（规格 1.5s） | 与左键锁定分开，改它不影响锁定 |

## `region` —— 活动区域

| 参数 | 默认 | 作用 | 说明 |
| --- | --- | --- | --- |
| `defaultInset` | 0 | 区域相对工作区四边留白 | 0 = 填满工作区 |
| `minWidthRatio` / `minHeightRatio` | 0.2 | 区域可缩到的最小尺寸（占工作区比例） | 防止缩没 |
| `resizeStep` | 40 | 面板加减宽高每次步进 px | |

## `anim` —— 待机 / 反馈动画

| 参数 | 默认 | 作用 | 手感 |
| --- | --- | --- | --- |
| `breatheAmplitude` | 0.015 | 待机呼吸缩放幅度（±1.5%） | 改大 → 呼吸更明显；要 2~4% 即 0.02~0.04 |
| `breathePeriodMs` | 4200 | 呼吸周期 | 改小 → 喘得越快 |
| `squishMin` / `stretchMax` | 0.86 / 1.10 | Q 弹压缩/拉伸的峰值界 | 越接近 1 越“硬”，越偏离 1 越“果冻” |
| `squishFrequency` | 5.0 | Q 弹回弹频率感（Hz） | 越大回弹越快、越抖 |
| `squishDamping` | 0.45 | Q 弹阻尼比 ζ | <1 欠阻尼=有轻微过冲拉伸；越小越晃 |
| `headpatImpulse` | 6.2 | 摸头 Q 弹压缩冲量（越小越软） | 摸头/喂食都用它 |
| `landImpulseMult` | 1.6 | 落地压扁相对摸头的倍率 | |
| `heartFloatMs` | 1400 | 爱心上浮时长 | |
| `animateWhileLocked` | true | 锁定时仍呼吸（只关交互不关动画） | 规格要求锁定也呼吸，勿关 |

## `physics` —— 抛掷 / 坠落（只在这两种情形生效）

| 参数 | 默认 | 作用 | 手感 |
| --- | --- | --- | --- |
| `throwSpeedThreshold` | 800 | 释放速度超过它才进抛掷弹道 | 调大 → 要甩更猛才算“扔” |
| `gravity` | 2600 | 重力加速度 px/s² | 越大下落越狠、抛物线越低平 |
| `drag` | 0.06 | 抛掷水平空气阻力（每帧速率衰减） | 越大横向越早停 |
| `restitution` | 0.62 | 撞到区域边界的弹性（1=完全弹，0=不弹） | 调大 → 弹得更欢 |
| `stopSpeedX` / `stopSpeedY` | 26 / 40 | 贴地后水平/竖直速度低于该值视为“稳定” | 越大停得越快 |
| `settleMs` | 300 | 稳定后缓冲多久才回待机 | |
| `snapProximityY` | 120 | 锚点距窗口顶沿多近才吸附（竖直） | 2026-09-08 按需求较最初的 60 翻倍，更容易吸附 |
| `snapMarginX` | 10 | 锚点水平超出窗口左右允许余量 | |
| `snapMaxSpeed` | 220 | 释放速度低于它才尝试吸附 | 调大 → 稍快也能吸上 |
| `groundDrag` | 1.8 | 贴地滚动额外摩擦 | 越大滚两下就停 |
| `maxBounceGuard` | 200 | 反弹次数保护（防发散） | 勿乱改 |

## `status` —— 状态系统（情绪/体力/饱食/好感）

| 参数 | 默认 | 作用 | 说明 |
| --- | --- | --- | --- |
| `initialMood/Energy/Satiety/Affinity` | 80/100/80/0 | 初始值 | |
| `moodPerInteraction` | 2 | 每次主动互动情绪 +2 | |
| `idleDecayDelayMs` | 30 min | 空闲多久后才开始掉情绪（缓冲期） | |
| `moodDecayStartPerMin` | 0.2 | 情绪开始衰减速率（点/分） | |
| `moodDecayMaxPerMin` | 1.0 | 情绪衰减封顶速率 | |
| `moodDecayRampMin` | 45 | 速率从 start 线性升到 max 所需分钟 | 越长越“慢慢变差” |
| `energyRecoverPerMin` | 0.5 | 非疲劳时体力恢复速率 | |
| `fatigueWindowMs` | 5 min | 疲劳判定滚动窗口 | |
| `fatigueThresholdCount` | 10 | 窗口内互动超过它 → 疲劳（掉体力） | |
| `fatigueDrainPerMin` | 1.5 | 疲劳时体力消耗速率 | |
| `energyPerFeed` | 5 | 喂食额外 +5 体力 | |
| `satietyDecayPerHour` | 2 | 饱食每小时 -2 | 规格要求 |
| `satietyPerFeed` | 20 | 喂食 +20 饱食 | |
| `lowOpacity` | 0.45 | 任一归零时宠物半透明值 | |
| `zeroEpsilon` | 0.001 | “归零”判定阈值 | 别动 |
| `transparentRecoverAt` | 0 | 保留字段（规格：任一 >0 即复原，不叠加） | |
| `affinityChance` | 0.02 | 每次主动互动好感 +1 概率 | 规格 2% |
| `affinityCap` | 100 | 好感上限 | |
| `affinityMilestoneStep` | 20 | 每满 20 触发爱心上浮 | |
| `persistIntervalMs` | 15000 | 状态持久化写盘心跳间隔 | |
| `burstWindowMs` | 2500 | “短时高频”判定的滚动窗口 | 狂点几秒内连点会触发 |
| `burstQuota` | 6 | 窗口内互动超过它开始扣体力 | 越小越容易被“罚” |
| `burstEnergyPerExtra` | 0.12 | 超配额后每多一次互动即时扣的体力 | 想让狂点代价更明显就调大（每次额外扣一点） |

## `rest` —— “休息”（右键菜单 → 透明度正弦闪烁 30s，结束体力回满）

| 参数 | 默认 | 作用 | 说明 |
| --- | --- | --- | --- |
| `durationMs` | 30000 | 一次休息时长 | 结束 → 体力回满、闪烁停止、透明度恢复正常 |
| `blinkPeriodMs` | 3000 | 透明度 25%↔75% 正弦往返一个完整周期 | 越小闪得越快；数值见下方上下限 |
| `opacityMin` / `opacityMax` | 0.25 / 0.75 | 闪烁透明度下限/上限 | 规格：在 25% ↔ 75% 间缓慢正弦渐变 |
| `energyRefill` | 100 | 结束时体力回满到的值 | 夹 0-100 |

## `greeting` —— 启动问候（2026-09-08 新增）

| 参数 | 默认 | 作用 | 说明 |
| --- | --- | --- | --- |
| `greetings` | 8 条中文问候 | 每次启动随机选一条弹出 | 数组，可自由增删改（用户常改项） |
| `delayMs` | 500 | 宠物就位后多久弹问候 | |
| `durationMs` | 5000 | 问候气泡停留时长 | 点击任意位置可提前关 |

## `blink` —— 眨眼（2026-09-08 新增）

| 参数 | 默认 | 作用 | 说明 |
| --- | --- | --- | --- |
| `minIntervalMs` / `maxIntervalMs` | 2800 / 6200 | 两次眨眼间隔的随机区间 | 闭眼图固定 `src/assets/blink.png`，与参数无关 |
| `minDurationMs` / `maxDurationMs` | 90 / 210 | 单次闭眼时长的随机区间 | 太长会像“睡着了” |

## `todo` —— 待办清单（2026-09-08 新增）

| 参数 | 默认 | 作用 | 说明 |
| --- | --- | --- | --- |
| `checkIntervalMs` | 30000 | 后台检查到期待办的间隔 | |
| `remindDurationMs` | 5000 | 到期提醒气泡停留时长 | 点击可提前关 |
| `remindTemplate` | 主人，该做“{task}”了！ | 到期提醒文案模板 | `{task}` 替换为待办内容（用户常改项） |

## `reminder` —— 随机催促（♥ 待办，2026-09-08 新增）

| 参数 | 默认 | 作用 | 说明 |
| --- | --- | --- | --- |
| `minIntervalMs` / `maxIntervalMs` | 25min / 30min | 催促触发间隔的随机区间 | 概率性，非固定间隔 |
| `soonMs` / `soonWeight` | 1h / 2 | 剩余 ≤1h 的 ♥ 待办权重倍数 | 越临近越容易被选中 |
| `urgentMs` / `urgentWeight` | 10min / 10 | 剩余 ≤10min（或已过期）的权重倍数 | “大幅提升”档 |
| `durationMs` | 8000 | 催促气泡停留时长 | |
| `template` | 主人，'{task}' 做完了吗？ | 催促文案模板 | `{task}` 替换（用户常改项） |

## `chat` —— 聊天（2026-09-08 新增）

| 参数 | 默认 | 作用 | 说明 |
| --- | --- | --- | --- |
| `windowWidth` / `windowHeight` | 400 / 540 | 聊天窗口初始尺寸 | 可调整大小 |
| `settingsWidth` / `settingsHeight` | 460 / 500 | 聊天设置窗口初始尺寸 | |
| `bubbleDurationMs` | 5000 | 桌宠回复在主窗气泡的停留时长 | |

## 行为开关（托盘勾选，持久化在 settings.json，不走 CFG）

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 窗口顶沿吸附（`settings.snapEnabled`） | 开 | 见下方 snap 几何参数 |
| **物理模拟（`settings.physicsEnabled`）** | 开 | 关闭后：甩动不抛掷、释放不坠落/不滑落，**人物拖到哪就停在哪**；但“低速贴近窗口顶沿 → 吸附”**仍正常**（吸附独立于物理）。关闭瞬间若正在飞行/坠落 → 原地冻结 |

## `ui` —— 外观

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `pillBg` / `pillText` / `pillFontPx` | 深色半透明/白 | 状态胶囊配色字号 |
| `menuBg/Text/Hover/Border` | Windows 浅色 | 主菜单配色（预留给自绘菜单） |
| `ringColor` / `ringWidthPx` / `ringRadiusPx` | 蓝 4px 30 | 长按进度环 |
| `heartGlyph` / `heartColor` / `heartSizeBase` / `heartSizePerLevel` | ♥ / 粉 / 22 / 3 | 爱心文字与尺寸 |
| `bgDefaultOpacity` | 0.8 | 背景图默认不透明度 |
| `bgOpacityMin/Max` | 0.1 / 1.0 | 背景不透明度范围 |
| `bgPetHScale` | 4/3 | 背景图高度 = 人物显示高 × 该值（宽度按原图等比） |

## `snapPoll` / `audio`

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `snapPoll.followPollMs` | 400 | 吸附后跟随窗口移动的轮询间隔 |
| `snapPoll.enabledByDefault` | true | 吸附默认开（托盘可关） |
| `audio.volumeDefault` | 0.6 | 默认音量 |

## 需要联动改的地方

- `petMaxDim` 改了 → 想让最小区域更小，同步看 `region.minWidthRatio/minHeightRatio`（`computeRegion` 会夹取）。
- `breatheAmplitude` 是叠加在 Q 弹之上的独立波：基线/收敛类检查现在读**弹簧值**（`animScale.sy`），不受呼吸幅度影响，故无论加多大都无需放宽阈值；呼吸本身的 UI 检查采满一整周期，跨幅≈2×幅度，阈值 0.02（按默认 2A=0.03 留余量）——若默认调到 ~1% 以下需同步下调该阈值。
- `status.*` 改动后，`npm test` 中 status 用例若用的是具体数值会暴露——它们是回归保护的“哨兵”，改动合理时可同步更新断言。
- `burstWindowMs/burstQuota/burstEnergyPerExtra`：status 单测有 3 条 `rapidInteract` 用例
  （配额内不扣 / 超配额按比例扣 / 触底夹 0），改默认值或规则时留意是否需要同步断言。
- `bgPetHScale` 或背景对齐规则：UI 场景 `bg` 断言“背景高=人物高×4/3、宽高比≈160/64、底边贴地、
  中心对人物脚底、悬空冻结、清除可再开”，改动需同步更新该场景。
- `longPressMs`/`menuPressMs`：改了要同步 gesture 单测（右键 1.5s 出菜单、左键锁定仍 3s）——
  两者拆开是刻意的：规格只把“右键菜单”改成 1.5s，“左键锁定”保持 3s 不变。
- `rest.*`：生产路径（菜单「休息」）用 CFG 默认（30s / 3s 周期 / 25↔75%）。UI 场景 `rest`
  传显式短值（3000ms / 220ms / 0.25 / 0.75）并断言“透明度在 25↔75 内往返、结束体力回满、
  恢复不透明”——改默认值不会破坏该显式断言，但改了默认上下限别忘同步场景里“从下限附近起”的假设。
- 物理开关（`settings.physicsEnabled`，默认开）：默认开时 snap/dragPhysics 两个 UI 场景行为不变；
  关闭的语义由 UI 场景 `physOff` 锁定（不抛不落、仍可吸附、吸附解除不坠落）。
- `greeting.*`：UI 场景 `greeting` 断言“气泡出现且文本 ∈ `greeting.greetings`”——删空数组会让场景失败；
  改 `delayMs` 过大（>3s）会撞场景 3s 等待上限。
- `blink.*`：UI 场景 `blink` 用 `forceBlink` 驱动、不依赖随机区间，改区间不破坏场景；
  单测 `blink.test.js` 只断言“落在区间内”，区间改得合法即可。
- `todo.checkIntervalMs`：UI 场景 `todo` 手动调 `checkDueTodos()`，不依赖 30s 间隔；改小会加快真实提醒频率。
- `reminder.soonMs/urgentMs/soonWeight/urgentWeight`：`todo.test.js` 有加权选择的确定性用例
  （rng 注入，权重 10/2/1 的落点断言）——改权重或阈值需同步这些断言；
  `randomReminderDelay` 的区间断言锁在 25~30min。
- `chat.bubbleDurationMs`：UI 场景 `chat` 断言气泡出现后立即手动关闭，不依赖时长；改小无碍。
- **新增窗口必须 `spellcheck:false`**：否则 Chromium Windows 拼写检查会在 cwd 产生乱码垃圾目录（复发过一次）。
