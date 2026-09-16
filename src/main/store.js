'use strict';
/**
 * 持久化（主进程）：把设置写到 app.getPath('userData')/settings.json。
 * 写盘做了原子替换（先写 tmp 再 rename），并带简单去抖。
 */
const fs = require('fs');
const path = require('path');
const { normalizeSettings, defaultSettings } = require('../shared/content');

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = defaultSettings();
    this._timer = null;
    this._loaded = false;
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      raw = null;
    }
    this.data = normalizeSettings(raw);
    this._loaded = true;
    return this.data;
  }

  /** 读取时尚未落盘的情况返回默认。 */
  get() {
    return this.data;
  }

  /** 传入需要局部更新的字段（浅合并到最外层）。链式可用。 */
  update(patch) {
    this.data = { ...this.data, ...patch };
    return this;
  }

  updateDeep(key, patch) {
    this.data[key] = { ...(this.data[key] || {}), ...patch };
    return this;
  }

  /** 立即写盘。 */
  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] save failed', e);
    }
  }

  /** 去抖写盘（用于高频变化：状态每秒结算）。 */
  saveSoon(ms = 2000) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.saveNow(); }, ms);
  }

  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.saveNow();
  }
}

module.exports = { Store };
