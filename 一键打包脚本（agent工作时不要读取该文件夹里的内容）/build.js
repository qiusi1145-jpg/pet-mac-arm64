'use strict';
/**
 * 一键打包脚本：把本仓库打成 Windows 绿色免安装版（桌宠.exe + 便携文件夹 + zip）。
 *
 * 入口：双击同目录 一键打包.bat（或手动 `node build.js`）。
 * 维护文档：同目录 README-维护文档.md —— 改动前必读，尤其是「复制清单」一节。
 *
 * 原理（零新增依赖）：
 *   1) 直接使用 node_modules/electron/dist 里现成的 Electron 运行时（与开发态同一份），
 *      electron.exe 改名为 桌宠.exe；
 *   2) 按「白名单」把运行必需的文件复制到 桌宠.exe/resources/app/ 下；
 *   3) 用 src/assets/pet.png 生成多尺寸 .ico（make-ico.ps1），再用系统自带的 Win32
 *      UpdateResource 把图标写进 exe（set-exe-icon.ps1）——全程零新增依赖、零联网；
 *   4) 用系统自带 bsdtar 产出同名 zip。
 *
 * 产物： <项目根>/out/桌宠-win32-x64/           ← 绿色文件夹，双击 桌宠.exe 即用
 *        <项目根>/out/桌宠-win32-x64.zip        ← 分发用压缩包
 *
 * ⚠ 为什么不打 asar：本应用是便携式设计（userData 固定为 应用目录/data/，见 src/main/main.js
 *   的 APP_ROOT/DATA_DIR）。asar 只读，压进去后 data/ 会落到 app.asar 内导致设置无法保存。
 *   所以资源必须保持散文件（resources/app/），这是本脚本与 electron-builder 方案的核心差异。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const ROOT = path.resolve(SCRIPT_DIR, '..');
const OUT_DIR = path.join(ROOT, 'out');

// ---------------------------------------------------------------- 可维护参数
// 运行时白名单：打包进 resources/app/ 的内容。应用新增顶层资源目录 / 原生依赖时必须同步这里。
const PROD_MODULES = [
  // package.json 的运行时 dependencies（+ 其平台二进制子包）。当前仅语音识别一个原生依赖。
  'sherpa-onnx-node',
  'sherpa-onnx-win-x64',
];
// 语音模型：把开发机 data/voice/models 已下载的模型一并打包（不含 _download 临时缓存），
// 这样换电脑语音开箱即用。应用设计是"缺模型→语音功能优雅隐藏"，所以缺了也只是警告不失败。
const SHIP_VOICE_MODELS = true;
// exe 图标来源：桌宠主图（用户指定：路径保持 src/assets/pet.png 不变）。
const ICON_PNG = path.join(ROOT, 'src', 'assets', 'pet.png');
// --------------------------------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = pkg.productName || pkg.name || '桌宠';
const STAGE_NAME = `${APP_NAME}-win32-x64`;
const STAGE = path.join(OUT_DIR, STAGE_NAME);
const ZIP_PATH = path.join(OUT_DIR, `${STAGE_NAME}.zip`);
const EXE_PATH = path.join(STAGE, `${APP_NAME}.exe`);

let stepNo = 0;
const log = (msg) => console.log(msg);
const step = (msg) => log(`\n[${ ++stepNo}/${6}] ${msg}`);
const warn = (msg) => console.warn(`  ⚠ ${msg}`);
const die = (msg) => { console.error(`\n  ✗ ${msg}`); process.exit(1); };
const exists = (p) => fs.existsSync(p);
const rel = (p) => path.relative(ROOT, p) || '.';

function copyDir(src, dest, filter) {
  fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, filter });
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      total += st.isDirectory() ? (walk(p), 0) : st.size;
    }
  };
  walk(dir);
  return total;
}

const fmtMB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/* ---------------------------------------------------------------- 1/7 预检 */
function preflight() {
  const required = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(ROOT, 'src', 'main', 'main.js'),
    path.join(ROOT, '动画素材'),
    path.join(ROOT, 'node_modules', 'sherpa-onnx-node'),
    path.join(ROOT, 'node_modules', 'sherpa-onnx-win-x64'),
  ];
  for (const p of required) {
    if (!exists(p)) die(`缺少 ${rel(p)}\n         （若刚拉了新代码，先在项目根跑一次 npm install 再打包）`);
  }
  if (!exists(ICON_PNG)) warn(`找不到图标源图 ${rel(ICON_PNG)}，本次将跳过图标（exe 用 Electron 默认图标）`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const electronPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'));
  log(`  应用: ${APP_NAME} v${pkg.version}   Electron: v${electronPkg.version}   Node: ${process.version}`);
}

/* ------------------------------------------------- 2/7 复制 Electron 运行时 */
function copyRuntime() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(ZIP_PATH, { force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  copyDir(path.join(ROOT, 'node_modules', 'electron', 'dist'), STAGE);
  fs.renameSync(path.join(STAGE, 'electron.exe'), EXE_PATH);
  log(`  Electron 运行时 → ${rel(STAGE)}（electron.exe 已改名 ${APP_NAME}.exe）`);
}

/* ------------------------------------------- 3/7 白名单复制应用代码与依赖 */
function copyApp() {
  const app = path.join(STAGE, 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });

  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(app, 'package.json'));
  copyDir(path.join(ROOT, 'src'), path.join(app, 'src'));
  copyDir(path.join(ROOT, '动画素材'), path.join(app, '动画素材'));
  // 语音模型下载工具（纯 Node 无依赖）：打包版换电脑后也能 `node fetch-voice-model.js` 补/换模型。
  const toolsDir = path.join(app, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'fetch-voice-model.js'), path.join(toolsDir, 'fetch-voice-model.js'));

  fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
  for (const m of PROD_MODULES) copyDir(path.join(ROOT, 'node_modules', m), path.join(app, 'node_modules', m));

  if (SHIP_VOICE_MODELS) {
    const modelsSrc = path.join(ROOT, 'data', 'voice', 'models');
    if (exists(modelsSrc)) {
      const modelsDest = path.join(app, 'data', 'voice', 'models');
      fs.mkdirSync(modelsDest, { recursive: true });
      for (const name of fs.readdirSync(modelsSrc)) {
        if (name === '_download') continue; // 临时下载缓存（压缩包/断点续传），不打进包
        copyDir(path.join(modelsSrc, name), path.join(modelsDest, name));
      }
      log(`  语音模型: ${fs.readdirSync(modelsDest).join(', ')}`);
    } else {
      warn('data/voice/models 不存在，本包不含语音模型（打包版里语音功能将隐藏，需手动补模型）');
    }
  }
  fs.mkdirSync(path.join(app, 'data'), { recursive: true }); // 便携数据目录（运行时自动填充）
  log(`  应用代码+依赖+模型 → ${rel(app)}`);
}

/* ---------------------------------------------------- 4/6 生成图标 (png→ico) */
function buildIcon() {
  if (!exists(ICON_PNG)) return null;
  const ps1 = path.join(SCRIPT_DIR, 'make-ico.ps1');
  if (!exists(ps1)) { warn('缺少 make-ico.ps1，跳过图标'); return null; }
  const icoPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-ico-')), 'pet.ico');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ps1, '-Png', ICON_PNG, '-Ico', icoPath,
  ], { encoding: 'utf8' });
  if (r.status !== 0 || !exists(icoPath)) {
    warn(`生成 ico 失败（PowerShell: ${r.status === null ? r.error?.message : `exit ${r.status}`}）${r.stderr ? '\n    ' + String(r.stderr).trim().split('\n').slice(-2).join('\n    ') : ''}`);
    warn('跳过图标，exe 使用默认图标（不影响功能）');
    return null;
  }
  return icoPath;
}

/* ------------------------------------------------- 4/6 写入 exe 图标 */
function applyIcon(exePath, icoPath) {
  if (!icoPath) return;
  const ps1 = path.join(SCRIPT_DIR, 'set-exe-icon.ps1');
  if (!exists(ps1)) { warn('缺少 set-exe-icon.ps1，跳过图标写入'); return; }
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ps1, '-Exe', exePath, '-Ico', icoPath,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = String(r.stderr || r.error?.message || '').trim().split('\n').slice(-2).join(' ');
    warn(`写入图标失败（exit ${r.status === null ? r.error?.message : r.status}${tail ? '：' + tail : ''}）`);
    warn('exe 保留 Electron 默认图标（不影响功能），可重跑一次打包重试');
    return;
  }
  log('  已把 pet.png 多尺寸图标写入 exe（资源管理器若短暂显示旧图标，是图标缓存，重开窗口即新）');
}

/* ---------------------------------------------------------------- 5/6 压缩包 */
function makeZip() {
  // 系统自带 bsdtar（Win10 1803+，注意必须用绝对路径，否则在 Git Bash 环境会命中 GNU tar）：
  // -a 按扩展名出 zip，文件名 UTF-8，中文不乱码。
  const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tarCmd = exists(sysTar) ? sysTar : 'tar';
  let r = spawnSync(tarCmd, ['-a', '-c', '-f', ZIP_PATH, '-C', OUT_DIR, STAGE_NAME], { encoding: 'utf8' });
  if (r.status !== 0 || !exists(ZIP_PATH)) {
    warn(`bsdtar 压缩失败（${r.status === null ? r.error?.message : `exit ${r.status}`}），改用 PowerShell Compress-Archive…`);
    r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path (Join-Path '${OUT_DIR}' '${STAGE_NAME}') -DestinationPath '${ZIP_PATH}' -Force`,
    ], { encoding: 'utf8' });
    if (r.status !== 0 || !exists(ZIP_PATH)) { warn('zip 生成失败，绿色文件夹仍可直接使用'); return; }
  }
  log(`  ${rel(ZIP_PATH)}（${fmtMB(fs.statSync(ZIP_PATH).size)}）`);
}

/* ----------------------------------------------------- 6/6 结构校验 + 摘要 */
function verifyStructure() {
  const app = path.join(STAGE, 'resources', 'app');
  const modelsOk = (() => {
    const d = path.join(app, 'data', 'voice', 'models');
    return !SHIP_VOICE_MODELS || (exists(d) && fs.readdirSync(d).length > 0);
  })();
  const checks = [
    [`${APP_NAME}.exe 存在且体积正常`, exists(EXE_PATH) && fs.statSync(EXE_PATH).size > 50 * 1024 * 1024],
    ['resources/app/package.json', exists(path.join(app, 'package.json'))],
    ['resources/app/src/main/main.js（主进程入口）', exists(path.join(app, 'src', 'main', 'main.js'))],
    ['resources/app/动画素材（随机特效）', exists(path.join(app, '动画素材'))],
    [`resources/app/node_modules/{${PROD_MODULES.join(',')}}（原生语音依赖）`,
      PROD_MODULES.every((m) => exists(path.join(app, 'node_modules', m)))],
    ['sherpa-onnx-c-api.dll（原生语音二进制）', exists(path.join(app, 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx-c-api.dll'))],
    ['resources/app/data/voice/models（语音模型）', modelsOk],
    ['同名 zip 压缩包', exists(ZIP_PATH)],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    log(`  ${ok ? '✓' : '✗'} ${name}`);
  }
  if (bad) warn(`${bad} 项结构校验未通过，请对照上方日志排查`);
  log('  （脚本不自动启动 exe：打包版没有自检参数，启动即拉起完整桌宠。请双击人工确认。）');
}

function summary() {
  let git = '';
  const g = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (g.status === 0) git = (g.stdout || '').trim();
  const lines = [
    `应用: ${APP_NAME} v${pkg.version}`,
    `Electron: ${(JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'))).version}`,
    `源码: git ${git || '(未知)'}   打包时间: ${new Date().toLocaleString('zh-CN')}`,
    `数据目录: 打包版把便携数据存在 ${APP_NAME}.exe/resources/app/data/（开发态是项目根 data/，两者互不影响）`,
    `语音模型: ${SHIP_VOICE_MODELS ? '已内置（换电脑开箱即用）' : '未内置'}`,
  ];
  fs.writeFileSync(path.join(STAGE, '打包信息.txt'), lines.join('\n') + '\n', 'utf8');
  const size = dirSize(STAGE);
  log(`\n========== 打包完成 ==========`);
  log(`  绿色文件夹: ${STAGE}（${fmtMB(size)}）`);
  if (exists(ZIP_PATH)) log(`  压缩包:     ${ZIP_PATH}`);
  log(`  下一步: 双击 ${APP_NAME}.exe 人工过一遍（托盘/番茄钟/语音/学英语），确认后即可整个文件夹分发。`);
  log(`  提示: 首次运行如弹 SmartScreen/杀软提醒，属未签名 exe 的正常现象（详见维护文档）。`);
}

/* --------------------------------------------------------------------- main */
(async () => {
  const t0 = Date.now();
  step('预检（Electron 运行时 / 源码 / 依赖 / 模型）');
  preflight();
  step('复制 Electron 运行时并改名为 桌宠.exe');
  copyRuntime();
  step('按白名单复制应用代码、运行时依赖、语音模型');
  copyApp();
  step('生成图标（pet.png → 多尺寸 ico）并写入 exe（系统 UpdateResource）');
  applyIcon(EXE_PATH, buildIcon());
  step('生成 zip 压缩包');
  makeZip();
  step('结构校验 + 写打包信息');
  verifyStructure();
  summary();
  log(`\n  耗时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒\n`);
})().catch((e) => die(e && e.stack ? e.stack : String(e)));
