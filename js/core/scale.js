// Every frequency/dB ↔ pixel conversion in the app lives here. Drawing code
// must not re-derive log-scale math; if you need a new mapping, add it here.
//
// A "view" is `{ minFreq, maxFreq, freqScale }` plus a pixel span. All the
// pixel-space functions take an explicit `x0`/`w` pair so plots can reserve a
// left gutter for axis labels without every caller doing the offset by hand.

import { clamp } from './util.js';

/** Frequency (Hz) → pixel X within the plot rect `[x0, x0 + w)`. */
export function freqToX(freq, view, w, x0 = 0) {
  const { minFreq, maxFreq } = view;
  if (view.freqScale === 'log') {
    const lo = Math.log10(Math.max(minFreq, 1));
    const hi = Math.log10(Math.max(maxFreq, minFreq + 1));
    return x0 + ((Math.log10(Math.max(freq, 1e-6)) - lo) / (hi - lo)) * w;
  }
  return x0 + ((freq - minFreq) / (maxFreq - minFreq)) * w;
}

/** Pixel X → frequency (Hz). Unclamped so drags past the edge still track. */
export function xToFreq(x, view, w, x0 = 0) {
  const { minFreq, maxFreq } = view;
  const t = (x - x0) / w;
  if (view.freqScale === 'log') {
    const lo = Math.log10(Math.max(minFreq, 1));
    const hi = Math.log10(Math.max(maxFreq, minFreq + 1));
    return Math.pow(10, lo + t * (hi - lo));
  }
  return minFreq + t * (maxFreq - minFreq);
}

/** Discrete positions on the span sliders. Position 0 is 1 Hz, the last `topHz`. */
export const FREQ_SLIDER_STEPS = 1000;

/**
 * Curve of the span sliders: `freq ∝ position³` between 1 Hz and Nyquist.
 *
 * A log curve is wrong for this control even though the default plot is log.
 * Log makes each step a fixed *ratio*, so the top octave — where the "To" edge
 * actually lives — gets squeezed into the last 2% of travel while the first
 * third covers 1–20 Hz, which nothing uses. A cube law spreads the Hz far more
 * evenly: step size ranges about 0.6 Hz to 60 Hz instead of 0.2 Hz to 200 Hz,
 * and 10–24 kHz gets a quarter of the travel rather than a sliver. It stays
 * fine enough at the bottom to place a 20 Hz edge, which a straight linear
 * mapping (20 Hz landing on position 1 of 1000) could not do.
 *
 * The exponent is the whole knob here — raise it toward log-like behaviour,
 * lower it toward linear.
 */
const CURVE = 3;

/**
 * Frequency ↔ span-slider position. `topHz` is the current Nyquist, so the
 * travel tracks whatever device is capturing, and the curve is independent of
 * `freqScale` — a linear plot still wants a usable control.
 *
 * Neither direction rounds to whole Hz: the round trip has to be exact or the
 * thumb fights the drag. Fractional Hz is already normal here — drag-select
 * and zoom set the span from `xToFreq` floats too.
 */
export function freqToSlider(freq, topHz) {
  const span = Math.max(topHz, 10) - 1;
  const t = Math.pow(clamp(freq - 1, 0, span) / span, 1 / CURVE);
  return Math.round(t * FREQ_SLIDER_STEPS);
}

export function sliderToFreq(pos, topHz) {
  const span = Math.max(topHz, 10) - 1;
  const t = clamp(pos / FREQ_SLIDER_STEPS, 0, 1);
  return 1 + span * Math.pow(t, CURVE);
}

/** dB → pixel Y within `[y0, y0 + h)`, clamped to the plot rect. */
export function dbToY(db, minDb, maxDb, h, y0 = 0) {
  const t = clamp((db - minDb) / (maxDb - minDb), 0, 1);
  return y0 + h - t * h;
}

export function yToDb(y, minDb, maxDb, h, y0 = 0) {
  const t = clamp(1 - (y - y0) / h, 0, 1);
  return minDb + t * (maxDb - minDb);
}

export function freqToBin(freq, sampleRate, fftSize) {
  const bins = fftSize / 2;
  return clamp(Math.round((freq / (sampleRate / 2)) * bins), 0, bins - 1);
}

export function binToFreq(bin, sampleRate, fftSize) {
  return (bin * (sampleRate / 2)) / (fftSize / 2);
}

/**
 * Peak dB across a frequency band. Always samples at least one bin, so a band
 * narrower than the bin spacing still reads the bin it falls inside instead of
 * returning -Infinity.
 */
export function bandPeakDb(data, freqLo, freqHi, sampleRate, fftSize) {
  if (!data) return NaN;
  const bins = fftSize / 2;
  let binLo = freqToBin(Math.min(freqLo, freqHi), sampleRate, fftSize);
  let binHi = freqToBin(Math.max(freqLo, freqHi), sampleRate, fftSize);
  if (binHi < binLo) [binLo, binHi] = [binHi, binLo];
  binHi = clamp(binHi, binLo, bins - 1);
  let peak = -Infinity;
  let peakBin = binLo;
  for (let b = binLo; b <= binHi; b++) {
    if (data[b] > peak) {
      peak = data[b];
      peakBin = b;
    }
  }
  return Number.isFinite(peak) ? peak : NaN;
}

/** Same as `bandPeakDb` but also reports where the peak sat. */
export function bandPeak(data, freqLo, freqHi, sampleRate, fftSize) {
  if (!data) return { db: NaN, freq: NaN };
  const bins = fftSize / 2;
  const binLo = freqToBin(Math.min(freqLo, freqHi), sampleRate, fftSize);
  const binHi = clamp(freqToBin(Math.max(freqLo, freqHi), sampleRate, fftSize), binLo, bins - 1);
  let peak = -Infinity;
  let peakBin = binLo;
  for (let b = binLo; b <= binHi; b++) {
    if (data[b] > peak) {
      peak = data[b];
      peakBin = b;
    }
  }
  if (!Number.isFinite(peak)) return { db: NaN, freq: NaN };
  return { db: peak, freq: refinePeakFreq(data, peakBin, sampleRate, fftSize) };
}

/**
 * Sub-bin peak frequency by parabolic interpolation over the dB values of the
 * peak bin and its neighbours. At FFT 4096 / 48 kHz a bin is ~11.7 Hz wide, so
 * without this a 1 kHz tone reads as 996 Hz or 1008 Hz depending on alignment.
 */
export function refinePeakFreq(data, bin, sampleRate, fftSize) {
  const bins = fftSize / 2;
  if (bin <= 0 || bin >= bins - 1) return binToFreq(bin, sampleRate, fftSize);
  const a = data[bin - 1];
  const b = data[bin];
  const c = data[bin + 1];
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
    return binToFreq(bin, sampleRate, fftSize);
  }
  const denom = a - 2 * b + c;
  const delta = denom === 0 ? 0 : clamp((0.5 * (a - c)) / denom, -0.5, 0.5);
  return binToFreq(bin + delta, sampleRate, fftSize);
}

/** Loudest bin in the whole spectrum, restricted to the visible range. */
export function findDominantPeak(data, view, sampleRate, fftSize, floorDb = -110) {
  const p = bandPeak(data, view.minFreq, view.maxFreq, sampleRate, fftSize);
  if (!Number.isFinite(p.db) || p.db < floorDb) return null;
  return p;
}

/**
 * Column → bin index table for a plot `w` pixels wide.
 *
 * Two entries per column (`lo`, `hi` inclusive) so drawing can take the max
 * across every bin a column covers. Reading a single rounded bin per column —
 * what v1 did — silently drops narrow peaks at high frequencies on a log axis,
 * where one column can span dozens of bins.
 */
export function buildColumnBins(w, view, sampleRate, fftSize) {
  const bins = fftSize / 2;
  const lo = new Int32Array(w);
  const hi = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const fA = xToFreq(x - 0.5, view, w);
    const fB = xToFreq(x + 0.5, view, w);
    let bLo = freqToBin(Math.min(fA, fB), sampleRate, fftSize);
    let bHi = freqToBin(Math.max(fA, fB), sampleRate, fftSize);
    if (bHi < bLo) [bLo, bHi] = [bHi, bLo];
    lo[x] = clamp(bLo, 0, bins - 1);
    hi[x] = clamp(bHi, 0, bins - 1);
  }
  return { lo, hi, width: w, bins };
}

/**
 * dB for one column: max over the bins it covers when zoomed out, linear
 * interpolation between neighbouring bins when zoomed in far enough that a
 * column covers less than one bin (otherwise the trace looks like a staircase).
 */
export function columnDb(data, x, table, view, sampleRate, fftSize) {
  const lo = table.lo[x];
  const hi = table.hi[x];
  if (hi > lo) {
    let peak = -Infinity;
    for (let b = lo; b <= hi; b++) if (data[b] > peak) peak = data[b];
    return peak;
  }
  const freq = xToFreq(x, view, table.width);
  const exact = (freq / (sampleRate / 2)) * (fftSize / 2);
  const b0 = Math.floor(exact);
  const b1 = Math.min(b0 + 1, fftSize / 2 - 1);
  if (b0 < 0) return data[0];
  const f = exact - b0;
  return data[b0] * (1 - f) + data[b1] * f;
}

// ---------- Axis ticks ----------

function niceStep(rough) {
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow10;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * pow10;
}

/**
 * Frequency ticks as `{ freq, major }`. Log mode walks 1–9 within each decade
 * and promotes 1/2/5 to major, so a 500–600 Hz zoom still gets ticks — v1's
 * fixed "nice frequencies" list returned nothing for narrow spans.
 */
export function freqTicks(view, pixelWidth) {
  const { minFreq, maxFreq, freqScale } = view;
  const out = [];
  if (freqScale === 'log') {
    const decLo = Math.floor(Math.log10(Math.max(minFreq, 1)));
    const decHi = Math.ceil(Math.log10(Math.max(maxFreq, 2)));
    for (let d = decLo; d <= decHi; d++) {
      const base = Math.pow(10, d);
      for (let m = 1; m <= 9; m++) {
        const f = m * base;
        if (f < minFreq || f > maxFreq) continue;
        out.push({ freq: f, major: m === 1 || m === 2 || m === 5 });
      }
    }
    // Narrow spans can sit entirely between decade multiples (e.g. 520–560 Hz).
    if (out.filter((t) => t.major).length < 2) return linearTicks(minFreq, maxFreq, pixelWidth);
    return out;
  }
  return linearTicks(minFreq, maxFreq, pixelWidth);
}

function linearTicks(minFreq, maxFreq, pixelWidth) {
  const target = clamp(Math.round(pixelWidth / 110), 3, 12);
  const step = niceStep((maxFreq - minFreq) / target);
  const out = [];
  for (let f = Math.ceil(minFreq / step) * step; f <= maxFreq; f += step) {
    out.push({ freq: f, major: true });
  }
  return out;
}

export function dbTicks(minDb, maxDb, pixelHeight) {
  const target = clamp(Math.round(pixelHeight / 46), 3, 10);
  const step = niceStep((maxDb - minDb) / target);
  const out = [];
  for (let d = Math.ceil(minDb / step) * step; d <= maxDb; d += step) out.push(Math.round(d));
  return out;
}
