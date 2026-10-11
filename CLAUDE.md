# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SoundRadar is a browser-based, real-time audio analysis toolkit. Pure HTML/CSS/JS with ES modules, zero build step, runs entirely client-side on the Web Audio API. The tool is a Spectrum Analyzer: a live spectrum plot and a scrolling waterfall/spectrogram sharing one frequency axis, with user-placeable frequency markers, plus pluggable sound detectors (pattern rules and the YAMNet classifier) that log and label what they hear.

There is no `package.json`, no bundler, no test runner, and no linter — everything is hand-written vanilla JS loaded directly by the browser via `<script type="module">`. The one third-party runtime, TensorFlow.js, is vendored as a single flat ES module in `js/vendor/`, and the YAMNet weights it runs are committed under `models/yamnet/`.

## Running it

```bash
./web.sh [port]   # serves the app with PHP's built-in server (default port 8080) and opens it in a browser
```

Any static file server works too (`python3 -m http.server`, `npx serve`). The app just needs `index.html` served over HTTP, since `getUserMedia` requires a secure context — `localhost` counts. There is no build/compile step: edit files in `js/`/`css/` and reload.

There are no automated tests or lint configs in this repo.

## Layout

```
js/app.js             composition root — settings wiring + the render loop
js/core/              DOM-free analysis/rendering modules (reusable across interfaces)
js/core/sessions.js   named save states (settings + markers) and whole-store export/import
js/core/alarm.js      the marker alarm / "finder" tone, and the detection chime
js/core/detect/       sound detection: catalog, engine, trigger, log, rules/, YAMNet
js/core/capture.js    AudioWorklet tap streaming raw samples (+ capture-worklet.js)
js/core/resample.js   streaming any-rate → any-rate resampler (worker-safe)
js/core/features.js   Tier 0 spectral descriptors shared by the rules
js/ruler.js           the shared frequency ruler
js/markers-table.js   the marker report table
js/detect-menu.js     the Detect menu (toggles, meters, thresholds, model card)
js/detections-table.js the detection log report
js/theme.js           reads canvas colours out of the stylesheet
js/vendor/            TensorFlow.js 4.22.0, flat ESM build (Apache-2.0)
models/yamnet/        YAMNet TF.js graph model + class map (Apache-2.0)
```

The split matters: `js/core/*` deliberately knows nothing about this app's DOM. Renderers take a `theme` object and an explicit rect rather than reading CSS or element IDs, so a different interface can reuse them. Keep new reusable logic in `core/`, and keep DOM wiring in `app.js` or a view module.

## Architecture

### Shared audio pipeline (`js/core/audio.js`)

A single `AudioEngine` wraps one shared `AudioContext` + `AnalyserNode`. All views read frequency data from the same analyser via `getFrequencyData()` (a `Float32Array` of dB values from `getFloatFrequencyData`), so every view is guaranteed to agree on FFT size, sample rate, and range settings. It also owns device enumeration (`listDevices`), start/pause/resume/stop, `getLevels()` for the input VU meter, and `sampleRate`/`nyquist`/`binHz` getters. Mic failures are mapped to actionable messages via `START_ERRORS` rather than surfacing raw `DOMException` names.

`SPEC.md` frames this as intentional groundwork for future tools (dB meter, oscilloscope) that would tap the same shared context rather than opening their own.

Other consumers hang off the same source through **taps**: `addTap(node)` / `removeTap(node)` keep a set of nodes connected to the input, and `start()` re-connects them to each new source, so a device switch never silently cuts a consumer off. Two exist: `AnalyserTap`, a second analyser with fixed settings the display controls never touch (the detection rules read it), and `CaptureTap` (`js/core/capture.js`), an AudioWorklet that streams raw samples over a `MessagePort`. Views still read the main analyser; taps are for consumers whose numbers must not move when the user re-tunes the picture.

### Sessions (`js/core/sessions.js`)

`SessionStore` owns the roster of named save states and the `localStorage` keys
each one lives in. A session is **not** a snapshot taken on demand: it *is* the
storage that `Settings` and `MarkerStore` read and write, under
`soundradar.s.<id>.settings.v1` / `soundradar.s.<id>.markers.v1`. Switching
sessions calls `settings.useStorage(key)` and `markers.useStorage(key)`, which
reload in place and notify their listeners — so there is no "unsaved session"
state to reconcile, because saving a setting has already written into the
session it was made in.

Storage is `localStorage`, not IndexedDB, on purpose: everything else the app
saves already lives there, a session is a few kB of JSON, and both stores load
synchronously at boot — IndexedDB would make `Settings` and `MarkerStore` async
for no gain at this size. That trade flips if a session ever has to hold
recorded waterfall history.

The roster and the active id live in `soundradar.sessions.v1`. It is never
empty: a browser with nothing saved lands in `default`. That default is only
created when the roster is empty, so deleting it (once other sessions exist)
does not resurrect it, and the last remaining session cannot be deleted.

`exportAll()`/`importAll()` are the whole-store JSON backup behind the Session
menu. **Import always adds** — imported sessions get fresh ids and
de-duplicated names — so restoring a file can never overwrite what the reader
already has. The exported `theme` travels for the record but is deliberately
not applied on import.

### Settings (`js/core/settings.js`)

`Settings` owns `BASE_DEFAULTS`, validation, `localStorage` persistence (into the active session's key — see Sessions above), and a subscribe/notify list. Every mutation goes through `set(patch, tags)`, which re-runs `normalize()` and then notifies listeners with the tag set (`'range'`, `'level'`, `'analysis'`, `'palette'`, `'all'`) so a listener can skip work it doesn't care about. `normalize()` is the single guard that a min never exceeds a max and that a stale save can't inject junk; `setNyquist()` makes range clamping track the real input device.

**Add new settings to `BASE_DEFAULTS`**, not to an ad-hoc object — that is what keeps validation, persistence, and "Reset all settings" authoritative.

### Central render loop (`js/app.js`)

`app.js` is the composition root: it constructs the engine, settings, marker store, and views, wires every toolbar control, and drives one `requestAnimationFrame` loop that:
1. Pulls the latest `Float32Array` from `engine.getFrequencyData()`.
2. Draws the spectrum plate via `SpectrumView`.
3. Advances the waterfall (throttled internally against the selected history span, independent of the frame rate).
4. Redraws the transparent overlay canvases (crosshair, marker bands, zoom-select rectangle) on top of each plate.
5. Sounds any armed marker alarms whose band has crossed its trigger level, and feeds the spectrum-based detectors (or closes every open detection when capture is not live).
6. Redraws the ruler and updates the summary strip, input VU, and each marker's live level/trend in the report.

The readout in step 6 is throttled to 10 Hz, but a frame drawn only because
something changed (`needsIdleDraw`) forces it: that frame may be the last one
for a while, and stale numbers — or a stale "sounding" flag after a pause —
must not be left on screen.

Each plate is two stacked `<canvas>` elements: a base canvas the module owns, and a transparent `*Overlay` canvas that `app.js` redraws every frame for cheap, non-destructive UI without touching the underlying plot or history. Both plates reserve a `GUTTER_L` left gutter for axis labels.

`app.js` also migrates older storage keys on boot — the project was renamed twice (`soundrad.survey.*` → `soundrad.*` → `soundradar.*`) and then settings/markers moved inside sessions (`soundradar.settings.v1` → `soundradar.s.default.settings.v1`), and the table chains each step in order. Leave it in place, and append to it rather than editing existing rows if keys ever move again.

### Frequency/dB ↔ pixel mapping (`js/core/scale.js`)

All coordinate math is centralized here and is the one place that understands both linear and logarithmic frequency scales. `freqToX`/`xToFreq` convert between Hz and canvas X (respecting `settings.freqScale`), `dbToY`/`yToDb` map dB to canvas Y, `freqToBin`/`binToFreq` cross between Hz and FFT bin index, `bandPeakDb`/`bandPeak` find the peak across a bin range (used by markers), `findDominantPeak` + `refinePeakFreq` drive the amber loudest-peak mark on the spectrum plate (`drawPeakMark` in `app.js`) and "Mark harmonics", with sub-bin interpolation, `buildColumnBins`/`columnDb` precompute the per-pixel-column bin ranges the plots draw from, and `freqTicks`/`dbTicks` generate axis ticks.

Pixel-space functions take an explicit `x0`/`w` pair so callers can reserve a gutter without redoing the offset by hand. **Every module that draws or hit-tests frequency data goes through these functions — keep it that way when adding features.**

### Waterfall (`js/core/waterfall.js`)

History is stored as quantised dB in a ring buffer, *not* as canvas pixels. The picture is re-rendered from that buffer, so changing the colour map, dB window, frequency range, or window size repaints the same recording instead of discarding it. (An earlier version shifted pixels on the canvas, which made every one of those changes destructive.) `WATERFALL_STORE_RANGE` is the fixed dB range the buffer quantises into — it is independent of the user's display dB window.

### Spectrum (`js/core/spectrum.js`)

`SpectrumView` draws grid, trace, optional fill, peak-hold with dB/s decay, and phosphor persistence. Colours come from a passed-in `theme` object rather than being hard-coded.

### Markers (`js/core/markers.js` + `js/markers-table.js`)

`MarkerStore` is the DOM-free model: CRUD, colour assignment from a palette, rolling dB history for the trend sparkline, per-marker alarm state (`alarm`, `alarmDb`), and `localStorage` persistence (into the active session's key). Markers are stored as centre frequency + bandwidth in Hz (never pixel positions), so they stay put across FFT size, zoom, and window changes.

`MarkersTable` renders the report. Rows are built when the list changes and then **mutated in place**, so typing in a name field is never interrupted by a redraw — preserve that when editing it. Every cell carries its column's `col-*` class so the responsive rules can hide a column by name; don't reintroduce `nth-child` column rules, which silently break the moment a column is added. `js/ruler.js` renders the pins for the same markers, numbered to match the table rows.

### Marker alarm (`js/core/alarm.js`)

The "finder". `AlarmTone` beeps while an armed marker's band sits at or above
its trigger level, raising both pitch and repetition rate with the level, so a
source can be walked down by ear. It generates the tone on the engine's own
`AudioContext` (passed in as `getContext`), which means pausing capture
suspends the context and silences it for free, and no second context is ever
opened. `active` is the set of ids currently sounding — the report reads it to
light the bells. Two separate off switches, and they mean different things:
muting (`alarmMuted`) silences every alarm while leaving markers armed, while
"Disable all alarms" (`MarkerStore.disableAllAlarms()`) clears the `alarm` flag
on every marker in one notification. Beeps are one-shot oscillator + gain pairs, ramped rather than
gated, because a square edge on a sine clicks.

### Sound detection (`js/core/detect/`)

The modular part is the **catalog** (`catalog.js`): an array of plain detector definitions — `id`, `label`, `description`, `source`, default `threshold`, event timing (`minMs`, `releaseMs`, `refractoryMs`), and a `group` — one of `GROUPS` in `catalog.js` (Animals, People, Home, Street). `DETECTORS` is sorted by group whatever the source, and the Detect menu lists it that way: each group's heading is a checkbox that switches the whole group (checked / indeterminate / unchecked is derived from the detectors, never stored), and pattern rules carry an "instant" tag. A ▾ button folds a group (`settings.detectCollapsed`, per session; folding never changes what is on), and a folded heading takes the `is-active` highlight while one of its detectors is sounding. A detector only ever answers "how sure am I right now, 0–1", optionally with a frequency and a `detail` (the matching AudioSet class, or the siren style). Two sources:

- `'spectrum'` — a rule with `create() → { update(frame), reset() }`, fed one frame per animation frame from `AnalyserTap` at `SPECTRUM_INPUT` (FFT 4096, smoothing 0.5) — **not** the display analyser, so the user's FFT size and smoothing never change what the rules hear. Rules live in `rules/` and build on `features.js` (`bandProminence`, `levelNear`, `periodicity`, `RateTrack`, …). Animation frames are not a fixed hop, so rules put what they track onto a `RateTrack` grid before asking timing questions of it.
- `'yamnet'` — a `yamnetCategory({ id, label, classes })` in `yamnet-categories.js`: pure data, scored as the max over its AudioSet classes (YAMNet's outputs are independent sigmoids). Class names must match `yamnet-classes.js` exactly; a typo warns in the console at load.

**To recognise a new sound, add a catalog entry** — a `yamnetCategory` if YAMNet already knows it, a rule module if it has a recognisable spectral shape. Nothing else changes: the menu, log, waterfall labels, settings and alarm all follow the catalog.

`DetectionEngine` (`engine.js`) also listens to the log: a `'clear'` makes every event still in progress start a fresh record on its next score (Clear means "start the list over", not "stop listening"), while a `'remove'` of one record leaves its event dismissed until the sound ends. It owns everything that turns scores into records: one `Trigger` per detector (`trigger.js` — hold `minMs` to start, tolerate flicker above `0.8 × threshold`, release after `releaseMs`, then a refractory period, so one bark is one row), the `DetectionLog` entries (`log.js`, in memory, newest first, CSV export; `remove(id)` and `clear()` notify, and the app redraws the waterfall labels from that), live `scores` for the meters and the `active` set. `configure(settings.detectors)` is the only way detectors are switched; it sets `needsModel` / `needsSpectrum`.

`YamnetClassifier` (`yamnet.js`) owns the classifier: a module Worker (`yamnet-worker.js`) that imports the vendored TF.js, resamples the `CaptureTap` stream to 16 kHz (`resample.js`), and scores a 0.975 s window every 0.25 s (wider if inference is slow; silent windows are skipped). Audio goes worklet → worker over a transferred port and never touches the main thread. The worker is spawned only while a `'yamnet'` detector is on and terminated when none is, which frees the model. Scores are stamped at the window centre on the `performance.now()` clock, so `Waterfall.yForTime()` can put the label on the row it describes — rows carry timestamps, which keeps that right across pauses and background-tab gaps.

`ClipRecorder` (`clips.js`) is the opt-in exception to "audio is never kept" (`settings.detectClips`, off by default). It hangs a second `CaptureTap` off the engine into a rolling 20 s buffer on the main thread, addressed by sample count and anchored to the newest chunk's arrival time (a gap in arrivals — a pause — restarts the buffer rather than splicing across it). It follows the log: an `'add'` starts a clip at `t0 − 2 s`, which is cut at `t1 + 1 s` (or 12 s, whichever first) into a WAV blob URL; `'remove'`/`'clear'` revoke them. Clips are memory-only by design — never move them into storage. While a clip plays, `DetectionEngine.quietUntil` keeps the replay (which the microphone hears over speakers) from being logged.

Detector configuration is `settings.detectors` — `{ [id]: { on, alarm, threshold? } }`, validated in `normalize()` — so it is per session, travels in the JSON export and resets with "Reset all settings". A detector's threshold is resolved by `resolveThreshold()` (`detect/thresholds.js`): its own `threshold`, else its category's in `settings.detectGroupThresholds`, else the global `settings.detectThreshold` (default 0.8). The catalog's `threshold` is the calibrated value, not read at runtime. The Detect menu's global and per-category sliders overwrite the narrower ones when moved (`setGlobalThreshold`/`setGroupThreshold` in `app.js`). The log is deliberately not saved. A detector's bell plays `AlarmTone.chime()`; mute applies to it, and "Disable all alarms" clears detector bells as well as marker bells.

### Input handling (`js/core/input.js`)

`PlotInput` covers mouse, touch, and pen through pointer events on one path. The full gesture vocabulary: drag to pan, wheel/pinch to zoom around the pointer, shift-drag to select a range to zoom into, double click/tap or long press to plant a marker, drag a pin to move it. Callbacks receive canvas-pixel coordinates; frequency math stays in `scale.js`. `zoomRange`/`panRange` are the pure range transforms, shared with the keyboard and the on-screen zoom/pan pad.

### Color maps (`js/core/colormap.js`)

Seven waterfall palettes (`classic`, `viridis`, `inferno`, `magma`, `amber`, `ice`, `gray`). `buildLut()` bakes a gradient into a 256-entry lookup table once per change, because the waterfall colours a full screen of pixels per frame and per-pixel interpolation is too expensive. `colorFor`/`colorForCss`/`gradientCss` serve the non-bulk cases (marker meters, labels, CSS gradients) — all of them should stay visually consistent, since they represent the same dB range.

### Reference overlays and harmonics (`js/core/reference.js`, `js/core/harmonics.js`)

Fixed landmarks that help place what you're looking at: `drawHearingBand` dims outside `HUMAN_HEARING`, `mainsHarmonics` and `harmonics` generate a harmonic stack from a fundamental (behind the "Mark harmonics" action).

### Theming (`js/theme.js`, `css/style.css`)

Canvas colours are read out of CSS custom properties via `cssVar()` so a colour is never written twice, once in CSS and once in JS. Adding a canvas colour means adding a custom property and reading it in `readTheme()`.

## Conventions worth preserving

- New settings go in `BASE_DEFAULTS` in `js/core/settings.js` and are applied through `settings.set(patch, tags)`, so persistence and "Reset all settings" stay authoritative.
- Keep frequency/dB coordinate conversions in `js/core/scale.js` — don't duplicate log-scale or dB-mapping math in drawing code.
- Keep `js/core/*` free of DOM lookups and app-specific IDs; pass in a rect and a theme instead.
- The plates keep a guaranteed share of the screen (`--plates-min` in `css/style.css`); the reports below share the rest and scroll their rows. Anything new that stacks under the plates must shrink and scroll the same way rather than push them smaller.
- The UI is sized for tablet/touch (large hit targets, generous base font — see `css/style.css` `:root`), not a dense desktop panel; collapsible `<details>` toolbar menus keep secondary controls out of the way so the plates get primary screen space.
- Every interaction must work by touch as well as by mouse — that is why the zoom/pan pad exists alongside the wheel and arrow keys.
- Anything that must survive a reload belongs to a session, not to a new
  top-level `localStorage` key. The theme is the one deliberate exception: it is
  a property of the browser, not of a measurement.
- A new detectable sound is a catalog entry in `js/core/detect/`, never a special case in `app.js`. Detectors stay DOM-free, and recognition stays local: nothing may send audio, features or results off the device (`spec-recognition.md`).
- `js/core/detect/yamnet-classes.js` is generated from `models/yamnet/yamnet_class_map.csv` — regenerate it rather than editing it, or indices drift from the model.
- `SPEC.md`, `spec-spectrum-analyzer.md` and `spec-recognition.md` are the source of design intent (goals, planned tools, interaction details) — check them before making product/UX decisions, and update them if a change alters documented behaviour.
