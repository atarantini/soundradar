// Sound categories recognised by the YAMNet model.
//
// A category is pure data: a label and the AudioSet classes that count as it.
// Its score is the highest score among those classes — YAMNet's outputs are
// independent sigmoids, not a softmax, so the max is the honest aggregate
// (summing would let ten weak guesses add up to a confident one).
//
// To recognise something new, add an entry here. The class names must match
// `yamnet-classes.js` exactly; a misspelt one is reported in the console when
// the app loads, and skipped.

import { YAMNET_CLASSES } from './yamnet-classes.js';

const INDEX = new Map(YAMNET_CLASSES.map((name, i) => [name, i]));

/**
 * @param {object} o
 * @param {string} o.id        stable key, saved in `settings.detectors`
 * @param {string} o.label
 * @param {string[]} o.classes AudioSet class names, as in yamnet-classes.js
 * @param {number} [o.threshold] default score that fires an event
 * @param {string} [o.group]     menu heading it is listed under
 */
export function yamnetCategory({
  id, label, description = '', group = '', classes, threshold = 0.3,
  minMs = 0, releaseMs = 1000, refractoryMs = 3000,
}) {
  const indices = [];
  for (const name of classes) {
    const i = INDEX.get(name);
    if (i === undefined) console.warn(`[detect] ${id}: YAMNet has no class named "${name}"`);
    else indices.push(i);
  }
  return Object.freeze({
    id, label, description, group, source: 'yamnet', classes, threshold, minMs, releaseMs, refractoryMs,
    /** @param {Float32Array} scores one YAMNet window, 521 values */
    score(scores) {
      let best = 0;
      let bestIndex = -1;
      for (const i of indices) {
        if (scores[i] > best) {
          best = scores[i];
          bestIndex = i;
        }
      }
      return { score: best, detail: bestIndex >= 0 ? YAMNET_CLASSES[bestIndex] : '' };
    },
  });
}

// Menu order. Thresholds and class lists were set against real recordings
// (see plan-detection.md): each category fires on its own clips and stays
// below its threshold on everything else in the test set.
export const YAMNET_CATEGORIES = [
  // ---- Animals
  yamnetCategory({
    id: 'bird',
    label: 'Bird',
    group: 'Animals',
    description: 'Song, calls, chirps; pigeons, crows, owls.',
    classes: [
      'Bird', 'Bird vocalization, bird call, bird song', 'Chirp, tweet', 'Squawk',
      'Pigeon, dove', 'Coo', 'Crow', 'Caw', 'Owl', 'Hoot',
    ],
  }),
  yamnetCategory({
    id: 'dog',
    label: 'Dog',
    group: 'Animals',
    description: 'Barking, howling, growling, whimpering.',
    classes: ['Dog', 'Bark', 'Yip', 'Howl', 'Bow-wow', 'Growling', 'Whimper (dog)'],
    // A crying baby reaches ~55% on YAMNet's own "Dog" class; barking, ~90%.
    threshold: 0.6,
  }),
  yamnetCategory({
    id: 'insect',
    label: 'Insect / mosquito',
    group: 'Animals',
    description: 'Mosquitoes, flies, bees and wasps, and other insects.',
    classes: ['Insect', 'Mosquito', 'Fly, housefly', 'Bee, wasp, etc.'],
  }),

  // ---- People. Detecting that someone is talking, never what they say:
  // nothing here transcribes or identifies anyone.
  yamnetCategory({
    id: 'speech',
    label: 'Speech',
    group: 'People',
    description: 'Talking, conversation, whispering, a crowd chattering.',
    classes: [
      'Speech', 'Child speech, kid speaking', 'Conversation', 'Narration, monologue',
      'Babbling', 'Whispering', 'Hubbub, speech noise, speech babble',
    ],
    // Broad on purpose, so it needs the most certainty; and talk comes in
    // sentences, so a pause is not the end of it.
    threshold: 0.6,
    releaseMs: 2500,
  }),
  yamnetCategory({
    id: 'shout',
    label: 'Shouting / screaming',
    group: 'People',
    description: 'Shouts, yells and screams — and groans, which carry most short screams.',
    classes: ['Shout', 'Bellow', 'Whoop', 'Yell', 'Children shouting', 'Screaming', 'Groan'],
    threshold: 0.25,
    releaseMs: 500,
  }),
  yamnetCategory({
    id: 'crying',
    label: 'Crying',
    group: 'People',
    description: 'A baby crying, sobbing, whimpering, wailing.',
    classes: ['Crying, sobbing', 'Baby cry, infant cry', 'Whimper', 'Wail, moan'],
    threshold: 0.4,
    releaseMs: 2000,
  }),
  yamnetCategory({
    id: 'laughter',
    label: 'Laughter',
    group: 'People',
    description: 'Laughing, giggling, chuckling — a baby\'s too.',
    classes: ['Laughter', 'Baby laughter', 'Giggle', 'Snicker', 'Belly laugh', 'Chuckle, chortle'],
    threshold: 0.35,
  }),

  // ---- Home
  yamnetCategory({
    id: 'door',
    label: 'Door',
    group: 'Home',
    description: 'Doors opening, closing and slamming; knocks and doorbells.',
    classes: ['Door', 'Slam', 'Sliding door', 'Knock', 'Doorbell', 'Ding-dong', 'Cupboard open or close'],
    threshold: 0.25,
    releaseMs: 500,
  }),
  yamnetCategory({
    // AudioSet has no class for a lock. A key turning in one is heard as keys
    // and mechanism; a heavy bolt thunk is heard as a door, so switch on Door
    // as well to catch both. Tick, Clicking and Camera also fire on locks but
    // would fire on every clock, keyboard and shutter, so they stay out.
    id: 'lock',
    label: 'Door lock / keys',
    group: 'Home',
    description: 'A key turning in a lock, a latch or bolt working, keys jangling.',
    classes: ['Keys jangling', 'Mechanisms', 'Ratchet, pawl'],
    threshold: 0.3,
    releaseMs: 500,
    refractoryMs: 2000,
  }),
  yamnetCategory({
    id: 'crash',
    label: 'Crash / smash',
    group: 'Home',
    description: 'Smashing, shattering, breaking, bangs.',
    classes: ['Smash, crash', 'Shatter', 'Breaking', 'Bang'],
    threshold: 0.25,
    releaseMs: 500,
  }),

  // ---- Street
  yamnetCategory({
    id: 'siren',
    label: 'Siren',
    group: 'Street',
    description: 'Police, ambulance, fire engine and civil-defence sirens.',
    classes: [
      'Siren', 'Civil defense siren', 'Police car (siren)', 'Ambulance (siren)',
      'Fire engine, fire truck (siren)', 'Emergency vehicle',
    ],
  }),
  yamnetCategory({
    id: 'traffic',
    label: 'Traffic',
    group: 'Street',
    description: 'Cars, buses, trucks and motorcycles; passing traffic and horns.',
    classes: [
      'Vehicle', 'Motor vehicle (road)', 'Car', 'Car passing by', 'Traffic noise, roadway noise',
      'Bus', 'Truck', 'Motorcycle', 'Vehicle horn, car horn, honking',
    ],
  }),
  yamnetCategory({
    id: 'train',
    label: 'Train / rail',
    group: 'Street',
    description: 'Trains, metro and trams, horns and squealing wheels.',
    classes: ['Train', 'Rail transport', 'Subway, metro, underground', 'Train horn', 'Train wheels squealing'],
  }),
];
