'use strict';
/**
 * 持久化设置的结构定义与清洗（纯函数）。渲染层/主进程共用一份 schema 认知，
 * 保证落盘与读盘字段一致。真正的文件读写只在主进程（store.js）做。
 */
const { CFG } = require('./config');
const { normalizeTodos } = require('./todo');
const { normalizeChatRules } = require('./chat');

function defaultSettings() {
  return {
    // 活动区域尺寸（相对主屏工作区的像素值，加载后仍会用 computeRegion 夹取）。
    region: { width: null, height: null }, // null = 默认填满工作区
    locked: false,
    visible: true,
    pos: null, // {x,y} 区域内部坐标（宠物左上角）
    // 图片资产（复制到 userData/assets 后，只存绝对路径）
    pet: { path: null },
    background: { path: null, opacity: CFG.ui.bgDefaultOpacity },
    // BGM
    playlist: [], // [{path,title}]
    volume: CFG.audio.volumeDefault,
    // 状态快照（含 lastTs 时间戳，用于离线结算）
    status: null,
    // 界面
    pillCollapsed: false,
    // 是否允许吸附到其它窗口顶沿
    snapEnabled: true,
    // 是否允许物理模拟（甩动抛掷 / 失去支撑坠落）；关闭后人物拖到哪停在哪，但吸附仍工作。
    physicsEnabled: true,
    // 待办清单
    todos: [], // [{id,text,due,done,important}]
    // 聊天回复规则
    chatRules: [], // [{keyword,reply}]
  };
}

/** 从磁盘 JSON 清洗出合法设置（缺省字段用默认值，类型错误则回退默认）。 */
function normalizeSettings(raw) {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const out = { ...d };
  if (raw.region && typeof raw.region === 'object') {
    const w = Number(raw.region.width);
    const h = Number(raw.region.height);
    out.region = {
      width: Number.isFinite(w) && w > 0 ? w : null,
      height: Number.isFinite(h) && h > 0 ? h : null,
    };
  }
  out.locked = !!raw.locked;
  out.visible = raw.visible !== false;
  if (raw.pos && Number.isFinite(raw.pos.x) && Number.isFinite(raw.pos.y)) {
    out.pos = { x: raw.pos.x, y: raw.pos.y };
  }
  if (raw.pet && typeof raw.pet.path === 'string') out.pet = { path: raw.pet.path };
  if (raw.background && typeof raw.background === 'object') {
    out.background.path = typeof raw.background.path === 'string' ? raw.background.path : null;
    const op = Number(raw.background.opacity);
    out.background.opacity = Number.isFinite(op)
      ? Math.min(CFG.ui.bgOpacityMax, Math.max(CFG.ui.bgOpacityMin, op))
      : d.background.opacity;
  }
  if (Array.isArray(raw.playlist)) {
    out.playlist = raw.playlist
      .filter((t) => t && typeof t.path === 'string' && t.path.length > 0)
      .map((t) => ({ path: t.path, title: typeof t.title === 'string' ? t.title : '' }));
  }
  const vol = Number(raw.volume);
  out.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : d.volume;
  out.status = raw.status && typeof raw.status === 'object' ? { ...raw.status } : null;
  out.pillCollapsed = !!raw.pillCollapsed;
  out.snapEnabled = raw.snapEnabled !== false;
  out.physicsEnabled = raw.physicsEnabled !== false;
  out.todos = normalizeTodos(raw.todos);
  out.chatRules = normalizeChatRules(raw.chatRules);
  return out;
}

module.exports = { defaultSettings, normalizeSettings };
