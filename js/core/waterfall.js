// Scrolling spectrogram.
//
// v1 drew straight onto the canvas and shifted pixels down, which meant the
// picture *was* the history: changing the colour map, the dB window, the
// frequency range or the window size threw the recording away. Here every row
// is kept as quantised dB in a ring buffer, so any of those changes just
// repaints the same history with new settings.
//
// Live frames still take the cheap path (blit down one row, write one row), and
// the ring is only walked in full when something invalidates the image.

import { buildLut } from './colormap.js';
import { clamp } from './util.js';
import { freqToX, xToFreq } from './scale.js';

// dB window the ring quantises into. 140 dB across 256 steps is 0.55 dB per
// step — finer than any colour map can show.
const STORE_MIN_DB = -150;
const STORE_MAX_DB = -10;

// Bins stored per row, normalised to Nyquist. 2048 gives ~11 Hz resolution at
// 48 kHz, and 1600 rows of it costs ~3.3 MB.
const STORED_BINS = 2048;
const CAPACITY = 1600;

export class Waterfall {
  constructor(canvas) {
    this.canvas = canvas;
    // Never read back from this context, so leave willReadFrequently off — it
    // would push the canvas to a software surface and make the scroll blit slow.
    this.ctx = canvas.getContext('2d', { alpha: false });

    this.rows = new Uint8Array(CAPACITY * STORED_BINS);
    this.rowNyquist = new Float64Array(CAPACITY);
    this.rowTime = new Float64Array(CAPACITY);
    this.head = -1; // ring index of the newest row
    this.count = 0;

    this.lut = null;
    this.lutKey = '';
    // Pixel column → the span of stored bins it covers, inclusive. A span, not
    // a single index: on a log axis one column near 10 kHz covers dozens of
    // bins, and picking just one of them makes the waterfall read 10–15 dB
    // quieter than the spectrum plot directly above it.
    this.colLo = null;
    this.colHi = null;
    this.colKey = '';
    this.rowImage = null;
    this.rowImage32 = null;

    this.rect = { x: 0, y: 0, w: 0, h: 0 };
    this.background = '#000';
    this.accum = 0;
    this.lastTime = 0;
    this.dirty = true;
  }

  /** Plot rect in canvas pixels, leaving room for the axis gutters. */
  setRect(x, y, w, h) {
    const r = this.rect;
    if (r.x === x && r.y === y && r.w === w && r.h === h) return;
    this.rect = { x, y, w: Math.max(0, w), h: Math.max(0, h) };
    this.colKey = '';
    this.rowImage = null;
    this.dirty = true;
  }

  /** Drop the recorded history (device change, explicit clear). */
  clear() {
    this.head = -1;
    this.count = 0;
    this.accum = 0;
    this.lastTime = 0;
    this.dirty = true;
  }

  /** Repaint from the ring on the next frame, keeping the history. */
  invalidate() {
    this.dirty = true;
  }

  get rowsPerSecond() {
    return this.rect.h > 0 && this._span > 0 ? this.rect.h / this._span : 0;
  }

  _ensureLut(settings) {
    const key = `${settings.colorMap}|${settings.minDb}|${settings.maxDb}`;
    if (key === this.lutKey) return;
    this.lut = buildLut(settings.colorMap, settings.minDb, settings.maxDb, STORE_MIN_DB, STORE_MAX_DB);
    this.lutKey = key;
    this.dirty = true;
  }

  _ensureColumns(settings, nyquist) {
    const { w } = this.rect;
    const key = `${w}|${settings.minFreq}|${settings.maxFreq}|${settings.freqScale}|${nyquist}`;
    if (key === this.colKey && this.colLo) return;
    const lo = new Int32Array(Math.max(0, w));
    const hi = new Int32Array(Math.max(0, w));
    for (let x = 0; x < w; x++) {
      const fA = xToFreq(x, settings, w);
      const fB = xToFreq(x + 1, settings, w);
      // -1 marks "above Nyquist": painted as background rather than as a fake
      // reading mirrored from the top bin.
      if (Math.min(fA, fB) > nyquist) {
        lo[x] = -1;
        hi[x] = -1;
        continue;
      }
      const iA = Math.round((Math.min(fA, fB) / nyquist) * (STORED_BINS - 1));
      const iB = Math.round((Math.min(Math.max(fA, fB), nyquist) / nyquist) * (STORED_BINS - 1));
      lo[x] = clamp(Math.min(iA, iB), 0, STORED_BINS - 1);
      hi[x] = clamp(Math.max(iA, iB), lo[x], STORED_BINS - 1);
    }
    this.colLo = lo;
    this.colHi = hi;
    this.colKey = key;
    this.dirty = true;
  }

  /** Loudest stored value across the bins a column covers. */
  _columnByte(rows, base, x) {
    const lo = this.colLo[x];
    if (lo < 0) return -1;
    const hi = this.colHi[x];
    let peak = rows[base + lo];
    for (let b = lo + 1; b <= hi; b++) {
      const v = rows[base + b];
      if (v > peak) peak = v;
    }
    return peak;
  }

  /**
   * Fold a live FFT frame into the stored resolution, keeping the maximum
   * across each group so a narrow peak survives the reduction.
   */
  _storeRow(data, sampleRate, fftSize, time) {
    const bins = fftSize / 2;
    const nyquist = sampleRate / 2;
    this.head = (this.head + 1) % CAPACITY;
    if (this.count < CAPACITY) this.count++;
    const base = this.head * STORED_BINS;
    const rows = this.rows;
    const scale = 255 / (STORE_MAX_DB - STORE_MIN_DB);

    if (bins >= STORED_BINS) {
      const per = bins / STORED_BINS;
      for (let i = 0; i < STORED_BINS; i++) {
        const b0 = Math.floor(i * per);
        const b1 = Math.min(bins - 1, Math.floor((i + 1) * per - 1e-9));
        let peak = -Infinity;
        for (let b = b0; b <= b1; b++) if (data[b] > peak) peak = data[b];
        rows[base + i] = Number.isFinite(peak) ? clamp((peak - STORE_MIN_DB) * scale, 0, 255) : 0;
      }
    } else {
      // Fewer bins than slots: replicate, since the extra slots carry no
      // information the FFT actually resolved.
      for (let i = 0; i < STORED_BINS; i++) {
        const b = clamp(Math.round((i / (STORED_BINS - 1)) * (bins - 1)), 0, bins - 1);
        const db = data[b];
        rows[base + i] = Number.isFinite(db) ? clamp((db - STORE_MIN_DB) * scale, 0, 255) : 0;
      }
    }
    this.rowNyquist[this.head] = nyquist;
    this.rowTime[this.head] = time;
  }

  /** Ring index of the row `age` steps behind the newest, or -1 if unrecorded. */
  _rowAt(age) {
    if (age >= this.count || age < 0) return -1;
    return (this.head - age + CAPACITY * 2) % CAPACITY;
  }

  /**
   * Advance the display if enough time has passed.
   *
   * The row interval is derived from the plot height in device pixels, and the
   * leftover time is carried in an accumulator — v1 reset its timer on every
   * row, so at high DPR (where a row is due more often than a frame arrives)
   * the waterfall silently scrolled slower than the chosen span.
   */
  push(now, data, settings, sampleRate, fftSize) {
    const { w, h } = this.rect;
    this._span = settings.waterfallSpan;
    if (w <= 0 || h <= 0 || !data) return 0;

    const interval = (settings.waterfallSpan * 1000) / h;
    if (this.lastTime === 0) {
      this.lastTime = now;
      return 0;
    }
    this.accum += now - this.lastTime;
    this.lastTime = now;
    if (this.accum < interval) return 0;

    let rows = Math.floor(this.accum / interval);
    this.accum -= rows * interval;
    // A backgrounded tab can hand us a multi-second gap; scrolling a whole
    // screen of duplicated rows just to catch up is worse than a small jump.
    rows = Math.min(rows, 12);

    for (let i = 0; i < rows; i++) this._storeRow(data, sampleRate, fftSize, now);
    return rows;
  }

  /** Paint. Cheap incremental scroll unless something invalidated the image. */
  draw(settings, nyquist, newRows) {
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0) return;
    this._ensureLut(settings);
    this._ensureColumns(settings, nyquist);

    if (this.dirty || newRows >= h) {
      this._repaintAll();
      this.dirty = false;
      return;
    }
    if (newRows <= 0) return;

    const shift = Math.min(newRows, h);
    this.ctx.drawImage(this.canvas, x, y, w, h - shift, x, y + shift, w, h - shift);
    for (let i = shift - 1; i >= 0; i--) {
      this._paintRow(this._rowAt(i), x, y + (shift - 1 - i));
    }
  }

  _ensureRowImage() {
    if (this.rowImage && this.rowImage.width === this.rect.w) return;
    this.rowImage = this.ctx.createImageData(this.rect.w, 1);
    this.rowImage32 = new Uint32Array(this.rowImage.data.buffer);
  }

  _paintRow(ringIndex, x, y) {
    const { w } = this.rect;
    if (w <= 0) return;
    this._ensureRowImage();
    const px = this.rowImage32;
    const lut = this.lut;
    if (ringIndex < 0) {
      px.fill(lut[0]);
    } else {
      const base = ringIndex * STORED_BINS;
      const rows = this.rows;
      for (let i = 0; i < w; i++) {
        const byte = this._columnByte(rows, base, i);
        px[i] = byte < 0 ? lut[0] : lut[byte];
      }
    }
    this.ctx.putImageData(this.rowImage, x, y);
  }

  /** Rebuild every visible row from the ring. Runs on any settings change. */
  _repaintAll() {
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0) return;
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const img = this.ctx.createImageData(w, h);
    const px = new Uint32Array(img.data.buffer);
    const lut = this.lut;
    const rows = this.rows;
    const empty = lut[0];

    for (let row = 0; row < h; row++) {
      const ring = this._rowAt(row);
      const out = row * w;
      if (ring < 0) {
        px.fill(empty, out, out + w);
        continue;
      }
      const base = ring * STORED_BINS;
      for (let i = 0; i < w; i++) {
        const byte = this._columnByte(rows, base, i);
        px[out + i] = byte < 0 ? empty : lut[byte];
      }
    }
    this.ctx.putImageData(img, x, y);
  }

  /**
   * dB under a point in the plot, for the hover readout — reads the recorded
   * history rather than the live frame, so hovering older rows tells the truth.
   */
  sampleAt(px, py, settings, nyquist) {
    const { x, y, w, h } = this.rect;
    const col = Math.round(px - x);
    const row = Math.round(py - y);
    if (col < 0 || col >= w || row < 0 || row >= h) return null;
    const ring = this._rowAt(row);
    if (ring < 0 || !this.colLo) return null;
    const byte = this._columnByte(this.rows, ring * STORED_BINS, col);
    if (byte < 0) return null;
    return {
      db: STORE_MIN_DB + (byte / 255) * (STORE_MAX_DB - STORE_MIN_DB),
      freq: xToFreq(col + 0.5, settings, w),
      ago: (row / h) * settings.waterfallSpan,
    };
  }

  /** Frequency → column X, matching what the renderer used. */
  freqToPlotX(freq, settings) {
    return freqToX(freq, settings, this.rect.w, this.rect.x);
  }
}

export const WATERFALL_STORE_RANGE = { min: STORE_MIN_DB, max: STORE_MAX_DB };
