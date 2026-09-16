'use strict';
/**
 * 采集用 AudioWorklet：把麦克风输入按 ~20ms 累积成一帧后 postMessage 给主线程。
 * 单独成文件是因为 AudioWorklet 模块必须在独立脚本里 registerProcessor。
 * （若运行环境不允许 addModule —— 例如 file:// 下的 CSP 限制 —— asr.js 会自动退回
 *  ScriptProcessorNode，功能不受影响，只是回调在主线程。）
 */
const FRAME = 320; // 16kHz × 20ms

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(FRAME);
    this._n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n >= FRAME) {
        this.port.postMessage(this._buf.slice(0));
        this._n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
