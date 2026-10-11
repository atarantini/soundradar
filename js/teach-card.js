// The teach card: where a sound of the user's own is recorded, named, given
// more examples, and deleted. It opens inside the Detect menu's My sounds group.
//
// One recording is one example. Record is a toggle — tap to start, tap to stop
// — because holding a button down is unreliable on a touch screen while the
// menu sheet scrolls. Recordings collect here as pending examples and are only
// written to the store on Save, so Cancel really does leave nothing behind.
// Examples already saved (when editing) are removed straight away with their ✕.
//
// What is kept is YAMNet embeddings, never audio (see learned.js); the card
// says so, since the user is about to point a microphone at something.

import { encodeVec, formatSeconds, secondsOf, MIN_SECONDS, MIN_WINDOWS } from './core/detect/learned.js';

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
};

const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
};

export class TeachCard {
  /**
   * @param {object} o
   * @param {HTMLElement} o.slot           where the card is shown
   * @param {import('./core/detect/sounds.js').SoundStore} o.store
   * @param {import('./core/detect/teach.js').TeachSession} o.teach
   * @param {() => { live: boolean, model: string }} o.status  capture and classifier state
   * @param {() => void} o.onStartCapture
   * @param {() => void} o.onStateChange  opened, closed, started or stopped recording: the
   *   classifier runs while the card is open, so it is ready by the time Record is pressed
   * @param {(sound: object, isNew: boolean) => void} o.onSaved
   * @param {(id: string) => void} o.onDelete
   * @param {(id: string) => void} o.onExport
   */
  constructor({ slot, store, teach, status, onStartCapture, onStateChange, onSaved, onDelete, onExport }) {
    this.slot = slot;
    this.store = store;
    this.teach = teach;
    this.status = status;
    this.onStateChange = onStateChange;
    this.onSaved = onSaved;
    this.onDelete = onDelete;
    this.onExport = onExport;
    this.soundId = null; // the sound being edited; null for a new one
    this.pending = []; // [{ at, s, dbs, vecs: Float32Array[] }]
    this.isOpen = false;
    this._build(onStartCapture);
    teach.onchange = () => this.refresh();
  }

  get recording() {
    return this.isOpen && this.teach.recording;
  }

  _build(onStartCapture) {
    const card = el('div', 'teach-card');
    card.hidden = true;
    const head = el('div', 'teach-head');
    this.title = el('span', 'tag');
    const close = el('button', 'link', 'Cancel');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(this.title, close);

    const nameRow = el('label', 'field field-row');
    nameRow.append(el('span', 'tag', 'Name'));
    this.name = el('input', 'teach-name');
    this.name.type = 'text';
    this.name.maxLength = 40;
    this.name.autocomplete = 'off';
    this.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.save();
    });
    nameRow.append(this.name);

    const recRow = el('div', 'teach-rec-row');
    this.rec = el('button', 'btn teach-rec');
    this.rec.type = 'button';
    this.rec.addEventListener('click', () => this.toggleRecord());
    this.line = el('p', 'teach-line');
    this.line.setAttribute('aria-live', 'polite');
    recRow.append(this.rec, this.line);

    this.startBtn = el('button', 'btn btn-block', 'Start capture');
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => onStartCapture());

    this.list = el('ul', 'teach-examples');
    this.msg = el('p', 'teach-msg');
    this.msg.setAttribute('role', 'status');

    const actions = el('div', 'teach-actions');
    this.saveBtn = el('button', 'btn btn-primary', 'Save');
    this.saveBtn.type = 'button';
    this.saveBtn.addEventListener('click', () => this.save());
    this.deleteBtn = el('button', 'link link-danger', 'Delete sound');
    this.deleteBtn.type = 'button';
    this.deleteBtn.addEventListener('click', () => {
      const sound = this.store.get(this.soundId);
      if (sound && confirm(`Delete “${sound.label}” and everything it was taught?`)) {
        this.close();
        this.onDelete(sound.id);
      }
    });
    this.exportBtn = el('button', 'link', 'Export');
    this.exportBtn.type = 'button';
    this.exportBtn.title = 'Save this sound as a file, with what it detected during this visit';
    this.exportBtn.addEventListener('click', () => this.soundId && this.onExport(this.soundId));
    const right = el('span', 'teach-actions-right');
    right.append(this.exportBtn, this.deleteBtn);
    actions.append(this.saveBtn, right);

    const hint = el('p', 'hint');
    hint.textContent =
      'Press Record while the sound is happening, and Record again to stop. Record it on its own if you can, ' +
      'and a few times — near, far, with other noise around — since every example helps. It learns to find ' +
      'this sound again, not every sound of its kind. What is kept is a numeric summary of each second, not ' +
      'audio; it stays in this browser and leaves only in a session export.';

    card.append(head, nameRow, recRow, this.startBtn, this.list, this.msg, actions, hint);
    this.slot.append(card);
    this.card = card;
  }

  /** Teach a new sound. */
  openNew() {
    this._open(null);
    this.name.value = this.store.uniqueLabel('My sound');
    this.name.focus();
    this.name.select();
  }

  /** Rename, add examples to or delete a sound already taught. */
  openEdit(id) {
    const sound = this.store.get(id);
    if (!sound) return;
    this._open(id);
    this.name.value = sound.label;
  }

  _open(id) {
    this._stop(true);
    this.soundId = id;
    this.pending = [];
    this.isOpen = true;
    this.card.hidden = false;
    this.msg.textContent = '';
    this._listKey = null;
    this.refresh();
    this.card.scrollIntoView?.({ block: 'nearest' });
    this.onStateChange();
  }

  /** Close without saving: what was recorded and not saved is dropped. */
  close() {
    this._stop(true);
    this.isOpen = false;
    this.pending = [];
    this.soundId = null;
    this.card.hidden = true;
    this.onStateChange();
  }

  _pendingWindows() {
    return this.pending.reduce((n, e) => n + e.vecs.length, 0);
  }

  toggleRecord() {
    if (this.teach.recording) {
      this._stop(false);
      return;
    }
    if (!this.status().live) {
      this.msg.textContent = 'Start capture first: there is nothing to record from.';
      this.refresh();
      return;
    }
    const room = this.store.roomFor(this.soundId) - this._pendingWindows();
    if (room < MIN_WINDOWS * 2) {
      this.msg.textContent = 'This sound holds as much as it can (about 40 s). Remove an example to record another.';
      return;
    }
    this.msg.textContent = '';
    this.teach.start(performance.now(), room);
    this.onStateChange();
    this.refresh();
  }

  /** Stop recording; keep what was heard unless `discard`. */
  _stop(discard) {
    if (!this.teach.recording) return;
    const { vecs, dbs, seconds, backgroundSeconds } = this.teach.stop(performance.now());
    this.onStateChange();
    if (discard) return;
    // The quiet stretches in between were the room, not the sound (teach.js).
    const left = backgroundSeconds >= 0.5 ? ` ${formatSeconds(backgroundSeconds)} of quieter background was left out.` : '';
    if (vecs.length < MIN_WINDOWS || seconds < MIN_SECONDS) {
      this.msg.textContent = `Only ${formatSeconds(seconds)} of sound was heard. Record at least ${formatSeconds(MIN_SECONDS)} while it is happening.${left}`;
    } else {
      this.pending.push({ at: new Date().toISOString(), s: Number(seconds.toFixed(2)), dbs, vecs });
      this.msg.textContent = this.teach.full ? `Stopped: this sound cannot hold any more.${left}` : left.trim();
    }
    this.refresh();
  }

  save() {
    if (this.teach.recording) this._stop(false);
    const examples = this.pending.map((e) => ({ at: e.at, s: e.s, dbs: e.dbs, vecs: e.vecs.map(encodeVec) }));
    const isNew = !this.soundId;
    let sound;
    try {
      if (isNew) {
        if (!examples.length) {
          this.msg.textContent = 'Record the sound at least once before saving.';
          return;
        }
        sound = this.store.add(this.name.value, examples);
      } else {
        this.store.rename(this.soundId, this.name.value);
        this.store.addExamples(this.soundId, examples);
        sound = this.store.get(this.soundId);
      }
    } catch (err) {
      this.msg.textContent = err.message;
      return;
    }
    this.pending = [];
    this.onSaved(sound, isNew);
    if (this.store.saveFailed) {
      // Keep the card up: the warning is the point.
      this._open(sound.id);
      this.msg.textContent = 'Kept for this visit only: this browser’s storage is full. Delete a sound or a session you no longer need, then save again.';
      return;
    }
    this.close();
  }

  _removeSaved(index) {
    const sound = this.store.get(this.soundId);
    if (!sound) return;
    if (sound.examples.length === 1 && !this.pending.length) {
      if (!confirm(`That is the only example of “${sound.label}”. Delete the sound?`)) return;
      this.close();
      this.onDelete(sound.id);
      return;
    }
    if (sound.examples.length === 1) {
      // Its new examples are about to replace it: save them first.
      this.msg.textContent = 'Save the new examples first; a sound needs at least one.';
      return;
    }
    this.store.removeExample(sound.id, index);
    this.refresh();
  }

  /** Redraw the card from its state; cheap enough to call on every window. */
  refresh() {
    if (!this.isOpen) return;
    const sound = this.soundId ? this.store.get(this.soundId) : null;
    if (this.soundId && !sound) return this.close(); // deleted elsewhere (a session switch)
    const { live, model } = this.status();
    const recording = this.teach.recording;

    this.title.textContent = sound ? `Edit “${sound.label}”` : 'Teach a sound';
    this.rec.textContent = recording ? '■ Stop' : '● Record';
    this.rec.classList.toggle('is-recording', recording);
    this.rec.setAttribute('aria-pressed', String(recording));
    this.startBtn.hidden = live;

    if (recording) {
      const t = Math.floor(this.teach.elapsed(performance.now()));
      const wait = model === 'ready' ? '' : model === 'error' ? ' · the classifier failed' : ' · loading the classifier…';
      this.line.textContent = `Recording ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} · ${formatSeconds(this.teach.seconds)} of sound${wait}`;
    } else if (!live) {
      this.line.textContent = 'Capture is stopped.';
    } else {
      const n = (sound?.examples.length || 0) + this.pending.length;
      this.line.textContent = n ? `${n} example${n === 1 ? '' : 's'}` : 'Press Record while the sound is happening.';
    }

    // Saved examples first, then the ones this card has not saved yet. Only
    // rebuilt when they change: this runs on every window while recording,
    // and a ✕ replaced under a finger would swallow the tap.
    const key = JSON.stringify([sound?.examples.map((e) => [e.at, e.vecs.length]), this.pending.map((e) => [e.at, e.vecs.length])]);
    if (key !== this._listKey) {
      this._listKey = key;
      this._renderList(sound);
    }

    this.saveBtn.textContent = sound ? 'Save changes' : 'Save sound';
    this.saveBtn.disabled = recording ? false : !sound && !this.pending.length;
    this.deleteBtn.hidden = !sound;
    this.exportBtn.hidden = !sound;
  }

  _renderList(sound) {
    this.list.replaceChildren();
    const item = (label, onRemove, isNew) => {
      const li = el('li', isNew ? 'is-new' : '');
      li.append(el('span', '', label));
      const x = el('button', 'icon-cell danger', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${label}`);
      x.addEventListener('click', onRemove);
      li.append(x);
      this.list.append(li);
    };
    sound?.examples.forEach((e, i) => {
      item(`Example ${i + 1} · ${formatSeconds(secondsOf(e))} · ${clock(e.at)}`, () => this._removeSaved(i), false);
    });
    const base = sound?.examples.length || 0;
    this.pending.forEach((e, i) => {
      item(`Example ${base + i + 1} · ${formatSeconds(e.s)} · not saved yet`, () => {
        this.pending.splice(i, 1);
        this.refresh();
      }, true);
    });
    this.list.hidden = !this.list.children.length;
  }
}
