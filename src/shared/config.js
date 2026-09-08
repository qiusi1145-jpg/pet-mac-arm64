'use strict';
/**
 * 中央参数配置文件。
 * 规则：所有可调参数（动画幅度/时长、物理常数、状态速率、阈值、不透明度、颜色、
 * 几何/交互阈值等）都必须定义在这里（或由这里派生的模块），禁止散落硬编码。
 * 每个参数都在 TUNING.md 中说明作用与位置，交付后可自行微调。
 */

const deepFreeze = (o) => {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(o);
};

const CFG = {
  /* ---------- 图片与几何 ---------- */
  image: {
    // 宠物上传后显示的最大边长（CSS 逻辑像素）。等比缩小，超过才缩放，小图不放大。
    petMaxDim: 220,
    // 背景图允许的最大边长，超出则等比缩放（避免超大图内存爆炸）。
    bgMaxDim: 4096,
    // 判定为“不透明（可交互）”的 alpha 阈值（0-255）。> 该值视为有像素。
    alphaThreshold: 20,
    // 一次长按可判定为“点按”的最大时长（ms）。短点 = 摸头。
    tapMaxMs: 450,
    // 判定从“点按/长按”转为“拖动”的最小位移（px）。
    dragTolerance: 5,
    // 进度圈在长按后延迟多久出现（ms）。
    ringDelayMs: 500,
    // 左键长按多久触发锁定切换（ms）。
    longPressMs: 3000,
    // 右键长按多久弹出主菜单（ms）。与左键锁定分开：规格要求右键 1.5s 弹出主菜单，
    // 而左键锁定保持原来的 3s 不变。
    menuPressMs: 1500,
  },

  /* ---------- 主窗口 / 活动区域 ---------- */
  region: {
    // 区域相对工作区的上下左右留白（px）。默认填满工作区。
    defaultInset: 0,
    // 区域可调的最小/最大尺寸范围（相对工作区比例与像素），用于 UI 滑块。
    minWidthRatio: 0.2,
    minHeightRatio: 0.2,
    // 调整尺寸步进（px）。
    resizeStep: 40,
  },

  /* ---------- 动画（待机 / 反馈 / 特效） ---------- */
  anim: {
    // 待机呼吸：围绕锚点的果冻缩放幅度（相对 1 的幅值，例如 0.015 = ±1.5%）。
    breatheAmplitude: 0.015,
    // 待机呼吸周期（ms）。
    breathePeriodMs: 4200,
    // 呼吸轻微左右摇摆？0=不摇摆；用弧度幅值（预留，当前仅缩放）。
    breathePhaseOffsetMs: 0,

    // q 弹（摸头 / 喂食 / 落地 / 好感爱心）：压扁程度峰值（相对 1，<1 为压缩）。
    squishMin: 0.86,
    // q 弹拉伸峰值（>1）。
    stretchMax: 1.10,
    // q 弹回弹“频率感”Hz（越大越抖、回弹越快）。
    squishFrequency: 5.0,
    // q 弹阻尼比 ζ（<1 欠阻尼=有轻微过冲拉伸；越大越干脆）。
    squishDamping: 0.45,
    // 摸头 q 弹压缩冲量大小（负向注入；越小越软，~0.89 压缩峰值）。
    headpatImpulse: 6.2,
    // 落地压扁额外冲量倍率。
    landImpulseMult: 1.6,

    // 半透明爱心上浮时长（ms）。
    heartFloatMs: 1400,
    // 锁定态呼吸也照常播放（由模式控制，这里仅提示：锁定只关交互不关动画）。
    animateWhileLocked: true,
  },

  /* ---------- 物理（仅抛掷 / 失去支撑坠落） ---------- */
  physics: {
    // 抛出判定：释放时速度阈值（px/s），超过则进入抛掷弹道。
    throwSpeedThreshold: 800,
    // 重力加速度（px/s^2，向下为正）。
    gravity: 2600,
    // 抛掷时的水平空气阻力（每秒速度衰减比例，0-1）。
    drag: 0.06,
    // 与活动区域边界反弹的弹性系数（0-1）。1=完全弹性，0=不弹。
    restitution: 0.62,
    // 贴地后停止判定的水平速度（px/s）以下视为停。
    stopSpeedX: 26,
    // 贴地后判定“已稳定、不再竖直弹跳”的竖直速度阈值（px/s）。
    stopSpeedY: 40,
    // 稳定后停留到回待机的缓冲时间（ms）。
    settleMs: 300,
    // 吸附判定：锚点与目标窗口顶沿接近距离阈值（px）内视为贴近。
    // 吸附范围相对上一版翻倍，提升“贴边松手就能挂上去”的手感。
    snapProximityY: 120,
    // 吸附判定：锚点水平落在窗口范围外的允许余量（px）。
    snapMarginX: 25,
    // 吸附触发只限低速释放（px/s）以下。
    snapMaxSpeed: 220,
    // 贴地滚动时的额外摩擦（每秒速度衰减比例，0-…，越大停得越快）。
    groundDrag: 1.8,
    // 贴地弹跳次数上限保护（防数值发散）。
    maxBounceGuard: 200,
  },

  /* ---------- 状态系统（0-100，取整显示，内部小数，每秒结算） ---------- */
  status: {
    initialMood: 80,
    initialEnergy: 100,
    initialSatiety: 80,
    initialAffinity: 0,

    // 情绪：互动 +2，重置空闲计时。
    moodPerInteraction: 2,
    // 空闲多久开始衰减（ms）。
    idleDecayDelayMs: 30 * 60 * 1000,
    // 情绪衰减起始速率（点/分钟）。
    moodDecayStartPerMin: 0.2,
    // 情绪衰减封顶速率（点/分钟）。
    moodDecayMaxPerMin: 1.0,
    // 从空闲开始，速率线性上升到封顶所需时间（分钟）。越短越早达到峰值。
    moodDecayRampMin: 45,

    // 体力：非疲劳恢复 +0.5/分。
    energyRecoverPerMin: 0.5,
    // 疲劳判定：滚动窗口时长（ms）。
    fatigueWindowMs: 5 * 60 * 1000,
    // 窗口内互动超过该次数进入疲劳。
    fatigueThresholdCount: 10,
    // 疲劳时体力消耗（点/分）。
    fatigueDrainPerMin: 1.5,
    // 喂食额外 +5 体力。
    energyPerFeed: 5,

    // 饱食度：约每小时 -2。
    satietyDecayPerHour: 2,
    // 喂食 +20 饱食。
    satietyPerFeed: 20,

    // 归零 → 宠物半透明。恢复 >0 立即恢复不透明（不叠加）。
    lowOpacity: 0.45,
    // “归零”的判定用该阈值（内部浮点，<= 此值视为 0）。
    zeroEpsilon: 0.001,
    // 体力/情绪恢复到该值才把半透明取消？不 —— 规格：任一 >0 即恢复。保留字段便于微调。
    transparentRecoverAt: 0,

    // 好感度：每次主动互动触发 +1 的概率。
    affinityChance: 0.02,
    affinityCap: 100,
    // 每满这些好感度触发一次爱心上浮动画。
    affinityMilestoneStep: 20,

    // 计时器：持久化心跳写盘间隔（ms）——仅作为“有变化才写”的兜底。
    persistIntervalMs: 15 * 1000,

    // 高频互动惩罚（“短时间内大量点击/拖动会轻微消耗体力”）：在 burstWindowMs 内，
    // 互动次数超过 burstQuota 后，每多一次互动按 burstEnergyPerExtra 扣除体力。
    // 用来让“狂点”有可见但轻微的代价；数值都可在 TUNING 微调。
    burstWindowMs: 2500,
    burstQuota: 6,
    burstEnergyPerExtra: 0.12,
  },

  /* ---------- “休息”（右键菜单 → 透明度缓慢闪烁，结束体力回满） ---------- */
  rest: {
    // 一次休息的时长（ms）。结束后体力回满、闪烁停止、透明度恢复正常。
    durationMs: 30000,
    // 透明度正弦渐变一个完整往返的周期（ms）。越小闪得越快。
    blinkPeriodMs: 3000,
    // 闪烁时的透明度下限 / 上限（0-1）：在两者间平滑正弦往返。
    // 规格：25% ↔ 75% 之间来回。
    opacityMin: 0.25,
    opacityMax: 0.75,
    // 结束后体力回满到的值（夹 0-100）。
    energyRefill: 100,
  },

  /* ---------- 外观 ---------- */
  ui: {
    // 状态面板胶囊默认半透明背景色（rgba）。
    pillBg: 'rgba(30,30,30,0.55)',
    pillText: 'rgba(255,255,255,0.92)',
    pillFontPx: 13,
    // 菜单配色（Windows 风格浅色）。
    menuBg: '#f5f5f5',
    menuText: '#222',
    menuHover: '#e5f1fb',
    menuBorder: '#c8c8c8',
    // 进度环颜色。
    ringColor: '#4aa3ff',
    ringWidthPx: 4,
    ringRadiusPx: 30,
    // 爱心文字（程序绘制，不依赖图片）。
    heartGlyph: '♥',
    heartColor: 'rgba(255,80,120,0.9)',
    // 背景不透明度默认 80%（0.1-1.0 可调）。
    bgDefaultOpacity: 0.8,
    bgOpacityMin: 0.1,
    bgOpacityMax: 1.0,
    // 背景图的显示规则（需求：背景“贴地 + 跟随人物居中”，随人物缩放到 4/3 高）：
    //   - 背景图高度 = 人物显示高 × bgPetHScale（保持图片原比例）。
    //   - 底边始终落在活动区域地面（不随人物上下，人物被抛起时背景留在原地）。
    //   - 人物站在地面时，背景水平居中跟随人物脚底中点（人物空中时背景水平也停住）。
    bgPetHScale: 4 / 3,
    // 半透明爱心里程碑尺寸步进（可让高级别爱心更大）。
    heartSizeBase: 22,
    heartSizePerLevel: 3,
  },

  /* ---------- 吸附 / 窗口枚举（托盘可关） ---------- */
  snapPoll: {
    // 吸附后跟随目标窗口移动的轮询间隔（ms）。
    followPollMs: 400,
    // 托盘/其他需要。
    enabledByDefault: true,
  },

  /* ---------- 默认播放列表（交付后由用户目录覆盖） ---------- */
  audio: {
    volumeDefault: 0.6,
  },

  /* ---------- 启动问候 ---------- */
  greeting: {
    // 每次启动随机选一条。
    greetings: [
      '嗨，我回来啦！',
      '今天也要元气满满哦！',
      '需要我陪着吗？',
      '记得休息一下呀。',
      '嘿嘿，我在这里呢。',
      '有空就摸摸我吧。',
      '今天也要加油鸭！',
      '见到你真好。',
    ],
    delayMs: 500,
    durationMs: 5000,
  },

  /* ---------- 眨眼 ---------- */
  blink: {
    // 图片固定读取 src/assets/blink.png，用户可替换为与主图同尺寸的闭眼图。
    minIntervalMs: 2800,
    maxIntervalMs: 6200,
    minDurationMs: 90,
    maxDurationMs: 210,
  },

  /* ---------- 待办清单 ---------- */
  todo: {
    // 后台检查“未完成且已到截止时间”待办的间隔（ms）。
    checkIntervalMs: 30 * 1000,
    // 到期提醒气泡停留时长（ms）。
    remindDurationMs: 5000,
    // 到期提醒模板（{task} 会被替换为待办内容）。
    remindTemplate: '主人，该做“{task}”了！',
  },

  /* ---------- 随机催促待办（♥ 重要待办） ---------- */
  reminder: {
    // 触发间隔在 min~max 之间随机（概率性，不是固定间隔）。
    minIntervalMs: 25 * 60 * 1000,
    maxIntervalMs: 30 * 60 * 1000,
    // 剩余时间 ≤ soonMs 的 ♥ 待办，被选中权重 × soonWeight。
    soonMs: 60 * 60 * 1000,
    soonWeight: 2,
    // 剩余时间 ≤ urgentMs（或已过期）权重 × urgentWeight（大幅提升）。
    urgentMs: 10 * 60 * 1000,
    urgentWeight: 10,
    // 催促气泡停留时长（ms）。
    durationMs: 8000,
    // 催促模板（{task} 会被替换为待办内容）。
    template: "主人，'{task}' 做完了吗？",
  },

  /* ---------- 聊天 ---------- */
  chat: {
    windowWidth: 400,
    windowHeight: 540,
    settingsWidth: 460,
    settingsHeight: 500,
    // 桌宠在主窗口回复气泡的停留时长（ms）。
    bubbleDurationMs: 5000,
  },
};

deepFreeze(CFG);

module.exports = { CFG, deepFreeze };
