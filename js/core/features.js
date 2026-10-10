// Cheap spectral descriptors over the analyser's dB frame — the Tier 0 of
// spec-recognition.md. DOM-free, and shaped like `bandPeakDb` in scale.js: a
// bin array plus a frequency band, with the bin math left to scale.js.

import { freqToBin, refinePeakFreq } from './scale.js';
import { clamp } from './util.js';

/** Inclusive bin range covering a band. Never empty. */
export function bandBins(freqLo, freqHi, sampleRate, fftSize) {
  const lo = freqToBin(Math.min(freqLo, freqHi), sampleRate, fftSize);
  const hi = Math.max(lo, freqToBin(Math.max(freqLo, freqHi), sampleRate, fftSize));
  return [lo, hi];
}

/**
 * Spectral flatness (Wiener entropy) of a band: geometric over arithmetic mean
 * of power. ~0 for a pure tone, ~1 for white noise. Computed on power, not dB,
 * or the ratio means nothing.
 */
export function bandFlatness(data, freqLo, freqHi, sampleRate, fftSize) {
  const [lo, hi] = bandBins(freqLo, freqHi, sampleRate, fftSize);
  let sumDb = 0;
  let sumPow = 0;
  let n = 0;
  for (let b = lo; b <= hi; b++) {
    const db = data[b];
    if (!Number.isFinite(db)) continue;
    sumDb += db;
    sumPow += 10 ** (db / 10);
    n++;
  }
  if (!n || sumPow <= 0) return NaN;
  return clamp(10 ** ((sumDb / n - 10 * Math.log10(sumPow / n)) / 10), 0, 1);
}

/**
 * The loudest bin in a band, and how far it stands above the band's mean dB.
 * A tone stands 20 dB or more proud of its surroundings; broadband noise, a
 * few dB. `freq` is refined to sub-bin precision.
 * @returns {{ freq:number, db:number, prominence:number, bin:number }}
 */
export function bandProminence(data, freqLo, freqHi, sampleRate, fftSize) {
  const [lo, hi] = bandBins(freqLo, freqHi, sampleRate, fftSize);
  let peak = -Infinity;
  let peakBin = lo;
  let sum = 0;
  let n = 0;
  for (let b = lo; b <= hi; b++) {
    const db = data[b];
    if (!Number.isFinite(db)) continue;
    sum += db;
    n++;
    if (db > peak) {
      peak = db;
      peakBin = b;
    }
  }
  if (!n || !Number.isFinite(peak)) return { freq: NaN, db: NaN, prominence: NaN, bin: -1 };
  return {
    freq: refinePeakFreq(data, peakBin, sampleRate, fftSize),
    db: peak,
    prominence: peak - sum / n,
    bin: peakBin,
  };
}

/** Peak dB within ±`tol` Hz of a frequency (at least the bin it falls in). */
export function levelNear(data, freq, tol, sampleRate, fftSize) {
  const [lo, hi] = bandBins(freq - tol, freq + tol, sampleRate, fftSize);
  let peak = -Infinity;
  for (let b = lo; b <= hi; b++) if (data[b] > peak) peak = data[b];
  return Number.isFinite(peak) ? peak : NaN;
}

/**
 * How strongly a series repeats within a lag range: the normalised
 * autocorrelation peak, ignoring NaN gaps. 1 is perfectly periodic at `lag`;
 * 0 is no repetition. This is the envelope-autocorrelation descriptor: feed it
 * a level or frequency track sampled at a fixed rate and it tells you how fast
 * that track repeats.
 *
 * Only lags after the autocorrelation first crosses zero count. A slow, smooth
 * track correlates highly with itself at every short lag, and without that
 * rule a gentle drift would read as a fast repetition.
 * @returns {{ r:number, lag:number }}
 */
export function periodicity(series, minLag, maxLag) {
  const n = series.length;
  let mean = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(series[i])) {
      mean += series[i];
      count++;
    }
  }
  if (count < 4) return { r: 0, lag: 0 };
  mean /= count;

  let best = { r: 0, lag: 0 };
  let crossed = false;
  for (let lag = 1; lag <= Math.min(maxLag, n - 2); lag++) {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i + lag < n; i++) {
      const a = series[i];
      const b = series[i + lag];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const x = a - mean;
      const y = b - mean;
      num += x * y;
      da += x * x;
      db += y * y;
    }
    const r = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    if (r <= 0) crossed = true;
    if (crossed && lag >= minLag && r > best.r) best = { r, lag };
  }
  return best;
}

/**
 * A value tracked on a fixed time grid.
 *
 * Animation frames arrive at whatever rate the display runs (30 Hz, 60 Hz,
 * 144 Hz, stalls), but a rule that asks "does this sweep repeat every 250 ms"
 * needs a constant hop. Each grid slot holds the latest value pushed into it.
 * Slots skipped because frames come slower than the grid repeat the previous
 * value; a longer silence (a stalled or background tab) leaves NaN, so a real
 * gap stays visible as a gap. A NaN pushed by the caller — "nothing found" —
 * is never held over.
 */
export class RateTrack {
  /**
   * @param {number} hz      grid rate
   * @param {number} seconds how much history to keep
   * @param {number} [holdSlots] longest frame gap, in slots, bridged by holding
   */
  constructor(hz, seconds, holdSlots = 3) {
    this.stepMs = 1000 / hz;
    this.holdSlots = holdSlots;
    this.size = Math.max(2, Math.round(hz * seconds));
    this.buf = new Float64Array(this.size).fill(NaN);
    this.slot = -1; // absolute index of the newest slot
    this.len = 0;
  }

  reset() {
    this.buf.fill(NaN);
    this.slot = -1;
    this.len = 0;
  }

  push(t, value) {
    const slot = Math.floor(t / this.stepMs);
    if (this.slot < 0) this.slot = slot - 1;
    if (slot < this.slot) return; // clock went backwards; ignore
    // Long gaps (background tab) clear the history rather than smearing it.
    const advance = Math.min(slot - this.slot, this.size);
    const held = advance <= this.holdSlots && this.len ? this.buf[this.slot % this.size] : NaN;
    for (let i = 1; i <= advance; i++) {
      this.buf[(this.slot + i) % this.size] = held;
    }
    if (advance) this.len = Math.min(this.size, this.len + advance);
    this.slot = slot;
    this.buf[slot % this.size] = value;
  }

  /** History oldest → newest, NaN where nothing was pushed. */
  values() {
    const out = new Array(this.len);
    for (let i = 0; i < this.len; i++) {
      out[i] = this.buf[(this.slot - this.len + 1 + i + this.size * 2) % this.size];
    }
    return out;
  }
}

/** Value at a fraction (0–1) of the sorted finite entries. */
export function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v[clamp(Math.round(q * (v.length - 1)), 0, v.length - 1)];
}

/** 0 at `a`, 1 at `b`, linear between — the scoring ramp the rules share. */
export function ramp(x, a, b) {
  if (!Number.isFinite(x)) return 0;
  return clamp((x - a) / (b - a), 0, 1);
}
