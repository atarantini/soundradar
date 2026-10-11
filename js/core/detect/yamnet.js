// Main-thread side of the YAMNet classifier.
//
// Owns the worker and the capture tap. Nothing is loaded until a YAMNet
// category or a learned sound is switched on, or a sound is being taught — the runtime and weights ship with the app, but
// ~17 MB is not something to fetch on every visit — and switching the last one
// off terminates the worker, which frees the model.
//
// The tap is attached once per AudioContext and stays connected through
// device switches: `AudioEngine` re-connects its taps to each new source.

import { CaptureTap } from '../capture.js';

export const YAMNET_MODEL = Object.freeze({
  name: 'YAMNet',
  url: new URL('../../../models/yamnet/model.json', import.meta.url).href,
  workerUrl: new URL('./yamnet-worker.js', import.meta.url),
  sizeMb: 16,
  licence: 'Apache-2.0',
  classes: 521,
});

/** Half of the 0.975 s window: scores describe its centre, not its end. */
const WINDOW_CENTRE_MS = 488;

export class YamnetClassifier {
  constructor({ model = YAMNET_MODEL } = {}) {
    this.model = model;
    this.worker = null;
    this.tap = new CaptureTap();
    this.state = 'off'; // off | loading | ready | error
    this.error = '';
    this.backend = '';
    this.ms = NaN; // inference time of the last scored window
    // (frame: { scores, embedding, learned, db }, t: number, silent: boolean) => void
    this.onwindow = null;
    this.onstate = null; // (classifier) => void
    this.bank = null; // the learned sounds' examples, kept to hand to a new worker
    this._attaching = null;
  }

  _set(state, patch = {}) {
    Object.assign(this, { state }, patch);
    this.onstate?.(this);
  }

  /**
   * Make sure the model is loading or loaded, and that it is listening to the
   * engine if capture is running. Safe to call repeatedly.
   */
  enable(engine) {
    if (!this.worker) this._spawn();
    if (engine.running && engine.ctx && !this.tap.attached && !this._attaching) {
      this._attaching = this.tap
        .open(engine)
        .then(({ port, sampleRate }) => {
          // Disabled while the worklet module was loading.
          if (!this.worker) {
            this.tap.close();
            port.close();
            return;
          }
          this.worker.postMessage({ type: 'input', port, sampleRate }, [port]);
        })
        .catch((err) => this._set('error', { error: err.message || String(err) }))
        .finally(() => {
          this._attaching = null;
        });
    }
  }

  /** Stop listening and drop the model. */
  disable() {
    this.tap.close();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.state !== 'off') this._set('off', { error: '', backend: '', ms: NaN });
  }

  /**
   * The learned sounds to match, from `bankOf()` in learned.js. Kept here so a
   * worker spawned later (or again) gets the same bank.
   */
  setBank(bank) {
    this.bank = bank;
    this._sendBank();
  }

  _sendBank() {
    if (!this.worker) return;
    const { ids = [], counts = [], bank = null } = this.bank || {};
    // A copy is transferred: this one is kept for the next worker.
    const copy = bank ? bank.slice() : null;
    this.worker.postMessage({ type: 'bank', ids, counts, bank: copy }, copy ? [copy.buffer] : []);
  }

  _spawn() {
    let worker;
    try {
      worker = new Worker(this.model.workerUrl, { type: 'module' });
    } catch (err) {
      this._set('error', { error: `Could not start the classifier: ${err.message || err}` });
      return;
    }
    this.worker = worker;
    worker.onmessage = (e) => this._message(e.data || {});
    worker.onerror = (e) => {
      e.preventDefault?.();
      this._set('error', { error: e.message || 'The classifier stopped unexpectedly.' });
    };
    worker.postMessage({ type: 'load', modelUrl: this.model.url });
    this._sendBank();
    this._set('loading', { error: '' });
  }

  _message(msg) {
    if (msg.type === 'ready') {
      this._set('ready', { backend: msg.backend, error: '' });
    } else if (msg.type === 'error') {
      this._set('error', { error: msg.message || 'The classifier failed.' });
    } else if (msg.type === 'scores') {
      if (!msg.silent) this.ms = msg.ms;
      // Same clock as requestAnimationFrame's `now`, so the waterfall can
      // place the result on the row it describes.
      const t = msg.wallEnd - performance.timeOrigin - WINDOW_CENTRE_MS;
      this.onwindow?.({ scores: msg.scores, embedding: msg.embedding, learned: msg.learned, db: msg.db }, t, msg.silent);
    }
  }
}
