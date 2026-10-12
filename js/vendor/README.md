# Vendored: TensorFlow.js

`tf.fesm.min.js` is the flat ES-module build of
[`@tensorflow/tfjs`](https://github.com/tensorflow/tfjs) **4.22.0**, from
`https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.fesm.min.js`.
It is self-contained (no imports), so the YAMNet worker loads it with a plain
`import` — no bundler. Licence: Apache-2.0, stated in the file's header.

One change from upstream: the trailing `//# sourceMappingURL=` line was
removed, because the 15 MB source map is not vendored and the dangling
reference only produced 404s.

Loaded only by `js/core/detect/yamnet-worker.js`, and only once a YAMNet
category is switched on in the Detect menu.

# Vendored: mqtt.js

`mqtt.esm.js` is the browser ES-module build of [`mqtt`](https://github.com/mqttjs/MQTT.js)
**5.16.0** (`dist/mqtt.esm.js` in the npm package), self-contained, default export
with `connect()`. Licence: MIT, in `mqtt.LICENSE.md`. Loaded only by
`js/app.js` via a dynamic import, and only when `js/config.local.js` enables
MQTT publishing.
