'use strict';
/**
 * UI 自动化：真实启动 Electron，跑“渲染层驱动场景”（src/main/uiScenarios.js）。
 * 场景名通过 PET_SCENARIO 注入，主进程执行后打印 `SCENARIO <name> PASS/FAIL`。
 * 每个场景都在真实渲染层里完成：加载宠物 → 注入动画/物理 → 轮询断言。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = require('electron');

const ALL_SCENARIOS = ['greeting', 'anim', 'dragPhysics', 'snap', 'physOff', 'status', 'passthrough', 'picker', 'bg', 'menuClean', 'audio', 'rest'];
// PET_UI_ONLY='bg,audio' 只跑指定场景，便于调试单个新场景
const ONLY = (process.env.PET_UI_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const SCENARIOS = ONLY.length ? ONLY : ALL_SCENARIOS;

/** 生成一段极短的无声音乐（PCM WAV），供“添加音乐”场景真实走导入/播放链路。 */
function writeSilentWav(filePath) {
  const rate = 8000, secs = 0.4;
  const dataLen = rate * secs * 2; // 16-bit 单声道
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);   // PCM
  b.writeUInt16LE(1, 22);            // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);     // byteRate
  b.writeUInt16LE(2, 32);            // blockAlign
  b.writeUInt16LE(16, 34);           // bitsPerSample
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  // 剩余样本默认全 0（静音），无需额外写入
  fs.writeFileSync(filePath, b);
}

async function runOne(name) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-ui-'));
  const petPath = path.join(__dirname, '..', 'fixtures', 'pet-96.png');
  const env = {
    ...process.env,
    PET_SCENARIO: name,
    PET_PET_PATH: petPath,
    PET_USERDATA: userData,
    ELECTRON_ENABLE_LOGGING: '1',
  };
  if (name === 'bg') env.PET_BG_PATH = path.join(__dirname, '..', 'fixtures', 'bg-160x64.png');
  if (name === 'audio') {
    const inbox = path.join(userData, 'audio-inbox');
    fs.mkdirSync(inbox, { recursive: true });
    env.PET_AUDIO_DIR = inbox;
    env.PET_AUDIO_PATH = path.join(inbox, 'tone.wav');
    writeSilentWav(env.PET_AUDIO_PATH);
  }
  const child = spawn(ELECTRON, ['--disable-gpu', '--in-process-gpu', '.'], { cwd: ROOT, env, windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const timeout = setTimeout(() => { console.error(`scenario ${name} TIMEOUT`); child.kill(); }, 70000);

  const code = await new Promise((res) => child.on('close', res));
  clearTimeout(timeout);
  fs.rmSync(userData, { recursive: true, force: true });
  return { name, code, out, err };
}

async function main() {
  let allOk = true;
  for (const name of SCENARIOS) {
    const { name: n, code, out, err } = await runOne(name);
    const pass = code === 0 && new RegExp(`SCENARIO ${n} PASS`).test(out);
    if (!pass) allOk = false;
    // 打印关键行（不铺满整个 stdout）
    const keyLines = out.split('\n').filter((l) => /SCENARIO|\[scenario\]/.test(l));
    console.log(`\n=== UI 场景: ${n} ===`);
    for (const l of keyLines) console.log('  ' + l);
    if (!pass) {
      console.log(`  FAIL code=${code}`);
      if (err) console.log('  --- stderr ---\n' + err.slice(0, 3000));
    }
  }
  console.log(allOk ? '\nUI_ALL_PASS' : '\nUI_FAIL');
  process.exit(allOk ? 0 : 1);
}

main();
