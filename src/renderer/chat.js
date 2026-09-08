'use strict';
/** 聊天窗口：输入文字 → 主进程按关键词规则匹配 → 显示桌宠回复（历史保留在本窗口）。
 *  规则由“聊天设置”窗口维护；未命中任何关键词时桌宠会被“点击一下”（Q 弹 + 情绪变化）。 */
const { ipcRenderer } = require('electron');

const msgsEl = document.getElementById('msgs');
const inputEl = document.getElementById('input');

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
  else if (res && res.ok) appendMsg('（桌宠歪了歪头，好像没听懂……）', 'sys');
  inputEl.focus();
}

document.getElementById('sendBtn').addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// 规则变化时轻提示（当前窗口的匹配即时生效）
ipcRenderer.on('chatRules:changed', (_e, { rules }) => {
  appendMsg(`（回复规则已更新：现在有 ${rules.length} 条规则）`, 'sys');
});

appendMsg('主人好呀，跟我说说话吧！', 'pet');
inputEl.focus();
