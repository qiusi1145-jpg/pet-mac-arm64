'use strict';
/**
 * 番茄钟学习记录的持久化（主进程专用）。
 *
 * 为什么独立文件而不是塞进 settings.pomodoro：
 *  - 记录会持续增长，settings.json 是"整体写回"的心跳模型，塞进去每次心跳都要背一份全量记录；
 *  - 学习记录是"成长数据"，该跟着便携包走 → 放 userData（= data/）内，随文件夹拷贝带走。
 * 读写都是同步小文件（≤400 条明细 + 每天一条聚合），不需要异步队列。
 */
const fs = require('fs');
const path = require('path');
const PS = require('../shared/pomodoroStats');

const FILE = 'pomodoro-stats.json';

function statsPath(userDataRoot) { return path.join(userDataRoot, FILE); }

/** 读 + 清洗（文件不存在/损坏 → 空白统计，绝不抛错）。 */
function load(userDataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(statsPath(userDataRoot), 'utf8'));
    return PS.normalizeStats(raw);
  } catch { /* 无文件或坏 JSON → 从零开始 */ }
  return PS.emptyStats();
}

/** 原子落盘：先写临时文件再改名，避免写一半崩掉留下坏 JSON。 */
function save(userDataRoot, stats) {
  const p = statsPath(userDataRoot);
  const tmp = `${p}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(stats), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

/**
 * 记一次专注并立刻落盘。
 * @returns {{stats, entry, unlocked}} 同 shared.recordFocus
 */
function record(userDataRoot, stats, ev, now) {
  const r = PS.recordFocus(stats, ev, now);
  try { save(userDataRoot, r.stats); } catch (e) {
    // 落盘失败不吞异常——让调用方知道（但内存里的统计已更新，下次成功写入会补上）
    if (process.env.PET_DEBUG) console.error('[pomodoroStats] save failed:', e && e.message);
  }
  return r;
}

module.exports = { statsPath, load, save, record };
