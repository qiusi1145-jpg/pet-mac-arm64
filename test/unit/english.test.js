'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const eng = require('../../src/shared/english');
const { CFG } = require('../../src/shared/config');

/* ================= 偏好与词书清洗 ================= */

test('sanitizePrefs: 非法难度/主题回退默认', () => {
  assert.equal(eng.sanitizePrefs({ level: 'cet6', theme: 'sunset' }).level, 'cet6');
  assert.equal(eng.sanitizePrefs({ level: 'hack', theme: 42 }).level, CFG.english.defaultLevel);
  assert.equal(eng.sanitizePrefs(null).theme, CFG.english.defaultTheme);
});

test('normalizeBook: 坏结构回 null，缺释义/重复词被丢', () => {
  assert.equal(eng.normalizeBook(null), null);
  assert.equal(eng.normalizeBook({}), null);
  const book = eng.normalizeBook({
    meta: { level: 'cet4' },
    words: [
      { w: 'run', trans: [{ pos: 'v', cn: '跑' }], sents: [{ en: 'I run fast.', cn: '我跑得快。' }] },
      { w: 'run', trans: [{ pos: 'n', cn: '跑步' }] }, // 重复 → 丢
      { w: 'bad' }, // 无释义 → 丢
      null,
    ],
  });
  assert.equal(book.words.length, 1);
  assert.equal(book.words[0].w, 'run');
});

test('indexBook: 按真题/例句建索引，短句不进例句索引', () => {
  const book = eng.normalizeBook({
    meta: {},
    words: [
      { w: 'a', trans: [{ cn: 'x' }], exams: [{ q: '_ ok', cs: ['1', '2', '3', '4'], right: 0 }] },
      { w: 'b', trans: [{ cn: 'y' }], sents: [{ en: 'This is a full sentence here.', cn: '完整句' }] },
      { w: 'c', trans: [{ cn: 'z' }], sents: [{ en: 'Hi.', cn: '短句' }] },
    ],
  });
  const idx = eng.indexBook(book);
  assert.equal(idx.examWords.length, 1);
  assert.equal(idx.sentWords.length, 1);
  assert.equal(idx.sentWords[0].w, 'b');
});

/* ================= 翻译判分 ================= */

test('judgeTranslation: 英译中，参考中文 bigram 覆盖率分档', () => {
  const r1 = eng.judgeTranslation('我们的航班被取消了。', 'Our flight was cancelled.', 'zh2en');
  // 方向参数是参考答案语言侧：en2zh 表示“参考答案为中文”
  const r2 = eng.judgeTranslation('我们的航班被取消了。', '我们的航班取消了。', 'en2zh');
  const r3 = eng.judgeTranslation('完全无关的答案内容呀。', '我们的航班取消了。', 'en2zh');
  assert.equal(r2.verdict, 'correct');
  assert.equal(r3.verdict, 'wrong');
  assert.ok(r1.score >= 0);
});

test('judgeTranslation: 中译英，忽略虚词后按内容词覆盖率判分', () => {
  const exact = eng.judgeTranslation('She was so absorbed in her job.', 'She was so absorbed in her job.', 'zh2en');
  const punct = eng.judgeTranslation('she was so absorbed in her job！', 'She was so absorbed in her job.', 'zh2en');
  const close = eng.judgeTranslation('she was absorbed in the job and the work and the task', 'She was absorbed in her job.', 'zh2en');
  const wrong = eng.judgeTranslation('I like apples very much.', 'She was absorbed in her job.', 'zh2en');
  assert.equal(exact.verdict, 'correct');
  assert.equal(punct.verdict, 'correct');
  assert.equal(close.verdict, 'close');
  assert.equal(wrong.verdict, 'wrong');
});

test('judgeTranslation: 空输入判错', () => {
  assert.equal(eng.judgeTranslation('', 'hello world', 'zh2en').verdict, 'wrong');
  assert.equal(eng.judgeTranslation('  ', '你好', 'en2zh').verdict, 'wrong');
});

/* ================= 选词填空 ================= */

function fakeBook() {
  return eng.normalizeBook({
    meta: {},
    words: [
      { w: 'absorbed', trans: [{ pos: 'adj', cn: '专心致志的' }], rels: [['v', 'absorb', '吸收']] },
      { w: 'apple', trans: [{ pos: 'n', cn: '苹果' }] },
      { w: 'banana', trans: [{ pos: 'n', cn: '香蕉' }] },
      { w: 'cat', trans: [{ pos: 'n', cn: '猫' }] },
      { w: 'dog', trans: [{ pos: 'n', cn: '狗' }] },
      {
        w: 'quickly', trans: [{ pos: 'adv', cn: '快速地' }],
        sents: [{ en: 'She ran quickly to the station yesterday.', cn: '她飞快地跑向车站。' }],
      },
    ],
  });
}

test('buildCloze: 挖目标词、4 选项、答案可定位、含解析与原句', () => {
  const book = fakeBook();
  const word = book.words.find((w) => w.w === 'quickly');
  const q = eng.buildCloze(word, book.words, () => 0.5);
  assert.ok(q, '应能出题');
  assert.ok(q.text.includes('______'));
  assert.ok(!q.text.includes('quickly'), '目标词必须被挖掉');
  assert.equal(q.cs.length, 4);
  assert.equal(new Set(q.cs.map((c) => c.toLowerCase())).size, 4, '选项不得重复');
  assert.equal(q.cs[q.right], 'quickly');
  assert.ok(q.explain.includes('原句'));
});

test('buildCloze: 目标词在句首（主语位）→ 不出题（红线：永不挖主语）', () => {
  const book = fakeBook();
  const word = {
    w: 'quickly', trans: [{ cn: '快速地' }],
    sents: [{ en: 'Quickly she ran to the store.', cn: '她飞快地跑向商店。' }],
  };
  assert.equal(eng.buildCloze(word, book.words, () => 0.5), null);
});

test('buildCloze: neverBlank 表中的词永不被挖', () => {
  const book = fakeBook();
  const word = {
    w: 'She', trans: [{ cn: '她' }], // 词书不会收代词，但防御性验证 neverBlank 生效
    sents: [{ en: 'the weather became She and dry.', cn: 'x' }],
  };
  assert.equal(eng.buildCloze(word, book.words, () => 0.5), null);
});

test('makeClozeQuestion: 真题优先路径返回合法题目', () => {
  const book = eng.normalizeBook({
    meta: {},
    words: [{
      w: 'absorb', trans: [{ pos: 'v', cn: '吸收' }],
      exams: [{ q: 'She was so ______ in her job.', cs: ['attracted', 'absorbed', 'drawn', 'concentrated'], right: 1, ex: 'be absorbed in 专注于' }],
    }],
  });
  const q = eng.makeClozeQuestion(book, eng.indexBook(book), () => 0); // rng<0.7 走真题
  assert.equal(q.text, 'She was so ______ in her job.');
  assert.equal(q.cs[q.right], 'absorbed');
  assert.ok(q.explain.includes('absorbed'));
});

/* ================= 背单词 SRS ================= */

test('gradeCard: 认识升档按间隔表排期，不认识降 2 档短间隔重现', () => {
  const now = 1_000_000_000_000;
  let c = eng.newCard(now);
  assert.equal(c.lv, 0);
  c = eng.gradeCard(c, true, now);
  assert.equal(c.lv, 1);
  assert.equal(c.due, now + CFG.english.srs.intervalsMs[1]);
  c = eng.gradeCard(c, true, now);
  assert.equal(c.lv, 2);
  c = eng.gradeCard(c, false, now);
  assert.equal(c.lv, 0);
  assert.equal(c.due, now + CFG.english.srs.lapseDelayMs);
  assert.equal(c.streak, 0);
  // 0 档答错不穿底
  c = eng.gradeCard(c, false, now);
  assert.equal(c.lv, 0);
  // 封顶不越界
  for (let i = 0; i < 20; i++) c = eng.gradeCard(c, true, now);
  assert.equal(c.lv, CFG.english.srs.intervalsMs.length - 1);
});

test('buildVocabQueue: 复习优先默认、每日新词限额、空进度可用', () => {
  const now = Date.now();
  const words = [
    { w: 'a', trans: [{ cn: '1' }] },
    { w: 'b', trans: [{ cn: '2' }] },
    { w: 'c', trans: [{ cn: '3' }] },
    { w: 'd', trans: [{ cn: '4' }] },
  ];
  const progress = {
    cards: {
      a: { lv: 2, due: now - 100, seen: 3, ok: 2, streak: 1 },
      b: { lv: 1, due: now + 999999, seen: 2, ok: 2, streak: 2 },
      c: { lv: 0, due: now - 500, seen: 1, ok: 0, streak: 0 },
    },
    daily: {},
  };
  const q = eng.buildVocabQueue(progress, words, now, { dailyNew: 2 });
  assert.deepEqual(q.queue.map((x) => x.word.w), ['c', 'a', 'd']); // 复习按 due 升序在前，新词殿后
  assert.equal(q.reviewLeft, 2);
  assert.equal(q.newLeft, 1);
  const empty = eng.buildVocabQueue(null, words, now, { dailyNew: 2 });
  assert.equal(empty.reviewLeft, 0);
  assert.equal(empty.queue.filter((x) => x.isNew).length, 2);
});

test('buildVocabQueue: 比例交错，一侧耗尽由另一侧补齐', () => {
  const now = Date.now();
  const mk = (ws, due) => ws.map((w) => ({ w, trans: [{ cn: w }] }));
  const words = mk(['r1', 'r2', 'r3', 'r4', 'n1', 'n2', 'n3']);
  const cards = {};
  for (const w of ['r1', 'r2', 'r3', 'r4']) cards[w] = { lv: 1, due: now - 1, seen: 1, ok: 1, streak: 1 };
  const progress = { cards, daily: {} };
  const seq = (ratio) => eng.buildVocabQueue(progress, words, now, { dailyNew: 3, ratio })
    .queue.map((x) => (x.isNew ? 'N' : 'R')).join('');
  assert.equal(seq('1:1'), 'RNRNRNR'); // 1 复习 1 新词交错，复习多 1 个收尾
  assert.equal(seq('3:1'), 'RRRNRNN'); // 3 复习 1 新词，一侧耗尽后由另一侧补齐
  assert.equal(seq('review-first'), 'RRRRNNN');
});

test('todayKey: 本地日期 YYYY-MM-DD', () => {
  assert.match(eng.todayKey(new Date(2026, 8, 10, 23, 59).getTime()), /^2026-09-10$/);
});

/* ================= 翻译出题 ================= */

test('makeTranslationQuestion: 双向出题且 prompt/answer 成对', () => {
  const book = fakeBook();
  const word = { w: 'x', trans: [{ cn: 'x' }], sents: [{ en: 'The sky is blue today.', cn: '今天天空是蓝色的。' }] };
  const b2 = eng.normalizeBook({ meta: {}, words: [word, ...book.words] });
  const q = eng.makeTranslationQuestion(b2, () => 0);
  assert.ok(q);
  if (q.direction === 'zh2en') assert.equal(q.prompt, '今天天空是蓝色的。');
  else assert.equal(q.prompt, 'The sky is blue today.');
  assert.equal(eng.makeTranslationQuestion(eng.normalizeBook({ meta: {}, words: [{ w: 'a', trans: [{ cn: 'b' }] }] }), () => 0), null);
});

/* ================= 偏好 v2 / 进度清洗 / 打卡 / 积分段位 ================= */

test('sanitizePrefs v2: 新字段默认与夹取', () => {
  const d = eng.sanitizePrefs(null);
  assert.equal(d.soft, true);
  assert.equal(d.useChoice, true);
  assert.equal(d.useSpell, true);
  assert.equal(d.ratio, CFG.english.defaultRatio);
  assert.equal(d.reminderMin, CFG.english.reminder.defaultMin);
  const s = eng.sanitizePrefs({ dailyNew: 999, ratio: '1:1', reminderMin: 30, soft: false, useSpell: false });
  assert.equal(s.dailyNew, CFG.english.dailyNewMax);
  assert.equal(s.ratio, '1:1');
  assert.equal(s.reminderMin, 30);
  assert.equal(s.soft, false);
  assert.equal(s.useSpell, false);
});

test('normalizeProgress: v1 数字 daily 兼容、旧记录裁剪、卡键小写', () => {
  const now = Date.now();
  const d30 = eng.todayKey(now - 30 * 86400e3);
  const d89 = eng.todayKey(now - 89 * 86400e3);
  const d91 = eng.todayKey(now - 91 * 86400e3);
  const p = eng.normalizeProgress({
    cards: { 'Apple': { lv: 1, due: now } },
    daily: { [d30]: 5, [d91]: 9 },
    history: { [d89]: 40, [d91]: 80, bad: 'x' },
  }, now);
  assert.deepEqual(p.cards['apple'], { lv: 1, due: now });
  assert.deepEqual(p.daily[d30], { new: 5 });
  assert.equal(p.daily[d91], undefined);
  assert.equal(p.history[d89], 40);
  assert.equal(p.history[d91], undefined);
});

test('computeStreak: 今天没学不断签，按昨天往回连数', () => {
  const now = new Date(2026, 8, 11, 9, 0).getTime(); // 2026-09-11 09:00
  const k = (offsetDays) => eng.todayKey(now - offsetDays * 86400e3);
  const daily = { [k(1)]: { new: 3 }, [k(2)]: { new: 1, review: 2 }, [k(4)]: { new: 1 } };
  assert.equal(eng.computeStreak(daily, now), 2); // 昨天+前天，第3天空缺
  daily[k(0)] = { review: 1 };
  assert.equal(eng.computeStreak(daily, now), 3);
  assert.equal(eng.computeStreak({}, now), 0);
});

test('addHistoryPts: 按天封顶，只计入剩余额度', () => {
  const now = Date.now();
  const progress = { history: {} };
  assert.equal(eng.addHistoryPts(progress, 60, now), 60);
  assert.equal(eng.addHistoryPts(progress, 60, now), 20); // 封顶 80，只计入 20
  assert.equal(eng.addHistoryPts(progress, -5, now), 0);
  assert.equal(progress.history[eng.todayKey(now)], 80);
});

test('checkGoalBonus: 达标一次性奖励，幂等', () => {
  const now = Date.now();
  const progress = { daily: {}, history: {} };
  const k = eng.todayKey(now);
  progress.daily[k] = { new: 5, review: 0 };
  assert.equal(eng.checkGoalBonus(progress, 5, now), true);
  assert.equal(progress.history[k], CFG.english.rank.goalBonus);
  assert.equal(eng.checkGoalBonus(progress, 5, now), false);
  assert.equal(progress.history[k], CFG.english.rank.goalBonus);
});

test('computeRank: 加权窗口与段位，长期不学自然衰减', () => {
  const now = Date.now();
  const k = (d) => eng.todayKey(now - d * 86400e3);
  const history = { [k(10)]: 80, [k(40)]: 40, [k(80)]: 40 };
  // 80*1 + 40*0.5 + 40*0.25 = 110 → A1(30) 档，距 A2(120) 差 10
  const r = eng.computeRank(history, now);
  assert.equal(r.score, 110);
  assert.equal(r.tierName, 'A1 入门');
  assert.equal(r.nextName, 'A2 基础');
  // 90 天后全部出窗 → 未评级
  const r2 = eng.computeRank(history, now + 95 * 86400e3);
  assert.equal(r2.score, 0);
  assert.equal(r2.tierName, '未评级');
  assert.equal(r2.nextAt, 30);
});

/* ================= 四选一 / 拼写 / 小测 ================= */

test('makeVocabChoice: 两个方向都是 4 个不重复选项且答案可定位', () => {
  const book = fakeBook();
  const word = book.words.find((w) => w.w === 'apple');
  for (const force of ['en2zh', 'zh2en']) {
    const q = eng.makeVocabChoice(word, book.words, () => 0.4, force);
    assert.equal(q.direction, force);
    assert.equal(q.cs.length, 4);
    assert.equal(new Set(q.cs).size, 4);
    assert.equal(q.cs[q.right], q.answer);
    if (force === 'en2zh') assert.equal(q.prompt, 'apple');
    else assert.ok(q.prompt.includes('苹果'));
  }
});

test('maskWord / checkSpelling: 遮罩与忽略大小写标点的判分', () => {
  assert.equal(eng.maskWord('apple', 2), 'ap___');
  assert.equal(eng.maskWord("it's", 0), "__'_");
  assert.equal(eng.maskWord('ok', 5), 'ok');
  assert.equal(eng.checkSpelling('Apple', ' apple '), true);
  assert.equal(eng.checkSpelling("don't", 'dont'), true);
  assert.equal(eng.checkSpelling('apple', 'app'), false);
});

test('makeMiniQuiz: 混合题型、限量、全关返回 null', () => {
  const book = fakeBook();
  const words = ['apple', 'banana', 'cat', 'dog'].map((w) => ({ w, trans: [{ pos: 'n', cn: w + '的中文释义' }] }));
  const quiz = eng.makeMiniQuiz(words, book.words, () => 0.3, 6, true, true);
  assert.equal(quiz.length, 4); // 词只有 4 个
  assert.ok(quiz.every((q) => q.type === 'choice' || q.type === 'spell'));
  const onlySpell = eng.makeMiniQuiz(words, book.words, () => 0.3, 6, false, true);
  assert.ok(onlySpell.every((q) => q.type === 'spell'));
  assert.equal(eng.makeMiniQuiz(words, book.words, () => 0.3, 6, false, false), null);
});
