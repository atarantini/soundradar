// Siren, recognised by its shape rather than by a model.
//
// Every emergency siren is a loud tone in roughly 350–1900 Hz that never sits
// still, in one of three ways:
//   wail  — a slow, smooth sweep up and down (a few seconds per cycle)
//   yelp  — the same sweep, fast enough to repeat 2–8 times a second
//   hi-lo — two steady pitches alternating (the European "nee-naw")
// So the rule tracks the dominant peak on a fixed time grid and asks three
// questions of the track. A steady tone (a beeper, a whistle) has no
// excursion; speech and birdsong have gaps and jumps; both score low.

import {
  bandProminence, levelNear, periodicity, quantile, ramp, RateTrack,
} from '../../features.js';

const BAND = [350, 1900];
const TRACK_HZ = 40;
const HISTORY_S = 10; // three beats of a slow two-tone horn
const RECENT_S = 4;
const MIN_PROMINENCE_DB = 14;
const FLOOR_DB = -95;
const SCORE_EVERY_MS = 100;

export default {
  id: 'siren-sweep',
  label: 'Siren (pattern)',
  source: 'spectrum',
  description: 'Wail, yelp or two-tone: a loud tone between 350 Hz and 1.9 kHz that keeps sweeping or alternating.',
  threshold: 0.6,
  minMs: 1000,
  releaseMs: 1500,
  refractoryMs: 5000,
  band: BAND,
  create: () => new SirenRule(),
};

class SirenRule {
  constructor() {
    this.track = new RateTrack(TRACK_HZ, HISTORY_S);
    this.reset();
  }

  reset() {
    this.track.reset();
    this.last = { score: 0 };
    this.scoredAt = -Infinity;
  }

  update({ data, sampleRate, fftSize, t }) {
    const p = bandProminence(data, BAND[0], BAND[1], sampleRate, fftSize);
    let freq = NaN;
    if (p.prominence >= MIN_PROMINENCE_DB && p.db >= FLOOR_DB) {
      freq = p.freq;
      // Siren horns are rich in harmonics, and the 2nd can outshout the
      // fundamental for part of a sweep. Fold back down so the track does not
      // leap an octave mid-sweep.
      const half = freq / 2;
      const tol = Math.max(half * 0.03, (1.5 * sampleRate) / fftSize);
      if (half >= BAND[0] && levelNear(data, half, tol, sampleRate, fftSize) >= p.db - 10) freq = half;
    }
    this.track.push(t, freq);

    if (t - this.scoredAt < SCORE_EVERY_MS) return { ...this.last, freq };
    this.scoredAt = t;
    this.last = this._score();
    return { ...this.last, freq };
  }

  _score() {
    const all = this.track.values();
    if (all.length < TRACK_HZ * 2) return { score: 0 };
    const recent = all.slice(-TRACK_HZ * RECENT_S);
    const finite = recent.filter(Number.isFinite);
    const coverage = finite.length / recent.length;
    if (coverage < 0.5) return { score: 0 };

    const lo = quantile(finite, 0.1);
    const hi = quantile(finite, 0.9);
    const excursion = hi - lo;
    const centre = (lo + hi) / 2;

    // Jumps between consecutive slots: a sweep glides, speech and tunes leap.
    let steps = 0;
    let jumps = 0;
    const jumpLimit = Math.max(60, centre * 0.12);
    for (let i = 1; i < recent.length; i++) {
      const a = recent[i - 1];
      const b = recent[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      steps++;
      if (Math.abs(b - a) > jumpLimit) jumps++;
    }
    if (steps < 10) return { score: 0 };
    const jumpFrac = jumps / steps;

    // How much of the time the pitch is gliding: a quarter-second span that
    // moved by more than a few hertz without a jump inside it. A wail glides
    // nearly all the time; a tune or a voice holds a note, then leaps. Spans,
    // not single slots, because at low frame rates half the slots repeat the
    // one before.
    const span = Math.round(TRACK_HZ * 0.25);
    let spans = 0;
    let gliding = 0;
    for (let i = span; i < recent.length; i++) {
      let ok = true;
      for (let j = i - span + 1; j <= i && ok; j++) {
        ok = Number.isFinite(recent[j]) && Number.isFinite(recent[j - 1]) && Math.abs(recent[j] - recent[j - 1]) <= jumpLimit;
      }
      if (!ok) continue;
      spans++;
      if (Math.abs(recent[i] - recent[i - span]) >= 4) gliding++;
    }
    const glide = spans ? gliding / spans : 0;

    const wail = ramp(excursion, 150, 300) * ramp(1 - jumpFrac, 0.85, 0.97) * ramp(glide, 0.5, 0.75);

    const fast = periodicity(all, Math.round(TRACK_HZ * 0.12), Math.round(TRACK_HZ * 0.6));
    const yelp = ramp(fast.r, 0.3, 0.6) * ramp(excursion, 150, 300);

    const hilo = twoToneScore(all);

    const best = Math.max(wail, yelp, hilo);
    const detail = best === hilo ? 'hi-lo' : best === yelp ? 'yelp' : 'wail';
    return { score: ramp(coverage, 0.65, 0.92) * best, detail };
  }
}

/**
 * Two steady pitches a fourth-ish apart, alternating on a steady beat.
 *
 * Real recordings are messier than the textbook: a second vehicle, a horn
 * harmonic, a passing car all put stray peaks on the track. So rather than
 * splitting every value into "high" and "low", find the two most-populated
 * pitch clusters that make a plausible two-tone pair, require them to own most
 * of the track, and judge the beat on those two alone — strays neither count
 * nor break a run. The beat is what separates a two-tone horn from a voice or
 * a tune, which also hop between a few pitches, but never in time.
 */
function twoToneScore(track) {
  const values = track.filter(Number.isFinite);
  const n = values.length;
  if (n < TRACK_HZ * 2) return 0;

  const clusters = pitchClusters(values, 0.05).slice(0, 4);
  let pair = null;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const lo = Math.min(clusters[i].centre, clusters[j].centre);
      const hi = Math.max(clusters[i].centre, clusters[j].centre);
      const ratio = hi / lo;
      // An octave is a harmonic, not a second tone.
      if (ratio < 1.08 || ratio > 1.7) continue;
      const share = (clusters[i].count + clusters[j].count) / n;
      if (!pair || share > pair.share) pair = { lo, hi, share };
    }
  }
  if (!pair) return 0;

  // Dwell on each tone, in track slots, from switch to switch. Horns are
  // often asymmetric — a long high, a short low — so the beat is judged per
  // tone: each tone's dwell has to repeat, not both to match.
  const near = (v, c) => Math.abs(v / c - 1) < 0.03;
  const runs = [[], []];
  let side = null;
  let since = 0;
  let switches = 0;
  for (let i = 0; i < track.length; i++) {
    const v = track[i];
    if (!Number.isFinite(v)) continue;
    const s = near(v, pair.lo) ? 0 : near(v, pair.hi) ? 1 : null;
    if (s === null || s === side) continue;
    // The first run is cut off by the window; only whole ones count.
    if (side !== null && switches++ > 0) runs[side].push(i - since);
    side = s;
    since = i;
  }
  // Regularity needs something to compare: two whole dwells on each tone.
  if (runs[0].length < 2 || runs[1].length < 2) return 0;
  const cv = Math.max(...runs.map(spreadOf));
  const all = [...runs[0], ...runs[1]];
  const dwell = all.reduce((a, b) => a + b, 0) / all.length / TRACK_HZ;

  return (
    ramp(pair.share, 0.55, 0.75) *
    (1 - ramp(cv, 0.3, 0.6)) *
    ramp(dwell, 0.2, 0.3) *
    (1 - ramp(dwell, 2, 3))
  );
}

/** Coefficient of variation of a list; 0 for fewer than two entries. */
function spreadOf(list) {
  if (list.length < 2) return 0;
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  return Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length) / mean;
}

/**
 * Group pitches that sit within `width` (a fraction) of each other, most
 * populated group first. Each group reports its median as the centre.
 */
function pitchClusters(values, width) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] <= sorted[start] * (1 + width)) continue;
    out.push({ centre: sorted[(start + i - 1) >> 1], count: i - start });
    start = i;
  }
  return out.sort((a, b) => b.count - a.count);
}
