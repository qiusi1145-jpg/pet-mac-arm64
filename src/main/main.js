'use strict';
/**
 * 桌宠 — 主进程入口。
 *
 * 关键实现选择（Windows 单显示器）：
 *  - 宠物窗口 == “活动区域”一个无边框透明置顶窗口。区域内宠物透明处 → 像素级点击
 *    穿透（win.setIgnoreMouseEvents(true,{forward:true})）；当指针落在实体像素上或
 *    打开菜单/面板时，才临时关闭忽略。用主进程高频推送光标位置 + 渲染层命中判定。
 *  - 锁定态 = 永远整窗点击穿透（动画照常），唯一解锁途径：托盘菜单。
 *  - 宠物/背景图片复制到 userData/assets 后持久化路径。
 */
const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { CFG } = require('../shared/config');
const { computeRegion, defaultRegionSettings } = require('../shared/region');
const { Store } = require('./store');
const { WinEnum, isSystemWindow } = require('./winenum');

const PET_NAME = '桌宠';
const PET_IMG_FILTERS = [{ name: '宠物图片 (PNG)', extensions: ['png'] }];

// 供测试隔离：把 userData 指到临时目录，避免污染真实设置。
if (process.env.PET_USERDATA) app.setPath('userData', process.env.PET_USERDATA);

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
    this.store = new Store(app.getPath('userData'));
    this.winEnum = new WinEnum(app.getPath('userData'));
    this.assetsDir = path.join(app.getPath('userData'), 'assets');
    this.region = null;           // 屏幕坐标区域
    this.locked = false;
    this.visible = true;
    this.ignore = true;
    this.consoleErrors = [];
    this.consoleListenerAttached = false;
    this.quitNow = false;
    this.initPromise = null;
  }

  async init() {
    log('init start');
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

    // 环境预置宠物（开发/测试）
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
    this.startCursorPush();
    log('ipc/tray/cursor up');

    if (process.env.PET_SMOKE) {
      this.runSmoke();
    } else if (process.env.PET_SCENARIO) {
      this.runScenario(process.env.PET_SCENARIO);
    } else {
      // 首次运行（无宠物）自动打开应用内图片选择器引导选图
      setTimeout(() => {
        if (!this.quitNow && !this.store.get().pet.path) this.openPicker('pet');
      }, 900);
    }
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
      focusable: true,
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
    this.win.setIgnoreMouseEvents(true, { forward: true });
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
    this.ignore = v;
    if (this.win && !this.win.isDestroyed()) {
      // 锁定态强制穿透
      if (this.locked) { v = true; this.ignore = true; }
      this.win.setIgnoreMouseEvents(v, { forward: true });
    }
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
    }));

    ipcMain.handle('screen:cursor', () => {
      const p = screen.getCursorScreenPoint();
      return { x: p.x, y: p.y };
    });

    ipcMain.on('win:setIgnore', (_e, v) => this.setIgnore(Boolean(v)));
    ipcMain.on('ui:lock', (_e, locked) => {
      this.locked = Boolean(locked);
      this.store.update({ locked: this.locked }).saveSoon();
      this.setIgnore(this.locked ? true : this.ignore);
      this.rebuildTray();
    });

    // 资产导入与读取
    ipcMain.handle('file:pickPet', async () => this.pickFile('宠物图片', PET_IMG_FILTERS));
    ipcMain.handle('file:pickBg', async () => this.pickFile('背景图片', [{ name: '图片', extensions: ['png'] }]));
    ipcMain.handle('file:pickAudio', async () => this.pickFile('音乐文件', [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }], true));

    ipcMain.handle('asset:importPet', (_e, srcPath) => this.importPetFile(srcPath));
    ipcMain.handle('asset:importBg', (_e, srcPath) => this.importAsset(srcPath, 'bg', 'background'));
    ipcMain.handle('asset:readImage', (_e, p) => this.readImageAsDataUrl(p));
    ipcMain.handle('asset:readAudio', (_e, p) => this.readAudioBytes(p));
    ipcMain.handle('fs:exists', (_e, p) => { try { return fs.existsSync(p); } catch { return false; } });

    // 应用内文件选择器（换宠/背景/音乐：列文件都由渲染层走这里，绕开失灵的原生对话框）
    ipcMain.handle('picker:roots', () => this.pickerRoots());
    ipcMain.handle('picker:list', (_e, arg) => this.pickerListFiles(arg)); // arg=dir 或 {dir,kind:'audio'}
    // 应用内“添加音乐”：源文件拷贝进 assets/audio-… → 追加到播放列表 → 回推 audio:list
    ipcMain.handle('audio:addFiles', (_e, paths) => this.addAudioTracks(Array.isArray(paths) ? paths : [paths]));

    ipcMain.on('settings:save', (_e, patch) => { this.store.update(patch).saveSoon(); });

    // 右键长按触发的 Windows 风格主菜单（Phase 4）
    ipcMain.on('menu:open', () => this.popupMainMenu());

    // 区域调整（渲染层菜单触发）
    ipcMain.handle('region:resize', (_e, width, height) => this.resizeRegion(width, height));

    // 托盘可见性
    ipcMain.on('app:setVisible', (_e, v) => {
      if (v) this.showWindow(); else this.hideWindow();
    });

    // 窗口枚举（吸附）
    ipcMain.handle('enumerate:windows', () => {
      if (!this.win) return [];
      const selfId = this.selfNativeId();
      return this.winEnum
        .list()
        .filter((w) => w.id !== selfId && !isSystemWindow(w));
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

  copyIntoAssets(src, prefix) {
    const ext = path.extname(src) || '.png';
    const dest = path.join(this.assetsDir, `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e5)}${ext}`);
    fs.copyFileSync(src, dest);
    return dest;
  }

  importPetFile(src) {
    if (!src || !fs.existsSync(src)) return null;
    const dest = this.copyIntoAssets(src, 'pet');
    this.store.updateDeep('pet', { path: dest }).saveNow();
    return dest;
  }

  importAsset(src, prefix, storeKey) {
    if (!src || !fs.existsSync(src)) return null;
    const dest = this.copyIntoAssets(src, prefix);
    this.store.updateDeep(storeKey, { path: dest }).saveNow();
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
        label: this.locked ? '解锁（保底入口）' : '锁定',
        click: () => {
          const next = !self.locked;
          self.locked = next;
          self.store.update({ locked: next }).saveSoon();
          self.setIgnore(true);
          self.rebuildTray();
          if (self.win && !self.win.isDestroyed()) self.win.webContents.send('lock:change', { locked: next });
        },
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
  }

  // 发送渲染层可执行的动作 / 事件（窗口可能隐藏 → 先显示）
  send(name, ...args) {
    if (this.visible && this.win && !this.win.isDestroyed()) this.win.webContents.send(name, ...args);
  }
  showIfHidden() { if (!this.visible) this.showWindow(); }

  act(type, payload) { this.showIfHidden(); this.send('pet:action', payload ? { type, ...payload } : { type }); }

  /* ---------------- Phase 4：原生主菜单 / 音乐 / 背景 ---------------- */

  popupMainMenu() {
    if (!this.win || this.win.isDestroyed()) return;
    this.showIfHidden();
    const self = this;
    const st = this.store.get();
    const playlist = st.playlist || [];
    const bg = st.background;
    const bgOpacityPct = bg && typeof bg.opacity === 'number' ? Math.round(bg.opacity * 100) : null;

    const template = [
      { label: '休息', click: () => self.act('rest') },
      { label: '喂食', click: () => self.act('feed') },
      {
        label: `音乐${playlist.length ? `（${playlist.length}）` : ''}`,
        submenu: [
          { label: '添加音乐…', click: () => self.openPicker('audio') },
          { type: 'separator' },
          { label: '播放 / 暂停', click: () => { self.showIfHidden(); self.send('audio:toggle'); } },
          { label: '下一首', click: () => { self.showIfHidden(); self.send('audio:next'); } },
          { label: '上一首', click: () => { self.showIfHidden(); self.send('audio:prev'); } },
          { label: '停止播放', click: () => { self.showIfHidden(); self.send('audio:stop'); } },
          { label: '清空列表', click: () => self.clearPlaylist() },
        ],
      },
      {
        label: `背景${bg && bg.path ? '（已设置）' : ''}`,
        submenu: [
          { label: '选择背景图片…', click: () => self.openPicker('bg') },
          { label: '清除背景', click: () => { self.store.updateDeep('background', { path: null, opacity: self.bgOpacityNow() }).saveSoon(); self.send('bg:clear'); } },
          { type: 'separator' },
          { label: '不透明度 25%', type: 'radio', checked: bgOpacityPct === 25, click: () => self.send('bg:opacity', { opacity: 0.25 }) },
          { label: '不透明度 50%', type: 'radio', checked: bgOpacityPct === 50, click: () => self.send('bg:opacity', { opacity: 0.5 }) },
          { label: '不透明度 75%', type: 'radio', checked: bgOpacityPct === 75, click: () => self.send('bg:opacity', { opacity: 0.75 }) },
          { label: '不透明度 100%', type: 'radio', checked: bgOpacityPct === 100, click: () => self.send('bg:opacity', { opacity: 1 }) },
        ],
      },
      { label: '切换状态', click: () => self.send('state:toggle') },
      { label: '重置状态', click: () => self.act('resetStatus') },
      { type: 'separator' },
      { label: '退出', click: () => self.quit() },
    ];
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
      tracks.push({ path: dest, name: path.basename(p) });
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
      // 选择器是明确的手动交互任务 → 若处于锁定态先解锁，否则整窗穿透点不到面板
      this.locked = false;
      this.store.update({ locked: false }).saveSoon();
      this.rebuildTray();
    }
    this.showIfHidden();
    const wc = w.webContents;
    if (wasLocked) wc.send('lock:change', { locked: false });
    const k = kind === 'bg' ? 'bg' : kind === 'audio' ? 'audio' : 'pet';
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
