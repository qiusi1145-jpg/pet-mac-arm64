'use strict';
/**
 * 学习计划表窗口（2026-09-17 三视图升级）：日 / 周（课表）/ 月 三种视图切换。
 * 三视图共用同一份计划数据（settings.planner.items）——任何视图增删改，其余视图即时同步。
 * 视觉照搬学英语的设计语言（近白浅渐变 + 磨砂玻璃卡 + 大圆角，见 planner.html 顶部注释）。
 *
 * 数据与日期计算全部走 shared/planner.js（与单测同一份纯函数）：
 *   weekKeys / monthGrid / inMonth / hourRange / itemsForDate / dayProgress / unscheduled / overdue / dayLabel
 * 持久化：settings.planner（主进程 planner:load / planner:save；view 字段记住上次视图）。
 */
const { ipcRenderer } = require('electron');
const { CFG } = require('../shared/config');
const PL = require('../shared/planner');

const $ = (id) => document.getElementById(id);
const el = {
  deco: $('deco'), tip: $('tip'), prog: $('prog'),
  tabDay: $('tabDay'), tabWeek: $('tabWeek'), tabMonth: $('tabMonth'),
  viewDay: $('viewDay'), viewWeek: $('viewWeek'), viewMonth: $('viewMonth'),
  week: $('week'), list: $('list'),
  wgrid: $('wgrid'), weekWrap: $('weekWrap'),
  mgrid: $('mgrid'), mEvents: $('mEvents'), mTitle: $('mTitle'),
  mPrev: $('mPrev'), mNext: $('mNext'), mToday: $('mToday'),
  text: $('text'), date: $('date'), time: $('time'), addBtn: $('addBtn'),
  msg: $('msg'), todayBtn: $('todayBtn'),
};

const WEEK_LABEL = ['日', '一', '二', '三', '四', '五', '六'];
const todayKey = PL.dateKey(new Date());
const TODAY = new Date();

let items = [];
let selected = todayKey;          // 选中日期（三视图共享：日=当天清单；周=所在周；月=事件列表）
let view = 'day';                 // 'day' | 'week' | 'month'（持久化在 settings.planner.view）
let monthY = TODAY.getFullYear(); // 月视图当前展示的年月
let monthM = TODAY.getMonth() + 1;
let saveTimer = 0;

/* ---------------- 装饰小桌宠 ---------------- */

async function initDeco() {
  const d = CFG.planner.deco;
  if (!d || d.enabled === false) { el.deco.style.display = 'none'; return; }
  if (d.corner === 'bottom-left') el.deco.classList.add('left');
  el.deco.style.opacity = String(d.opacity);
  const layout = () => { el.deco.style.height = `${Math.round(window.innerHeight * d.heightRatio)}px`; };
  layout();
  window.addEventListener('resize', layout);
  try {
    // 复用主窗口同一套"宠物主图"解析（素材根目录 pet.png > 旧 settings 值 > 内置主图）
    const r = await ipcRenderer.invoke('pet:thumbnail');
    if (r && r.dataUrl) el.deco.src = r.dataUrl;
    else el.deco.style.display = 'none';
  } catch { el.deco.style.display = 'none'; }
}

/* ---------------- 渲染：公共 ---------------- */

function setMsg(t, isErr) {
  el.msg.textContent = t || '';
  el.msg.classList.toggle('err', !!isErr);
}

/** 顶栏进度：日=选中日；周=本周合计；月=选中日。 */
function renderProg() {
  let text = '';
  if (view === 'week') {
    const keys = PL.weekKeys(selected, CFG.planner.weekStart);
    let total = 0, done = 0;
    for (const k of keys) { const p = PL.dayProgress(items, k); total += p.total; done += p.done; }
    text = total ? `本周 ${done}/${total}` : '';
  } else {
    const p = PL.dayProgress(items, selected);
    text = p.total ? `完成 ${p.done}/${p.total}` : '';
  }
  el.prog.textContent = text;
}

/** 条目行（日视图清单 / 月视图事件列表共用）。 */
function rowOf(it) {
  const row = document.createElement('div');
  row.className = 'row' + (it.done ? ' done' : '') + (!it.done && it.date && it.date < todayKey ? ' overdue' : '');
  row.dataset.id = it.id;

  const ck = document.createElement('input');
  ck.type = 'checkbox'; ck.className = 'ck'; ck.checked = it.done;
  ck.title = '标记完成';
  ck.addEventListener('change', () => { void patch(it.id, { done: ck.checked }); });

  const tm = document.createElement('div');
  tm.className = 'tm';
  tm.textContent = it.time || (it.date ? '' : '未排期');

  const tx = document.createElement('div');
  tx.className = 'tx'; tx.textContent = it.text; tx.title = it.note || it.text;

  const del = document.createElement('button');
  del.className = 'delBtn'; del.title = '删除'; del.textContent = '✕';
  del.addEventListener('click', () => { void removeItem(it.id); });

  row.append(ck, tm, tx, del);
  return row;
}

/* ---------------- 日视图（原有设计） ---------------- */

function renderWeekStrip() {
  el.week.textContent = '';
  const keys = PL.weekKeys(selected, CFG.planner.weekStart);
  for (const key of keys) {
    const d = PL.parseDateKey(key);
    const p = PL.dayProgress(items, key);
    const box = document.createElement('div');
    box.className = 'day' + (key === selected ? ' sel' : '') + (key === todayKey ? ' today' : '');
    box.dataset.key = key;
    const dw = document.createElement('div'); dw.className = 'dw'; dw.textContent = `周${WEEK_LABEL[d.getDay()]}`;
    const dd = document.createElement('div'); dd.className = 'dd'; dd.textContent = String(d.getDate());
    const dot = document.createElement('div'); dot.className = 'dot';
    dot.textContent = p.total ? (p.done === p.total ? '✓ 全部' : `✓ ${p.done}/${p.total}`) : '';
    box.append(dw, dd, dot);
    box.addEventListener('click', () => { selected = key; render(); });
    el.week.appendChild(box);
  }
}

function renderList() {
  el.list.textContent = '';
  const dayList = PL.itemsForDate(items, selected);
  const over = PL.overdue(items, todayKey).filter((it) => it.date !== selected);
  const uns = PL.unscheduled(items);

  if (!dayList.length && !over.length && !uns.length) {
    const e = document.createElement('div');
    e.className = 'empty'; e.textContent = CFG.planner.strings.empty;
    el.list.appendChild(e);
    return;
  }
  if (dayList.length) {
    for (const it of dayList) el.list.appendChild(rowOf(it));
  } else {
    const e = document.createElement('div');
    e.className = 'empty'; e.textContent = '这一天还没有安排。';
    el.list.appendChild(e);
  }
  if (over.length) {
    const h = document.createElement('div'); h.className = 'sec'; h.textContent = '逾期未完成';
    el.list.appendChild(h);
    for (const it of over) el.list.appendChild(rowOf(it));
  }
  if (uns.length) {
    const h = document.createElement('div'); h.className = 'sec'; h.textContent = '待安排（没填日期）';
    el.list.appendChild(h);
    for (const it of uns) el.list.appendChild(rowOf(it));
  }
}

function renderDay() {
  renderWeekStrip();
  renderList();
}

/* ---------------- 周视图（课表：本周实际计划按 时间×日期 摆放） ---------------- */

/** 课表事件块：点块勾/取消完成，✕ 删除（与日视图同一条数据）。 */
function eventBlock(it) {
  const b = document.createElement('div');
  b.className = 'wevt' + (it.done ? ' done' : '') + (!it.done && it.date < todayKey ? ' overdue' : '');
  b.title = (it.note ? `${it.note}\n` : '') + '点击标记完成/取消';
  const t = document.createElement('div'); t.className = 't'; t.textContent = it.time;
  const x = document.createElement('div'); x.className = 'x'; x.textContent = it.text;
  const del = document.createElement('button');
  del.className = 'delBtn'; del.textContent = '✕'; del.title = '删除';
  del.addEventListener('click', (e) => { e.stopPropagation(); void removeItem(it.id); });
  b.addEventListener('click', () => { void patch(it.id, { done: !it.done }); });
  b.append(t, x, del);
  return b;
}

function renderWeek() {
  const keys = PL.weekKeys(selected, CFG.planner.weekStart);
  const [h0, h1] = PL.hourRange(items, keys);   // 自适应时间轴（无计划 → 8~22）
  el.wgrid.textContent = '';

  const mk = (cls) => { const c = document.createElement('div'); c.className = cls; return c; };

  // 时间刻度列
  const gutter = mk('wcol head');
  gutter.appendChild(mk('whead'));
  for (let h = h0; h < h1; h++) {
    const slot = mk('whour');
    const hl = document.createElement('span'); hl.className = 'hl'; hl.textContent = `${String(h).padStart(2, '0')}:00`;
    slot.appendChild(hl);
    gutter.appendChild(slot);
  }
  el.wgrid.appendChild(gutter);

  // 7 个日期列：每列顶部日头（点击=选中），下面按小时分槽；事件按 HH 落槽堆叠
  for (const key of keys) {
    const d = PL.parseDateKey(key);
    const col = mk('wcol');
    const head = mk('whead' + (key === selected ? ' sel' : '') + (key === todayKey ? ' today' : ''));
    head.innerHTML = `周${WEEK_LABEL[d.getDay()]} <span class="n">${d.getDate()}</span>`;
    head.addEventListener('click', () => { selected = key; render(); });
    col.appendChild(head);
    for (let h = h0; h < h1; h++) {
      const slot = mk('wslot');
      slot.title = `${String(h).padStart(2, '0')}:00~${String(h + 1).padStart(2, '0')}:00`;
      for (const it of PL.itemsForDate(items, key)) {
        if (!it.time || Number(it.time.slice(0, 2)) !== h) continue;
        slot.appendChild(eventBlock(it));
      }
      col.appendChild(slot);
    }
    el.wgrid.appendChild(col);
  }

  // 本周无时刻的计划 + 未排期条目 → 课表下方的补充区
  const wkSet = new Set(keys);
  const allDay = items.filter((it) => it.date && wkSet.has(it.date) && !it.time);
  const uns = PL.unscheduled(items);
  const extra = el.weekExtra;
  extra.textContent = '';
  if (allDay.length) {
    const h = document.createElement('div'); h.className = 'sec'; h.textContent = '本周全天（没定时刻）';
    extra.appendChild(h);
    for (const it of PL.sortItems(allDay)) extra.appendChild(rowOf(it));
  }
  if (uns.length) {
    const h = document.createElement('div'); h.className = 'sec'; h.textContent = '待安排（没填日期）';
    extra.appendChild(h);
    for (const it of uns) extra.appendChild(rowOf(it));
  }
}

/* ---------------- 月视图（月历 + 选中日事件） ---------------- */

function renderMonth() {
  el.mTitle.textContent = `${monthY} 年 ${monthM} 月`;
  const cells = PL.monthGrid(monthY, monthM, CFG.planner.weekStart);
  el.mgrid.textContent = '';

  // 表头：按 weekStart 排 周几
  const ws = Number(CFG.planner.weekStart) === 0 ? 0 : 1;
  for (let i = 0; i < 7; i++) {
    const h = document.createElement('div');
    h.className = 'mh';
    h.textContent = `周${WEEK_LABEL[(ws + i) % 7]}`;
    el.mgrid.appendChild(h);
  }

  for (const key of cells) {
    const d = PL.parseDateKey(key);
    const cell = document.createElement('div');
    cell.className = 'mcell'
      + (PL.inMonth(key, monthY, monthM) ? '' : ' dim')
      + (key === todayKey ? ' today' : '')
      + (key === selected ? ' sel' : '');
    cell.dataset.key = key;

    const n = document.createElement('div'); n.className = 'n'; n.textContent = String(d.getDate());
    cell.appendChild(n);

    // 当日计划标记：右上角未完成数；左下角小圆点（全部完成→绿点）
    const list = PL.itemsForDate(items, key);
    if (list.length) {
      const undone = list.filter((it) => !it.done).length;
      if (undone) {
        const c = document.createElement('span'); c.className = 'cnt'; c.textContent = String(undone);
        cell.appendChild(c);
      }
      const dots = document.createElement('div'); dots.className = 'dots';
      for (let i = 0; i < Math.min(3, list.length); i++) dots.appendChild(document.createElement('i'));
      if (undone === 0) cell.classList.add('alldone');
      cell.appendChild(dots);
    }

    // 单击=选中（下方列事件）；双击=选中并聚焦输入框快速添加
    cell.addEventListener('click', () => { selected = key; render(); });
    cell.addEventListener('dblclick', () => {
      selected = key; render();
      el.text.focus();
      setMsg(`已选中 ${key}，输入内容回车即添加到这一天`);
    });
    el.mgrid.appendChild(cell);
  }

  // 下方：选中日的事件清单（与日/周视图同一条数据 → 天然互通）
  el.mEvents.textContent = '';
  const dayList = PL.itemsForDate(items, selected);
  const h = document.createElement('div');
  h.className = 'sec';
  h.textContent = `${selected}（${PL.dayLabel(selected, todayKey)}）的事件`;
  el.mEvents.appendChild(h);
  if (!dayList.length) {
    const e = document.createElement('div');
    e.className = 'empty'; e.textContent = '这一天还没有安排——双击月历格子或用上方添加行。';
    el.mEvents.appendChild(e);
    return;
  }
  for (const it of dayList) el.mEvents.appendChild(rowOf(it));
}

/* ---------------- 视图切换与总渲染 ---------------- */

function showView(v) {
  view = PL.normalizePlanner({ view: v }).view;   // 白名单兜底
  el.viewDay.hidden = view !== 'day';
  el.viewWeek.hidden = view !== 'week';
  el.viewMonth.hidden = view !== 'month';
  el.tabDay.classList.toggle('on', view === 'day');
  el.tabWeek.classList.toggle('on', view === 'week');
  el.tabMonth.classList.toggle('on', view === 'month');
  if (view === 'month') { monthY = PL.parseDateKey(selected).getFullYear(); monthM = PL.parseDateKey(selected).getMonth() + 1; }
  render();
  scheduleSave();   // 记住视图选择
}

function render() {
  const d = PL.parseDateKey(selected) || new Date();
  el.tip.textContent = view === 'week'
    ? `${PL.weekKeys(selected, CFG.planner.weekStart)[0]} 起（${PL.dayLabel(selected, todayKey)}）`
    : `${selected}（${PL.dayLabel(selected, todayKey)}）`;
  el.date.value = selected;
  renderProg();
  if (view === 'day') renderDay();
  else if (view === 'week') renderWeek();
  else renderMonth();
}

/* ---------------- 数据读写 ---------------- */

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void save(); }, 400);
}

async function save() {
  const payload = PL.normalizePlanner({ items, view }) || { items: [], view: 'day' };
  const res = await ipcRenderer.invoke('planner:save', payload);
  if (res && res.ok) { items = res.items; setMsg('已保存'); setTimeout(() => setMsg(''), 1500); }
  else setMsg('保存失败', true);
}

async function patch(id, partial) {
  items = items.map((it) => (it.id === id ? { ...it, ...partial } : it));
  render();
  await save();
}

async function removeItem(id) {
  items = items.filter((it) => it.id !== id);
  render();
  await save();
}

async function add() {
  const text = el.text.value.trim();
  if (!text) { el.text.focus(); return; }
  const date = el.date.value || selected;
  const item = PL.normalizeItem({ text, date, time: el.time.value });
  if (!item) { setMsg('内容不能为空', true); return; }
  items.push(item);
  el.text.value = '';
  el.time.value = '';
  setMsg('已添加');
  render();
  await save();
  el.text.focus();
}

/* ---------------- 事件 ---------------- */

el.addBtn.addEventListener('click', () => { void add(); });
el.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') void add(); });
el.todayBtn.addEventListener('click', () => { selected = todayKey; render(); });
el.date.addEventListener('change', () => {
  const k = PL.parseDateKey(el.date.value) ? el.date.value : selected;
  selected = k; render();
});

el.tabDay.addEventListener('click', () => showView('day'));
el.tabWeek.addEventListener('click', () => showView('week'));
el.tabMonth.addEventListener('click', () => showView('month'));
el.mPrev.addEventListener('click', () => {
  monthM -= 1; if (monthM < 1) { monthM = 12; monthY -= 1; }
  render();
});
el.mNext.addEventListener('click', () => {
  monthM += 1; if (monthM > 12) { monthM = 1; monthY += 1; }
  render();
});
el.mToday.addEventListener('click', () => {
  selected = todayKey;
  monthY = TODAY.getFullYear(); monthM = TODAY.getMonth() + 1;
  render();
});

/* ---------------- 启动 ---------------- */

(async () => {
  await initDeco();
  try {
    const saved = await ipcRenderer.invoke('planner:load');
    const n = PL.normalizePlanner(saved);
    if (n) { items = n.items; view = n.view || 'day'; }
  } catch { items = []; }
  selected = todayKey;
  if (view !== 'day') { showView(view); } else { render(); }
})();
