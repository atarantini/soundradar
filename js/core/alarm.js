// Marker alarm — the "finder".
//
// Turn it on for a marker and the app sounds a short beep whenever that
// marker's band is at or above its trigger level. The louder the band, the
// higher the pitch and the faster the beeps, so you can walk a mic around a
// room and hear yourself getting closer without watching the screen.
//
// The tone is generated on the same AudioContext the analyser runs on, so it
// stops with the capture (pausing suspends the context, which silences this
// too) and no second context is ever opened.

import { clamp } from './util.js';

// Pitched high on purpose: the ear is most sensitive between roughly 2 and
// 5 kHz, so the top of this range carries over machine noise and reads as
// urgent, and the whole sweep sits above the low-frequency rumble that is
// usually what you are hunting.
export const ALARM_MIN_HZ = 700;   // at the trigger level
export const ALARM_MAX_HZ = 5600;  // at the top of the display window
export const DEFAULT_ALARM_DB = -50;

const SLOW_MS = 520; // beep spacing just above the trigger level
const FAST_MS = 90;  // ...and at full intensity
const BEEP_S = 0.075;
const SPAN_FLOOR_DB = 6; // never map intensity across less than this

/** 0–1 position of `db` between the trigger level and the display ceiling. */
export function alarmIntensity(db, triggerDb, ceilingDb) {
  if (!Number.isFinite(db)) return 0;
  const span = Math.max(SPAN_FLOOR_DB, ceilingDb - triggerDb);
  return clamp((db - triggerDb) / span, 0, 1);
}

/** Pitch for an intensity, geometric so the rise sounds even to the ear. */
export function alarmPitch(intensity) {
  return ALARM_MIN_HZ * (ALARM_MAX_HZ / ALARM_MIN_HZ) ** clamp(intensity, 0, 1);
}

export class AlarmTone {
  /**
   * @param {object} o
   * @param {() => (AudioContext|null)} o.getContext  the shared context, or null before capture starts
   */
  constructor({ getContext }) {
    this.getContext = getContext;
    this.nextAt = new Map(); // marker id → context time of the next beep
    this.active = new Set(); // ids currently sounding, for the UI
  }

  /** Silence everything and forget the schedule (capture stopped, all muted). */
  reset() {
    this.nextAt.clear();
    this.active.clear();
  }

  /**
   * Called once per frame with the current marker levels.
   * @param {object} o
   * @param {Array} o.markers    marker records (`alarm`, `alarmDb`)
   * @param {(id:number)=>{db:number}} o.levelOf
   * @param {number} o.ceilingDb top of the display window — full intensity
   * @param {number} o.volume    0–1 master level
   * @param {boolean} o.live     capture is running and not paused
   */
  update({ markers, levelOf, ceilingDb, volume, live }) {
    const armed = live && volume > 0;
    const ctx = armed ? this.getContext() : null;
    if (!ctx || ctx.state !== 'running') {
      if (this.active.size) this.active.clear();
      return;
    }

    const now = ctx.currentTime;
    const seen = new Set();

    for (const m of markers) {
      if (!m.alarm) continue;
      seen.add(m.id);
      const db = levelOf(m.id)?.db;
      const trigger = Number.isFinite(m.alarmDb) ? m.alarmDb : DEFAULT_ALARM_DB;
      if (!Number.isFinite(db) || db < trigger) {
        this.active.delete(m.id);
        this.nextAt.delete(m.id);
        continue;
      }
      this.active.add(m.id);

      const t = alarmIntensity(db, trigger, ceilingDb);
      const due = this.nextAt.get(m.id);
      // A marker that has just crossed the trigger beeps immediately; the gap
      // to the next beep is re-read every time, so it tightens as you close in.
      if (due != null && now < due) continue;
      this._beep(ctx, now, alarmPitch(t), volume);
      this.nextAt.set(m.id, now + (SLOW_MS + (FAST_MS - SLOW_MS) * t) / 1000);
    }

    for (const id of [...this.nextAt.keys()]) if (!seen.has(id)) this.nextAt.delete(id);
    for (const id of [...this.active]) if (!seen.has(id)) this.active.delete(id);
  }

  /** One short sine pip. Nodes are one-shot and released when they end. */
  _beep(ctx, at, freq, volume) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    // Ramped rather than switched: a square-edged gate on a sine clicks.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + BEEP_S);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + BEEP_S + 0.02);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* already torn down with the context */
      }
    };
  }
}
