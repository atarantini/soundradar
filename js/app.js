// SoundRadar — composition root.
//
// Owns the settings, wires the toolbar menus, and drives the single animation
// frame loop that redraws both plates, the shared ruler, and the report.

import { AudioEngine, FFT_SIZES, checkSupport } from './core/audio.js';
import { Settings, WATERFALL_SPANS, MIN_SPAN_HZ } from './core/settings.js';
import { MarkerStore } from './core/markers.js';
import { SpectrumView } from './core/spectrum.js';
import { Waterfall } from './core/waterfall.js';
import { PlotInput, zoomRange, panRange } from './core/input.js';
import { drawHearingBand } from './core/reference.js';
import {
  freqToX, xToFreq, findDominantPeak,
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

const GUTTER_L = 44; // CSS px reserved for the dB / time axis on each plate
const THEME_KEY = 'soundradar.theme';

const PALETTE = ['#2a3fd4', '#0f9d58', '#d4762a', '#8e44c4', '#c02b5e', '#0d8ea8', '#7a8c1f', '#b8342b'];

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

const settings = new Settings('soundradar.settings.v1', { colorMap: 'viridis', freqScale: 'linear' });
const engine = new AudioEngine();
const markers = new MarkerStore({ storageKey: 'soundradar.markers.v1', palette: PALETTE });

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
  bodyEl: $('markerRows'),
  emptyEl: $('markersEmpty'),
  countEl: $('markerCount'),
  store: markers,
  onSelect: (id) => {
    highlightId = id;
    needsIdleDraw = true;
  },
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

  fieldView.classList.toggle('no-waterfall', !s.waterfallOn);
  $('roBin').textContent = engine.running ? `${engine.binHz.toFixed(1)} Hz` : '—';
  $('binHint').textContent = engine.running
    ? `At ${s.fftSize} points and ${(engine.sampleRate / 1000).toFixed(1)} kHz, each bin covers ${engine.binHz.toFixed(1)} Hz.`
    : 'Larger FFT sizes resolve closer frequencies but react more slowly.';
}

settings.subscribe((s, tags) => {
  if (tags.has('analysis') || tags.has('all')) {
    engine.setFftSize(s.fftSize);
    engine.setSmoothing(s.smoothing);
  }
  if (tags.has('range') || tags.has('level') || tags.has('palette') || tags.has('all')) waterfall.invalidate();
  if (tags.has('range') || tags.has('all')) spectrum.resetPeaks();
  syncControls();
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

// ---------- report ----------

$('clearMarkers').addEventListener('click', () => {
  if (markers.markers.length && confirm('Remove all markers?')) markers.clear();
});
$('exportMarkers').addEventListener('click', () => {
  if (!markers.markers.length) return;
  downloadBlob(new Blob([markers.toCsv()], { type: 'text/csv' }), `${timestampSlug('soundradar-markers')}.csv`);
});
$('markHarmonics').addEventListener('click', () => {
  if (!dominant) return;
  const series = harmonics(dominant.freq, Math.min(settings.v.maxFreq, nyq()), 5);
  const entries = [
    { freq: dominant.freq, name: `${Math.round(dominant.freq)} Hz fundamental`, bw: settings.v.markerBw },
    ...series.map((h) => ({ freq: h.freq, name: `Harmonic ×${h.n}`, bw: settings.v.markerBw })),
  ];
  markers.addMany(entries);
});
$('reportToggle').addEventListener('click', () => {
  const collapsed = $('report').classList.toggle('collapsed');
  $('reportToggle').textContent = collapsed ? 'Show' : 'Hide';
  $('reportToggle').setAttribute('aria-expanded', String(!collapsed));
  requestAnimationFrame(layout);
});

// ---------- capture ----------

const RUN_LABEL = { idle: 'Start capture', requesting: 'Starting…', live: 'Pause', paused: 'Resume', error: 'Try again' };

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
      'Start capture to read the room. Audio is analysed in this tab and never leaves your device.';
    $('curtainBtn').textContent = 'Start capture';
  } else {
    curtain.classList.add('hidden');
  }
  syncControls();
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
    $('statusDevice').textContent = info.label || 'System default input';
    await refreshDevices();
  } catch {
    // Already reported through engine.error and paintState.
  } finally {
    $('runBtn').disabled = false;
    paintState();
  }
}

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

function drawOverlay(ctx, canvas, rect, view) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawHearingBand(ctx, rect, settings.v, theme);
  if (view === 'waterfall') drawTimeAxis(ctx, rect);
  drawMarkerBands(ctx, rect);
  drawSelection(ctx, rect, view);
  drawCrosshair(ctx, rect, view);
}

function hexA(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ---------- readout ----------

function updateReadout(now) {
  if (now - lastReadoutAt < 100) return;
  lastReadoutAt = now;

  if (dominant) {
    const khz = dominant.freq >= 1000;
    $('peakFreq').textContent = khz ? (dominant.freq / 1000).toFixed(3) : dominant.freq.toFixed(1);
    $('peakUnit').textContent = khz ? 'kHz' : 'Hz';
    $('peakLevel').textContent = `${dominant.db.toFixed(1)} dB`;
  } else {
    $('peakFreq').textContent = '—';
    $('peakUnit').textContent = '';
    $('peakLevel').textContent = '—';
  }
  $('roBin').textContent = engine.running ? `${engine.binHz.toFixed(1)} Hz` : '—';

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

  table.update(settings.v);
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

  updateReadout(now);
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
layout();
syncControls();
paintState();
table.update(settings.v);
requestAnimationFrame(frame);
