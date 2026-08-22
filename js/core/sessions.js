// Sessions: named save states, each with its own settings and markers.
//
// A session is not a copy of the live state — it *is* the storage the live
// state reads and writes. Every session owns two localStorage records
// (`<prefix><id>.settings.v1` and `<prefix><id>.markers.v1`), and switching a
// session just re-points `Settings` and `MarkerStore` at the other pair. That
// keeps one code path for persistence: there is no "unsaved session" state to
// reconcile, because saving a setting already writes into the active session.
//
// The index record (`indexKey`) holds the roster and which id is active. The
// "default" session always exists and can never be deleted, so the app always
// has somewhere to write.

export const DEFAULT_SESSION_ID = 'default';
export const DEFAULT_SESSION_NAME = 'Default';
export const MAX_NAME_LEN = 60;

const ID_OK = /^[a-z0-9][a-z0-9-]{0,39}$/;

function newId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function cleanName(name, fallback = 'Session') {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  return s || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

export class SessionStore {
  /**
   * @param {object} o
   * @param {string} o.indexKey  localStorage key holding the roster
   * @param {string} o.prefix    key prefix for each session's own records
   */
  constructor({ indexKey, prefix }) {
    this.indexKey = indexKey;
    this.prefix = prefix;
    this.sessions = [];
    this.activeId = DEFAULT_SESSION_ID;
    this.listeners = new Set();
    this._read();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _changed() {
    this._write();
    for (const fn of this.listeners) fn(this.sessions, this.activeId);
  }

  _read() {
    let parsed = null;
    try {
      const raw = localStorage.getItem(this.indexKey);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const list = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const seen = new Set();
    this.sessions = list
      .filter((s) => s && typeof s.id === 'string' && ID_OK.test(s.id) && !seen.has(s.id) && seen.add(s.id))
      .map((s) => ({
        id: s.id,
        name: cleanName(s.name, s.id),
        createdAt: typeof s.createdAt === 'string' ? s.createdAt : nowIso(),
        updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : nowIso(),
      }));
    this._ensureDefault();
    const wanted = typeof parsed?.activeId === 'string' ? parsed.activeId : DEFAULT_SESSION_ID;
    this.activeId = this.has(wanted) ? wanted : this.sessions[0].id;
  }

  /**
   * A roster is never empty: a browser with nothing saved lands in "default".
   * This deliberately does not re-add "default" once other sessions exist —
   * otherwise deleting it would resurrect it as an empty stranger.
   */
  _ensureDefault() {
    if (!this.sessions.length) {
      this.sessions.unshift({
        id: DEFAULT_SESSION_ID,
        name: DEFAULT_SESSION_NAME,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  }

  _write() {
    try {
      localStorage.setItem(this.indexKey, JSON.stringify({ activeId: this.activeId, sessions: this.sessions }));
    } catch {
      /* storage unavailable — sessions still work for this page view */
    }
  }

  // ---------- roster ----------

  list() {
    return this.sessions;
  }

  has(id) {
    return this.sessions.some((s) => s.id === id);
  }

  get(id) {
    return this.sessions.find((s) => s.id === id) || null;
  }

  active() {
    return this.get(this.activeId) || this.sessions[0];
  }

  /** The two storage keys a session's live state reads and writes. */
  keysFor(id) {
    return { settings: `${this.prefix}${id}.settings.v1`, markers: `${this.prefix}${id}.markers.v1` };
  }

  /** A name no other session is using, so the picker stays unambiguous. */
  uniqueName(base) {
    const wanted = cleanName(base);
    const taken = new Set(this.sessions.map((s) => s.name.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; ; n++) {
      const candidate = cleanName(`${wanted} ${n}`);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /**
   * A new session starts empty: with no records under its keys, `Settings` and
   * `MarkerStore` fall back to their defaults, which is what "new" should mean.
   */
  create(name) {
    const s = { id: newId(), name: this.uniqueName(name || 'Session'), createdAt: nowIso(), updatedAt: nowIso() };
    this.sessions.push(s);
    this._changed();
    return s;
  }

  duplicate(id, name) {
    const from = this.get(id);
    if (!from) return null;
    const copy = { id: newId(), name: this.uniqueName(name || `${from.name} copy`), createdAt: nowIso(), updatedAt: nowIso() };
    const src = this.keysFor(id);
    const dst = this.keysFor(copy.id);
    for (const which of ['settings', 'markers']) {
      try {
        const raw = localStorage.getItem(src[which]);
        if (raw != null) localStorage.setItem(dst[which], raw);
      } catch {
        /* a copy that cannot be written is still a usable empty session */
      }
    }
    this.sessions.push(copy);
    this._changed();
    return copy;
  }

  rename(id, name) {
    const s = this.get(id);
    if (!s) return;
    const wanted = cleanName(name, s.name);
    if (wanted === s.name) return;
    // uniqueName() would see the session's own name as taken.
    const others = this.sessions.filter((o) => o.id !== id).map((o) => o.name.toLowerCase());
    let final = wanted;
    for (let n = 2; others.includes(final.toLowerCase()); n++) final = cleanName(`${wanted} ${n}`);
    s.name = final;
    s.updatedAt = nowIso();
    this._changed();
  }

  /** Delete a session and its records. The last one standing is kept. */
  remove(id) {
    if (this.sessions.length <= 1 || !this.has(id)) return false;
    const keys = this.keysFor(id);
    try {
      localStorage.removeItem(keys.settings);
      localStorage.removeItem(keys.markers);
    } catch {
      /* storage unavailable */
    }
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this._ensureDefault();
    if (this.activeId === id) this.activeId = this.sessions[0].id;
    this._changed();
    return true;
  }

  setActive(id) {
    if (!this.has(id) || id === this.activeId) return false;
    this.activeId = id;
    this._changed();
    return true;
  }

  /** Stamp the active session as just-modified. Called on settings/marker edits. */
  touch(id = this.activeId) {
    const s = this.get(id);
    if (!s) return;
    s.updatedAt = nowIso();
    this._write(); // no notify: nothing visible changes, and this runs on every edit
  }

  // ---------- whole-store snapshots ----------

  _readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** One session with its data inlined, as it appears in an export file. */
  snapshot(id) {
    const s = this.get(id);
    if (!s) return null;
    const keys = this.keysFor(id);
    return {
      ...s,
      settings: this._readJson(keys.settings, null),
      markers: this._readJson(keys.markers, []),
    };
  }

  /**
   * Everything this browser holds for the app, in one portable object.
   * `theme` travels for the record but is not applied on import — a merge
   * should never silently repaint the app the reader is looking at.
   */
  exportAll({ theme = null } = {}) {
    return {
      app: 'soundradar',
      kind: 'backup',
      version: 1,
      exportedAt: nowIso(),
      theme,
      activeSessionId: this.activeId,
      sessions: this.sessions.map((s) => this.snapshot(s.id)).filter(Boolean),
    };
  }

  /**
   * Merge an exported file back in. Imported sessions are always *added*
   * (with fresh ids and de-duplicated names) rather than overwriting what is
   * already here, so an import can never cost the reader their current work.
   * @returns {{ added: number, names: string[] }}
   */
  importAll(data) {
    const parsed = typeof data === 'string' ? parseJson(data) : data;
    if (!parsed || typeof parsed !== 'object') throw new Error('That file is not a SoundRadar backup.');
    const list = Array.isArray(parsed.sessions) ? parsed.sessions : null;
    if (!list) throw new Error('That file does not contain any sessions.');

    const added = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const id = newId();
      const name = this.uniqueName(cleanName(entry.name, 'Imported session'));
      const keys = this.keysFor(id);
      try {
        if (entry.settings && typeof entry.settings === 'object') {
          localStorage.setItem(keys.settings, JSON.stringify(entry.settings));
        }
        if (Array.isArray(entry.markers)) {
          localStorage.setItem(keys.markers, JSON.stringify(entry.markers));
        }
      } catch {
        throw new Error('There is no room left in this browser’s storage for the import.');
      }
      this.sessions.push({
        id,
        name,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : nowIso(),
        updatedAt: nowIso(),
      });
      added.push(name);
    }
    if (!added.length) throw new Error('That file does not contain any sessions.');
    this._changed();
    return { added: added.length, names: added };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
}
