// YAMNet, off the main thread.
//
// Receives raw audio from the capture tap over a MessagePort, resamples it to
// 16 kHz, and every quarter second scores the latest 0.975 s — one YAMNet patch —
// against the model's 521 AudioSet classes. Scores go back to the page; audio
// never leaves this worker.
//
// Messages in:   { type: 'load', modelUrl }
//                { type: 'input', port, sampleRate }   (port transferred)
//                { type: 'detach' }
// Messages out:  { type: 'ready', backend } | { type: 'error', message }
//                { type: 'scores', scores, wallEnd, ms, silent }

import * as tf from '../../vendor/tf.fesm.min.js';
import { Resampler } from '../resample.js';

const RATE = 16000;
const WINDOW = 15600; // 0.975 s, exactly one YAMNet patch → one score frame
// 0.25 s between windows when the backend keeps up. Each instant then falls
// in about four windows, so a click or a slam lasting a fraction of a second
// lands near the middle of at least one — at a 0.5 s hop, short sounds read
// at half the score they get when centred. On a GPU a window costs ~10–30 ms.
const HOP = 4000;
const MAX_HOP = RATE * 3;
const CLASSES = 521;
// Below this the window is silence; skipping it keeps an idle monitor idle.
const SILENCE_RMS = 10 ** (-70 / 20);

let model = null;
let resampler = null;
let input = null;
const ring = new Float32Array(WINDOW);
let filled = 0;
let sinceLast = 0;
let hop = HOP;
let busy = false;

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'load') load(msg.modelUrl);
  else if (msg.type === 'input') attach(msg.port, msg.sampleRate);
  else if (msg.type === 'detach') detach();
};

async function load(url) {
  try {
    const backend = await pickBackend();
    model = await tf.loadGraphModel(url);
    // The first run compiles kernels (shaders, on WebGL) — pay for it now
    // rather than on the first real window.
    tf.tidy(() => model.execute(tf.zeros([WINDOW])));
    self.postMessage({ type: 'ready', backend });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
}

/** WebGL through OffscreenCanvas where the browser has it; CPU otherwise. */
async function pickBackend() {
  for (const name of ['webgl', 'cpu']) {
    try {
      if (await tf.setBackend(name)) {
        await tf.ready();
        return name;
      }
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No TensorFlow.js backend could start in this browser.');
}

function attach(port, sampleRate) {
  detach();
  input = port;
  resampler = new Resampler(sampleRate, RATE);
  filled = 0;
  sinceLast = 0;
  input.onmessage = (e) => push(e.data);
}

function detach() {
  if (input) {
    input.onmessage = null;
    input.close();
  }
  input = null;
  resampler = null;
}

function push(chunk) {
  if (!resampler || !(chunk instanceof Float32Array)) return;
  const y = resampler.process(chunk);
  if (y.length >= WINDOW) {
    ring.set(y.subarray(y.length - WINDOW));
  } else {
    ring.copyWithin(0, y.length);
    ring.set(y, WINDOW - y.length);
  }
  filled = Math.min(WINDOW, filled + y.length);
  sinceLast += y.length;
  if (model && !busy && filled >= WINDOW && sinceLast >= hop) classify();
}

async function classify() {
  busy = true;
  sinceLast = 0;
  const wallEnd = performance.timeOrigin + performance.now();

  let sum = 0;
  for (let i = 0; i < WINDOW; i++) sum += ring[i] * ring[i];
  if (Math.sqrt(sum / WINDOW) < SILENCE_RMS) {
    const scores = new Float32Array(CLASSES);
    self.postMessage({ type: 'scores', scores, wallEnd, ms: 0, silent: true }, [scores.buffer]);
    busy = false;
    return;
  }

  try {
    const t0 = performance.now();
    const waveform = ring.slice();
    const mean = tf.tidy(() => {
      const out = model.execute(tf.tensor1d(waveform));
      const list = Array.isArray(out) ? out : [out];
      const scores = list.find((t) => t.shape[t.shape.length - 1] === CLASSES);
      return scores.mean(0);
    });
    const scores = Float32Array.from(await mean.data());
    mean.dispose();
    const ms = performance.now() - t0;
    // A slow backend widens the hop instead of queueing windows it cannot
    // finish: fewer, current answers beat a growing backlog of stale ones.
    hop = Math.min(MAX_HOP, Math.max(HOP, Math.round((ms * 1.5 * RATE) / 1000)));
    self.postMessage({ type: 'scores', scores, wallEnd, ms, silent: false }, [scores.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  } finally {
    busy = false;
  }
}
