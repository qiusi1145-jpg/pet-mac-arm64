'use strict';
/**
 * SSE（Server-Sent Events）解析 —— **纯函数、无 IO、可单测**。
 *
 * 为什么单独一个文件：流式与非流式是**两条代码路径**，而"分片边界"最容易出错
 * （一个 `data:` 事件可能被 TCP 切成两半、`\r\n` 与 `\n` 混用、末尾没有空行收尾）。
 * 把协议层拧出来单独测，业务层（llm.js）就只管"怎么解释这些 data"。
 *
 * OpenAI 兼容流式的形态（DeepSeek / OpenAI / Moonshot… 都一样）：
 *   data: {"choices":[{"delta":{"content":"你"},"index":0}]}
 *   data: {"choices":[{"delta":{"content":"好"}}]}
 *   data: [DONE]
 * 每行以 `\n\n` 分隔；另有 `: keep-alive` 心跳注释行需要忽略。
 *
 * 用法：
 *   const p = createSseParser();
 *   for (const data of p.push(chunkText)) { … }      // 边收边喂
 *   for (const data of p.flush()) { … }              // 流结束时把残留吐出来
 */

/** 找最早的"空行"分隔（兼容 \n\n 与 \r\n\r\n）。返回 {at,len} 或 -1。 */
function findSeparator(buf) {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1 && b === -1) return -1;
  if (b === -1) return { at: a, len: 2 };
  if (a === -1) return { at: b, len: 4 };
  return a <= b ? { at: a, len: 2 } : { at: b, len: 4 };
}

/**
 * 从一个事件块里取 data 负载：多行 data 用 \n 连接（SSE 规范）；
 * 忽略注释行（`:` 开头，常用于心跳）。
 * @returns {string|null} 该块没有 data 时返回 null
 */
function extractData(rawBlock) {
  if (!rawBlock) return null;
  const parts = [];
  for (const line of String(rawBlock).split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const m = /^data:(.*)$/.exec(line);
    if (m) parts.push(m[1].replace(/^ /, ''));  // 规范允许冒号后跟一个空格
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * 增量解析器：喂文本块，吐 data 负载。
 * 内部只保留"还没凑成完整事件"的尾巴，所以喂多少块都能正确切分。
 */
function createSseParser() {
  let buf = '';
  return {
    /** @param {string} chunk 任意切分的文本（可以是半个事件） @returns {string[]} 本次确定完成的 data 负载 */
    push(chunk) {
      buf += String(chunk == null ? '' : chunk);
      const out = [];
      let sep;
      while ((sep = findSeparator(buf)) !== -1) {
        const block = buf.slice(0, sep.at);
        buf = buf.slice(sep.at + sep.len);
        const data = extractData(block);
        if (data !== null) out.push(data);
      }
      return out;
    },
    /** 流结束：把没有以空行收尾的最后一段也交出来（某些实现最后一帧不带空行）。 */
    flush() {
      if (!buf.trim()) { buf = ''; return []; }
      const data = extractData(buf);
      buf = '';
      return data === null ? [] : [data];
    },
    /** 尚未消费的残留（排查用）。 */
    get pending() { return buf; },
  };
}

/**
 * 解析一个 OpenAI 兼容的流式 data 负载。
 * @returns {{text?:string, done?:boolean, usage?:Object|null, finishReason?:string|null,
 *            error?:string, parseError?:boolean}}
 */
function parseOpenAiChunk(data) {
  const s = String(data == null ? '' : data).trim();
  if (!s) return { text: '' };
  if (s === '[DONE]') return { done: true, text: '' };
  let j;
  try {
    j = JSON.parse(s);
  } catch {
    return { parseError: true, text: '' };
  }
  // 流式中途也可能塞一个错误对象（例如限流）
  if (j && j.error) {
    const e = j.error;
    return { error: typeof e === 'string' ? e : (e.message || e.code || 'stream error') };
  }
  const choice = (j && Array.isArray(j.choices) && j.choices[0]) || null;
  let text = '';
  if (choice) {
    if (choice.delta && typeof choice.delta.content === 'string') text = choice.delta.content;
    else if (typeof choice.text === 'string') text = choice.text;   // 兼容旧式补全格式
  }
  return {
    text,
    done: false,
    usage: (j && j.usage) || null,
    finishReason: (choice && choice.finish_reason) || null,
  };
}

module.exports = { createSseParser, parseOpenAiChunk, extractData, findSeparator };
