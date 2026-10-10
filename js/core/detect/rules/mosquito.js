// Mosquito whine, recognised from the wingbeat tone.
//
// A flying mosquito is a sustained tone between roughly 300 and 1000 Hz
// (females lower, males higher) with strong harmonics and nothing in between
// them, and its pitch is never perfectly steady: wingbeat rate and Doppler
// keep it wandering by a few hertz. That last point is what separates it from
// the things that look most like it on a spectrum analyzer — a fan, a
// transformer, a test tone — which hold their pitch to a fraction of a hertz.
// Anything with a lower fundamental — mains buzz, a voice, an engine — is
// ruled out by the gaps: its harmonic comb is dense, so the spectrum between
// f0 and 2·f0, and just below f0, is not quiet.

import {
  bandProminence, levelNear, quantile, ramp, RateTrack,
} from '../../features.js';
import { bandPeakDb } from '../../scale.js';

const BAND = [300, 1000];
const TRACK_HZ = 20;
const HISTORY_S = 1.5;
const MIN_PROMINENCE_DB = 12;
const HARMONIC_DB = 8; // 2nd harmonic above the band's mean level
const GAP_DB = 10; // f0 above anything between its harmonics, or just below it
const FLOOR_DB = -100;

export default {
  id: 'mosquito-whine',
  label: 'Mosquito whine',
  source: 'spectrum',
  description: 'A wandering wingbeat tone between 300 Hz and 1 kHz with a strong 2nd harmonic.',
  threshold: 0.6,
  minMs: 800,
  releaseMs: 1000,
  refractoryMs: 5000,
  band: BAND,
  create: () => new MosquitoRule(),
};

class MosquitoRule {
  constructor() {
    this.track = new RateTrack(TRACK_HZ, HISTORY_S);
  }

  reset() {
    this.track.reset();
  }

  update({ data, sampleRate, fftSize, t }) {
    const binHz = sampleRate / fftSize;
    const tolOf = (f) => Math.max(f * 0.03, 1.5 * binHz);
    const p = bandProminence(data, BAND[0], BAND[1], sampleRate, fftSize);
    let f0 = NaN;

    if (p.prominence >= MIN_PROMINENCE_DB && p.db >= FLOOR_DB) {
      let f = p.freq;
      let fDb = p.db;
      // The 2nd harmonic is often as loud as the fundamental; if the peak we
      // found has a strong partner an octave down, that partner is f0.
      const halfDb = levelNear(data, f / 2, tolOf(f / 2), sampleRate, fftSize);
      if (f / 2 >= BAND[0] && halfDb >= fDb - 10) {
        f /= 2;
        fDb = halfDb;
      }
      const meanDb = p.db - p.prominence;
      const h2 = levelNear(data, 2 * f, tolOf(2 * f), sampleRate, fftSize);
      // Stay a window main lobe (±3 bins, Blackman) clear of f0 and 2·f0, or
      // at coarse FFT sizes their own leakage fills the gaps being measured.
      const lobe = 3 * binHz;
      const between = bandPeakDb(data, f * 1.15 + lobe, Math.max(f * 1.15 + lobe, f * 1.85 - lobe), sampleRate, fftSize);
      const below = bandPeakDb(data, f * 0.55, Math.max(f * 0.55, f * 0.85 - lobe), sampleRate, fftSize);
      if (h2 >= meanDb + HARMONIC_DB && fDb - Math.max(between, below) >= GAP_DB) f0 = f;
    }
    this.track.push(t, f0);

    const values = this.track.values();
    if (values.length < TRACK_HZ) return { score: 0, freq: f0 };
    const finite = values.filter(Number.isFinite);
    const coverage = finite.length / values.length;
    if (finite.length < 4) return { score: 0, freq: f0 };

    const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
    const sd = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length);
    const wobble = ramp(sd, 0.5, 2) * (1 - ramp(sd, 25, 45));
    // A wingbeat wanders; it never leaps. A pitch that jumps — even across a
    // short gap — is two sounds (a ding-dong, a tune), whatever its spread says.
    let jumps = 0;
    for (let i = 1; i < finite.length; i++) {
      if (Math.abs(finite[i] - finite[i - 1]) > Math.max(25, finite[i - 1] * 0.05)) jumps++;
    }
    return {
      score: ramp(coverage, 0.7, 0.9) * wobble * (jumps === 0 ? 1 : jumps === 1 ? 0.5 : 0),
      freq: Number.isFinite(f0) ? f0 : quantile(finite, 0.5),
    };
  }
}
