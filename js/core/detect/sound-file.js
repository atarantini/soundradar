// One learned sound as a file: to keep it, take it to another browser or
// session, or hand it to someone — or to an assistant — to look at.
//
// The file is the sound (its examples, as 8-bit embeddings with their levels),
// how it was set (threshold, bell), and, when there is any, what it did during
// this visit: its detections, and the recent windows it scored at or above its
// release level — what held its events open — next to a sample of those it
// did not. Windows are YAMNet's numeric summaries, never audio.
//
// `tools/inspect-sound.mjs` reads this file and reports on it.
//
// Importing always adds a new sound (fresh id, a label no other sound has), as
// importing a session always adds a session: a file can never overwrite what
// is already here.

import { encodeVec } from './learned.js';
import { normalizeSounds } from './sounds.js';

export const SOUND_FILE_KIND = 'soundradar-sound';
export const SOUND_FILE_VERSION = 1;

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {object} o
 * @param {object} o.sound        from SoundStore
 * @param {object} o.settings     `{ on, alarm, threshold, ownThreshold, releaseLevel }`
 * @param {object[]} [o.detections]  this sound's DetectionLog entries
 * @param {{ matched: object[], other: object[] }|null} [o.evidence]  from WindowHistory.forSound
 * @param {number} o.now          `performance.now()` at export, to turn window times into ages
 */
export function makeSoundFile({ sound, settings, detections = [], evidence = null, now }) {
  const windowRow = (w) => ({
    ago: Math.round((now - w.t) / 100) / 10,
    db: Math.round(w.db * 10) / 10,
    score: round3(w.score),
    vec: encodeVec(w.vec),
  });
  return {
    app: 'soundradar',
    kind: SOUND_FILE_KIND,
    version: SOUND_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    note: 'A sound taught to SoundRadar: YAMNet summaries of the windows it was recorded in, not audio.',
    sound: { label: sound.label, created: sound.created, examples: sound.examples },
    settings: {
      on: Boolean(settings.on),
      alarm: Boolean(settings.alarm),
      threshold: round3(settings.threshold),
      ownThreshold: Number.isFinite(settings.ownThreshold) ? round3(settings.ownThreshold) : null,
      releaseLevel: round3(settings.releaseLevel),
    },
    detections: detections.map((e) => ({
      start: new Date(e.wallStart).toISOString(),
      seconds: Math.round((e.t1 - e.t0) / 100) / 10,
      confidence: round3(e.confidence),
    })),
    evidence: evidence && (evidence.matched.length || evidence.other.length)
      ? {
          note: 'Recent windows during this visit: "matched" scored at or above the release level, "other" is a sample of the rest. Ages are seconds before the export.',
          matched: evidence.matched.map(windowRow),
          other: evidence.other.map(windowRow),
        }
      : null,
  };
}

/**
 * Read a sound file back.
 * @returns {{ sound: { label: string, examples: object[] }, settings: { threshold?: number, alarm: boolean } }}
 */
export function readSoundFile(data) {
  let parsed = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('That file is not a SoundRadar sound.');
  if (parsed.kind === 'backup') throw new Error('That is a session backup: import it from the Session menu.');
  if (parsed.kind !== SOUND_FILE_KIND || !parsed.sound) throw new Error('That file is not a SoundRadar sound.');
  // normalizeSounds wants a stored sound; the id is replaced when it is added.
  const [sound] = normalizeSounds([{ ...parsed.sound, id: 'my-import' }]);
  if (!sound) throw new Error('That file holds no examples this version can read.');
  const t = Number(parsed.settings?.ownThreshold);
  return {
    sound: { label: sound.label, examples: sound.examples },
    settings: {
      alarm: Boolean(parsed.settings?.alarm),
      ...(Number.isFinite(t) ? { threshold: Math.max(0.05, Math.min(0.95, t)) } : {}),
    },
  };
}
