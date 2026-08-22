# SoundRadar

A browser-based toolkit for analyzing sound in real time using the microphone
or other local audio input. Pure HTML/CSS/JS, no build step required, runs
entirely client-side using the Web Audio API.

## Goals

- Zero-install: open `index.html` (or a static host) and go.
- Modular tools: each analysis tool is a self-contained module/view sharing a
  common audio input pipeline.
- Real-time first: everything is designed around live mic input, with room to
  later accept file/line-in input too.

## Audio Input Pipeline (shared across tools)

- `getUserMedia({ audio: true })` for mic access, with a device picker if
  multiple input devices are available (`enumerateDevices`).
- Single `AudioContext` shared app-wide; each tool taps it via its own
  `AnalyserNode` (or other node) rather than creating separate contexts.
- Input source is abstracted so a future "load audio file" or "line-in"
  option can feed the same graph without changing tool code.
- Permission/error states (denied mic, no devices, insecure context) surfaced
  to the user, not silently failed.

## Saved state (shared across tools)

- **Sessions**: every saved thing belongs to a named session — display
  settings and markers today, whatever a future tool saves tomorrow. Sessions
  are switched from the toolbar, and the app always opens in a session
  (`default` on a fresh browser). Storage is the browser's `localStorage`,
  under `soundradar.s.<id>.*`, with the roster in `soundradar.sessions.v1`.
- **Portability**: one JSON file carries every session, so a survey can move
  between machines or be attached to a report. Import merges rather than
  replaces — restoring a backup must never cost the reader the work already
  in front of them.
- The theme is the deliberate exception: it belongs to the browser, not to a
  measurement, so it lives outside sessions and is not applied by an import.

## Tools (planned)

1. **Spectrum Analyzer** — see [`spec-spectrum-analyzer.md`](./spec-spectrum-analyzer.md) (first tool, in progress)
2. *(future tools TBD — e.g. decibel meter, oscilloscope)*

## Tech Notes

- Canvas 2D for rendering (spectrum bars/line + waterfall). No framework
  dependency assumed; keep JS modular (ES modules) so tools can be added
  without a bundler.
- Target modern evergreen browsers (Web Audio API + `getUserMedia` support
  assumed). No legacy/vendor-prefix support planned.
