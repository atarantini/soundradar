// One recording of a sound being taught: the YAMNet embeddings of the windows
// heard between Record and Stop.
//
// It is fed every window the classifier scores, stamped at the window's centre
// on the `performance.now()` clock (yamnet.js). Windows from before Record was
// pressed, and silent ones (below the worker's −70 dBFS gate, which carry no
// embedding), are not kept. It stops by itself once it holds `room` windows,
// the most the sound can still take.

import { MAX_WINDOWS, WINDOW_S } from './learned.js';

export class TeachSession {
  constructor() {
    this.recording = false;
    this.windows = [];
    this.seconds = 0; // audio the kept windows cover
    this.t0 = NaN;
    this.t1 = NaN;
    this.room = MAX_WINDOWS;
    this.full = false;
    this.onchange = null; // () => void, after every kept window and on stop
  }

  /** @param {number} t  now, on the `performance.now()` clock */
  start(t, room = MAX_WINDOWS) {
    this.recording = true;
    this.windows = [];
    this.seconds = 0;
    this.last = -Infinity;
    this.t0 = t;
    this.t1 = NaN;
    this.room = Math.max(0, room);
    this.full = this.room === 0;
    if (this.full) this.stop(t);
  }

  push(embedding, t, silent) {
    if (!this.recording || silent || !embedding || !(t >= this.t0)) return;
    this.windows.push(Float32Array.from(embedding));
    // Overlapping windows add only what is new; spaced-out ones a window each.
    this.seconds += Math.min(WINDOW_S, (t - this.last) / 1000);
    this.last = t;
    if (this.windows.length >= this.room) {
      this.full = true;
      this.stop(t);
      return;
    }
    this.onchange?.();
  }

  /** @returns {Float32Array[]} the windows kept */
  stop(t) {
    if (this.recording) {
      this.recording = false;
      this.t1 = t;
      this.onchange?.();
    }
    return this.windows;
  }

  /** Seconds since Record, or the recording's length once stopped. */
  elapsed(now) {
    if (!Number.isFinite(this.t0)) return 0;
    return ((this.recording ? now : this.t1) - this.t0) / 1000;
  }
}
