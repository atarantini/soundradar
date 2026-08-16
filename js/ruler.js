// The frequency ruler.
//
// One engraved strip between the two plates carrying the shared frequency axis,
// and the surface markers are planted on. Both plates map frequency to exactly
// the same X, so a pin on the ruler lines up with the peak above it and the
// stripe below it — which is the whole point of putting the axis between them
// instead of under the bottom plot.

import { freqToX, freqTicks } from './core/scale.js';
import { clamp, dpr, formatFreqShort, formatFreq } from './core/util.js';

const BADGE = 17; // CSS px
const STEM_TOP = 0;

export class Ruler {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rect = { x: 0, w: 0 };
    this.pinRects = []; // { id, x0, x1 } in canvas px, for hit-testing
  }

  /** Match the plates' plot rect so the axis lines up across all three. */
  setRect(x, w) {
    this.rect = { x, w: Math.max(0, w) };
  }

  draw({ settings, markers, theme, hoverFreq, selection }) {
    const ctx = this.ctx;
    const r = dpr();
    const { width, height } = this.canvas;
    const { x, w } = this.rect;

    ctx.clearRect(0, 0, width, height);
    if (w <= 0) return;

    const badge = BADGE * r;
    const tickTop = 0;
    const labelY = Math.round(height * 0.30);
    const pinY = height - badge - 3 * r;

    if (selection) {
      ctx.fillStyle = theme.selection;
      ctx.fillRect(Math.min(selection.x0, selection.x1), 0, Math.abs(selection.x1 - selection.x0), height);
    }

    // --- ticks -------------------------------------------------------------
    ctx.save();
    ctx.font = `600 ${10 * r}px ${theme.monoFont}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    let lastEdge = -Infinity;

    for (const tick of freqTicks(settings, w)) {
      const px = Math.round(freqToX(tick.freq, settings, w, x)) + 0.5;
      if (px < x - 1 || px > x + w + 1) continue;
      ctx.strokeStyle = tick.major ? theme.rulerTick : theme.rulerTickMinor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, tickTop);
      ctx.lineTo(px, tickTop + (tick.major ? 9 * r : 5 * r));
      ctx.stroke();
      if (!tick.major) continue;

      const label = formatFreqShort(tick.freq);
      const half = ctx.measureText(label).width / 2 + 7 * r;
      if (px - half < lastEdge) continue;
      lastEdge = px + half;
      ctx.fillStyle = theme.rulerText;
      ctx.fillText(label, clamp(px, x + half, x + w - half), labelY);
    }

    // A hairline along the bottom of the tick band ties the strip together.
    ctx.strokeStyle = theme.rulerBaseline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, Math.round(labelY + 12 * r) + 0.5);
    ctx.lineTo(x + w, Math.round(labelY + 12 * r) + 0.5);
    ctx.stroke();
    ctx.restore();

    // --- hover caret -------------------------------------------------------
    if (Number.isFinite(hoverFreq)) {
      const px = Math.round(freqToX(hoverFreq, settings, w, x)) + 0.5;
      if (px >= x && px <= x + w) {
        ctx.save();
        ctx.strokeStyle = theme.rulerCaret;
        ctx.setLineDash([2 * r, 3 * r]);
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, height);
        ctx.stroke();
        ctx.restore();
      }
    }

    // --- pins --------------------------------------------------------------
    this.pinRects = [];
    ctx.save();
    ctx.font = `700 ${10 * r}px ${theme.monoFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    markers.forEach((m, i) => {
      const px = freqToX(m.freq, settings, w, x);
      if (px < x - badge || px > x + w + badge) return;
      const bx = clamp(px, x + badge / 2, x + w - badge / 2);

      // Stem: rises the full height so the pin visibly belongs to both plates.
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5 * r;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, STEM_TOP);
      ctx.lineTo(Math.round(px) + 0.5, pinY);
      ctx.stroke();

      ctx.fillStyle = m.color;
      ctx.fillRect(bx - badge / 2, pinY, badge, badge);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(i + 1), bx, pinY + badge / 2 + 0.5 * r);

      this.pinRects.push({ id: m.id, x0: bx - badge, x1: bx + badge });
    });
    ctx.restore();
  }

  /** Marker id under a canvas X, or null. Pins are the only draggable thing. */
  hitPin(px) {
    for (let i = this.pinRects.length - 1; i >= 0; i--) {
      const p = this.pinRects[i];
      if (px >= p.x0 && px <= p.x1) return p.id;
    }
    return null;
  }
}

export { formatFreq };
