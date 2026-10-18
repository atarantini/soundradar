// Service worker: makes the app installable and usable offline.
//
// Everything is same-origin static files, so the whole app is cached on first
// visit. Bump VERSION whenever the file list below changes; code files are also
// refreshed in the background on every visit (stale-while-revalidate), so an
// ordinary edit shows up on the *next* load without touching this file.

const VERSION = 'v1';
const CORE_CACHE = `soundradar-core-${VERSION}`;
const MODEL_CACHE = 'soundradar-model-v1'; // survives code updates: ~16 MB, never changes

// Paths are relative to this file, so it works under /soundradar/ on GitHub Pages.
const CORE = [
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
  'js/vendor/tf.fesm.min.js',
];
// Large or rarely used: fetched after install so a slow link cannot fail it.
const LATER = [
  'models/yamnet/model.json',
  'models/yamnet/group1-shard1of4.bin', 'models/yamnet/group1-shard2of4.bin',
  'models/yamnet/group1-shard3of4.bin', 'models/yamnet/group1-shard4of4.bin',
  'js/vendor/mqtt.esm.js',
];

const isModel = (url) => url.pathname.includes('/models/');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE);
    await core.addAll(CORE);
    self.skipWaiting();
    // Not awaited: install completes now, the model keeps downloading.
    const fetchLater = async () => {
      for (const path of LATER) {
        const cache = await caches.open(path.startsWith('models/') ? MODEL_CACHE : CORE_CACHE);
        if (await cache.match(path)) continue;
        try { await cache.add(path); } catch { /* fetched on demand later */ }
      }
    };
    event.waitUntil(fetchLater());
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('soundradar-core-') && key !== CORE_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // MQTT and anything else off-site: untouched
  event.respondWith(respond(request, url));
});

async function respond(request, url) {
  const cache = await caches.open(isModel(url) ? MODEL_CACHE : CORE_CACHE);
  // Range requests and query strings aside, the cached copy is keyed by path.
  const hit = await cache.match(request, { ignoreSearch: true });

  // Model weights never change: cache first, network only to fill a gap.
  if (hit && isModel(url)) return hit;

  const refresh = fetch(request).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(request, res.clone());
    return res;
  });

  if (hit) {
    refresh.catch(() => {}); // revalidate quietly; offline is fine
    return hit;
  }
  try {
    return await refresh;
  } catch (err) {
    if (request.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    throw err; // e.g. the optional config.local.js while offline: the app already copes
  }
}
