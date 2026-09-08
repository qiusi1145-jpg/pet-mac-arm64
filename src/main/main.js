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
const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { CFG } = require('../shared/config');
const { computeRegion, defaultRegionSettings } = require('../shared/region');
const { findDueTodos, formatTask, normalizeTodo, pickReminderTodo, randomReminderDelay } = require('../shared/todo');
const { matchChatRule } = require('../shared/chat');
const { ov } = require('../shared/overrides');
const { Store } = require('./store');
const { WinEnum, isSystemWindow } = require('./winenum');

const PET_NAME = '桌宠';

// 便携化（"整个文件夹发到别的电脑双击即用"）：userData 固定在应用文件夹内 data/，
// 素材、settings.json、编译产物（winenum）全部跟着文件夹走，不写注册表、不依赖本机用户目录。
// 优先级：PET_USERDATA（测试隔离）> data/ 便携目录。旧版 %APPDATA%\桌宠 的数据由
// migrateLegacyPortableData() 在首次启动时一次性搬进 data/。
const APP_ROOT = app.getAppPath();            // 项目根（package.json 所在目录，随文件夹整体移动）
const DATA_DIR = path.join(APP_ROOT, 'data'); // 便携数据目录
if (process.env.PET_USERDATA) app.setPath('userData', process.env.PET_USERDATA);
else app.setPath('userData', DATA_DIR);

// 供渲染层访问进程内共享逻辑的测试开关（仅测试模式可用）
const TEST_MODE = !!(process.env.PET_TEST || process.env.PET_SMOKE || process.env.PET_SCENARIO);

const log = (...a) => { if (process.env.PET_DEBUG) console.log('[main]', ...a); };
log('main module loaded');

// 让“应用内添加音乐 → 自动播放 / 播放列表切歌”无需额外的用户手势即可出声。
// （Chromium 默认 autoplay 策略会拦掉没有 user gesture 的 Audio.play()，这里放开。）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
    // 应用内不提供浏览/修改该目录的入口；开发者用文件管理器或开发者模式维护。
    this.petRoot = path.join(this.assetsDir, 'pet');
    this.region = null;           // 屏幕坐标区域
    this.locked = false;
    this.lockLevel = 'floating';  // 当前置顶级别：锁定='screen-saver'，解锁='floating'
    this.visible = true;
    this.ignore = true;
    this.consoleErrors = [];
    this.consoleListenerAttached = false;
    this.quitNow = false;
    this.initPromise = null;
    this.todoWin = null;          // 待办清单窗口
    this.todoTimer = 0;           // 到期检查定时器
    this.remindedTodoIds = new Set(); // 已提醒过的到期待办（本次运行内不重复弹）
    this.reminderTimer = 0;       // 随机催促定时器
    this.chatWin = null;          // 聊天窗口
    this.chatSettingsWin = null;  // 聊天设置窗口
    this.stateVisualOn = false;   // 当前形态：false=主宠物图，true=状态图（渲染层回传同步）
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

    if (!app.requestSingleInstanceLock()) {
      log('single instance lock busy, quit');
      app.quit();
      return;
    }
    app.on('second-instance', () => this.showWindow());
    app.setAppUserModelId('com.deskpet.desktop');

    fs.mkdirSync(this.assetsDir, { recursive: true });
    fs.mkdirSync(this.petRoot, { recursive: true });

    // 环境预置宠物（仅开发/测试用，非用户功能；用户素材走素材根目录/开发者模式）
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
    log('ipc/tray/cursor up');

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
        this.win.show(); this.win.setAlwaysOnTop(true, 'floating');
        if (!this.visible) { this.win.hide(); this.win.webContents.send('app:visibility', { visible: false }); }
      }
    });
    this.win.setAlwaysOnTop(true, 'floating');
    // 启动即处于锁定态（设置恢复）→ 直接用最高置顶级别
    this.lockLevel = this.locked ? 'screen-saver' : 'floating';
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
      // 交互结束恢复穿透时的尽力而为兜底：部分应用的遮挡检测会因 z-order 变更事件重算。
      // 实测 Chrome/Edge 不以 REORDER 触发重算（根治靠上面的 WS_EX_TOOLWINDOW），
      // 但保留它对其它实现可能是有效的解冻手段，且开销可忽略。
      if (!was && this.ignore) {
        try {
          this.win.setAlwaysOnTop(false);
          this.win.setAlwaysOnTop(true, this.lockLevel);
        } catch { /* 窗口可能正在销毁 */ }
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

  // 锁定统一入口：锁定 = 最高置顶级别（screen-saver）+ 整窗强制穿透；
  // 解锁 = 恢复常规置顶（floating）与常规穿透判定。托盘是解锁保底入口。
  setLocked(v) {
    const next = !!v;
    if (next !== this.locked) {
      this.locked = next;
      this.store.update({ locked: next }).saveSoon();
      if (this.win && !this.win.isDestroyed()) {
        this.lockLevel = next ? 'screen-saver' : 'floating';
        this.win.setAlwaysOnTop(true, this.lockLevel);
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
      // 宠物主图解析结果（优先级：开发者配置覆盖 > 素材根目录 pet.png > settings 旧值 > 内置占位图）
      petPath: this.resolvePetPath(),
      petIsPlaceholder: this.isPlaceholderPet(this.resolvePetPath()),
      // 可定制文案/配置的生效值（无开发者模式时 = config.js 默认值，字段结构固定）
      dev: this.rendererOverrides(),
    }));

    ipcMain.handle('screen:cursor', () => {
      const p = screen.getCursorScreenPoint();
      return { x: p.x, y: p.y };
    });

    ipcMain.on('win:setIgnore', (_e, v) => this.setIgnore(Boolean(v)));
    // 应用内选择器打开/关闭时临时开/关“可激活”（平时 false，见 createWindow 注释）
    ipcMain.on('win:setFocusable', (_e, v) => this.setFocusable(Boolean(v)));
    ipcMain.on('ui:lock', (_e, locked) => this.setLocked(Boolean(locked)));

    // 资产导入与读取（换宠已移除：file:pickPet / asset:importPet 已删，宠物素材走素材根目录）
    ipcMain.handle('file:pickBg', async () => this.pickFile('背景图片', [{ name: '图片', extensions: ['png'] }]));
    ipcMain.handle('file:pickAudio', async () => this.pickFile('音乐文件', [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }], true));

    ipcMain.handle('asset:importBg', (_e, srcPath) => this.importAsset(srcPath, 'bg', 'background'));
    ipcMain.handle('asset:readImage', (_e, p) => this.readImageAsDataUrl(this.resolveDataPath(p)));
    ipcMain.handle('asset:readAudio', (_e, p) => this.readAudioBytes(this.resolveDataPath(p)));
    ipcMain.handle('fs:exists', (_e, p) => { try { return fs.existsSync(this.resolveDataPath(p)); } catch { return false; } });

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
    ipcMain.handle('chat:send', (_e, text) => this.chatSend(text));
    ipcMain.handle('chat:strings', () => this.rendererOverrides().chat); // 开场白/未命中提示（可定制）
    ipcMain.handle('chatRules:load', () => this.store.get().chatRules || []);
    ipcMain.handle('chatRules:add', (_e, rule) => this.chatRuleAdd(rule));
    ipcMain.handle('chatRules:remove', (_e, keyword) => this.chatRuleRemove(keyword));

    // 右键长按触发的 Windows 风格主菜单（Phase 4）
    ipcMain.on('menu:open', () => this.popupMainMenu());

    // 区域调整（渲染层菜单触发）
    ipcMain.handle('region:resize', (_e, width, height) => this.resizeRegion(width, height));

    // 托盘可见性
    ipcMain.on('app:setVisible', (_e, v) => {
      if (v) this.showWindow(); else this.hideWindow();
    });

    // 状态图形态（渲染层应用后回传，供“切换状态”菜单单选项的勾选态）
    ipcMain.on('state:visualSync', (_e, { useState }) => { this.stateVisualOn = !!useState; });

    // 窗口枚举（吸附）。list() 异步 spawn（不阻塞主进程事件循环），handle 自动等待 Promise。
    ipcMain.handle('enumerate:windows', async () => {
      if (!this.win) return [];
      const selfId = this.selfNativeId();
      const wins = await this.winEnum.list();
      return wins.filter((w) => w.id !== selfId && !isSystemWindow(w));
    });

    ipcMain.on('app:quit', () => this.quit());
  }

  selfNativeId() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const big = buf.readBigUInt64LE(0);
      return big.toString();
    } catch { return '-1'; }
  }

  pickFile(name, filters, multi = false) {
    const opts = { title: `选择${name}`, filters, properties: ['openFile'] };
    if (multi) opts.properties.push('multiSelections');
    // 这台机器上，只要“透明+置顶+全屏”的宠物窗在场，原生文件对话框确认后就拿不到所选
    // 路径（点了“打开”却返回空）。挂父窗、不挂父窗、对话框期间隐藏宠物窗都复现。
    // 宠物/背景/音乐现都改走应用内选择器（openPicker，绕开系统对话框）；
    // pickFile 保留但已无调用入口（想恢复原生对话框时可直接用）。
    const w = this.win && !this.win.isDestroyed() ? this.win : null;
    const wasTop = !!(w && w.isAlwaysOnTop());
    const wasVisible = !!(w && w.isVisible());
    if (w && wasTop) w.setAlwaysOnTop(false);
    if (w && wasVisible) w.hide();
    try {
      const r = dialog.showOpenDialogSync(opts);
      return r && r.filePaths ? r.filePaths : [];
    } finally {
      if (w) {
        if (wasTop) w.setAlwaysOnTop(true, 'floating');
        if (wasVisible) w.show();
        // hide/show 后重设穿透态，保证回到“指针在宠物上才可交互”
        w.setIgnoreMouseEvents(this.ignore, { forward: true });
      }
    }
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
   * 1. 开发者配置覆盖（ov('pet.path')，开发者模式/固化文件均可提供）；
   * 2. 素材根目录约定文件 pet.png（手动替换文件即定制，重启生效）；
   * 3. 兼容旧用户：settings.json 的 pet.path（相对/绝对都支持）；
   * 4. 内置占位图（透明底 src/assets/pet.png）：新电脑/空素材目录也直接有宠物可看。
   */
  resolvePetPath() {
    const devPath = ov('pet.path', null);
    if (devPath && fs.existsSync(devPath)) return devPath;
    const conventional = path.join(this.petRoot, 'pet.png');
    if (fs.existsSync(conventional)) return conventional;
    const legacy = this.resolveDataPath(this.store.get().pet && this.store.get().pet.path);
    if (legacy && fs.existsSync(legacy)) return legacy;
    const fallback = path.join(APP_ROOT, 'src', 'assets', 'pet.png');
    return fs.existsSync(fallback) ? fallback : null;
  }

  /** 当前主图是否为内置占位图（渲染层据此保留"如何自定义"提示条）。 */
  isPlaceholderPet(p) {
    return !!p && path.resolve(p) === path.resolve(path.join(APP_ROOT, 'src', 'assets', 'pet.png'));
  }

  /** 渲染层用的"可定制值"生效集合（无开发者模式时 = config.js 默认值；结构固定）。 */
  rendererOverrides() {
    return {
      greetings: ov('greeting.greetings', CFG.greeting.greetings),
      chat: {
        opening: ov('chat.strings.opening', CFG.chat.strings.opening),
        missNotice: ov('chat.strings.missNotice', CFG.chat.strings.missNotice),
      },
      blinkAnim: {
        frames: ov('blinkAnim.frames', CFG.blinkAnim.frames),
        probability: ov('blinkAnim.probability', CFG.blinkAnim.probability),
      },
      stateImagePath: ov('stateImage.path', CFG.stateImage.path),
    };
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
      const buf = fs.readFileSync(p);
      const ext = path.extname(p).toLowerCase();
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
    const text = formatTask(ov('todo.remindTemplate', CFG.todo.remindTemplate), due[0].text);
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
    const text = formatTask(ov('reminder.template', CFG.reminder.template), t.text);
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

  /** 处理一句聊天输入：命中关键词 → 回复 + 主窗气泡；未命中 → 模拟被点击（Q 弹 + 情绪变化）。 */
  chatSend(text) {
    const input = String(text == null ? '' : text).slice(0, 500);
    if (!input.trim()) return { ok: false, matched: false, reply: null };
    const rule = matchChatRule(this.store.get().chatRules || [], input);
    if (rule) {
      this.send('bubble:chat', { text: rule.reply, ms: CFG.chat.bubbleDurationMs });
      return { ok: true, matched: true, reply: rule.reply, keyword: rule.keyword };
    }
    this.send('pet:action', { type: 'headpat' });
    return { ok: true, matched: false, reply: null };
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

  /* --------- 主菜单文本/可见性（开发者模式可定制；无覆盖时 = config.js 默认） --------- */

  menuLabel(id) {
    const def = CFG.menu.items[id];
    return ov(`menu.items.${id}.label`, def ? def.label : id);
  }

  menuVisible(id) {
    if (!CFG.menu.items[id]) return false; // 未登记的 id 不显示
    return ov(`menu.items.${id}.visible`, true) !== false;
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
    const st = this.store.get();
    const playlist = st.playlist || [];
    const bg = st.background;
    const bgOpacityPct = bg && typeof bg.opacity === 'number' ? Math.round(bg.opacity * 100) : null;

    // 子菜单：隐藏项过滤掉；全部隐藏时整个父项也不出现
    const chatSub = [
      self.menuItem('chatOpen', { click: () => self.openChatWindow() }),
      self.menuItem('chatSettings', { click: () => self.openChatSettingsWindow() }),
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

    const template = [
      self.menuItem('rest', { click: () => self.act('rest') }),
      self.menuItem('feed', { click: () => self.act('feed') }),
      self.menuItem('todo', { click: () => self.openTodoWindow() }),
      chatSub.length ? self.menuItem('chat', { submenu: chatSub }) : null,
      musicSub.length
        ? { id: 'music', label: `${self.menuLabel('music')}${playlist.length ? `（${playlist.length}）` : ''}`, submenu: musicSub }
        : null,
      bgSub.length
        ? { id: 'bg', label: `${self.menuLabel('bg')}${bg && bg.path ? '（已设置）' : ''}`, submenu: bgSub }
        : null,
      stateSub.length ? self.menuItem('state', { submenu: stateSub }) : null,
      self.menuItem('resetStatus', { click: () => self.act('resetStatus') }),
      // 「更换宠物…」已移除（"换图即定制"：素材替换走素材根目录 / 开发者模式）
      { type: 'separator' },
      self.menuItem('quit', { click: () => self.quit() }),
    ].filter(Boolean);
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
    // 素材根目录是应用核心素材（防误改）：应用内不提供浏览入口（开发者模式有专用通道）。
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

  quit() {
    this.quitNow = true;
    if (this.todoTimer) { clearInterval(this.todoTimer); this.todoTimer = 0; }
    if (this.reminderTimer) { clearTimeout(this.reminderTimer); this.reminderTimer = 0; }
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
          visible: this.visible,
        }),
        // 主进程动作（菜单项等价路径）
        checkDueTodos: () => this.checkDueTodos(),
        triggerReminderNow: () => this.triggerReminderNow(),
        openTodo: () => this.openTodoWindow(),
        openChat: () => this.openChatWindow(),
        openChatSettings: () => this.openChatSettingsWindow(),
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
                     petLoaded: !!(s && s.petLoaded), pet: s && s.pet ? { w: s.pet.w, h: s.pet.h } : null };
          })()`);
          const errCount = this.consoleErrors.length + (res.errors || 0);
          console.log(`[smoke] rendererReady=${res.ready} petLoaded=${res.petLoaded} pet=${JSON.stringify(res.pet)} consoleErrors=${errCount} region=${JSON.stringify(this.region)}`);
          const ok = res.ready && errCount === 0 && (process.env.PET_PET_PATH ? res.petLoaded : true);
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

app.whenReady().then(() => {
  log('whenReady resolved');
  const p = new PetApp();
  p.init();
}).catch((e) => {
  console.error('[main] fatal', e);
  app.exit(1);
});

app.on('window-all-closed', (e) => {
  // 托盘常驻：不退出
});
app.on('before-quit', () => {
  // 正常退出路径（若有 store 引用由 quit() 主动 flush）
});
