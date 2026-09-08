'use strict';
/** 聊天窗口：输入文字 → 主进程按关键词规则匹配 → 显示桌宠回复（历史保留在本窗口）。
 *  规则由“聊天设置”窗口维护；未命中任何关键词时桌宠会被“点击一下”（Q 弹 + 情绪变化）。
 *  开场白/未命中提示来自主进程 chat:strings（可经开发者模式定制）。 */
const { ipcRenderer } = require('electron');

const msgsEl = document.getElementById('msgs');
const inputEl = document.getElementById('input');

// 默认值兜底；启动后异步取主进程生效值（无开发者模式时 = config.js 默认）
const STR = {
  opening: '主人好呀，跟我说说话吧！',
  missNotice: '（桌宠歪了歪头，好像没听懂……）',
};

function appendMsg(text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  msgsEl.appendChild(d);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) { inputEl.focus(); return; }
  appendMsg(text, 'me');
  inputEl.value = '';
  const res = await ipcRenderer.invoke('chat:send', text);
  if (res && res.ok && res.matched) appendMsg(res.reply, 'pet');
  else if (res && res.ok) appendMsg(STR.missNotice, 'sys');
  inputEl.focus();
}

document.getElementById('sendBtn').addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// 规则变化时轻提示（当前窗口的匹配即时生效）
ipcRenderer.on('chatRules:changed', (_e, { rules }) => {
  appendMsg(`（回复规则已更新：现在有 ${rules.length} 条规则）`, 'sys');
});

(async () => {
  try {
    const s = await ipcRenderer.invoke('chat:strings');
    if (s && typeof s === 'object') {
      if (s.opening) STR.opening = s.opening;
      if (s.missNotice) STR.missNotice = s.missNotice;
    }
  } catch { /* 取不到就用默认文案 */ }
  appendMsg(STR.opening, 'pet');
  inputEl.focus();
})();
