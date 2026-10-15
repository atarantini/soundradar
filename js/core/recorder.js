// Manual recordings: the user presses Record, hears it again, saves it.
//
// Like clips (detect/clips.js) this keeps audio, but only in this tab's memory
// and only because the user asked for it: never in storage, never uploaded.
// Samples come from a capture tap of its own, are kept as 16-bit chunks (about
// 5.8 MB a minute at 48 kHz) and are put together into a WAV blob only when the
// take ends, without copying them into one array first.

import { CaptureTap } from './capture.js';

export const TAKE_LIMITS = Object.freeze({
  maxMs: 10 * 60 * 1000, // longest take; recording stops by itself here
  maxTakes: 5, // Record refuses past this rather than dropping the user's audio
});

let nextId = 1;

export class TakeRecorder {
  constructor(limits = {}) {
    Object.assign(this, TAKE_LIMITS, limits);
    this.tap = new CaptureTap();
    this.port = null;
    this.sampleRate = 0;
    this.chunks = [];
    this.samples = 0;
    this.wallStart = 0;
    this.takes = []; // oldest first: { id, blob, url, ms, bytes, wallStart }
    this.listeners = new Set();
    this._starting = null;
    this.recording = false;
    /** Why the last start() did not start, for the view to show. */
    this.error = '';
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) fn();
  }

  get full() {
    return this.takes.length >= this.maxTakes;
  }

  /** Length of the take in progress, in ms, counted from samples (so pauses never stretch it). */
  get elapsedMs() {
    return this.sampleRate ? (this.samples / this.sampleRate) * 1000 : 0;
  }

  get(id) {
    return this.takes.find((t) => t.id === id) || null;
  }

  /** Begin a take on a running engine. Resolves once samples are flowing. */
  async start(engine) {
    if (this.recording || this._starting) return;
    this.error = '';
    if (this.full) {
      this.error = `${this.maxTakes} recordings are kept: delete one to record another.`;
      this._notify();
      return;
    }
    if (!engine.running || !engine.ctx) return;
    this._starting = this.tap.open(engine);
    try {
      const { port, sampleRate } = await this._starting;
      this.port = port;
      this.sampleRate = sampleRate;
      this.chunks = [];
      this.samples = 0;
      this.wallStart = Date.now();
      this.recording = true;
      port.onmessage = (e) => this._push(e.data);
    } catch {
      this.error = 'This browser cannot record raw audio (no AudioWorklet support).';
    } finally {
      this._starting = null;
    }
    this._notify();
  }

  _push(chunk) {
    if (!this.recording || !(chunk instanceof Float32Array)) return;
    const room = Math.round((this.sampleRate * this.maxMs) / 1000) - this.samples;
    const n = Math.min(chunk.length, room);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.chunks.push(pcm);
    this.samples += n;
    if (n < chunk.length) this.stop(); // reached the cap
  }

  /** End the take and keep it. Returns it, or null when nothing was recorded. */
  stop() {
    if (!this.recording) return null;
    this.recording = false;
    this.tap.close();
    this.port?.close();
    this.port = null;
    let take = null;
    if (this.samples >= this.sampleRate * 0.25) {
      const blob = wavBlob(this.chunks, this.samples, this.sampleRate);
      take = {
        id: nextId++,
        blob,
        url: URL.createObjectURL(blob),
        ms: this.elapsedMs,
        bytes: blob.size,
        wallStart: this.wallStart,
      };
      this.takes.push(take);
    }
    this.chunks = [];
    this.samples = 0;
    this._notify();
    return take;
  }

  remove(id) {
    const i = this.takes.findIndex((t) => t.id === id);
    if (i < 0) return;
    URL.revokeObjectURL(this.takes[i].url);
    this.takes.splice(i, 1);
    this.error = '';
    this._notify();
  }
}

/** 16-bit mono PCM chunks → a WAV blob, the chunks referenced rather than copied. */
export function wavBlob(chunks, samples, sampleRate) {
  const head = new DataView(new ArrayBuffer(44));
  const str = (at, s) => {
    for (let i = 0; i < s.length; i++) head.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  head.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true); // PCM
  head.setUint16(22, 1, true); // mono
  head.setUint32(24, sampleRate, true);
  head.setUint32(28, sampleRate * 2, true);
  head.setUint16(32, 2, true);
  head.setUint16(34, 16, true);
  str(36, 'data');
  head.setUint32(40, samples * 2, true);
  return new Blob([head.buffer, ...chunks], { type: 'audio/wav' });
}
