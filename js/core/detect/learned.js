// Sounds the user taught: detectors built from data at runtime.
//
// Nothing is trained. A learned sound is the YAMNet embeddings of the windows
// it was recorded in — its examples — and it is detected by how close a live
// window comes to the closest of them (cosine similarity, after taking away the
// average sound in yamnet-centre.js). The worker does that matching, for every
// learned sound at once; the detector here only reads its answer, so from the
// engine's side a learned sound is one more catalog entry.
//
// Matching every example window, not an average of them, keeps every mode of
// the sound (a bark and a whine) and every condition it was recorded in. It
// finds *that* sound again — the heat pump, the gate — far better than it
// generalises to everything of its kind.

export const LEARNED_SOURCE = 'learned';
export const LEARNED_GROUP = 'My sounds';
export const EMBEDDING_DIMS = 1024;

// A window is 0.975 s, scored every 0.25 s — or further apart on a device that
// cannot keep up, so an example's length is measured as the audio its windows
// actually covered, not counted in windows. 160 windows is ~40 s at full rate.
export const MAX_WINDOWS = 160;
export const MAX_SOUNDS = 24;
export const WINDOW_S = 0.975;
export const WINDOW_HOP_S = 0.25;
// The least an example can be: 1.5 s of sound, from at least 3 windows.
export const MIN_SECONDS = 1.5;
export const MIN_WINDOWS = 3;

/** Seconds of sound an example covers: its own, or (older data) the nominal rate. */
export const secondsOf = (example) => (Number.isFinite(example.s) ? example.s : example.vecs.length * WINDOW_HOP_S);

/**
 * @param {{ id: string, label: string, examples: { vecs: string[] }[] }} sound
 */
export function learnedDetector(sound) {
  const seconds = sound.examples.reduce((t, e) => t + secondsOf(e), 0);
  const n = sound.examples.length;
  return Object.freeze({
    id: sound.id,
    label: sound.label,
    group: LEARNED_GROUP,
    source: LEARNED_SOURCE,
    description: `Taught from ${n} example${n === 1 ? '' : 's'}, ${formatSeconds(seconds)} of sound.`,
    // Thresholds come from the sliders (thresholds.js); this is what the
    // spike suggested for a learned sound, kept for the record like the
    // calibrated values of the built-in categories.
    threshold: 0.8,
    minMs: 0,
    releaseMs: 1000,
    refractoryMs: 3000,
    /** @param {{ learned: Record<string, number> | null }} frame */
    score(frame) {
      const s = frame.learned?.[sound.id];
      return { score: Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0 };
    },
  });
}

export function formatSeconds(s) {
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

// ---- storage form of one embedding: 8 bits per value against its own maximum.
//
// The embedding is post-ReLU, so every value is ≥ 0. A float32 scale followed
// by 1024 bytes, base64: ~1.4 kB of text instead of ~7 kB of JSON numbers. The
// round trip moves a centred cosine similarity by under 0.002.

/** @param {ArrayLike<number>} v  one 1024-d embedding */
export function encodeVec(v) {
  let max = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) if (v[i] > max) max = v[i];
  const bytes = new Uint8Array(4 + EMBEDDING_DIMS);
  new DataView(bytes.buffer).setFloat32(0, max, true);
  const k = max > 0 ? 255 / max : 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) bytes[4 + i] = Math.round(Math.max(0, v[i]) * k);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** @returns {Float32Array|null} null when the string is not an encoded embedding */
export function decodeVec(text) {
  if (typeof text !== 'string') return null;
  let bin;
  try {
    bin = atob(text);
  } catch {
    return null;
  }
  if (bin.length !== 4 + EMBEDDING_DIMS) return null;
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const max = new DataView(bytes.buffer).getFloat32(0, true);
  if (!Number.isFinite(max) || max < 0) return null;
  const v = new Float32Array(EMBEDDING_DIMS);
  const k = max / 255;
  for (let i = 0; i < EMBEDDING_DIMS; i++) v[i] = bytes[4 + i] * k;
  return v;
}

/**
 * Every learned sound's example windows as one matrix, for the worker.
 * @param {object[]} sounds  from SoundStore
 * @param {(sound: object) => Float32Array[]} vectorsOf  decoded windows of a sound
 * @returns {{ ids: string[], counts: number[], bank: Float32Array|null }}
 */
export function bankOf(sounds, vectorsOf) {
  const ids = [];
  const counts = [];
  const all = [];
  for (const sound of sounds) {
    const vecs = vectorsOf(sound);
    if (!vecs.length) continue;
    ids.push(sound.id);
    counts.push(vecs.length);
    all.push(...vecs);
  }
  if (!all.length) return { ids: [], counts: [], bank: null };
  const bank = new Float32Array(all.length * EMBEDDING_DIMS);
  all.forEach((v, i) => bank.set(v, i * EMBEDDING_DIMS));
  return { ids, counts, bank };
}
