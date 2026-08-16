// Live spectrum plot: grid, trace, optional peak-hold and phosphor persistence.
//
// Colours come from a theme object rather than being hard-coded, so the two
// interface designs can share this renderer without either one inheriting the
// other's palette.

import { columnDb, buildColumnBins, dbToY, freqToX, freqTicks, dbTicks } from './scale.js';
import { clamp, dpr, formatFreqShort } from './util.js';

export class SpectrumView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rect = { x: 0, y: 0, w: 0, h: 0 };

    this.columns = null;
    this.columnKey = '';
    this.trace = null; // dB per column, current frame
    this.peaks = null; // dB per column, decaying maximum
    this.peakTime = 0;

    // Persistence buffer: successive traces fading out, the way an analogue
    // analyser's phosphor holds a moment of history in the picture itself.
    this.phosphor = null;
    this.phosphorCtx = null;
  }

  setRect(x, y, w, h) {
    const r = this.rect;
    if (r.x === x && r.y === y && r.w === w && r.h === h) return;
    this.rect = { x, y, w: Math.max(0, w), h: Math.max(0, h) };
    this.columnKey = '';
    this.trace = null;
    this.peaks = null;
    if (this.phosphor) {
      this.phosphor.width = Math.max(1, this.rect.w);
      this.phosphor.height = Math.max(1, this.rect.h);
    }
  }

  resetPeaks() {
    this.peaks = null;
  }

  _ensureColumns(settings, sampleRate, fftSize) {
    const { w } = this.rect;
    const key = `${w}|${settings.minFreq}|${settings.maxFreq}|${settings.freqScale}|${sampleRate}|${fftSize}`;
    if (key === this.columnKey && this.columns) return;
    this.columns = buildColumnBins(Math.max(1, w), settings, sampleRate, fftSize);
    this.columnKey = key;
    this.trace = new Float32Array(Math.max(1, w));
    this.peaks = null;
  }

  _ensurePhosphor() {
    if (this.phosphor) return;
    this.phosphor = document.createElement('canvas');
    this.phosphor.width = Math.max(1, this.rect.w);
    this.phosphor.height = Math.max(1, this.rect.h);
    this.phosphorCtx = this.phosphor.getContext('2d');
  }

  /**
   * @param {object} o
   * @param {Float32Array|null} o.data   latest FFT frame
   * @param {object} o.settings         display settings
   * @param {object} o.theme            canvas colours, see `theme.js`
   * @param {number} o.now              rAF timestamp, for peak decay
   */
  draw({ data, settings, sampleRate, fftSize, theme, now }) {
    const ctx = this.ctx;
    const { x, y, w, h } = this.rect;
    const ratio = dpr();

    ctx.save();
    ctx.fillStyle = theme.plotBg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (w <= 0 || h <= 0) {
      ctx.restore();
      return;
    }

    this._ensureColumns(settings, sampleRate, fftSize);
    this._drawGrid(theme, settings, ratio);

    if (!data) {
      ctx.restore();
      return;
    }

    // Sample every column first: the trace, the fill, the peak-hold line and
    // the persistence buffer all read the same array.
    const trace = this.trace;
    const nyquist = sampleRate / 2;
    for (let i = 0; i < w; i++) {
      const db = columnDb(data, i, this.columns, settings, sampleRate, fftSize);
      trace[i] = Number.isFinite(db) ? db : settings.minDb - 10;
    }

    if (settings.peakHold) this._updatePeaks(trace, now, settings);

    if (settings.persistence > 0) {
      this._drawPersistence(theme, settings, ratio);
    }

    this._drawTrace(trace, theme, settings, ratio, nyquist);

    if (settings.peakHold && this.peaks) {
      this._drawPeakLine(theme, settings, ratio);
    }

    ctx.restore();
  }

  _updatePeaks(trace, now, settings) {
    const w = this.rect.w;
    if (!this.peaks || this.peaks.length !== w) {
      this.peaks = Float32Array.from(trace);
      this.peakTime = now;
      return;
    }
    const dt = Math.max(0, Math.min(0.25, (now - this.peakTime) / 1000));
    this.peakTime = now;
    const decay = settings.peakDecay * dt; // dB to fall this frame
    const peaks = this.peaks;
    for (let i = 0; i < w; i++) {
      const v = trace[i];
      peaks[i] = v >= peaks[i] ? v : Math.max(v, peaks[i] - decay);
    }
  }

  _tracePath(ctx, values, settings, offsetX, offsetY) {
    const { w, h } = this.rect;
    ctx.beginPath();
    for (let i = 0; i < w; i++) {
      const py = dbToY(values[i], settings.minDb, settings.maxDb, h, offsetY);
      if (i === 0) ctx.moveTo(offsetX + i, py);
      else ctx.lineTo(offsetX + i, py);
    }
  }

  _drawTrace(trace, theme, settings, ratio, nyquist) {
    const ctx = this.ctx;
    const { x, y, w, h } = this.rect;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    if (settings.spectrumFill) {
      this._tracePath(ctx, trace, settings, x, y);
      ctx.lineTo(x + w - 1, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, theme.traceFillTop);
      grad.addColorStop(1, theme.traceFillBottom);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    this._tracePath(ctx, trace, settings, x, y);
    ctx.lineWidth = 1.4 * ratio;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.trace;
    if (theme.traceGlow) {
      ctx.shadowColor = theme.traceGlow;
      ctx.shadowBlur = 6 * ratio;
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawPeakLine(theme, settings, ratio) {
    const ctx = this.ctx;
    const { x, y, w, h } = this.rect;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    this._tracePath(ctx, this.peaks, settings, x, y);
    ctx.lineWidth = 1 * ratio;
    ctx.strokeStyle = theme.peak;
    ctx.setLineDash([3 * ratio, 3 * ratio]);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Fade the persistence buffer, stamp the current trace into it, then composite
   * it under the live trace. `persistence` is 0–1; higher holds trails longer.
   */
  _drawPersistence(theme, settings, ratio) {
    this._ensurePhosphor();
    const p = this.phosphorCtx;
    const { x, y, w, h } = this.rect;
    if (this.phosphor.width !== w || this.phosphor.height !== h) {
      this.phosphor.width = Math.max(1, w);
      this.phosphor.height = Math.max(1, h);
    }

    p.globalCompositeOperation = 'destination-out';
    p.fillStyle = `rgba(0,0,0,${(1 - settings.persistence) * 0.5 + 0.02})`;
    p.fillRect(0, 0, w, h);

    p.globalCompositeOperation = 'source-over';
    this._tracePathOn(p, this.trace, settings, 0, 0);
    p.lineWidth = 1.2 * ratio;
    p.strokeStyle = theme.persistence;
    p.stroke();

    this.ctx.drawImage(this.phosphor, x, y);
  }

  _tracePathOn(ctx, values, settings, offsetX, offsetY) {
    const { w, h } = this.rect;
    ctx.beginPath();
    for (let i = 0; i < w; i++) {
      const py = dbToY(values[i], settings.minDb, settings.maxDb, h, offsetY);
      if (i === 0) ctx.moveTo(offsetX + i, py);
      else ctx.lineTo(offsetX + i, py);
    }
  }

  _drawGrid(theme, settings, ratio) {
    const ctx = this.ctx;
    const { x, y, w, h } = this.rect;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = `${theme.axisWeight || 500} ${10 * ratio}px ${theme.axisFont}`;
    ctx.textBaseline = 'middle';

    for (const tick of freqTicks(settings, w)) {
      const px = Math.round(freqToX(tick.freq, settings, w, x)) + 0.5;
      if (px < x || px > x + w) continue;
      ctx.strokeStyle = tick.major ? theme.gridMajor : theme.gridMinor;
      ctx.beginPath();
      ctx.moveTo(px, y);
      ctx.lineTo(px, y + h);
      ctx.stroke();
    }

    // dB labels live in the left gutter so they never sit on top of the trace.
    ctx.textAlign = 'right';
    ctx.fillStyle = theme.axisText;
    for (const db of dbTicks(settings.minDb, settings.maxDb, h)) {
      const py = Math.round(dbToY(db, settings.minDb, settings.maxDb, h, y)) + 0.5;
      ctx.strokeStyle = theme.gridMajor;
      ctx.beginPath();
      ctx.moveTo(x, py);
      ctx.lineTo(x + w, py);
      ctx.stroke();
      if (py > y + 8 * ratio && py < y + h - 4 * ratio) {
        ctx.fillText(String(db), x - 6 * ratio, py);
      }
    }
    ctx.restore();
  }

  /** dB of the current frame at a pixel X, for the hover readout. */
  dbAtX(px) {
    if (!this.trace) return NaN;
    const i = Math.round(px - this.rect.x);
    if (i < 0 || i >= this.rect.w) return NaN;
    return this.trace[i];
  }
}

/**
 * Frequency axis strip. Drawn separately from the plots so both views and the
 * shared ruler in this layout can use exactly the same tick positions.
 */
export function drawFreqAxis(ctx, rect, settings, theme, ratio = dpr()) {
  const { x, y, w, h } = rect;
  ctx.save();
  ctx.font = `${theme.axisWeight || 500} ${10 * ratio}px ${theme.axisFont}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';

  let lastLabelEdge = -Infinity;
  for (const tick of freqTicks(settings, w)) {
    const px = Math.round(freqToX(tick.freq, settings, w, x)) + 0.5;
    if (px < x - 1 || px > x + w + 1) continue;
    ctx.strokeStyle = tick.major ? theme.axisTick : theme.axisTickMinor;
    ctx.beginPath();
    ctx.moveTo(px, y);
    ctx.lineTo(px, y + (tick.major ? h * 0.42 : h * 0.22));
    ctx.stroke();
    if (!tick.major) continue;
    const label = formatFreqShort(tick.freq);
    const half = ctx.measureText(label).width / 2 + 6 * ratio;
    if (px - half < lastLabelEdge) continue; // keep labels from colliding
    lastLabelEdge = px + half;
    ctx.fillStyle = theme.axisText;
    ctx.fillText(label, clamp(px, x + half, x + w - half), y + h * 0.46);
  }
  ctx.restore();
}
