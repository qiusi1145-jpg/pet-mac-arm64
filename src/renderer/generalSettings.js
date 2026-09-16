'use strict';
/**
 * 通用设置窗（2026-09-17 新增）：目前只有「界面主题色 accent」一项。
 * 规则白名单在 shared/uiTheme.js；持久化在 settings.json 的 uiPrefs 字段；
 * 保存由主进程广播 ui:accent → 各工具窗实时换色（含本窗）。
 */
const { ipcRenderer } = require('electron');
const { ACCENTS, DEFAULT_ACCENT } = require('../shared/uiTheme');

/* ---- UI 主题色：本窗自己也要应用与跟随广播 ---- */
void (async () => {
  const prefs = await ipcRenderer.invoke('uiPrefs:load').catch(() => null);
  document.documentElement.dataset.accent = (prefs && prefs.accent) || DEFAULT_ACCENT;
  render(prefs && prefs.accent);
})();
ipcRenderer.on('ui:accent', (_e, prefs) => {
  document.documentElement.dataset.accent = (prefs && prefs.accent) || DEFAULT_ACCENT;
  mark((prefs && prefs.accent) || DEFAULT_ACCENT);
});

const $ = (id) => document.getElementById(id);
const msgEl = () => $('msg');

let msgTimer = 0;
function flash(text) {
  const el = msgEl();
  if (!el) return;
  el.textContent = text;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

/** 生成色板（一次）；点击 → 保存 → 主进程广播。 */
function render(current) {
  const box = $('swatches');
  if (!box || box.childElementCount) return;
  for (const [id, preset] of Object.entries(ACCENTS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sw' + (id === current ? ' on' : '');
    btn.dataset.accent = id;
    btn.title = preset.label;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = preset.color;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = preset.label;
    btn.append(dot, nm);
    btn.addEventListener('click', () => void pick(id));
    box.appendChild(btn);
  }
}

function mark(current) {
  document.querySelectorAll('#swatches .sw').forEach((el) => {
    el.classList.toggle('on', el.dataset.accent === current);
  });
}

async function pick(id) {
  const clean = await ipcRenderer.invoke('uiPrefs:save', { accent: id }).catch(() => null);
  if (clean && clean.accent === id) {
    mark(id);
    flash('已保存');
  } else {
    flash('保存失败，请重试');
  }
}
