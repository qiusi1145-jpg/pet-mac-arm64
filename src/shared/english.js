'use strict';
/**
 * 学英语（纯函数，可单测）：词书清洗、翻译判分、选词填空出题（真题优先/生成兜底）、
 * 背单词间隔重复（Leitner 简化）与队列构建。只做数据处理，不做 IO/IPC。
 *
 * 词书文件格式（data/english/words.<level>.json，由 _build.js 构建）：
 *   { meta:{level,label,count,builtAt}, words:[{
 *       w, us, uk,                       单词 + 美音/英音音标
 *       trans:[{pos,cn}],                词性 + 中文释义
 *       sents:[{en,cn}],                 例句 + 中文翻译
 *       exams?:[{q,cs:[4],right,ex}],    真题填空选择题（题干含 _，right 为 cs 下标）
 *       syn?:[{pos,ws:[...]}],           近义词
 *       phrs?:[[en,cn]],                 词组
 *       rels?:[[pos,word,cn]],           同根词
 *   }]}
 */
const { CFG } = require('./config');
const { clamp } = require('./util');

/* ================= 偏好与词书 ================= */

function createDefaultPrefs() {
  return {
    level: CFG.english.defaultLevel,
    theme: CFG.english.defaultTheme,
    soft: true,                                       // 柔和配色（默认开）
    dailyNew: CFG.english.srs.dailyNew,               // 每日新词目标
    ratio: CFG.english.defaultRatio,                  // 复习:新词 出卡比例
    reminderMin: CFG.english.reminder.defaultMin,     // 桌宠催背频率（0=关）
    useChoice: true,                                  // 四选一题型
    useSpell: true,                                   // 拼写题型
  };
}

/** 清洗持久化的偏好：非法难度/主题/数值回退默认或夹取。 */
function sanitizePrefs(raw) {
  const d = createDefaultPrefs();
  const p = raw && typeof raw === 'object' ? raw : {};
  const lv = CFG.english.levels.find((l) => l.id === p.level);
  const dn = Math.round(Number(p.dailyNew));
  const rm = Number(p.reminderMin);
  return {
    level: lv ? lv.id : d.level,
    theme: typeof p.theme === 'string' && p.theme ? p.theme : d.theme,
    soft: p.soft !== false,
    dailyNew: Number.isFinite(dn) ? clamp(dn, CFG.english.dailyNewMin, CFG.english.dailyNewMax) : d.dailyNew,
    ratio: CFG.english.ratios.includes(p.ratio) ? p.ratio : d.ratio,
    reminderMin: CFG.english.reminder.choicesMin.includes(rm) ? rm : d.reminderMin,
    useChoice: p.useChoice !== false,
    useSpell: p.useSpell !== false,
  };
}

/** 校验并规范化词书 JSON：返回 {meta, words} 或 null（文件缺失/结构坏）。 */
function normalizeBook(raw) {
  if (!raw || typeof raw !== 'object' || !raw.meta || !Array.isArray(raw.words)) return null;
  const words = [];
  const seen = new Set();
  for (const w of raw.words) {
    if (!w || typeof w.w !== 'string' || !w.w.trim()) continue;
    if (!Array.isArray(w.trans) || !w.trans.length) continue;
    const key = w.w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(w);
  }
  if (!words.length) return null;
  return { meta: raw.meta, words };
}

/** 词书内部索引：有真题的词 / 有可用例句的词（生成填空与翻译共用）。 */
function indexBook(book) {
  const examWords = [];
  const sentWords = [];
  for (const w of book.words) {
    if (Array.isArray(w.exams) && w.exams.length) examWords.push(w);
    const ok = (w.sents || []).some((s) => countTokens(s.en) >= CFG.english.cloze.minSentenceTokens);
    if (ok) sentWords.push(w);
  }
  return { examWords, sentWords };
}

/* ================= 文本规范化与翻译判分 ================= */

/** 全角→半角、去标点（保留字母数字与中文）、转小写、压空格。 */
function normalizeText(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function countTokens(s) {
  return normalizeText(s).split(' ').filter(Boolean).length;
}

/**
 * 翻译判分。direction：'zh2en'（参考答案为英文）| 'en2zh'（参考答案为中文）。
 * 返回 { verdict:'correct'|'close'|'wrong', score:0..1 }。纯本地，不用任何 API。
 */
function judgeTranslation(input, reference, direction, cfg = CFG.english.judge) {
  const inN = normalizeText(input);
  const refN = normalizeText(reference);
  if (!inN || !refN) return { verdict: 'wrong', score: 0 };
  if (inN === refN) return { verdict: 'correct', score: 1 };

  let score;
  if (direction === 'en2zh') {
    // 参考是中文：以参考答案的字符 bigram 覆盖率计分（容忍语序/用词差异）
    const zh = refN.replace(/\s+/g, '');
    const inZ = inN.replace(/\s+/g, '');
    if (zh.length < 2) {
      score = inZ.includes(zh) ? 1 : 0;
    } else {
      let hit = 0;
      for (let i = 0; i < zh.length - 1; i++) if (inZ.includes(zh.slice(i, i + 2))) hit += 1;
      score = hit / (zh.length - 1);
    }
  } else {
    // 参考是英文：参考句内容词（去虚词）被输入覆盖的比例
    const stop = new Set(cfg.enStopwords);
    const tokens = refN.split(' ').filter((t) => t.length >= 2 && !stop.has(t));
    if (!tokens.length) return { verdict: 'wrong', score: 0 };
    let hit = 0;
    for (const t of tokens) if (inN.includes(t)) hit += 1;
    score = hit / tokens.length;
  }
  score = clamp(score, 0, 1);
  const verdict = score >= cfg.correctAt ? 'correct' : score >= cfg.closeAt ? 'close' : 'wrong';
  return { verdict, score: Math.round(score * 100) / 100 };
}

/* ================= 选词填空出题 ================= */

function stripToken(tok) {
  return tok.toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
}

function shuffleWith(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 词书内随机取 n 个不等于 answer 的词（大小写不敏感去重）。 */
function pickWordDistractors(words, answer, n, rng) {
  const ans = answer.toLowerCase();
  const out = [];
  const seen = new Set([ans]);
  const pool = shuffleWith(words, rng);
  for (const w of pool) {
    if (out.length >= n) break;
    const k = w.w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w.w);
  }
  return out;
}

/**
 * 生成式填空（兜底出题）：从目标词的例句挖掉目标词本身。
 * 红线：永不挖主语——目标只允许是“该词书收录的实义词”，且句首词与虚词表（neverBlank）一律不挖。
 * 返回 {text, cs:[4], right, explain} 或 null（没有合格例句）。
 */
function buildCloze(word, bookWords, rng, cfg = CFG.english.cloze) {
  const target = word.w.toLowerCase();
  const infl = new Set([target]);
  for (const [, hw] of word.rels || []) {
    const k = String(hw || '').toLowerCase();
    if (k.length >= 3) infl.add(k);
  }
  const sents = shuffleWith((word.sents || []).filter((s) => countTokens(s.en) >= cfg.minSentenceTokens), rng);
  for (const sent of sents) {
    const tokens = sent.en.trim().split(/\s+/);
    for (let idx = 1; idx < tokens.length; idx++) { // idx 从 1 起：句首永不挖
      const stripped = stripToken(tokens[idx]);
      if (!stripped || !infl.has(stripped)) continue;
      if (cfg.neverBlank.includes(stripped)) continue;
      // 组干扰项：介词/连词走固定池，其余用同书随机词
      let pool;
      if (cfg.pools.prep.includes(stripped)) pool = cfg.pools.prep;
      else if (cfg.pools.conj.includes(stripped)) pool = cfg.pools.conj;
      const others = pool
        ? shuffleWith(pool.filter((p) => p !== stripped), rng).slice(0, 3)
        : pickWordDistractors(bookWords, stripped, 3, rng);
      if (others.length < 3) return null;
      const answer = tokens[idx];
      const cs = shuffleWith([answer, ...others], rng);
      const defs = word.trans.map((t) => `${t.pos ? t.pos + '. ' : ''}${t.cn}`).join('；');
      return {
        text: [...tokens.slice(0, idx), '______', ...tokens.slice(idx + 1)].join(' '),
        cs,
        right: cs.indexOf(answer),
        explain: `【${word.w}】${defs}\n原句：${sent.en}（${sent.cn}）`,
      };
    }
  }
  return null;
}

/** 真题填空：词书自带 exam[]（已含解析）。 */
function buildRealExam(word, rng) {
  const q = word.exams[Math.floor(rng() * word.exams.length)];
  return { text: q.q, cs: q.cs.slice(), right: q.right, explain: q.ex || `【${word.w}】正确答案：${q.cs[q.right]}` };
}

/**
 * 出一道选词填空：约 70% 优先真题（有则用），否则生成题；全部失败返回 null。
 * 返回 { word, text, cs, right, explain }。
 */
function makeClozeQuestion(book, idx, rng = Math.random) {
  const { examWords, sentWords } = idx;
  if (examWords.length && rng() < 0.7) {
    const w = examWords[Math.floor(rng() * examWords.length)];
    return { word: w.w, ...buildRealExam(w, rng) };
  }
  for (let tries = 0; tries < 8 && sentWords.length; tries++) {
    const w = sentWords[Math.floor(rng() * sentWords.length)];
    const q = buildCloze(w, book.words, rng);
    if (q) return { word: w.w, ...q };
  }
  return null;
}

/* ================= 翻译练习出题 ================= */

/** 随机一道翻译题：{word, direction:'zh2en'|'en2zh', prompt, answer}；词书无例句返回 null。 */
function makeTranslationQuestion(book, rng = Math.random) {
  const pool = book.words.filter((w) => w.sents && w.sents.length);
  if (!pool.length) return null;
  const w = pool[Math.floor(rng() * pool.length)];
  const s = w.sents[Math.floor(rng() * w.sents.length)];
  const zh2en = rng() < 0.5;
  return {
    word: w.w,
    direction: zh2en ? 'zh2en' : 'en2zh',
    prompt: zh2en ? s.cn : s.en,
    answer: zh2en ? s.en : s.cn,
  };
}

/* ================= 背单词（Leitner 简化间隔重复） ================= */

function todayKey(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function newCard(now) {
  return { lv: 0, due: now, seen: 0, ok: 0, streak: 0 };
}

/** 对一张卡打分（纯函数，返回新卡）：认识升 1 档按间隔表排期；不认识降 2 档短间隔重现。 */
function gradeCard(card, known, now, cfg = CFG.english.srs) {
  const maxLv = cfg.intervalsMs.length - 1;
  const n = { ...card, seen: (card.seen || 0) + 1 };
  if (known) {
    n.lv = Math.min(maxLv, (card.lv || 0) + 1);
    n.due = now + cfg.intervalsMs[n.lv];
    n.ok = (card.ok || 0) + 1;
    n.streak = (card.streak || 0) + 1;
  } else {
    n.lv = Math.max(0, (card.lv || 0) - 2);
    n.due = now + cfg.lapseDelayMs;
    n.streak = 0;
  }
  return n;
}

/**
 * 构建背单词出卡队列。
 * opts.dailyNew：每日新词目标（缺省用 config）；opts.ratio：复习:新词比例
 * （'review-first' = 复习全部优先再补新词；'2:1' 等 = 按块交错，一侧耗尽后由另一侧补齐）。
 * 返回 { queue:[{word,card,isNew}], reviewLeft, newLeft, dailyNew }，队列顺序即出卡顺序。
 */
function buildVocabQueue(progress, words, now, opts = {}) {
  const dailyNew = clamp(
    Math.round(Number(opts.dailyNew) || CFG.english.srs.dailyNew),
    1, CFG.english.dailyNewMax || 100
  );
  const ratio = CFG.english.ratios.includes(opts.ratio) ? opts.ratio : 'review-first';
  const cards = (progress && progress.cards) || {};

  const review = [];
  for (const w of words) {
    const c = cards[w.w.toLowerCase()];
    if (c && (c.due || 0) <= now) review.push({ word: w, card: c });
  }
  review.sort((a, b) => a.card.due - b.card.due);

  const rec = progress && progress.daily && progress.daily[todayKey(now)];
  const doneNew = rec && typeof rec === 'object' ? (rec.new || 0) : (typeof rec === 'number' ? rec : 0);
  const newLeft = Math.max(0, dailyNew - doneNew);
  const fresh = [];
  for (const w of words) {
    if (fresh.length >= newLeft) break;
    if (!cards[w.w.toLowerCase()]) fresh.push(w);
  }

  const queue = [];
  if (ratio === 'review-first') {
    for (const r of review) queue.push({ word: r.word, card: r.card, isNew: false });
    for (const w of fresh) queue.push({ word: w, card: null, isNew: true });
  } else {
    const [perR, perN] = ratio.split(':').map(Number);
    let i = 0, j = 0;
    while (i < review.length || j < fresh.length) {
      const takeR = Math.min(perR, review.length - i);
      for (let k = 0; k < takeR; k++) queue.push({ word: review[i + k].word, card: review[i + k].card, isNew: false });
      i += takeR;
      const takeN = Math.min(perN, fresh.length - j);
      for (let k = 0; k < takeN; k++) queue.push({ word: fresh[j + k], card: null, isNew: true });
      j += takeN;
      if (takeR === 0 && takeN === 0) break; // 双侧耗尽防呆
    }
  }
  return { queue, reviewLeft: review.length, newLeft: fresh.length, dailyNew };
}

/** 单词卡展示用的释义行（"pos. 中文"拼接）。 */
function formatDefs(word) {
  return (word.trans || [])
    .map((t) => `${t.pos ? t.pos + '. ' : ''}${t.cn}`)
    .join('；');
}

/** 短释义（四选一选项用）：取第一条释义，截断到 max 字符。 */
function formatShortDefs(word, max = 26) {
  const t = (word.trans || [])[0] || {};
  const s = `${t.pos ? t.pos + '. ' : ''}${t.cn || ''}`.trim() || word.w;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ================= 进度清洗 / 打卡 / 积分段位 ================= */

const DAY_MS = 86400e3;

function parseDayKey(k) {
  if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return NaN;
  const t = Date.parse(`${k}T12:00:00`);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * 清洗背单词进度（v1 兼容：daily 的数字值视为 {new:n}；超过 90 天的记录裁掉）。
 * 结构：{ cards:{[word]:card}, daily:{[date]:{new,review,goalBonus}}, history:{[date]:积分} }
 */
function normalizeProgress(raw, now = Date.now()) {
  const out = { cards: {}, daily: {}, history: {} };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.cards && typeof raw.cards === 'object') {
    for (const [k, c] of Object.entries(raw.cards)) {
      if (!c || typeof c !== 'object') continue;
      out.cards[String(k).toLowerCase()] = { ...c };
    }
  }
  const fresh = (k) => {
    const t = parseDayKey(k);
    return Number.isFinite(t) && now - t < 90 * DAY_MS;
  };
  for (const [k, v] of Object.entries(raw.daily && typeof raw.daily === 'object' ? raw.daily : {})) {
    if (!fresh(k)) continue;
    if (typeof v === 'number') { if (v > 0) out.daily[k] = { new: Math.round(v) }; continue; }
    if (v && typeof v === 'object') {
      out.daily[k] = {
        new: Math.max(0, Math.round(Number(v.new) || 0)),
        review: Math.max(0, Math.round(Number(v.review) || 0)),
        ...(v.goalBonus ? { goalBonus: true } : {}),
      };
    }
  }
  for (const [k, v] of Object.entries(raw.history && typeof raw.history === 'object' ? raw.history : {})) {
    if (!fresh(k) || !Number.isFinite(v)) continue;
    const n = Math.round(v);
    if (n > 0) out.history[k] = n;
  }
  return out;
}

/** 连续打卡天数：从今天往数（今天还没学不断签，从昨天起算）。 */
function computeStreak(daily, now = Date.now()) {
  const has = (k) => {
    const r = daily && daily[k];
    if (!r) return false;
    if (typeof r === 'number') return r > 0;
    return (r.new || 0) + (r.review || 0) > 0;
  };
  const d = new Date(now);
  if (!has(todayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (has(todayKey(d.getTime()))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/**
 * 给“今天”记积分（按天封顶，超出部分不计）。直接更新 progress.history（调用方持有进度对象）。
 * 返回实际计入的分数。
 */
function addHistoryPts(progress, pts, now = Date.now(), cfg = CFG.english.rank) {
  if (!Number.isFinite(pts) || pts <= 0) return 0;
  if (!progress.history || typeof progress.history !== 'object') progress.history = {};
  const k = todayKey(now);
  const cur = progress.history[k] || 0;
  const added = Math.max(0, Math.min(cfg.dailyCap - cur, Math.round(pts)));
  if (added > 0) progress.history[k] = cur + added;
  return added;
}

/** 当日新词达标一次性奖励（goalBonus 幂等，重复调用不重复加）。 */
function checkGoalBonus(progress, dailyNew, now = Date.now(), cfg = CFG.english.rank) {
  const k = todayKey(now);
  const rec = progress.daily && progress.daily[k];
  const done = rec && typeof rec === 'object' ? rec.new : 0;
  if (!rec || !dailyNew || done < dailyNew || rec.goalBonus) return false;
  rec.goalBonus = true;
  addHistoryPts(progress, cfg.goalBonus, now, cfg);
  return true;
}

/**
 * 积分段位：近 90 天按窗口加权（30 天内 ×1、30–60 天 ×0.5、60–90 天 ×0.25，更久不计）——
 * 长时间不学，历史积分权重自然衰减 ⇒ 掉分。
 * 返回可序列化摘要 {score, tierName, tierIdx, nextName, nextAt, pct}。
 * 【预留联网接口】该摘要即未来排行榜的上报载荷（再配一个匿名用户 id 即可），主进程
 * `english:prefs:*` 同模式可加 `english:rank:sync`；在接入联网前不上传任何数据。
 */
function computeRank(history, now = Date.now(), cfg = CFG.english.rank) {
  let score = 0;
  for (const [k, pts] of Object.entries(history && typeof history === 'object' ? history : {})) {
    const t = parseDayKey(k);
    if (!Number.isFinite(t)) continue;
    const age = (now - t) / DAY_MS;
    if (age < 0) continue;
    let w = 0;
    for (const win of cfg.windows) {
      if (age < win.days) { w = win.w; break; }
    }
    score += (Number(pts) || 0) * w;
  }
  score = Math.round(score);
  let tierIdx = 0;
  for (let i = 0; i < cfg.tiers.length; i++) {
    if (score >= cfg.tiers[i].at) tierIdx = i;
  }
  const next = cfg.tiers[tierIdx + 1] || null;
  const cur = cfg.tiers[tierIdx];
  const pct = next ? clamp((score - cur.at) / (next.at - cur.at), 0, 1) : 1;
  return {
    score, tierIdx, tierName: cur.name,
    nextName: next ? next.name : null, nextAt: next ? next.at : null,
    pct: Math.round(pct * 100) / 100,
  };
}

/* ================= 四选一 / 拼写 / 小测 ================= */

/**
 * 背单词用的四选一辨认题。direction 'en2zh'：出单词选释义；'zh2en'：出释义选单词。
 * forceDirection 传 'en2zh'/'zh2en' 可固定方向（新词学习固定英→中）。
 */
function makeVocabChoice(word, bookWords, rng = Math.random, forceDirection = null) {
  const direction = forceDirection || (rng() < 0.5 ? 'en2zh' : 'zh2en');
  let prompt, answer;
  if (direction === 'en2zh') {
    prompt = word.w;
    answer = formatShortDefs(word);
    const others = [];
    const pool = shuffleWith(bookWords, rng);
    for (const w of pool) {
      if (others.length >= 3) break;
      if (w.w.toLowerCase() === word.w.toLowerCase()) continue;
      const d = formatShortDefs(w);
      if (d === answer || others.includes(d)) continue;
      others.push(d);
    }
    if (others.length < 3) return null;
    var distract = others;
  } else {
    prompt = formatShortDefs(word);
    answer = word.w;
    var distract = pickWordDistractors(bookWords, word.w, 3, rng);
    if (distract.length < 3) return null;
  }
  const cs = shuffleWith([answer, ...distract], rng);
  return { direction, prompt, cs, right: cs.indexOf(answer), answer };
}

/** 拼写遮罩：前 reveal 个字母显示，其余用 _；撇号/连字符等原样显示。 */
function maskWord(w, reveal = 0) {
  let seen = 0;
  return String(w).split('').map((ch) => {
    if (!/[a-zA-Z]/.test(ch)) return ch;
    const out = seen < reveal ? ch : '_';
    seen += 1;
    return out;
  }).join('');
}

/** 拼写判分：忽略大小写与非字母字符。 */
function checkSpelling(word, input) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  return norm(word) === norm(input) && norm(word).length > 0;
}

/**
 * 组内小测：从 words（本次会话学过的词）里出最多 size 道混合题（四选一/拼写交替）。
 * 两类题型都被关闭时返回 null。返回 [{type:'choice',…}|{type:'spell',…}]。
 */
function makeMiniQuiz(words, bookWords, rng = Math.random, size = CFG.english.quiz.size, useChoice = true, useSpell = true) {
  const types = [];
  if (useChoice) types.push('choice');
  if (useSpell) types.push('spell');
  if (!types.length || !Array.isArray(words) || words.length === 0) return null;
  const pool = shuffleWith(words, rng);
  const out = [];
  for (let i = 0; i < Math.min(size, pool.length); i++) {
    const w = pool[i];
    const type = types[i % types.length];
    if (type === 'choice') {
      const q = makeVocabChoice(w, bookWords, rng);
      if (q) out.push({ type, word: w.w, ...q });
    } else {
      out.push({ type, word: w.w, prompt: formatShortDefs(w), answer: w.w });
    }
  }
  return out.length ? out : null;
}

module.exports = {
  createDefaultPrefs,
  sanitizePrefs,
  normalizeBook,
  indexBook,
  normalizeText,
  countTokens,
  judgeTranslation,
  buildCloze,
  buildRealExam,
  makeClozeQuestion,
  makeTranslationQuestion,
  todayKey,
  newCard,
  gradeCard,
  buildVocabQueue,
  formatDefs,
  formatShortDefs,
  normalizeProgress,
  computeStreak,
  addHistoryPts,
  checkGoalBonus,
  computeRank,
  makeVocabChoice,
  maskWord,
  checkSpelling,
  makeMiniQuiz,
};
