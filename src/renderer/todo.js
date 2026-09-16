'use strict';
/** 待办清单窗口：添加 / 截止时间（分钟精度）/ 完成划线 / 标记重要 ♥ / 删除。
 *  数据全部走主进程（todo:* IPC），持久化在 settings.json。 */
const { ipcRenderer } = require('electron');

/* ---- UI 主题色（通用设置切换；只改视觉变量，不碰业务逻辑） ---- */
void (async () => {
  const prefs = await ipcRenderer.invoke('uiPrefs:load').catch(() => null);
  if (prefs && prefs.accent) document.documentElement.dataset.accent = prefs.accent;
})();
ipcRenderer.on('ui:accent', (_e, prefs) => {
  if (prefs && prefs.accent) document.documentElement.dataset.accent = prefs.accent;
});


const $ = (id) => document.getElementById(id);
const listEl = $('list'), textEl = $('text'), dueEl = $('due'), impEl = $('important'), countEl = $('count');
let todos = [];

const pad = (n) => String(n).padStart(2, '0');

function fmtDue(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render() {
  listEl.textContent = '';
  if (!todos.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '还没有待办。添加一条试试吧！';
    listEl.appendChild(d);
  }
  for (const t of todos) {
    const row = document.createElement('div');
    row.className = 'row' + (t.done ? ' done' : '');
    row.dataset.id = t.id;

    const ck = document.createElement('input');
    ck.type = 'checkbox'; ck.className = 'doneCk'; ck.checked = t.done; ck.title = '标记完成';
    row.appendChild(ck);

    const body = document.createElement('div'); body.className = 'body';
    const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = t.text;
    body.appendChild(txt);
    if (t.due != null) {
      const meta = document.createElement('div'); meta.className = 'meta';
      const overdue = !t.done && t.due <= Date.now();
      meta.textContent = `截止 ${fmtDue(t.due)}${overdue ? '（已到时间）' : ''}`;
      if (overdue) meta.classList.add('overdue');
      body.appendChild(meta);
    }
    row.appendChild(body);

    const imp = document.createElement('button');
    imp.className = 'impBtn' + (t.important ? '' : ' off');
    imp.title = '标记重要（♥ 的待办会被随机催促）';
    imp.textContent = t.important ? '♥' : '♡';
    row.appendChild(imp);

    const del = document.createElement('button');
    del.className = 'delBtn'; del.title = '删除'; del.textContent = '✕';
    row.appendChild(del);

    listEl.appendChild(row);
  }
  const left = todos.filter((t) => !t.done).length;
  countEl.textContent = todos.length ? `${left} 项未完成 / 共 ${todos.length} 项` : '暂无待办';
}

async function refresh() {
  todos = await ipcRenderer.invoke('todo:load');
  render();
}

listEl.addEventListener('click', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.classList.contains('doneCk')) {
    todos = await ipcRenderer.invoke('todo:update', id, { done: e.target.checked });
    render();
  } else if (e.target.classList.contains('impBtn')) {
    const cur = todos.find((x) => x.id === id);
    todos = await ipcRenderer.invoke('todo:update', id, { important: !(cur && cur.important) });
    render();
  } else if (e.target.classList.contains('delBtn')) {
    todos = await ipcRenderer.invoke('todo:remove', id);
    render();
  }
});

async function add() {
  const text = textEl.value.trim();
  if (!text) { textEl.focus(); return; }
  const due = dueEl.value ? Date.parse(dueEl.value) : null;
  todos = await ipcRenderer.invoke('todo:add', {
    text,
    due: Number.isFinite(due) ? due : null,
    important: impEl.checked,
  });
  textEl.value = ''; impEl.checked = false; dueEl.value = '';
  render();
  textEl.focus();
}

$('addBtn').addEventListener('click', add);
textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
ipcRenderer.on('todo:changed', (_e, { todos: t }) => { todos = t; render(); });
refresh();
