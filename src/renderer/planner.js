'use strict';
/**
 * 学习计划表窗口：周视图 + 当天清单 + 待安排 / 逾期分区；
 * 右下角用**桌宠主图**（同一套素材解析顺序，换 data/assets/pet/pet.png 即换装饰）缩小后作 UI 装饰。
 *
 * 数据与日期计算全部走 shared/planner.js（与单测同一份纯函数）：
 *   weekKeys / itemsForDate / dayProgress / unscheduled / overdue / dayLabel
 * 持久化：settings.planner（主进程 planner:load / planner:save）。
 */
const { ipcRenderer } = require('electron');
const { CFG } = require('../shared/config');
const PL = require('../shared/planner');

const $ = (id) => document.getElementById(id);
const el = {
  deco: $('deco'), tip: $('tip'), prog: $('prog'), week: $('week'),
  text: $('text'), date: $('date'), time: $('time'), addBtn: $('addBtn'),
  list: $('list'), msg: $('msg'), todayBtn: $('todayBtn'),
};

const WEEK_LABEL = ['日', '一', '二', '三', '四', '五', '六'];
const todayKey = PL.dateKey(new Date());

let items = [];
let selected = todayKey;
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

/* ---------------- 渲染 ---------------- */

function setMsg(t, isErr) {
  el.msg.textContent = t || '';
  el.msg.classList.toggle('err', !!isErr);
}

function renderWeek() {
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

function render() {
  const d = PL.parseDateKey(selected) || new Date();
  el.tip.textContent = `${selected}（${PL.dayLabel(selected, todayKey)}）`;
  const p = PL.dayProgress(items, selected);
  el.prog.textContent = p.total ? `完成 ${p.done}/${p.total}` : '';
  el.date.value = selected;
  renderWeek();
  renderList();
}

/* ---------------- 数据读写 ---------------- */

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void save(); }, 400);
}

async function save() {
  const payload = PL.normalizePlanner({ items }) || { items: [] };
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

/* ---------------- 启动 ---------------- */

(async () => {
  await initDeco();
  try {
    const saved = await ipcRenderer.invoke('planner:load');
    const n = PL.normalizePlanner(saved);
    if (n) items = n.items;
  } catch { items = []; }
  selected = todayKey;
  render();
})();
