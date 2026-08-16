// Gradient tables plus a lookup-table builder. The waterfall colours a whole
// screen of pixels per change, so colour work is done once into a 256-entry LUT
// and every pixel afterwards is a single array index.

import { clamp } from './util.js';

export const STOPS = {
  // Blue → green → yellow → red. What most SDR and RF analysers ship with.
  classic: [
    [0.0, [6, 6, 28]],
    [0.15, [0, 0, 150]],
    [0.35, [0, 160, 195]],
    [0.55, [0, 195, 70]],
    [0.75, [232, 220, 0]],
    [1.0, [228, 22, 0]],
  ],
  // Perceptually uniform: equal dB steps look like equal colour steps, so a
  // ramp in the display really is a ramp in the signal.
  viridis: [
    [0.0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1.0, [253, 231, 37]],
  ],
  inferno: [
    [0.0, [0, 0, 4]],
    [0.25, [87, 16, 110]],
    [0.5, [188, 55, 84]],
    [0.75, [249, 142, 9]],
    [1.0, [252, 255, 164]],
  ],
  magma: [
    [0.0, [0, 0, 4]],
    [0.25, [81, 18, 124]],
    [0.5, [183, 55, 121]],
    [0.75, [252, 137, 97]],
    [1.0, [252, 253, 191]],
  ],
  // Amber CRT phosphor, for the bench-instrument look. The bottom third stays
  // near black on purpose: a noise floor should read as an unlit screen, not as
  // a lit one, or every plot looks like it is picking something up.
  amber: [
    [0.0, [6, 5, 4]],
    [0.3, [26, 11, 2]],
    [0.52, [112, 43, 0]],
    [0.74, [225, 122, 8]],
    [0.9, [255, 196, 105]],
    [1.0, [255, 250, 228]],
  ],
  // Cool counterpart — reads well in daylight on a light page.
  ice: [
    [0.0, [4, 8, 20]],
    [0.25, [16, 52, 110]],
    [0.5, [22, 116, 178]],
    [0.75, [104, 194, 214]],
    [1.0, [238, 252, 255]],
  ],
  gray: [
    [0.0, [0, 0, 0]],
    [1.0, [255, 255, 255]],
  ],
  // Reserved for meter fills and level text: readable white at low levels,
  // warming to red as things get loud. Not offered as a waterfall map.
  intensity: [
    [0.0, [232, 238, 245]],
    [0.45, [232, 238, 245]],
    [0.65, [255, 214, 102]],
    [0.85, [255, 149, 51]],
    [1.0, [244, 63, 63]],
  ],
};

/** Maps a user can pick for the waterfall, in menu order. */
export const WATERFALL_MAPS = ['classic', 'viridis', 'inferno', 'magma', 'amber', 'ice', 'gray'];

export const MAP_LABELS = {
  classic: 'Classic',
  viridis: 'Viridis',
  inferno: 'Inferno',
  magma: 'Magma',
  amber: 'Amber CRT',
  ice: 'Ice',
  gray: 'Grayscale',
};

export function colorFor(mapName, t) {
  const stops = STOPS[mapName] || STOPS.classic;
  const tc = clamp(t, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (tc >= t0 && tc <= t1) {
      const f = t1 === t0 ? 0 : (tc - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

export function colorForCss(mapName, t) {
  const [r, g, b] = colorFor(mapName, t);
  return `rgb(${r},${g},${b})`;
}

/** `linear-gradient(...)` for the map, for legends and swatches. */
export function gradientCss(mapName, angle = '90deg') {
  const stops = STOPS[mapName] || STOPS.classic;
  const parts = stops.map(([t, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${(t * 100).toFixed(0)}%`);
  return `linear-gradient(${angle}, ${parts.join(', ')})`;
}

// ImageData is byte-order little-endian on every platform this app targets, but
// probe rather than assume — a wrong guess swaps red and blue everywhere.
const LITTLE_ENDIAN = (() => {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x0a0b0c0d;
  return new Uint8Array(buf)[0] === 0x0d;
})();

function pack(r, g, b) {
  return LITTLE_ENDIAN
    ? (255 << 24) | (b << 16) | (g << 8) | r
    : (r << 24) | (g << 16) | (b << 8) | 255;
}

/**
 * 256 packed RGBA values for one colour map over one dB window.
 *
 * The waterfall stores each cell as a byte covering `storeMinDb…storeMaxDb`, so
 * this table folds "byte → dB → normalised → colour" into one step. Rebuilt only
 * when the map or the dB window changes.
 */
export function buildLut(mapName, minDb, maxDb, storeMinDb, storeMaxDb) {
  const lut = new Uint32Array(256);
  const span = maxDb - minDb || 1;
  for (let i = 0; i < 256; i++) {
    const db = storeMinDb + (i / 255) * (storeMaxDb - storeMinDb);
    const [r, g, b] = colorFor(mapName, (db - minDb) / span);
    lut[i] = pack(r, g, b);
  }
  return lut;
}
