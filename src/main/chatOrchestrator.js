'use strict';
/**
 * 聊天编排器（主进程）：**文字与语音的唯一汇流点**。
 *
 *   chatSend(text)   ─┐
 *                     ├─► ChatOrchestrator.handle(req) ──► ChatEngine 注册表 ──┬─► rule 引擎（关键词规则）
 *   voiceFinal(text) ─┘                     │                                   └─► llm 引擎（★ 仅预留）
 *                                           ▼
 *                          气泡 bubble:chat / 聊天窗消息 / 未命中 → pet:action headpat
 *
 * 设计要点（对应《语音识别调研与接入方案》§5.2）：
 *  · 签名与返回值对调用方透明：`chatSend` 仍是 `{ ok, matched, reply, keyword? }`，行为零变化。
 *  · 语音接入对聊天系统的全部影响 = 多了一个 `channel:'voice'` 的调用方。
 *  · 引擎不可用（如 llm 未配置/未实现）→ selectEngine 自动回落 rule，桌宠不会"不说话"。
 */
const chat = require('../shared/chat');
const { CFG } = require('../shared/config');

class ChatOrchestrator {
  /** @param {import('./main').PetApp} app 主进程 PetApp（借用其 store / send / 窗口引用） */
  constructor(app) {
    this.app = app;
  }

  /**
   * 只读上下文快照：交给引擎做个性化（rule 只用 chatRules；将来 llm 可拼进 systemPrompt）。
   * 注意：情绪/体力等状态由**渲染层**持有（每秒结算），主进程没有实时值 → 这里不编造，
   * 需要时由主进程向宠物窗取一次快照（后续 LLM 落地时再做，避免每句话都跨进程往返）。
   */
  buildContext(extra) {
    const st = this.app.store.get();
    return {
      chatRules: st.chatRules || [],
      todos: (st.todos || []).map((t) => ({ text: t.text, due: t.due, done: !!t.done, important: !!t.important })),
      study: st.english || null,
      form: this.app.visualMode,
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
  }

  /**
   * 处理一条聊天请求（文字/语音同源）。
   * @param {import('../shared/chat/engine').ChatRequest} req
   * @returns {Promise<{ok:boolean, matched:boolean, reply:string|null, keyword?:string, engine?:string}>}
   */
  async handle(req) {
    const prefs = this.app.store.get().chatEngine || CFG.chatEngine;
    const fallbackId = (CFG.chatEngine && CFG.chatEngine.active) || 'rule';
    const { engine, degradedFrom, requestedId } = chat.selectEngine(prefs, fallbackId);
    if (!engine) {
      return { ok: false, matched: false, reply: null, error: `no-engine(${requestedId})` };
    }
    const full = { ...req, context: this.buildContext(req && req.context) };
    let raw;
    try {
      raw = await engine.send(full);
    } catch (e) {
      raw = { ok: false, matched: false, reply: null, error: (e && e.message) ? e.message : String(e) };
    }
    const r = chat.normalizeResult(raw, engine.id);
    if (degradedFrom) r.meta = { ...(r.meta || {}), degradedFrom }; // 谁被降级掉了（排查用）
    this.dispatch(r, req, engine.id);
    return r.meta && r.meta.keyword ? { ...r, keyword: r.meta.keyword } : r;
  }

  /**
   * 结果分发（与迁移前 chatSend 的行为逐字对齐）：
   *  命中/有回复 → 主窗气泡；未命中 → 桌宠被"点一下"（Q 弹 + 情绪 +2），且**不弹气泡**。
   *
   * ⚠ 这里**只负责宠物窗的视觉反馈**，不再往聊天窗推消息：
   *   2026-09-16 起聊天窗的内容（我的话/桌宠的话/旁白）统一由 main.chatHandle 推送并落记录，
   *   两边都推就会重复显示（而且记录会多一条）。详见 main.js pushChatMessage()。
   */
  dispatch(r, req, engineId) {
    void engineId;
    void req;
    if (r.ok && r.matched && r.reply) {
      this.app.send('bubble:chat', { text: r.reply, ms: CFG.chat.bubbleDurationMs });
    } else if (r.ok && !r.matched) {
      this.app.send('pet:action', { type: 'headpat' });
    }
  }
}

module.exports = { ChatOrchestrator };
