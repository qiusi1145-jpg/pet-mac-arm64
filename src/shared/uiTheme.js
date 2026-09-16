'use strict';
/**
 * UI 主题偏好（纯函数，可单测）：通用设置窗切换的工具窗 accent 主题色。
 * 2026-09-17 起：除「学习」模块外的工具窗 = 苹果极简风（apple.css），
 * accent 可在预设色里切换；主窗 HUD 与学习模块不受影响。
 * 只做数据处理；持久化在 settings.json 的 uiPrefs 字段（store 双份同步）。
 */

/** 预设 accent（Apple 系统色系）；strong = hover 加深，weak = 淡底，由 apple.css 落地。 */
const ACCENTS = {
  blue: { label: '蓝', color: '#007aff' },
  purple: { label: '紫', color: '#af52de' },
  pink: { label: '粉', color: '#ff2d55' },
  green: { label: '绿', color: '#34c759' },
  orange: { label: '橙', color: '#ff9500' },
  graphite: { label: '灰', color: '#8e8e93' },
};

const DEFAULT_ACCENT = 'blue';

/** 清洗 uiPrefs：只认白名单里的 accent id，非法/缺省回退 blue（防手改 settings 改坏）。 */
function normalizeAccentPref(raw) {
  if (raw && typeof raw === 'object' && typeof raw.accent === 'string' && ACCENTS[raw.accent]) {
    return { accent: raw.accent };
  }
  return { accent: DEFAULT_ACCENT };
}

module.exports = { ACCENTS, DEFAULT_ACCENT, normalizeAccentPref };
