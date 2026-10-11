// Every detector the app offers, in menu order.
//
// A detector definition is a plain object:
//
//   id           stable key, saved in `settings.detectors` — never rename one
//   label        what the menu, the log and the waterfall call it
//   description  one line for the menu
//   source       'spectrum' — scored from the analyser frame, every frame
//                'yamnet'   — scored from the YAMNet model's 521 classes
//   threshold    default score (0–1) that fires an event; the user can move it
//   group        category in GROUPS: its menu heading, and its on/off switch
//   minMs, releaseMs, refractoryMs   event timing, see trigger.js
//   create()     ('spectrum') → { update(frame) → { score, freq?, detail? }, reset() }
//   score(v)     ('yamnet')   → { score, detail? }
//
// Adding a sound is adding an entry: a rule module under rules/ for something
// with a recognisable spectral shape, or a `yamnetCategory` for anything the
// model already knows.

import sirenSweep from './rules/siren.js';
import mosquitoWhine from './rules/mosquito.js';
import { YAMNET_CATEGORIES } from './yamnet-categories.js';

/** How the report names a detector's `source`. */
export const SOURCE_LABELS = Object.freeze({ spectrum: 'Pattern rule', yamnet: 'YAMNet' });

/**
 * The categories the menu lists, in order. Each is switched on and off as a
 * whole from its heading. A detector with no `group` is listed last.
 */
export const GROUPS = Object.freeze([
  'Animals', 'People', 'Home', 'Street', 'Natural sounds', 'Environment and background',
]);

const rank = (d) => {
  const i = GROUPS.indexOf(d.group);
  return i < 0 ? GROUPS.length : i;
};

// Grouped by category, whatever the detector's source; within a category,
// classifier entries keep their order and pattern rules follow them.
export const DETECTORS = Object.freeze(
  [...YAMNET_CATEGORIES, mosquitoWhine, sirenSweep]
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map(({ d }) => d)
);

const BY_ID = new Map(DETECTORS.map((d) => [d.id, d]));
if (BY_ID.size !== DETECTORS.length) console.warn('[detect] duplicate detector ids in the catalog');

export function getDetector(id) {
  return BY_ID.get(id) || null;
}
