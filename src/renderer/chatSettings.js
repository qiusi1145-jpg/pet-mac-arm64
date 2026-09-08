'use strict';
/** 聊天设置窗口：维护“关键词 → 回复”规则（添加/删除），持久化到 settings.json。 */
const { ipcRenderer } = require('electron');

const listEl = document.getElementById('list');
const kwEl = document.getElementById('keyword');
const rpEl = document.getElementById('reply');
let rules = [];

function render() {
  listEl.textContent = '';
  if (!rules.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '还没有规则。添加一条，桌宠就会说话了！';
    listEl.appendChild(d);
  }
  for (const r of rules) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.keyword = r.keyword;

    const kw = document.createElement('div');
    kw.className = 'kw'; kw.textContent = r.keyword;
    const rp = document.createElement('div');
    rp.className = 'rp'; rp.textContent = r.reply;
    const del = document.createElement('button');
    del.className = 'delBtn'; del.title = '删除这条规则'; del.textContent = '✕';

    row.append(kw, rp, del);
    listEl.appendChild(row);
  }
}

listEl.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('delBtn')) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const res = await ipcRenderer.invoke('chatRules:remove', row.dataset.keyword);
  if (res && res.ok) { rules = res.rules; render(); }
});

async function add() {
  const res = await ipcRenderer.invoke('chatRules:add', { keyword: kwEl.value, reply: rpEl.value });
  if (res && res.ok) {
    rules = res.rules;
    kwEl.value = ''; rpEl.value = '';
    render();
  }
  kwEl.focus();
}

document.getElementById('addBtn').addEventListener('click', add);
kwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') rpEl.focus(); });
rpEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

ipcRenderer.on('chatRules:changed', (_e, { rules: r }) => { rules = r; render(); });

(async () => {
  rules = await ipcRenderer.invoke('chatRules:load');
  render();
})();
