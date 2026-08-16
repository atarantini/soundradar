// Reference overlays: fixed frequency landmarks that help place what you're
// looking at without measuring it.

import { freqToX } from './scale.js';

export const HUMAN_HEARING = { min: 20, max: 20000 };

/**
 * Shade the audible band and dim what falls outside it. A 12 kHz whine being
 * inside the band and a 30 Hz rumble being at its very edge is context you
 * otherwise have to work out from the axis.
 */
export function drawHearingBand(ctx, rect, settings, theme) {
  if (!settings.showHearingBand) return;
  const { x, y, w, h } = rect;
  const loX = freqToX(HUMAN_HEARING.min, settings, w, x);
  const hiX = freqToX(HUMAN_HEARING.max, settings, w, x);

  ctx.save();
  ctx.fillStyle = theme.outsideHearing;
  if (loX > x) ctx.fillRect(x, y, Math.min(loX, x + w) - x, h);
  if (hiX < x + w) ctx.fillRect(Math.max(hiX, x), y, x + w - Math.max(hiX, x), h);
  ctx.restore();
}

/**
 * Mains hum and its harmonics. Buzz hunting is mostly ruling this in or out, so
 * the fundamental and the first few multiples are worth being able to see.
 */
export function mainsHarmonics(baseHz, maxFreq, count = 8) {
  const out = [];
  for (let n = 1; n <= count; n++) {
    const f = baseHz * n;
    if (f > maxFreq) break;
    out.push({ n, freq: f });
  }
  return out;
}
