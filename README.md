# SoundRadar

**[▶ Open the live app](https://atarantini.github.io/soundradar/)** — runs in
your browser, nothing to install.

A real-time audio spectrum analyzer and waterfall that runs entirely in your
browser. Point a microphone at a room, a motor, a speaker or a wall, and read
what is actually in the air — no install, no account, no upload.

Plain HTML, CSS and ES modules. No build step, no bundler, no dependencies.
Audio is analysed in the tab and never leaves the device.

## Quick start

Any static file server works. The app needs to be served over HTTP(S) rather
than opened as a `file://` URL, because `getUserMedia` requires a secure
context — `localhost` counts as one.

```bash
./web.sh          # PHP's built-in server on :8080, opens a browser
./web.sh 9000     # ...on another port
```

Or use whatever you already have:

```bash
python3 -m http.server 8080
npx serve .
```

Then open `http://localhost:8080/` and press **Start capture**.

It also deploys as-is to any static host — GitHub Pages, Netlify, an S3
bucket. All paths are relative, so serving it from a subdirectory works.

## What it does

- **Spectrum plate** — live frequency magnitude, with optional peak hold
  (decay in dB/s), fill under the trace, and phosphor-style persistence.
- **Waterfall plate** — scrolling spectrogram over a selectable history window
  (5 s to 2 min) in one of seven palettes. History is kept as data, not as
  pixels, so changing the palette, dB window or zoom repaints the *same*
  recording instead of throwing it away.
- **Shared frequency ruler** between the two plates. Both plates map frequency
  to the same X, so a peak, its pin, and its stripe line up vertically.
- **Markers** — plant one at a frequency, name it, give it a bandwidth, and
  watch its live level, peak and trend in the report table. Stored by
  frequency in Hz (not pixels), so they survive zoom, FFT size and window
  changes, and persist in `localStorage`.
- **Marker alarm (the finder)** — arm the bell on a marker and give it a
  trigger level: whenever that band reaches it, the app beeps, rising in pitch
  and repeating faster the louder it gets. Walk around with a laptop or phone
  and hear yourself getting closer to a buzz without watching the screen.
  Mute silences every alarm without disarming anything; "Disable all alarms"
  switches them all off. (Headphones — over speakers the beep feeds back into
  the microphone.)
- **Sessions** — named save states, each with its own display settings and
  markers, switched from the Session menu. One survey per room, per machine,
  per site visit. The app always opens in the session you were last in, and
  starts life in one called *Default*.
- **Mark harmonics** — drop a marker on each harmonic of the loudest
  frequency, which is the fastest way to confirm a single tonal source
  (a motor, a fan, mains hum).
- **Fit to signal** — sets the dB floor and ceiling from what the input is
  doing right now.
- **Span presets** — full range, rumble, speech, hiss, mains hum.
- **Export** — save the current view as a PNG, the marker table as CSV, or
  every session you have as one JSON file that imports back on another
  machine. Importing adds sessions alongside your own; it never overwrites
  them.
- Light and dark themes, an input device picker, and a layout sized for
  tablet/touch as much as for desktop.

## Controls

| Gesture | Action |
| --- | --- |
| Drag a plate | Pan the frequency range |
| Wheel / pinch | Zoom around the pointer |
| Shift + drag | Select a range to zoom into |
| Double click / tap | Plant a marker at that frequency |
| Long press (touch) | Plant a marker |
| Drag a pin | Move a marker along the ruler |

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Start capture, or pause / resume it |
| <kbd>M</kbd> | Plant a marker at the cursor |
| <kbd>←</kbd> <kbd>→</kbd> | Pan |
| <kbd>+</kbd> <kbd>−</kbd> | Zoom |
| <kbd>Esc</kbd> | Close the open toolbar menu |

## Requirements

A modern evergreen browser with the Web Audio API and `getUserMedia`
(Chrome, Edge, Firefox, Safari). No legacy or vendor-prefixed support is
planned. Microphone permission is requested when you press **Start capture**
and can be revoked at any time.

## Privacy

There is no server component and no network traffic. Audio is processed in
the page via the Web Audio API and is never recorded, uploaded or persisted.
The only things stored are your sessions — display settings and markers — plus
your theme, in this browser's `localStorage` (keys prefixed `soundradar.`).
Exporting writes a JSON file to your own disk; nothing is sent anywhere.

## Repository layout

```
index.html            markup and every control
css/style.css         all styling, themed via CSS custom properties
js/app.js             composition root: settings, wiring, render loop
js/core/              reusable, DOM-free analysis and rendering modules
js/core/sessions.js   named save states, and JSON export/import of all of them
js/core/alarm.js      the marker alarm tone
js/ruler.js           the shared frequency ruler between the plates
js/markers-table.js   the marker report table
js/theme.js           reads canvas colours out of the stylesheet
CHANGELOG.md          what changed in each release
SPEC.md               project goals and the shared audio pipeline
spec-spectrum-analyzer.md   design intent for the analyzer tool
CLAUDE.md             architecture notes and conventions for contributors
```

## Contributing

Issues and pull requests are welcome. There is no build, lint or test setup —
edit the files and reload the page. Two conventions matter:

- All frequency/dB ↔ pixel maths lives in `js/core/scale.js`. Don't
  re-derive log-scale or dB mapping in drawing code.
- New settings go in `BASE_DEFAULTS` in `js/core/settings.js` so that
  validation, persistence and "Reset all settings" stay authoritative.

`CLAUDE.md` has the fuller architecture tour.

## License

MIT — see [LICENSE](./LICENSE).
