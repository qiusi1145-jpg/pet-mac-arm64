'use strict';
/**
 * 聊天记录单测（L1：纯 Node，零 Electron）。
 * 覆盖 2026-09-16 需求："聊天记录要一直留在界面里、可翻阅" + 用户要求"独立 json、明文、不随应用迁移"。
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { ChatLog, resolveLogFile, normalizeEntry, pickEntries } = require(path.join(ROOT, 'src', 'main', 'chatLog'));
const { isInsideDir } = require(path.join(ROOT, 'src', 'main', 'llmSecret'));

const T0 = 1_700_000_000_000;

const TMP_DIRS = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}
function tmpFile() { return path.join(tmpDir('pet-chatlog-'), 'chat.json'); }

after(() => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

/* ================= 路径解析（必须落在便携目录之外） ================= */

test('★ 记录路径默认在用户主目录下（便携目录之外），支持 ~ / 相对 / 环境变量覆盖', () => {
  const home = path.join(path.sep + 'home', 'someone');
  assert.equal(resolveLogFile({ homeDir: home }), path.join(home, '.deskpet', 'chat.json'));
  assert.equal(resolveLogFile({ logFile: '~/a/chat.json', homeDir: home }), path.join(home, 'a', 'chat.json'));
  assert.equal(resolveLogFile({ logFile: 'rel/chat.json', homeDir: home }), path.join(home, 'rel', 'chat.json'));
  const abs = path.join(path.sep + 'tmp', 'c.json');
  assert.equal(resolveLogFile({ logFile: abs, homeDir: home }), abs);
  assert.equal(resolveLogFile({ logFile: abs, homeDir: home, envFile: '~/x.json' }), path.join(home, 'x.json'));
  // 与项目"便携目录"红线对齐：默认路径绝不在程序目录（data/）之内
  const portable = path.join(path.sep + 'app', 'data');
  assert.equal(isInsideDir(portable, resolveLogFile({ homeDir: home })), false);
});

/* ================= 清洗与裁剪（纯函数） ================= */

test('单条清洗：who 白名单、空文本丢弃、超长截断、时间戳兜底', () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({ text: '   ' }), null);
  assert.equal(normalizeEntry({ text: { a: 1 } }), null, '对象这类输入直接丢掉，别写进 [object Object]');
  assert.equal(normalizeEntry({ text: 123 }).text, '123', '数字可以容忍（转成字符串）');
  assert.deepEqual(normalizeEntry({ who: 'me', text: '你好', ts: T0 }), { ts: T0, who: 'me', text: '你好' });
  assert.equal(normalizeEntry({ who: 'pet', text: '嗨' }).who, 'pet');
  assert.equal(normalizeEntry({ who: 'hacker', text: '嗨' }).who, 'sys', '未知 who 归到 sys');
  const long = normalizeEntry({ who: 'pet', text: 'x'.repeat(5000) });
  assert.equal(long.text.length, 2000, '超长截断，别让一条把文件撑爆');
  assert.ok(Number.isFinite(normalizeEntry({ who: 'pet', text: 'a' }).ts), '缺 ts → 用当前时间');
});

test('裁剪：按上限保留**最新**的若干条，并且上限有硬边界', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ ts: T0 + i, who: 'pet', text: `第${i}条` }));
  const kept = pickEntries(list, 3);
  assert.equal(kept.length, 3);
  assert.equal(kept[0].text, '第7条');
  assert.equal(kept[2].text, '第9条', '保留最新的');
  assert.equal(pickEntries(list, 5).length, 5);
  assert.equal(pickEntries(list, 3).length, 3, '合法上限原样尊重（别偷偷夹成 20）');
  assert.equal(pickEntries(list, 99999).length, 10, '超上界只夹到上界，不会丢数据');
  assert.equal(pickEntries(list, 0).length, 10, '非法上限退回默认值（10 条本来就少于默认）');
  assert.deepEqual(pickEntries(null, 5), []);
});

/* ================= 落盘 / 读回 / 坏文件 / 清空 ================= */

test('★ 追加即落盘、新建实例（= 重启应用）能读回——这就是"聊天记录一直留着"', () => {
  const f = tmpFile();
  const log = new ChatLog({ file: f, max: 500 });
  assert.equal(log.append('me', '今天要背单词', T0).ok, true);
  assert.equal(log.append('pet', '好呀，一起', T0 + 1000).ok, true);
  assert.equal(fs.existsSync(f), true);
  assert.equal(fs.existsSync(`${f}.tmp`), false, '原子写：临时文件不许留下');
  const again = new ChatLog({ file: f, max: 500 });   // = 重新打开应用
  const list = again.entries();
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { ts: T0, who: 'me', text: '今天要背单词' });
  assert.equal(list[1].who, 'pet');
  assert.equal(again.status().count, 2);
  assert.equal(again.status().path, f);
});

test('★ 换电脑场景：目录不存在时第一次追加就自动建出整条路径', () => {
  const deep = path.join(tmpDir('pet-newpc-'), 'a', 'b', 'chat.json');
  assert.equal(fs.existsSync(path.dirname(deep)), false);
  const log = new ChatLog({ file: deep });
  assert.equal(log.isEmpty(), true, '没文件 = 空记录（不是错误）');
  assert.equal(log.status().error, '');
  assert.equal(log.append('pet', '新电脑上的第一句').ok, true);
  assert.equal(fs.existsSync(deep), true);
  assert.equal(new ChatLog({ file: deep }).entries().length, 1);
});

test('上限：超出后丢最旧的，且文件里也只有上限条', () => {
  const f = tmpFile();
  const log = new ChatLog({ file: f, max: 20 });   // 会被夹到 MIN_MAX=20
  for (let i = 0; i < 30; i++) log.append('me', `第${i}条`, T0 + i);
  const list = new ChatLog({ file: f, max: 20 }).entries();
  assert.equal(list.length, 20);
  assert.equal(list[list.length - 1].text, '第29条');
  assert.equal(list[0].text, '第10条');
});

test('坏文件不当致命错误：启动按空记录来（记录丢了也比应用起不来轻）', () => {
  const f = tmpFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ 这不是合法 json', 'utf8');
  const log = new ChatLog({ file: f });
  assert.deepEqual(log.entries(), []);
  assert.equal(log.status().error, 'corrupt');
  assert.equal(log.append('me', '坏文件之后照常能写').ok, true);
  assert.equal(new ChatLog({ file: f }).entries().length, 1, '写入后文件被修复成合法 json');
});

test('兼容两种落盘形态（裸数组 / {entries:[…]}）——避免以后改格式就读不出旧记录', () => {
  const f1 = tmpFile();
  fs.mkdirSync(path.dirname(f1), { recursive: true });
  fs.writeFileSync(f1, JSON.stringify([{ ts: T0, who: 'me', text: '裸数组' }]), 'utf8');
  assert.equal(new ChatLog({ file: f1 }).entries()[0].text, '裸数组');
  const f2 = tmpFile();
  fs.mkdirSync(path.dirname(f2), { recursive: true });
  fs.writeFileSync(f2, JSON.stringify({ entries: [{ ts: T0, who: 'pet', text: '带壳' }] }), 'utf8');
  assert.equal(new ChatLog({ file: f2 }).entries()[0].text, '带壳');
});

test('清空：内存与文件同时归零，且之后还能继续写', () => {
  const f = tmpFile();
  const log = new ChatLog({ file: f });
  log.append('me', '一句');
  log.append('pet', '两句');
  assert.equal(log.clear().ok, true);
  assert.equal(log.entries().length, 0);
  assert.equal(new ChatLog({ file: f }).entries().length, 0, '重新打开也是空的');
  assert.equal(log.append('pet', '清空后的新对话').ok, true);
  assert.equal(new ChatLog({ file: f }).entries()[0].text, '清空后的新对话');
});

test('空文本不产生记录（不会往记录里塞空行）', () => {
  const f = tmpFile();
  const log = new ChatLog({ file: f });
  assert.equal(log.append('me', '').ok, false);
  assert.equal(log.append('me', '   \n  ').ok, false);
  assert.equal(log.append('me', null).ok, false);
  assert.equal(log.entries().length, 0);
});
