// Runs the enabled detectors and turns their scores into logged events.
//
// A detector only ever answers "how sure am I, right now, 0–1" (plus,
// optionally, where in frequency and which variant). Everything that makes a
// score into a record — thresholds, hysteresis, the refractory period, the
// log entry, the alarm hook — lives here, once, so a new detector is nothing
// but its scoring.
//
// Two inputs, matching a detector's `source`:
//   'spectrum' — an analyser frame, once per animation frame
//   'yamnet'   — a 521-class score vector, about twice a second

import { Trigger } from './trigger.js';

/**
 * The analyser the 'spectrum' detectors read. Fixed, not the display's: the
 * rules are tuned at this resolution and response, and a user zooming the
 * picture with a 32k FFT and heavy smoothing should not quietly blind them.
 */
export const SPECTRUM_INPUT = Object.freeze({ fftSize: 4096, smoothing: 0.5 });

export class DetectionEngine {
  /**
   * @param {object} o
   * @param {object[]} o.catalog  detector definitions
   * @param {import('./log.js').DetectionLog} o.log
   * @param {(kind:'start'|'end', entry:object, def:object)=>void} [o.onEvent]
   */
  constructor({ catalog, log, onEvent }) {
    this.catalog = catalog;
    this.log = log;
    this.onEvent = onEvent;
    this.slots = new Map(); // id → { def, trigger, instance, entry, t }
    this.scores = new Map(); // id → latest score, for live meters
    this.active = new Set(); // ids with an event open right now
    this.needsModel = false;
    this.needsSpectrum = false;
  }

  /**
   * Match the running set to a `settings.detectors` map. Detectors keep their
   * state across a threshold change; switching one off closes its event.
   */
  configure(config = {}) {
    const wanted = new Set();
    for (const def of this.catalog) {
      const c = config[def.id];
      if (!c?.on) continue;
      wanted.add(def.id);
      let slot = this.slots.get(def.id);
      if (!slot) {
        slot = {
          def,
          trigger: new Trigger(def),
          instance: def.create ? def.create() : null,
          entry: null,
          t: NaN,
        };
        this.slots.set(def.id, slot);
      }
      slot.trigger.threshold = Number.isFinite(c.threshold) ? c.threshold : def.threshold;
    }
    for (const [id, slot] of this.slots) {
      if (wanted.has(id)) continue;
      this._finish(slot, slot.t);
      this.slots.delete(id);
      this.scores.delete(id);
    }
    const sources = new Set([...this.slots.values()].map((s) => s.def.source));
    this.needsModel = sources.has('yamnet');
    this.needsSpectrum = sources.has('spectrum');
  }

  isOn(id) {
    return this.slots.has(id);
  }

  thresholdOf(id) {
    return this.slots.get(id)?.trigger.threshold ?? NaN;
  }

  /** One analyser frame (see `SPECTRUM_INPUT`), `now` in ms. */
  updateSpectrum(data, sampleRate, fftSize, now) {
    if (!data) return;
    const frame = { data, sampleRate, fftSize, t: now };
    for (const slot of this.slots.values()) {
      if (slot.def.source !== 'spectrum') continue;
      this._step(slot, slot.instance.update(frame), now);
    }
  }

  /** One YAMNet score vector, stamped at the centre of its window. */
  updateScores(scores, t) {
    for (const slot of this.slots.values()) {
      if (slot.def.source !== 'yamnet') continue;
      this._step(slot, slot.def.score(scores), t);
    }
  }

  /** Capture is not running: close open events and drop the meters. */
  idle(t) {
    for (const slot of this.slots.values()) {
      this._finish(slot, Number.isFinite(slot.t) ? slot.t : t);
      slot.instance?.reset();
      this.scores.set(slot.def.id, NaN);
    }
  }

  /** Forget everything in flight — a session switch. */
  reset() {
    for (const slot of this.slots.values()) {
      slot.trigger.reset();
      slot.instance?.reset();
      slot.entry = null;
    }
    this.scores.clear();
    this.active.clear();
  }

  _step(slot, result, t) {
    const { def, trigger } = slot;
    const score = Number.isFinite(result?.score) ? result.score : 0;
    slot.t = t;
    this.scores.set(def.id, score);

    const event = trigger.step(score, t);
    if (event === 'start') {
      slot.entry = this.log.open({
        detectorId: def.id,
        label: def.label,
        source: def.source,
        // The event began when the score first rose, not when `minMs` ran out.
        t: Number.isFinite(trigger.aboveSince) ? trigger.aboveSince : t,
        confidence: score,
        freq: result?.freq,
        detail: result?.detail,
      });
      slot.entry.t1 = t;
      this.active.add(def.id);
      this.onEvent?.('start', slot.entry, def);
    } else if (event === 'update' && slot.entry) {
      const e = slot.entry;
      if (score >= trigger.releaseLevel) e.t1 = t;
      if (score > e.confidence) {
        e.confidence = score;
        if (result?.detail) e.detail = result.detail;
      }
      // Track where a sweeping source is now, so the waterfall tick follows it.
      if (Number.isFinite(result?.freq)) e.freq = result.freq;
    } else if (event === 'end') {
      this._close(slot);
    }
  }

  _finish(slot, t) {
    if (slot.trigger.end(t) === 'end') this._close(slot);
  }

  _close(slot) {
    const entry = slot.entry;
    slot.entry = null;
    this.active.delete(slot.def.id);
    if (!entry) return;
    this.log.close(entry);
    this.onEvent?.('end', entry, slot.def);
  }
}
