// What the learned sounds have been matching: the last few minutes of
// classifier windows, kept in memory only, so that exporting a sound can say
// what it fired on as well as what it was taught from.
//
// A window is kept as its embedding, level and the learned sounds' scores —
// the same summary the examples are, never audio. Nothing here is saved; it is
// gone on reload, and on a session switch.

export const HISTORY_WINDOWS = 720; // ~3 min at 4 windows a second

export class WindowHistory {
  constructor(max = HISTORY_WINDOWS) {
    this.max = max;
    this.windows = []; // [{ t, db, vec: Float32Array, learned: { id: score } }]
  }

  /** @param {{ embedding: Float32Array, learned: object, db: number }} frame  a non-silent window */
  push(frame, t) {
    if (!frame.embedding || !frame.learned) return;
    this.windows.push({ t, db: frame.db, vec: frame.embedding, learned: frame.learned });
    if (this.windows.length > this.max) this.windows.splice(0, this.windows.length - this.max);
  }

  clear() {
    this.windows = [];
  }

  /**
   * One sound's evidence: the windows it scored at or above `level` (what it
   * matched — what holds an event open), newest first, and an even sample of
   * the rest for contrast.
   * @returns {{ matched: object[], other: object[] }} each `{ t, db, score, vec }`
   */
  forSound(id, level, { matched: maxMatched = 120, other: maxOther = 60 } = {}) {
    const rows = this.windows
      .filter((w) => Number.isFinite(w.learned[id]))
      .map((w) => ({ t: w.t, db: w.db, score: w.learned[id], vec: w.vec }));
    const matched = rows.filter((r) => r.score >= level).slice(-maxMatched).reverse();
    const rest = rows.filter((r) => r.score < level);
    const step = Math.max(1, rest.length / maxOther);
    const other = [];
    for (let i = rest.length - 1; i >= 0 && other.length < maxOther; i -= step) other.push(rest[Math.floor(i)]);
    return { matched, other };
  }
}
