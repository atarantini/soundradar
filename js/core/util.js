// Small shared helpers. No DOM assumptions beyond canvas sizing.

/**
 * Device pixel ratio, capped. Uncapped DPR on a 3x phone turns the waterfall
 * into a 3x-taller pixel buffer for no visible gain and a big compose cost.
 */
export function dpr() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

/** Size a canvas's backing store to its CSS box. Returns true if it changed. */
export function resizeCanvasToDisplaySize(canvas) {
  const ratio = dpr();
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * ratio));
  const h = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Human-readable frequency: `440 Hz`, `1.24 kHz`, `12.5 kHz`. */
export function formatFreq(freq, digits) {
  if (!Number.isFinite(freq)) return '—';
  if (freq >= 1000) {
    const khz = freq / 1000;
    const d = digits ?? (khz >= 10 ? 1 : 2);
    return `${khz.toFixed(d)} kHz`;
  }
  return `${freq >= 100 ? Math.round(freq) : freq.toFixed(freq < 10 ? 1 : 0)} Hz`;
}

/** Frequency with no unit suffix, for axis ticks where the unit is implied. */
export function formatFreqShort(freq) {
  if (freq >= 1000) {
    const khz = freq / 1000;
    return `${khz % 1 === 0 ? khz : khz.toFixed(1)}k`;
  }
  return String(Math.round(freq));
}

export function formatDb(db, digits = 1) {
  if (!Number.isFinite(db)) return '—';
  return `${db.toFixed(digits)} dB`;
}

/** Seconds → `12.4s` / `1:05`. Used for waterfall time ticks. */
export function formatAgo(seconds) {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Trailing-edge debounce, used for resize and persistence writes. */
export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Read a CSS custom property off :root as a trimmed string. */
export function cssVar(name, fallback = '') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** `#rrggbb` + alpha → `rgba(...)`. Accepts `#rgb` too. */
export function withAlpha(hex, alpha) {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return hex;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Trigger a client-side download of a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `soundradar-2026-08-14-153012` — stable, sortable export filenames. */
export function timestampSlug(prefix = 'soundradar') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
