// One recording of a sound being taught: the YAMNet embeddings of the windows
// heard between Record and Stop.
//
// It is fed every window the classifier scores, stamped at the window's centre
// on the `performance.now()` clock (yamnet.js), with its level in dBFS. Windows
// from before Record was pressed, and silent ones (below the worker's −70 dBFS
// gate, which carry no embedding), are not kept. It stops by itself once it
// holds `room` windows, the most the sound can still take.
//
// On Stop only the windows within `LEVEL_SPREAD_DB` of the loudest one are
// kept. A room is rarely below the silence gate, so a recording that waits for
// the sound also holds the room in between — and a sound taught from the room
// matches the room, which then reads as the sound for as long as it is quiet.
// The same spread is what the spike and `yamnet-centre.js` used.

import { MAX_WINDOWS, WINDOW_S } from './learned.js';

export const LEVEL_SPREAD_DB = 15;

/**
 * Each window's share of the recording: the stretch since the window before
 * it (a full window for the first, or after a gap). Shares add up to the time
 * covered, so the kept and the dropped windows' shares split it between the
 * sound and the background.
 */
function shares(windows) {
  return windows.map((w, i) => (i ? Math.min(WINDOW_S, (w.t - windows[i - 1].t) / 1000) : WINDOW_S));
}

export class TeachSession {
  constructor() {
    this.recording = false;
    this.windows = []; // [{ vec: Float32Array, t, db }]
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
    this.t0 = t;
    this.t1 = NaN;
    this.room = Math.max(0, room);
    this.full = this.room === 0;
    if (this.full) this.stop(t);
  }

  push(embedding, t, silent, db = 0) {
    if (!this.recording || silent || !embedding || !(t >= this.t0)) return;
    this.windows.push({ vec: Float32Array.from(embedding), t, db: Number.isFinite(db) ? db : 0 });
    if (this.windows.length >= this.room) {
      this.full = true;
      this.stop(t);
      return;
    }
    this.onchange?.();
  }

  /** Seconds of sound heard so far, before the level filter. */
  get seconds() {
    return shares(this.windows).reduce((a, b) => a + b, 0);
  }

  /**
   * Stop, and keep what is loud enough to be the sound.
   * @returns {{ vecs: Float32Array[], dbs: number[], seconds: number, backgroundSeconds: number }}
   */
  stop(t) {
    if (this.recording) {
      this.recording = false;
      this.t1 = t;
      this.onchange?.();
    }
    return this.result();
  }

  result() {
    const top = Math.max(...this.windows.map((w) => w.db));
    const share = shares(this.windows);
    let seconds = 0;
    let backgroundSeconds = 0;
    const kept = [];
    this.windows.forEach((w, i) => {
      if (w.db >= top - LEVEL_SPREAD_DB) {
        kept.push(w);
        seconds += share[i];
      } else {
        backgroundSeconds += share[i];
      }
    });
    return {
      vecs: kept.map((w) => w.vec),
      dbs: kept.map((w) => Math.round(w.db * 10) / 10),
      seconds,
      backgroundSeconds,
    };
  }

  /** Seconds since Record, or the recording's length once stopped. */
  elapsed(now) {
    if (!Number.isFinite(this.t0)) return 0;
    return ((this.recording ? now : this.t1) - this.t0) / 1000;
  }
}
