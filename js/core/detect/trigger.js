// Turns a stream of 0–1 detector scores into discrete events.
//
// Without this, one bark logs forty detections: the score crosses the
// threshold, dips for a frame, crosses again. Here an event has to hold the
// threshold for `minMs` before it starts, has to fall below a lower release
// level for `releaseMs` before it ends, and cannot start again for
// `refractoryMs` after that.

/** An open event ends below this fraction of the threshold, not at it. */
export const RELEASE_RATIO = 0.8;

export class Trigger {
  /**
   * @param {object} o
   * @param {number} o.threshold     score (0–1) an event has to reach
   * @param {number} [o.minMs]       how long it has to stay there to start
   * @param {number} [o.releaseMs]   how long below the release level to end
   * @param {number} [o.refractoryMs] quiet time after an end before a new start
   */
  constructor({ threshold = 0.5, minMs = 0, releaseMs = 0, refractoryMs = 0 } = {}) {
    this.threshold = threshold;
    this.minMs = minMs;
    this.releaseMs = releaseMs;
    this.refractoryMs = refractoryMs;
    this.reset();
  }

  reset() {
    this.open = false;
    this.aboveSince = NaN; // when the score last rose to the threshold
    this.belowSince = NaN; // when an open event's score last fell below release
    this.blockedUntil = -Infinity;
  }

  get releaseLevel() {
    return this.threshold * RELEASE_RATIO;
  }

  /**
   * @param {number} score 0–1; anything unreadable counts as 0
   * @param {number} t     ms on a monotonic clock
   * @returns {'start'|'update'|'end'|null}
   */
  step(score, t) {
    const s = Number.isFinite(score) ? score : 0;

    if (!this.open) {
      // Pending: the clock starts at the threshold and keeps running through
      // brief dips, as long as the score stays above the release level —
      // real scores flicker, and a flicker should not restart the wait.
      const pending = Number.isFinite(this.aboveSince);
      if (t < this.blockedUntil || s < (pending ? this.releaseLevel : this.threshold)) {
        this.aboveSince = NaN;
        return null;
      }
      if (!pending) this.aboveSince = t;
      if (t - this.aboveSince < this.minMs || s < this.threshold) return null;
      this.open = true;
      this.belowSince = NaN;
      return 'start';
    }

    if (s >= this.releaseLevel) {
      this.belowSince = NaN;
      return 'update';
    }
    if (!Number.isFinite(this.belowSince)) this.belowSince = t;
    if (t - this.belowSince < this.releaseMs) return 'update';
    return this.end(t);
  }

  /** Close an open event now — capture paused, detector switched off. */
  end(t) {
    if (!this.open) return null;
    this.open = false;
    this.aboveSince = NaN;
    this.belowSince = NaN;
    this.blockedUntil = t + this.refractoryMs;
    return 'end';
  }
}
