// Service worker: makes the app installable and usable offline.
//
// Code is network-first: online, every load gets what is deployed, exactly as
// without a service worker, and keeps a copy; offline, the copy is served.
// Once a page has loaded it asks for a 'sync', which re-fetches every cached
// file — so modules loaded only later (the YAMNet worker and TF.js) stay in
// step with the page that will load them — and then fills in the YAMNet model.
// The model (~16 MB) is never part of the install: a slow link must not hold
// the install up, or fail it, for the sake of a feature that is optional.

const CODE_CACHE = 'soundradar-code';
const MODEL_CACHE = 'soundradar-model-v1'; // the weights never change

// Precached so the app works offline even before a feature has been used once.
// Paths are relative to this file, so it works under /soundradar/ on GitHub
// Pages. A file left out is still cached the first time it loads online.
const CODE = [
  './', 'index.html', 'manifest.webmanifest', 'favicon.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'css/style.css',
  'js/app.js', 'js/config.js', 'js/theme.js', 'js/ruler.js', 'js/markers-table.js',
  'js/detect-menu.js', 'js/recordings.js', 'js/teach-card.js', 'js/detections-table.js',
  'js/core/alarm.js', 'js/core/audio.js', 'js/core/capture-worklet.js', 'js/core/capture.js',
  'js/core/colormap.js', 'js/core/features.js', 'js/core/harmonics.js', 'js/core/input.js',
  'js/core/markers.js', 'js/core/publish.js', 'js/core/recorder.js', 'js/core/reference.js',
  'js/core/resample.js', 'js/core/scale.js', 'js/core/sessions.js', 'js/core/settings.js',
  'js/core/spectrum.js', 'js/core/util.js', 'js/core/waterfall.js',
  'js/core/detect/catalog.js', 'js/core/detect/clips.js', 'js/core/detect/engine.js',
  'js/core/detect/evidence.js', 'js/core/detect/learned.js', 'js/core/detect/log.js',
  'js/core/detect/sound-file.js', 'js/core/detect/sounds.js', 'js/core/detect/teach.js',
  'js/core/detect/thresholds.js', 'js/core/detect/trigger.js',
  'js/core/detect/yamnet-categories.js', 'js/core/detect/yamnet-centre.js',
  'js/core/detect/yamnet-classes.js', 'js/core/detect/yamnet-worker.js', 'js/core/detect/yamnet.js',
  'js/core/detect/rules/mosquito.js', 'js/core/detect/rules/siren.js',
  'js/vendor/tf.fesm.min.js', 'js/vendor/mqtt.esm.js',
];
const MODEL = [
  'models/yamnet/model.json',
  'models/yamnet/group1-shard1of4.bin', 'models/yamnet/group1-shard2of4.bin',
  'models/yamnet/group1-shard3of4.bin', 'models/yamnet/group1-shard4of4.bin',
];

const isModel = (url) => url.pathname.includes('/models/');
// One entry per file, whatever query string a request carried.
const keyOf = (url) => { const u = new URL(url, location); u.search = ''; u.hash = ''; return u.href; };

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CODE_CACHE);
    // One file failing (renamed, say) must not cost the whole install.
    await Promise.allSettled(CODE.map((path) => cache.add(path)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only our own: every project page on <user>.github.io shares this origin,
    // and so its Cache Storage.
    for (const key of await caches.keys()) {
      if (key.startsWith('soundradar-') && key !== CODE_CACHE && key !== MODEL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return; // MQTT etc.: untouched
  event.respondWith(isModel(url) ? cacheFirst(event) : networkFirst(event));
});

async function cacheFirst(event) {
  const cache = await caches.open(MODEL_CACHE);
  const key = keyOf(event.request.url);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.ok) event.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(CODE_CACHE);
  const key = keyOf(request.url);
  try {
    const res = await fetch(request);
    if (res.ok) event.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (err) {
    const hit = await cache.match(key)
      ?? (request.mode === 'navigate' ? await cache.match(keyOf('./')) : undefined);
    if (hit) return hit;
    throw err; // e.g. the optional config.local.js offline: the app already copes
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'sync') event.waitUntil(sync(event.data));
});

async function sync({ model }) {
  const code = await caches.open(CODE_CACHE);
  const keys = new Set([...CODE.map(keyOf), ...(await code.keys()).map((r) => r.url)]);
  await Promise.allSettled([...keys].map(async (key) => {
    const res = await fetch(key); // offline: throws, and the copy stays
    if (res.ok) await code.put(key, res);
    else if (res.status === 404) await code.delete(key); // gone from the deployment
  }));

  if (!model) return;
  const cache = await caches.open(MODEL_CACHE);
  for (const path of MODEL) {
    const key = keyOf(path);
    if (await cache.match(key)) continue;
    try { await cache.add(key); } catch { return; } // offline or cut short: next visit resumes
  }
}
