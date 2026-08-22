// Display settings: defaults, validation, persistence.
//
// v1 kept settings in a plain object with no validation and never saved them, so
// a min above max quietly broke every plot and a reload threw the setup away.

import { clamp } from './util.js';
import { FFT_SIZES } from './audio.js';
import { WATERFALL_MAPS } from './colormap.js';

export const BASE_DEFAULTS = {
  minFreq: 20,
  maxFreq: 20000,
  freqScale: 'log',
  minDb: -100,
  maxDb: -20,
  fftSize: 4096,
  smoothing: 0.7,
  waterfallOn: true,
  waterfallSpan: 10,
  colorMap: 'classic',
  peakHold: true,
  peakDecay: 12, // dB per second
  persistence: 0,
  spectrumFill: true,
  showHearingBand: true,
  markerBw: 50,
  alarmVolume: 0.25,
  alarmMuted: false,
};

export const WATERFALL_SPANS = [5, 10, 20, 30, 60, 120];
export const MIN_SPAN_HZ = 4;
export const ABSOLUTE_MAX_HZ = 96000;

/**
 * Force a settings object into a usable state.
 * @param {number} nyquist upper frequency limit of the current input.
 */
export function normalize(s, nyquist = 24000) {
  const top = Math.min(ABSOLUTE_MAX_HZ, Math.max(1000, nyquist));

  s.freqScale = s.freqScale === 'linear' ? 'linear' : 'log';
  s.minFreq = clamp(Number(s.minFreq) || BASE_DEFAULTS.minFreq, 1, top - MIN_SPAN_HZ);
  s.maxFreq = clamp(Number(s.maxFreq) || BASE_DEFAULTS.maxFreq, s.minFreq + MIN_SPAN_HZ, top);

  s.maxDb = clamp(Number(s.maxDb) ?? BASE_DEFAULTS.maxDb, -140, 0);
  s.minDb = clamp(Number(s.minDb) ?? BASE_DEFAULTS.minDb, -150, s.maxDb - 5);

  s.fftSize = FFT_SIZES.includes(Number(s.fftSize)) ? Number(s.fftSize) : BASE_DEFAULTS.fftSize;
  s.smoothing = clamp(Number(s.smoothing) ?? BASE_DEFAULTS.smoothing, 0, 0.95);
  s.waterfallSpan = clamp(Number(s.waterfallSpan) || BASE_DEFAULTS.waterfallSpan, 1, 600);
  s.colorMap = WATERFALL_MAPS.includes(s.colorMap) ? s.colorMap : BASE_DEFAULTS.colorMap;
  s.peakDecay = clamp(Number(s.peakDecay) || BASE_DEFAULTS.peakDecay, 1, 60);
  s.persistence = clamp(Number(s.persistence) || 0, 0, 0.95);
  s.markerBw = clamp(Number(s.markerBw) || BASE_DEFAULTS.markerBw, 1, 5000);
  // Not the `Number(x) || default` idiom used above: a volume of 0 is a real
  // value (silent alarms) and must survive the round trip.
  const vol = Number(s.alarmVolume);
  s.alarmVolume = clamp(Number.isFinite(vol) ? vol : BASE_DEFAULTS.alarmVolume, 0, 1);

  s.waterfallOn = Boolean(s.waterfallOn);
  s.peakHold = Boolean(s.peakHold);
  s.spectrumFill = Boolean(s.spectrumFill);
  s.showHearingBand = Boolean(s.showHearingBand);
  s.alarmMuted = Boolean(s.alarmMuted);
  return s;
}

export class Settings {
  /**
   * @param {string} storageKey
   * @param {object} defaults  merged over `BASE_DEFAULTS` per interface
   */
  constructor(storageKey, defaults = {}) {
    this.storageKey = storageKey;
    this.defaults = { ...BASE_DEFAULTS, ...defaults };
    this.values = normalize({ ...this.defaults, ...this._read() });
    this.listeners = new Set();
  }

  _read() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return {};
      // Only keys we know about, so a stale save cannot inject junk.
      const out = {};
      for (const key of Object.keys(this.defaults)) {
        if (parsed[key] !== undefined) out[key] = parsed[key];
      }
      return out;
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.values));
    } catch {
      /* storage unavailable — settings still apply for this session */
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Apply a patch, re-validate, persist, notify.
   * @param {string[]} [tags] hints for listeners, e.g. `['range']`, `['analysis']`
   */
  set(patch, tags = []) {
    Object.assign(this.values, patch);
    normalize(this.values, this.nyquist);
    this.save();
    for (const fn of this.listeners) fn(this.values, new Set(tags), patch);
  }

  /** Nyquist of the live input, so range clamping tracks the real device. */
  setNyquist(nyquist) {
    this.nyquist = nyquist;
    normalize(this.values, nyquist);
  }

  /**
   * Point at another saved state — a session switch — and reload from it.
   * Listeners are told 'all', because every value may have changed.
   */
  useStorage(storageKey) {
    this.storageKey = storageKey;
    this.values = normalize({ ...this.defaults, ...this._read() }, this.nyquist);
    for (const fn of this.listeners) fn(this.values, new Set(['all']), this.values);
  }

  reset(tags = ['all']) {
    this.values = normalize({ ...this.defaults }, this.nyquist);
    this.save();
    for (const fn of this.listeners) fn(this.values, new Set(tags), this.values);
  }

  get v() {
    return this.values;
  }
}
