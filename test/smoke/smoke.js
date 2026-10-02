'use strict';
/**
 * 启动冒烟：真实启动 Electron 应用 —— 断言窗口创建、渲染层 ready、宠物正常解码、
 * 控制台无报错、进程能正常退出（返回码 0）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// PET_ELECTRON_BIN：把测试指向**交付物本身**（打包出来的 桌宠.exe / Electron.app 里的二进制），
// 而不是开发树 node_modules 里那个 —— 出包脚本用它验包，验的才是真发出去的东西。
const ELECTRON = process.env.PET_ELECTRON_BIN || require('electron');

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-smoke-'));
  const petPath = path.join(__dirname, '..', 'fixtures', 'pet-96.png');
  const env = {
    ...process.env,
    PET_SMOKE: '1',
    PET_PET_PATH: petPath,
    PET_USERDATA: userData,
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const child = spawn(ELECTRON, ['.'], { cwd: ROOT, env, windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const timeout = setTimeout(() => { console.error('smoke TIMEOUT'); child.kill(); process.exit(2); }, 60000);

  const code = await new Promise((res) => child.on('close', res));
  clearTimeout(timeout);

  console.log('--- stdout ---\n' + out);
  const gotOk = /SMOKE_OK/.test(out);
  const gotFail = /SMOKE_FAIL/.test(out);
  // 拒绝出现未捕获异常（Electron 主进程崩溃会打出这些）
  const crashLike = /Uncaught|FATAL|A JavaScript error occurred in the main process|Error: electron failed to install/.test(err);

  fs.rmSync(userData, { recursive: true, force: true });
  if (code === 0 && gotOk && !gotFail && !crashLike) {
    console.log('SMOKE PASS');
    process.exit(0);
  } else {
    console.log('SMOKE FAIL', JSON.stringify({ code, gotOk, gotFail, crashLike }));
    if (err) console.log('--- stderr ---\n' + err.slice(0, 4000));
    process.exit(1);
  }
}

main();
