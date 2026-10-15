// SoundRadar — composition root.
//
// Owns the settings, wires the toolbar menus, and drives the single animation
// frame loop that redraws both plates, the shared ruler, and the report.

import { AudioEngine, AnalyserTap, FFT_SIZES, checkSupport } from './core/audio.js';
import { Settings, WATERFALL_SPANS, MIN_SPAN_HZ } from './core/settings.js';
import { MarkerStore } from './core/markers.js';
import { SessionStore, DEFAULT_SESSION_ID } from './core/sessions.js';
import { AlarmTone } from './core/alarm.js';
import { DETECTORS, withLearned } from './core/detect/catalog.js';
import { learnedDetector, bankOf } from './core/detect/learned.js';
import { SoundStore } from './core/detect/sounds.js';
import { TeachSession } from './core/detect/teach.js';
import { WindowHistory } from './core/detect/evidence.js';
import { makeSoundFile, readSoundFile } from './core/detect/sound-file.js';
import { RELEASE_RATIO } from './core/detect/trigger.js';
import { resolveThreshold, groupOf } from './core/detect/thresholds.js';
import { DetectionEngine, SPECTRUM_INPUT } from './core/detect/engine.js';
import { DetectionLog } from './core/detect/log.js';
import { Publisher } from './core/publish.js';
import baseConfig from './config.js';
import { ClipRecorder } from './core/detect/clips.js';
import { YamnetClassifier } from './core/detect/yamnet.js';
import { SpectrumView } from './core/spectrum.js';
import { Waterfall } from './core/waterfall.js';
import { PlotInput, zoomRange, panRange } from './core/input.js';
import { drawHearingBand } from './core/reference.js';
import {
  freqToX, xToFreq, findDominantPeak, dbToY,
  freqToSlider, sliderToFreq, FREQ_SLIDER_STEPS,
} from './core/scale.js';
import { WATERFALL_MAPS, MAP_LABELS } from './core/colormap.js';
import { harmonics } from './core/harmonics.js';
import {
  clamp, dpr, resizeCanvasToDisplaySize, formatFreq, formatAgo,
  downloadBlob, timestampSlug, debounce,
} from './core/util.js';
import { readTheme } from './theme.js';
import { Ruler } from './ruler.js';
import { MarkersTable } from './markers-table.js';
import { DetectMenu } from './detect-menu.js';
import { DetectionsTable } from './detections-table.js';
import { TeachCard } from './teach-card.js';
import { TakeRecorder } from './core/recorder.js';
import { RecordingsMenu } from './recordings.js';

const GUTTER_L = 44; // CSS px reserved for the dB / time axis on each plate
const THEME_KEY = 'soundradar.theme';
const SESSIONS_KEY = 'soundradar.sessions.v1';
const SESSION_PREFIX = 'soundradar.s.'; // + `<id>.settings.v1` / `<id>.markers.v1`

const PALETTE = ['#2a3fd4', '#0f9d58', '#d4762a', '#8e44c4', '#c02b5e', '#0d8ea8', '#7a8c1f', '#b8342b'];
// Detection labels are drawn on the dark waterfall as well as on paper, so
// these sit at mid luminance where the marker palette runs dark.
const DETECT_PALETTE = [
  '#4f8cff', '#2fbf71', '#ff8a3d', '#b46cff', '#ff4f8b',
  '#22c3d6', '#c8d440', '#ff5a4d', '#f2c12e', '#9aa7b8',
  '#7cdb5a', '#ff7ad9', '#5ad1a8', '#d89a5b', '#8f9bff', '#e8e05a',
];

const $ = (id) => document.getElementById(id);

// ---------- storage ----------

// The keys have been renamed twice: "survey" → "soundrad" → "soundradar".
// Carry anything already saved across once, so a rename never costs anyone
// their markers. Order matters — each step feeds the next. Runs before
// anything reads storage below.
for (const [from, to] of [
  ['soundrad.survey.theme', 'soundrad.theme'],
  ['soundrad.survey.settings.v1', 'soundrad.settings.v1'],
  ['soundrad.survey.markers.v1', 'soundrad.markers.v1'],
  ['soundrad.theme', THEME_KEY],
  ['soundrad.settings.v1', 'soundradar.settings.v1'],
  ['soundrad.markers.v1', 'soundradar.markers.v1'],
  // Sessions arrived after these: what used to be the app's one saved state is
  // now the "default" session's, which is the session the app opens in.
  ['soundradar.settings.v1', `${SESSION_PREFIX}${DEFAULT_SESSION_ID}.settings.v1`],
  ['soundradar.markers.v1', `${SESSION_PREFIX}${DEFAULT_SESSION_ID}.markers.v1`],
]) {
  try {
    const saved = localStorage.getItem(from);
    if (saved != null) {
      if (localStorage.getItem(to) == null) localStorage.setItem(to, saved);
      localStorage.removeItem(from);
    }
  } catch {
    /* storage unavailable */
  }
}

// ---------- theme ----------

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  try {
    if (mode) localStorage.setItem(THEME_KEY, mode);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* storage unavailable */
  }
}

function currentThemeIsDark() {
  const set = document.documentElement.dataset.theme;
  if (set) return set === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

// Low light is the default; a stored choice wins once the user has picked one.
try {
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
} catch {
  applyTheme('dark');
}

// ---------- state ----------

const sessions = new SessionStore({ indexKey: SESSIONS_KEY, prefix: SESSION_PREFIX });
const sessionKeys = sessions.keysFor(sessions.activeId);

const settings = new Settings(sessionKeys.settings, { colorMap: 'viridis', freqScale: 'linear' });
const engine = new AudioEngine();
const markers = new MarkerStore({ storageKey: sessionKeys.markers, palette: PALETTE });
const alarm = new AlarmTone({ getContext: () => engine.ctx });
// The sounds the user taught, per session. They join the catalog at runtime:
// `catalog` is always the built-in detectors with the learned ones in front.
const sounds = new SoundStore({ storageKey: sessionKeys.sounds });
const teach = new TeachSession();
// The last few minutes of what learned sounds scored, in memory, for export.
const history = new WindowHistory();
let catalog = withLearned(sounds.sounds.map(learnedDetector));
const detectLog = new DetectionLog();
// Set up below when js/config(.local).js turns MQTT publishing on; null otherwise.
let publisher = null;
const clips = new ClipRecorder({ log: detectLog });
const clipPlayer = new Audio();
const recorder = new TakeRecorder();
const detection = new DetectionEngine({ catalog, log: detectLog, onEvent: onDetection });
const classifier = new YamnetClassifier();
const detectTap = new AnalyserTap(engine, SPECTRUM_INPUT);
const detectorColors = new Map(DETECTORS.map((d, i) => [d.id, DETECT_PALETTE[i % DETECT_PALETTE.length]]));
// A learned sound's colour follows its place in the list, so it keeps it
// across reloads. Its own sequence skips the palette's grey, which reads as
// "switched off", and steps far enough that neighbours never look alike.
const LEARNED_COLORS = DETECT_PALETTE.filter((c) => c !== '#9aa7b8');
const colorOfDetector = (id) => {
  const builtIn = detectorColors.get(id);
  if (builtIn) return builtIn;
  const i = sounds.sounds.findIndex((s) => s.id === id);
  return i < 0 ? DETECT_PALETTE[0] : LEARNED_COLORS[(4 + i * 4) % LEARNED_COLORS.length];
};

const spectrumCanvas = $('spectrumCanvas');
const spectrumOverlay = $('spectrumOverlay');
const waterfallCanvas = $('waterfallCanvas');
const waterfallOverlay = $('waterfallOverlay');
const rulerCanvas = $('rulerCanvas');
const fieldView = $('fieldView');
const tooltip = $('tooltip');

const spectrum = new SpectrumView(spectrumCanvas);
const waterfall = new Waterfall(waterfallCanvas);
const ruler = new Ruler(rulerCanvas);
const spectrumOverlayCtx = spectrumOverlay.getContext('2d');
const waterfallOverlayCtx = waterfallOverlay.getContext('2d');

let theme = readTheme();
let hover = null;
let selection = null;
let highlightId = null;
let latestData = null;
let dominant = null;
let lastReadoutAt = 0;
let needsIdleDraw = true;

const table = new MarkersTable({
  reportEl: $('report'),
  bodyEl: $('markerRows'),
  countEl: $('markerCount'),
  store: markers,
  onSelect: (id) => {
    highlightId = id;
    needsIdleDraw = true;
  },
});

const detectMenu = new DetectMenu({
  listEl: $('detectList'),
  badgeEl: $('detectBadge'),
  stateEl: $('modelState'),
  enabledEl: $('modelEnabled'),
  catalog: DETECTORS,
  colorOf: colorOfDetector,
  onTeach: () => {
    teachCard.openNew();
    $('menuDetect').open = true;
  },
  onEdit: (id) => teachCard.openEdit(id),
  onImport: importSound,
  onChange: setDetector,
  onChangeMany: setDetectors,
  onExpand: (names) => settings.set({ detectExpanded: names }, []),
  globalEl: $('detectGlobal'),
  onGlobalThreshold: setGlobalThreshold,
  onGroupThreshold: setGroupThreshold,
});

const teachCard = new TeachCard({
  slot: detectMenu.teachSlot,
  store: sounds,
  teach,
  status: () => ({ live: engine.running && !engine.paused, model: classifier.state }),
  onStartCapture: () => $('runBtn').click(),
  onStateChange: () => {
    $('menuDetect').classList.toggle('is-recording', teachCard.recording);
    syncClassifier();
  },
  // A sound starts on, so a test straight after teaching shows whether it works.
  onSaved: (sound, isNew) => {
    if (isNew) setDetector(sound.id, { on: true });
  },
  onDelete: deleteSound,
  onExport: exportSound,
});

const detectionsTable = new DetectionsTable({
  bodyEl: $('detectionRows'),
  emptyEl: $('detectionsEmpty'),
  countEl: $('detectionCount'),
  log: detectLog,
  colorOf: colorOfDetector,
  onRemove: (id) => detectLog.remove(id),
  clips,
  onPlay: playClip,
  onDownload: downloadClip,
});

// ---------- layout ----------

function layout() {
  const changed = [spectrumCanvas, spectrumOverlay, waterfallCanvas, waterfallOverlay, rulerCanvas]
    .map(resizeCanvasToDisplaySize)
    .some(Boolean);

  const r = dpr();
  const gl = Math.round(GUTTER_L * r);
  const pad = Math.round(6 * r);
  const plotW = Math.max(1, spectrumCanvas.width - gl - pad);

  spectrum.setRect(gl, pad, plotW, Math.max(1, spectrumCanvas.height - pad * 2));
  // No bottom gutter here: the ruler carries the frequency axis for both plates.
  waterfall.setRect(gl, 0, plotW, Math.max(1, waterfallCanvas.height));
  waterfall.background = theme.plotBg;
  ruler.setRect(gl, plotW);

  if (changed) {
    waterfall.invalidate();
    spectrum.resetPeaks();
    needsIdleDraw = true;
  }
}

const relayout = debounce(() => {
  theme = readTheme();
  waterfall.background = theme.plotBg;
  layout();
}, 80);

window.addEventListener('resize', relayout);
if (window.ResizeObserver) new ResizeObserver(relayout).observe(fieldView);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', relayout);

$('themeBtn').addEventListener('click', () => {
  applyTheme(currentThemeIsDark() ? 'light' : 'dark');
  theme = readTheme();
  waterfall.background = theme.plotBg;
  waterfall.invalidate();
  needsIdleDraw = true;
});

// ---------- controls ----------

function fillSelect(el, values, labelFor) {
  el.replaceChildren();
  for (const v of values) el.append(new Option(labelFor(v), String(v)));
}

fillSelect($('fftSize'), FFT_SIZES, (v) => String(v));
fillSelect($('waterfallSpan'), WATERFALL_SPANS, (v) => (v >= 60 ? `${v / 60} min` : `${v} s`));
fillSelect($('colorMap'), WATERFALL_MAPS, (v) => MAP_LABELS[v]);

for (const el of [$('minFreq'), $('maxFreq')]) el.max = String(FREQ_SLIDER_STEPS);

// Top of the span sliders and of every range clamp. Declared here because
// `syncControls` reads it on the first paint, before capture has started.
const nyq = () => (engine.running ? engine.nyquist : 24000);

function syncControls() {
  const s = settings.v;
  applySplit(s.platesSplit);
  const top = nyq();
  $('minFreq').value = String(freqToSlider(s.minFreq, top));
  $('maxFreq').value = String(freqToSlider(s.maxFreq, top));
  $('minFreqVal').value = formatFreq(s.minFreq);
  $('maxFreqVal').value = formatFreq(s.maxFreq);
  for (const btn of document.querySelectorAll('.seg-btn[data-scale]')) {
    const on = btn.dataset.scale === s.freqScale;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  $('minDb').value = String(s.minDb);
  $('maxDb').value = String(s.maxDb);
  $('minDbVal').value = `${s.minDb} dB`;
  $('maxDbVal').value = `${s.maxDb} dB`;
  $('fftSize').value = String(s.fftSize);
  $('smoothing').value = String(s.smoothing);
  $('smoothingVal').value = s.smoothing.toFixed(2);
  $('peakHold').checked = s.peakHold;
  $('peakDecay').value = String(s.peakDecay);
  $('peakDecayVal').value = `${s.peakDecay} dB/s`;
  $('waterfallOn').checked = s.waterfallOn;
  $('waterfallSpan').value = String(s.waterfallSpan);
  $('colorMap').value = s.colorMap;
  $('spectrumFill').checked = s.spectrumFill;
  $('showHearingBand').checked = s.showHearingBand;
  $('alarmVolume').value = String(s.alarmVolume);
  $('alarmVolumeVal').value = `${Math.round(s.alarmVolume * 100)}%`;
  $('alarmMuted').checked = s.alarmMuted;
  $('detectClips').checked = s.detectClips;
  const muteBtn = $('alarmMuteToggle');
  muteBtn.classList.toggle('on', s.alarmMuted);
  muteBtn.setAttribute('aria-pressed', String(s.alarmMuted));
  muteBtn.textContent = s.alarmMuted ? 'Alarms muted' : 'Mute alarms';

  fieldView.classList.toggle('no-waterfall', !s.waterfallOn);
}

settings.subscribe((s, tags) => {
  if (tags.has('analysis') || tags.has('all')) {
    engine.setFftSize(s.fftSize);
    engine.setSmoothing(s.smoothing);
  }
  if (tags.has('range') || tags.has('level') || tags.has('palette') || tags.has('all')) waterfall.invalidate();
  if (tags.has('range') || tags.has('all')) spectrum.resetPeaks();
  if (tags.has('detect') || tags.has('all')) syncDetection();
  syncControls();
  syncAlarmActions();
  needsIdleDraw = true;
});

// Each slider is clamped against the other rather than pushing it, so grabbing
// one edge of the span never drags the far edge along with it. `input` (not
// `change`) keeps the plates live during the drag — the waterfall repaints from
// its ring buffer, so nothing in the history is lost while scrubbing.
const commitFreqSlider = (edge) => {
  const top = nyq();
  const { minFreq, maxFreq } = settings.v;
  if (edge === 'min') {
    const lo = Math.min(sliderToFreq(Number($('minFreq').value), top), maxFreq - MIN_SPAN_HZ);
    settings.set({ minFreq: lo }, ['range']);
  } else {
    const hi = Math.max(sliderToFreq(Number($('maxFreq').value), top), minFreq + MIN_SPAN_HZ);
    settings.set({ maxFreq: hi }, ['range']);
  }
};
$('minFreq').addEventListener('input', () => commitFreqSlider('min'));
$('maxFreq').addEventListener('input', () => commitFreqSlider('max'));

for (const btn of document.querySelectorAll('.seg-btn[data-scale]')) {
  btn.addEventListener('click', () => settings.set({ freqScale: btn.dataset.scale }, ['range']));
}
for (const chip of document.querySelectorAll('.chip[data-span]')) {
  chip.addEventListener('click', () => {
    const [lo, hi] = chip.dataset.span.split(',').map(Number);
    settings.set({ minFreq: lo, maxFreq: hi }, ['range']);
  });
}

const applyZoom = (factor, anchorFreq) => {
  const next = zoomRange(settings.v, factor, anchorFreq, nyq(), MIN_SPAN_HZ);
  if (next) settings.set(next, ['range']);
};
const applyPan = (fraction) => settings.set(panRange(settings.v, fraction, nyq()), ['range']);

function midFreq() {
  const s = settings.v;
  return s.freqScale === 'log' ? Math.sqrt(s.minFreq * s.maxFreq) : (s.minFreq + s.maxFreq) / 2;
}

// The pad repeats the wheel/arrow-key gestures for touch. There is no pointer
// to anchor a zoom on, so it works from the middle of the current span.
$('panLeftBtn').addEventListener('click', () => applyPan(-0.1));
$('panRightBtn').addEventListener('click', () => applyPan(0.1));
$('zoomInBtn').addEventListener('click', () => applyZoom(0.8, midFreq()));
$('zoomOutBtn').addEventListener('click', () => applyZoom(1.25, midFreq()));

$('rangeReset').addEventListener('click', () =>
  settings.set({ minFreq: settings.defaults.minFreq, maxFreq: Math.min(settings.defaults.maxFreq, nyq()) }, ['range'])
);

$('minDb').addEventListener('input', (e) => settings.set({ minDb: Number(e.target.value) }, ['level']));
$('maxDb').addEventListener('input', (e) => settings.set({ maxDb: Number(e.target.value) }, ['level']));
$('autoLevel').addEventListener('click', fitLevelWindow);

function fitLevelWindow() {
  if (!latestData) return;
  const values = Array.from(latestData).filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length < 8) return;
  settings.set(
    {
      minDb: clamp(Math.round(values[Math.floor(values.length * 0.1)] - 6), -150, -35),
      maxDb: clamp(Math.round(values[values.length - 1] + 8), -100, 0),
    },
    ['level']
  );
}

$('fftSize').addEventListener('change', (e) => settings.set({ fftSize: Number(e.target.value) }, ['analysis']));
$('smoothing').addEventListener('input', (e) => settings.set({ smoothing: Number(e.target.value) }, ['analysis']));
$('peakHold').addEventListener('change', (e) => {
  settings.set({ peakHold: e.target.checked }, []);
  spectrum.resetPeaks();
});
$('peakDecay').addEventListener('input', (e) => settings.set({ peakDecay: Number(e.target.value) }, []));

$('waterfallOn').addEventListener('change', (e) => {
  settings.set({ waterfallOn: e.target.checked }, []);
  layout();
  waterfall.invalidate();
});
$('waterfallSpan').addEventListener('change', (e) => settings.set({ waterfallSpan: Number(e.target.value) }, []));
$('colorMap').addEventListener('change', (e) => settings.set({ colorMap: e.target.value }, ['palette']));
$('spectrumFill').addEventListener('change', (e) => settings.set({ spectrumFill: e.target.checked }, []));
$('showHearingBand').addEventListener('change', (e) => settings.set({ showHearingBand: e.target.checked }, []));
$('alarmVolume').addEventListener('input', (e) => settings.set({ alarmVolume: Number(e.target.value) }, []));
$('alarmMuted').addEventListener('change', (e) => settings.set({ alarmMuted: e.target.checked }, []));
$('alarmMuteToggle').addEventListener('click', () => settings.set({ alarmMuted: !settings.v.alarmMuted }, []));

// Muting is a stop button; this is the off switch. Nothing to confirm — the
// bells are still in the report and the Detection menu, one click each from
// being armed again. It covers detector bells too: one switch for every alarm.
$('alarmDisableAll').addEventListener('click', () => {
  const markersOff = markers.disableAllAlarms();
  const detectorsOff = disableDetectorAlarms();
  if (!markersOff && !detectorsOff) return;
  alarm.reset();
  needsIdleDraw = true;
});

// Only offer the bulk action when there is something to switch off.
function syncAlarmActions() {
  $('alarmDisableAll').disabled = markers.armedCount() === 0 && armedDetectorCount() === 0;
}
markers.subscribe(syncAlarmActions);
syncAlarmActions();

$('savePng').addEventListener('click', savePng);
$('resetAll').addEventListener('click', () => {
  settings.reset(['all']);
  spectrum.resetPeaks();
  waterfall.clear();
  layout();
});

// ---------- menus ----------

const menus = [...document.querySelectorAll('.menu')];
for (const menu of menus) {
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    for (const other of menus) if (other !== menu) other.open = false;
  });
}
document.addEventListener('pointerdown', (e) => {
  for (const menu of menus) if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const menu of menus) menu.open = false;
});

// ---------- sessions ----------

// A session is the storage the live state reads and writes, so switching one is
// just re-pointing both stores and repainting. Nothing is "saved" on the way
// out: every edit already went into the session it was made in.
function activateSession(id) {
  if (!sessions.has(id)) return;
  sessions.setActive(id);
  const keys = sessions.keysFor(id);
  teachCard.close(); // an unsaved recording belongs to the session it was made in
  history.clear(); // and so does what the sounds were matching
  sounds.useStorage(keys.sounds); // first, so the settings sync sees this session's catalog
  settings.useStorage(keys.settings); // notifies 'all' → controls, engine, plots
  markers.useStorage(keys.markers);
  alarm.reset();
  // Detections belong to the measurement they were heard in.
  detection.reset();
  detectLog.clear();
  syncDetectionsPanel();
  spectrum.resetPeaks();
  waterfall.clear();
  layout();
  renderSessions();
  needsIdleDraw = true;
}

function renderSessions() {
  const select = $('sessionSelect');
  const list = sessions.list();
  select.replaceChildren();
  for (const s of list) select.append(new Option(s.name, s.id));
  select.value = sessions.activeId;
  $('sessionName').textContent = sessions.active()?.name || '—';
  publisher?.heartbeat();
  // The roster can never be empty, so the last session cannot be deleted.
  $('sessionDelete').disabled = list.length <= 1;
}

// `updatedAt` is what orders the picker in a future listing and tells the user
// which session they were last in; it does not need to be written on every
// frame of a slider drag.
const touchSession = debounce(() => sessions.touch(), 600);
settings.subscribe(() => touchSession());
markers.subscribe(() => touchSession());
sounds.subscribe(() => touchSession());

$('sessionSelect').addEventListener('change', (e) => activateSession(e.target.value));

$('sessionNew').addEventListener('click', () => {
  const name = prompt('Name for the new session', sessions.uniqueName('Session'));
  if (name === null) return;
  activateSession(sessions.create(name).id);
});

$('sessionDuplicate').addEventListener('click', () => {
  const current = sessions.active();
  const name = prompt('Name for the copy', sessions.uniqueName(`${current.name} copy`));
  if (name === null) return;
  const copy = sessions.duplicate(current.id, name);
  if (copy) activateSession(copy.id);
});

$('sessionRename').addEventListener('click', () => {
  const current = sessions.active();
  const name = prompt('Rename this session', current.name);
  if (name === null) return;
  sessions.rename(current.id, name);
  renderSessions();
});

$('sessionDelete').addEventListener('click', () => {
  const current = sessions.active();
  if (sessions.list().length <= 1) return;
  if (!confirm(`Delete the session “${current.name}” with its settings, markers and learned sounds? This cannot be undone.`)) return;
  sessions.remove(current.id);
  activateSession(sessions.activeId); // remove() already moved us to a survivor
  renderSessions();
});

// ---------- export / import ----------

const DATA_HINT = $('dataHint').textContent;

/** Report the outcome of an export/import in place, then fade back to the hint. */
function dataNote(message, isError = false) {
  const el = $('dataHint');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  clearTimeout(dataNote.timer);
  dataNote.timer = setTimeout(() => {
    el.textContent = DATA_HINT;
    el.classList.remove('is-error');
  }, 6000);
}

$('exportData').addEventListener('click', () => {
  const data = sessions.exportAll({ theme: localStorage.getItem(THEME_KEY) || null });
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    `${timestampSlug('soundradar-data')}.json`
  );
  dataNote(`Exported ${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'}.`);
});

$('importData').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // so picking the same file twice fires the event twice
  if (!file) return;
  try {
    const { added } = sessions.importAll(await file.text());
    renderSessions();
    dataNote(`Imported ${added} session${added === 1 ? '' : 's'}. Pick one above to open it.`);
  } catch (err) {
    dataNote(err.message || 'That file could not be imported.', true);
  }
});

// ---------- report ----------

$('clearMarkers').addEventListener('click', () => {
  if (markers.markers.length && confirm('Remove all markers?')) markers.clear();
});
$('exportMarkers').addEventListener('click', () => {
  if (!markers.markers.length) return;
  downloadBlob(new Blob([markers.toCsv()], { type: 'text/csv' }), `${timestampSlug('soundradar-markers')}.csv`);
});
// In the report's header, and in the Analysis menu too: the report is hidden
// until there is a marker, which is exactly when this is most wanted.
function markHarmonics() {
  if (!dominant) return;
  const series = harmonics(dominant.freq, Math.min(settings.v.maxFreq, nyq()), 5);
  const entries = [
    { freq: dominant.freq, name: `${Math.round(dominant.freq)} Hz fundamental`, bw: settings.v.markerBw },
    ...series.map((h) => ({ freq: h.freq, name: `Harmonic ×${h.n}`, bw: settings.v.markerBw })),
  ];
  markers.addMany(entries);
}
$('markHarmonics').addEventListener('click', markHarmonics);
$('markHarmonicsMenu').addEventListener('click', markHarmonics);
$('reportToggle').addEventListener('click', () => {
  const collapsed = $('report').classList.toggle('collapsed');
  $('reportToggle').textContent = collapsed ? 'Show' : 'Hide';
  $('reportToggle').setAttribute('aria-expanded', String(!collapsed));
  requestAnimationFrame(layout);
});

// ---------- plates / reports splitter ----------

const MIN_PLATES_PX = 112;
const MIN_REPORTS_PX = 96;

function clampPlatesPx(px) {
  const max = window.innerHeight - document.querySelector('.bar').offsetHeight - MIN_REPORTS_PX;
  return clamp(px, MIN_PLATES_PX, Math.max(MIN_PLATES_PX, max));
}

function setPlatesPx(px) {
  document.body.classList.add('is-split');
  document.documentElement.style.setProperty('--plates-h', `${Math.round(clampPlatesPx(px))}px`);
}

/** @param {number} frac plates height as a fraction of the window; 0 = automatic */
function applySplit(frac) {
  if (!(frac > 0)) {
    document.body.classList.remove('is-split');
    return;
  }
  setPlatesPx(frac * window.innerHeight);
}

const splitter = $('splitter');
let splitDrag = null;
splitter.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('is-dragging');
  splitDrag = { y: e.clientY, h: fieldView.getBoundingClientRect().height };
});
splitter.addEventListener('pointermove', (e) => {
  if (splitDrag) setPlatesPx(splitDrag.h + e.clientY - splitDrag.y);
});
const endSplitDrag = () => {
  if (!splitDrag) return;
  splitDrag = null;
  splitter.classList.remove('is-dragging');
  settings.set({ platesSplit: fieldView.getBoundingClientRect().height / window.innerHeight }, []);
};
splitter.addEventListener('pointerup', endSplitDrag);
splitter.addEventListener('pointercancel', endSplitDrag);
splitter.addEventListener('dblclick', () => settings.set({ platesSplit: 0 }, []));
splitter.addEventListener('keydown', (e) => {
  const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
  if (!dir) return;
  e.preventDefault();
  const h = fieldView.getBoundingClientRect().height + dir * 24;
  settings.set({ platesSplit: clampPlatesPx(h) / window.innerHeight }, []);
});
window.addEventListener('resize', () => applySplit(settings.v.platesSplit));

// ---------- detection ----------

function setDetector(id, patch) {
  setDetectors([id], patch);
}

/** The same change to several detectors (a whole category) in one write. */
function setDetectors(ids, patch) {
  const next = { ...settings.v.detectors };
  for (const id of ids) next[id] = { ...next[id], ...patch };
  settings.set({ detectors: next }, ['detect']);
}

/** `settings.detectors` with the own threshold removed from those matching `inScope`. */
function withoutOwnThresholds(inScope) {
  const next = {};
  for (const [id, d] of Object.entries(settings.v.detectors)) {
    const { threshold, ...rest } = d;
    next[id] = inScope(id) ? rest : d;
  }
  return next;
}

// A wider slider writes over the narrower ones, so moving "all" really does
// apply to all: see detect/thresholds.js for the order they are read in.
function setGlobalThreshold(t) {
  settings.set(
    { detectThreshold: t, detectGroupThresholds: {}, detectors: withoutOwnThresholds(() => true) },
    ['detect']
  );
}

function setGroupThreshold(group, t) {
  const ids = new Set(catalog.filter((d) => groupOf(d) === group).map((d) => d.id));
  settings.set(
    {
      detectGroupThresholds: { ...settings.v.detectGroupThresholds, [group]: t },
      detectors: withoutOwnThresholds((id) => ids.has(id)),
    },
    ['detect']
  );
}

function armedDetectorCount() {
  return Object.values(settings.v.detectors).filter((d) => d.on && d.alarm).length;
}

/** Clear every detector bell in one settings write. Returns how many were armed. */
function disableDetectorAlarms() {
  const armed = armedDetectorCount();
  if (!Object.values(settings.v.detectors).some((d) => d.alarm)) return 0;
  const next = {};
  for (const [id, d] of Object.entries(settings.v.detectors)) next[id] = { ...d, alarm: false };
  settings.set({ detectors: next }, ['detect']);
  return armed;
}

/**
 * Bring the running detectors in line with settings. The classifier is only
 * loaded while a YAMNet category or a learned sound is on, or the teach card
 * is open, and dropped again when none is.
 */
function syncDetection() {
  detection.configure(settings.v.detectors, (def) => resolveThreshold(def, settings.v));
  syncBank();
  syncClassifier();
  // Off means keep nothing; on with no detector running just stops listening.
  if (!settings.v.detectClips) clips.disable();
  else if (detection.slots.size) clips.enable(engine);
  else clips.detach();
  detectMenu.sync(settings.v);
  detectMenu.setExpanded(settings.v.detectExpanded);
  syncDetectionsPanel();
}

// The log takes room from the plates, so it only shows while it has a job:
// something is switched on, or there is something in it to read.
function syncDetectionsPanel() {
  const show = detection.slots.size > 0 || detectLog.entries.length > 0;
  if ($('detections').hidden === show) $('detections').hidden = !show;
}

// The worker matches only the learned sounds that are on. The bank is sent
// again only when that set or their examples change — not on every move of a
// threshold slider, which also lands here.
let bankKey = '';
function syncBank() {
  const on = sounds.sounds.filter((s) => settings.v.detectors[s.id]?.on);
  const key = on.map((s) => `${s.id}:${s.examples.map((e) => `${e.at}/${e.vecs.length}`).join(',')}`).join('|');
  if (key === bankKey) return;
  bankKey = key;
  classifier.setBank(bankOf(on, (s) => sounds.vectorsOf(s)));
}

// An open teach card loads the model too, so it is ready by the time Record is
// pressed rather than swallowing the first seconds of the sound.
function syncClassifier() {
  if (detection.needsModel || teachCard.isOpen) classifier.enable(engine);
  else classifier.disable();
}

/**
 * The learned sounds changed (taught, renamed, given or stripped of examples,
 * deleted, or another session's): rebuild the catalog, the menu's My sounds
 * rows and the worker's bank, then let the settings decide what runs.
 */
function rebuildCatalog() {
  const learned = sounds.sounds.map(learnedDetector);
  catalog = withLearned(learned);
  detection.setCatalog(catalog);
  detectMenu.setLearned(learned);
  syncDetection(); // → syncBank()
  teachCard.refresh();
}
sounds.subscribe(rebuildCatalog);

/**
 * A learned sound as a file (sound-file.js): its examples and settings, and
 * what it detected and matched during this visit.
 */
function exportSound(id) {
  const sound = sounds.get(id);
  const def = catalog.find((d) => d.id === id);
  if (!sound || !def) return;
  const own = settings.v.detectors[id] || {};
  const threshold = resolveThreshold(def, settings.v);
  const releaseLevel = threshold * RELEASE_RATIO;
  const file = makeSoundFile({
    sound,
    settings: { on: own.on, alarm: own.alarm, threshold, ownThreshold: own.threshold, releaseLevel },
    detections: detectLog.entries.filter((e) => e.detectorId === id).reverse(),
    evidence: history.forSound(id, releaseLevel),
    now: performance.now(),
  });
  const slug = sound.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sound';
  downloadBlob(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }), `${timestampSlug(`soundradar-sound-${slug}`)}.json`);
}

/** Add a sound from a file: always a new sound, switched on, as it was set. */
async function importSound(file) {
  const msg = detectMenu.importMsg;
  try {
    const { sound, settings: set } = readSoundFile(await file.text());
    const added = sounds.add(sound.label, sound.examples);
    setDetector(added.id, { on: true, alarm: set.alarm, ...(Number.isFinite(set.threshold) ? { threshold: set.threshold } : {}) });
    const n = added.examples.length;
    msg.textContent = `Added “${added.label}” (${n} example${n === 1 ? '' : 's'}).${sounds.saveFailed ? ' Kept for this visit only: this browser’s storage is full.' : ''}`;
  } catch (err) {
    msg.textContent = err.message || 'That file could not be read.';
  }
}

/** Forget a learned sound and its switch, bell and threshold. */
function deleteSound(id) {
  sounds.remove(id);
  if (!(id in settings.v.detectors)) return;
  const next = { ...settings.v.detectors };
  delete next[id];
  settings.set({ detectors: next }, ['detect']);
}

function onDetection(kind, entry, def) {
  if (kind === 'start') {
    const s = settings.v;
    if (s.detectors[def.id]?.alarm && !s.alarmMuted) alarm.chime(s.alarmVolume);
    syncDetectionsPanel();
  }
  needsIdleDraw = true;
}

classifier.onwindow = (frame, t, silent) => {
  // A window can land just after a pause; it describes audio the user has
  // already stopped looking at.
  if (!engine.running || engine.paused) return;
  teach.push(frame.embedding, t, silent, frame.db);
  if (!silent) history.push(frame, t);
  // A sound being given another example must not log itself while it is.
  const taught = teachCard.recording ? teachCard.soundId : null;
  if (taught && frame.learned) frame = { ...frame, learned: { ...frame.learned, [taught]: 0 } };
  detection.updateModel(frame, t);
};
classifier.onstate = () => {
  detectMenu.setModel(classifier, engine.running && !engine.paused);
  teachCard.refresh();
};

// Removing records changes what the waterfall labels, and an empty log with
// nothing switched on no longer needs its panel.
detectLog.subscribe((kind) => {
  if (kind !== 'remove' && kind !== 'clear') return;
  syncDetectionsPanel();
  needsIdleDraw = true;
});

// ---------- publishing (opt-in, deployment config only) ----------
//
// Off in the repository. A deployment turns it on in js/config.local.js, which
// is the only way: there is no setting, because it is a property of where the
// app is hosted. Events and a heartbeat go to one MQTT broker (js/core/publish.js);
// while it is off the library is never fetched. A dot beside the session name
// shows that the app is publishing, and its connection state.

const CLIENT_KEY = 'soundradar.client.v1'; // like the theme: a property of the browser, not of a session

function clientId() {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/-/g, '').slice(0, 12);
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    return Math.random().toString(16).slice(2, 14);
  }
}

async function startPublishing() {
  let config = baseConfig.mqtt;
  try {
    const local = (await import('./config.local.js')).default;
    config = { ...config, ...(local?.mqtt || {}) };
  } catch {
    // No local override: the shipped default stands.
  }
  if (!config.enabled) return;

  const dot = document.createElement('span');
  dot.className = 'publish-dot';
  dot.textContent = ' ●';
  $('sessionName').after(dot);
  const colours = { connected: '#3c3', connecting: '#fb0', reconnecting: '#fb0', offline: '#888', error: '#f44' };

  publisher = new Publisher({
    config,
    client: clientId(),
    load: () => import('./vendor/mqtt.esm.js'),
    identity: () => ({
      session: sessions.active()?.name || '',
      host: location.host,
      agent: navigator.userAgent,
      detectors: Object.entries(settings.v.detectors || {}).filter(([, d]) => d.on).map(([id]) => id),
    }),
  });
  publisher.onstate = (status) => {
    dot.style.color = colours[status] || '#888';
    dot.title = `Publishing detections to ${config.url}: ${status}${publisher.error ? ` (${publisher.error})` : ''}`;
  };
  publisher.onstate(publisher.status);
  detectLog.subscribe((kind, entry) => {
    if (kind === 'add') publisher.event('start', entry);
    else if (kind === 'close') publisher.event('end', entry);
  });
  const beat = debounce(() => publisher.heartbeat(), 1000);
  settings.subscribe((_, tags) => {
    if (tags.has('detect') || tags.has('all')) beat();
  });
  addEventListener('pagehide', () => publisher.stop());
  publisher.start();
}
startPublishing();

// Same guard as the markers report: an overnight log is worth one question.
$('clearDetections').addEventListener('click', () => {
  const n = detectLog.entries.length;
  if (n && confirm(`Remove all ${n} detection${n === 1 ? '' : 's'}? Export them as CSV first to keep a copy.`)) {
    detectLog.clear();
  }
});
$('detectClips').addEventListener('change', (e) => settings.set({ detectClips: e.target.checked }, ['detect']));

// One shared player: starting a clip stops whichever was playing.
function playClip(id) {
  const clip = clips.get(id);
  if (!clip) return;
  if (detectionsTable.playingId === id && !clipPlayer.paused) {
    stopClip();
    return;
  }
  stopTake();
  clipPlayer.src = clip.url;
  // Over speakers the microphone hears the replay; it must not be logged as a
  // fresh detection. YAMNet scores arrive a window late, hence the margin.
  detection.quietUntil = performance.now() + clip.ms + 1500;
  clipPlayer.play().catch(() => stopClip());
  detectionsTable.setPlaying(id);
}

function stopClip() {
  if (!clipPlayer.paused) clipPlayer.pause();
  if (detectionsTable.playingId !== null) detection.quietUntil = performance.now() + 1500;
  detectionsTable.setPlaying(null);
}

clipPlayer.addEventListener('ended', stopClip);
// A clip that is dropped (row removed, log cleared, option off) stops playing.
clips.subscribe((id) => {
  if (id === detectionsTable.playingId && !clips.get(id)) stopClip();
});

function downloadClip(id) {
  const clip = clips.get(id);
  const entry = detectLog.entries.find((e) => e.id === id);
  if (!clip || !entry) return;
  const name = entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  downloadBlob(clip.blob, `${timestampSlug(`soundradar-${name}`, entry.wallStart)}.wav`);
}

$('exportDetections').addEventListener('click', () => {
  if (!detectLog.entries.length) return;
  downloadBlob(new Blob([detectLog.toCsv()], { type: 'text/csv' }), `${timestampSlug('soundradar-detections')}.csv`);
});
$('detectionsToggle').addEventListener('click', () => {
  const collapsed = $('detections').classList.toggle('collapsed');
  $('detectionsToggle').textContent = collapsed ? 'Show' : 'Hide';
  $('detectionsToggle').setAttribute('aria-expanded', String(!collapsed));
  requestAnimationFrame(layout);
});

// ---------- capture ----------

const RUN_LABEL = {
  idle: 'Start listening', requesting: 'Starting…', live: 'Pause', paused: 'Resume listening', error: 'Try again',
};

/** The Record button: white dot to start, white square and the clock while a take runs. */
function paintRecording() {
  const live = engine.running && !engine.paused;
  const btn = $('recBtn');
  btn.disabled = !live && !recorder.recording;
  btn.classList.toggle('is-recording', recorder.recording);
  btn.setAttribute('aria-pressed', String(recorder.recording));
  $('recLabel').textContent = recorder.recording ? formatClock(recorder.elapsedMs) : 'Record';
  btn.setAttribute('aria-label', recorder.recording ? 'Stop recording' : 'Record');
  $('menuRecordings').classList.toggle('is-recording', recorder.recording);
}

function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function paintState() {
  const state = engine.error ? 'error' : engine.state;
  const run = $('runBtn');
  run.classList.toggle('is-live', state === 'live');
  run.classList.toggle('is-paused', state === 'paused');
  $('runLabel').textContent = RUN_LABEL[state] || RUN_LABEL.idle;

  const curtain = $('curtain');
  if (engine.error) {
    curtain.classList.remove('hidden');
    curtain.classList.add('is-error');
    $('curtainTitle').textContent = 'Cannot reach the microphone';
    $('curtainBody').textContent = engine.error;
    $('curtainBtn').textContent = 'Try again';
  } else if (!engine.running) {
    curtain.classList.remove('hidden', 'is-error');
    $('curtainTitle').textContent = 'No signal yet';
    $('curtainBody').textContent =
      'Start listening to read the room. Audio is analysed in this tab and never leaves your device.';
    $('curtainBtn').textContent = 'Start listening';
  } else {
    curtain.classList.add('hidden');
  }
  paintRecording();
  syncControls();
  detectMenu.setModel(classifier, state === 'live');
  teachCard.refresh();
  // No more audio is coming: cut pending clips from what has arrived.
  if (state !== 'live') {
    clips.flush();
    recorder.stop(); // no more audio is coming: keep what there is
  }
  // Pausing suspends the context: one more frame lets the alarms notice and the
  // report drop their "sounding" flags.
  needsIdleDraw = true;
}

engine.onstatechange = paintState;

async function startCapture() {
  $('runBtn').disabled = true;
  $('runLabel').textContent = RUN_LABEL.requesting;
  try {
    const info = await engine.start($('deviceSelect').value || undefined);
    settings.setNyquist(engine.nyquist);
    engine.setFftSize(settings.v.fftSize);
    engine.setSmoothing(settings.v.smoothing);
    waterfall.clear();
    spectrum.resetPeaks();
    // The context exists now, so the classifier can tap it. Later restarts
    // (a device switch) keep the tap: the engine re-connects it.
    syncClassifier();
    if (settings.v.detectClips && detection.slots.size) clips.enable(engine);
    $('statusDevice').textContent = info.label || 'System default input';
    await refreshDevices();
  } catch {
    // Already reported through engine.error and paintState.
  } finally {
    $('runBtn').disabled = false;
    paintState();
  }
}

// ---------- recordings ----------

const takePlayer = new Audio();
const recordingsMenu = new RecordingsMenu({
  menuEl: $('menuRecordings'),
  listEl: $('recList'),
  badgeEl: $('recBadge'),
  msgEl: $('recMsg'),
  recorder,
  onPlay: playTake,
  onDownload: (id) => {
    const take = recorder.get(id);
    if (take) downloadBlob(take.blob, `${timestampSlug('soundradar-recording', take.wallStart)}.wav`);
  },
  onDelete: (id) => {
    if (recordingsMenu.playingId === id) stopTake();
    recorder.remove(id);
  },
});

function playTake(id) {
  const take = recorder.get(id);
  if (!take) return;
  if (recordingsMenu.playingId === id && !takePlayer.paused) return stopTake();
  stopClip();
  takePlayer.src = take.url;
  // The microphone hears the replay over speakers; it must not be logged.
  detection.quietUntil = performance.now() + take.ms + 1500;
  takePlayer.play().catch(() => stopTake());
  recordingsMenu.setPlaying(id);
}

function stopTake() {
  if (!takePlayer.paused) takePlayer.pause();
  if (recordingsMenu.playingId !== null) detection.quietUntil = performance.now() + 1500;
  recordingsMenu.setPlaying(null);
}

takePlayer.addEventListener('ended', stopTake);

$('recBtn').addEventListener('click', async () => {
  if (recorder.recording) recorder.stop();
  else await recorder.start(engine);
  if (recorder.error) $('menuRecordings').open = true;
  paintRecording();
});
recorder.subscribe(paintRecording);

// Takes live in memory only: say so before a reload throws them away.
addEventListener('beforeunload', (e) => {
  if (recorder.takes.length || recorder.recording) e.preventDefault();
});

$('runBtn').addEventListener('click', () => {
  if (!engine.running) return startCapture();
  if (engine.paused) engine.resume();
  else engine.pause();
});
$('curtainBtn').addEventListener('click', startCapture);
$('deviceSelect').addEventListener('change', () => {
  if (engine.running) startCapture();
});

async function refreshDevices() {
  const select = $('deviceSelect');
  try {
    const devices = await engine.listDevices();
    const current = select.value;
    select.replaceChildren(new Option('System default', ''));
    devices.forEach((d, i) => select.append(new Option(d.label || `Input ${i + 1}`, d.deviceId)));
    select.value = devices.some((d) => d.deviceId === current) ? current : '';
  } catch {
    /* enumeration before permission returns blank labels */
  }
}

navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
refreshDevices();

// ---------- interaction ----------

function rectFor(view) {
  if (view === 'spectrum') return spectrum.rect;
  if (view === 'waterfall') return waterfall.rect;
  return { x: ruler.rect.x, y: 0, w: ruler.rect.w, h: rulerCanvas.height };
}

function freqAt(view, x) {
  const rect = rectFor(view);
  return xToFreq(x, settings.v, rect.w, rect.x);
}

function attachPlate(el, view) {
  return new PlotInput(el, {
    onHover(x, y, evt) {
      hover = { view, x, y, clientX: evt.clientX, clientY: evt.clientY };
      needsIdleDraw = true;
      showTooltip();
    },
    onLeave() {
      hover = null;
      tooltip.classList.add('hidden');
      needsIdleDraw = true;
    },
    onPan(dxPixels) {
      const rect = rectFor(view);
      if (rect.w > 0) applyPan(dxPixels / rect.w);
    },
    onZoom(factor, anchorX) {
      applyZoom(factor, freqAt(view, anchorX));
    },
    onSelect(sel) {
      selection = sel ? { view, x0: sel.x0, x1: sel.x1 } : null;
      needsIdleDraw = true;
    },
    onSelectCommit(x0, x1) {
      const a = freqAt(view, x0);
      const b = freqAt(view, x1);
      const lo = Math.max(1, Math.min(a, b));
      const hi = Math.min(nyq(), Math.max(a, b));
      if (hi - lo >= MIN_SPAN_HZ) settings.set({ minFreq: lo, maxFreq: hi }, ['range']);
    },
    onAddMarker(x) {
      addMarkerAt(freqAt(view, x));
    },
    onPinchStart() {
      tooltip.classList.add('hidden');
    },
  });
}

attachPlate($('spectrumPlot'), 'spectrum');
attachPlate($('waterfallPlot'), 'waterfall');

// The ruler adds one thing the plates do not have: pins are grabbable there,
// so dragging anywhere on a plate always pans and never nudges a marker.
new PlotInput($('ruler'), {
  onHover(x, y, evt) {
    hover = { view: 'ruler', x, y, clientX: evt.clientX, clientY: evt.clientY };
    $('ruler').style.cursor = ruler.hitPin(x) != null ? 'grab' : 'ew-resize';
    needsIdleDraw = true;
  },
  onLeave() {
    hover = null;
    tooltip.classList.add('hidden');
    needsIdleDraw = true;
  },
  onPan(dxPixels) {
    if (ruler.rect.w > 0) applyPan(dxPixels / ruler.rect.w);
  },
  onZoom(factor, anchorX) {
    applyZoom(factor, freqAt('ruler', anchorX));
  },
  onAddMarker(x) {
    addMarkerAt(freqAt('ruler', x));
  },
  hitMarker(x) {
    return ruler.hitPin(x);
  },
  onMarkerDragStart(id) {
    highlightId = id;
    $('ruler').classList.add('dragging');
  },
  onMarkerDrag(id, x) {
    markers.update(id, { freq: clamp(freqAt('ruler', x), 1, nyq()) });
  },
  onMarkerDragEnd() {
    highlightId = null;
    $('ruler').classList.remove('dragging');
  },
});

function addMarkerAt(freq) {
  if (!Number.isFinite(freq)) return;
  markers.add(clamp(freq, 1, nyq()), { bw: settings.v.markerBw });
}

function showTooltip() {
  if (!hover) return;
  const rect = fieldView.getBoundingClientRect();
  const freq = freqAt(hover.view, hover.x);
  const lines = [`<b>${formatFreq(freq)}</b>`];

  if (hover.view === 'spectrum') {
    const db = spectrum.dbAtX(hover.x);
    if (Number.isFinite(db)) lines.push(`${db.toFixed(1)} dB`);
  } else if (hover.view === 'waterfall') {
    const sample = waterfall.sampleAt(hover.x, hover.y, settings.v, nyq());
    if (sample) lines.push(`${sample.db.toFixed(1)} dB`, `${formatAgo(sample.ago)} ago`);
  }

  tooltip.innerHTML = lines.join('<br>');
  tooltip.classList.remove('hidden');
  tooltip.style.left = `${clamp(hover.clientX - rect.left, 60, rect.width - 60)}px`;
  tooltip.style.top = `${clamp(hover.clientY - rect.top, 42, rect.height)}px`;
}

// ---------- overlays ----------

function drawMarkerBands(ctx, rect) {
  const s = settings.v;
  const r = dpr();
  ctx.save();
  for (const m of markers.markers) {
    const xc = freqToX(m.freq, s, rect.w, rect.x);
    if (xc < rect.x - 40 || xc > rect.x + rect.w + 40) continue;
    const x0 = freqToX(m.freq - m.bw / 2, s, rect.w, rect.x);
    const x1 = freqToX(m.freq + m.bw / 2, s, rect.w, rect.x);
    const active = m.id === highlightId;

    ctx.fillStyle = hexA(m.color, active ? 0.3 : 0.13);
    ctx.fillRect(x0, rect.y, Math.max(1.5 * r, x1 - x0), rect.h);

    ctx.strokeStyle = m.color;
    ctx.lineWidth = (active ? 2 : 1) * r;
    ctx.beginPath();
    ctx.moveTo(Math.round(xc) + 0.5, rect.y);
    ctx.lineTo(Math.round(xc) + 0.5, rect.y + rect.h);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCrosshair(ctx, rect, view) {
  if (!hover) return;
  const r = dpr();
  const x = hover.view === view ? hover.x : freqToX(freqAt(hover.view, hover.x), settings.v, rect.w, rect.x);
  ctx.save();
  ctx.strokeStyle = theme.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([2 * r, 3 * r]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, rect.y);
  ctx.lineTo(Math.round(x) + 0.5, rect.y + rect.h);
  if (hover.view === view && view === 'waterfall') {
    ctx.moveTo(rect.x, Math.round(hover.y) + 0.5);
    ctx.lineTo(rect.x + rect.w, Math.round(hover.y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function drawSelection(ctx, rect, view) {
  if (!selection || selection.view !== view) return;
  const x0 = Math.min(selection.x0, selection.x1);
  const x1 = Math.max(selection.x0, selection.x1);
  ctx.save();
  ctx.fillStyle = theme.selection;
  ctx.fillRect(x0, rect.y, x1 - x0, rect.h);
  ctx.strokeStyle = theme.selectionEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x0) + 0.5, rect.y + 0.5, Math.round(x1 - x0), rect.h - 1);
  ctx.restore();
}

function drawTimeAxis(ctx, rect) {
  const s = settings.v;
  const r = dpr();
  const step = [1, 2, 5, 10, 15, 30, 60, 120].find((c) => s.waterfallSpan / c <= 6) || 300;
  ctx.save();
  ctx.font = `600 ${10 * r}px ${theme.monoFont}`;
  ctx.fillStyle = theme.axisText;
  ctx.strokeStyle = theme.gridMinor;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let t = step; t < s.waterfallSpan; t += step) {
    const y = Math.round(rect.y + (t / s.waterfallSpan) * rect.h) + 0.5;
    ctx.beginPath();
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + 5 * r, y);
    ctx.stroke();
    ctx.fillText(formatAgo(t), rect.x - 6 * r, y);
  }
  ctx.restore();
}

/**
 * Detections on the waterfall, at the rows they were heard in: a bar in a lane
 * along the left edge spanning the event, a label at its start, and — for
 * detectors that know where in frequency they heard it — a trace at that
 * frequency. The waterfall is the history; this annotates it. Left, beside the
 * time axis the rows are read against, and clear of the zoom pad.
 */
function drawDetections(ctx, rect) {
  if (!detectLog.entries.length) return;
  const s = settings.v;
  const r = dpr();
  const lane = 4 * r;
  const laneX = rect.x + 6 * r; // past the time-axis tick marks
  const pad = 4 * r;
  const half = 8 * r;
  let lastLabelY = -Infinity;
  ctx.save();
  ctx.font = `600 ${10 * r}px ${theme.monoFont}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const e of detectLog.entries) {
    const top = waterfall.yForTime(e.open ? Infinity : e.t1);
    if (!Number.isFinite(top)) continue; // ended before the visible history
    const start = waterfall.yForTime(e.t0);
    const bottom = Number.isFinite(start) ? start : rect.y + rect.h;
    const h = Math.max(2 * r, bottom - top);
    const color = colorOfDetector(e.detectorId);

    ctx.fillStyle = color;
    ctx.fillRect(laneX, top, lane, h);
    if (Number.isFinite(e.freq)) {
      const x = freqToX(e.freq, s, rect.w, rect.x);
      if (x >= rect.x && x <= rect.x + rect.w) {
        ctx.globalAlpha = 0.8;
        ctx.fillRect(Math.round(x) - r, top, 2 * r, h);
        ctx.globalAlpha = 1;
      }
    }

    // Labels sit at the start of each event; one that would land on the
    // previous label is skipped rather than stacked illegibly.
    const ly = clamp(bottom - half, rect.y + half, rect.y + rect.h - half);
    if (Math.abs(ly - lastLabelY) < 2 * half) continue;
    lastLabelY = ly;
    const text = `${e.label} ${Math.round(e.confidence * 100)}%`;
    const boxW = ctx.measureText(text).width + 6 * r + 3 * pad;
    const bx = laneX + lane + 4 * r;
    ctx.fillStyle = theme.detChip;
    ctx.fillRect(bx, ly - half, boxW, 2 * half);
    ctx.fillStyle = color;
    ctx.fillRect(bx + pad, ly - 3 * r, 6 * r, 6 * r);
    ctx.fillStyle = theme.detChipText;
    ctx.fillText(text, bx + 2 * pad + 6 * r, ly);
  }
  ctx.restore();
}

/** The loudest peak: a small amber marker on the trace, with its frequency and level. */
function drawPeakMark(ctx, rect) {
  if (!dominant) return;
  const s = settings.v;
  const r = dpr();
  const x = freqToX(dominant.freq, s, rect.w, rect.x);
  if (x < rect.x || x > rect.x + rect.w) return;
  const y = dbToY(dominant.db, s.minDb, s.maxDb, rect.h, rect.y);
  const khz = dominant.freq >= 1000;
  const text = `${khz ? (dominant.freq / 1000).toFixed(3) + ' kHz' : dominant.freq.toFixed(1) + ' Hz'} · ${dominant.db.toFixed(1)} dB`;

  ctx.save();
  ctx.fillStyle = theme.peakMark;
  ctx.beginPath();
  ctx.moveTo(x, y - 3 * r);
  ctx.lineTo(x - 5 * r, y - 11 * r);
  ctx.lineTo(x + 5 * r, y - 11 * r);
  ctx.closePath();
  ctx.fill();

  ctx.font = `600 ${11 * r}px ${theme.monoFont}`;
  ctx.textBaseline = 'middle';
  const pad = 5 * r;
  const w = ctx.measureText(text).width + 2 * pad;
  const h = 16 * r;
  // Beside the triangle, to its right; to its left when there is no room.
  const gap = 4 * r;
  const bx = x + 5 * r + gap + w <= rect.x + rect.w ? x + 5 * r + gap : x - 5 * r - gap - w;
  const by = clamp(y - 7 * r - h / 2, rect.y + 2 * r, rect.y + rect.h - h - 2 * r);
  ctx.fillStyle = theme.detChip;
  ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = theme.peakMark;
  ctx.fillText(text, bx + pad, by + h / 2);
  ctx.restore();
}

function drawOverlay(ctx, canvas, rect, view) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawHearingBand(ctx, rect, settings.v, theme);
  if (view === 'waterfall') drawTimeAxis(ctx, rect);
  drawMarkerBands(ctx, rect);
  if (view === 'spectrum') drawPeakMark(ctx, rect);
  if (view === 'waterfall') drawDetections(ctx, rect);
  drawSelection(ctx, rect, view);
  drawCrosshair(ctx, rect, view);
}

function hexA(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ---------- readout ----------

/**
 * @param {boolean} force  redraw even inside the throttle window. A frame drawn
 *   only because something changed (a pause, a hover) may be the last one for a
 *   while, so the readout cannot be allowed to skip it and leave stale numbers
 *   — or a stale "sounding" flag — on screen.
 */
function updateReadout(now, force) {
  if (!force && now - lastReadoutAt < 100) return;
  lastReadoutAt = now;


  const levels = engine.getLevels();
  const vu = $('vuFill').parentElement;
  if (levels && Number.isFinite(levels.rms)) {
    const pct = (db) => `${(clamp((db + 60) / 60, 0, 1) * 100).toFixed(1)}%`;
    $('vuFill').style.width = pct(levels.rms);
    $('vuPeak').style.left = pct(levels.peak);
    $('vuLabel').textContent = levels.clipping ? 'Clipping' : `${levels.rms.toFixed(0)} dBFS`;
    vu.classList.toggle('clip', levels.clipping);
  } else {
    $('vuFill').style.width = '0%';
    $('vuPeak').style.left = '0%';
    $('vuLabel').textContent = '—';
    vu.classList.remove('clip');
  }

  table.update(settings.v, alarm.active);
  if (recorder.recording) paintRecording(); // the clock
  if ($('menuDetect').open) {
    detectMenu.update(detection);
    if (teachCard.recording) teachCard.refresh(); // the clock, even before any window arrives
    detectMenu.setModel(classifier, engine.running && !engine.paused);
  }
  if (!$('detections').hidden) detectionsTable.update();
}

// ---------- main loop ----------

function frame(now) {
  const s = settings.v;
  const live = engine.running && !engine.paused;
  latestData = engine.getFrequencyData();

  if (!live && !needsIdleDraw) {
    requestAnimationFrame(frame);
    return;
  }
  const idleDraw = needsIdleDraw;
  needsIdleDraw = false;

  spectrum.draw({
    data: latestData,
    settings: s,
    sampleRate: engine.sampleRate,
    fftSize: engine.fftSize,
    theme,
    now,
  });

  markers.updateLevels(latestData, engine.sampleRate, engine.fftSize, live);
  if (!live) detection.idle(now);
  else if (detection.needsSpectrum) {
    detection.updateSpectrum(detectTap.read(), engine.sampleRate, detectTap.fftSize, now);
  }
  alarm.update({
    markers: markers.markers,
    levelOf: (id) => markers.level(id),
    ceilingDb: s.maxDb,
    volume: s.alarmMuted ? 0 : s.alarmVolume,
    live,
  });
  dominant = latestData ? findDominantPeak(latestData, s, engine.sampleRate, engine.fftSize, s.minDb) : null;

  drawOverlay(spectrumOverlayCtx, spectrumOverlay, spectrum.rect, 'spectrum');

  if (s.waterfallOn) {
    const rows = live ? waterfall.push(now, latestData, s, engine.sampleRate, engine.fftSize) : 0;
    waterfall.draw(s, nyq(), rows);
    drawOverlay(waterfallOverlayCtx, waterfallOverlay, waterfall.rect, 'waterfall');
  }

  ruler.draw({
    settings: s,
    markers: markers.markers,
    theme,
    hoverFreq: hover ? freqAt(hover.view, hover.x) : NaN,
    selection: selection && selection.view === 'ruler' ? selection : null,
  });

  updateReadout(now, idleDraw);
  requestAnimationFrame(frame);
}

// ---------- export ----------

function savePng() {
  const gap = Math.round(4 * dpr());
  const wfH = settings.v.waterfallOn ? waterfallCanvas.height : 0;
  const out = document.createElement('canvas');
  out.width = spectrumCanvas.width;
  out.height = spectrumCanvas.height + rulerCanvas.height + (wfH ? gap + wfH : 0);
  const ctx = out.getContext('2d');
  ctx.fillStyle = theme.plotBg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(spectrumCanvas, 0, 0);
  ctx.drawImage(spectrumOverlay, 0, 0);

  // The ruler is drawn on paper, so it needs its own ground in the export.
  const rulerY = spectrumCanvas.height;
  ctx.fillStyle = theme.rulerBaseline;
  ctx.fillRect(0, rulerY, out.width, rulerCanvas.height);
  ctx.fillStyle = currentThemeIsDark() ? '#1e232b' : '#f4f6f8';
  ctx.fillRect(0, rulerY, out.width, rulerCanvas.height);
  ctx.drawImage(rulerCanvas, 0, rulerY);

  if (wfH) {
    ctx.drawImage(waterfallCanvas, 0, rulerY + rulerCanvas.height + gap);
    ctx.drawImage(waterfallOverlay, 0, rulerY + rulerCanvas.height + gap);
  }
  out.toBlob((blob) => {
    if (blob) downloadBlob(blob, `${timestampSlug('soundradar')}.png`);
  }, 'image/png');
}

// ---------- keyboard ----------

const TYPING = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

window.addEventListener('keydown', (e) => {
  if (TYPING.has(document.activeElement?.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case ' ':
      // Space presses whatever button or menu has focus — a row's ✕, a bell,
      // a toolbar button. Only on the page itself does it mean start/pause.
      if (document.activeElement?.closest('button, summary, a[href]')) return;
      e.preventDefault();
      if (!engine.running) startCapture();
      else if (engine.paused) engine.resume();
      else engine.pause();
      break;
    case 'm': case 'M':
      if (hover) addMarkerAt(freqAt(hover.view, hover.x));
      break;
    case 'ArrowLeft': e.preventDefault(); applyPan(-0.1); break;
    case 'ArrowRight': e.preventDefault(); applyPan(0.1); break;
    case '+': case '=': applyZoom(0.8, hover ? freqAt(hover.view, hover.x) : midFreq()); break;
    case '-': case '_': applyZoom(1.25, hover ? freqAt(hover.view, hover.x) : midFreq()); break;
    case 'h': case 'H':
      settings.set({ minFreq: settings.defaults.minFreq, maxFreq: Math.min(settings.defaults.maxFreq, nyq()) }, ['range']);
      break;
    case 'p': case 'P':
      settings.set({ peakHold: !settings.v.peakHold }, []);
      spectrum.resetPeaks();
      break;
    case 'f': case 'F': fitLevelWindow(); break;
    case 's': case 'S': savePng(); break;
    default: return;
  }
});

// ---------- boot ----------

const support = checkSupport();
if (!support.ok) engine.error = support.reason;

settings.setNyquist(24000);
renderSessions();
rebuildCatalog(); // → syncDetection()
layout();
syncControls();
paintState();
table.update(settings.v);
requestAnimationFrame(frame);

// Capture starts by itself. A browser lets the microphone open on page load
// but keeps the audio context suspended until the first gesture, so the first
// click, touch or key press wakes it.
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => engine.wake(), true);
if (support.ok) startCapture();
