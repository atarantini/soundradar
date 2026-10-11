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
//   'yamnet'   — a 521-class score vector, up to four times a second
//   'learned'  — the same YAMNet window, as its similarity to a sound the
//                user taught (matched in the worker; see learned.js)

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
    this.slots = new Map(); // id → { def, trigger, instance, entry, reopen, t }
    this.scores = new Map(); // id → latest score, for live meters
    this.active = new Set(); // ids with an event open right now
    this.needsModel = false;
    this.needsSpectrum = false;
    // Until this time (performance.now ms) nothing new is logged: a clip being
    // replayed over speakers reaches the microphone and is not a new event.
    this.quietUntil = -Infinity;
    log.subscribe((kind) => {
      if (kind === 'clear') this._cleared();
    });
  }

  /**
   * The log was cleared — "start the list over", not "stop listening". A
   * sound still going on would otherwise keep updating a record nobody can
   * see, and nothing new would appear until it stopped. Instead it starts a
   * fresh record on its next score. The trigger and the rules' history are
   * kept, so nothing has to re-learn the sound. (Removing one record with ✕
   * is different: that dismisses the event for as long as it lasts.)
   */
  _cleared() {
    for (const slot of this.slots.values()) {
      if (!slot.entry) continue;
      slot.entry = null;
      slot.reopen = true;
    }
  }

  /**
   * Swap in a new catalog — the user taught, renamed or deleted a sound. Call
   * `configure()` after it: that is what starts and stops detectors.
   */
  setCatalog(catalog) {
    this.catalog = catalog;
    // A renamed sound keeps its slot and its trigger, under its new label.
    for (const def of catalog) {
      const slot = this.slots.get(def.id);
      if (slot) slot.def = def;
    }
  }

  /**
   * Match the running set to a `settings.detectors` map. Detectors keep their
   * state across a threshold change; switching one off closes its event.
   * @param {object} config  `settings.detectors`
   * @param {(def:object)=>number} [thresholdFor] the effective threshold of a
   *   detector; by default its own setting, else the catalog's
   */
  configure(config = {}, thresholdFor = (def) => (Number.isFinite(config[def.id]?.threshold) ? config[def.id].threshold : def.threshold)) {
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
      slot.trigger.threshold = thresholdFor(def);
    }
    for (const [id, slot] of this.slots) {
      if (wanted.has(id)) continue;
      this._finish(slot, slot.t);
      this.slots.delete(id);
      this.scores.delete(id);
    }
    const sources = new Set([...this.slots.values()].map((s) => s.def.source));
    this.needsModel = sources.has('yamnet') || sources.has('learned');
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

  /**
   * One YAMNet window, stamped at its centre: `{ scores, learned }`, where
   * `learned` maps a taught sound's id to its similarity (null when silent).
   */
  updateModel(frame, t) {
    for (const slot of this.slots.values()) {
      const { source } = slot.def;
      if (source === 'yamnet') this._step(slot, slot.def.score(frame.scores), t);
      else if (source === 'learned') this._step(slot, slot.def.score(frame), t);
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
      slot.reopen = false;
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
    if (event === 'start' && performance.now() < this.quietUntil) {
      // Let the trigger run its course for this sound, but log nothing.
      slot.entry = null;
    } else if (event === 'start') {
      // The event began when the score first rose, not when `minMs` ran out.
      this._open(slot, result, score, Number.isFinite(trigger.aboveSince) ? trigger.aboveSince : t, t);
      this.onEvent?.('start', slot.entry, def);
    } else if (event === 'update' && slot.reopen) {
      // Still going after a Clear: a fresh record from now, without a chime —
      // it is the same sound, not a new one.
      slot.reopen = false;
      this._open(slot, result, score, t, t);
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

  _open(slot, result, score, t0, t) {
    slot.entry = this.log.open({
      detectorId: slot.def.id,
      label: slot.def.label,
      source: slot.def.source,
      t: t0,
      confidence: score,
      freq: result?.freq,
      detail: result?.detail,
    });
    slot.entry.t1 = t;
    this.active.add(slot.def.id);
  }

  _finish(slot, t) {
    if (slot.trigger.end(t) === 'end') this._close(slot);
  }

  _close(slot) {
    const entry = slot.entry;
    slot.entry = null;
    slot.reopen = false;
    this.active.delete(slot.def.id);
    if (!entry) return;
    this.log.close(entry);
    this.onEvent?.('end', entry, slot.def);
  }
}
