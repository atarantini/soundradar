# Changelog

Notable changes to SoundRadar. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Sound detection** — a Detect menu that turns the analyzer from "show me
  what is there" into "tell me when *that* happens". Switch a sound on and
  every time it is heard it is logged, labelled on the waterfall at the row it
  was heard in, and optionally announced with a chime.
  - **Pattern rules**, instant and dependency-free: *siren* (wail, yelp or
    two-tone hi-lo, from how the dominant pitch moves) and *mosquito whine*
    (a wandering wingbeat tone with a clean 2nd harmonic). They read their
    own fixed analyser, so the display's FFT size and smoothing never change
    what they hear, and they mark the frequency on the waterfall.
  - **YAMNet sound classifier** for *bird, dog, siren, insect / mosquito,
    traffic, train / rail, crash / smash* and *door*. The model (Apache-2.0,
    ~16 MB) and TensorFlow.js ship with the app and load from the same site,
    only once a classifier category is switched on. Inference runs in a
    module Worker fed by an AudioWorklet tap, so the render loop never pays
    for it and nothing leaves the device.
  - Each detector has a live confidence meter with its threshold marked on
    it, a threshold slider, and a bell. Events are debounced (hold time,
    release level, refractory period), so one bark is one row, not forty.
  - A **Detections** log under the markers report: time, sound and the
    AudioSet class or siren style that matched, peak confidence, duration,
    frequency. Exports as CSV. Kept in memory per session; not saved.
    Remove a single detection — a false alarm, a test — with its ✕, or every
    one with *Clear* (which asks first). Either takes the label off the
    waterfall too.
  - **Sound clips**, opt-in (*Keep a sound clip of each detection*, off by
    default): each detection keeps from 2 s before it started to 1 s after
    it ended (at most 12 s), to replay ▶ or download ⤓ as WAV from its row.
    Clips live only in the tab's memory — at most 50 / 64 MB, oldest dropped
    first — and go with their row, a cleared log, a session switch, a reload,
    or the option being turned off. Replaying over speakers is not logged as
    a new detection.
  - Which detectors are on, their thresholds and bells are part of a
    session's settings — they switch with the session and travel in the JSON
    export.
  - Adding a sound is one catalog entry: a `yamnetCategory` listing AudioSet
    classes, or a rule module scored from the spectrum.

- **More sounds to detect**, grouped in the Detect menu as Animals, People,
  Home and Street:
  - *People:* **Speech** (talking, conversation, whispering, crowd chatter),
    **Shouting / screaming**, **Crying** (including a baby's) and
    **Laughter**. They detect *that* someone is talking, shouting, crying or
    laughing — nothing transcribes or identifies anyone.
  - *Home:* **Door lock / keys** — a key turning in a lock, a latch or bolt,
    keys jangling. AudioSet has no lock class; a key turning is heard as keys
    and mechanism. Switch on Door too to catch a heavy bolt's thunk.
  - *Animals:* **Cat** — meowing, purring, caterwauling, a growl. (A hiss is
    often heard as a power tool and missed.)
  - Class lists and thresholds were set against real recordings, so each
    category fires on its own sounds and stays below threshold on the rest.
- **Categories you can switch as a whole.** The Detect menu now lists every
  detector by category — the instant pattern rules included, marked as such —
  and each category heading is its switch: tick it to turn on everything in
  it, untick to turn it all off, half-ticked when only some are on.

### Changed

- **Dog** now defaults to a 60% threshold (was 30%): YAMNet scores a crying
  baby at ~55% "Dog", a real bark at ~90%.
- **Crying** now defaults to 70% and **Shouting / screaming** to 35%: parts
  of a cat's meow read ~60% "crying" and its yowl ~30% "screaming", while
  real crying and screams score 70–99%.
- The classifier scores a window every 0.25 s instead of 0.5 s (still
  widening on slow machines), so short sounds — a lock, a slam, a scream —
  land in the middle of a window instead of straddling two.
- "Disable all alarms" now also clears detector bells, and the Display menu's
  alarm section is called *Alarms*.

### Fixed

- **Detection after Clear.** Clearing the log while a sound was still going
  on — traffic, talking, a long siren — left that sound's event running out
  of sight, and nothing new was logged until the sound stopped for a moment.
  A continuous sound could go unlogged indefinitely. Now a sound still going
  on when you clear starts a fresh record right away (without a chime: it is
  the same sound). Removing a single detection with ✕ still dismisses it for
  as long as that sound lasts.
- **Toolbar menus on phones.** Below 620px the menus scroll in a row of their
  own, and that row clipped every drop-down to its own height: menus opened,
  but nothing in them could be reached, and a tap on one closed it. On a
  phone a menu now opens as a sheet across the screen under the toolbar, and
  a long one scrolls inside itself.
- **Toolbar on tablets.** Between 620px and 900px the toolbar no longer fits
  one row (adding the Detect menu made that range wider still), which pushed
  the page past the screen. The menus now take a row of their own there, and
  their panels open from that row's right edge, so they never run off-screen.
- **Space on a focused button.** The start/pause shortcut swallowed Space
  everywhere but text fields, so a focused button (a row's ✕, a bell, a
  toolbar menu) could not be pressed with it. Space now presses what has
  focus, and still starts or pauses capture from the page itself.
- **Page wider than a phone screen.** The markers report's actions now wrap
  instead of widening the page, which had left the whole app slightly zoomed
  out and pannable sideways on phones.

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
