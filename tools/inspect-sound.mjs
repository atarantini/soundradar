// Reports on a learned sound exported from SoundRadar (Edit → Export), and can
// write an improved copy to import back.
//
// The file holds YAMNet embeddings, not audio, so nothing has to be run through
// the model: YAMNet's own last layer (read from the vendored weights) says what
// each window sounds like, and the matching is the app's — centred cosine
// similarity to the nearest stored window (js/core/detect/learned.js).
//
// It looks at three things:
//   - the stored windows: their level, what YAMNet hears in them, and which
//     look like the room rather than the sound (quiet, or heard as ambience);
//   - the evidence, when the file has any: what the sound scored at or above
//     its release level during the visit it was exported from — what held its
//     events open — and which stored windows those windows matched;
//   - its detections: how long they lasted.
//
// Usage (from the repository root, Node 20+):
//   node tools/inspect-sound.mjs sound.json
//   node tools/inspect-sound.mjs sound.json --drop 1.4,1.5,2.1    what if these windows went
//   node tools/inspect-sound.mjs sound.json --clean out.json      write a copy without the
//                                                                 background-like windows
//                                                                 (plus any --drop), to import
// Windows are numbered example.window, from 1, as the report prints them.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { decodeVec, MAX_WINDOWS } = await import(join(ROOT, 'js/core/detect/learned.js'));
const { LEVEL_SPREAD_DB } = await import(join(ROOT, 'js/core/detect/teach.js'));
const { YAMNET_CLASSES } = await import(join(ROOT, 'js/core/detect/yamnet-classes.js'));
const { YAMNET_CENTRE } = await import(join(ROOT, 'js/core/detect/yamnet-centre.js'));

// ---- arguments
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const cleanTo = opt('--clean');
const dropArg = opt('--drop');
const path = args[0];
if (!path) {
  console.error('usage: node tools/inspect-sound.mjs sound.json [--drop 1.4,2.1] [--clean out.json]');
  process.exit(1);
}
const file = JSON.parse(readFileSync(path, 'utf8'));
if (file.kind !== 'soundradar-sound' || !file.sound) {
  console.error(`${path}: not a sound exported from SoundRadar (Edit → Export).`);
  process.exit(1);
}

// ---- YAMNet's last layer: logits = embedding · W + b, scores = sigmoid(logits)
const manifest = JSON.parse(readFileSync(join(ROOT, 'models/yamnet/model.json'), 'utf8'));
const shards = Buffer.concat(manifest.weightsManifest[0].paths.map((p) => readFileSync(join(ROOT, 'models/yamnet', p))));
const BYTES = { float32: 4, int32: 4, uint8: 1, uint16: 2, int8: 1, bool: 1 };
let W = null;
let B = null;
for (let off = 0, k = 0, ws = manifest.weightsManifest[0].weights; k < ws.length; k++) {
  const w = ws[k];
  const n = w.shape.reduce((a, b) => a * b, 1);
  const size = n * BYTES[w.quantization ? w.quantization.dtype : w.dtype];
  const take = () => new Float32Array(shards.buffer.slice(shards.byteOffset + off, shards.byteOffset + off + size));
  if (w.dtype === 'float32' && !w.quantization && w.shape.join() === '1024,521') W = take();
  if (w.dtype === 'float32' && !w.quantization && w.shape.join() === '521' && W && !B) B = take();
  off += size;
}
if (!W || !B) throw new Error('could not find YAMNet’s output layer in models/yamnet');

function classes(v, k = 3) {
  const z = Float64Array.from(B);
  for (let i = 0; i < 1024; i++) {
    const x = v[i];
    if (!x) continue;
    for (let j = 0, row = i * 521; j < 521; j++) z[j] += x * W[row + j];
  }
  return Array.from(z, (l, j) => [1 / (1 + Math.exp(-l)), j])
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(([p, j]) => ({ name: YAMNET_CLASSES[j], p }));
}

// The room, not a sound: what YAMNet calls ambience. Hums, fans and air
// conditioning are left out on purpose — those can be the very thing taught.
const AMBIENCE_UNDER_DB = 6;
const AMBIENCE = new Set([
  'Silence', 'Inside, small room', 'Inside, large room or hall', 'Inside, public space',
  'Outside, urban or manmade', 'Outside, rural or natural', 'Reverberation', 'Echo', 'Noise',
  'Environmental noise', 'Static', 'White noise', 'Pink noise',
]);

const centred = (v) => {
  const o = new Float32Array(1024);
  let s = 0;
  for (let i = 0; i < 1024; i++) {
    o[i] = v[i] - YAMNET_CENTRE[i];
    s += o[i] * o[i];
  }
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < 1024; i++) o[i] /= s;
  return o;
};
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < 1024; i++) s += a[i] * b[i];
  return s;
};
const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const db1 = (x) => (Number.isFinite(x) ? `${x.toFixed(0)} dBFS` : '–');
const top1 = (c) => `${c[0].name} ${Math.round(c[0].p * 100)}%`;

// ---- the stored windows
const sound = file.sound;
const stored = [];
sound.examples.forEach((ex, e) => {
  ex.vecs.forEach((text, i) => {
    const vec = decodeVec(text);
    if (!vec) return;
    const db = Array.isArray(ex.dbs) && Number.isFinite(ex.dbs[i]) ? ex.dbs[i] : null;
    stored.push({ key: `${e + 1}.${i + 1}`, e, i, vec, c: centred(vec), db, cls: classes(vec) });
  });
});
const loudest = Math.max(...stored.map((w) => (w.db == null ? -Infinity : w.db)));
const hasLevels = Number.isFinite(loudest);
const centroid = centred(stored.reduce((m, w) => m.map((x, i) => x + w.c[i]), new Float32Array(1024)));
for (const w of stored) {
  w.flags = [];
  if (hasLevels && w.db != null && w.db < loudest - LEVEL_SPREAD_DB) w.flags.push(`quiet (${Math.round(loudest - w.db)} dB under the loudest)`);
  // Ambience only counts against a window that is also quieter than the sound:
  // the loudest windows are the sound, heard in its room.
  if (AMBIENCE.has(w.cls[0].name) && (!hasLevels || w.db == null || w.db < loudest - AMBIENCE_UNDER_DB)) w.flags.push(`heard as ${w.cls[0].name}`);
  w.likeRest = dot(w.c, centroid);
  if (w.likeRest < 0.5) w.flags.push(`unlike the rest (${f2(w.likeRest)})`);
}

// ---- report: the sound
const set = file.settings || {};
const seconds = sound.examples.reduce((t, ex) => t + (Number.isFinite(ex.s) ? ex.s : ex.vecs.length * 0.25), 0);
console.log(`“${sound.label}” — ${sound.examples.length} example(s), ${stored.length} windows, ~${seconds.toFixed(1)} s of sound`);
console.log(`threshold ${f2(set.threshold)}${set.ownThreshold != null ? ' (its own)' : ' (from the category or global slider)'}, release ${f2(set.releaseLevel)}: an event ends once the score stays under the release for 1 s`);
if (!hasLevels) console.log('levels: not in this file (taught before levels were stored); quiet windows can only be guessed from what YAMNet hears');
console.log('');
console.log('What it was taught from (window: level · what YAMNet hears · flags):');
sound.examples.forEach((ex, e) => {
  const ws = stored.filter((w) => w.e === e);
  const kinds = new Map();
  for (const w of ws) kinds.set(w.cls[0].name, (kinds.get(w.cls[0].name) || 0) + 1);
  const summary = [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, k]) => `${n} ×${k}`).join(', ');
  console.log(`  example ${e + 1}: ${ws.length} windows${ex.at ? `, ${ex.at.slice(0, 16).replace('T', ' ')}` : ''} — mostly ${summary}`);
  for (const w of ws) {
    if (!w.flags.length && ws.length > 12) continue; // long examples: only the windows worth a look
    console.log(`    ${w.key.padEnd(6)} ${db1(w.db).padStart(9)} · ${w.cls.map((c) => `${c.name} ${Math.round(c.p * 100)}%`).join(', ')}${w.flags.length ? '  ← ' + w.flags.join('; ') : ''}`);
  }
});
const suspects = stored.filter((w) => w.flags.some((f) => f.startsWith('quiet') || f.startsWith('heard as')));
console.log('');

// ---- report: the evidence
const ev = file.evidence;
const matched = (ev?.matched || []).map((m) => ({ ...m, vec: decodeVec(m.vec) })).filter((m) => m.vec);
const other = (ev?.other || []).map((m) => ({ ...m, vec: decodeVec(m.vec) })).filter((m) => m.vec);
for (const m of [...matched, ...other]) {
  m.c = centred(m.vec);
  let best = -2;
  for (const w of stored) {
    const s = dot(w.c, m.c);
    if (s > best) {
      best = s;
      m.nearest = w;
    }
  }
  m.again = best;
}
for (const m of matched) m.cls = classes(m.vec);
if (!ev) {
  console.log('No evidence in this file: export it during the visit in which it misbehaved (with the sound on),');
  console.log('and the file also says what it was matching.');
} else {
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  console.log(`What it matched in the ${Math.round(Math.max(0, ...matched.map((m) => m.ago), ...other.map((m) => m.ago)))} s before export: ${n(matched.length, 'window')} at or above the release level, ${other.length} sampled below it`);
  if (matched.length) {
    const drift = Math.max(...matched.map((m) => Math.abs(m.again - m.score)));
    if (drift > 0.02) console.log(`  (scores recomputed here differ from the app's by up to ${f2(drift)}: the file may come from another version)`);
    const kinds = new Map();
    for (const m of matched) kinds.set(m.cls[0].name, (kinds.get(m.cls[0].name) || 0) + 1);
    console.log(`  YAMNet hears them as: ${[...kinds].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, k]) => `${n} ×${k}`).join(', ')}`);
    const levels = matched.map((m) => m.db);
    console.log(`  their level: median ${db1(pct(levels, 0.5))} (${db1(pct(levels, 0.1))} – ${db1(pct(levels, 0.9))})${hasLevels ? `; the sound was taught at up to ${db1(loudest)}` : ''}`);
    console.log(`  their score: median ${f2(pct(matched.map((m) => m.score), 0.5))}, highest ${f2(Math.max(...matched.map((m) => m.score)))}`);
    const by = new Map();
    for (const m of matched) by.set(m.nearest, (by.get(m.nearest) || 0) + 1);
    console.log('  the stored windows they matched most:');
    for (const [w, k] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    ${w.key.padEnd(6)} ${String(k).padStart(4)} (${Math.round((100 * k) / matched.length)}%)  ${db1(w.db)} · ${top1(w.cls)}${w.flags.length ? '  ← ' + w.flags.join('; ') : ''}`);
    }
  }
  if (other.length) console.log(`  the rest scored: median ${f2(pct(other.map((m) => m.score), 0.5))}, 90th percentile ${f2(pct(other.map((m) => m.score), 0.9))}`);
}
const dets = file.detections || [];
if (dets.length) {
  const total = dets.reduce((t, d) => t + d.seconds, 0);
  const longest = Math.max(...dets.map((d) => d.seconds));
  console.log(`Detections this visit: ${dets.length}, ${total.toFixed(0)} s in all, the longest ${longest.toFixed(0)} s`);
}
console.log('');

// ---- what if some windows went
const dropKeys = new Set((dropArg || '').split(',').map((s) => s.trim()).filter(Boolean));
const unknown = [...dropKeys].filter((k) => !stored.some((w) => w.key === k));
if (unknown.length) console.log(`(no such window: ${unknown.join(', ')})`);
const dropping = cleanTo ? new Set([...suspects.map((w) => w.key), ...dropKeys]) : dropKeys;
const keep = stored.filter((w) => !dropping.has(w.key));

function whatIf(label, kept) {
  if (!matched.length || !kept.length) return;
  const rescore = (m) => Math.max(...kept.map((w) => dot(w.c, m.c)));
  const r = matched.map(rescore);
  const release = Number(set.releaseLevel);
  const still = r.filter((s) => s >= release).length;
  const fire = r.filter((s) => s >= Number(set.threshold)).length;
  console.log(`${label}: of the ${matched.length} matched windows, ${still} would still hold an event open (≥ ${f2(release)}) and ${fire} would still start one (≥ ${f2(set.threshold)}); median score ${f2(pct(r, 0.5))}`);
}

console.log('Suggestions:');
let said = 0;
const say = (s) => {
  said++;
  console.log(`  - ${s}`);
};
if (suspects.length) {
  const share = matched.length ? matched.filter((m) => suspects.includes(m.nearest)).length / matched.length : NaN;
  say(`${suspects.length} of the ${stored.length} stored windows look like the room, not the sound (${suspects.map((w) => w.key).join(', ')})` +
    (Number.isFinite(share) ? `; they were the closest match for ${Math.round(share * 100)}% of what it matched.` : '.') +
    ' Write a copy without them with --clean and import it (then delete the old one).');
  whatIf('    without them', stored.filter((w) => !suspects.includes(w)));
}
if (matched.length && hasLevels) {
  const quietShare = matched.filter((m) => m.db < loudest - LEVEL_SPREAD_DB).length / matched.length;
  if (quietShare > 0.5) say(`${Math.round(quietShare * 100)}% of what it matched was more than ${LEVEL_SPREAD_DB} dB quieter than the sound was taught at — it is matching the room. If the room itself is loud, record an example with the sound closer, or louder.`);
}
// What would let a long event end: the room's scores (matched windows quieter
// than the sound, so not the sound) against the sound as it would be after the
// suggested clean-up, and the threshold whose release (× 0.8) clears them.
const RELEASE_RATIO = 0.8;
if (dets.some((d) => d.seconds > 30)) {
  const longest = Math.max(...dets.map((d) => d.seconds)).toFixed(0);
  const kept = stored.filter((w) => !suspects.includes(w));
  const room = hasLevels ? matched.filter((m) => m.db < loudest - LEVEL_SPREAD_DB) : [];
  if (room.length >= 5 && kept.length) {
    const roomScore = pct(room.map((m) => Math.max(...kept.map((w) => dot(w.c, m.c)))), 0.9);
    const needed = Math.ceil((roomScore / RELEASE_RATIO) * 20) / 20; // the slider's 0.05 steps
    say(needed <= 0.95
      ? `A detection lasted ${longest} s: the room kept the score above the release level (${f2(set.releaseLevel)}). After the clean-up the room still scores up to ${f2(roomScore)}; a threshold of ${f2(needed)} on this sound (release ${f2(needed * RELEASE_RATIO)}) would let events end. Check it still fires on the sound itself.`
      : `A detection lasted ${longest} s: the room kept the score above the release level (${f2(set.releaseLevel)}). Even after the clean-up the room scores up to ${f2(roomScore)} against the sound, which no threshold can clear: to SoundRadar this sound is too much like the room it was recorded in. Record it louder or closer, away from what hums or rings in the room.`);
  } else {
    say(`A detection lasted ${longest} s: the score never stayed under ${f2(set.releaseLevel)} for a second. Export it again while that is happening, so the file shows what held it open.`);
  }
}
if (seconds < 5) say(`It was taught from ${seconds.toFixed(1)} s of sound. Two or three more examples, in different conditions, make it steadier.`);
if (stored.length >= MAX_WINDOWS - 10) say('It is close to the 160-window limit: remove weak examples before adding new ones.');
if (!said) say('Nothing stands out. If it fires on something it should not, export it while that is happening, so the file holds what it matched.');
if (dropKeys.size && !cleanTo) {
  console.log('');
  whatIf(`Without ${[...dropKeys].join(', ')}`, keep);
}

// ---- the cleaned copy
if (cleanTo) {
  const examples = sound.examples
    .map((ex, e) => {
      const idx = ex.vecs.map((_, i) => i).filter((i) => !dropping.has(`${e + 1}.${i + 1}`));
      if (!idx.length) return null;
      const out = { at: ex.at, vecs: idx.map((i) => ex.vecs[i]) };
      if (Number.isFinite(ex.s)) out.s = Math.round(((ex.s * idx.length) / ex.vecs.length) * 100) / 100;
      if (Array.isArray(ex.dbs)) out.dbs = idx.map((i) => ex.dbs[i]);
      return out;
    })
    .filter(Boolean);
  if (!examples.length) {
    console.error('\nNothing would be left: not writing a copy.');
    process.exit(1);
  }
  const copy = {
    ...file,
    exportedAt: new Date().toISOString(),
    note: `${file.note || ''} Cleaned by tools/inspect-sound.mjs: ${dropping.size} window(s) removed.`.trim(),
    sound: { ...sound, label: `${sound.label} (cleaned)`.slice(0, 40), examples },
    detections: [],
    evidence: null,
  };
  writeFileSync(cleanTo, JSON.stringify(copy, null, 1));
  console.log('');
  whatIf(`The copy (${keep.length} windows)`, keep);
  console.log(`Wrote ${cleanTo}: ${dropping.size} window(s) removed. Import it from My sounds → Import…, try it, then delete the old one.`);
}
