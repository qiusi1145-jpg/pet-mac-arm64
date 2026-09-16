'use strict';
/**
 * 中央参数配置文件 —— 应用唯一的调参/文案/定制入口（README 有每键说明）。
 * 规则：所有可调参数（动画幅度/时长、物理常数、状态速率、阈值、不透明度、颜色、
 * 几何/交互阈值、菜单文案与可见性、问候/提醒/聊天文案、状态图与眨眼动画路径等）
 * 都定义在这里，禁止散落硬编码。
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
    // 宠物显示的最大边长（CSS 逻辑像素）。等比缩放，超过才缩放，小图不放大。
    petMaxDim: 220,
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
    // 右键长按多久弹出主菜单（ms）。与左键锁定分开：右键 1.5s 主菜单，左键锁定保持 3s。
    menuPressMs: 1500,
  },

  /* ---------- 主窗口 / 活动区域 ---------- */
  region: {
    // 区域相对工作区调整尺寸的步进（px）。
    resizeStep: 40,
  },

  /* ---------- 动画（待机 / 反馈 / 特效） ---------- */
  anim: {
    // 待机呼吸：围绕锚点的果冻缩放幅度（相对 1 的幅值，例如 0.015 = ±1.5%）。
    breatheAmplitude: 0.015,
    // 待机呼吸周期（ms）。
    breathePeriodMs: 4200,
    // q 弹（摸头 / 喂食 / 落地 / 好感爱心）回弹“频率感”Hz（越大越抖、回弹越快）。
    squishFrequency: 5.0,
    // q 弹阻尼比 ζ（<1 欠阻尼=有轻微过冲拉伸；越大越干脆）。
    squishDamping: 0.45,
    // 摸头 q 弹压缩冲量大小（负向注入；越小越软，~0.89 压缩峰值）。
    headpatImpulse: 6.2,
    // 落地压扁额外冲量倍率。
    landImpulseMult: 1.6,
    // 半透明爱心上浮时长（ms）。
    heartFloatMs: 1400,
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
    // 吸附判定：锚点与目标窗口顶沿接近距离阈值（px）内视为贴近。
    snapProximityY: 120,
    // 吸附判定：锚点水平落在窗口范围外的允许余量（px）。
    snapMarginX: 25,
    // 贴地滚动时的额外摩擦（每秒速度衰减比例，0-…，越大停得越快）。
    groundDrag: 1.8,
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

    // 好感度：每次主动互动触发 +1 的概率。
    affinityChance: 0.02,
    affinityCap: 100,
    // 每满这些好感度触发一次爱心上浮动画。
    affinityMilestoneStep: 20,

    // 计时器：持久化心跳写盘间隔（ms）——仅作为“有变化才写”的兜底。
    persistIntervalMs: 15 * 1000,

    // ★ 桌宠“不在你面前”时（应用关闭 / 窗口隐藏）要不要继续按时间流逝结算？
    //   false（默认）= **冻结**：这段时间直接从时间轴上抹掉（见 status.js freezeStatus()）。
    //   —— 用户 2026-09-16 拍板：关掉电脑过一夜后第二天打开，情绪与饱食度都被算到 0
    //      （"别让桌宠在后台挨饿"），体感很差。冻结后只有它在你眼前时时间才算数。
    //   true = 恢复旧行为（启动/恢复显示时一次性结算离线时长），成对地情绪与饱食都会掉。
    decayWhileAway: false,

    // 高频互动惩罚（“短时间内大量点击/拖动会轻微消耗体力”）：在 burstWindowMs 内，
    // 互动次数超过 burstQuota 后，每多一次互动按 burstEnergyPerExtra 扣除体力。
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
    // 闪烁时的透明度下限 / 上限（0-1）：在两者间平滑正弦往返（25% ↔ 75%）。
    opacityMin: 0.25,
    opacityMax: 0.75,
    // 结束后体力回满到的值（夹 0-100）。
    energyRefill: 100,
  },

  /* ---------- 外观 ---------- */
  ui: {
    // 状态面板胶囊默认半透明背景色 / 文字色（rgba）。
    pillBg: 'rgba(30,30,30,0.55)',
    pillText: 'rgba(255,255,255,0.92)',
    // 进度环颜色。
    ringColor: '#4aa3ff',
    // 爱心文字（程序绘制，不依赖图片）。
    heartGlyph: '♥',
    heartColor: 'rgba(255,80,120,0.9)',
    // 背景不透明度默认 80%（0.1-1.0 可调）。
    bgDefaultOpacity: 0.8,
    bgOpacityMin: 0.1,
    bgOpacityMax: 1.0,
    // 背景图显示规则（背景“贴地 + 跟随人物居中”）：背景图高度 = 人物显示高 × bgPetHScale
    // （保持原图比例）；底边始终落在活动区域地面；人物站在地面时背景水平居中跟随脚底中点，
    // 人物空中时背景水平停住。
    bgPetHScale: 4 / 3,
    // 半透明爱心里程碑尺寸步进（让高级别爱心更大）。
    heartSizeBase: 22,
    heartSizePerLevel: 3,
  },

  /* ---------- 吸附 / 窗口枚举（托盘可关） ---------- */
  snapPoll: {
    // 吸附后跟随目标窗口移动的轮询间隔（ms）。
    followPollMs: 400,
  },

  /* ---------- BGM ---------- */
  audio: {
    volumeDefault: 0.6,
    // 语音"在听"期间自动压到的音量（防止麦克风把自己的音乐收进去污染识别）。
    duckVolume: 0.15,
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

  /* ---------- 眨眼 ----------
   * 新机制：主循环逐帧检测“主呼吸波缩放偏移归零（符号翻转）”的零点，每个零点按
   * zeroChance 掷骰触发；降级单图（src/assets/blink.png，与主图同尺寸最贴合）显示
   * zeroFrameMs 后恢复。拖动/飞行/手势中/切状态图/窗口隐藏时无呼吸零点 → 自然不眨。 */
  blink: {
    // 每个呼吸零点的触发概率（0~1）。
    zeroChance: 0.9,
    // 降级单图眨眼的显示时长（ms）。多帧动画模式（blinkAnim.frames）每帧用各自时长。
    zeroFrameMs: 150,
  },

  /* ---------- 随机特效动画（整帧替换的随机小动画，如 动画素材/动画1、动画2） ----------
   * groups 每项 = 一组帧序列；帧是“包含完整宠物的整图”，播放时隐藏本体、整帧替换、播完恢复。
   * 触发：每次播完或跳过后在 min~max 间隔随机再试；到点后挂起，等下一个呼吸零点起播
   * （起播门禁：本体恰在未变形尺寸，切换无跳变）。与眨眼互斥（特效优先）；
   * 拖动/物理/手势/切形态/隐藏时跳过本轮。
   * 帧 path 解析：以 "../" 开头 = 相对渲染层目录（src/renderer/）的内置素材（如 ../../动画素材/…）；
   * 其余相对 data/ 或绝对路径（与 blinkAnim.frames 一致，经主进程读取）。 */
  effectAnim: {
    groups: [
      {
        name: '动画1',
        frameMs: 150, // 每帧显示时长（ms）
        frames: [
          '../../动画素材/动画1/动画一第1帧.png',
          '../../动画素材/动画1/动画一第2帧.png',
          '../../动画素材/动画1/动画一第3帧.png',
        ],
      },
      {
        name: '动画2',
        frameMs: 150,
        frames: [
          '../../动画素材/动画2/动画二第1帧.png',
          '../../动画素材/动画2/动画二第2帧.png',
          '../../动画素材/动画2/动画二第3帧.png',
        ],
      },
    ],
    minIntervalMs: 15 * 1000,
    maxIntervalMs: 25 * 1000,
  },

  /* ---------- 待办清单 ---------- */
  todo: {
    windowWidth: 440,      // 待办窗口尺寸（2026-09-17 从 main.js 硬编码挪入，与其它窗口同源）
    windowHeight: 560,
    // 后台检查"未完成且已到截止时间"待办的间隔（ms）。
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
    // 聊天窗文案。
    strings: {
      opening: '主人好呀，跟我说说话吧！',        // 开场白（**只在记录为空时**写入一次）
      missNotice: '（桌宠歪了歪头，好像没听懂……）', // 未命中关键词时的轻提示
      // 大模型失败回落规则引擎时，写进聊天记录的那句人话（key = 引擎的原因码）。
      // 放在这里而不是各渲染层各一份：主进程写记录、设置窗显示"测试连接"结果都用同一张表。
      fallbackReasons: {
        'no-key': '还没填密钥',
        'no-base-url': '没填 base_url',
        'no-model': '没填模型名',
        auth: '密钥无效',
        'not-found': '接口地址错（检查 base_url 是否带 /v1）',
        'model-not-found': '模型名不存在',
        'rate-limit': '触发限流',
        server: '服务端错误',
        network: '网络不可达',
        timeout: '请求超时',
        aborted: '已取消',
        'bad-response': '响应解析失败',
        'bad-url': 'base_url 不合法',
        'force-fallback': '调试开关（强制回落）',
        unknown: '未知错误',
      },
    },
    // ★ 聊天记录（2026-09-16 新增）：独立 json、明文保存、**刻意放在便携目录之外**。
    //   为什么放外面：把桌宠文件夹拷给别人 / 发出去，不该把聊天记录一起带走（用户明确要求）。
    //   路径规则同密钥文件（`~` = 用户主目录；相对路径也按主目录解析）→ 见 main/userFile.js。
    //   自检/测试用环境变量 PET_CHAT_LOG_FILE 覆盖，避免污染真实主目录。
    logFile: '~/.deskpet/chat.json',
    // 记录条数上限（超出丢最旧的）。这是"翻阅用台账"，不是数据库，别设太大。
    logMax: 500,
  },

  /* ---------- 聊天引擎（ChatEngine 契约 + 注册表，见 src/shared/chat/） ----------
   * 目的：让"以后接大模型"变成「新增一个文件 + 改一个配置字段」，不动 ASR / IPC / UI / 持久化。
   * 唯一接缝是 ChatRequest.channel（'text' | 'voice'）——引擎不知道这句话是打字来的还是说的。
   * active 指到不可用（或未实现）的引擎时会**自动回落 rule**，桌宠不会"不说话"。 */
  chatEngine: {
    active: 'rule', // 'rule'（关键词规则，默认）| 'llm'（大模型，OpenAI 兼容）
    engines: {
      rule: { id: 'rule', label: '关键词规则（离线，默认）' },
      /* ★ LLM 引擎（OpenAI 兼容 /v1/chat/completions）。
       * 安全红线（三条，改这块前先读）：
       *  ① **密钥不进 settings.json**（该文件随便携 data/ 拷来拷去）→ 存独立的**明文密钥文件**
       *     `keyFile`（默认 `~/.deskpet/llm.key`，见下面注释：**刻意放在便携目录之外**）；
       *     也支持环境变量 `apiKeyEnv`（存的是**变量名**，不是密钥）作为后备。
       *  ② 出网请求**只允许在主进程**（渲染层永远拿不到密钥）。
       *  ③ 密钥绝不进日志/错误信息（`llm.js` 里还有一道 `sk-***` 脱敏兜底）。
       * ⚠ 密钥文件是**明文**（用户 2026-09-15 决策：不要加密保险箱，要能直接拿记事本改）。
       *   所以唯一的硬要求是**它不能跟着便携包走**：路径必须在程序目录之外，且换电脑后
       *   第一次保存密钥时能自动创建（`llmSecret.js` 用 mkdirSync(recursive) 保证）。
       * 接新服务商：多数厂商都是 OpenAI 兼容（DeepSeek / Moonshot / 通义 / 智谱 / 本地 Ollama…），
       * 只需在 `presets` 里加一条，或让用户在设置面板里选「自定义」后手填 base_url + 模型名。 */
      llm: {
        id: 'llm', label: '大模型（OpenAI 兼容）',
        provider: 'deepseek',                  // 预设 id（见 presets）；'custom' = 手填
        baseUrl: 'https://api.deepseek.com/v1', // 不带尾部斜杠；本地如 'http://127.0.0.1:11434/v1'
        model: 'deepseek-chat',
        apiKeyEnv: '',                         // 环境变量**名**（可选，优先级低于密钥文件）
        // ★ API 密钥文件的路径（**明文**；不填则用 llmSecret.js 的默认值 `~/.deskpet/llm.key`）。
        //   `~` = 用户主目录；相对路径也按**用户主目录**解析（刻意不按程序目录 —— 否则又变成便携的了）。
        //   设计意图：把桌宠文件夹整个拷到别的电脑**不会**带走密钥；那边第一次保存密钥时自动建目录。
        //   ⚠ 别把它改到 data/ 里面（那会让密钥跟着便携包走，等于把红线拆了）。
        //   自检/测试可用环境变量 PET_LLM_KEY_FILE 覆盖（避免污染真实用户主目录）。
        keyFile: '~/.deskpet/llm.key',
        // 服务商预设：选中后自动带出 base_url / 模型名（用户仍可手改）
        presets: [
          { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
          { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
          { id: 'custom', label: '自定义（任意 OpenAI 兼容服务 / 本地模型）', baseUrl: '', model: '' },
        ],
        temperature: 1.0,           // 0~2；DeepSeek 官方对**通用对话**推荐 1.0（0.7 会更保守、更容易说套话）
        maxTokens: 512,             // 请求侧 max_tokens（留足空间，气泡另有 maxChars 截断）
        maxChars: 300,              // ★ 单次回复最大字数（超长截断）。⚠ 气泡只有 260px 宽、显示 5s，
                                    //   300 字约占 15 行、读不完 → 想短就调小（120 约 7 行）
        historyTurns: 10,           // 携带的历史轮数（1 轮 = 一问一答）；0 = 不带历史
        historyMaxChars: 4000,      // 历史总字数预算（超预算从最旧的丢）
        timeoutMs: 10000,           // 单次请求超时（默认 10s；可调小到 3s 做超时测试）
        retryMax: 2,                // ★ 429 / 5xx / 网络抖动 的**额外**重试次数（指数退避，绝无无限重试）
        retryBaseMs: 500,           // 退避基数：第 n 次重试等 retryBaseMs * 2^(n-1)
        stream: false,              // 流式输出（打字机效果）；流式与非流式是两条代码路径，能力必须对齐
        streamDeltaMs: 80,          // 流式增量推送到界面的最小间隔（防 IPC 洪水）
        streamMaxChars: 20000,      // 流式累计上限（防御：模型失控重复时别把内存吃光）
        forceFallback: false,       // ★ 调试开关：强制走"回落规则引擎"路径（测兜底不用拔网线）
        systemPrompt: '你是桌面宠物，说话简短、口语化、温和，像一个陪读的小伙伴。',
        // 追加在 systemPrompt 之后的硬约束（{maxChars} 会被替换成实际字数上限）
        replyRules: '回复要求：不超过 {maxChars} 字；口语化、别用 Markdown 标题或长列表；不要复述用户的问题。',
      },
    },
  },

  /* ---------- 语音（语音识别 / 唤醒词）----------
   * 选型：sherpa-onnx（路线 A：sherpa-onnx-node，Node-API 原生插件；推理在**独立隐藏渲染进程**，
   * 音频一次都不跨进程，主进程只做编排——主进程每 16ms 推光标，绝不能被推理阻塞）。
   * 模型放 data/voice/models/<model>/（随便携 data/ 走，不进 git）。
   * 全部离线：音频不出本机、默认不落盘、不联网。 */
  voice: {
    enabled: true,
    engine: 'sherpa-onnx-node',   // 预留：以后换引擎/换预编译 exe 只改这里
    model: 'zipformer-zh-int8',   // 对应 data/voice/models/<model>/
    // 可选模型档位（白名单：手改 settings 指向别的 id 会被 normalizeVoicePrefs 拒绝）。
    // dir = 模型在 data/voice/models/ 下的目录名（下载脚本按它落地）。
    // kind = **模型结构**，决定推理时怎么填 modelConfig（三种结构差别很大，别只看体积）：
    //   'transducer'   encoder + decoder + joiner 三件套
    //   'zipformer2Ctc' 单文件 model.onnx（CTC，配 bbpe.model 做 BPE 词表）
    //   'senseVoice'    单文件、非流式
    // streaming = 是否边说边出字（流式）。
    // 体积为**实测**（GitHub release 的 content-length / 解压后实测，2026-09-14 核实）。
    models: [
      {
        id: 'zipformer-zh-int8',
        label: '中文 · 均衡（153MB，流式，推荐）',
        dir: 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
        kind: 'transducer',
        streaming: true,
      },
      {
        id: 'small-ctc-zh-int8',
        label: '中文 · 轻量（解压后约 25MB，流式，慢网/老旧机器首选）',
        dir: 'sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01',
        kind: 'zipformer2Ctc',   // ★ 单文件 + bbpe.model（不是三件套！）
        streaming: true,
      },
      {
        id: 'sense-voice-int8',
        label: '中英日韩粤 · 高精度（数十 MB，非流式，说话完再出字）',
        dir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
        kind: 'senseVoice',
        streaming: false,
      },
    ],
    // 唤醒词关键词模型（KWS）。建模单元 = **拼音（声母+韵母）**，所以关键词写的是音素串不是汉字。
    // 体积实测：压缩包 31MB、解压后约 34MB（官方标 3.3M 是模型参数量，不是下载体积）。
    // ★ 它**不在 asr-models 那个 release 里**，而在 `kws-models`（实测：用 asr-models 取这个文件会 502）。
    kwsModel: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
    sampleRate: 16000,
    // 语音聊天设置窗（主菜单「聊天 ▸ 语音聊天设置…」）
    settingsWidth: 470,
    settingsHeight: 600,
    // ★ 交互模型（2026-09-16 用户定调，取代原来的 4 种"触发方式"）：
    //   · 聊天窗**常态是打字聊天**；
    //   · 「语音对话」由聊天窗的 🎤 按钮进入/退出（运行期开关，不持久化）：
    //     点一下 → 自动连续多轮（说完静音自动断句 → 停麦等模型 → 回复到了自动接着听）；
    //   · 唤醒词是**独立的**后台被动监听（没开聊天窗时也能喊一声叫醒我），由 wake.enabled 控制。
    //   · 按键说话（PTT）见下面的 `ptt` 段：全局键 = 按一下进入 / 再按一下退出（任何窗口都能按）；
    //     聊天窗内的键 = 按住说话、松开立即提交。**与语音对话共存**，不互斥。
    // ---- 唤醒词（关键词检测 KWS）----
    // KWS 吃的是**音素串**不是中文原文（sherpa-onnx 的 keywords.txt 格式：
    //   `x iǎo ài t óng x ué :1.5 #0.25 @小爱同学`）。本项目不依赖 Python，
    // 所以内置词库把「中文 → 音素串」预先做好放 data/voice/wakewords.json，
    // 用户也可在设置窗里直接改音素串（高级）。
    wake: {
      enabled: true,              // ★ 要不要**在后台监听唤醒词**（true = 麦克风常驻；用户可在设置窗关掉）
      word: '桌宠桌宠',           // 当前唤醒词原文（显示用）
      tokens: '',                // 当前唤醒词的音素串；空 = 由内置词库按 word 查表
      // 内置可选唤醒词（值 = 音素串）。
      // ★ 已用**真实 KWS 词表**逐 token 核对通过（227 个 token，2026-09-14 实测）；
      //   想加新词：照这个格式写（声母+韵母+声调，如 zh uō），或用模型目录里自带的
      //   `keywords.txt`（官方示例词，token 保证正确）直接抄一行。
      builtin: [
        { word: '桌宠桌宠', tokens: 'zh uō ch ǒng zh uō ch ǒng' },
        { word: '小助手', tokens: 'x iǎo zh ù sh ǒu' },
        { word: '你好桌宠', tokens: 'n ǐ h ǎo zh uō ch ǒng' },
        { word: '同学同学', tokens: 't óng x ué t óng x ué' },
        { word: '小老师', tokens: 'x iǎo l ǎo sh ī' },
      ],
      boost: 1.5,      // keywords.txt 的 :boost（越大越易触发）
      threshold: 0.25, // #threshold（越大越严）
    },
    // ---- 语音对话（聊天窗 🎤 进入/退出）：一轮 = 听 → 静音自动断句 → 停麦等模型 → 回复到了自动接着听 ----
    dialog: {
      // 「过短不请求」阈值：**两个条件同时满足**才把这句话发给大模型。
      // 用户 2026-09-16："仅发出'啊'声或其他过短语句时不向大模型发起请求"。
      minSpeechMs: 350,   // ① 有效人声时长下限（按帧统计 RMS 超阈值的毫秒数；"啊"一声约 200~300ms）
      minChars: 2,        // ② 去掉标点后至少几个字（挡住"嗯""哦"这类单字噪声）
      // 等待模型回复的上限：超过就自动恢复采集（防"模型卡住 → 语音永久哑掉"）
      resumeTimeoutMs: 30000,
    },
    // ---- 按键说话（PTT）键位；用户可在「语音聊天设置」里**点一下再按一个键**来自定义 ----
    // 两种形态**故意分开**，因为 Electron 的 `globalShortcut` 只给 keydown、没有 keyup：
    //   local     = 聊天窗内「按住说话」（有 keydown+keyup，是真正的按住；松开=立即提交这一句，
    //               不用等 1.2 秒静音断句）
    //   globalKey = 全局「按一下进入语音对话 / 再按一下退出」（**任何窗口**都能按）
    // 默认 globalKey **留空 = 不注册**：不替用户平白占用按键，要用的人自己设一个。
    // ★ 沿革：2026-09-16 白天曾按要求取消 PTT（理由是与语音对话互斥），当晚用户要求改回来 ——
    //   现在两者**共存**：语音对话是"会话状态"，按键只是进入/退出与"提前提交"的快捷方式。
    ptt: {
      local: 'Control+Shift+Space',
      globalKey: '',
    },
    endpointSilenceMs: 1200,  // 静音多久算一句说完（流式与非流式统一用这个值；用户体感 1.2 秒）
    maxRecordMs: 15000,       // 单句上限（防呆）
    prewarmMs: 1200,          // 启动后多久预热模型（避免首次说话干等 1~2s）
    // ---- 自愈（重试机制）：语音"没准备好"必须能自己恢复，而不是让用户对着没反应的键干瞪眼 ----
    readyTimeoutMs: 20000,    // 识别进程多久没回报 ready 就算"卡住" → 触发一次受控重建
    readyMaxRetries: 3,       // 卡住/加载失败最多自动重建几次（上限，防死循环刷 CPU）
    retryDelayMs: 600,        // 重建前的退避等待（别在同一个坏状态下疯狂重试）
    duckBgmWhileListening: true, // 听/识别期间自动压低 BGM（否则麦克风会把自己的音乐收进去）
    showPartial: true,        // 实时字幕
    bubbleMs: 8000,           // 识别结果气泡停留时长
    saveRecordings: false,    // ★ 默认不保存录音（隐私：音频不出本机）
    strings: {
      listening: '我在听…',
      heard: '听到了：{text}',
      empty: '没听清，再说一次？',
      noModel: '语音模型未安装（data/voice/models）',
      noMic: '没找到麦克风（或权限被拒绝）',
      notReady: '语音引擎还没准备好，稍等再试',
      starting: '语音引擎正在加载模型，稍等一下再说（首次约 1~3 秒）',
      wakeHint: '说“{word}”唤醒我',
      // 语音对话相关（聊天窗状态条）
      dialogOn: '语音对话中…（直接说话，点麦克风结束）',
      thinking: '在想…',
      tooShort: '没听清，再说一次？',   // 过短/没内容：**不请求大模型**，只在状态条上提示
      noSpeech: '没听到你说话',
      // 按键说话（键位录制 / 全局键注册失败时用）
      pressKey: '请按一个键…（只按 Ctrl / Shift / Alt 不算，需要再配一个字母或功能键）',
      keyTaken: '这个键已被其它程序占用，换一个试试',
      keyCleared: '已清除全局键',
    },
  },

  /* ---------- 主菜单文本与可见性（可定制） ----------
   * id → 默认文案；可见性默认全开，给某个 id 加 `visible:false` 即可在菜单里隐藏该项
   * （功能逻辑本身不受影响）。主进程 popupMainMenu 按 id 取文本/可见性组装菜单。 */
  menu: {
    items: {
      rest: { label: '休息' },
      feed: { label: '喂食' },
      todo: { label: '待办…' },
      chat: { label: '聊天' },
      chatOpen: { label: '聊天' },
      chatSettings: { label: '聊天设置' },
      voiceSettings: { label: '语音聊天设置…' },
      // 「学习」一级菜单（2026-09-14 起：学英语从聊天子菜单迁到这里）
      learn: { label: '学习' },
      english: { label: '学英语' },
      pomodoro: { label: '番茄钟' },
      planner: { label: '学习计划表' },
      music: { label: '音乐' }, // 显示时会追加曲目数“（N）”
      musicAdd: { label: '添加音乐…' },
      musicToggle: { label: '播放 / 暂停' },
      musicNext: { label: '下一首' },
      musicPrev: { label: '上一首' },
      musicStop: { label: '停止播放' },
      musicClear: { label: '清空列表' },
      bg: { label: '背景' }, // 已设置背景时显示时会追加“（已设置）”
      bgPick: { label: '选择背景图片…' },
      bgClear: { label: '清除背景' },
      bgOp25: { label: '不透明度 25%' },
      bgOp50: { label: '不透明度 50%' },
      bgOp75: { label: '不透明度 75%' },
      bgOp100: { label: '不透明度 100%' },
      state: { label: '切换状态' },
      stateMain: { label: '主宠物图' },
      stateAlt: { label: '状态图' },
      resetStatus: { label: '重置状态' },
      quit: { label: '退出' },
    },
  },

  /* ---------- 眨眼动画（多帧序列增强） ----------
   * frames 非空时：每次眨眼机会按 probability 概率依次播放帧序列（每帧各自 durationMs），
   * 播完恢复常态；frames 为空时降级为原有单图眨眼（src/assets/blink.png）。
   * 帧 path 会被主进程按数据目录（便携 data/，测试 PET_USERDATA）解析，绝对路径也可。 */
  blinkAnim: {
    frames: [], // [{ path, durationMs }]
    probability: 1, // 0~1：每次眨眼机会播放动画序列的概率
    defaultFrameMs: 150, // 新帧未填时长时的默认显示时长
  },

  /* ---------- 状态切换图路径覆盖（null = 用内置 src/assets/state.png） ---------- */
  stateImage: {
    path: null,
  },

  /* ---------- 学英语（独立窗口：翻译练习/选词填空/背单词） ----------
   * 词库数据在 data/english/words.<level>.json（构建见该目录 _build.js）；
   * 难度与主题偏好持久化在 settings.json 的 english 字段；
   * 背单词 SRS 进度持久化在 data/english/progress.json。 */
  english: {
    windowWidth: 560,
    windowHeight: 680,
    // 难度档位（顺序即 UI 展示顺序）。词书文件 = words.<id>.json；缺文件 → UI 显示“该难度暂无数据”。
    levels: [
      { id: 'chuzhong', label: '初中' },
      { id: 'gaozhong', label: '高中' },
      { id: 'cet4', label: '四级' },
      { id: 'cet6', label: '六级' },
      { id: 'kaoyan', label: '考研' },
      { id: 'ielts', label: '雅思' },
      { id: 'tem8', label: '专八' },
    ],
    // 默认难度 / 默认主题（主题预设全集见 english.css 的 [data-theme=…]）。
    defaultLevel: 'cet4',
    defaultTheme: 'aurora',
    // ---- 学习节奏（用户可在学英语窗口的设置面板里改，存 prefs）----
    dailyNewMin: 5,
    dailyNewMax: 100,
    // 复习:新词 出卡比例；review-first = 复习全部优先再补新词（旧行为）
    ratios: ['review-first', '3:1', '2:1', '1:1', '1:2'],
    defaultRatio: '2:1',
    // ---- 桌宠催背（主进程定时气泡；主窗复用 bubble:reminder 通道）----
    reminder: {
      choicesMin: [0, 15, 30, 60, 120, 240, 480], // 0 = 关闭
      defaultMin: 120,
      quietHourStart: 8,  // 只在 8:00–23:00 之间催
      quietHourEnd: 23,
      durationMs: 8000,
      // {total}/{review}/{new} 会被替换为当天剩余数
      template: '⏰ 该背单词啦！今天还剩 {total} 词（复习 {review} · 新词 {new}）',
    },
    // ---- 积分段位（只统计近 90 天，越久远权重越低——长期不学自然掉分）----
    rank: {
      dailyCap: 80,          // 每天最多计入的积分
      ptsPerNew: 2,          // 学会 1 个新词
      ptsPerReviewOk: 1,     // 复习答对 1 次
      quizBonus: 5,          // 小测达标奖励
      quizPassCorrect: 4,    // 小测达标线（≥4/6）
      goalBonus: 10,         // 当日新词达标一次性奖励
      // 权重窗口：30 天内全额，30–60 天半额，60–90 天四分之一，90 天外不计
      windows: [{ days: 30, w: 1 }, { days: 60, w: 0.5 }, { days: 90, w: 0.25 }],
      // 段位（CEFR 风格命名；score ≥ at 即达档）。rank 摘要 {score, tier} 为可序列化对象，
      // 预留作未来联网排行榜的上报载荷（见 shared/english.js computeRank 注释）。
      tiers: [
        { at: 0, name: '未评级' },
        { at: 30, name: 'A1 入门' },
        { at: 120, name: 'A2 基础' },
        { at: 300, name: 'B1 进阶' },
        { at: 600, name: 'B2 高阶' },
        { at: 1100, name: 'C1 熟练' },
        { at: 1800, name: 'C2 精通' },
      ],
    },
    // ---- 组内小测（背单词流程中每学 N 张卡插一轮混合小测）----
    quiz: { everyGraded: 10, size: 6 },
    // ---- 翻译判分（judgeTranslation）：归一化后精确命中 = correct；否则按关键词重叠率分档 ----
    judge: {
      correctAt: 0.8, // 重叠率 ≥ 该值判“正确”
      closeAt: 0.4,   // 重叠率 ≥ 该值判“接近”（展示参考答案）
      // 英译中判分时忽略的高频虚词（不参与关键词统计）
      enStopwords: 'the a an of to in on at for and or is are was were be been am do does did will would can could should i we you he she it they that this these those'.split(' '),
    },
    // ---- 选词填空生成器（词书无真题时的兜底出题）----
    cloze: {
      minSentenceTokens: 4,  // 例句少于该词数不出生成题
      maxPerSession: 50,     // 生成器干扰项采样池上限（同书随机词）
      // 目标词本身是虚词时的固定干扰池
      pools: {
        prep: 'in on at for with about of to from by into onto over under above below across through against between among during without within upon'.split(' '),
        conj: 'because although while since unless before after if when until though whereas whereas whether as so that'.split(' '),
      },
      // 禁止作为挖空目标的词（主语代词/助动/冠词等——出题红线：永不挖主语）
      neverBlank: 'i we you he she it they me us him her them my our your his its their mine ours yours theirs who whom whose which what this that these those there here not no nor and but or so if then than as the a an is am are was were be been being do does did done have has had having will would shall should can could may might must'.split(' '),
    },
    // ---- 背单词间隔重复（Leitner 简化）：lv 为答对次数档，答对升 1 档、答错降 2 档 ----
    srs: {
      intervalsMs: [10 * 60e3, 3600e3, 86400e3, 3 * 86400e3, 7 * 86400e3, 14 * 86400e3, 30 * 86400e3],
      lapseDelayMs: 10 * 60e3, // 答错（降到 0 档也一样）后多久重现
      dailyNew: 20,            // 每日新词上限（跨难度共享当天额度）
    },
  },

  /* ---------- 番茄钟（独立窗口；主菜单「学习 ▸ 番茄钟」）----------
   * 预设 + 用户自定义：预设做成快捷按钮，用户也能填任意 min~max 分钟。
   * 节奏：专注 → 短休 → 专注 … 每完成 longBreakEvery 个专注插入一次长休。
   * 完成一个专注会回一点体力/情绪（让"陪伴"与"学习"互相有反馈）。 */
  pomodoro: {
    windowWidth: 400,
    windowHeight: 540,
    // 预设时长（分钟）——窗口里的快捷按钮
    presets: {
      focus: [15, 25, 45, 60],
      shortBreak: [5, 10],
      longBreak: [15, 30],
    },
    minMinutes: 1,    // 自定义时长的合法区间（分钟）
    maxMinutes: 180,
    defaultFocusMin: 25,
    defaultShortBreakMin: 5,
    defaultLongBreakMin: 15,
    longBreakEvery: 4,        // 每完成 N 个专注 → 下一次休息用长休
    autoStartNext: false,     // 一段结束后是否自动开始下一段
    tickMs: 250,              // 计时刷新间隔（ms）
    rewardEnergy: 8,          // 完成一个专注 → 体力 +（0 = 不回）
    rewardMood: 2,            // 完成一个专注 → 情绪 +
    strings: {
      phaseFocus: '专注',
      phaseShortBreak: '短休',
      phaseLongBreak: '长休',
      idle: '准备开始',
      running: '进行中',
      paused: '已暂停',
      doneFocus: '专注完成！该休息了～',
      doneBreak: '休息结束，继续加油！',
      custom: '自定义',
    },
  },

  /* ---------- 学习计划表（独立日程窗口；主菜单「学习 ▸ 学习计划表」）----------
   * 一个日程视图 + **桌宠主图缩小后作窗口装饰**（右下角，跟随同一套素材解析顺序，
   * 换 data/assets/pet/pet.png 即换装饰，和主窗保持一致）。 */
  planner: {
    windowWidth: 580,
    windowHeight: 660,
    maxItems: 300,        // 单条 ≤200 字、总条数上限（防 settings.json 无限膨胀）
    maxTextLen: 200,
    // 装饰小桌宠（主图缩小）
    deco: {
      enabled: true,
      heightRatio: 0.30,   // 装饰高度 = 窗口高的 ×该值
      opacity: 0.92,
      corner: 'bottom-right', // 'bottom-right' | 'bottom-left'
    },
    weekStart: 1,          // 1=周一
    dayStartHour: 8,       // 日程视图默认滚动到的起始小时
    dayEndHour: 23,
    strings: {
      empty: '还没有计划。加一条，我陪你一起完成！',
      today: '今天',
      done: '已完成',
      tomorrow: '明天',
    },
  },
};

deepFreeze(CFG);

module.exports = { CFG };
