// Harmonic series helpers. A single tonal source — a motor, a fan, mains hum —
// almost always shows up as a stack of evenly spaced peaks, so being able to
// generate that stack from a fundamental is the fastest way to confirm one.

/**
 * Harmonic series of a fundamental, up to `maxFreq`. Used by the "mark
 * harmonics" action.
 */
export function harmonics(fundamental, maxFreq, count = 8) {
  const out = [];
  for (let n = 2; n <= count + 1; n++) {
    const f = fundamental * n;
    if (f > maxFreq) break;
    out.push({ n, freq: f });
  }
  return out;
}
