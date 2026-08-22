# Changelog

Notable changes to SoundRadar. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-08-22

The survey release: your work now has somewhere to live, somewhere to go, and
something to shout when it finds what you are looking for.

### Added

- **Sessions** — named save states, each with its own display settings and
  markers, switched from the new Session menu in the toolbar (New, Rename,
  Duplicate, Delete). One survey per room, per machine, per site visit. The
  app opens in the session you were last in, and starts life in one called
  *Default*. Nothing needs saving by hand: a session *is* the storage settings
  and markers are written to, so switching is immediate.
- **Export / import all data** — "Export everything as JSON" writes every
  session, with its settings and markers, to a single file; "Import from
  JSON…" reads it back. Import **adds** sessions (fresh ids, de-duplicated
  names) rather than overwriting, so restoring a backup can never cost you the
  work already in front of you.
- **Marker alarm, the "finder"** — arm the bell on a marker in the report and
  give it a trigger level: whenever that band reaches it, the app beeps,
  rising in pitch (700 Hz → 5.6 kHz) and repeating faster the louder it gets.
  Walk around with a laptop or a phone and hear yourself getting closer to a
  buzz without watching the screen. The tone runs on the shared
  `AudioContext`, so pausing capture silences it.
  - Master volume, **Mute alarms** and **Disable all alarms** live in the
    Display menu; the mute is also one click away in the markers report.
    They are deliberately different switches: mute silences everything but
    leaves markers armed, disable switches every marker off.
  - Use headphones. Over speakers, the beep feeds back into the microphone.

### Changed

- A fresh visitor now lands on a **linear frequency axis** and the **dark
  theme**, instead of the logarithmic axis and the system colour scheme. A
  stored choice still wins in both cases.
- Report table columns are hidden by name on narrow screens rather than by
  counting positions, and the new Alarm column stays visible on a phone —
  hunting a noise by ear one-handed is exactly what it is for.

### Fixed

- Below 900 px the report hid the wrong cells: the rules hid the *headers* of
  the Level and Trend columns but the *cells* of Now and Actions, so headers
  and data drifted out of alignment.
- A frame drawn only because something changed (a pause, a hover) could be
  skipped by the 10 Hz readout throttle, leaving stale numbers — and, once
  alarms existed, a stale "sounding" bell — on screen until the next frame
  that never came.

### Storage

- Settings and markers moved from `soundradar.settings.v1` /
  `soundradar.markers.v1` into the default session
  (`soundradar.s.default.*`). Existing setups are migrated automatically on
  first load, as with the two earlier renames; nothing is lost and nothing
  needs doing.
- The session roster lives in `soundradar.sessions.v1`. The theme stays
  outside sessions, in `soundradar.theme`: it belongs to the browser, not to
  a measurement, which is also why an import never changes it.

## [0.1.0] — 2026-08-16

Initial public release: the spectrum analyzer.

- Spectrum plate with peak hold, fill and phosphor persistence; waterfall
  plate over a selectable history window in seven palettes, kept as data
  rather than pixels so a palette or zoom change repaints the same recording.
- One shared frequency ruler between the plates, and the surface markers are
  planted on.
- Markers stored by frequency in Hz, with live level, peak and trend, plus
  "Mark harmonics" and CSV export.
- Touch-first interaction throughout: drag to pan, wheel/pinch to zoom,
  shift-drag to select a span, double-tap or long-press to plant a marker,
  and an on-screen zoom/pan pad.
- Light and dark themes, input device picker, PNG export of the current view.
- Runs entirely client-side; audio never leaves the tab.

[0.2.0]: https://github.com/atarantini/soundradar/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/atarantini/soundradar/releases/tag/v0.1.0
