# Plan: Recordings

Record what the microphone hears, then play it back or download it as WAV.

## Decisions
- Two top-bar buttons: **Listen** (green, start / pause / resume) and **Record** (white ● / ■ on red, with a timer while recording). Red now means "a recording you started with Record"; teaching a sound and detection clips keep their own markers (menu dot, log-row dot).
- A **Recordings** menu lists takes: play, download (WAV), delete.
- 10 minute cap per take (auto-stops), 5 takes at most (Record refuses until one is deleted — never drop the user's audio silently).
- Detection, spectrum and alarms keep running while recording.
- Pausing or stopping listening ends the take and keeps it.
- Memory only, like clips: takes are never stored or uploaded; the download is the only way out. A `beforeunload` prompt warns when takes would be lost.
- While a take plays, `detection.quietUntil` keeps the replay from being logged.

## Code
- `js/core/recorder.js` — `TakeRecorder`, DOM-free. Own `CaptureTap`, 16-bit chunks (~5.8 MB/min at 48 kHz), WAV assembled from chunks without copying.
- `js/recordings.js` — the menu view (rows, play/download/delete).
- `js/app.js` — wiring; the run button loses its red state.
- `index.html`, `css/style.css`, `CLAUDE.md`, `spec-recognition.md` (audio-kept wording), README.
