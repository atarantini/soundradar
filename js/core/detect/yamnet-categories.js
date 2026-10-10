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
 */
export function yamnetCategory({
  id, label, description = '', classes, threshold = 0.3,
  minMs = 0, releaseMs = 1000, refractoryMs = 3000,
}) {
  const indices = [];
  for (const name of classes) {
    const i = INDEX.get(name);
    if (i === undefined) console.warn(`[detect] ${id}: YAMNet has no class named "${name}"`);
    else indices.push(i);
  }
  return Object.freeze({
    id, label, description, source: 'yamnet', classes, threshold, minMs, releaseMs, refractoryMs,
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

export const YAMNET_CATEGORIES = [
  yamnetCategory({
    id: 'bird',
    label: 'Bird',
    description: 'Song, calls, chirps; pigeons, crows, owls.',
    classes: [
      'Bird', 'Bird vocalization, bird call, bird song', 'Chirp, tweet', 'Squawk',
      'Pigeon, dove', 'Coo', 'Crow', 'Caw', 'Owl', 'Hoot',
    ],
  }),
  yamnetCategory({
    id: 'dog',
    label: 'Dog',
    description: 'Barking, howling, growling, whimpering.',
    classes: ['Dog', 'Bark', 'Yip', 'Howl', 'Bow-wow', 'Growling', 'Whimper (dog)'],
  }),
  yamnetCategory({
    id: 'siren',
    label: 'Siren',
    description: 'Police, ambulance, fire engine and civil-defence sirens.',
    classes: [
      'Siren', 'Civil defense siren', 'Police car (siren)', 'Ambulance (siren)',
      'Fire engine, fire truck (siren)', 'Emergency vehicle',
    ],
  }),
  yamnetCategory({
    id: 'insect',
    label: 'Insect / mosquito',
    description: 'Mosquitoes, flies, bees and wasps, and other insects.',
    classes: ['Insect', 'Mosquito', 'Fly, housefly', 'Bee, wasp, etc.'],
  }),
  yamnetCategory({
    id: 'traffic',
    label: 'Traffic',
    description: 'Cars, buses, trucks and motorcycles; passing traffic and horns.',
    classes: [
      'Vehicle', 'Motor vehicle (road)', 'Car', 'Car passing by', 'Traffic noise, roadway noise',
      'Bus', 'Truck', 'Motorcycle', 'Vehicle horn, car horn, honking',
    ],
  }),
  yamnetCategory({
    id: 'train',
    label: 'Train / rail',
    description: 'Trains, metro and trams, horns and squealing wheels.',
    classes: ['Train', 'Rail transport', 'Subway, metro, underground', 'Train horn', 'Train wheels squealing'],
  }),
  yamnetCategory({
    id: 'crash',
    label: 'Crash / smash',
    description: 'Smashing, shattering, breaking, bangs.',
    classes: ['Smash, crash', 'Shatter', 'Breaking', 'Bang'],
    threshold: 0.25,
    releaseMs: 500,
  }),
  yamnetCategory({
    id: 'door',
    label: 'Door',
    description: 'Doors opening, closing and slamming; knocks and doorbells.',
    classes: ['Door', 'Slam', 'Sliding door', 'Knock', 'Doorbell', 'Ding-dong', 'Cupboard open or close'],
    threshold: 0.25,
    releaseMs: 500,
  }),
];
