// The detection log: one record per event, newest first.
//
// Detections are data, not just a beep — this is what turns a live display
// into an unattended monitor. Leave a tablet in a room overnight, come back to
// a list of when the thing happened. Kept in memory and exported as CSV; it is
// not part of a session's saved state.

export const LOG_CAPACITY = 1000;

export class DetectionLog {
  constructor({ capacity = LOG_CAPACITY } = {}) {
    this.capacity = capacity;
    this.entries = [];
    this.listeners = new Set();
    this.nextId = 1;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _changed(kind, entry) {
    for (const fn of this.listeners) fn(kind, entry);
  }

  /**
   * Start a record. Confidence, end time and frequency are then updated in
   * place by the engine while the event lasts, without a notification per
   * frame — views refresh those on their own cadence.
   * @param {object} o
   * @param {number} o.t  start, in ms on the `performance.now()` clock
   */
  open({ detectorId, label, source, t, confidence, freq, detail }) {
    const entry = {
      id: this.nextId++,
      detectorId,
      label,
      source,
      detail: detail || '',
      t0: t,
      t1: t,
      wallStart: performance.timeOrigin + t,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      freq: Number.isFinite(freq) ? freq : NaN,
      open: true,
    };
    this.entries.unshift(entry);
    if (this.entries.length > this.capacity) this.entries.length = this.capacity;
    this._changed('add', entry);
    return entry;
  }

  close(entry) {
    if (!entry.open) return;
    entry.open = false;
    this._changed('close', entry);
  }

  clear() {
    if (!this.entries.length) return;
    this.entries = [];
    this._changed('clear', null);
  }

  toCsv() {
    const rows = [['start', 'end', 'duration_s', 'sound', 'detail', 'source', 'confidence', 'frequency_hz']];
    for (const e of [...this.entries].reverse()) {
      const dur = Math.max(0, e.t1 - e.t0);
      rows.push([
        new Date(e.wallStart).toISOString(),
        new Date(e.wallStart + dur).toISOString(),
        (dur / 1000).toFixed(1),
        e.label,
        e.detail,
        e.source,
        e.confidence.toFixed(3),
        Number.isFinite(e.freq) ? e.freq.toFixed(1) : '',
      ]);
    }
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }
}
