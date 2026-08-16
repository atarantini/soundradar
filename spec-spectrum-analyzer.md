# Spectrum Analyzer — Spec

First tool in SoundRadar. Real-time frequency spectrum display with an
optional waterfall (spectrogram) view, interactive tooltip, and
user-placeable frequency markers.

## Overview

Two coordinated views over the same audio data:

- **Spectrum view** — current frequency magnitude, updated every animation
  frame (line or bar plot, frequency on X, dB on Y).
- **Waterfall view** — scrolling spectrogram (time on one axis, frequency on
  the other, magnitude mapped to color). Toggleable on/off; spectrum view
  always available.

Both read from the same `AnalyserNode` so they always agree on FFT
size/range/scale settings.

## Audio Analysis

- `AnalyserNode` from the shared `AudioContext` (see main `SPEC.md`).
- `fftSize` configurable (e.g. 512 / 1024 / 2048 / 4096 / 8192 / 16384) —
  trade-off between frequency resolution and time resolution, exposed as a
  user setting.
- `smoothingTimeConstant` exposed as a setting (0–0.9), separate from the
  "speed" control below (this smooths the FFT itself; speed controls how
  fast the waterfall scrolls / how often we sample it).
- Data read via `getFloatFrequencyData` (dB values, so min/max dB mapping is
  direct — no manual log conversion needed).

## Controls / Settings

### Frequency axis
- **Min frequency / Max frequency** — clamps and zooms the displayed range
  (e.g. default 40 Hz – 20,000 Hz, adjustable via numeric inputs or a
  dual-handle slider).
- **Scale**: logarithmic (default, matches human hearing) or linear —
  toggle.

### Amplitude (dB) axis
- **Min dB / Max dB** — sets the color/height mapping range (e.g. default
  -100 dB to -30 dB). Values outside range clip to the min/max color.
- Applies to both the spectrum view's Y-axis and the waterfall's color
  mapping, so the two stay visually consistent.

### Waterfall
- **On/off toggle.**
- **Speed** — how many seconds of history are visible / how fast it scrolls
  (e.g. 5s / 10s / 30s / 60s, or a free-form seconds input). Determines row
  advance rate independent of animation frame rate.
- **Color map** — selectable gradient (e.g. classic "spectrogram"
  blue→green→yellow→red, grayscale, viridis/magma-style perceptual maps)
  mapped across the min–max dB range.
- **Zoom**: hold Ctrl and drag a horizontal selection directly on the
  waterfall to zoom the frequency axis to that range — sets Min/Max Hz to
  the selected span (shared with the spectrum view) and resets the
  waterfall history. A short drag (<4px) is ignored so it doesn't clobber
  the normal click-to-add-marker gesture. Floating +/−/reset buttons in the
  waterfall's top-right corner give the same zoom without needing Ctrl+drag
  (in/out scale the current range 30% around its center; reset restores the
  default Min/Max Hz).
- **Orientation** — scroll direction (up/down or left/right), default
  vertical scroll with newest data at one edge.
- Each marker's live dB level is rendered directly on the waterfall, just
  below its name/frequency label, color-coded the same way as its meter in
  the markers panel — so you can read intensity without the panel open.

### General
- **FFT size** picker (resolution vs. responsiveness trade-off).
- **Smoothing** slider (`smoothingTimeConstant`).
- Pause/resume capture.
- Reset-to-defaults button.

## UI sizing

There is no top header or settings bar — all controls live in a single
collapsible left sidebar so the waterfall/spectrum plots (the primary
working view) get the full remaining width, edge-to-edge with no padding
around them. Controls and inputs favor touch-usable hit targets over a
dense desktop panel, but the visual language is deliberately technical:
flat panels, hairline dividers, zero corner rounding, monospace type
throughout — closer to a bench instrument's control surface than a
typical web app.

The sidebar (`#sidebar`, toggled by `#sidebarToggle`) is collapsed to a
thin rail by default — the plots get full width on first load, and the
sidebar is opt-in. Collapsing/expanding animates the width and triggers
a canvas resize once the transition ends.

Inside, a three-way tab strip (`.tab-bar`, `data-tab` on both the
`.tab-btn`s and their matching `.tab-panel`s) splits the controls into:
- **Configs** — device picker, frequency axis, amplitude (dB), analysis
  (FFT/smoothing), and the "Reset defaults" button. Default tab.
- **Waterfall** — enabled toggle, scroll speed, color map.
- **Markers** — the marker list, with "Clear all" in its header row.

Only one tab's content is visible at a time; switching tabs doesn't
resize anything since the sidebar's own width is unchanged.

The mic Start/Pause/Resume control is the one thing that stays outside
the sidebar: a small fixed control in the upper-right corner of the
screen (`.capture-bar`), with the REC-style dot built in (dark = not
recording, red + blinking = recording, dim red = paused — same
convention as a tape deck). It floats above the plots regardless of
sidebar state or scroll position, since nothing else works until the
mic is started.

The waterfall zoom/pan controls (`.zoom-controls`) similarly float fixed
in the lower-right corner of the screen rather than pinned to the
waterfall canvas, so they stay reachable without overlapping the plot
area.

Markers are rendered as compact two-row table entries (name/controls row,
then a single data row with Hz, ± width, live meter, dB readout, and
chart toggle) rather than a tall stacked card — see "Frequency markers"
below.

## Interaction

### Hover tooltip (crosshair)
- On mousemove over the spectrum (and/or waterfall) canvas, draw a vertical
  line at the cursor's X position spanning the plot height.
- Tooltip near the cursor shows:
  - Frequency at that X position (Hz, formatted as e.g. `1.2 kHz` above
    1000 Hz).
  - dB magnitude at that frequency for the spectrum view (nearest FFT bin,
    current frame). For the waterfall, also show the timestamp/row hovered.
- Hides on mouseleave.

### Frequency markers
- Click on the spectrum/waterfall to drop a marker centered at that
  frequency, rendered as a shaded band (`freq ± width/2`), not just a hairline
  — width defaults to a fixed Hz value and is editable per marker.
- Markers list shown in a side panel: each entry has an editable name, exact
  center frequency (Hz), and band width (Hz), plus a remove (✕) button.
- **Monitor**: each marker row has a live meter (bar + dB readout)
  showing the current peak signal level within that marker's frequency band,
  updated every frame. Intended for walking around with the mic to localize
  a noise/buzz source by watching the level rise or fall. The dB readout is
  color-coded by intensity — white/readable at low levels, warming through
  yellow/orange to red as the level rises — and a 📈 toggle on the row opens
  a small live line chart (auto-scaled to recent history) of that marker's
  dB over time.
- Markers persist across FFT size / range changes (frequency-based, not
  pixel-based), and are saved to `localStorage` so they survive page
  reloads. Cleared only via the explicit "clear markers" action.
- Optional (future): click-drag an existing marker to reposition it.

## Layout (current)

```
┌────────┬──────────────────────────────────────┐
│Sidebar │                          [Start/Pause]│
│(all    ├──────────────────────────────────────┤
│controls│         Spectrum view                 │
│ +      │         (line/bar, w/ crosshair)       │
│markers)├──────────────────────────────────────┤
│        │                                        │
│        │         Waterfall view                 │
│        │         (scrolling spectrogram,         │
│        │          edge-to-edge, no padding) [zoom]│
└────────┴──────────────────────────────────────┘
```

No top header or controls bar — the sidebar is collapsible (thin rail
when collapsed) and holds every setting plus the markers list. The
Start/Pause control floats fixed in the upper-right corner of the screen;
the zoom/pan controls float fixed in the lower-right.

## Out of scope (for this first pass)

- dB SPL calibration, multi-channel/stereo split view, export of captured
  waterfall data — candidates for later tools or a v2 of this spec.

Musical note/pitch readouts are explicitly out of scope: this is a signal
analysis tool, not a music app.
