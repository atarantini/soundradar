// The markers report: one table row per marker, numbered to match its pin on
// the ruler. Rows are built when the list changes and mutated in place after
// that, so editing a field is never interrupted by a redraw.

import { levelFraction } from './core/markers.js';
import { dpr, formatFreq, resizeCanvasToDisplaySize } from './core/util.js';

export class MarkersTable {
  constructor({ bodyEl, emptyEl, countEl, store, onSelect }) {
    this.bodyEl = bodyEl;
    this.emptyEl = emptyEl;
    this.countEl = countEl;
    this.store = store;
    this.onSelect = onSelect;
    this.rows = new Map();
    store.subscribe(() => this.rebuild());
    this.rebuild();
  }

  rebuild() {
    const markers = this.store.markers;
    this.bodyEl.replaceChildren();
    this.rows.clear();
    this.emptyEl.hidden = markers.length > 0;
    this.countEl.textContent = String(markers.length);

    markers.forEach((m, index) => {
      const tr = document.createElement('tr');
      tr.style.setProperty('--pin-color', m.color);
      tr.addEventListener('pointerenter', () => this.onSelect?.(m.id));
      tr.addEventListener('pointerleave', () => this.onSelect?.(null));

      // Pin number — the same badge that appears on the ruler.
      const pin = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'pin-badge';
      badge.textContent = String(index + 1);
      pin.append(badge);

      const nameCell = document.createElement('td');
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'cell-name';
      name.value = m.name;
      name.setAttribute('aria-label', `Name of marker ${index + 1}`);
      name.addEventListener('change', () => this.store.update(m.id, { name: name.value.trim() || m.name }));
      nameCell.append(name);

      const freqCell = document.createElement('td');
      freqCell.className = 'num-cell';
      const freq = numberInput(m.freq, `Frequency of marker ${index + 1} in hertz`);
      freq.addEventListener('change', () => this.store.update(m.id, { freq: Number(freq.value) }));
      freqCell.append(freq);

      const bwCell = document.createElement('td');
      bwCell.className = 'num-cell';
      const bw = numberInput(m.bw, `Bandwidth of marker ${index + 1} in hertz`);
      bw.addEventListener('change', () => this.store.update(m.id, { bw: Number(bw.value) }));
      bwCell.append(bw);

      const meterCell = document.createElement('td');
      const meter = document.createElement('div');
      meter.className = 'row-meter';
      const fill = document.createElement('div');
      fill.className = 'row-meter-fill';
      const peakMark = document.createElement('div');
      peakMark.className = 'row-meter-peak';
      meter.append(fill, peakMark);
      meterCell.append(meter);

      const nowCell = document.createElement('td');
      nowCell.className = 'num-cell';
      nowCell.textContent = '—';

      const peakCell = document.createElement('td');
      peakCell.className = 'num-cell';
      peakCell.textContent = '—';

      const trendCell = document.createElement('td');
      const trend = document.createElement('canvas');
      trend.className = 'row-trend';
      trendCell.append(trend);

      const actions = document.createElement('td');
      actions.className = 'row-actions';
      const up = iconButton('▲', `Move marker ${index + 1} up`);
      up.disabled = index === 0;
      up.addEventListener('click', () => this.store.move(m.id, -1));
      const down = iconButton('▼', `Move marker ${index + 1} down`);
      down.disabled = index === markers.length - 1;
      down.addEventListener('click', () => this.store.move(m.id, 1));
      const remove = iconButton('✕', `Remove marker ${index + 1}`);
      remove.classList.add('danger');
      remove.addEventListener('click', () => this.store.remove(m.id));
      actions.append(up, down, remove);

      tr.append(pin, nameCell, freqCell, bwCell, meterCell, nowCell, peakCell, trendCell, actions);
      this.bodyEl.append(tr);
      this.rows.set(m.id, {
        freq, bw, fill, peakMark, nowCell, peakCell,
        trend, ctx: trend.getContext('2d'),
      });
    });
  }

  update(settings) {
    for (const m of this.store.markers) {
      const row = this.rows.get(m.id);
      if (!row) continue;
      const level = this.store.level(m.id);

      if (Number.isFinite(level.db)) {
        const t = levelFraction(level.db, settings.minDb, settings.maxDb);
        row.fill.style.width = `${(t * 100).toFixed(1)}%`;
        row.nowCell.textContent = level.db.toFixed(1);
      } else {
        row.fill.style.width = '0%';
        row.nowCell.textContent = '—';
      }
      if (Number.isFinite(level.peak)) {
        const pt = levelFraction(level.peak, settings.minDb, settings.maxDb);
        row.peakMark.style.left = `${(pt * 100).toFixed(1)}%`;
        row.peakMark.style.opacity = '0.8';
        row.peakCell.textContent = level.peak.toFixed(1);
      } else {
        row.peakMark.style.opacity = '0';
        row.peakCell.textContent = '—';
      }

      this.drawTrend(row, m);
    }
  }

  drawTrend(row, marker) {
    if (!row.ctx || !row.trend.isConnected) return;
    resizeCanvasToDisplaySize(row.trend);
    const { width, height } = row.trend;
    const ctx = row.ctx;
    ctx.clearRect(0, 0, width, height);

    const history = this.store.historyOf(marker.id);
    const finite = history.filter(Number.isFinite);
    if (finite.length < 2) return;

    // Floor the span so a steady reading does not get magnified into noise.
    let min = Math.min(...finite);
    let max = Math.max(...finite);
    if (max - min < 6) {
      const mid = (max + min) / 2;
      min = mid - 3;
      max = mid + 3;
    }

    ctx.strokeStyle = marker.color;
    ctx.lineWidth = 1.2 * dpr();
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < history.length; i++) {
      const v = history[i];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = (i / (history.length - 1)) * width;
      const y = height - ((v - min) / (max - min)) * height;
      if (started) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        started = true;
      }
    }
    ctx.stroke();
  }
}

function iconButton(glyph, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-cell';
  b.textContent = glyph;
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}

function numberInput(value, label) {
  const i = document.createElement('input');
  i.type = 'number';
  i.className = 'cell-num';
  i.min = '1';
  i.step = '1';
  i.inputMode = 'numeric';
  i.value = String(value);
  i.setAttribute('aria-label', label);
  return i;
}

export { formatFreq };
