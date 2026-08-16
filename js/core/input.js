// Pointer handling for a plot surface.
//
// v1 listened for `mousemove`/`mousedown` only, so on the tablets the interface
// was explicitly sized for, nothing worked but tapping — and a tap dropped a
// marker, which made it impossible to just look. Pointer events cover mouse,
// touch and pen with one path; the gestures below are the whole interaction
// vocabulary of both designs.
//
//   drag              pan the frequency range
//   wheel / pinch     zoom around the pointer
//   shift + drag      select a range to zoom into
//   double click/tap  drop a marker
//   long press        drop a marker (touch)
//   drag a marker     move it
//
// All callbacks receive canvas-pixel coordinates; frequency maths stays in
// `scale.js` where the caller can apply it with the right settings.

import { clamp, dpr } from './util.js';

const DRAG_SLOP = 5; // px before a press becomes a drag
const LONG_PRESS_MS = 480;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 28;

export class PlotInput {
  /**
   * @param {HTMLElement} el      element that receives pointer events
   * @param {object} h            handlers, all optional
   */
  constructor(el, h) {
    this.el = el;
    this.h = h;
    this.pointers = new Map();
    this.mode = null; // 'pan' | 'select' | 'marker' | 'pinch'
    this.start = null;
    this.dragMarkerId = null;
    this.longPressTimer = 0;
    this.lastTap = { t: 0, x: 0, y: 0 };
    this.selection = null;
    this.hover = null;

    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this._down);
    el.addEventListener('pointermove', this._move);
    el.addEventListener('pointerup', this._up);
    el.addEventListener('pointercancel', this._up);
    el.addEventListener('pointerleave', this._leave);
    el.addEventListener('wheel', this._wheel, { passive: false });
    el.addEventListener('dblclick', this._dblclick);
    el.addEventListener('contextmenu', this._contextmenu);
  }

  destroy() {
    const el = this.el;
    el.removeEventListener('pointerdown', this._down);
    el.removeEventListener('pointermove', this._move);
    el.removeEventListener('pointerup', this._up);
    el.removeEventListener('pointercancel', this._up);
    el.removeEventListener('pointerleave', this._leave);
    el.removeEventListener('wheel', this._wheel);
    el.removeEventListener('dblclick', this._dblclick);
    el.removeEventListener('contextmenu', this._contextmenu);
  }

  /** Event → canvas-pixel coordinates, matching the backing store. */
  toCanvas(evt) {
    const rect = this.el.getBoundingClientRect();
    const ratio = dpr();
    return {
      x: (evt.clientX - rect.left) * ratio,
      y: (evt.clientY - rect.top) * ratio,
    };
  }

  _cancelLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
    }
  }

  /** Pointer capture throws if the id is not active; never let that abort a gesture. */
  _capture(id, release) {
    try {
      if (release) this.el.releasePointerCapture?.(id);
      else this.el.setPointerCapture?.(id);
    } catch {
      /* no active pointer with this id */
    }
  }

  _down = (evt) => {
    if (evt.button !== undefined && evt.button > 1) return;
    this._capture(evt.pointerId, false);
    const p = this.toCanvas(evt);
    this.pointers.set(evt.pointerId, p);

    if (this.pointers.size === 2) {
      this._cancelLongPress();
      const [a, b] = [...this.pointers.values()];
      this.mode = 'pinch';
      this.start = { distance: Math.abs(a.x - b.x) || 1, center: (a.x + b.x) / 2 };
      this.h.onPinchStart?.();
      return;
    }
    if (this.pointers.size > 2) return;

    const markerId = this.h.hitMarker?.(p.x, p.y);
    if (evt.shiftKey || evt.button === 1) {
      this.mode = 'select';
      this.selection = { x0: p.x, x1: p.x };
      this.h.onSelect?.(this.selection);
    } else if (markerId != null) {
      this.mode = 'marker';
      this.dragMarkerId = markerId;
      this.h.onMarkerDragStart?.(markerId);
    } else {
      this.mode = 'pan';
    }
    this.start = { ...this.start, x: p.x, y: p.y, moved: false };

    if (evt.pointerType === 'touch' && this.mode === 'pan') {
      this.longPressTimer = setTimeout(() => {
        this.longPressTimer = 0;
        if (this.start && !this.start.moved) {
          this.mode = null;
          this.h.onAddMarker?.(p.x, p.y);
        }
      }, LONG_PRESS_MS);
    }
  };

  _move = (evt) => {
    const p = this.toCanvas(evt);

    if (!this.pointers.has(evt.pointerId)) {
      this.hover = p;
      this.h.onHover?.(p.x, p.y, evt);
      return;
    }

    const prev = this.pointers.get(evt.pointerId);
    this.pointers.set(evt.pointerId, p);

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.abs(a.x - b.x) || 1;
      const center = (a.x + b.x) / 2;
      this.h.onZoom?.(this.start.distance / distance, this.start.center);
      this.h.onPan?.(this.start.center - center);
      this.start = { distance, center };
      return;
    }

    if (this.start && !this.start.moved) {
      if (Math.hypot(p.x - this.start.x, p.y - this.start.y) > DRAG_SLOP * dpr()) {
        this.start.moved = true;
        this._cancelLongPress();
      }
    }

    if (this.mode === 'select') {
      this.selection.x1 = p.x;
      this.h.onSelect?.(this.selection);
      return;
    }
    if (this.mode === 'marker') {
      this.h.onMarkerDrag?.(this.dragMarkerId, p.x, p.y);
      return;
    }
    if (this.mode === 'pan' && this.start.moved) {
      this.h.onPan?.(prev.x - p.x);
      this.h.onHover?.(p.x, p.y, evt);
      return;
    }
    this.hover = p;
    this.h.onHover?.(p.x, p.y, evt);
  };

  _up = (evt) => {
    this._capture(evt.pointerId, true);
    const p = this.pointers.get(evt.pointerId) || this.toCanvas(evt);
    this.pointers.delete(evt.pointerId);
    this._cancelLongPress();

    if (this.mode === 'pinch') {
      // Second finger lifted: fall back to panning with the one that remains.
      this.mode = this.pointers.size === 1 ? 'pan' : null;
      if (this.mode === 'pan') {
        const [a] = [...this.pointers.values()];
        this.start = { x: a.x, y: a.y, moved: true };
      }
      return;
    }

    if (this.mode === 'select') {
      const sel = this.selection;
      this.selection = null;
      this.h.onSelect?.(null);
      if (sel && Math.abs(sel.x1 - sel.x0) > DRAG_SLOP * dpr()) {
        this.h.onSelectCommit?.(Math.min(sel.x0, sel.x1), Math.max(sel.x0, sel.x1));
      }
    } else if (this.mode === 'marker') {
      this.h.onMarkerDragEnd?.(this.dragMarkerId);
      this.dragMarkerId = null;
    } else if (this.mode === 'pan' && this.start && !this.start.moved) {
      // A tap that did not drag. On touch, a second tap nearby means "add a
      // marker" — the desktop equivalent is a double click.
      const now = performance.now();
      const isDouble =
        evt.pointerType === 'touch' &&
        now - this.lastTap.t < DOUBLE_TAP_MS &&
        Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < DOUBLE_TAP_SLOP * dpr();
      if (isDouble) {
        this.lastTap = { t: 0, x: 0, y: 0 };
        this.h.onAddMarker?.(p.x, p.y);
      } else {
        this.lastTap = { t: now, x: p.x, y: p.y };
        this.h.onTap?.(p.x, p.y);
      }
    }

    if (this.pointers.size === 0) {
      this.mode = null;
      this.start = null;
    }
  };

  _leave = () => {
    if (this.pointers.size) return;
    this.hover = null;
    this._cancelLongPress();
    this.h.onLeave?.();
  };

  _wheel = (evt) => {
    // Always claim the gesture: an un-prevented ctrl+wheel is a browser zoom,
    // which would resize the whole page mid-measurement.
    evt.preventDefault();
    const p = this.toCanvas(evt);
    const unit = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? 400 : 1;
    const dy = evt.deltaY * unit;
    const dx = evt.deltaX * unit;

    if (evt.shiftKey && !evt.ctrlKey) {
      this.h.onPan?.((dx || dy) * 0.6);
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      this.h.onPan?.(dx * 0.6);
      return;
    }
    this.h.onZoom?.(Math.exp(dy * 0.0016), p.x);
  };

  _dblclick = (evt) => {
    evt.preventDefault();
    const p = this.toCanvas(evt);
    this.h.onAddMarker?.(p.x, p.y);
  };

  _contextmenu = (evt) => {
    if (!this.h.onContext) return;
    evt.preventDefault();
    const p = this.toCanvas(evt);
    this.h.onContext(p.x, p.y, evt);
  };
}

/**
 * Zoom a frequency range by `factor` while holding the frequency under
 * `anchorX` still — the behaviour that makes wheel-zoom feel like a map.
 */
export function zoomRange(settings, factor, anchorFreq, nyquist, minSpanHz = 4) {
  const { minFreq, maxFreq, freqScale } = settings;
  const anchor = clamp(anchorFreq, minFreq, maxFreq);
  let lo;
  let hi;
  if (freqScale === 'log') {
    const la = Math.log10(Math.max(anchor, 1));
    lo = Math.pow(10, la + (Math.log10(Math.max(minFreq, 1)) - la) * factor);
    hi = Math.pow(10, la + (Math.log10(Math.max(maxFreq, 2)) - la) * factor);
  } else {
    lo = anchor + (minFreq - anchor) * factor;
    hi = anchor + (maxFreq - anchor) * factor;
  }
  lo = Math.max(1, lo);
  hi = Math.min(nyquist, hi);
  if (hi - lo < minSpanHz) return null;
  return { minFreq: round(lo), maxFreq: round(hi) };
}

/** Shift a range by a fraction of its span, stopping at the hard limits. */
export function panRange(settings, fraction, nyquist) {
  const { minFreq, maxFreq, freqScale } = settings;
  let lo;
  let hi;
  if (freqScale === 'log') {
    const span = Math.log10(Math.max(maxFreq, 2)) - Math.log10(Math.max(minFreq, 1));
    const shift = span * fraction;
    lo = Math.pow(10, Math.log10(Math.max(minFreq, 1)) + shift);
    hi = Math.pow(10, Math.log10(Math.max(maxFreq, 2)) + shift);
  } else {
    const shift = (maxFreq - minFreq) * fraction;
    lo = minFreq + shift;
    hi = maxFreq + shift;
  }
  if (lo < 1) {
    hi += 1 - lo;
    lo = 1;
  }
  if (hi > nyquist) {
    lo -= hi - nyquist;
    hi = nyquist;
  }
  if (lo < 1) lo = 1;
  return { minFreq: round(lo), maxFreq: round(Math.max(lo + 4, hi)) };
}

function round(f) {
  return f < 100 ? Number(f.toFixed(1)) : Math.round(f);
}
