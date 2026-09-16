'use strict';
/**
 * 语音模型下载脚本（放在项目根 tools/ 下，**不在 data/ 内** —— data/ 是运行时数据）。
 *
 * 用法：
 *   npm run voice:fetch                        # 下载 config 选定的识别模型 + 唤醒词模型
 *   npm run voice:fetch -- --model small-ctc-zh-int8   # ★ 只下轻量档（**实测 20.3MB**，慢网首选）
 *   npm run voice:fetch -- --kws               # 只下唤醒词(KWS)模型（约 3.3MB）
 *   npm run voice:fetch -- --all               # 下载全部档位（体积大，不推荐）
 *   npm run voice:fetch -- --mirror            # 走 ModelScope 镜像（该镜像路径**未核实**，未必有文件）
 *   npm run voice:fetch -- --from "D:\\下载\\sherpa-onnx-...tar.bz2"
 *                                              # 用**本地下好的压缩包**（GitHub 慢时的推荐做法：
 *                                              # 用浏览器/下载工具下完，再让脚本负责校验与解压）
 *
 * ⚠ 模型分处两个 release（实测核实）：识别模型在 `asr-models`，**唤醒词(KWS)在 `kws-models`**。
 *   早期版本一律用 asr-models，导致 KWS 那条恒 502 → 唤醒功能永远装不上。
 *
 * 落地位置：data/voice/models/<模型目录名>/  （随 data/ 便携；**不进 git**）
 * 可中断：压缩包留在 data/voice/models/_download/，重跑会续传/跳过。
 *
 * 为什么需要它：模型体积远超仓库合理范围（160MB 级），而且换档位只是换目录，
 * 所以做成"按需下载"而不是随包分发。缺模型时应用不会崩——语音功能整体优雅隐藏
 * （菜单照常出现，点开/说话时提示"语音模型未安装"），与"学英语缺词书"同一套路。
 *
 * 依赖：Windows 自带 bsdtar（C:\Windows\System32\tar.exe，支持 .tar.bz2）与 curl。
 * 若解压工具缺失，脚本会保留已下载的压缩包并给出**手动解压的一行命令**。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { CFG } = require(path.join(ROOT, 'src', 'shared', 'config'));

const MODELS_ROOT = path.join(ROOT, 'data', 'voice', 'models');
const DL_DIR = path.join(MODELS_ROOT, '_download');
// ★ 两个模型在**不同的 GitHub release** 里（实测核实）：
//   识别模型 → asr-models     唤醒词(KWS) → kws-models
//   早期版本一律用 asr-models → KWS 那条恒 502，唤醒功能永远装不上。
const RELEASES = {
  asr: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models',
  kws: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models',
};
const MIRROR = 'https://www.modelscope.cn/api/v1/models/ZhaoChaoqun/sherpa-onnx-asr-models/repo?Revision=master&FilePath=';

function arg(name) { return process.argv.includes(name); }
function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function human(n) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** 找一个可用的 curl（Windows 10+ 自带 C:\Windows\System32\curl.exe）。 */
function findCurl() {
  for (const p of ['C:/Windows/System32/curl.exe', 'curl']) {
    const r = spawnSync(p, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}

/**
 * 用系统 curl 下载 —— **这才是真正可靠的路径**：
 *   -C -                 断点续传（`.part` 存在就从断点接上，不从头来）
 *   --retry-all-errors   连 5xx/网络中断也重试
 *   --speed-limit/--time 卡住（<1KB/s 持续 120s）才放弃 → 慢但活着就继续等
 * 之前手写的 https 实现有两个真问题：① 固定 120s 超时把慢速下载直接掐死
 * ② 号称"可续传"其实没实现，重跑等于从头下。慢网下这两个叠加 = 永远下不完。
 */
function downloadWithCurl(curl, url, dest) {
  const part = dest + '.part';
  const args = [
    '-L', '-C', '-',
    '--retry', '50', '--retry-delay', '3', '--retry-all-errors',
    '--connect-timeout', '20',
    '--speed-limit', '1024', '--speed-time', '120',
    '--progress-bar',
    '-o', part, url,
  ];
  const r = spawnSync(curl, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`curl 退出码 ${r.status}（已下的部分保留在 ${path.basename(part)}，重跑会续传）`);
  const size = fs.statSync(part).size;
  fs.renameSync(part, dest);
  return { bytes: size };
}

/** 跟随重定向的下载（**兜底**：系统没有 curl 时才用；不支持续传）。 */
function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) { reject(new Error('重定向过多')); return; }
    const req = https.get(url, { headers: { 'User-Agent': 'deskpet-voice-fetch' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        resolve(download(next, dest, depth + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, lastPct = -1;
      const tmp = dest + '.part';
      const ws = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        got += c.length;
        const pct = total ? Math.floor((got / total) * 100) : -1;
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          process.stdout.write(`\r    下载中 ${pct >= 0 ? pct + '%' : human(got)} (${human(got)}${total ? '/' + human(total) : ''})   `);
        }
      });
      res.pipe(ws);
      ws.on('finish', () => {
        ws.close(() => {
          process.stdout.write('\r');
          try { fs.renameSync(tmp, dest); } catch (e) { reject(e); return; }
          resolve({ bytes: got, total });
        });
      });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('下载超时')); });
  });
}

function findTar() {
  for (const p of ['C:/Windows/System32/tar.exe', 'tar']) {
    const r = spawnSync(p, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}

/** 解压 .tar.bz2 到 MODELS_ROOT（压缩包内自带顶层目录名）。 */
function extractTarBz2(tar, archive) {
  const r = spawnSync(tar, ['-xjf', archive, '-C', MODELS_ROOT], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`解压失败：${(r.stderr || '').trim() || '未知原因'}`);
}

function modelFilesOk(dir, streaming) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return { ok: false, missing: [dir] }; }
  const has = (re) => names.some((n) => re.test(n));
  const missing = [];
  if (!fs.existsSync(path.join(dir, 'tokens.txt'))) missing.push('tokens.txt');
  if (streaming) {
    if (!has(/^encoder.*\.onnx$/i)) missing.push('encoder*.onnx');
    if (!has(/^decoder.*\.onnx$/i)) missing.push('decoder*.onnx');
    if (!has(/^joiner.*\.onnx$/i)) missing.push('joiner*.onnx');
  } else if (!has(/\.onnx$/i)) missing.push('*.onnx');
  return { ok: missing.length === 0, missing };
}

async function fetchOne(label, dirName, opts = {}) {
  const dir = path.join(MODELS_ROOT, dirName);
  const check = modelFilesOk(dir, opts.streaming !== false);
  if (check.ok) {
    console.log(`  ✓ ${label} 已存在，跳过（${dirName}）`);
    return true;
  }
  const file = `${dirName}${opts.ext || '.tar.bz2'}`;
  fs.mkdirSync(DL_DIR, { recursive: true });
  const dest = path.join(DL_DIR, file);
  const from = argVal('--from', '');
  const useLocal = from && path.basename(from) === file && fs.existsSync(from);
  if (useLocal) {
    console.log(`    用本地压缩包：${from}`);
    fs.copyFileSync(from, dest);
  } else if (from) {
    console.log(`    ⚠ --from 指定的文件不存在或文件名不匹配（需要 ${file}），改为网络下载`);
  }
  if (!useLocal) {
    const base = RELEASES[opts.release || 'asr'] || RELEASES.asr;
    const url = arg('--mirror') ? MIRROR + encodeURIComponent(file) : `${base}/${file}`;
    console.log(`    ${url}`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      console.log(`    已有下载缓存（${human(fs.statSync(dest).size)}），跳过下载`);
    } else {
      try {
        const curl = findCurl();
        if (curl) {
          const partial = fs.existsSync(dest + '.part') ? fs.statSync(dest + '.part').size : 0;
          console.log(`    用系统 curl 下载${partial > 1024 ? `（从 ${human(partial)} 处续传）` : ''}…`);
          const r = downloadWithCurl(curl, url, dest);
          console.log(`    完成（${human(r.bytes)}）`);
        } else {
          console.log('    （没找到 curl，退回内置下载器；此路径不支持续传）');
          const r = await download(url, dest);
          console.log(`    完成（${human(r.bytes)}）`);
        }
      } catch (e) {
        console.log(`    ✗ 下载失败：${e.message}`);
        console.log('    三个替代做法：① 直接重跑本命令（会从断点续传，不用重头下）');
        console.log('    ② 换网络/挂代理后重跑    ③ 用浏览器或下载工具下这个文件，然后：');
        console.log(`       npm run voice:fetch -- --from "<下载到的路径>/${file}"`);
        return false;
      }
    }
  }
  fs.mkdirSync(MODELS_ROOT, { recursive: true });
  const tar = findTar();
  if (!tar) {
    console.log(`    ✗ 找不到解压工具。压缩包已保存在：\n      ${dest}`);
    console.log('    请手动解压到 data/voice/models/ 后重跑本脚本校验。');
    return false;
  }
  try {
    extractTarBz2(tar, dest);
  } catch (e) {
    console.log(`    ✗ ${e.message}`);
    return false;
  }
  const after = modelFilesOk(dir, opts.streaming !== false);
  if (after.ok) {
    console.log(`    ✓ 就绪：${dir}`);
    return true;
  }
  console.log(`    ✗ 解压后仍缺文件：${after.missing.join(', ')}（请检查目录名是否为 ${dirName}）`);
  return false;
}

(async () => {
  console.log('语音模型下载（离线识别用；全部本地，不联网运行）\n');
  const wantAll = arg('--all');
  const onlyKws = arg('--kws');
  const results = [];

  if (!onlyKws) {
    const pick = argVal('--model', '');
    let list;
    if (pick) {
      list = CFG.voice.models.filter((m) => m.id === pick);
      if (!list.length) {
        console.log(`  ✗ 没有这个档位：${pick}`);
        console.log(`    可用：${CFG.voice.models.map((m) => `${m.id}（${m.label}）`).join('\n          ')}`);
        process.exit(1);
      }
    } else {
      list = wantAll ? CFG.voice.models : CFG.voice.models.filter((m) => m.id === CFG.voice.model);
    }
    for (const m of list) {
      results.push(await fetchOne(`识别模型：${m.label}`, m.dir, { streaming: m.streaming !== false, release: 'asr' }));
    }
  }
  if (onlyKws || wantAll || !arg('--no-kws')) {
    // ★ 唤醒词模型在 **kws-models** 那个 release，不在 asr-models
    results.push(await fetchOne('唤醒词模型（KWS）', CFG.voice.kwsModel, { streaming: true, release: 'kws' }));
  }

  console.log('\n—— 小结 ——');
  console.log(results.every(Boolean)
    ? '全部就绪。重启桌宠即可说话（主菜单 → 聊天 → 语音聊天设置）。'
    : '部分未就绪。缺模型时应用不会崩，语音功能会整体优雅隐藏并给出提示。');
  process.exit(results.every(Boolean) ? 0 : 1);
})();
