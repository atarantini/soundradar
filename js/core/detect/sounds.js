// The sounds the user has taught, per session.
//
// A sound is `{ id, label, created, examples: [{ at, s, vecs }] }`, where `s`
// is the seconds of sound an example covers and each string in `vecs` is one
// window's YAMNet embedding in the 8-bit form of learned.js. Examples are embeddings, never audio: they cannot be played back.
//
// They live in their own localStorage record next to the session's settings
// and markers, not inside `Settings`: settings are rewritten on every slider
// move, and one sound is tens of kB. Switching sessions re-points this store at
// the other record, exactly as `MarkerStore.useStorage()` does. A sound's
// switch, bell and threshold are ordinary `settings.detectors[id]` entries.
//
// Updates replace the sound object rather than mutating it, so the decoded
// vectors can be cached per object.

import { decodeVec, MAX_SOUNDS, MAX_WINDOWS } from './learned.js';

export const MAX_LABEL_LEN = 40;
const ID = /^my-[a-z0-9]{1,16}$/;

/** Every sound's id is a valid `settings.detectors` key: `my-` + base 36. */
function newId(taken) {
  for (;;) {
    const id = `my-${Math.random().toString(36).slice(2, 8)}`;
    if (id.length > 3 && !taken.has(id)) return id;
  }
}

function cleanLabel(label, fallback = 'My sound') {
  const s = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LEN);
  return s || fallback;
}

const windowsIn = (examples) => examples.reduce((n, e) => n + e.vecs.length, 0);
const copyExample = (e) => ({ at: e.at, vecs: [...e.vecs], ...(Number.isFinite(e.s) ? { s: e.s } : {}) });

/**
 * A clean list from whatever was stored or imported: unknown fields dropped,
 * undecodable windows dropped, the caps applied, and sounds left with no
 * examples removed.
 */
export function normalizeSounds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const ids = new Set();
  for (const raw of value) {
    if (out.length >= MAX_SOUNDS) break;
    if (!raw || typeof raw !== 'object' || !ID.test(raw.id) || ids.has(raw.id)) continue;
    const examples = [];
    let room = MAX_WINDOWS;
    for (const ex of Array.isArray(raw.examples) ? raw.examples : []) {
      if (!ex || !Array.isArray(ex.vecs) || room <= 0) continue;
      const vecs = ex.vecs.filter((v) => decodeVec(v)).slice(0, room);
      if (!vecs.length) continue;
      room -= vecs.length;
      const s = Number(ex.s);
      examples.push({ at: typeof ex.at === 'string' ? ex.at : '', vecs, ...(Number.isFinite(s) && s > 0 ? { s: Math.min(s, 600) } : {}) });
    }
    if (!examples.length) continue;
    ids.add(raw.id);
    out.push({
      id: raw.id,
      label: cleanLabel(raw.label),
      created: typeof raw.created === 'string' ? raw.created : '',
      examples,
    });
  }
  return out;
}

export class SoundStore {
  /** @param {{ storageKey: string }} o */
  constructor({ storageKey }) {
    this.storageKey = storageKey;
    this.sounds = [];
    this.listeners = new Set();
    this.cache = new WeakMap(); // sound object → decoded Float32Array[]
    // Set when the last write did not reach storage (full quota, private
    // mode): the change still holds for this visit, and the caller says so.
    this.saveFailed = false;
    this.load();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(kind) {
    for (const fn of this.listeners) fn(kind, this.sounds);
  }

  load() {
    let parsed = [];
    try {
      const raw = localStorage.getItem(this.storageKey);
      parsed = raw ? JSON.parse(raw) : [];
    } catch {
      parsed = [];
    }
    this.sounds = normalizeSounds(parsed);
  }

  /** @returns {boolean} whether the list reached storage */
  save() {
    try {
      if (this.sounds.length) localStorage.setItem(this.storageKey, JSON.stringify(this.sounds));
      else localStorage.removeItem(this.storageKey);
      this.saveFailed = false;
    } catch {
      this.saveFailed = true;
    }
    return !this.saveFailed;
  }

  /** Another session's sounds — a session switch. */
  useStorage(storageKey) {
    this.storageKey = storageKey;
    this.load();
    this.saveFailed = false;
    this._notify('load');
  }

  get(id) {
    return this.sounds.find((s) => s.id === id) || null;
  }

  /** How many more windows a sound can take (a new one: the full cap). */
  roomFor(id) {
    const sound = id ? this.get(id) : null;
    return MAX_WINDOWS - (sound ? windowsIn(sound.examples) : 0);
  }

  windowsOf(sound) {
    return windowsIn(sound.examples);
  }

  /** Decoded example windows, cached per sound object. */
  vectorsOf(sound) {
    let vecs = this.cache.get(sound);
    if (!vecs) {
      vecs = sound.examples.flatMap((e) => e.vecs.map(decodeVec)).filter(Boolean);
      this.cache.set(sound, vecs);
    }
    return vecs;
  }

  /** A label no other sound has, so the log stays unambiguous. */
  uniqueLabel(base = 'My sound') {
    const wanted = cleanLabel(base);
    const taken = new Set(this.sounds.map((s) => s.label.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; ; n++) {
      const candidate = cleanLabel(`${wanted} ${n}`);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /**
   * A new sound from one or more recorded examples.
   * @param {string} label
   * @param {{ at: string, vecs: string[] }[]} examples  encoded, see learned.js
   * @returns {object} the sound. Throws when a cap would be exceeded.
   */
  add(label, examples) {
    if (this.sounds.length >= MAX_SOUNDS) throw new Error(`A session holds at most ${MAX_SOUNDS} sounds. Delete one to teach another.`);
    if (windowsIn(examples) > MAX_WINDOWS) throw new Error('That is more sound than one learned sound can hold.');
    if (!windowsIn(examples)) throw new Error('Nothing was heard to learn from.');
    const sound = {
      id: newId(new Set(this.sounds.map((s) => s.id))),
      label: this.uniqueLabel(label),
      created: new Date().toISOString(),
      examples: examples.map(copyExample),
    };
    this.sounds = [...this.sounds, sound];
    this.save();
    this._notify('add');
    return sound;
  }

  addExamples(id, examples) {
    const sound = this.get(id);
    if (!sound || !examples.length) return;
    if (windowsIn(sound.examples) + windowsIn(examples) > MAX_WINDOWS) {
      throw new Error('That is more sound than one learned sound can hold. Remove an example first.');
    }
    this._replace(id, { examples: [...sound.examples, ...examples.map(copyExample)] });
  }

  rename(id, label) {
    const sound = this.get(id);
    if (!sound) return;
    const wanted = cleanLabel(label, sound.label);
    if (wanted === sound.label) return;
    const others = new Set(this.sounds.filter((s) => s.id !== id).map((s) => s.label.toLowerCase()));
    let final = wanted;
    for (let n = 2; others.has(final.toLowerCase()); n++) final = cleanLabel(`${wanted} ${n}`);
    this._replace(id, { label: final });
  }

  /** Removing the last example removes the sound: there is nothing left to match. */
  removeExample(id, index) {
    const sound = this.get(id);
    if (!sound || !sound.examples[index]) return;
    if (sound.examples.length === 1) return this.remove(id);
    this._replace(id, { examples: sound.examples.filter((_, i) => i !== index) });
  }

  remove(id) {
    if (!this.get(id)) return;
    this.sounds = this.sounds.filter((s) => s.id !== id);
    this.save();
    this._notify('remove');
  }

  _replace(id, patch) {
    this.sounds = this.sounds.map((s) => (s.id === id ? { ...s, ...patch } : s));
    this.save();
    this._notify('change');
  }
}
