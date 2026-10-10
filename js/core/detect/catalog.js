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

export const DETECTORS = Object.freeze([sirenSweep, mosquitoWhine, ...YAMNET_CATEGORIES]);

const BY_ID = new Map(DETECTORS.map((d) => [d.id, d]));
if (BY_ID.size !== DETECTORS.length) console.warn('[detect] duplicate detector ids in the catalog');

export function getDetector(id) {
  return BY_ID.get(id) || null;
}
