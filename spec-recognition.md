# Signal Recognition — Spec

Second tool family in SoundRadar. Turns the analyzer from *"show me what is
there"* into *"tell me when **that** comes back"*.

Everything here runs client-side, on the same shared `AudioContext` as the
spectrum analyzer. Nothing is uploaded. That is the point: Shazam, Merlin and
every phone assistant answer the same questions by shipping your microphone to
a server, and a tool used to survey a factory floor, a neighbour's heat pump or
a nest box cannot do that.

## The four questions

Recognition is not one feature. It is four, in increasing order of cost, and
the spec keeps them separate because each is useful without the ones after it:

1. **What kind of sound is this?** — tonal or broadband, harmonic or not,
   steady or pulsing, how fast is it pulsing. Cheap descriptors over data the
   app already computes. *No training, no models, always on.*
2. **Is *this specific thing* here again?** — the user records a patch of
   spectrogram and the app watches for it. *Trained by the user, in two
   gestures, from data already in the waterfall ring.*
3. **Is this a known coded signal?** — a siren, a smoke alarm's T-3 pattern, a
   reversing beeper, DTMF, Morse, a CTCSS tone. *Rule-based decoders, no
   training, no models.*
4. **What is it called?** — "dog bark", "chainsaw", "Turdus merula". *Requires
   a pretrained neural network, i.e. a downloaded model.*

Questions 1–3 preserve the project's zero-install promise completely. Question
4 does not, and is therefore an explicit, per-model, opt-in download.

## Principles

- **Local-only.** No recognition feature may send audio, features, or
  embeddings off the device. A feature that cannot be done locally is not
  done.
- **The marker is the anchor.** A marker already says *where in frequency* to
  look and already owns an alarm that says *what to do when the level rises*.
  Recognition slots in between: the marker gains a *what to look for*, and a
  match drives the alarm that is already there.
- **Weight is opt-in and visible.** The base app stays a few hundred kB of
  hand-written JS. A model runtime and its weights are downloaded on request,
  cached, and shown with their size and licence before the download starts.
- **No build step.** Any third-party runtime arrives as a vendored ES module
  under `js/vendor/`, imported directly by the browser. If a candidate
  library only ships a CommonJS/bundler-only build, it is not a candidate.
- **Detections are data.** Every match is a timestamped record with a
  confidence, exportable as CSV/JSON next to the marker report — not just a
  transient beep.

---

## Audio plumbing

This is the first thing that has to change, and it is not optional for
anything past Tier 0.

### Why the existing analyser is not enough

`app.js` reads `engine.getFrequencyData()` once per animation frame. That is
correct for drawing and wrong for recognition, for three separate reasons:

- **The hop is not fixed.** `requestAnimationFrame` fires at display rate,
  drifts, and stops entirely in a backgrounded tab. Every recognizer past
  simple descriptors assumes a constant hop (10 ms for MFCC, 21.5 ms for
  BirdNET-style mel frames). Frames that arrive whenever the compositor feels
  like it cannot be fed to a time-warping matcher or a convnet.
- **`smoothingTimeConstant` is applied.** The analyser exponentially averages
  successive FFTs. That is a display nicety and a recognition bug: it smears
  onsets, which is precisely the information a transient-based matcher wants.
- **Windowing and scaling are fixed.** `AnalyserNode` applies a Blackman
  window and hands back dBFS. Mel filterbanks and cross-correlation want a
  Hann window, linear magnitude, and a hop the caller chooses.

### The capture tap

Add `js/core/capture.js`: an `AudioWorkletNode` on the same graph, downstream
of the same source node as the analyser, writing raw `Float32` samples into a
ring buffer.

- The worklet's `process()` copies its 128-sample quantum into a
  `SharedArrayBuffer` ring if cross-origin isolation is available, and falls
  back to `postMessage` with transferable `ArrayBuffer`s if not.
  **`SharedArrayBuffer` must stay optional** — requiring COOP/COEP headers
  would break `python3 -m http.server` and with it the "open it and go"
  promise. The fallback costs a copy per quantum, which is nothing.
- A consumer pulls fixed-size, fixed-hop frames out of the ring. Frame size
  and hop are per-recognizer, not global.
- Pausing capture suspends the context, which stalls the worklet, which is the
  correct behaviour for free — the same trick `alarm.js` already relies on.

### Resampling

`AudioContext.sampleRate` is whatever the device gives (usually 48 kHz,
sometimes 44.1). Pretrained models want a specific rate — 16 kHz for
YAMNet-class models, 48 kHz for BirdNET-class ones. Put a polyphase resampler
in `js/core/resample.js` rather than round-tripping through
`OfflineAudioContext`, which is async, allocation-heavy, and awkward to drive
at a steady hop.

### Where the work happens

One `Worker` per active recognizer, never the main thread. The render loop's
budget is already spent on two canvases; a mel spectrogram plus a forward pass
is not going into it. The worker receives frames and posts back detections.
Tier 0 descriptors are the exception — they are a handful of sums over a bin
array and belong inline.

---

## Tier 0 — Descriptors (no training, no models, always on)

Cheap scalars computed per frame from the FFT data the app already has, shown
per marker in the report and, where it makes sense, for the full band. These
are worth shipping first because they are ~150 lines total and they answer the
question people actually ask a spectrum analyzer: *what kind of thing is
this?*

Goes in `js/core/features.js`, DOM-free, taking a bin array and a bin range —
same shape as `bandPeakDb` in `scale.js`.

| Descriptor | Tells you | Cost |
|---|---|---|
| **Spectral flatness** (Wiener entropy, geometric ÷ arithmetic mean) | Tonal (whine, hum, tone) vs. broadband (hiss, wind, rain, fan noise). The single most useful number here. | O(bins) |
| **Spectral crest** (peak ÷ mean) | Same axis, cheaper, less robust. Good for a live meter. | O(bins) |
| **Spectral centroid / spread / rolloff** | "Brightness" and bandwidth — separates a hiss from a rumble numerically. | O(bins) |
| **Spectral flux** (positive change vs. previous frame) | Onsets. Fires on transients, ignores steady tones. The gate for every event-driven recognizer below. | O(bins) |
| **Harmonic product spectrum** | Is there a fundamental with a harmonic stack, and at what f0. Motors, engines, transformers, mains hum. Pairs directly with the existing `harmonics.js`. | O(bins × k) |
| **Envelope autocorrelation** | Is the *level* periodic, and at what rate. Beeping, pulsing, rotor whop, reversing alarms. | O(n log n) on the history |

Two of these deserve to be more than a number in a table:

**Modulation rate.** `MarkerStore` already keeps rolling dB history per marker
for the trend sparkline. Autocorrelating that series gives the repetition rate
of anything pulsing, in Hz, for free. A readout of *"1.2 Hz"* next to a marker
on a reversing beeper, or *"100 Hz"* on rectified mains buzz, is genuinely
diagnostic and costs one FFT over ~200 samples.

**Tonality.** Spectral flatness within a marker's band, shown as a
tonal↔broadband bar, immediately separates "there is a whine at 3 kHz" from
"there is wind noise across 3 kHz". Anyone hunting a noise source wants this
before they want a species name.

---

## Tier 1 — User-taught templates (the headline feature)

*"Record a pattern from a marker, and tell me when it comes back."*

This is the feature this spec exists for, and the architecture already
supports it almost entirely by accident.

### Templates come out of the waterfall, for free

`waterfall.js` does not store pixels — it stores **1600 rows × 2048 bins of
quantised dB**, normalised to Nyquist, each row carrying its own timestamp
(`rowTime`) and its own Nyquist (`rowNyquist`). That is not a picture of a
recording. It *is* a recording: a spectro-temporal array, ~3.3 MB, already in
memory, already independent of FFT size, colour map, dB window and zoom.

So the gesture is the obvious one:

> **Drag a box on the waterfall → "Learn this".**

The selection rectangle already exists (shift-drag zoom-select in
`input.js`). A second modifier, or a mode toggle, turns the same rectangle
into a template extraction: the box's frequency span becomes the template's
band, the box's time span becomes its length, and the contents are lifted
straight out of the ring via the same addressing `sampleAt()` already uses.

The user sees the thing they are teaching the app, because it is the thing
they just drew a box around. No abstract "record 5 examples" flow, no
countdown, no separate capture mode. **A template is a screenshot of the past
that the app can match against the future.**

### Two caveats the implementation must handle

- **The ring's row rate is display-driven.** Row interval is
  `waterfallSpan × 1000 / plotHeight` in device pixels — so the same 3-second
  call recorded at a different window height or scroll span yields a different
  number of rows. Templates must be **resampled onto a canonical time grid**
  (proposal: 50 frames/second) at extraction time, and live frames matched
  against that grid, not against the ring's current rate.
- **The ring stores per-band peak, not mean.** Fine, even good, for matching —
  but the live matcher must reduce bins the same way, or the two are not
  comparable. One shared reduction function, used by both paths.

A "record from live audio" path (Tier 1b) can come later for templates shorter
or finer than the waterfall's row rate resolves. It is strictly an addition —
the waterfall path covers birdsong, sirens, alarms, machine cycles and
everything else in the 0.2–10 s range, which is nearly everything.

### Matching

Three matchers, in increasing order of robustness and cost. Ship them in
order; each is independently useful.

**(a) Spectral template — single frame, cosine similarity.**
For steady sources: hum, whine, a motor's signature, a resonance. Normalise
the template's dB vector (subtract its mean, divide by its norm), do the same
to the live band, take the dot product. Scale-invariant in level by
construction, which is what you want — the fridge is the same fridge from
across the room. ~20 lines. Should ship in the first pass.

**(b) Spectro-temporal patch — sliding normalised cross-correlation.**
For sounds with shape in time: a chirp, a two-tone siren, a three-beep alarm,
most bird calls. Slide the template over the last *N* frames of a rolling
buffer, compute normalised correlation at each offset, report the max. Cost is
`template_bins × template_frames` multiply-adds per hop — for a 3-second, 64-bin
template at 50 fps that is ~10k MACs per hop, i.e. free. Handles level
differences; does **not** handle tempo differences.

**(c) DTW over a band-limited feature vector.**
For calls that vary in tempo — a bird singing slower in the cold, a siren at a
different sweep rate, a human whistling. Dynamic time warping over the same
reduced-bin representation, with a Sakoe–Chiba band to bound the cost.
`O(frames² / band)`, still trivial at these sizes. This is the classic
isolated-utterance recognizer and it long predates neural nets for a reason:
with **one** example it beats anything statistical.

**(d) Landmark hashing (Shazam-style) — optional, for the long tail.**
Pick spectral peaks, hash pairs as `(f₁, f₂, Δt)`, match by hash agreement with
a consistent time offset. Extremely robust to additive noise, extremely cheap
to query, and it scales to hundreds of templates because it is a hash lookup
rather than a scan. The catch is that it is brittle to pitch/time scaling — it
recognises *the same recording*, not *the same kind of sound*. Right for
"detect this exact jingle/announcement/machine cycle", wrong for birds. Worth
having as a fourth mode, not as the default.

### Match handling

- A per-template **similarity threshold** (0–1), shown live as a meter so the
  user can set it by watching, exactly as the alarm's trigger level is set by
  watching the dB meter.
- **Hysteresis and refractory period**: a match must clear the threshold for
  *k* consecutive hops to fire, and cannot re-fire for *t* seconds. Without
  this, one event logs forty detections.
- On a match: log a detection, optionally sound the marker's alarm, optionally
  flash the marker band on both plates. Reuse `alarm.js` — the existing
  mute/disable split applies unchanged.

---

## Tier 2 — Rule-based decoders (no training, no models)

Known signals with published structure. Each is small, self-contained, and
needs no weights. These fit the "radar" framing better than anything else in
this spec, and several are direct ports of well-understood open-source code.

**Alarm and siren patterns.** All of these are envelope-domain, decodable from
the modulation-rate descriptor plus a state machine:
- **ISO 8201 / T-3** temporal pattern (0.5 s on, 0.5 s off, ×3, then 1.5 s
  off) — the standard smoke alarm evacuation signal.
- **T-4** (four pulses) — carbon monoxide.
- **Reversing beepers** — ~1 Hz pulse on a ~1 kHz tone.
- **Emergency vehicle sirens** — wail (slow sweep), yelp (fast sweep), hi-lo
  (two-tone alternation, EU). Detect by tracking the dominant peak's frequency
  trajectory and classifying its shape and rate. `findDominantPeak` +
  `refinePeakFreq` in `scale.js` already produce the trajectory.

**Radio-adjacent decoders**, for a receiver's audio output — all Goertzel-based
and all under 200 lines each:
- **DTMF** (8 tones, 16 symbols) — the textbook Goertzel application.
- **CTCSS / PL** subaudible tones (67–254 Hz) and **DCS** — identifies which
  repeater/user a signal belongs to.
- **1750 Hz** tone burst, **NOAA 1050 Hz** alert, **EAS/SAME** headers (AFSK
  520.83 baud).
- **Morse (CW)** — an envelope-threshold decoder over a marker's band, with
  adaptive WPM estimation. Fun, tiny, and a natural fit: the marker already
  defines the passband.
- **RTTY/AFSK/POCSAG** — mark/space tracking. Ports from `fldigi` and
  `multimon-ng` (both C, both WASM-portable, both GPL — see Licensing).

**Mains / ENF.** Precise 50/60 Hz tracking with sub-Hz resolution via a long
FFT or a phase-locked estimator, plus harmonic depth. Diagnostic for
electrical noise, and the frequency's slow wander is a genuine forensic
timestamp.

**Machine condition.** Sideband detection around a fundamental (bearing fault
frequencies, gear mesh, imbalance), blade-pass frequency for fans and drones,
RPM readout from a tracked f0. This is where a spectrum analyzer earns its
keep in a plant, and it is all peak-picking on data already in hand.

---

## Tier 3 — Pretrained models (opt-in download)

This is where "what is it called" lives, and where the zero-install promise
gets a caveat. Structure the tier so the caveat is per-model and explicit: a
card showing name, size, licence, what it recognises, and a Download button.
Cache in the **Cache API** or **OPFS**, never in `localStorage`.

### Runtime

**ONNX Runtime Web** (WASM + SIMD, with a WebGPU EP where available) is the
recommendation over TensorFlow.js: it ships an ESM build, it is one dependency
rather than a framework, and every model below either is ONNX or converts to
it. **transformers.js** is the alternative if the model list drifts toward
Hugging Face-hosted models — it is ESM-first and handles fetching and caching
itself, at the cost of a much larger surface.

### Candidate models

| Model | Recognises | Size (approx.) | Notes |
|---|---|---|---|
| **YAMNet** | 521 AudioSet classes — sirens, engines, dogs, glass, speech, music, tools | ~15 MB | MobileNetV1 on 64-bin log-mel, 0.96 s frames, 16 kHz. Apache-2.0. The obvious first model: broad, small, fast, permissively licensed. |
| **BirdNET** (V2.4) | ~6,000 bird species, with location/date priors | ~50 MB | 3 s windows at 48 kHz. **The Merlin analogue** — Merlin Sound ID is Cornell's closed sibling; BirdNET-Analyzer is the open one. **Licence is CC BY-NC-SA — non-commercial. Verify before shipping.** |
| **Silero VAD** | Speech present / absent | ~2 MB | ONNX already. Cheap, and the right way to implement a privacy gate ("pause logging while someone is talking"). |
| **CLAP** (audio tower only) | *Anything you can describe in words* — zero-shot | ~30 MB audio encoder | The text encoder does **not** need to run in-browser: precompute label embeddings offline and ship a JSON of vectors. Type "a dripping tap", get a detector. The most interesting entry here by a distance. |
| **Whisper tiny** (transformers.js) | Speech → text | ~40 MB int8 | Only if transcription is ever in scope. Probably it is not. |

### The hybrid that beats both tiers

**Embeddings + user-labelled k-NN.** Run a pretrained model as a *feature
extractor* (YAMNet's 1024-d embedding, BirdNET's penultimate layer), then let
the user record five examples of "my neighbour's heat pump" and classify by
nearest centroid in embedding space.

This is what BirdNET-Analyzer's own custom-classifier trainer does, and what
Teachable Machine does, and it is dramatically more robust than raw spectral
templates — the embedding has already learned what makes sounds similar. It
needs no gradient descent in the browser: storing centroids and computing
cosine distances is the entire training procedure.

If Tier 3 ships at all, this is the reason to ship it. "Name that sound" is a
party trick; "teach it *my* sound and be robust about it" is the tool.

---

## Prior art available for porting

The user's framing was *"if software is available but not in the browser we can
port it"*. The honest answer is that most of this is already in the browser:

| What | Where it is | State |
|---|---|---|
| **Meyda** | JS, ESM | Spectral descriptors. Could be used directly, or read and reimplemented — Tier 0 is ~150 lines and vendoring a library for it is a poor trade. |
| **Essentia.js** | WASM port of Essentia | Large, complete DSP + some ML. Heavy for this project but a good reference implementation. |
| **aubio.js** | WASM port of aubio | Onset, pitch (YIN), tempo. Well-tested. |
| **TF.js speech-commands / ml5 soundClassifier** | JS | Direct precedent for the Tier 3 hybrid, including the user-recorded-examples flow. |
| **BirdNET-Analyzer** | Python + TFLite | Model converts to ONNX. `BirdNET-Pi` and `Chirpity` are working references for windowing, overlap and confidence handling. |
| **fldigi** | C++ | Digital-mode decoders (RTTY, PSK, MFSK). Portable to WASM; **GPL**. |
| **multimon-ng** | C | POCSAG, DTMF, EAS, morse. Portable to WASM; **GPL**. |

The Tier 2 decoders are small enough that reimplementing from the published
specifications is cleaner than a WASM port — and it sidesteps the GPL problem
below.

---

## Data model

### Templates and classifiers belong to a session

A template is `{ id, name, band: {lo, hi}, frames, bins, data, fps, threshold,
matcher, markerId? }` — consistent with markers being frequency-based, not
pixel-based.

**This is the trade that flips.** `TODO.md` and `CLAUDE.md` both note that
`localStorage` is right *"unless a session ever has to hold recorded waterfall
history"*. A template **is** recorded waterfall history. A 3-second, 64-bin
template at 50 fps is 9,600 bytes raw, ~13 kB base64'd in JSON — one is fine,
thirty is not, and a model's cached weights are hopeless.

So: **templates move to IndexedDB**, keyed by session id, while settings and
markers stay in `localStorage` and stay synchronous. Sessions gain an async
`loadTemplates()` rather than becoming async wholesale. Export/import extends
to carry templates as base64, keeping the "one JSON file moves a survey"
promise intact — a survey that includes what you taught the app is much more
worth moving than one that doesn't.

### Detections are a log

`{ t, templateId | classLabel, confidence, peakDb, markerId }`, ring-buffered
in memory, exported as CSV alongside the existing marker CSV. This is what
turns the tool from a live display into an unattended monitor: leave a tablet
in a room overnight, come back to a list of when the thing happened.

---

## UI

Deliberately additive — no new top-level view.

- **Learn gesture**: box-select on the waterfall → "Learn this" → names it,
  attaches it to a marker (or creates one from the box's band).
- **Recognition lane**: a thin strip under the waterfall, sharing the time
  axis, with a coloured tick per detection. The waterfall already shows the
  past; this annotates it. Clicking a tick scrolls the readout to that moment.
- **Report column**: templates appear in the markers table as extra rows or a
  match-confidence column, with the same live-meter treatment the dB readout
  gets. Threshold is set by watching the meter, as the alarm's trigger is.
- **Sidebar tab**: a fourth tab, *Recognize*, holding the template list, the
  Tier 2 decoder toggles, and the Tier 3 model cards.
- **Alarm reuse**: "sound the alarm on match" is a checkbox on a template. The
  existing mute / disable-all semantics apply unchanged and must not be
  forked.

---

## Performance budget

Target: **recognition never costs a frame.** Everything below runs in a worker
against a 60 fps render loop that must keep its own budget.

- Tier 0 descriptors: <0.1 ms/frame, inline. Free.
- Tier 1 (b) patch correlation, 30 templates: ~300k MACs per 20 ms hop.
  Comfortably real-time in plain JS.
- Tier 1 (c) DTW, 30 templates × 150 frames with a 20-frame band: ~90k cells
  per hop. Fine, but gate it behind spectral flux so it only runs when
  something happened.
- Tier 3 YAMNet: ~10–20 ms per 0.96 s window on WASM SIMD. ~2% of one core.
- Tier 3 BirdNET: ~50–150 ms per 3 s window. Still ~5% duty cycle, but it
  belongs in its own worker with its own 48 kHz resampled stream.

**Gate everything on flux.** Most of the time nothing is happening; a
recognizer that only wakes on an onset costs almost nothing at idle, and idle
is the normal case for unattended monitoring.

---

## Licensing and privacy

- **GPL is a real constraint.** SoundRadar is MIT. `fldigi` and `multimon-ng`
  are GPL — porting their code, rather than reimplementing from published
  specs, would relicense the project. Reimplement.
- **BirdNET's models are non-commercial (CC BY-NC-SA).** Fine for an MIT app
  that *downloads* them at the user's request and never redistributes them,
  but it must be stated on the model card, not buried.
- **YAMNet is Apache-2.0** and carries no such problem.
- **Nothing leaves the device.** The only network traffic recognition may
  cause is fetching a model file from a static host, at the user's explicit
  request. This should be stated in the README as a feature, because against
  every comparable app it is one.

---

## Open decisions

1. **Does Tier 3 ship at all?** Tiers 0–2 keep the app pure, dependency-free
   and honest to its "open it and go" promise. Tier 3 adds a vendored runtime
   and multi-megabyte downloads for a capability that is genuinely
   impressive. *Recommendation: build 0–2 first, then Tier 3 as a strictly
   optional module — and if it ships, ship the embedding+k-NN hybrid rather
   than raw class labels.*
2. **`SharedArrayBuffer` or `postMessage`?** *Recommendation: `postMessage`
   with transferables as the baseline, SAB as an upgrade when cross-origin
   isolation happens to be present. Never require headers.*
3. **Canonical template frame rate.** 50 fps is proposed; it survives the
   waterfall's typical row rate and resolves a Morse dit at 20 WPM. Needs a
   sanity check against the fastest thing worth matching.
4. **Pitch/f0 readouts vs. the existing "no musical notes" rule.**
   `spec-spectrum-analyzer.md` rules out note names. f0 *in Hz* — engine RPM,
   siren pitch, wingbeat rate — is squarely in scope and does not conflict;
   it just needs saying so nobody re-litigates it.
5. **Ultrasonic.** At 48 kHz the ceiling is 24 kHz, which reaches ultrasonic
   pest repellers, dog whistles and tracking beacons, but not most bats. Some
   devices offer 96 kHz via `getUserMedia` constraints. Worth probing for and
   reporting, and worth a spec of its own if it works.

## Out of scope

- Anything that uploads audio, features, or embeddings.
- Speech transcription and speaker identification. Both are technically
  feasible in-browser today; both change what this tool *is*, and the second
  changes what it is *for*.
- Training a neural network in the browser. Centroids and k-NN over
  pretrained embeddings, yes; gradient descent, no.
- Music-domain recognition (chords, key, beat tracking) — same reasoning as
  the existing note-name exclusion.
- Multi-microphone work: direction finding, beamforming, source separation.
  Genuinely interesting for something called SoundRadar, but it is an input
  pipeline change, not a recognition feature, and it belongs in its own spec.

## Phasing

1. **`features.js` + Tier 0 descriptors.** No plumbing changes, no new
   dependencies, immediately useful. Tonality and modulation rate per marker.
2. **`capture.js` worklet tap + resampler.** The enabling work. Verifiable on
   its own by checking that frames arrive at a fixed hop under load.
3. **Tier 1a/1b: box-select on the waterfall → cosine and patch matching.**
   The headline feature. Templates in IndexedDB, detections in the log,
   matches into the existing alarm.
4. **Tier 1c DTW + the recognition lane and CSV export.**
5. **Tier 2 decoders**, cheapest and most-wanted first — siren/alarm patterns
   and Morse are the natural openers.
6. **Tier 3**, if decision (1) goes that way: YAMNet first, then the
   embedding + k-NN hybrid, then BirdNET.
