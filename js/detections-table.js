// The detection report: one row per logged event, newest on top.
//
// Rows are added and closed as the log notifies, then refreshed in place at
// the readout's cadence, writing only cells whose text actually changed — a
// busy log never rebuilds the table, and an idle one touches nothing. Cells
// carry `col-*` classes like the markers report, so responsive rules can hide
// a column by name.

import { formatFreq } from './core/util.js';
import { SOURCE_LABELS } from './core/detect/catalog.js';

const MAX_ROWS = 200; // the log keeps more; the CSV has all of it

export class DetectionsTable {
  /**
   * @param {object} o
   * @param {HTMLElement} o.bodyEl
   * @param {HTMLElement} o.emptyEl
   * @param {HTMLElement} o.countEl
   * @param {import('./core/detect/log.js').DetectionLog} o.log
   * @param {(id:string)=>string} o.colorOf
   * @param {(entryId:number)=>void} o.onRemove  the user asked to drop a row
   */
  constructor({ bodyEl, emptyEl, countEl, log, colorOf, onRemove }) {
    this.bodyEl = bodyEl;
    this.emptyEl = emptyEl;
    this.countEl = countEl;
    this.log = log;
    this.colorOf = colorOf;
    this.onRemove = onRemove;
    this.rows = new Map(); // entry id → row refs
    log.subscribe((kind, entry) => {
      if (kind === 'add') this._add(entry);
      else if (kind === 'close') this._refresh(this.rows.get(entry.id), performance.now());
      else if (kind === 'remove') this._remove(entry);
      else this.rebuild();
    });
    this.rebuild();
  }

  rebuild() {
    this.bodyEl.replaceChildren();
    this.rows.clear();
    for (const entry of this.log.entries.slice(0, MAX_ROWS).reverse()) this._add(entry);
    this._counts();
  }

  _counts() {
    const n = this.log.entries.length;
    this.countEl.textContent = String(n);
    this.emptyEl.hidden = n > 0;
  }

  _add(entry) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(entry.id);
    tr.style.setProperty('--det-color', this.colorOf(entry.detectorId));

    const when = cell('col-when');
    const clock = document.createElement('div');
    clock.className = 'det-clock';
    clock.textContent = new Date(entry.wallStart).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const ago = document.createElement('div');
    ago.className = 'det-ago';
    when.append(clock, ago);

    const sound = cell('col-sound');
    const name = document.createElement('div');
    name.className = 'det-sound';
    const swatch = document.createElement('span');
    swatch.className = 'det-swatch';
    const label = document.createElement('span');
    label.textContent = entry.label;
    const detail = document.createElement('span');
    detail.className = 'det-detail';
    name.append(swatch, label, detail);
    sound.append(name);

    const conf = cell('col-conf');
    const confWrap = document.createElement('div');
    confWrap.className = 'det-conf';
    const meter = document.createElement('div');
    meter.className = 'det-meter';
    const fill = document.createElement('div');
    fill.className = 'det-meter-fill';
    meter.append(fill);
    const confText = document.createElement('span');
    confText.className = 'num-cell';
    confWrap.append(meter, confText);
    conf.append(confWrap);

    const dur = cell('num-cell col-dur');
    const hz = cell('num-cell col-hz');
    const source = cell('col-source');
    source.textContent = SOURCE_LABELS[entry.source] || entry.source;

    const actions = cell('row-actions col-actions');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-cell danger';
    remove.textContent = '✕';
    const what = `${entry.label} at ${clock.textContent}`;
    remove.title = `Remove this detection (${what})`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => this.onRemove?.(entry.id));
    actions.append(remove);

    tr.append(when, sound, conf, dur, hz, source, actions);
    this.bodyEl.prepend(tr);
    const row = { entry, tr, ago, detail, fill, confText, dur, hz, last: {} };
    this.rows.set(entry.id, row);

    // Trim from the bottom: the oldest rows go first.
    while (this.bodyEl.children.length > MAX_ROWS) {
      const oldest = this.bodyEl.lastElementChild;
      this.rows.delete(Number(oldest.dataset.id));
      oldest.remove();
    }
    this._refresh(row, performance.now());
    this._counts();
  }

  _remove(entry) {
    const row = this.rows.get(entry.id);
    // Past the row cap, a removal frees room for an older record that is not
    // on screen yet; a rebuild is the simplest way to bring it in.
    if (!row || this.log.entries.length >= MAX_ROWS) {
      this.rebuild();
      return;
    }
    // Keep keyboard focus in the list, so rows can be removed one after another.
    const hadFocus = row.tr.contains(document.activeElement);
    const neighbour = row.tr.nextElementSibling || row.tr.previousElementSibling;
    row.tr.remove();
    this.rows.delete(entry.id);
    if (hadFocus) neighbour?.querySelector('.col-actions button')?.focus();
    this._counts();
  }

  _refresh(row, now) {
    if (!row) return;
    const e = row.entry;
    const pct = Math.round(e.confidence * 100);
    const seconds = (Math.max(0, e.t1 - e.t0) / 1000).toFixed(1);
    put(row, 'open', e.open, (v) => row.tr.classList.toggle('det-open', v));
    put(row, 'ago', agoText(now - e.t0), (v) => { row.ago.textContent = v; });
    put(row, 'detail', e.detail && e.detail !== e.label ? e.detail : '', (v) => { row.detail.textContent = v; });
    put(row, 'pct', pct, (v) => {
      row.fill.style.width = `${v}%`;
      row.confText.textContent = `${v}%`;
    });
    put(row, 'dur', e.open ? `${seconds} s…` : `${seconds} s`, (v) => { row.dur.textContent = v; });
    put(row, 'hz', Number.isFinite(e.freq) ? formatFreq(e.freq) : '—', (v) => { row.hz.textContent = v; });
  }

  /** Ages tick on, and open events keep growing. */
  update(now = performance.now()) {
    for (const row of this.rows.values()) this._refresh(row, now);
  }
}

/** Write a cell only when its value changed since the last write. */
function put(row, key, value, write) {
  if (row.last[key] === value) return;
  row.last[key] = value;
  write(value);
}

function cell(className) {
  const td = document.createElement('td');
  td.className = className;
  return td;
}

function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}
