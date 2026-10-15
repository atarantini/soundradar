// The Recordings menu: the takes made with the Record button, each of which
// can be played, saved as WAV or deleted. Rows are rebuilt when the list
// changes; nothing here is edited in place, so a rebuild interrupts nothing.

function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

function button(className, text, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

export class RecordingsMenu {
  /**
   * @param {object} o
   * @param {HTMLElement} o.menuEl   the whole menu, hidden until there is a take (or a reason to show one)
   * @param {HTMLElement} o.listEl   where the rows go
   * @param {HTMLElement} o.badgeEl  count of takes kept
   * @param {HTMLElement} o.msgEl    one line for why Record did not start
   * @param {import('./core/recorder.js').TakeRecorder} o.recorder
   * @param {(id:number)=>void} o.onPlay
   * @param {(id:number)=>void} o.onDownload
   * @param {(id:number)=>void} o.onDelete
   */
  constructor({ menuEl, listEl, badgeEl, msgEl, recorder, onPlay, onDownload, onDelete }) {
    Object.assign(this, { menuEl, listEl, badgeEl, msgEl, recorder, onPlay, onDownload, onDelete });
    this.playingId = null;
    recorder.subscribe(() => this.render());
    this.render();
  }

  setPlaying(id) {
    this.playingId = id;
    this.render();
  }

  render() {
    const { takes, error, maxTakes } = this.recorder;
    this.badgeEl.textContent = String(takes.length);
    this.badgeEl.hidden = takes.length === 0;
    this.msgEl.textContent = error;
    this.msgEl.hidden = !error;
    // Nothing to play, nothing to show; a failure to record still gets its say.
    this.menuEl.hidden = !takes.length && !error;
    if (this.menuEl.hidden) this.menuEl.open = false;

    const rows = takes.map((take, i) => {
      const row = document.createElement('div');
      row.className = 'rec-row';
      const info = document.createElement('div');
      info.className = 'rec-info';
      const name = document.createElement('span');
      name.className = 'rec-name';
      name.textContent = new Date(take.wallStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const meta = document.createElement('span');
      meta.className = 'rec-meta';
      meta.textContent = `${formatClock(take.ms)} · ${formatSize(take.bytes)}`;
      info.append(name, meta);
      const playing = this.playingId === take.id;
      row.append(
        info,
        button('btn rec-play', playing ? '■' : '▶', playing ? 'Stop playing' : 'Play this recording', () => this.onPlay(take.id)),
        button('btn', '⤓', 'Download as WAV', () => this.onDownload(take.id)),
        button('btn', '✕', 'Delete this recording', () => this.onDelete(take.id))
      );
      row.dataset.n = String(i + 1);
      return row;
    });
    if (rows.length) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = `${takes.length} of ${maxTakes} kept. They are lost when the page is closed or reloaded.`;
      rows.push(note);
    }
    this.listEl.replaceChildren(...rows);
  }
}
