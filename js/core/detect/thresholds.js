// Which score counts as a detection, for each detector.
//
// Three sliders can say, from narrowest to widest: the detector's own, its
// category's, and the global one. The first that is set wins. The catalog's own
// `threshold` is the value a detector was calibrated at, not a fallback here.

export const DEFAULT_THRESHOLD = 0.8;
export const MIN_THRESHOLD = 0.05;
export const MAX_THRESHOLD = 0.95;

/** The key a detector's category is stored under (matches the menu's heading). */
export const groupOf = (def) => def.group || 'Other';

/**
 * @param {object} def  a catalog entry
 * @param {object} s    settings: `detectors`, `detectGroupThresholds`, `detectThreshold`
 */
export function resolveThreshold(def, s) {
  const own = s.detectors?.[def.id]?.threshold;
  if (Number.isFinite(own)) return own;
  const group = s.detectGroupThresholds?.[groupOf(def)];
  if (Number.isFinite(group)) return group;
  return Number.isFinite(s.detectThreshold) ? s.detectThreshold : DEFAULT_THRESHOLD;
}
