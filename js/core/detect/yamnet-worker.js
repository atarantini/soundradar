// YAMNet, off the main thread.
//
// Receives raw audio from the capture tap over a MessagePort, resamples it to
// 16 kHz, and every quarter second scores the latest 0.975 s — one YAMNet patch —
// against the model's 521 AudioSet classes. The same run also yields the
// window's 1024-d embedding, which is matched against the sounds the user has
// taught (learned.js): one matrix product against every stored example. Scores,
// similarities and the embedding go back to the page; audio never leaves this
// worker.
//
// Messages in:   { type: 'load', modelUrl }
//                { type: 'input', port, sampleRate }   (port transferred)
//                { type: 'detach' }
//                { type: 'bank', ids, counts, bank }   (learned sounds; bank transferred)
// Messages out:  { type: 'ready', backend } | { type: 'error', message }
//                { type: 'scores', scores, embedding, learned, db, wallEnd, ms, silent }
//                (`db`: the window's RMS level in dBFS)

import * as tf from '../../vendor/tf.fesm.min.js';
import { Resampler } from '../resample.js';
import { YAMNET_CENTRE } from './yamnet-centre.js';

const RATE = 16000;
const WINDOW = 15600; // 0.975 s, exactly one YAMNet patch → one score frame
// 0.25 s between windows when the backend keeps up. Each instant then falls
// in about four windows, so a click or a slam lasting a fraction of a second
// lands near the middle of at least one — at a 0.5 s hop, short sounds read
// at half the score they get when centred. On a GPU a window costs ~10–30 ms.
const HOP = 4000;
const MAX_HOP = RATE * 3;
const CLASSES = 521;
const DIMS = 1024;
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
// Learned sounds: every stored example window, centred and unit length, as
// rows of one matrix; `segments` says which rows belong to which sound.
let bank = null; // tf.Tensor2D [rows, DIMS]
let segments = []; // [{ id, start, end }]
let centre = null; // tf.Tensor1D
let pendingBank = null; // a bank that arrived before the backend was chosen

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'load') load(msg.modelUrl);
  else if (msg.type === 'input') attach(msg.port, msg.sampleRate);
  else if (msg.type === 'detach') detach();
  else if (msg.type === 'bank') setBank(msg);
};

async function load(url) {
  try {
    const backend = await pickBackend();
    model = await tf.loadGraphModel(url);
    // The first run compiles kernels (shaders, on WebGL) — pay for it now
    // rather than on the first real window.
    tf.tidy(() => model.execute(tf.zeros([WINDOW])));
    if (pendingBank) setBank(pendingBank);
    pendingBank = null;
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

/** Unit length after taking the centre away: what learned sounds compare. */
function centred(x) {
  const d = tf.sub(x, centre);
  return tf.div(d, tf.maximum(tf.norm(d, 'euclidean', -1, true), 1e-6));
}

function setBank(msg) {
  // Tensors made before the backend is picked would live on the wrong one.
  if (!model) {
    pendingBank = msg;
    return;
  }
  const { ids = [], counts = [], bank: data = null } = msg;
  bank?.dispose();
  bank = null;
  segments = [];
  const rows = counts.reduce((a, b) => a + b, 0);
  if (!rows || !(data instanceof Float32Array) || data.length !== rows * DIMS) return;
  centre ??= tf.tensor1d(YAMNET_CENTRE);
  bank = tf.tidy(() => centred(tf.tensor2d(data, [rows, DIMS])));
  let start = 0;
  segments = ids.map((id, i) => {
    const seg = { id, start, end: start + counts[i] };
    start = seg.end;
    return seg;
  });
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
  const db = 10 * Math.log10(sum / WINDOW + 1e-20);
  if (Math.sqrt(sum / WINDOW) < SILENCE_RMS) {
    const scores = new Float32Array(CLASSES);
    self.postMessage({ type: 'scores', scores, embedding: null, learned: null, db, wallEnd, ms: 0, silent: true }, [scores.buffer]);
    busy = false;
    return;
  }

  try {
    const t0 = performance.now();
    const waveform = ring.slice();
    const segs = segments;
    const [meanScores, meanEmbedding, similar] = tf.tidy(() => {
      const out = model.execute(tf.tensor1d(waveform));
      const list = Array.isArray(out) ? out : [out];
      const s = list.find((t) => t.shape[t.shape.length - 1] === CLASSES).mean(0);
      const e = list.find((t) => t.shape[t.shape.length - 1] === DIMS).mean(0);
      // Cosine similarity to every stored example window, in one product.
      const sim = bank ? tf.matMul(bank, centred(e).reshape([DIMS, 1])).reshape([-1]) : null;
      return [s, e, sim];
    });
    const [scores, embedding, sims] = await Promise.all([meanScores.data(), meanEmbedding.data(), similar?.data()]);
    tf.dispose([meanScores, meanEmbedding, similar].filter(Boolean));
    // A sound is as close as its closest example: matching each window, rather
    // than an average of them, keeps every way the sound was recorded.
    let learned = null;
    if (sims) {
      learned = {};
      for (const { id, start, end } of segs) {
        let best = 0;
        for (let i = start; i < end; i++) if (sims[i] > best) best = sims[i];
        learned[id] = best;
      }
    }
    const ms = performance.now() - t0;
    // A slow backend widens the hop instead of queueing windows it cannot
    // finish: fewer, current answers beat a growing backlog of stale ones.
    hop = Math.min(MAX_HOP, Math.max(HOP, Math.round((ms * 1.5 * RATE) / 1000)));
    const s32 = Float32Array.from(scores);
    const e32 = Float32Array.from(embedding);
    self.postMessage({ type: 'scores', scores: s32, embedding: e32, learned, db, wallEnd, ms, silent: false }, [s32.buffer, e32.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  } finally {
    busy = false;
  }
}
