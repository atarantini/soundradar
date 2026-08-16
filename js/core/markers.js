// Marker model. Deliberately free of DOM: v1 had the store building its own
// list markup, which made the panel impossible to restyle without editing the
// data layer. Each interface renders markers however it likes and subscribes
// here for changes.
//
// Markers are stored as centre frequency + bandwidth in Hz, so they stay put
// across FFT size, zoom and window changes.

import { bandPeak } from './scale.js';
import { clamp } from './util.js';

export const DEFAULT_BANDWIDTH_HZ = 50;
const HISTORY_LEN = 300;

export class MarkerStore {
  /**
   * @param {object} o
   * @param {string} o.storageKey  localStorage key
   * @param {string[]} o.palette   colours assigned round-robin to new markers
   */
  constructor({ storageKey, palette }) {
    this.storageKey = storageKey;
    this.palette = palette;
    this.markers = [];
    this.levels = new Map(); // id → { db, peak }
    this.history = new Map(); // id → { buf: Float32Array, len, pos }
    this.listeners = new Set();
    this.nextId = 1;
    this.load();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _changed() {
    this.save();
    for (const fn of this.listeners) fn(this.markers);
  }

  load() {
    let parsed = [];
    try {
      const raw = localStorage.getItem(this.storageKey);
      parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) parsed = [];
    } catch {
      parsed = [];
    }
    this.markers = parsed
      .filter((m) => m && Number.isFinite(Number(m.freq)))
      .map((m, i) => ({
        id: Number.isFinite(m.id) ? Number(m.id) : i + 1,
        freq: Number(m.freq),
        // v1 labelled this field "±" but treated it as the full span. It is a
        // full bandwidth here, and the interface says "BW" to match.
        bw: Number.isFinite(Number(m.bw)) && m.bw > 0 ? Number(m.bw) : Number(m.width) || DEFAULT_BANDWIDTH_HZ,
        name: typeof m.name === 'string' && m.name ? m.name : `M${i + 1}`,
        color: typeof m.color === 'string' ? m.color : this.palette[i % this.palette.length],
        chart: Boolean(m.chart),
        muted: Boolean(m.muted),
      }));
    this.nextId = this.markers.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    for (const m of this.markers) this._resetHistory(m.id);
  }

  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.markers));
    } catch {
      // Private mode or a full quota: markers still work for this session.
    }
  }

  _resetHistory(id) {
    this.history.set(id, { buf: new Float32Array(HISTORY_LEN).fill(NaN), len: 0, pos: 0 });
  }

  add(freq, opts = {}) {
    const m = {
      id: this.nextId++,
      freq: Number(freq.toFixed(freq < 1000 ? 1 : 0)),
      bw: opts.bw ?? DEFAULT_BANDWIDTH_HZ,
      name: opts.name ?? `M${this.markers.length + 1}`,
      color: opts.color ?? this.palette[this.markers.length % this.palette.length],
      chart: false,
      muted: false,
    };
    this.markers.unshift(m); // newest first, where the eye lands
    this._resetHistory(m.id);
    this._changed();
    return m;
  }

  /** Add several at once (harmonic stacks) with a single notification. */
  addMany(entries) {
    const added = entries.map((e, i) => {
      const m = {
        id: this.nextId++,
        freq: Number(e.freq.toFixed(e.freq < 1000 ? 1 : 0)),
        bw: e.bw ?? DEFAULT_BANDWIDTH_HZ,
        name: e.name ?? `M${this.markers.length + i + 1}`,
        color: e.color ?? this.palette[(this.markers.length + i) % this.palette.length],
        chart: false,
        muted: false,
      };
      this._resetHistory(m.id);
      return m;
    });
    this.markers.unshift(...added);
    this._changed();
    return added;
  }

  get(id) {
    return this.markers.find((m) => m.id === id) || null;
  }

  remove(id) {
    const before = this.markers.length;
    this.markers = this.markers.filter((m) => m.id !== id);
    if (this.markers.length === before) return;
    this.levels.delete(id);
    this.history.delete(id);
    this._changed();
  }

  update(id, patch) {
    const m = this.get(id);
    if (!m) return;
    if (patch.freq !== undefined) patch.freq = Math.max(1, Number(patch.freq) || m.freq);
    if (patch.bw !== undefined) patch.bw = Math.max(1, Number(patch.bw) || m.bw);
    Object.assign(m, patch);
    this._changed();
  }

  move(id, delta) {
    const i = this.markers.findIndex((m) => m.id === id);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= this.markers.length) return;
    [this.markers[i], this.markers[j]] = [this.markers[j], this.markers[i]];
    this._changed();
  }

  clear() {
    if (!this.markers.length) return;
    this.markers = [];
    this.levels.clear();
    this.history.clear();
    this._changed();
  }

  /** Nearest marker to a frequency, within `tolerance` Hz. For hit-testing. */
  nearest(freq, tolerance) {
    let best = null;
    let bestD = Infinity;
    for (const m of this.markers) {
      const d = Math.abs(m.freq - freq);
      if (d < bestD && d <= tolerance) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  /** Peak level in every marker band. Called once per frame. */
  updateLevels(data, sampleRate, fftSize, live) {
    for (const m of this.markers) {
      const half = m.bw / 2;
      const res = live && data ? bandPeak(data, m.freq - half, m.freq + half, sampleRate, fftSize) : { db: NaN, freq: NaN };
      const prev = this.levels.get(m.id);
      const peak = Number.isFinite(res.db) ? Math.max(res.db, prev?.peak ?? -Infinity) : prev?.peak ?? -Infinity;
      this.levels.set(m.id, { db: res.db, peakFreq: res.freq, peak });
      const h = this.history.get(m.id);
      if (h) {
        h.buf[h.pos] = res.db;
        h.pos = (h.pos + 1) % HISTORY_LEN;
        h.len = Math.min(HISTORY_LEN, h.len + 1);
      }
    }
  }

  resetPeaks() {
    for (const [id, lvl] of this.levels) this.levels.set(id, { ...lvl, peak: -Infinity });
  }

  level(id) {
    return this.levels.get(id) || { db: NaN, peak: -Infinity, peakFreq: NaN };
  }

  /** History oldest → newest, so charts can plot it left to right directly. */
  historyOf(id) {
    const h = this.history.get(id);
    if (!h) return [];
    const out = new Array(h.len);
    for (let i = 0; i < h.len; i++) {
      out[i] = h.buf[(h.pos - h.len + i + HISTORY_LEN * 2) % HISTORY_LEN];
    }
    return out;
  }

  toCsv() {
    const rows = [['name', 'frequency_hz', 'bandwidth_hz', 'level_db', 'peak_db']];
    for (const m of this.markers) {
      const l = this.level(m.id);
      rows.push([
        m.name,
        m.freq,
        m.bw,
        Number.isFinite(l.db) ? l.db.toFixed(2) : '',
        Number.isFinite(l.peak) ? l.peak.toFixed(2) : '',
      ]);
    }
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  toJson() {
    return JSON.stringify(
      this.markers.map((m) => ({ name: m.name, freq: m.freq, bw: m.bw, color: m.color })),
      null,
      2
    );
  }

  /** Merge an exported list back in. Returns how many were added. */
  importJson(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (!Array.isArray(parsed)) throw new Error('That file does not contain a marker list.');
    const entries = parsed
      .filter((m) => m && Number.isFinite(Number(m.freq)))
      .map((m) => ({ freq: Number(m.freq), bw: Number(m.bw) || DEFAULT_BANDWIDTH_HZ, name: m.name, color: m.color }));
    if (!entries.length) throw new Error('That file does not contain a marker list.');
    this.addMany(entries);
    return entries.length;
  }
}

/** Normalised 0–1 position of a level inside the display window. */
export function levelFraction(db, minDb, maxDb) {
  if (!Number.isFinite(db)) return 0;
  return clamp((db - minDb) / (maxDb - minDb), 0, 1);
}
