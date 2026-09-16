'use strict';
/**
 * 学英语窗口（翻译练习 / 选词填空 / 背单词 / 学习统计）。
 * 业务规则都在 shared/english.js 纯函数里；本文件只做状态管理、渲染与 IPC。
 * 数据：词书 english:loadBook(level)；SRS 进度 english:progress:*（data/english/progress.json）；
 * 偏好（难度/主题/柔和/每日新词/比例/题型/催背频率）english:prefs:*（settings.json 的 english 字段）。
 * 所有 IPC 调用都兜底失败（比如主进程无此 handler），保证窗口总能打开。
 */
const { ipcRenderer } = require('electron');
const { CFG } = require('../shared/config');
const eng = require('../shared/english');

const $ = (id) => document.getElementById(id);
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a).catch(() => null);
const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

/* 主题预设（与 english.css 的 body[data-theme=…] 一一对应；bg 仅用于色板预览） */
const THEMES = [
  { id: 'aurora', name: '极光', bg: 'linear-gradient(160deg,#5b7cfa,#8a5bd6 52%,#4fc3f7)' },
  { id: 'sunset', name: '日落', bg: 'linear-gradient(160deg,#ff9a56,#ff6a88 52%,#ffc46b)' },
  { id: 'mint', name: '薄荷', bg: 'linear-gradient(160deg,#2fbf71,#21b8a6 52%,#7ce7a2)' },
  { id: 'sakura', name: '樱粉', bg: 'linear-gradient(160deg,#f78fb3,#c471ed 52%,#fbc2eb)' },
  { id: 'night', name: '暗夜', bg: 'linear-gradient(160deg,#241a52,#12122b 52%,#3d1e63)' },
  { id: 'graphite', name: '石墨', bg: 'linear-gradient(160deg,#43484d,#23272b 52%,#5a6167)' },
];
const RATIO_LABELS = { 'review-first': '复习优先', '3:1': '3 : 1', '2:1': '2 : 1', '1:1': '1 : 1', '1:2': '1 : 2' };

const st = {
  prefs: eng.createDefaultPrefs(),
  book: null,   // normalizeBook 后的当前词书
  idx: null,    // 词书索引（真题词/例句词）
  tab: 'translate',
  tr: { cur: null, done: 0, ok: 0 },
  cz: { cur: null, answered: false, done: 0, ok: 0 },
  vb: {
    queue: [], cur: null,
    totalNew: 20, leftNew: 0, totalReview: 0, leftReview: 0,
    sessionGraded: 0, sessionWords: [], ttsOk: false, starOnly: false,
  },
  progress: null,
};

/* ================= 偏好 ================= */

async function loadPrefs() {
  const raw = await call('english:prefs:load');
  st.prefs = eng.sanitizePrefs(raw);
}
function savePrefs() { void call('english:prefs:save', st.prefs); }

function applyTheme() {
  document.body.dataset.theme = st.prefs.theme;
  document.querySelectorAll('.sw').forEach((el) => el.classList.toggle('on', el.dataset.t === st.prefs.theme));
}
function applySoft() {
  document.body.dataset.soft = st.prefs.soft ? '1' : '0';
  document.querySelectorAll('#setSoft button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === st.prefs.soft));
}

/* ================= 难度 ================= */

function renderLevelBar() {
  const bar = $('levelBar');
  bar.textContent = '';
  for (const l of CFG.english.levels) {
    const b = h('button', 'chip' + (l.id === st.prefs.level ? ' on' : ''), l.label);
    b.dataset.level = l.id;
    b.addEventListener('click', () => { if (l.id !== st.prefs.level) void loadLevel(l.id); });
    bar.appendChild(b);
  }
}

async function loadLevel(level) {
  st.prefs.level = level;
  savePrefs();
  renderLevelBar();
  const raw = await call('english:loadBook', level);
  st.book = eng.normalizeBook(raw);
  st.idx = st.book ? eng.indexBook(st.book) : null;
  // 会话统计与队列全部随难度重置
  st.tr = { cur: null, done: 0, ok: 0 };
  st.cz = { cur: null, answered: false, done: 0, ok: 0 };
  st.vb = { queue: [], cur: null, totalNew: st.prefs.dailyNew, leftNew: 0, totalReview: 0, leftReview: 0, sessionGraded: 0, sessionWords: [], ttsOk: st.vb.ttsOk, starOnly: st.vb.starOnly };
  const empty = !st.book;
  $('emptyTip').hidden = !empty;
  for (const id of ['tab-translate', 'tab-cloze', 'tab-vocab', 'tab-stats']) {
    $(id).style.visibility = empty ? 'hidden' : 'visible';
  }
  if (empty) return;
  newTranslationQuestion();
  newClozeQuestion();
  await rebuildVocabQueue();
}

/* ================= Tab 切换 ================= */

function switchTab(name) {
  st.tab = name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `tab-${name}`);
  if (name === 'translate') $('trInput').focus();
  if (name === 'stats') renderStats();
}

/* ================= 翻译练习 ================= */

function newTranslationQuestion() {
  const q = st.book ? eng.makeTranslationQuestion(st.book, Math.random) : null;
  st.tr.cur = q;
  $('trVerdict').hidden = true;
  $('trInput').value = '';
  if (!q) {
    $('trDir').textContent = '—';
    $('trWord').textContent = '';
    $('trPrompt').textContent = '这本书暂无可用的例句';
    return;
  }
  $('trDir').textContent = q.direction === 'zh2en' ? '中 → 英' : '英 → 中';
  $('trWord').textContent = `出处：${q.word}`;
  $('trPrompt').textContent = q.prompt;
  refreshTrStat();
  $('trInput').focus();
}

function refreshTrStat() {
  $('trStat').textContent = st.tr.done ? `已练 ${st.tr.done} 题 · 命中 ${st.tr.ok}` : '';
}

function submitTranslation() {
  const q = st.tr.cur;
  if (!q) return;
  const input = $('trInput').value.trim();
  if (!input) { $('trInput').focus(); return; }
  const r = eng.judgeTranslation(input, q.answer, q.direction);
  st.tr.done += 1;
  if (r.verdict === 'correct') st.tr.ok += 1;
  const v = $('trVerdict');
  v.hidden = false;
  v.className = 'card verdict ' + (r.verdict === 'correct' ? 'ok' : r.verdict === 'close' ? 'warn' : 'bad');
  $('trVTitle').textContent =
    r.verdict === 'correct' ? '✅ 回答正确！' :
    r.verdict === 'close' ? `🤔 很接近（匹配度 ${Math.round(r.score * 100)}%）` :
    `❌ 还差一点（匹配度 ${Math.round(r.score * 100)}%）`;
  const ref = `参考答案：${q.answer}`;
  $('trVAns').textContent = r.verdict === 'correct' ? ref : `${ref}\n你的答案：${input}`;
  refreshTrStat();
}

/* ================= 选词填空 ================= */

function newClozeQuestion() {
  const q = st.book ? eng.makeClozeQuestion(st.book, st.idx, Math.random) : null;
  st.cz.cur = q;
  st.cz.answered = false;
  $('czVerdict').hidden = true;
  $('czNext').hidden = true;
  const box = $('czChoices');
  box.textContent = '';
  if (!q) {
    $('czSrc').textContent = '—';
    $('czWord').textContent = '';
    $('czPrompt').textContent = '这本书暂无可出题的素材';
    refreshCzStat();
    return;
  }
  const real = st.book.words.some((w) => w.w === q.word && Array.isArray(w.exams) && w.exams.length &&
    w.exams.some((e) => e.q === q.text));
  $('czSrc').textContent = real ? '真题' : '智能出题';
  $('czWord').textContent = `考点：${q.word}`;
  $('czPrompt').textContent = q.text;
  q.cs.forEach((c, i) => {
    const b = h('button', 'opt');
    b.appendChild(h('span', 'key', 'ABCD'[i]));
    b.appendChild(h('span', null, c));
    b.addEventListener('click', () => answerCloze(i));
    box.appendChild(b);
  });
  refreshCzStat();
}

function answerCloze(i) {
  const q = st.cz.cur;
  if (!q || st.cz.answered) return;
  st.cz.answered = true;
  st.cz.done += 1;
  const right = i === q.right;
  if (right) st.cz.ok += 1;
  document.querySelectorAll('#czChoices .opt').forEach((el, j) => {
    el.disabled = true;
    if (j === q.right) el.classList.add('right');
    else if (j === i) el.classList.add('wrong');
    else el.classList.add('dim');
  });
  const v = $('czVerdict');
  v.hidden = false;
  v.className = 'card verdict ' + (right ? 'ok' : 'bad');
  $('czVTitle').textContent = right ? '✅ 答对了！' : `❌ 正确答案：${q.cs[q.right]}`;
  $('czVAns').textContent = q.explain || '';
  $('czNext').hidden = false;
  refreshCzStat();
}

function refreshCzStat() {
  $('czStat').textContent = st.cz.done ? `已答 ${st.cz.done} 题 · 答对 ${st.cz.ok}` : '';
}

/* ================= 背单词：队列与进度 ================= */

async function rebuildVocabQueue() {
  const raw = await call('english:progress:load');
  st.progress = eng.normalizeProgress(raw);
  const now = Date.now();
  const q = eng.buildVocabQueue(st.progress, st.book.words, now, { dailyNew: st.prefs.dailyNew, ratio: st.prefs.ratio });
  let items = q.queue.map((x) => ({
    type: 'word', word: x.word, card: x.card, isNew: x.isNew, consumedNew: false,
    phase: x.isNew ? 'card' : (st.prefs.useChoice ? 'choice' : 'grade'),
    choice: null, spell: null,
  }));
  // 生词本模式：只出带 ☆ 标记的到期复习卡，不出新词
  if (st.vb.starOnly) {
    items = items.filter((x) => !x.isNew && x.card && x.card.star);
  }
  st.vb.queue = items;
  st.vb.totalReview = st.vb.starOnly ? items.length : q.reviewLeft;
  st.vb.leftReview = st.vb.totalReview;
  st.vb.totalNew = st.vb.starOnly ? 0 : q.dailyNew;
  st.vb.leftNew = st.vb.starOnly ? 0 : q.newLeft;
  st.vb.sessionGraded = 0;
  st.vb.sessionWords = [];
  renderVbModes();
  showNextVocab();
}

/** 出卡范围切换：全部 / 只背生词本★ */
function renderVbModes() {
  const host = $('vbModes');
  if (!host || !st.book) return;
  host.textContent = '';
  const mk = (label, on, fn) => {
    const c = h('button', 'chip' + (on ? ' on' : ''), label);
    c.addEventListener('click', fn);
    return c;
  };
  const starCount = Object.values(st.progress.cards).filter((c) => c && c.star).length;
  host.appendChild(mk('全部', !st.vb.starOnly, () => {
    if (!st.vb.starOnly) return;
    st.vb.starOnly = false;
    void rebuildVocabQueue();
  }));
  host.appendChild(mk(`只背生词本 ★${starCount}`, st.vb.starOnly, () => {
    if (st.vb.starOnly) return;
    st.vb.starOnly = true;
    void rebuildVocabQueue();
  }));
}

function refreshVbStat() {
  if (!st.book) { $('vbStat').textContent = ''; return; }
  const busy = st.vb.queue.length || st.vb.cur;
  const prefix = st.vb.starOnly ? '生词本模式 · ' : '';
  $('vbStat').textContent = busy
    ? `${prefix}待复习 ${st.vb.leftReview} · 今日新词还可学 ${st.vb.leftNew}/${st.vb.totalNew}` +
      (st.progress ? ` · 连续打卡 ${eng.computeStreak(st.progress.daily)} 天` : '')
    : st.vb.starOnly
      ? '生词本里暂时没有到期的词'
      : '今天的学习任务全部完成，明天再来吧 🎉';
}

function showNextVocab() {
  st.vb.cur = st.vb.queue.shift() || null;
  renderVocab();
}

/** 记一次卡的结果：SRS 排期 + 当日计数 + 积分 + 目标奖励，然后落盘。 */
function recordActivity(item, known) {
  const now = Date.now();
  const key = item.word.w.toLowerCase();
  const base = st.progress.cards[key] || eng.newCard(now);
  st.progress.cards[key] = eng.gradeCard(base, known, now);
  const k = eng.todayKey(now);
  const rec = st.progress.daily[k] || (st.progress.daily[k] = { new: 0, review: 0 });
  let pts = 0;
  if (item.isNew && !item.consumedNew) {
    item.consumedNew = true;
    rec.new += 1;
    st.vb.leftNew = Math.max(0, st.vb.leftNew - 1);
    pts = CFG.english.rank.ptsPerNew;
  } else if (!item.isNew) {
    rec.review += 1;
    st.vb.leftReview = Math.max(0, st.vb.leftReview - 1);
    if (known) pts = CFG.english.rank.ptsPerReviewOk;
    else st.progress.cards[key].wrong = (st.progress.cards[key].wrong || 0) + 1;
  }
  const gained = eng.addHistoryPts(st.progress, pts, now);
  if (gained > 0) showToast(`积分 +${gained}`);
  if (eng.checkGoalBonus(st.progress, st.prefs.dailyNew, now)) showToast(`🎉 今日目标达成，积分 +${CFG.english.rank.goalBonus}`);
  void call('english:progress:save', st.progress);
}

/** 一张卡完成（新词学会或复习打分）后推进：会话计数 → 可能插一轮小测 → 下一张。 */
function advance(item) {
  st.vb.sessionGraded += 1;
  st.vb.sessionWords.push(item.word);
  if (st.vb.sessionGraded % CFG.english.quiz.everyGraded === 0 && (st.prefs.useChoice || st.prefs.useSpell)) {
    const recent = st.vb.sessionWords.slice(-10);
    if (recent.length >= 4) {
      const qs = eng.makeMiniQuiz(recent, st.book.words, Math.random, CFG.english.quiz.size, st.prefs.useChoice, st.prefs.useSpell);
      if (qs && qs.length) st.vb.queue.unshift({ type: 'quiz', questions: qs, idx: 0, correct: 0 });
    }
  }
  showNextVocab();
}

/* ================= 背单词：渲染 ================= */

/** 通用：单词卡（word/phone/释义/例句/词组 + 发音/星标）。reveal=true 直接展开释义。 */
function buildWordCard(item, reveal) {
  const w = item.word;
  const card = h('div', 'card v-card');
  const head = h('div', 'v-head');
  const tts = h('button', 'tts-btn', '🔊');
  tts.title = '发音';
  tts.addEventListener('click', (e) => { e.stopPropagation(); speak(w.w); });
  const star = h('button', 'star-btn' + ((st.progress.cards[w.w.toLowerCase()] || {}).star ? ' on' : ''), '☆');
  star.title = '加入生词本';
  star.addEventListener('click', (e) => { e.stopPropagation(); toggleStar(item, star); });
  const wordEl = h('div', 'v-word', w.w);
  const phone = h('div', 'v-phone', [w.uk ? `英 ${w.uk}` : '', w.us ? `美 ${w.us}` : ''].filter(Boolean).join('  ·  '));
  head.append(tts, wordEl, star);
  card.append(head, phone);
  const more = h('div', 'v-more');
  more.hidden = !reveal;
  more.appendChild(h('div', 'v-defs', eng.formatDefs(w)));
  const s = (w.sents && w.sents[0]) || null;
  if (s) {
    const sent = h('div', 'v-sent');
    sent.appendChild(h('b', null, s.en));
    sent.appendChild(h('br'));
    sent.appendChild(document.createTextNode(s.cn));
    more.appendChild(sent);
  }
  const phrs = (w.phrs || []).slice(0, 3);
  if (phrs.length) more.appendChild(h('div', 'v-phrs', '词组：' + phrs.map((p) => `${p[0]}（${p[1]}）`).join('  ')));
  card.appendChild(more);
  if (!reveal) {
    card.appendChild(h('div', 'v-hint', '先想想意思，点击卡片看答案'));
    card.addEventListener('click', () => { more.hidden = false; card.querySelector('.v-hint')?.remove(); });
  }
  return card;
}

function choiceBlock(q, onPick) {
  const box = h('div', 'choices');
  q.cs.forEach((c, i) => {
    const b = h('button', 'opt');
    b.appendChild(h('span', 'key', 'ABCD'[i]));
    b.appendChild(h('span', null, c));
    b.addEventListener('click', () => onPick(i, b));
    box.appendChild(b);
  });
  return box;
}

function markChoice(box, q, picked) {
  box.querySelectorAll('.opt').forEach((el, j) => {
    el.disabled = true;
    if (j === q.right) el.classList.add('right');
    else if (j === picked) el.classList.add('wrong');
    else el.classList.add('dim');
  });
}

function renderVocab() {
  const host = $('vbBody');
  host.textContent = '';
  refreshVbStat();
  const cur = st.vb.cur;
  if (!cur) {
    const box = h('div', 'card done-box');
    box.appendChild(h('div', 'big', '🎉'));
    box.appendChild(h('div', 'txt', '今天的学习任务全部完成！'));
    box.appendChild(h('div', 'v-phone', '复习会按记忆间隔排期，明天再来吧'));
    host.appendChild(box);
    return;
  }
  if (cur.type === 'quiz') return renderQuiz(host, cur);
  if (cur.isNew) return renderLearn(host, cur);
  return renderReview(host, cur);
}

/* ---- 新词学习：翻卡 → 四选一 → 拼写 → 自动结卡 ---- */

function renderLearn(host, item) {
  if (item.phase === 'card') {
    host.appendChild(h('div', 'phase-tag', '新词'));
    const card = buildWordCard(item, false);
    host.appendChild(card);
    const row = h('div', 'row btn-row');
    const go = h('button', 'btn primary', '开始答题 →');
    go.addEventListener('click', () => {
      item.phase = st.prefs.useChoice ? 'choice' : (st.prefs.useSpell ? 'spell' : 'done');
      if (item.phase === 'done') { finishLearn(item); return; }
      renderVocab();
    });
    row.appendChild(go);
    host.appendChild(row);
    speak(item.word.w);
    return;
  }
  if (item.phase === 'choice') {
    host.appendChild(h('div', 'phase-tag', '新词 · 选对意思'));
    if (!item.choice) item.choice = eng.makeVocabChoice(item.word, st.book.words, Math.random, 'en2zh');
    const q = item.choice;
    if (!q) { item.phase = st.prefs.useSpell ? 'spell' : 'done'; if (item.phase === 'done') return finishLearn(item); return renderVocab(); }
    const card = h('div', 'card');
    const qt = h('div', 'q-title');
    qt.append('选出 ', h('b', null, q.prompt), ' 的意思');
    card.appendChild(qt);
    host.appendChild(card);
    const box = choiceBlock(q, (i, el) => {
      markChoice(box, q, i);
      if (i === q.right) showToast('答对了！');
      speak(item.word.w);
      const row = h('div', 'row btn-row');
      const next = h('button', 'btn primary', '继续');
      next.addEventListener('click', () => {
        item.phase = st.prefs.useSpell ? 'spell' : 'done';
        if (item.phase === 'done') return finishLearn(item);
        renderVocab();
      });
      row.appendChild(next);
      host.appendChild(row);
    });
    host.appendChild(box);
    speak(item.word.w);
    return;
  }
  if (item.phase === 'spell') return renderSpell(host, item, () => finishLearn(item));
}

/* ---- 复习：四选一自测 → 翻卡 → 认识 / 不认识 ---- */

function renderReview(host, item) {
  if (item.phase === 'choice') {
    host.appendChild(h('div', 'phase-tag', '复习 · 自测'));
    if (!item.choice) item.choice = eng.makeVocabChoice(item.word, st.book.words, Math.random);
    const q = item.choice;
    if (!q) { item.phase = 'grade'; return renderVocab(); }
    const card = h('div', 'card');
    const qt = h('div', 'q-title');
    qt.append('选出 ', h('b', null, q.prompt), ' 的意思');
    card.appendChild(qt);
    host.appendChild(card);
    const box = choiceBlock(q, (i) => {
      markChoice(box, q, i);
      const row = h('div', 'row btn-row');
      const next = h('button', 'btn primary', '看释义');
      next.addEventListener('click', () => { item.phase = 'grade'; renderVocab(); });
      row.appendChild(next);
      host.appendChild(row);
    });
    host.appendChild(box);
    if (q.direction === 'en2zh') speak(item.word.w);
    return;
  }
  // grade 阶段：展开释义 + 认识 / 不认识
  host.appendChild(h('div', 'phase-tag', '复习 · 还记得吗'));
  host.appendChild(buildWordCard(item, true));
  const row = h('div', 'row btn-row');
  const no = h('button', 'btn danger', '😵 不认识');
  const yes = h('button', 'btn primary', '😄 认识');
  no.addEventListener('click', () => finishReview(item, false));
  yes.addEventListener('click', () => finishReview(item, true));
  row.append(no, yes);
  host.appendChild(row);
  speak(item.word.w);
}

function finishReview(item, known) {
  recordActivity(item, known);
  advance(item);
}

function finishLearn(item) {
  showToast(`已学会「${item.word.w}」`);
  recordActivity(item, true);
  advance(item);
}

/* ---- 拼写（新词学习与小测共用） ---- */

function renderSpell(host, item, onDone, quizMode) {
  const w = item.word;
  if (!item.spell) item.spell = { reveal: 1, fails: 0, solved: false };
  const sp = item.spell;
  const defs = eng.formatShortDefs(w, 40);
  const card = h('div', 'card');
  card.appendChild(h('div', 'q-title', quizMode ? '拼写出这个单词' : '拼写出刚才的单词'));
  card.appendChild(h('div', 'v-defs', defs));
  const line = h('div', 'spell-line', eng.maskWord(w.w, sp.solved ? w.w.length : sp.reveal));
  card.appendChild(line);
  const input = h('input', 'spell-input');
  input.placeholder = '输入拼写，Enter 确认';
  input.spellcheck = false;
  card.appendChild(input);
  const row = h('div', 'row btn-row');
  const hint = h('button', 'btn slim', '提示');
  const skip = h('button', 'btn slim', '跳过');
  const ok = h('button', 'btn primary slim', '确认');
  row.append(hint, skip, ok);
  card.appendChild(row);
  host.appendChild(card);

  const finishReveal = () => {
    sp.solved = true;
    line.textContent = w.w;
    row.remove();
    input.disabled = true;
    if (quizMode) { setTimeout(() => onDone(), 900); return; } // 小测自动翻题，不加按钮（防双推进）
    const r2 = h('div', 'row btn-row');
    const next = h('button', 'btn primary', '继续');
    next.addEventListener('click', onDone);
    r2.appendChild(next);
    card.appendChild(r2);
  };
  const submit = () => {
    if (sp.solved) return;
    const v = input.value.trim();
    if (!v) return;
    if (eng.checkSpelling(w.w, v)) { finishReveal(); return; }
    sp.fails += 1;
    input.classList.remove('bad');
    void input.offsetWidth; // 重触发抖动动画
    input.classList.add('bad');
    if (sp.fails >= 3) { showToast(`正确拼写：${w.w}`); finishReveal(); }
  };
  hint.addEventListener('click', () => {
    sp.reveal = Math.min(w.w.replace(/[^a-zA-Z]/g, '').length, sp.reveal + 1);
    line.textContent = eng.maskWord(w.w, sp.solved ? w.w.length : sp.reveal);
    input.focus();
  });
  skip.addEventListener('click', () => { showToast(`正确拼写：${w.w}`); finishReveal(); });
  ok.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => input.focus(), 50);
}

/* ---- 组内小测 ---- */

function renderQuiz(host, cur) {
  if (cur.idx >= cur.questions.length) {
    const pass = cur.correct >= CFG.english.rank.quizPassCorrect;
    const pts = eng.addHistoryPts(st.progress, pass ? CFG.english.rank.quizBonus : 2);
    void call('english:progress:save', st.progress);
    const box = h('div', 'card done-box');
    box.appendChild(h('div', 'big', cur.correct >= cur.questions.length ? '🏆' : pass ? '👍' : '💪'));
    box.appendChild(h('div', 'txt', `小测完成 ${cur.correct}/${cur.questions.length}`));
    box.appendChild(h('div', 'v-phone', pts > 0 ? `积分 +${pts}` : '继续加油！'));
    const row = h('div', 'row btn-row');
    const next = h('button', 'btn primary', '继续背单词');
    next.addEventListener('click', () => showNextVocab());
    row.appendChild(next);
    box.appendChild(row);
    host.appendChild(box);
    return;
  }
  const q = cur.questions[cur.idx];
  host.appendChild(h('div', 'phase-tag', `小测 ${cur.idx + 1}/${cur.questions.length}`));
  const nextQ = () => { cur.idx += 1; renderVocab(); };
  if (q.type === 'choice') {
    const card = h('div', 'card');
    const qt = h('div', 'q-title');
    qt.append('选出 ', h('b', null, q.prompt), ' 的意思');
    card.appendChild(qt);
    host.appendChild(card);
    const box = choiceBlock(q, (i) => {
      markChoice(box, q, i);
      if (i === q.right) cur.correct += 1;
      if (q.direction === 'en2zh') speak(q.prompt);
      setTimeout(nextQ, 800);
    });
    host.appendChild(box);
  } else {
    const item = { word: st.book.words.find((x) => x.w === q.word) || { w: q.word, trans: [{ cn: q.prompt }] } };
    host.appendChild(h('div', 'card v-phone', '这个词你刚学过：'));
    renderSpell(host, { word: item.word, spell: { reveal: 1, fails: 0, solved: false } }, () => {
      cur.correct += 1;
      nextQ();
    }, true);
    // 拼写答对/跳过都会走 onDone 计一次正确（小测以曝光巩固为主）
  }
}

/* ---- 发音（系统离线 TTS，无英文音色时按钮自动隐藏） ---- */

function initTts() {
  if (!('speechSynthesis' in window)) return;
  const check = () => {
    let ok = false;
    try { ok = speechSynthesis.getVoices().some((v) => /^en/i.test(v.lang || '')); } catch { ok = false; }
    if (ok !== st.vb.ttsOk) {
      st.vb.ttsOk = ok;
      document.body.classList.toggle('tts-ok', ok);
      if (st.tab === 'vocab') renderVocab();
    }
  };
  check();
  if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', check);
  else speechSynthesis.onvoiceschanged = check;
  setTimeout(check, 900);
}

function speak(text) {
  if (!st.vb.ttsOk) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'en-US';
    u.rate = 0.9;
    speechSynthesis.speak(u);
  } catch { /* 无音色/被系统禁用就算了 */ }
}

function toggleStar(item, btn) {
  const key = item.word.w.toLowerCase();
  const now = Date.now();
  const card = st.progress.cards[key] || eng.newCard(now);
  card.star = !card.star;
  if (!card.star) delete card.star;
  st.progress.cards[key] = card;
  btn.classList.toggle('on', !!card.star);
  btn.textContent = card.star ? '★' : '☆';
  void call('english:progress:save', st.progress);
  showToast(card.star ? '已加入生词本 ★' : '已移出生词本');
}

/* ================= 学习统计 ================= */

function renderStats() {
  const host = $('statsBody');
  host.textContent = '';
  if (!st.progress || !st.book) return;
  const now = Date.now();
  const k = eng.todayKey(now);
  const rec = st.progress.daily[k] || { new: 0, review: 0 };
  const rank = eng.computeRank(st.progress.history, now);
  const streak = eng.computeStreak(st.progress.daily, now);
  const cards = Object.values(st.progress.cards);
  const starCount = cards.filter((c) => c && c.star).length;
  const hardCount = cards.filter((c) => c && (c.wrong || 0) >= 2).length;
  const todayPts = st.progress.history[k] || 0;

  // 段位卡
  const rankCard = h('div', 'card rank-hero');
  rankCard.appendChild(h('div', 'rank-tier', rank.tierName));
  rankCard.appendChild(h('div', 'rank-score', `近三个月积分 ${rank.score}`));
  const bar = h('div', 'rank-bar');
  const fill = h('i');
  fill.style.width = `${Math.round(rank.pct * 100)}%`;
  bar.appendChild(fill);
  rankCard.appendChild(bar);
  rankCard.appendChild(h('div', 'rank-next', rank.nextName
    ? `距离「${rank.nextName}」还差 ${rank.nextAt - rank.score} 分`
    : '已是最高段位，保持住！'));
  rankCard.appendChild(h('div', 'rank-note',
    '积分只统计最近 90 天：30 天内全额计入，30–60 天按一半，60–90 天按四分之一——长期不背会自然掉分。'));
  host.appendChild(rankCard);

  // 今日卡
  const today = h('div', 'card');
  const grid = h('div', 'stat-grid');
  const cell = (num, lbl) => {
    const c = h('div', 'stat-cell');
    c.appendChild(h('div', 'num', String(num)));
    c.appendChild(h('div', 'lbl', lbl));
    return c;
  };
  grid.append(
    cell(`${rec.new || 0}/${st.prefs.dailyNew}`, '今日新词'),
    cell(rec.review || 0, '今日复习'),
    cell('+' + todayPts, '今日积分'),
    cell(streak, '连续打卡(天)')
  );
  today.appendChild(grid);
  host.appendChild(today);

  // 近 7 天柱状
  const week = h('div', 'card');
  week.appendChild(h('div', 'tp-sec', '近 7 天学习量'));
  const bars = h('div', 'week-bars');
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const t = new Date(now - i * 86400e3);
    const r = st.progress.daily[eng.todayKey(t.getTime())] || {};
    days.push({ label: '日一二三四五六'[t.getDay()], n: (r.new || 0) + (r.review || 0), today: i === 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  for (const d of days) {
    const col = h('div', 'col' + (d.today ? ' today' : ''));
    col.appendChild(h('div', 'n', d.n ? String(d.n) : ''));
    const b = h('div', 'bar');
    b.style.height = `${Math.max(4, Math.round((d.n / max) * 64))}px`;
    col.appendChild(b);
    col.appendChild(h('div', 'd', d.label));
    bars.appendChild(col);
  }
  week.appendChild(bars);
  host.appendChild(week);

  // 生词本 / 易错词
  const misc = h('div', 'card');
  const g2 = h('div', 'stat-grid');
  g2.append(cell(starCount, '生词本'), cell(hardCount, '易错词(错≥2次)'), cell(cards.length, '累计学过词'), cell(Object.keys(st.progress.daily).length, '累计学习天数'));
  misc.appendChild(g2);
  host.appendChild(misc);
}

/* ================= 设置面板 ================= */

function renderSwatches() {
  const box = $('tpSwatches');
  box.textContent = '';
  for (const t of THEMES) {
    const b = h('button', 'sw' + (t.id === st.prefs.theme ? ' on' : ''));
    b.dataset.t = t.id;
    b.style.background = t.bg;
    b.title = t.name;
    b.appendChild(h('span', 'nm', t.name));
    b.addEventListener('click', () => {
      st.prefs.theme = t.id;
      savePrefs();
      applyTheme();
    });
    box.appendChild(b);
  }
}

function fillSelect(sel, values, labels, current, onPick) {
  sel.textContent = '';
  for (const v of values) {
    const o = h('option', null, labels(v));
    o.value = String(v);
    if (String(v) === String(current)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onPick(sel.value));
}

function syncSettingsUI() {
  applySoft();
  $('setDaily').value = String(st.prefs.dailyNew);
  $('setDailyV').textContent = String(st.prefs.dailyNew);
  $('setRatio').value = st.prefs.ratio;
  $('setRemind').value = String(st.prefs.reminderMin);
  $('setChoice').checked = st.prefs.useChoice;
  $('setSpell').checked = st.prefs.useSpell;
}

function bindSettings() {
  for (const b of document.querySelectorAll('#setSoft button')) {
    b.addEventListener('click', () => {
      st.prefs.soft = b.dataset.v === '1';
      savePrefs();
      applySoft();
    });
  }
  $('setDaily').addEventListener('input', (e) => {
    st.prefs.dailyNew = Number(e.target.value) || st.prefs.dailyNew;
    $('setDailyV').textContent = String(st.prefs.dailyNew);
  });
  $('setDaily').addEventListener('change', () => {
    savePrefs();
    if (st.book) void rebuildVocabQueue(); // 新目标立刻生效
  });
  fillSelect($('setRatio'), CFG.english.ratios, (v) => RATIO_LABELS[v] || v, st.prefs.ratio, (v) => {
    st.prefs.ratio = v;
    savePrefs();
    if (st.book) void rebuildVocabQueue();
  });
  $('setChoice').addEventListener('change', (e) => { st.prefs.useChoice = e.target.checked; savePrefs(); });
  $('setSpell').addEventListener('change', (e) => { st.prefs.useSpell = e.target.checked; savePrefs(); });
  fillSelect($('setRemind'), CFG.english.reminder.choicesMin,
    (m) => (!m ? '关闭' : m < 60 ? `每 ${m} 分钟` : `每 ${m / 60} 小时`),
    st.prefs.reminderMin, (v) => { st.prefs.reminderMin = Number(v); savePrefs(); });
}

/* ================= 词表浏览（搜索 + 详情 + 生词本标记） ================= */

function openList() {
  if (!st.book) return;
  $('listPanel').hidden = false;
  $('wlBack').hidden = true;
  $('wlSearchRow').style.display = '';
  $('wlSearch').value = '';
  renderList('');
  setTimeout(() => $('wlSearch').focus(), 60);
}

function renderList(query) {
  $('wlBack').hidden = true;
  $('wlSearchRow').style.display = '';
  const body = $('wlBody');
  body.textContent = '';
  const q = String(query || '').trim().toLowerCase();
  const hits = st.book.words.filter((w) => w.w.toLowerCase().includes(q)).slice(0, 80);
  $('wlCount').textContent = `${hits.length}${hits.length >= 80 ? '+' : ''} / ${st.book.words.length} 词`;
  if (!hits.length) {
    body.appendChild(h('div', 'wl-empty', '没有匹配的单词'));
    return;
  }
  const list = h('div', 'wl-list');
  for (const w of hits) {
    const card = st.progress.cards[w.w.toLowerCase()];
    const row = h('button', 'wl-item');
    row.appendChild(h('span', 'w', w.w));
    row.appendChild(h('span', 'd', eng.formatShortDefs(w, 30)));
    if (card && card.star) row.appendChild(h('span', 'wl-badge star', '★ 生词本'));
    else if (card && (card.wrong || 0) >= 2) row.appendChild(h('span', 'wl-badge hard', '易错'));
    else if (card) row.appendChild(h('span', 'wl-badge seen', '已学'));
    row.addEventListener('click', () => renderDetail(w));
    list.appendChild(row);
  }
  body.appendChild(list);
}

function renderDetail(word) {
  const body = $('wlBody');
  body.textContent = '';
  $('wlBack').hidden = false;
  $('wlSearchRow').style.display = 'none';
  const item = { word, card: st.progress.cards[word.w.toLowerCase()] || null, isNew: false, consumedNew: false, phase: 'detail', choice: null, spell: null };
  const card = buildWordCard(item, true);
  card.classList.add('v-card');
  body.appendChild(card);
  speak(word.w);
}

/* ================= Toast ================= */

let toastTimer = 0;
function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

/* ================= 事件绑定与启动 ================= */

function bind() {
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => switchTab(b.dataset.tab));
  // 翻译
  $('trSubmit').addEventListener('click', submitTranslation);
  $('trNext').addEventListener('click', newTranslationQuestion);
  $('trInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitTranslation(); }
  });
  // 填空
  $('czNext').addEventListener('click', newClozeQuestion);
  // 设置
  $('gearBtn').addEventListener('click', () => { syncSettingsUI(); $('themePanel').hidden = false; });
  $('tpClose').addEventListener('click', () => { $('themePanel').hidden = true; });
  $('themePanel').addEventListener('click', (e) => { if (e.target === $('themePanel')) $('themePanel').hidden = true; });
  // 词表
  $('listBtn').addEventListener('click', openList);
  $('wlClose').addEventListener('click', () => { $('listPanel').hidden = true; });
  $('listPanel').addEventListener('click', (e) => { if (e.target === $('listPanel')) $('listPanel').hidden = true; });
  $('wlBack').addEventListener('click', () => renderList($('wlSearch').value));
  $('wlSearch').addEventListener('input', (e) => renderList(e.target.value));
  $('wlSearch').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('listPanel').hidden = true; });
  // 键盘：填空与背单词四选一的 1-4；Esc 关设置
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('themePanel').hidden = true; $('listPanel').hidden = true; return; }
    if (!['1', '2', '3', '4'].includes(e.key)) return;
    const i = Number(e.key) - 1;
    if (st.tab === 'cloze' && !st.cz.answered) {
      if (st.cz.cur && i < st.cz.cur.cs.length) answerCloze(i);
      return;
    }
    if (st.tab === 'vocab') {
      const opts = document.querySelectorAll('#vbBody .opt');
      if (opts[i]) opts[i].click();
    }
  });
}

(async () => {
  await loadPrefs();
  applyTheme();
  applySoft();
  renderSwatches();
  renderLevelBar();
  bind();
  bindSettings();
  initTts();
  await loadLevel(st.prefs.level);
})();
