'use strict';
/**
 * 桌宠 — 主进程入口。
 *
 * 关键实现选择（Windows 单显示器）：
 *  - 宠物窗口 == “活动区域”一个无边框透明置顶窗口。区域内宠物透明处 → 像素级点击
 *    穿透（win.setIgnoreMouseEvents(true,{forward:true})）；当指针落在实体像素上或
 *    打开菜单/面板时，才临时关闭忽略。用主进程高频推送光标位置 + 渲染层命中判定。
 *  - 锁定态 = 永远整窗点击穿透（动画照常），唯一解锁途径：托盘菜单。
 *  - 宠物/背景图片复制到 userData/assets 后持久化**相对路径**（随 data/ 文件夹便携）。
 */
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { CFG } = require('../shared/config');
const { computeRegion, defaultRegionSettings } = require('../shared/geom');
const {
  findDueTodos, formatTask, normalizeTodo, pickReminderTodo, randomReminderDelay,
  normalizePomodoroPrefs, normalizePlanner, normalizeVoicePrefs, normalizeLlmPrefs,
} = require('../shared/content');
const englishM = require('../shared/english');
const { stripPngColorChunks } = require('../shared/util');
const { Store } = require('./store');
const { ChatOrchestrator } = require('./chatOrchestrator');
const { VoiceService } = require('./voiceService');
const { LlmSecret, resolveKeyFile, isInsideDir } = require('./llmSecret');
const { ChatLog, resolveLogFile } = require('./chatLog');
const chatM = require('../shared/chat');
const llmM = require('../shared/chat/llm');
const { WinEnum, isSystemWindow } = require('./winenum');

const PET_NAME = '桌宠';

// 语音端到端自检开关（`electron . --voice-e2e`）：必须在最早期决定 —— 它要改 userData 路径。
// 为什么需要它：单测验纯函数、诊断验引擎，**只有这条路径验"接线"**（2026-09-15 的事故就是它抓出来的）。
const VOICE_E2E = process.argv.includes('--voice-e2e');
// LLM 端到端自检开关（`electron . --llm-e2e`）：同样要尽早决定，因为它会改 userData 与**密钥文件**路径。
const LLM_E2E = process.argv.includes('--llm-e2e');

// 便携化（"整个文件夹发到别的电脑双击即用"）：userData 固定在应用文件夹内 data/，
// 素材、settings.json、编译产物（winenum）全部跟着文件夹走，不写注册表、不依赖本机用户目录。
// 优先级：PET_USERDATA（测试隔离）> data/ 便携目录。旧版 %APPDATA%\桌宠 的数据由
// migrateLegacyPortableData() 在首次启动时一次性搬进 data/。
const APP_ROOT = app.getAppPath();            // 项目根（package.json 所在目录，随文件夹整体移动）
const DATA_DIR = path.join(APP_ROOT, 'data'); // 便携数据目录
if (process.env.PET_USERDATA) app.setPath('userData', process.env.PET_USERDATA);
// 自检实例默认用临时 userData：别去抢正在运行的桌宠的 data/（Chromium 缓存锁会打架）。
// 同时把 PET_USERDATA 也设上 —— 让"旧数据一次性迁移"跳过：自检不该读用户的历史数据。
else if (VOICE_E2E || LLM_E2E) {
  const dir = path.join(os.tmpdir(), `deskpet-${VOICE_E2E ? 'voice' : 'llm'}-e2e-${process.pid}`);
  app.setPath('userData', dir);
  process.env.PET_USERDATA = dir;
}
else app.setPath('userData', DATA_DIR);

// 自检的安全兜底：无论上面走哪条分支，都**别把测试密钥写进真实用户主目录**。
// 正常情况下调用方会显式传 PET_LLM_KEY_FILE（两阶段自检要共用同一个文件，才能验"重启后密钥还在"）；
// 这里是"有人直接敲 electron . --llm-e2e"时的最后一道保险。
if (LLM_E2E && !process.env.PET_LLM_KEY_FILE) {
  process.env.PET_LLM_KEY_FILE = path.join(os.tmpdir(), `deskpet-llm-e2e-key-${process.pid}`, 'llm.key');
}

// 同理：**聊天记录也是"用户级文件"（在便携目录之外）**，测试/自检实例一律隔离，
// 否则跑一次 UI 场景就会往真实的 `~/.deskpet/chat.json` 里塞测试对话。
// 触发条件 = 用了临时 userData（PET_USERDATA，测试与自检都会设）或自检开关；显式传了则以显式为准。
if (!process.env.PET_CHAT_LOG_FILE && (process.env.PET_USERDATA || VOICE_E2E || LLM_E2E)) {
  process.env.PET_CHAT_LOG_FILE = path.join(process.env.PET_USERDATA || os.tmpdir(), 'chat.json');
}

// 供渲染层访问进程内共享逻辑的测试开关（仅测试模式可用）
const TEST_MODE = !!(process.env.PET_TEST || process.env.PET_SMOKE || process.env.PET_SCENARIO);

const log = (...a) => { if (process.env.PET_DEBUG) console.log('[main]', ...a); };
log('main module loaded');

// PET_DEBUG=1 时把日志**同时写进 <userData>/debug.log**。
// 原因：Windows 下双击 .bat 没有控制台、用 Start-Process 重定向也抓不到 Electron 的主进程输出，
// 于是"出问题时看不到任何日志"。落盘一份最省事（data/ 在 .gitignore 内，不会进仓库）。
if (process.env.PET_DEBUG) {
  const LOG_FILE = path.join(app.getPath('userData'), 'debug.log');
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  let truncated = false;
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const append = (tag, args) => {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      if (!truncated) { fs.writeFileSync(LOG_FILE, `=== 桌宠调试日志 ${new Date().toISOString()} ===\n`, 'utf8'); truncated = true; }
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString().slice(11, 23)}]${tag} ${args.map(fmt).join(' ')}\n`, 'utf8');
    } catch { /* 写不了就算了，别影响运行 */ }
  };
  console.log = (...a) => { append(' ', a); origLog(...a); };
  console.error = (...a) => { append(' E', a); origErr(...a); };
}

// 让“应用内添加音乐 → 自动播放 / 播放列表切歌”无需额外的用户手势即可出声。
// （Chromium 默认 autoplay 策略会拦掉没有 user gesture 的 Audio.play()，这里放开。）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 【交互冻结根治】禁用 Chromium 的 Windows 遮挡计算（CalculateNativeWinOcclusion）：
// 它会把“被完全遮挡的本窗”（透明巨窗常会被这么判）按 hidden 处理 → rAF 停转 →
// “悬停→取消穿透”的命中判定全停，实测症状为“桌宠点不动 + 浮层关不掉”同时出现。
// 本应用常驻渲染本就无可省功耗，直接禁掉该特性（渲染层另有 cursor:pos IPC 驱动判定的兜底）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 语音诊断模式（`npm run voice:diag`）——必须在 ready 之前决定：
//  · 关掉 GPU：诊断只需要一个隐藏窗采音频，而**无 GPU / 沙箱 / 远程会话**下
//    Chromium 的 GPU 进程会反复崩，最后 FATAL "GPU process isn't usable" 直接带走整个进程。
//  · userData 指到临时目录：避免与正在运行的桌宠抢 data/ 的缓存锁（实测会 "Unable to move the cache 拒绝访问"）。
const VOICE_DIAG = process.argv.includes('--voice-diag');
// 无 GPU 运行：`PET_NOGPU=1`。给三类场景用：受限/沙箱/远程会话（独立 GPU 进程会反复崩 →
// FATAL "GPU process isn't usable" 直接带走进程）、CI 冒烟、以及不便截图的环境。
// 只影响渲染后端，功能不变（桌宠本身也不吃 GPU 性能）。
const NO_GPU = !!process.env.PET_NOGPU;
if (VOICE_DIAG || NO_GPU) {
  try {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('in-process-gpu');
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-dev-shm-usage');
    if (VOICE_DIAG) {
      // 诊断用临时 userData：避免与正在运行的桌宠抢 data/ 的缓存锁
      // （实测会 "Unable to move the cache 拒绝访问 (0x5)"）
      app.setPath('userData', path.join(require('os').tmpdir(), `deskpet-voice-diag-${process.pid}`));
    }
  } catch (e) {
    console.error('[main] no-gpu 初始化失败：', (e && e.message) || e);
  }
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);
const IMG_EXTS = new Set(['.png']);

class PetApp {
  constructor() {
    this.win = null;
    this.tray = null;
    this.userDataRoot = app.getPath('userData'); // 便携模式 = <项目>/data；测试 = PET_USERDATA
    this.store = new Store(this.userDataRoot);
    this.winEnum = new WinEnum(this.userDataRoot);
    this.assetsDir = path.join(this.userDataRoot, 'assets');
    // 素材根目录（需求："换图即定制"）：宠物主图（约定文件 pet.png）、眨眼帧、状态图都放这里。
    // 应用内不提供浏览/修改该目录的入口；开发者用文件管理器维护。
    this.petRoot = path.join(this.assetsDir, 'pet');
    this.region = null;           // 屏幕坐标区域
    this.locked = false;
    // 置顶级别恒为最高档（screen-saver）：锁定与解锁的差异只在“整窗强制穿透”这类
    // 交互语义，不在层级——低级别（floating）会被其它置顶/全屏应用遮挡（手册 #13）。
    this.lockLevel = 'screen-saver';
    this.visible = true;
    this.ignore = true;
    this.consoleErrors = [];
    this.consoleListenerAttached = false;
    this.quitNow = false;
    this.quitting = false;        // 退出流程重入保护（quit() 是异步的：要等宠物窗回一次状态快照）
    this.initPromise = null;
    this.todoWin = null;          // 待办清单窗口
    this.todoTimer = 0;           // 到期检查定时器
    this.remindedTodoIds = new Set(); // 已提醒过的到期待办（本次运行内不重复弹）
    this.reminderTimer = 0;       // 随机催促定时器
    this.chatWin = null;          // 聊天窗口
    this.chatSettingsWin = null;  // 聊天设置窗口
    this.englishWin = null;       // 学英语窗口
    this.pomodoroWin = null;      // 番茄钟窗口
    this.plannerWin = null;       // 学习计划表窗口
    this.voiceSettingsWin = null; // 语音聊天设置窗口
    this.voiceWin = null;         // 语音采集/识别进程宿主窗（隐藏；见 voiceService.js）
    this._englishBooks = {};      // 学英语词书内存缓存（level → book）
    this.englishRemindTimer = 0;  // 桌宠催背定时器
    this.stateVisualOn = false;   // 当前形态：false=主宠物图，true=状态图（渲染层回传同步）
    // 聊天编排器：文字（chatSend）与语音（voiceFinal）的唯一汇流点，内部走 ChatEngine 注册表
    this.orchestrator = new ChatOrchestrator(this);
    // 语音服务（识别进程生命周期 / 模型状态 / 降级）——见 voiceService.js；
    // 未初始化时为 null，相关 IPC 全部走"优雅不可用"分支（不崩不卡）。
    this.voice = null;
    this._asrEventBound = false;  // asr:event 转发是否已注册（只注册一次；与"实例是否存在"分开判断）
    this.pttAcc = '';             // 当前已注册的全局「按键说话」accelerator（空 = 没注册）
    // LLM（大模型）：密钥文件 + 进行中的请求 + 请求日志环形缓冲
    this.llmSecret = null;      // 见 llmSecret.js（明文密钥文件，在便携目录之外）
    this.llmKeyFile = '';       // 密钥文件的绝对路径（init 时按 config/PET_LLM_KEY_FILE 解析）
    this.chatLog = null;        // 聊天记录（独立 json，同样在便携目录之外；见 chatLog.js）
    this.llmInflight = null;    // 当前请求的 AbortController（"停止"/新一句到来时取消）
    this.llmLog = [];           // [{ts,kind,path,code,httpStatus,elapsedMs,...}] 最多 50 条
  }

  /**
   * 一次性迁移（便携化改造）：旧版把数据放在 %APPDATA%\桌宠。
   * 便携 data/ 里还没有 settings.json 且旧目录存在 → 拷贝 settings.json + assets/，
   * 并把其中指向旧数据目录的绝对路径改写成相对路径（否则换电脑就断链）。
   */
  migrateLegacyPortableData() {
    if (process.env.PET_USERDATA) return; // 测试实例不做迁移
    const dst = this.userDataRoot;
    const legacy = path.join(app.getPath('appData'), PET_NAME);
    if (path.resolve(legacy) === path.resolve(dst)) return;
    if (!fs.existsSync(path.join(legacy, 'settings.json'))) return;
    if (fs.existsSync(path.join(dst, 'settings.json'))) return; // 已迁移/便携目录已在用
    try {
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(legacy, 'settings.json'), path.join(dst, 'settings.json'));
      const srcAssets = path.join(legacy, 'assets');
      if (fs.existsSync(srcAssets)) fs.cpSync(srcAssets, path.join(dst, 'assets'), { recursive: true });
      const file = path.join(dst, 'settings.json');
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const fix = (p) => {
        if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return p;
        const rel = path.relative(legacy, p);
        // 旧数据目录内的文件 → 相对路径；目录外的（如下载目录里的旧导入）保持原样
        return (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? p : rel.split(path.sep).join('/');
      };
      if (cfg.pet && cfg.pet.path) cfg.pet.path = fix(cfg.pet.path);
      if (cfg.background && cfg.background.path) cfg.background.path = fix(cfg.background.path);
      if (Array.isArray(cfg.playlist)) for (const t of cfg.playlist) if (t && t.path) t.path = fix(t.path);
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
      log('已从旧数据目录迁移到便携目录:', legacy, '->', dst);
    } catch (e) {
      log('迁移旧数据失败（忽略，按全新数据目录启动）:', e && e.message);
    }
  }

  async init() {
    log('init start');
    this.migrateLegacyPortableData(); // 旧 %APPDATA% 数据一次性搬进便携 data/（放在 load 前）
    this.store.load();
    this.locked = !!this.store.get().locked;
    this.visible = this.store.get().visible !== false;
    log('store loaded');

    // LLM 密钥文件（**明文独立文件，刻意放在便携目录之外**）——密钥**不进 settings.json**。
    // 必须在 setupIpc 之前建好 —— IPC 处理里会用到它。
    // 路径解析：PET_LLM_KEY_FILE（自检/测试隔离，避免污染真实用户主目录）> config 的 keyFile > 默认。
    const llmKeyCfg = (CFG.chatEngine.engines.llm || {}).keyFile;
    this.llmKeyFile = resolveKeyFile({
      keyFile: llmKeyCfg,
      homeDir: os.homedir(),
      envFile: process.env.PET_LLM_KEY_FILE,
    });
    this.llmSecret = new LlmSecret({
      file: this.llmKeyFile,
      log: (...a) => log('[llm-key]', ...a),
    });
    this.configureLlm();   // 把密钥/偏好/日志/流式回调注入 shared 层的 llm 引擎
    log('llm ready, keyFile=', this.llmKeyFile,
      'insidePortable=', isInsideDir(this.userDataRoot, this.llmKeyFile),
      'stored=', this.llmSecret.status().stored);

    // 聊天记录（独立 json、**便携目录之外**，见 chatLog.js）：主进程是唯一写入方。
    this.chatLog = new ChatLog({
      file: resolveLogFile({
        logFile: (CFG.chat || {}).logFile,
        homeDir: os.homedir(),
        envFile: process.env.PET_CHAT_LOG_FILE,
      }),
      max: CFG.chat.logMax,
      log: (...a) => log('[chat-log]', ...a),
    });
    this.chatLog.load();
    log('chat log ready, file=', this.chatLog.file, 'entries=', this.chatLog.size());

    if (!app.requestSingleInstanceLock()) {
      log('single instance lock busy, quit');
      app.quit();
      return;
    }
    app.on('second-instance', () => this.showWindow());
    app.setAppUserModelId('com.deskpet.desktop');

    fs.mkdirSync(this.assetsDir, { recursive: true });
    fs.mkdirSync(this.petRoot, { recursive: true });

    // 环境预置宠物（仅开发/测试用，非用户功能；用户素材走素材根目录）
    if (process.env.PET_PET_PATH) {
      const p = process.env.PET_PET_PATH;
      if (fs.existsSync(p)) this.importPetFile(p);
    }

    this.initRegion();
    log('region', JSON.stringify(this.region));
    this.createWindow();
    log('window created');

    this.setupIpc();
    this.createTray();
    // 吸附用的窗口枚举 exe 提前编译/校验：留到第一次松手吸附才编译的话，
    // 那一下同步编译会卡主进程约 1 秒（现在 list() 本身已是异步 spawn）。
    this.winEnum.ensure();
    this.startCursorPush();
    this.startTodoChecker();
    this.scheduleReminder();
    this.scheduleEnglishReminder();
    // ★ 语音服务必须在这里真正启动。2026-09-15 用户报"重启后仍然显示语音引擎没准备好"，
    //   真因就是**这一行漏了**：startVoice() 写好了却没人调用 → this.voice 恒为 null
    //   → 聊天窗麦克风按钮永不出现、按键只回一句"没准备好"。
    //   回归测试见 test/unit/voice-wiring.test.js（它把主进程 boot 一遍再断言接线）。
    this.startVoice();
    log('ipc/tray/cursor/voice up');

    if (process.env.PET_SMOKE) {
      this.runSmoke();
    } else if (process.env.PET_SCENARIO) {
      this.runScenario(process.env.PET_SCENARIO);
    }
    // 注：首次运行不再自动弹"更换宠物"——换宠交互已移除（"换图即定制"设计），
    // 无宠物时主窗左下角提示条会引导把 pet.png 放进素材根目录。
  }

  /* ---------------- 区域与窗口 ---------------- */

  initRegion() {
    const wa = screen.getPrimaryDisplay().workArea;
    const s = this.store.get().region;
    const siz = s.width && s.height ? s : defaultRegionSettings(wa);
    this.region = computeRegion(wa, siz, CFG.image.petMaxDim);
  }

  createWindow() {
    const r = this.region;
    this.win = new BrowserWindow({
      title: PET_NAME,
      x: r.x, y: r.y, width: r.width, height: r.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      // 不可激活（Windows: WS_EX_NOACTIVATE）：点击宠物不抢系统前台。
      // 若可激活，点击会把前台切给这个“覆盖全工作区的透明置顶窗”，触发其它 Chromium
      // 应用（浏览器等）的原生窗口遮挡检测重算 → 对方被判“被完全遮挡” → 其 GIF/视频
      // 冻结、视频黑屏白屏；点回那个窗口才恢复。需要键盘的浮层（应用内选择器）打开时
      // 经 win:setFocusable 临时允许激活。
      focusable: false,
      enableLargerThanScreen: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        devTools: false,
        // 必须关闭：Chromium 的 Windows 拼写检查会在进程 cwd 下不断创建
        // “<乱码名>/Microsoft/Spelling”垃圾目录（已知上游问题）。
        spellcheck: false,
      },
    });
    // 屏幕显示时再 show，避免白闪
    this.pageLoaded = false;
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: TEST_MODE ? { test: '1' } : {} });
    this.win.webContents.on('did-finish-load', () => { log('page did-finish-load'); this.pageLoaded = true; });
    this.win.once('ready-to-show', () => {
      if (!this.quitNow) {
        this.win.show(); this.win.setAlwaysOnTop(true, 'screen-saver');
        if (!this.visible) { this.win.hide(); this.win.webContents.send('app:visibility', { visible: false }); }
      }
    });
    // 置顶级别统一最高档（screen-saver）：锁定/解锁差异只在穿透语义（见构造函数注释）
    this.win.setAlwaysOnTop(true, this.lockLevel);
    this.win.setIgnoreMouseEvents(true, { forward: true });
    // 【遮挡冻结根治】加 WS_EX_TOOLWINDOW（工具窗口位）：Chromium 系应用（Chrome/Edge/QQ 等）
    // 的"原生窗口遮挡检测"会把工具窗口排除在遮挡物之外。实测（A/B 对照）：不加此位时，
    // 真实点击激活本窗（覆盖整个工作区）会把被盖住的浏览器标签页判为 hidden → GIF/视频
    // 冻结（点回那个窗口才恢复）；加此位后同样的点击不产生任何冻结。附带效果：Alt-Tab
    // 里不再出现桌宠（本就不该出现）。
    if (process.platform === 'win32') {
      try {
        const hwndDec = this.win.getNativeWindowHandle().readBigUInt64LE(0).toString();
        this.winEnum.applyExStyle(hwndDec, 0x80, 0); // WS_EX_TOOLWINDOW
      } catch (e) { log('applyExStyle failed', e && e.message); }
    }
    this.win.on('closed', () => { this.win = null; });
    if (!this.consoleListenerAttached) {
      this.consoleListenerAttached = true;
      this.win.webContents.on('console-message', (ev, ...rest) => this.onConsoleMessage(ev, rest));
    }
  }

  onConsoleMessage(ev, rest) {
    let level = typeof ev === 'object' && ev ? ev.level : ev;
    let message = typeof ev === 'object' && ev ? (ev.message || '') : '';
    if (!message && rest.length) message = rest.join(' ');
    if (typeof ev === 'number') { level = ev; message = rest.join(' '); }
    const isError = (typeof level === 'string' && level === 'error') || level === 3;
    if (isError) this.consoleErrors.push(String(message).slice(0, 500));
    if (process.env.PET_DEBUG) log('renderer-msg', level, String(message).slice(0, 300));
  }

  /* ---------------- 光标推送与点击穿透 ---------------- */

  startCursorPush() {
    this.cursorTimer = setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return;
      if (!this.win.isVisible() || this.quitNow) return;
      const p = screen.getCursorScreenPoint();
      this.win.webContents.send('cursor:pos', { x: p.x, y: p.y });
    }, 16);
  }

  setIgnore(v) {
    if (this.ignore === v) return;
    const was = this.ignore;
    this.ignore = v;
    if (this.win && !this.win.isDestroyed()) {
      // 锁定态强制穿透
      if (this.locked) { v = true; this.ignore = true; }
      this.win.setIgnoreMouseEvents(v, { forward: true });
      if (!was && this.ignore) {
        // 交互结束恢复穿透时的尽力而为兜底：部分应用的遮挡检测会因 z-order 变更事件重算。
        // 实测 Chrome/Edge 不以 REORDER 触发重算（根治靠 WS_EX_TOOLWINDOW + 禁遮挡计算），
        // 但保留它对其它实现可能是有效的解冻手段，且开销可忽略。
        try {
          this.win.setAlwaysOnTop(false);
          this.win.setAlwaysOnTop(true, this.lockLevel);
        } catch { /* 窗口可能正在销毁 */ }
      } else if (was && !this.ignore) {
        // “伸手即置顶”：从穿透转可交互的瞬间抬到 z 序最上（手册 #13），比定时轮询自然。
        try { this.win.moveTop(); } catch { /* 窗口可能正在销毁 */ }
      }
    }
  }

  /** 键盘浮层（应用内选择器）期间临时允许窗口激活（路径输入框/Esc 需要键盘），关闭即还原。
   *  平时保持不可激活（focusable:false），原因见 createWindow 里的遮挡误判说明。 */
  setFocusable(v) {
    if (!this.win || this.win.isDestroyed()) return;
    if (!v) this.win.blur(); // 若窗口当前持有焦点，先还给系统再变回不可激活
    this.win.setFocusable(v);
  }

  // 锁定统一入口：置顶级别恒为最高档（screen-saver），锁定差异只在整窗强制穿透；
  // 解锁恢复正常穿透判定。托盘是解锁保底入口。
  setLocked(v) {
    const next = !!v;
    if (next !== this.locked) {
      this.locked = next;
      this.store.update({ locked: next }).saveSoon();
      if (this.win && !this.win.isDestroyed()) {
        this.win.setIgnoreMouseEvents(next, { forward: true });
        this.ignore = next; // 直接设置过穿透态，同步缓存
      }
    }
    this.rebuildTray();
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('lock:change', { locked: this.locked });
  }

  /* ---------------- IPC ---------------- */

  setupIpc() {
    ipcMain.handle('app:init', () => ({
      testMode: TEST_MODE,
      locked: this.locked,
      visible: this.visible,
      regionScreen: { ...this.region },
      workArea: { ...screen.getPrimaryDisplay().workArea },
      petMaxDim: CFG.image.petMaxDim,
      settings: this.store.get(),
      // 宠物主图解析结果（优先级：素材根目录 pet.png > settings 旧值 > 内置主图；
      // 内置主图即交付的正式宠物，不再有“占位提示”概念）
      petPath: this.resolvePetPath(),
    }));

    ipcMain.on('win:setIgnore', (_e, v) => this.setIgnore(Boolean(v)));
    // 应用内选择器打开/关闭时临时开/关“可激活”（平时 false，见 createWindow 注释）
    ipcMain.on('win:setFocusable', (_e, v) => this.setFocusable(Boolean(v)));
    ipcMain.on('ui:lock', (_e, locked) => this.setLocked(Boolean(locked)));

    // 资产导入与读取
    ipcMain.handle('asset:importBg', (_e, srcPath) => this.importAsset(srcPath, 'bg', 'background'));
    ipcMain.handle('asset:readImage', (_e, p) => this.readImageAsDataUrl(this.resolveDataPath(p)));
    ipcMain.handle('asset:readAudio', (_e, p) => this.readAudioBytes(this.resolveDataPath(p)));

    // 应用内文件选择器（换宠/背景/音乐：列文件都由渲染层走这里，绕开失灵的原生对话框）
    ipcMain.handle('picker:roots', () => this.pickerRoots());
    ipcMain.handle('picker:list', (_e, arg) => this.pickerListFiles(arg)); // arg=dir 或 {dir,kind:'audio'}
    // 应用内“添加音乐”：源文件拷贝进 assets/audio-… → 追加到播放列表 → 回推 audio:list
    ipcMain.handle('audio:addFiles', (_e, paths) => this.addAudioTracks(Array.isArray(paths) ? paths : [paths]));

    ipcMain.on('settings:save', (_e, patch) => { this.store.update(patch).saveSoon(); });

    // 待办清单（独立窗口；数据持久化在 settings.json 的 todos 字段）
    ipcMain.handle('todo:load', () => this.store.get().todos || []);
    ipcMain.handle('todo:add', (_e, t) => this.todoAdd(t));
    ipcMain.handle('todo:update', (_e, id, patch) => this.todoUpdate(id, patch));
    ipcMain.handle('todo:remove', (_e, id) => this.todoRemove(id));

    // 聊天（独立窗口；回复规则持久化在 settings.json 的 chatRules 字段）
    // 聊天**记录**在独立 json 文件里（便携目录之外，见 chatLog.js）——渲染层只渲染，不再自己记
    ipcMain.handle('chat:send', (_e, text) => this.chatSend(text));
    ipcMain.handle('chat:history:load', () => this.chatHistoryLoad());
    ipcMain.handle('chat:history:status', () => this.chatLogStatus());
    ipcMain.handle('chat:history:clear', () => this.chatHistoryClear());
    ipcMain.handle('chat:strings', () => ({ opening: CFG.chat.strings.opening, missNotice: CFG.chat.strings.missNotice }));
    ipcMain.handle('chatRules:load', () => this.store.get().chatRules || []);
    ipcMain.handle('chatRules:add', (_e, rule) => this.chatRuleAdd(rule));
    ipcMain.handle('chatRules:remove', (_e, keyword) => this.chatRuleRemove(keyword));
    // 聊天引擎（ChatEngine 注册表）：列出可用引擎 / 切换当前引擎（llm 未实现会被自动回落）
    ipcMain.handle('chatEngine:list', () => ({
      engines: chatM.listEngines(),
      active: (this.store.get().chatEngine || CFG.chatEngine).active,
    }));
    ipcMain.handle('chatEngine:set', (_e, id) => this.setChatEngine(id));

    // ---- LLM（大模型）：偏好 / 密钥 / 连通性 / 日志（引擎实现见 shared/chat/llm.js）----
    // 密钥只在主进程内流转：IPC 只收"设/清/查状态/定位文件"，**永远不回传密钥内容**。
    ipcMain.handle('llm:status', () => this.llmStatus());
    ipcMain.handle('llm:prefs:save', (_e, raw) => this.setLlmPrefs(raw));
    ipcMain.handle('llm:key:set', (_e, apiKey) => {
      const r = this.llmSecret ? this.llmSecret.set(apiKey) : { ok: false, code: 'no-store' };
      this.configureLlm();
      return { ...r, status: this.llmStatus() };
    });
    ipcMain.handle('llm:key:clear', () => {
      const r = this.llmSecret ? this.llmSecret.clear() : { ok: false, code: 'no-store' };
      this.configureLlm();
      return { ...r, status: this.llmStatus() };
    });
    // 「打开密钥文件位置」：路径是明文文件，让用户能自己去看看/用记事本改
    ipcMain.handle('llm:key:reveal', () => this.revealLlmKeyFile());
    ipcMain.handle('llm:test', async () => ({ result: await this.llmTest(), status: this.llmStatus() }));
    ipcMain.handle('llm:log:clear', () => { this.llmLog = []; return { ok: true }; });
    // 用户点「停止」→ 立刻取消进行中的请求（渲染层按钮见 chat.html #stopBtn）
    ipcMain.handle('chat:cancel', () => ({ ok: this.abortLlmInflight('user-stop') }));

    // 学英语（独立窗口；词书/进度在 data/english/，偏好持久化在 settings.json 的 english 字段）
    ipcMain.handle('english:loadBook', (_e, level) => this.loadEnglishBook(level));
    ipcMain.handle('english:progress:load', () => this.loadEnglishProgress());
    ipcMain.handle('english:progress:save', (_e, progress) => this.saveEnglishProgress(progress));
    ipcMain.handle('english:prefs:load', () => (this.store.get().english || null));
    ipcMain.handle('english:prefs:save', (_e, prefs) => {
      if (!prefs || typeof prefs !== 'object') return false;
      this.store.update({ english: prefs }).saveNow();
      this.scheduleEnglishReminder(); // 催背频率可能被改 → 重新排程
      return true;
    });

    // 学习：番茄钟（settings.pomodoro）/ 学习计划表（settings.planner）
    ipcMain.handle('pomodoro:prefs:load', () => this.store.get().pomodoro || null);
    ipcMain.handle('pomodoro:prefs:save', (_e, prefs) => {
      const n = normalizePomodoroPrefs(prefs);
      if (!n) return { ok: false };
      this.store.update({ pomodoro: n }).saveNow();
      return { ok: true, prefs: n };
    });
    ipcMain.handle('pomodoro:report', (_e, payload) => this.pomodoroReport(payload));
    ipcMain.handle('planner:load', () => this.store.get().planner || null);
    ipcMain.handle('planner:save', (_e, raw) => {
      const n = normalizePlanner(raw) || { items: [] };
      this.store.update({ planner: n }).saveNow();
      return { ok: true, items: n.items };
    });
    // 宠物主图缩略图（学习计划表的装饰小桌宠 / 设置窗预览）：与主窗同一套素材解析顺序
    ipcMain.handle('pet:thumbnail', () => this.petThumbnail());

    // 语音聊天设置：唤醒词 / 触发方式 / 档位 / 设备（识别服务本身见 voiceService.js）
    ipcMain.handle('voice:prefs:load', () => this.store.get().voice || null);
    ipcMain.handle('voice:prefs:save', (_e, prefs) => {
      if (prefs == null) { // 传 null = 还原默认
        this.store.update({ voice: null }).saveNow();
        const ptt = this.onVoicePrefsChanged();
        return { ok: true, prefs: null, ptt };
      }
      const n = normalizeVoicePrefs(prefs);
      if (!n) return { ok: false, prefs: null };
      this.store.update({ voice: n }).saveNow();
      const ptt = this.onVoicePrefsChanged(); // 唤醒词/模式/键位变了 → 通知识别侧与快捷键
      return { ok: true, prefs: n, ptt };
    });
    // 语音：所有入口都先过 ensureVoiceService()（惰性自愈）——
    // 启动期万一没起来（漏调用/异常被吞/热重载），用户的第一次点击就把它补上，
    // 而不是永久停在"引擎没准备好"（2026-09-15 那次事故的教训）。
    ipcMain.handle('voice:status', () => {
      const v = this.ensureVoiceService();
      return v ? v.status() : {
        available: false, engine: CFG.voice.engine, model: CFG.voice.model,
        modelReady: false, kwsReady: false, reason: 'not-initialized',
      };
    });
    ipcMain.handle('voice:devices', async () => {
      const v = this.ensureVoiceService();
      return v ? v.devices() : { ok: false, devices: [] };
    });
    ipcMain.handle('voice:start', (_e, opts) => this.startVoiceDialog(opts));
    // 用户主动重试（语音聊天设置里的"重试"按钮）：把"卡住/已停用"从死局里救回来
    ipcMain.handle('voice:retry', () => {
      const v = this.ensureVoiceService();
      if (!v) return { ok: false };
      const st = v.retry();
      this.onVoicePrefsChanged();   // 重建后按当前偏好重新落唤醒词等
      return { ok: true, status: st };
    });
    // 退出语音对话**不**触发惰性补启：为了"停止"而新建一个服务毫无意义（还可能平白拉起 200MB 模型）
    ipcMain.handle('voice:stop', () => this.stopVoiceDialog());
    // 聊天窗内「按住说话」**松开** → 立即提交当前这句（不等 1.2 秒静音断句）；同样不补启
    ipcMain.handle('voice:flush', () => (this.voice ? this.voice.flushUtt() : { ok: true }));
    ipcMain.handle('voice:final:submit', (_e, text) => this.voiceFinal(text));

    // 右键长按触发的 Windows 风格主菜单（Phase 4）
    ipcMain.on('menu:open', () => this.popupMainMenu());

    // 区域调整（渲染层菜单触发）
    ipcMain.handle('region:resize', (_e, width, height) => this.resizeRegion(width, height));

    // 状态图形态（渲染层应用后回传，供“切换状态”菜单单选项的勾选态）
    ipcMain.on('state:visualSync', (_e, { useState }) => { this.stateVisualOn = !!useState; });

    // 窗口枚举（吸附）。list() 异步 spawn（不阻塞主进程事件循环），handle 自动等待 Promise。
    ipcMain.handle('enumerate:windows', async () => {
      if (!this.win) return [];
      const selfId = this.selfNativeId();
      const wins = await this.winEnum.list();
      return wins.filter((w) => w.id !== selfId && !isSystemWindow(w));
    });
  }

  selfNativeId() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const big = buf.readBigUInt64LE(0);
      return big.toString();
    } catch { return '-1'; }
  }

  /** 相对路径 → 绝对路径：settings 里的相对路径以数据目录为基准；绝对路径原样返回。 */
  resolveDataPath(p) {
    if (!p || typeof p !== 'string') return p;
    return path.isAbsolute(p) ? p : path.join(this.userDataRoot, p);
  }

  /** 绝对路径 → 相对数据目录的路径（便携化关键：换电脑/改根文件夹名都不断链）。 */
  relDataPath(abs) {
    const r = path.relative(this.userDataRoot, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return abs; // 数据目录外的文件保持绝对路径
    return r.split(path.sep).join('/');
  }

  copyIntoAssets(src, prefix) {
    const ext = path.extname(src) || '.png';
    const dest = path.join(this.assetsDir, `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e5)}${ext}`);
    fs.copyFileSync(src, dest);
    return dest;
  }

  /** 仅测试预置用（PET_PET_PATH）：拷进 assets 并写入 settings.pet.path。非用户功能。 */
  importPetFile(src) {
    if (!src || !fs.existsSync(src)) return null;
    const dest = this.copyIntoAssets(src, 'pet');
    this.store.updateDeep('pet', { path: this.relDataPath(dest) }).saveNow();
    return dest;
  }

  /**
   * 解析当前应加载的宠物主图路径（"换图即定制"）：
   * 1. 素材根目录约定文件 pet.png（data/assets/pet/pet.png，手动替换文件即定制，重启生效）；
   * 2. 兼容旧用户：settings.json 的 pet.path（相对/绝对都支持）；
   * 3. 内置主图（src/assets/pet.png）：新电脑/空素材目录也直接有宠物可看。
   */
  resolvePetPath() {
    const conventional = path.join(this.petRoot, 'pet.png');
    if (fs.existsSync(conventional)) return conventional;
    const legacy = this.resolveDataPath(this.store.get().pet && this.store.get().pet.path);
    if (legacy && fs.existsSync(legacy)) return legacy;
    const fallback = path.join(APP_ROOT, 'src', 'assets', 'pet.png');
    return fs.existsSync(fallback) ? fallback : null;
  }

  importAsset(src, prefix, storeKey) {
    if (!src || !fs.existsSync(src)) return null;
    const dest = this.copyIntoAssets(src, prefix);
    this.store.updateDeep(storeKey, { path: this.relDataPath(dest) }).saveNow();
    return dest;
  }

  readImageAsDataUrl(p) {
    try {
      if (!p || !fs.existsSync(p)) return null;
      let buf = fs.readFileSync(p);
      const ext = path.extname(p).toLowerCase();
      if (ext === '.png') {
        // 色彩统一：无损剥离内嵌色彩档案块（iCCP/gAMA/cHRM/sRGB，只删辅助块、像素零改动），
        // 否则带 ICC 档案的素材会被浏览器单独调色，与不带档案的素材出现肉眼色差。
        buf = stripPngColorChunks(buf);
      }
      const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/bmp';
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, ext };
    } catch { return null; }
  }

  readAudioBytes(p) {
    try {
      if (!p || !fs.existsSync(p)) return null;
      const buf = fs.readFileSync(p);
      return { bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), name: path.basename(p) };
    } catch { return null; }
  }

  resizeRegion(width, height) {
    const wa = screen.getPrimaryDisplay().workArea;
    const s = { width: width ?? this.region.width, height: height ?? this.region.height };
    this.region = computeRegion(wa, s, CFG.image.petMaxDim);
    this.store.update({ region: { width: this.region.width, height: this.region.height } }).saveNow();
    if (this.win && !this.win.isDestroyed()) {
      this.win.setBounds(this.region);
      this.win.webContents.send('region:changed', { regionScreen: { ...this.region } });
    }
    return { regionScreen: { ...this.region } };
  }

  /* ---------------- 待办清单 ---------------- */

  /** 打开（或聚焦）待办清单窗口：普通不透明窗口、可调整大小。 */
  openTodoWindow() {
    if (this.todoWin && !this.todoWin.isDestroyed()) { this.todoWin.show(); return; }
    const w = new BrowserWindow({
      title: '待办清单',
      width: 440,
      height: 560,
      resizable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false, // 同主窗：避免 Windows 拼写检查在 cwd 产生乱码目录
      },
    });
    this.todoWin = w;
    w.setMenu(null);
    w.loadFile(path.join(__dirname, '..', 'renderer', 'todo.html'));
    w.on('closed', () => { if (this.todoWin === w) this.todoWin = null; });
  }

  /** 待办数据变化 → 推送给待办窗口刷新。 */
  todoChanged() {
    if (this.todoWin && !this.todoWin.isDestroyed()) {
      this.todoWin.webContents.send('todo:changed', { todos: this.store.get().todos });
    }
  }

  todoAdd(t) {
    const n = normalizeTodo(t);
    const todos = (this.store.get().todos || []).slice();
    if (n) todos.push(n);
    this.store.update({ todos }).saveNow();
    this.todoChanged();
    return todos;
  }

  todoUpdate(id, patch) {
    const todos = (this.store.get().todos || []).map((t) => {
      if (t.id !== id) return t;
      return normalizeTodo({ ...t, ...patch }) || t;
    });
    this.store.update({ todos }).saveNow();
    this.todoChanged();
    return todos;
  }

  todoRemove(id) {
    const todos = (this.store.get().todos || []).filter((t) => t.id !== id);
    this.store.update({ todos }).saveNow();
    this.todoChanged();
    return todos;
  }

  /** 每 30s 检查：未完成且已到截止时间的待办 → 桌宠气泡提醒（每条只提醒一次）。 */
  startTodoChecker() {
    if (this.todoTimer) return;
    this.todoTimer = setInterval(() => this.checkDueTodos(), CFG.todo.checkIntervalMs);
  }

  checkDueTodos() {
    const now = Date.now();
    const due = findDueTodos(this.store.get().todos || [], now)
      .filter((t) => !this.remindedTodoIds.has(t.id));
    if (!due.length) return;
    for (const t of due) this.remindedTodoIds.add(t.id);
    const text = formatTask(CFG.todo.remindTemplate, due[0].text);
    this.showIfHidden(); // 到期提醒需要用户看见 → 隐藏时先显示
    this.send('bubble:todo', { text, ms: CFG.todo.remindDurationMs });
  }

  /* ---------------- 随机催促（♥ 重要待办） ---------------- */

  /** 排下一次随机催促：25~30 分钟之间概率性触发（不是固定间隔）。 */
  scheduleReminder() {
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = setTimeout(() => {
      this.reminderTimer = 0;
      this.triggerReminderNow();
      this.scheduleReminder();
    }, randomReminderDelay());
  }

  /** 立即按规则催促一次：仅非锁定、非隐藏时生效；从 ♥ 待办按紧迫度加权选一条。 */
  triggerReminderNow() {
    if (this.locked || !this.visible) return;
    const t = pickReminderTodo(this.store.get().todos || [], Date.now());
    if (!t) return;
    const text = formatTask(CFG.reminder.template, t.text);
    this.send('bubble:reminder', { text, ms: CFG.reminder.durationMs });
  }

  /* ---------------- 聊天 ---------------- */

  /** 聊天窗口：普通不透明窗口，展示历史消息与输入框。 */
  openChatWindow() {
    if (this.chatWin && !this.chatWin.isDestroyed()) { this.chatWin.show(); return; }
    const w = new BrowserWindow({
      title: '聊天',
      width: CFG.chat.windowWidth,
      height: CFG.chat.windowHeight,
      resizable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false, // 同主窗：避免 Windows 拼写检查在 cwd 产生乱码目录
      },
    });
    this.chatWin = w;
    w.setMenu(null);
    w.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'));
    w.on('closed', () => { if (this.chatWin === w) this.chatWin = null; });
  }

  /** 聊天设置窗口：添加/删除“关键词 → 回复”规则。 */
  openChatSettingsWindow() {
    if (this.chatSettingsWin && !this.chatSettingsWin.isDestroyed()) { this.chatSettingsWin.show(); return; }
    const w = new BrowserWindow({
      title: '聊天设置',
      width: CFG.chat.settingsWidth,
      height: CFG.chat.settingsHeight,
      resizable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.chatSettingsWin = w;
    w.setMenu(null);
    w.loadFile(path.join(__dirname, '..', 'renderer', 'chatSettings.html'));
    w.on('closed', () => { if (this.chatSettingsWin === w) this.chatSettingsWin = null; });
  }

  /* ---------------- 学英语（独立窗口：翻译练习/选词填空/背单词） ---------------- */

  /** 打开（或聚焦）学英语窗口（创建模式与聊天/待办窗口一致）。 */
  openEnglishWindow() {
    if (this.englishWin && !this.englishWin.isDestroyed()) { this.englishWin.show(); return; }
    const w = new BrowserWindow({
      title: '学英语',
      width: CFG.english.windowWidth,
      height: CFG.english.windowHeight,
      resizable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false, // 同主窗：避免 Windows 拼写检查在 cwd 产生乱码目录
      },
    });
    this.englishWin = w;
    w.setMenu(null);
    w.loadFile(path.join(__dirname, '..', 'renderer', 'english.html'));
    w.on('closed', () => { if (this.englishWin === w) this.englishWin = null; });
  }

  /** 通用"工具窗"：普通不透明窗口，创建参数与待办/聊天/学英语完全一致
   *  （spellcheck:false 防 Chromium 在 cwd 造乱码目录；backgroundThrottling:false 保证计时不飘）。
   *  已存在则只 show/focus，不重复创建。 */
  openToolWindow(key, file, title, width, height) {
    const cur = this[key];
    if (cur && !cur.isDestroyed()) { cur.show(); cur.focus(); return cur; }
    const w = new BrowserWindow({
      title, width, height,
      resizable: true, minimizable: true, maximizable: false, fullscreenable: false,
      webPreferences: {
        nodeIntegration: true, contextIsolation: false, sandbox: false,
        backgroundThrottling: false, spellcheck: false,
      },
    });
    this[key] = w;
    w.setMenu(null);
    w.loadFile(path.join(__dirname, '..', 'renderer', file));
    w.on('closed', () => { if (this[key] === w) this[key] = null; });
    return w;
  }

  /* ---------------- 学习：番茄钟 / 学习计划表 ---------------- */

  openPomodoroWindow() {
    return this.openToolWindow('pomodoroWin', 'pomodoro.html', '番茄钟', CFG.pomodoro.windowWidth, CFG.pomodoro.windowHeight);
  }

  openPlannerWindow() {
    return this.openToolWindow('plannerWin', 'planner.html', '学习计划表', CFG.planner.windowWidth, CFG.planner.windowHeight);
  }

  /**
   * 番茄钟结算：完成一个"专注" → 桌宠回体力/情绪 + 气泡夸奖。
   * 与"随机催促/催背"同一条气泡通道（bubble:chat），不新增通道。
   */
  pomodoroReport(payload) {
    const p = payload || {};
    const isFocus = p.phase === 'focus';
    const minutes = Number.isFinite(Number(p.minutes)) ? Math.round(Number(p.minutes)) : 0;
    if (isFocus) {
      const energy = CFG.pomodoro.rewardEnergy;
      const mood = CFG.pomodoro.rewardMood;
      if (energy || mood) this.send('pet:reward', { energy, mood });
      const text = minutes > 0
        ? `专注 ${minutes} 分钟完成，真棒！${energy ? `体力 +${energy}` : ''}`
        : CFG.pomodoro.strings.doneFocus;
      this.showIfHidden();
      this.send('bubble:chat', { text, ms: CFG.chat.bubbleDurationMs });
    }
    return { ok: true };
  }

  /* ---------------- 语音聊天设置（偏好 + 状态） ---------------- */

  openVoiceSettingsWindow() {
    return this.openToolWindow('voiceSettingsWin', 'voiceSettings.html', '语音聊天设置', CFG.voice.settingsWidth, CFG.voice.settingsHeight);
  }

  /** 供设置窗与计划表窗复用的"宠物主图缩略图"（同一套素材解析顺序，换图即换装饰）。 */
  petThumbnail() {
    const p = this.resolvePetPath();
    if (!p) return null;
    const img = this.readImageAsDataUrl(p);
    return img ? { dataUrl: img.dataUrl, path: p } : null;
  }

  /**
   * 语音偏好变化（唤醒词 / 触发方式 / 档位 / 设备）后的联动：
   * 唤醒词变了要重建 KWS 关键词串；模式变了要重排监听策略。
   * 语音服务未启动时是空操作（设置照样能存，下次启动生效）。
   */
  onVoicePrefsChanged() {
    if (this.voice && typeof this.voice.applyPrefs === 'function') {
      try { this.voice.applyPrefs(this.store.get().voice || null); }
      catch (e) { log('voice applyPrefs failed', e && e.message); }
    }
    // 唤醒词/唤醒开关/设备变了 → 通知相关窗口刷新（聊天窗要更新"要不要提示唤醒词"等）
    for (const [key, label] of [['chatWin', 'chat'], ['voiceSettingsWin', 'voiceSettings']]) {
      const w = this[key];
      if (w && !w.isDestroyed()) w.webContents.send('voice:prefs:changed', { window: label, prefs: this.store.get().voice || null });
    }
    if (this.voice) { try { this.voice.broadcastDialog(); } catch { /* 忽略 */ } }
    // 键位可能变了 → 重新注册全局键（返回值让设置窗能如实提示"这个键已被其它程序占用"）
    const ptt = this.applyPttShortcut();
    return { ok: true, ptt };
  }

  /**
   * 进入「语音对话」。**三个等价入口都走到这里**：
   *   ① 聊天窗 🎤 点一下；
   *   ② **全局快捷键**按一下（`applyPttShortcut` 注册，任何窗口都能按）；
   *   ③ 聊天窗内按住说话键（渲染层先请求进入，再随说话提交）。
   * 不可用时**必须给气泡反馈**并按真实原因说话，否则用户按/点了没反应只会以为"坏了"。
   */
  startVoiceDialog(opts) {
    const S = CFG.voice.strings;
    const v = this.ensureVoiceService();   // 第一层自愈：万一没启动，这一下就补上
    if (!v) return { ok: false, error: 'not-initialized', hint: S.notReady };
    let st = v.status();
    if (!st.available) {
      // 没就绪时**先尽力自愈**（模型后装 / 进程刚崩过 / 首次加载慢），而不是直接回绝
      v.ensureReady();
      st = v.status();
      if (!st.available) {
        const text = st.reason === 'no-model' ? S.noModel
          : st.reason === 'disabled' ? '语音功能已关闭（可在「语音聊天设置」里打开）'
            : st.reason === 'crashed' ? `语音已停用：${v.error || '识别进程反复失败'}（可在「语音聊天设置」里重试）`
              : st.loading ? S.starting
                : `${S.notReady}（可在「语音聊天设置」里重试）`;
        this.send('bubble:chat', { text, ms: 5000 });
        return { ok: false, error: st.reason === 'no-model' ? 'no-model' : (st.loading ? 'loading' : 'not-ready'), hint: text };
      }
    }
    const r = v.startDialog({ deviceId: (opts && opts.deviceId) || '' });
    if (!r || !r.ok) {
      const text = r && r.error === 'no-model' ? S.noModel : S.notReady;
      this.send('bubble:chat', { text, ms: 5000 });
      return { ok: false, error: (r && r.error) || 'not-ready', hint: text };
    }
    return { ok: true, dialog: true };
  }

  /** 退出语音对话（🎤 再点一下 / 全局键再按一下）。 */
  stopVoiceDialog() {
    if (!this.voice) return { ok: true, dialog: false };
    this.voice.stopDialog();
    return { ok: true, dialog: false };
  }

  /**
   * 全局键被按下：**按一下进入语音对话 / 再按一下退出**。
   *
   * ⚠ 为什么全局不是"按住说话"：Electron 的 `globalShortcut` **只给 keydown、没有 keyup**，
   *   系统层面只可能做成"按一下切换"。真·按住只在应用窗口内（聊天窗的 local 键）。
   *   **这不是偷懒，是 API 限制**（`config.voice.ptt` 的注释里也写了）。
   * 桌上没有聊天窗时也能用：先 `showIfHidden()` 让桌宠现身，失败一律弹气泡说明原因。
   */
  toggleVoiceByKey() {
    this.showIfHidden();
    const v = this.ensureVoiceService();   // 第一层自愈：万一没启动，这一按就补上
    if (!v) {
      this.send('bubble:chat', { text: CFG.voice.strings.notReady, ms: 4000 });
      return { ok: false, error: 'not-initialized' };
    }
    // ★ 用"是否正在语音对话"判断，**不能**用 state!=='idle'：
    //   开着唤醒监听时状态是 listening（不是 idle），拿状态判断会把"要开始"误判成"要停止"，
    //   导致全局键在唤醒模式下按了毫无反应（2026-09-15 踩过，别退回去）。
    if (v.isDialogOn()) return this.stopVoiceDialog();
    return this.startVoiceDialog({});
  }

  /**
   * 注册 / 注销全局「按键说话」。
   *
   * 默认 `config.voice.ptt.globalKey` 为空 = **不注册任何全局键**（不替用户平白占用按键）；
   * 想用的人在「语音聊天设置」里点一下自己按一个键，值存进 `settings.voice.ptt.globalKey`。
   * 注册失败（键已被别的程序占用 / Electron 不认这个语法）**如实回报**给设置窗 ——
   * 不能让用户"设了却没反应"。
   * @returns {{ok:boolean, accelerator:string}} accelerator = 实际生效的键（空 = 未注册）
   */
  applyPttShortcut() {
    const prefs = normalizeVoicePrefs(this.store.get().voice);
    const desired = (prefs ? prefs.ptt.globalKey : '') || (CFG.voice.ptt && CFG.voice.ptt.globalKey) || '';
    if (desired === this.pttAcc) return { ok: true, accelerator: this.pttAcc };   // 没变 → 不动（避免重复注册）
    if (this.pttAcc) {
      try { globalShortcut.unregister(this.pttAcc); } catch { /* 已注销 */ }
      this.pttAcc = '';
    }
    if (!desired) return { ok: true, accelerator: '' };
    let ok = false;
    try { ok = globalShortcut.register(desired, () => this.toggleVoiceByKey()); }
    catch (e) { log('ptt register failed', e && e.message); ok = false; }
    if (ok) this.pttAcc = desired;
    return { ok, accelerator: ok ? desired : '' };
  }

  /**
   * 启动语音服务：放行 media 权限（**不放行 getUserMedia 会被直接 reject**）→
   * 找模型（缺则整体优雅隐藏，不崩不卡）→ 建隐藏的识别进程 → 预热。
   * 语音是"可选增强"：任何一步失败都只影响语音本身。
   */
  startVoice() {
    if (this.voice) return this.voice;           // 已有实例 → 复用（幂等）
    if (!CFG.voice.enabled) return null;
    try {
      this.voice = new VoiceService(this);
      this.voice.installPermissionHandler();
      // ★ 顺序：**先注册事件转发，再 init()**。
      //   反过来的话，识别进程万一极快回报（页面被缓存、事件恰好比监听器先到），
      //   那次 asr:ready 会被丢掉 → 之后永远 not-ready（属于"偶发、难以复现"的坑）。
      //   识别进程 → 主进程统一从 asr:event 进（单一入口，便于排查）。
      //   只注册一次：重复注册会让同一个事件被分发多次（判断用独立标记，别跟"实例是否存在"混在一起，
      //   否则实例被销毁后就再也补不回来了）。
      if (!this._asrEventBound) {
        this._asrEventBound = true;
        ipcMain.on('asr:event', (_e, msg) => {
          if (!this.voice || !msg) return;
          // 返回 Promise（handleFinal 会返回）→ 自检/测试可以 await 一轮对话真的走完
          try { return this.voice.onAsrMessage(msg.channel, msg.payload); }
          catch (e) { log('asr event failed', msg.channel, e && e.message); }
        });
      }
      this.voice.init();
      log('voice service started');
    } catch (e) {
      this.voice = null;
      log('voice service failed to start', e && e.message);
    }
    // 全局按键说话（PTT）：**开机即注册**。
    // ★ 别退回到"只在设置窗点保存那一刻才注册"—— 那样重启就失效、用户按了毫无反应
    //   （2026-09-15 踩过的旧缺陷）。
    try { this.applyPttShortcut(); } catch (e) { log('ptt shortcut init failed', e && e.message); }
    return this.voice;
  }

  /**
   * 惰性自愈入口：任何"要用语音"的地方先过一下这里。
   *
   * 存在的理由：如果启动接线因为任何原因没生效（漏调用、启动期异常被吞、热重载…），
   * 用户的第一次点击就应当把它补起来，而不是永久停在"引擎没准备好"。
   * 属于三层自愈的第一层：①惰性补启（本方法）→ ②卡住重建（VoiceService.ensureReady）
   * → ③崩溃重启（VoiceService.onAsrCrash，3 次/10 分钟上限）。
   */
  ensureVoiceService() {
    if (!this.voice) this.startVoice();
    return this.voice;
  }

  englishDir() { return path.join(this.userDataRoot, 'english'); }

  /** 读取某难度的词书（words.<level>.json，带内存缓存）；缺失/损坏返回 null（UI 显示“该难度暂无数据”）。 */
  loadEnglishBook(level) {
    if (!CFG.english.levels.some((l) => l.id === level)) return null;
    if (this._englishBooks[level]) return this._englishBooks[level];
    try {
      const file = path.join(this.englishDir(), `words.${level}.json`);
      if (!fs.existsSync(file)) return null;
      const book = JSON.parse(fs.readFileSync(file, 'utf8'));
      this._englishBooks[level] = book;
      return book;
    } catch (e) {
      log('english book load failed:', level, e && e.message);
      return null;
    }
  }

  loadEnglishProgress() {
    try {
      const file = path.join(this.englishDir(), 'progress.json');
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  }

  /** SRS 进度原子写盘（tmp + rename，与 store.js 同一策略）。 */
  saveEnglishProgress(progress) {
    if (!progress || typeof progress !== 'object') return false;
    try {
      const dir = this.englishDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'progress.json');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(progress), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      log('english progress save failed:', e && e.message);
      return false;
    }
  }

  /** 桌宠催背：按用户设置的间隔（prefs.reminderMin，0=关）弹气泡，只报当天剩余量。 */
  scheduleEnglishReminder() {
    if (this.englishRemindTimer) { clearTimeout(this.englishRemindTimer); this.englishRemindTimer = 0; }
    const prefs = this.store.get().english || {};
    const min = Number.isFinite(prefs.reminderMin) ? prefs.reminderMin : CFG.english.reminder.defaultMin;
    if (!min) return; // 用户关闭催背
    this.englishRemindTimer = setTimeout(() => {
      this.englishRemindTimer = 0;
      try { this.englishReminderTick(); } catch (e) { log('english reminder failed:', e && e.message); }
      this.scheduleEnglishReminder();
    }, min * 60 * 1000);
  }

  englishReminderTick() {
    const h = new Date().getHours();
    if (h < CFG.english.reminder.quietHourStart || h >= CFG.english.reminder.quietHourEnd) return;
    const prefs = this.store.get().english || {};
    const book = this.loadEnglishBook(prefs.level || CFG.english.defaultLevel);
    if (!book || !Array.isArray(book.words)) return;
    const q = englishM.buildVocabQueue(
      englishM.normalizeProgress(this.loadEnglishProgress()),
      book.words, Date.now(), { dailyNew: prefs.dailyNew, ratio: prefs.ratio }
    );
    const left = q.reviewLeft + q.newLeft;
    if (left <= 0) return; // 今日已清空就不打扰
    const text = CFG.english.reminder.template
      .replace('{total}', String(left))
      .replace('{review}', String(q.reviewLeft))
      .replace('{new}', String(q.newLeft));
    this.showIfHidden();
    this.send('bubble:reminder', { text, ms: CFG.english.reminder.durationMs });
  }

  /**
   * 处理一句聊天输入（文字）：交给编排器 → ChatEngine（默认 rule = 关键词规则）。
   *  命中 → 回复 + 主窗气泡；未命中 → 模拟被点击（Q 弹 + 情绪变化）。
   *  签名与返回值与迁移前**完全一致**（旧聊天窗协议无需改动）。
   *
   * ★ 2026-09-16 起主进程是聊天记录的**唯一持有者**：这里负责把"我说的那句 + 桌宠的回复"
   *   都写进记录并推给聊天窗（渲染层不再自己 append，否则记录与界面会各说各话）。
   */
  chatSend(text) {
    const input = String(text == null ? '' : text).slice(0, 500);
    if (input.trim()) this.pushChatMessage(input, 'me');
    return this.chatHandle(input, 'text');
  }

  /** 语音识别结果入口：与文字**同源**，唯一差别是 channel —— 这就是 ASR 与聊天系统的全部接缝。 */
  voiceFinal(text) {
    return this.chatHandle(text, 'voice');
  }

  chatHandle(text, channel) {
    const input = String(text == null ? '' : text).slice(0, 500);
    if (!input.trim()) return { ok: false, matched: false, reply: null };
    // ★ 新的一句到来 → 取消上一句还在路上的请求（最新优先）：否则大模型的慢回复会插队/串味
    this.abortLlmInflight('superseded');
    const ctrl = new AbortController();
    this.llmInflight = ctrl;
    this.sendChatBusy(true);
    const p = this.orchestrator.handle(chatM.makeRequest({ channel, text: input, signal: ctrl.signal }));
    return Promise.resolve(p).then((r) => {
      this.narrateChatResult(r);
      return r;
    }).finally(() => {
      if (this.llmInflight === ctrl) this.llmInflight = null;
      this.sendChatBusy(false);
    });
  }

  /**
   * 把这一轮"聊天窗该看到的内容"推给窗口并落记录 —— **统一在这里产生，渲染层只负责渲染**。
   * 为什么集中：以前文字路径靠渲染层自己 append（用 invoke 的返回值）、语音路径靠主进程推，
   * 两条路并存；一旦记录要持久化，就必然出现"界面有、记录没有"的不一致。
   */
  narrateChatResult(r) {
    if (!r || !r.ok) return;
    if (r.matched && r.reply) {
      this.pushChatMessage(r.reply, 'pet');
    } else if (!r.matched) {
      // 没命中规则 / 模型没话可说 → 与旧界面一致的那句轻提示
      this.pushChatMessage(CFG.chat.strings.missNotice, 'sys');
    }
    // 回落说明（大模型失败）也写进记录，方便日后回看"当时为什么变笨了"
    if (r.meta && r.meta.degradedFrom) {
      this.pushChatMessage(`（大模型调用失败：${this.fallbackReasonText(r.meta.fallbackReason)}；已用本地规则兜底）`, 'sys');
    }
  }

  /** 回落原因码 → 一句人话（文案表在 config.chat.strings.fallbackReasons）。 */
  fallbackReasonText(code) {
    const M = (CFG.chat.strings && CFG.chat.strings.fallbackReasons) || {};
    return M[code] || code || '未知原因';
  }

  /**
   * 把一条聊天消息**记进记录并推给聊天窗** —— 主进程是聊天记录的唯一写入方（见 chatLog.js）。
   * who：'pet'（桌宠说的话）| 'me'（我说的那句：打字或语音识别）| 'sys'（系统提示）。
   * @param {{noRecord?:boolean}} [opts] noRecord = 只推给界面、不落盘（用于极少数一次性提示）
   */
  pushChatMessage(text, who, opts) {
    const t = String(text || '');
    if (!t) return;
    const w = (who === 'pet' || who === 'me') ? who : 'sys';
    if (this.chatLog && !(opts && opts.noRecord)) this.chatLog.append(w, t);
    if (this.chatWin && !this.chatWin.isDestroyed()) {
      this.chatWin.webContents.send('chat:message', { text: t, who: w });
    }
  }

  /**
   * 聊天窗打开时拉取记录（持久化在 data/ 之外，见 config.chat.logFile）。
   * 开场白**只在记录为空时**写入一条 —— 旧实现每开一次窗就 append 一次，
   * 记录一持久化就会堆满重复问候。
   */
  chatHistoryLoad() {
    if (!this.chatLog) return { entries: [], greeting: null, status: null };
    let entries = this.chatLog.entries();
    let greeting = null;
    if (!entries.length) {
      greeting = String(CFG.chat.strings.opening || '');
      if (greeting) { this.chatLog.append('pet', greeting); entries = this.chatLog.entries(); }
    }
    return { entries, greeting, status: this.chatLog.status() };
  }

  /** 清空聊天记录（设置窗按钮）。清完广播一次，让开着的聊天窗立刻变空。 */
  chatHistoryClear() {
    if (!this.chatLog) return { ok: false, code: 'no-log', entries: [] };
    const r = this.chatLog.clear();
    if (this.chatWin && !this.chatWin.isDestroyed()) this.chatWin.webContents.send('chat:history:cleared', {});
    return { ...r, entries: this.chatLog.entries() };
  }

  /** 聊天记录现状（给设置窗显示"存了多少条、存在哪"）。 */
  chatLogStatus() {
    return this.chatLog ? this.chatLog.status() : null;
  }

  /**
   * 语音状态广播：**宠物窗**（"在听"标识 + 电平条）与**聊天窗**（"正在输入"显示）都要收到。
   * 之前只发了宠物窗 —— 于是用户在聊天窗说话时看不到任何反馈，这是本轮补的缺口。
   */
  voiceBroadcast(channel, payload) {
    this.send(channel, payload);
    if (this.chatWin && !this.chatWin.isDestroyed()) this.chatWin.webContents.send(channel, payload);
    if (this.voiceSettingsWin && !this.voiceSettingsWin.isDestroyed()) this.voiceSettingsWin.webContents.send(channel, payload);
  }

  chatRuleAdd(rule) {
    const keyword = rule && typeof rule.keyword === 'string' ? rule.keyword.trim().slice(0, 100) : '';
    const reply = rule && typeof rule.reply === 'string' ? rule.reply.slice(0, 500) : '';
    if (!keyword || !reply) return { ok: false, rules: this.store.get().chatRules || [] };
    const rules = (this.store.get().chatRules || []).filter((r) => r.keyword !== keyword);
    rules.push({ keyword, reply });
    this.store.update({ chatRules: rules }).saveNow();
    this.chatRulesChanged();
    return { ok: true, rules };
  }

  chatRuleRemove(keyword) {
    const rules = (this.store.get().chatRules || []).filter((r) => r.keyword !== keyword);
    this.store.update({ chatRules: rules }).saveNow();
    this.chatRulesChanged();
    return { ok: true, rules };
  }

  chatRulesChanged() {
    const payload = { rules: this.store.get().chatRules || [] };
    if (this.chatSettingsWin && !this.chatSettingsWin.isDestroyed()) {
      this.chatSettingsWin.webContents.send('chatRules:changed', payload);
    }
    if (this.chatWin && !this.chatWin.isDestroyed()) this.chatWin.webContents.send('chatRules:changed', payload);
  }

  /* ---------------- LLM（大模型引擎：密钥文件 / 偏好 / 连通性 / 请求日志） ---------------- */

  /**
   * 把运行期环境注入 llm 引擎。`shared/chat/llm.js` 属于 shared 层（不碰 Electron/store/密钥文件），
   * 所以密钥、"偏好"、日志出口、流式回调都由这里注入。
   * 触发时机：启动 / 保存偏好 / 保存或清除密钥 —— 每次都要重注入，否则 available() 不会变。
   */
  configureLlm() {
    try {
      llmM.configure({
        prefs: (this.store.get().chatEngine || {}).llm || null,
        getApiKey: () => this.readLlmKey(),
        onLog: (entry) => this.pushLlmLog(entry),
        onDelta: (acc) => this.streamBubble(acc),
      });
    } catch (e) { log('configureLlm failed', e && e.message); }
  }

  /**
   * 取密钥：独立的密钥文件优先，其次环境变量（config 里 `apiKeyEnv` 存的是**变量名**）。
   * ⚠ 只在主进程内使用；调用方（llm 引擎）只拿它拼 Authorization 头，绝不写日志。
   */
  readLlmKey() {
    let key = '';
    try { if (this.llmSecret) key = this.llmSecret.get() || ''; } catch { key = ''; }
    if (!key) {
      const envName = (llmM.llmConfig() || {}).apiKeyEnv;
      if (envName && process.env[envName]) key = String(process.env[envName]);
    }
    return key;
  }

  /**
   * 「打开密钥文件位置」（设置面板按钮）：
   * 已保存过 → 在资源管理器里选中该文件；还没保存过 → 先建出目录再打开（否则打不开不存在的路径）。
   * ⚠ 不返回也不读取密钥内容 —— 只是把用户带到他自己的文件面前。
   */
  async revealLlmKeyFile() {
    if (!this.llmSecret) return { ok: false, code: 'no-store' };
    const st = this.llmSecret.status();
    try {
      if (st.stored && fs.existsSync(st.path)) {
        shell.showItemInFolder(st.path);
        return { ok: true, code: 'revealed', path: st.path, dir: st.dir };
      }
      fs.mkdirSync(st.dir, { recursive: true });
      const err = await shell.openPath(st.dir);
      return { ok: !err, code: err ? 'open-failed' : 'opened-dir', path: st.path, dir: st.dir, detail: err || '' };
    } catch (e) {
      return { ok: false, code: 'io', detail: (e && e.message) || '' };
    }
  }

  /**
   * 流式增量 → 宠物窗气泡"打字机"。
   * 复用既有 `bubble:chat` 通道（文字不断变长就是逐字出现），因此**渲染层无需新增任何代码**；
   * 增量节流由 llm.js 按 config.voice… 的 `streamDeltaMs` 控制，避免 IPC 洪水。
   */
  streamBubble(text) {
    const t = String(text || '');
    if (!t) return;
    this.send('bubble:chat', { text: t, ms: CFG.chat.bubbleDurationMs });
  }

  /** 请求日志（环形缓冲 50 条）+ 实时推给设置面板的「请求日志」区。 */
  pushLlmLog(entry) {
    const e = { ts: Date.now(), ...(entry || {}) };
    this.llmLog.unshift(e);
    if (this.llmLog.length > 50) this.llmLog.length = 50;
    const w = this.chatSettingsWin;
    if (w && !w.isDestroyed()) w.webContents.send('llm:log:appended', e);
  }

  /** 取消进行中的请求（用户点「停止」/ 新的一句到来 / 退出）。 */
  abortLlmInflight(reason) {
    const c = this.llmInflight;
    if (!c) return false;
    this.llmInflight = null;
    try { c.abort(); } catch { /* 已结束 */ }
    log('llm request aborted:', reason || 'user');
    return true;
  }

  /** 请求进行中 → 通知聊天窗显示「停止」按钮（渲染层会延迟 250ms 才显示，避免规则引擎一闪而过）。 */
  sendChatBusy(busy) {
    const w = this.chatWin;
    if (w && !w.isDestroyed()) w.webContents.send('chat:busy', { busy: !!busy });
  }

  /** 保存 LLM 偏好（白名单 + 夹取走 content.normalizeLlmPrefs；**密钥不在此**）。 */
  setLlmPrefs(raw) {
    const cur = this.store.get().chatEngine || {};
    const llm = normalizeLlmPrefs(raw);
    this.store.update({ chatEngine: { active: cur.active || CFG.chatEngine.active, llm } }).saveNow();
    this.configureLlm();
    return { ok: true, ...this.llmStatus() };
  }

  /** 设置面板需要的现状：偏好 + 预设 + 密钥状态（**永不回密钥本身**）+ 引擎清单 + 最近日志。 */
  llmStatus() {
    const cur = this.store.get().chatEngine || {};
    const secret = this.llmSecret
      ? this.llmSecret.status()
      : { stored: false, exists: false, source: 'none', path: '', dir: '', error: '' };
    const cfg = llmM.llmConfig() || {};
    const envName = cfg.apiKeyEnv || '';
    const envSet = !!(envName && process.env[envName]);
    const engines = chatM.listEngines();
    const llmInfo = engines.find((e) => e.id === 'llm') || null;
    return {
      prefs: normalizeLlmPrefs(cur.llm),
      presets: Array.isArray(cfg.presets) ? cfg.presets : [],
      key: {
        stored: secret.stored,                // 密钥文件已存在且能解析出密钥
        exists: secret.exists,                // 文件是否存在（存在但解析不出 → 用户改坏了）
        source: secret.source,                // 'file'（本机密钥文件）| 'none'
        path: secret.path,                    // ★ 密钥文件的绝对路径（明文文件，可手改）
        dir: secret.dir,
        // 该路径**必须**在便携目录之外（否则把文件夹拷走就把密钥一起带走了）
        outsidePortable: !isInsideDir(this.userDataRoot, secret.path),
        error: secret.error || '',            // '' | 'io' | 'empty-file'
        envName,
        envSet,
        configured: secret.source !== 'none' || envSet,
      },
      engines,
      active: cur.active || CFG.chatEngine.active,
      llmAvailable: !!(llmInfo && llmInfo.available),
      unavailableReason: llmM.unavailableReason(),
      logs: this.llmLog.slice(0, 50),
    };
  }

  /** 「测试连接」：一次最小请求，返回明确分类（成功/密钥错/地址错/模型不存在/网络不可达/超时）。 */
  async llmTest() {
    return llmM.probe();
  }

  /**
   * 切换聊天引擎：id 必须命中 ChatEngine 注册表，否则回退 config 默认（rule）。
   * 注意：**这里不拦"不可用的引擎"**——llm 允许被选中，由 selectEngine 在每次发送时
   * 判定 available() 并自动回落 rule（用户没填密钥也不会让桌宠"哑巴"）。
   * ★ 必须把 llm 偏好一起写回，否则"切一下引擎"就会把用户填的 base_url/模型/人设挤掉。
   */
  setChatEngine(id) {
    const ids = chatM.listEngines().map((e) => e.id);
    const fallback = (CFG.chatEngine && CFG.chatEngine.active) || 'rule';
    const active = ids.includes(String(id)) ? String(id) : fallback;
    const cur = this.store.get().chatEngine || {};
    this.store.update({ chatEngine: { active, llm: normalizeLlmPrefs(cur.llm) } }).saveNow();
    return { ok: true, active };
  }

  /* ---------------- 托盘 ---------------- */

  createTray() {
    const icon = this.makeTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip(PET_NAME);
    this.tray.on('double-click', () => this.showWindow());
    this.rebuildTray();
  }

  makeTrayIcon() {
    // 程序内绘制 16x16 圆点（不依赖外部图片文件）
    const bmp = [];
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const dx = x - 7.5, dy = y - 7.5;
        const d = Math.sqrt(dx * dx + dy * dy);
        const a = d <= 7 ? 255 : d <= 8 ? 200 : 0;
        bmp.push(0, 140, 220, a); // BGRA
      }
    }
    const img = nativeImage.createFromBitmap(Buffer.from(bmp), { width: 16, height: 16 });
    return img.resize({ width: 16, height: 16 });
  }

  rebuildTray() {
    if (!this.tray) return;
    const self = this;
    const menu = Menu.buildFromTemplate([
      { label: this.visible ? '隐藏宠物' : '显示宠物', click: () => { if (self.visible) self.hideWindow(); else self.showWindow(); } },
      {
        label: this.locked ? '解锁（保底入口）' : '锁定并保持始终置于顶层',
        click: () => self.setLocked(!self.locked),
      },
      {
        label: '窗口顶沿吸附', type: 'checkbox', checked: this.store.get().snapEnabled !== false,
        click: (item) => {
          const v = !!item.checked;
          this.store.update({ snapEnabled: v }).saveSoon();
          if (self.win && !self.win.isDestroyed()) self.win.webContents.send('snap:enabled', { enabled: v });
        },
      },
      {
        label: '物理模拟（甩动/坠落）', type: 'checkbox', checked: this.store.get().physicsEnabled !== false,
        click: (item) => {
          const v = !!item.checked;
          this.store.update({ physicsEnabled: v }).saveSoon();
          if (self.win && !self.win.isDestroyed()) self.win.webContents.send('physics:enabled', { enabled: v });
        },
      },
      { type: 'separator' },
      {
        label: '主菜单…',
        click: () => {
          this.showIfHidden();
          if (self.win && !self.win.isDestroyed()) setTimeout(() => self.popupMainMenu(), 80);
        },
      },
      { label: '活动区域设置…', click: () => { this.showIfHidden(); if (self.win && !self.win.isDestroyed()) self.win.webContents.send('ui:openRegionEditor'); } },
      { type: 'separator' },
      { label: '退出', click: () => self.quit() },
    ]);
    this.tray.setContextMenu(menu);
    this._trayMenuItems = menu.items.map((i) => i.label); // 供 UI 场景断言托盘文本
  }

  // 发送渲染层可执行的动作 / 事件（窗口可能隐藏 → 先显示）
  send(name, ...args) {
    if (this.visible && this.win && !this.win.isDestroyed()) this.win.webContents.send(name, ...args);
  }
  showIfHidden() { if (!this.visible) this.showWindow(); }

  act(type, payload) { this.showIfHidden(); this.send('pet:action', payload ? { type, ...payload } : { type }); }

  /* --------- 主菜单文本/可见性（config.js 可定制；item 加 visible:false 即隐藏该项） --------- */

  menuLabel(id) {
    const def = CFG.menu.items[id];
    return def ? def.label : id;
  }

  menuVisible(id) {
    const it = CFG.menu.items[id];
    if (!it) return false; // 未登记的 id 不显示
    return it.visible !== false;
  }

  /** 组装一个主菜单项；该项被隐藏时返回 null（隐藏后菜单里彻底消失，功能逻辑不受影响）。 */
  menuItem(id, extra = {}) {
    if (!this.menuVisible(id)) return null;
    return { id, label: this.menuLabel(id), ...extra };
  }

  /* ---------------- Phase 4：原生主菜单 / 音乐 / 背景 ---------------- */

  popupMainMenu() {
    if (!this.win || this.win.isDestroyed()) return;
    this.showIfHidden();
    const self = this;
    const template = this.buildMainMenuTemplate();
    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: this.win,
      // 菜单关闭（选了某项 / 点了菜单外）后通知渲染层清理残留的按键/手势态，
      // 避免“选完任意菜单项人物被吸到鼠标位置”（bug #5）。
      callback: () => {
        if (self.win && !self.win.isDestroyed()) self.win.webContents.send('menu:closed');
      },
    });
  }

  /**
   * 组装主菜单模板（**不弹窗**，纯结构）。
   * 拆出来有两个好处：① 菜单结构可被自动化断言（native 菜单本身没法查）② 便于排查"某项没出现"。
   * 菜单结构（2026-09-14 起）：休息 / 喂食 / 待办… / 聊天▸(聊天·聊天设置·语音聊天设置…) /
   * 学习▸(学英语·番茄钟·学习计划表) / 音乐▸ / 背景▸ / 切换状态▸ / 重置状态 / 退出。
   */
  buildMainMenuTemplate() {
    const self = this;
    const st = this.store.get();
    const playlist = st.playlist || [];
    const bg = st.background;
    const bgOpacityPct = bg && typeof bg.opacity === 'number' ? Math.round(bg.opacity * 100) : null;

    // 子菜单：隐藏项过滤掉；全部隐藏时整个父项也不出现
    const chatSub = [
      self.menuItem('chatOpen', { click: () => self.openChatWindow() }),
      self.menuItem('chatSettings', { click: () => self.openChatSettingsWindow() }),
      self.menuItem('voiceSettings', { click: () => self.openVoiceSettingsWindow() }),
    ].filter(Boolean);
    // 「学习」一级菜单（2026-09-14：学英语从聊天子菜单迁到这里，并新增番茄钟 / 学习计划表）
    const learnSub = [
      self.menuItem('english', { click: () => self.openEnglishWindow() }),
      self.menuItem('pomodoro', { click: () => self.openPomodoroWindow() }),
      self.menuItem('planner', { click: () => self.openPlannerWindow() }),
    ].filter(Boolean);
    const musicSub = [
      self.menuItem('musicAdd', { click: () => self.openPicker('audio') }),
      { type: 'separator' },
      self.menuItem('musicToggle', { click: () => { self.showIfHidden(); self.send('audio:toggle'); } }),
      self.menuItem('musicNext', { click: () => { self.showIfHidden(); self.send('audio:next'); } }),
      self.menuItem('musicPrev', { click: () => { self.showIfHidden(); self.send('audio:prev'); } }),
      self.menuItem('musicStop', { click: () => { self.showIfHidden(); self.send('audio:stop'); } }),
      self.menuItem('musicClear', { click: () => self.clearPlaylist() }),
    ].filter(Boolean);
    const bgSub = [
      self.menuItem('bgPick', { click: () => self.openPicker('bg') }),
      self.menuItem('bgClear', { click: () => { self.store.updateDeep('background', { path: null, opacity: self.bgOpacityNow() }).saveSoon(); self.send('bg:clear'); } }),
      { type: 'separator' },
      self.menuItem('bgOp25', { type: 'radio', checked: bgOpacityPct === 25, click: () => self.send('bg:opacity', { opacity: 0.25 }) }),
      self.menuItem('bgOp50', { type: 'radio', checked: bgOpacityPct === 50, click: () => self.send('bg:opacity', { opacity: 0.5 }) }),
      self.menuItem('bgOp75', { type: 'radio', checked: bgOpacityPct === 75, click: () => self.send('bg:opacity', { opacity: 0.75 }) }),
      self.menuItem('bgOp100', { type: 'radio', checked: bgOpacityPct === 100, click: () => self.send('bg:opacity', { opacity: 1 }) }),
    ].filter(Boolean);
    const stateSub = [
      // 两个单选项直达目标形态（勾选态 = 渲染层回传的当前形态）
      self.menuItem('stateMain', { type: 'radio', checked: !self.stateVisualOn, click: () => self.send('state:visual', { useState: false }) }),
      self.menuItem('stateAlt', { type: 'radio', checked: !!self.stateVisualOn, click: () => self.send('state:visual', { useState: true }) }),
    ].filter(Boolean);

    return [
      self.menuItem('rest', { click: () => self.act('rest') }),
      self.menuItem('feed', { click: () => self.act('feed') }),
      self.menuItem('todo', { click: () => self.openTodoWindow() }),
      chatSub.length ? self.menuItem('chat', { submenu: chatSub }) : null,
      learnSub.length ? self.menuItem('learn', { submenu: learnSub }) : null,
      musicSub.length
        ? { id: 'music', label: `${self.menuLabel('music')}${playlist.length ? `（${playlist.length}）` : ''}`, submenu: musicSub }
        : null,
      bgSub.length
        ? { id: 'bg', label: `${self.menuLabel('bg')}${bg && bg.path ? '（已设置）' : ''}`, submenu: bgSub }
        : null,
      stateSub.length ? self.menuItem('state', { submenu: stateSub }) : null,
      self.menuItem('resetStatus', { click: () => self.act('resetStatus') }),
      // 「更换宠物…」已移除（"换图即定制"：素材替换走素材根目录）
      { type: 'separator' },
      self.menuItem('quit', { click: () => self.quit() }),
    ].filter(Boolean);
  }

  bgOpacityNow() {
    const s = this.store.get();
    return s.background && typeof s.background.opacity === 'number' ? s.background.opacity : CFG.ui.bgDefaultOpacity;
  }

  /** 把音频源文件拷贝进 assets 并追加到播放列表；返回真正加上的数量。 */
  addAudioTracks(paths) {
    if (!paths || !paths.length) return 0;
    const tracks = [];
    for (const p of paths) {
      if (!p || !fs.existsSync(p)) continue;
      const dest = this.copyIntoAssets(p, 'audio');
      tracks.push({ path: this.relDataPath(dest), name: path.basename(p) });
    }
    if (!tracks.length) return 0;
    const prev = this.store.get().playlist || [];
    const next = prev.slice();
    for (const t of tracks) if (!next.some((x) => x.path === t.path)) next.push(t);
    this.store.update({ playlist: next }).saveNow();
    this.showIfHidden();
    this.send('audio:list', { playlist: next });
    return tracks.length;
  }

  clearPlaylist() {
    this.store.update({ playlist: [] }).saveNow();
    this.showIfHidden();
    this.send('audio:list', { playlist: [] });
  }

  /* ===== 应用内图片选择器（换宠/背景），绕开这台机器上失灵的原生对话框 ===== */

  openPicker(kind) {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    const wasLocked = this.locked;
    if (wasLocked) {
      // 选择器是明确的手动交互任务 → 若处于锁定态先解锁（恢复正常置顶层级与穿透），否则整窗穿透点不到面板
      this.setLocked(false);
    }
    this.showIfHidden();
    const wc = w.webContents;
    const k = kind === 'audio' ? 'audio' : 'bg'; // 换宠已移除：选择器只余 背景/音乐 两种
    wc.send('ui:openPicker', { kind: k });
  }

  /** 给应用内选择器的快捷入口：桌面/图片/下载/已上传/主目录（都存在才列出）。 */
  pickerRoots() {
    const out = [];
    const seen = new Set();
    const push = (label, p) => {
      if (!p || seen.has(String(p).toLowerCase())) return;
      try { if (!fs.statSync(p).isDirectory()) return; } catch { return; }
      seen.add(String(p).toLowerCase());
      out.push({ label, path: p });
    };
    push('桌面', app.getPath('desktop'));
    push('图片', app.getPath('pictures'));
    push('下载', app.getPath('downloads'));
    push('已上传图片', this.assetsDir);
    push('主目录', app.getPath('home'));
    return out;
  }

  /** 列某文件夹下的文件：kind='audio' 列音乐扩展名，否则列图片扩展名；按名字排序。 */
  pickerListFiles(arg) {
    const dir = typeof arg === 'string' ? arg : (arg && arg.dir) || '';
    const isAudio = !!(arg && arg.kind === 'audio');
    // 素材根目录是应用核心素材（防误改）：应用内不提供浏览入口（开发者用文件管理器访问）。
    const norm = (p) => path.resolve(String(p)).toLowerCase();
    const root = norm(this.petRoot);
    if (root && (norm(dir) === root || norm(dir).startsWith(root + path.sep))) {
      return { ok: false, error: '这是应用素材根目录，请在文件管理器中查看' };
    }
    try {
      if (!dir || typeof dir !== 'string' || !fs.statSync(dir).isDirectory()) {
        return { ok: false, error: '不是有效的文件夹' };
      }
      const exts = isAudio ? AUDIO_EXTS : IMG_EXTS;
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name)
        .filter((n) => exts.has(path.extname(n).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .map((name) => ({ name, path: path.join(dir, name) }));
      return { ok: true, dir, files };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  showWindow() {
    this.visible = true;
    this.store.update({ visible: true }).saveSoon();
    if (this.win && !this.win.isDestroyed() && !this.win.isVisible()) this.win.show();
    this.win && this.win.webContents.send('app:visibility', { visible: true });
    this.rebuildTray();
  }

  hideWindow() {
    this.visible = false;
    this.store.update({ visible: false }).saveSoon();
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    this.win && this.win.webContents.send('app:visibility', { visible: false });
    this.rebuildTray();
  }

  /**
   * 退出前把宠物窗里"最新"的状态快照要回来 —— 渲染层每 CFG.status.persistIntervalMs（默认 15s）
   * 才心跳写一次盘，直接 exit 会丢掉最后最多 15 秒的互动（用户要求"恢复上次退出时保存的状态"，
   * 那就不该有这 15 秒的误差）。`window.__pet` 一直挂在宠物窗上（不只是测试模式），取只读 status 即可。
   * 加了超时保护：拿不到也不许把退出流程吊住。
   */
  async snapshotStatusFromPet() {
    if (!this.win || this.win.isDestroyed()) return null;
    try {
      const raw = await Promise.race([
        this.win.webContents.executeJavaScript(
          'JSON.stringify((window.__pet && window.__pet.status) || null)', true),
        new Promise((r) => setTimeout(() => r('null'), 400)),
      ]);
      const st = raw ? JSON.parse(raw) : null;
      return st && typeof st === 'object' ? st : null;
    } catch (e) {
      log('status snapshot failed', e && e.message);
      return null;
    }
  }

  async quit() {
    if (this.quitting) return;
    this.quitting = true;
    this.quitNow = true;
    if (this.todoTimer) { clearInterval(this.todoTimer); this.todoTimer = 0; }
    if (this.reminderTimer) { clearTimeout(this.reminderTimer); this.reminderTimer = 0; }
    if (this.voice) { try { this.voice.shutdown(); } catch { /* 退出中 */ } }
    this.abortLlmInflight('quit');   // 退出时别把在途请求吊在那儿
    // 全局键要显式注销：虽然进程退出时系统会回收，但留着不注销会让"重启后才生效"更难排查
    try { globalShortcut.unregisterAll(); } catch { /* 退出中 */ }
    // ① 状态持久化：要回最新快照再落盘（否则丢最后 ≤15 秒）
    const st = await this.snapshotStatusFromPet();
    if (st) this.store.update({ status: st });
    this.store.flush();
    app.exit(0);
  }

  /* ---------------- 场景（UI 自动化） ---------------- */

  async runScenario(name) {
    const label = `SCENARIO ${name}`;
    try {
      const { scenarios } = require('./uiScenarios');
      const sc = scenarios[name];
      if (!sc) throw new Error(`未知场景: ${name}（可用: ${Object.keys(scenarios).join(', ')}）`);
      // 等待渲染层就绪 + 宠物就位（场景内还会自行等待）
      const deadline = Date.now() + 12000;
      while (!this.pageLoaded && Date.now() < deadline && !this.quitNow) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!this.pageLoaded) throw new Error('页面加载超时');
      await new Promise((r) => setTimeout(r, 1200)); // 让 renderer init 走完

      const wc = this.win.webContents;
      const ctx = {
        js: (expr) => wc.executeJavaScript(expr),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        // 主进程侧状态（锁定层级/托盘文本/持久化数据），供新功能场景断言
        mainState: () => ({
          locked: this.locked,
          lockLevel: this.lockLevel,
          trayLabels: this._trayMenuItems || [],
          todos: this.store.get().todos,
          chatRules: this.store.get().chatRules,
          chatEngine: this.store.get().chatEngine,
          pomodoro: this.store.get().pomodoro,
          planner: this.store.get().planner,
          voice: this.store.get().voice,
          voiceAvailable: !!(this.voice && this.voice.status().available),
          visible: this.visible,
        }),
        // 主菜单结构（不弹窗）：{ id: [子项 id…] } 只含子菜单；便于断言"学习"一级菜单已就位
        mainMenu: () => this.buildMainMenuTemplate()
          .map((i) => ({ id: i.id, label: i.label, children: (i.submenu || []).map((c) => c.id).filter(Boolean) })),
        // 主进程动作（菜单项等价路径）
        checkDueTodos: () => this.checkDueTodos(),
        triggerReminderNow: () => this.triggerReminderNow(),
        openTodo: () => this.openTodoWindow(),
        openChat: () => this.openChatWindow(),
        openChatSettings: () => this.openChatSettingsWindow(),
        openEnglish: () => this.openEnglishWindow(),
        openPomodoro: () => this.openPomodoroWindow(),
        openPlanner: () => this.openPlannerWindow(),
        openVoiceSettings: () => this.openVoiceSettingsWindow(),
        // 语音可视化（不依赖麦克风/模型）：由主进程直接广播 + 推消息，用来断言聊天窗的"正在输入"显示
        voiceBroadcast: (channel, payload) => this.voiceBroadcast(channel, payload),
        pushChatMessage: (text, who) => this.pushChatMessage(text, who),
        // 直接在宠物窗弹一条气泡（用于断言"气泡与语音提示条不重叠"这类纯视觉规则）
        bubble: (text, ms) => this.send('bubble:chat', { text, ms }),
        // 独立窗口驱动（待办/聊天）
        waitForWin: (name, timeoutMs = 8000) => this.waitForScenarioWin(name, timeoutMs),
        execIn: (name, expr) => {
          const w = this[name];
          if (!w || w.isDestroyed()) throw new Error(`窗口未打开: ${name}`);
          return w.webContents.executeJavaScript(expr);
        },
      };
      const passed = await sc(ctx);
      const errCount = this.consoleErrors.length;
      console.log(`${label} ${passed ? 'PASS' : 'FAIL'} consoleErrors=${errCount}`);
      app.exit(passed && errCount === 0 ? 0 : 1);
    } catch (e) {
      console.error(label, 'FAIL', e && e.message ? e.message : e);
      app.exit(1);
    }
  }

  /* ---------------- 冒烟 ---------------- */

  /** UI 场景驱动：等待某个独立窗口（todoWin/chatWin…）创建且页面可执行 JS。 */
  async waitForScenarioWin(name, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const w = this[name];
      if (w && !w.isDestroyed()) {
        try { await w.webContents.executeJavaScript('1'); return true; } catch { /* 页面尚未就绪 */ }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待窗口超时: ${name}`);
  }

  async runSmoke() {
    try {
      // 等待页面加载完成
      const deadline = Date.now() + 15000;
      while (!this.pageLoaded && Date.now() < deadline && !this.quitNow) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const wc = this.win.webContents;
      setTimeout(async () => {
        try {
          const res = await wc.executeJavaScript(`(() => {
            const s = window.__petState ? window.__petState() : null;
            return { ready: !!window.__petReady, errors: window.__petErrors || 0,
                     petLoaded: !!(s && s.petLoaded), pet: s && s.pet ? { w: s.pet.w, h: s.pet.h } : null,
                     // 内置素材装载（config 默认路径 → 渲染层相对路径直读）：
                     fxGroups: s ? s.fxAnim.groups : -1, blinkBody: !!(window.__pet && window.__pet.blinkBody) };
          })()`);
          const errCount = this.consoleErrors.length + (res.errors || 0);
          console.log(`[smoke] rendererReady=${res.ready} petLoaded=${res.petLoaded} pet=${JSON.stringify(res.pet)} fxGroups=${res.fxGroups} blinkBody=${res.blinkBody} consoleErrors=${errCount} region=${JSON.stringify(this.region)}`);
          // fxGroups/blinkBody：config 默认素材（含“动画素材/”中文相对路径）必须能装载，
          // 否则等于“配置写了但不生效”（手册 #7）。
          const ok = res.ready && errCount === 0 && (process.env.PET_PET_PATH ? res.petLoaded : true) &&
            res.fxGroups > 0 && res.blinkBody;
          console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL');
          app.exit(ok ? 0 : 1);
        } catch (e) {
          console.error('SMOKE_FAIL', e);
          app.exit(1);
        }
      }, 1500);
    } catch (e) {
      console.error('SMOKE_FAIL', e);
      app.exit(1);
    }
  }
}

app.whenReady().then(async () => {
  log('whenReady resolved');
  // 语音诊断模式：`npm run voice:diag`（= `electron . --voice-diag`）
  // 放在 App 里跑而不是做成独立脚本，是为了**与 App 完全同环境**：同一套 webPreferences、
  // 同一个权限处理器、同一份模型解析逻辑与 data/ 路径 —— 诊断结论才能代表真实运行。
  // ⚠ 若 shell 里带着 `ELECTRON_RUN_AS_NODE=1`（某些 IDE/宿主会注入），Electron 会退化成纯 Node，
  //   此时 `require('electron')` 只返回 npm 包的**路径字符串**、`app` 是 undefined → 跑诊断前清掉它。
  if (VOICE_DIAG) {
    try {
      const { runVoiceDiag } = require('./voiceDiag');
      const code = await runVoiceDiag({ dataDir: DATA_DIR });
      app.exit(code);
    } catch (e) {
      console.error('[voice-diag] 失败：', (e && e.stack) || e);
      app.exit(1);
    }
    return;
  }
  // 语音端到端自检（`npm run voice:e2e` = `electron . --voice-e2e`）：
  // 走**真实启动路径**（真实 PetApp.init() → startVoice() → 隐藏识别进程 → asr:ready），
  // 断言"语音服务真的被启动，并且真的就绪"。
  // 为什么需要它：单测能验证纯函数，诊断脚本能验证引擎——但**只有这条路径能验证"接线"**。
  // 2026-09-15 那次事故（init() 漏调 startVoice）就是被这条路径抓出来的。
  // 用法：PET_USERDATA=<临时目录> PET_VOICE_MODELS=<仓库>/data/voice/models [PET_NOGPU=1] \
  //       electron . --voice-e2e        → 打印 VOICE_E2E_OK / VOICE_E2E_FAIL 并以退出码表态
  if (VOICE_E2E) {
    const waitMs = Math.max(3000, Number(process.env.PET_E2E_WAIT_MS) || 20000);
    // 自检默认指向本仓库的模型目录（临时 userData 里当然没有模型副本）
    if (!process.env.PET_VOICE_MODELS) process.env.PET_VOICE_MODELS = path.join(DATA_DIR, 'voice', 'models');
    const p = new PetApp();
    try {
      await p.init();
    } catch (e) {
      console.log('[voice-e2e] init 抛异常：', (e && e.stack) || e);
      console.log('VOICE_E2E_FAIL');
      app.exit(1);
      return;
    }
    console.log('[voice-e2e] voice 服务对象 =', !!p.voice, '（false 即为本次事故的根因）');
    const deadline = Date.now() + waitMs;
    let ok = false, last = '';
    while (Date.now() < deadline) {
      const v = p.voice;
      const st = v ? v.status() : null;
      const key = st ? `${st.available}|${st.loading}|${st.reason}|${st.stage}|${st.retries}` : 'null';
      if (key !== last) {
        last = key;
        console.log(`[voice-e2e] ${new Date().toISOString().slice(11, 19)} ${JSON.stringify(st)}`);
      }
      if (st && st.available) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (ok) {
      // ★ 端到端第一步（2026-09-16 用户定调的交互）：模拟"聊天窗点 🎤"→ 应进入语音对话并开始听；
      //   再点一次 → 应退出。
      try {
        const r1 = p.startVoiceDialog();
        await new Promise((r) => setTimeout(r, 1500));
        const st2 = p.voice.status();
        console.log(`[voice-e2e] 点 🎤 后：ok=${r1 && r1.ok} dialog=${st2.dialog} state=${st2.state}（应为 dialog=true / decoding=正在听）`);
        const r2 = p.stopVoiceDialog();
        await new Promise((r) => setTimeout(r, 600));
        const st3 = p.voice.status();
        console.log(`[voice-e2e] 再点一次后：ok=${r2 && r2.ok} dialog=${st3.dialog}（应为 false）`);
      } catch (e) {
        console.log('[voice-e2e] 语音对话模拟失败：', (e && e.message) || e);
      }
      // ★ 端到端第二步（2026-09-16 晚恢复的功能）：模拟"按一下**全局键**"——
      //   应等价于点 🎤（进入对话），再按一下退出。这条能证明"注册了"且"按下去真的能用"。
      try {
        if (p.pttAcc) {
          console.log(`[voice-e2e] 已注册全局键：${p.pttAcc}`);
          p.toggleVoiceByKey();
          await new Promise((r) => setTimeout(r, 1200));
          const st4 = p.voice.status();
          console.log(`[voice-e2e] 按一下后：dialog=${st4.dialog} state=${st4.state}（应为 true / decoding）`);
          p.toggleVoiceByKey();
          await new Promise((r) => setTimeout(r, 600));
          console.log(`[voice-e2e] 再按一下后：dialog=${p.voice.status().dialog}（应为 false）`);
        } else {
          console.log('[voice-e2e] 未注册全局键（settings.voice.ptt.globalKey 为空）→ 跳过按键模拟');
        }
      } catch (e) {
        console.log('[voice-e2e] 全局键模拟失败：', (e && e.message) || e);
      }
    }
    console.log(ok ? 'VOICE_E2E_OK' : 'VOICE_E2E_FAIL');
    try { if (p.voice) p.voice.shutdown(); } catch { /* 退出中 */ }
    app.exit(ok ? 0 : 1);
    return;
  }
  // LLM 端到端自检（`npm run llm:e2e` = `electron . --llm-e2e`）：
  // 走**真实 PetApp**（真密钥文件 / 真 IPC 方法），配一个进程内 mock LLM 服务，
  // 把三批需求逐条跑一遍（连通性分类 / 后退重试 / 回落 / 取消 / 截断 / 流式）。
  // 两阶段：PET_LLM_E2E_PHASE=1 写入；=2 复用同一 userData 再启动一次（= 模拟重启，验证密钥还在）。
  if (process.argv.includes('--llm-e2e')) {
    const p = new PetApp();
    try {
      await p.init();
      const { runLlmE2e } = require('./llmE2e');
      const code = await runLlmE2e(p);
      app.exit(code);
    } catch (e) {
      console.error('[llm-e2e] 失败：', (e && e.stack) || e);
      console.log('LLM_E2E_FAIL');
      app.exit(1);
    }
    return;
  }
  const p = new PetApp();
  p.init();
}).catch((e) => {
  console.error('[main] fatal', e);
  app.exit(1);
});

// 导出 PetApp：供 `test/unit/voice-wiring.test.js` 用 electron 桩**把主进程真正 boot 一遍**
// 再断言启动接线（不建真窗口、不碰鼠标）。存在的理由见该测试文件顶部注释。
module.exports = { PetApp };

app.on('window-all-closed', (e) => {
  // 托盘常驻：不退出
});
app.on('before-quit', () => {
  // 正常退出路径（若有 store 引用由 quit() 主动 flush）
});
