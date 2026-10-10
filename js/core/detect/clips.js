// Sound clips of detections, so a detection can be heard again or saved.
//
// This is the one feature that keeps audio, so it is opt-in and it keeps
// audio only in this tab's memory: never in storage, never uploaded. A clip
// runs from a little before the event started (the sound that tripped the
// detector rises before the detector is sure) to a little after it ended,
// capped in length, and is dropped when its log record is — removed, cleared,
// a session switch — or when the option is turned off.
//
// Raw samples come from a capture tap of their own (an AudioWorklet), into a
// rolling buffer a little longer than the longest clip. The buffer is
// addressed by sample count, anchored to the arrival time of the newest
// chunk; a gap in arrivals (a pause) breaks that clock, so the buffer starts
// over rather than splicing audio from either side of it.

import { CaptureTap } from '../capture.js';

export const CLIP_LIMITS = Object.freeze({
  preMs: 2000, // before the event's start
  postMs: 1000, // after its end
  maxMs: 12000, // longest clip, however long the event
  ringSeconds: 20, // rolling buffer; must exceed maxMs plus detection lag
  maxClips: 50, // oldest dropped past either limit
  maxBytes: 64 * 1024 * 1024,
});

const FADE_MS = 10; // ramp clip edges so playback starts and stops without a click

export class ClipRecorder {
  /**
   * @param {object} o
   * @param {import('./log.js').DetectionLog} o.log
   * @param {() => number} [o.now] clock in ms, same as the log's (`performance.now`)
   */
  constructor({ log, now = () => performance.now(), ...limits }) {
    Object.assign(this, CLIP_LIMITS, limits);
    this.log = log;
    this.now = now;
    this.tap = new CaptureTap();
    this.enabled = false;
    this.port = null;
    this.sampleRate = 0;
    this.ring = null;
    this.written = 0; // samples ever written into the ring
    this.lastArrival = NaN; // when the newest sample arrived
    this.pending = new Map(); // entry id → { entry, start }
    this.clips = new Map(); // entry id → { blob, url, ms, bytes }, oldest first
    this.listeners = new Set();
    this._attaching = null;
    log.subscribe((kind, entry) => this._onLog(kind, entry));
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(id) {
    for (const fn of this.listeners) fn(id);
  }

  /** 'recording' while a clip is still being captured, 'ready', or null. */
  state(id) {
    if (this.clips.has(id)) return 'ready';
    return this.pending.has(id) ? 'recording' : null;
  }

  get(id) {
    return this.clips.get(id) || null;
  }

  /** Keep clips from now on, tapping the engine if capture is running. */
  enable(engine) {
    this.enabled = true;
    if (!engine.running || !engine.ctx || this.tap.attached || this._attaching) return;
    this._attaching = this.tap
      .open(engine)
      .then(({ port, sampleRate }) => {
        if (!this.enabled) {
          this.tap.close();
          port.close();
          return;
        }
        this.port = port;
        this.begin(sampleRate);
        port.onmessage = (e) => this.push(e.data, this.now());
      })
      .catch(() => {
        /* no AudioWorklet: rows simply get no clip */
      })
      .finally(() => {
        this._attaching = null;
      });
  }

  /** Stop listening but keep the clips already made (no detector is on). */
  detach() {
    this.enabled = false;
    this.flush();
    this.tap.close();
    this.port?.close();
    this.port = null;
    this.ring = null;
  }

  /** Turn the option off: stop listening and forget every clip. */
  disable() {
    this.detach();
    this.pending.clear();
    this._dropAll();
  }

  /** Start a fresh rolling buffer at this rate. */
  begin(sampleRate) {
    this.sampleRate = sampleRate;
    this.ring = new Float32Array(Math.round(sampleRate * this.ringSeconds));
    this.written = 0;
    this.lastArrival = NaN;
  }

  /** One chunk of raw audio, which finished arriving at `t` ms. */
  push(chunk, t) {
    if (!this.ring || !(chunk instanceof Float32Array)) return;
    const chunkMs = (chunk.length / this.sampleRate) * 1000;
    if (Number.isFinite(this.lastArrival) && t - this.lastArrival > chunkMs * 3 + 500) {
      // Pause or stall: the sample count no longer tells time across the gap.
      this.written = 0;
    }
    const n = this.ring.length;
    let pos = this.written % n;
    let i = 0;
    while (i < chunk.length) {
      const take = Math.min(chunk.length - i, n - pos);
      this.ring.set(chunk.subarray(i, i + take), pos);
      i += take;
      pos = (pos + take) % n;
    }
    this.written += chunk.length;
    this.lastArrival = t;
    this._service(t);
  }

  /** Capture paused or stopped: cut every pending clip from what has arrived. */
  flush() {
    for (const [id, p] of [...this.pending]) {
      this._finish(id, p, Math.min(this.lastArrival, p.start + this.maxMs));
    }
  }

  _onLog(kind, entry) {
    if (kind === 'add') {
      if (!this.enabled || !this.ring) return;
      this.pending.set(entry.id, { entry, start: entry.t0 - this.preMs });
      this._notify(entry.id);
    } else if (kind === 'remove') {
      this.pending.delete(entry.id);
      this._drop(entry.id);
    } else if (kind === 'clear') {
      this.pending.clear();
      this._dropAll();
    }
  }

  _service(t) {
    for (const [id, p] of [...this.pending]) {
      const cap = p.start + this.maxMs;
      const end = p.entry.open ? cap : Math.min(cap, p.entry.t1 + this.postMs);
      if (t >= end) this._finish(id, p, end);
    }
  }

  _finish(id, p, end) {
    this.pending.delete(id);
    const samples = this._slice(p.start, end);
    if (samples && samples.length >= this.sampleRate * 0.25) {
      const blob = encodeWav(samples, this.sampleRate);
      this.clips.set(id, {
        blob,
        url: URL.createObjectURL(blob),
        ms: (samples.length / this.sampleRate) * 1000,
        bytes: blob.size,
      });
      this._evict();
    }
    this._notify(id);
  }

  /** Samples between two times, clamped to what the ring still holds. */
  _slice(from, to) {
    if (!this.ring || !this.written || !Number.isFinite(this.lastArrival)) return null;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const n = this.ring.length;
    const at = (t) => Math.round(this.written - ((this.lastArrival - t) * this.sampleRate) / 1000);
    const a = Math.max(at(from), this.written - n, 0);
    const b = Math.min(at(to), this.written);
    if (b <= a) return null;
    const out = new Float32Array(b - a);
    for (let i = a; i < b; i++) out[i - a] = this.ring[i % n];
    return out;
  }

  _evict() {
    let bytes = 0;
    for (const c of this.clips.values()) bytes += c.bytes;
    for (const [id, c] of this.clips) {
      if (this.clips.size <= this.maxClips && bytes <= this.maxBytes) break;
      bytes -= c.bytes;
      this._drop(id);
    }
  }

  _drop(id) {
    const c = this.clips.get(id);
    if (!c) return;
    URL.revokeObjectURL(c.url);
    this.clips.delete(id);
    this._notify(id);
  }

  _dropAll() {
    for (const id of [...this.clips.keys()]) this._drop(id);
  }
}

/**
 * Mono float samples → a 16-bit PCM WAV blob. WAV because every browser and
 * every audio tool plays it, and a clip of a few seconds does not need
 * compressing.
 */
export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (at, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  const fade = Math.min(Math.round((sampleRate * FADE_MS) / 1000), samples.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    const edge = Math.min(i, samples.length - 1 - i);
    const gain = edge < fade ? edge / fade : 1;
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
