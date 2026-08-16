// Canvas colours read from the stylesheet, so the plates track the theme
// toggle without any values being written twice.

import { cssVar } from './core/util.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function readTheme() {
  const accent = cssVar('--accent', '#2a3fd4');
  return {
    plotBg: cssVar('--plate', '#0c1016'),
    gridMajor: cssVar('--plate-grid', 'rgba(226,232,240,0.11)'),
    gridMinor: cssVar('--plate-grid-2', 'rgba(226,232,240,0.05)'),
    axisText: cssVar('--plate-text', 'rgba(226,232,240,0.7)'),
    axisTick: cssVar('--plate-text', 'rgba(226,232,240,0.7)'),
    axisTickMinor: cssVar('--plate-grid', 'rgba(226,232,240,0.11)'),
    axisFont: MONO,
    axisWeight: 600,
    monoFont: MONO,

    trace: cssVar('--plate-trace', '#8ea6ff'),
    traceGlow: '',
    traceFillTop: cssVar('--plate-fill', 'rgba(142,166,255,0.2)'),
    traceFillBottom: 'rgba(142,166,255,0.01)',
    peak: cssVar('--plate-peak', 'rgba(142,166,255,0.45)'),
    persistence: cssVar('--plate-peak', 'rgba(142,166,255,0.45)'),

    crosshair: 'rgba(255, 255, 255, 0.55)',
    selection: 'rgba(125, 144, 255, 0.22)',
    selectionEdge: '#8ea6ff',
    outsideHearing: 'rgba(0, 0, 0, 0.45)',

    // Ruler lives on paper, so it uses the ink palette rather than the plate's.
    rulerText: cssVar('--ink-2', '#4c5867'),
    rulerTick: cssVar('--rule-2', '#a3adba'),
    rulerTickMinor: cssVar('--rule', '#ccd2da'),
    rulerBaseline: cssVar('--rule', '#ccd2da'),
    rulerCaret: accent,
  };
}
