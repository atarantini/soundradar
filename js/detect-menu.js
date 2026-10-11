// The Detect menu: the detectors of the catalog, listed by category, plus the
// classifier's model card.
//
// Each category heading is also its on/off switch: ticked when every detector
// in it is on, half-ticked when some are, and a click switches the whole
// category. Its state is read off the detectors, so there is nothing extra to
// save and it can never disagree with them.
//
// A category also folds away behind its ▾ button. Folding is only about what
// is on screen: it never switches anything, a folded heading still says how
// many of its sounds are on, and it lights up while one of them is sounding.
//
// Thresholds are set at three widths: one global slider (above the list), one
// per category (at the top of its body), and one per detector. The menu only
// reports a slider moving; what each width overwrites is decided by the app.
//
// Rows are built once — the catalog does not change at runtime — and mutated
// in place after that, so dragging a threshold slider is never interrupted by
// a rebuild triggered by the very setting it is changing.

import { groupOf, resolveThreshold, MIN_THRESHOLD, MAX_THRESHOLD } from './core/detect/thresholds.js';

/** A labelled threshold slider: `{ el, slider, value }`. */
function thresholdSlider(label, ariaLabel, onInput) {
  const el = document.createElement('label');
  el.className = 'det-all';
  const text = document.createElement('span');
  text.textContent = label;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(MIN_THRESHOLD);
  slider.max = String(MAX_THRESHOLD);
  slider.step = '0.05';
  slider.setAttribute('aria-label', ariaLabel);
  slider.addEventListener('input', () => onInput(Number(slider.value)));
  const value = document.createElement('output');
  value.className = 'num';
  el.append(text, slider, value);
  return { el, slider, value };
}

function showThreshold(ctl, t) {
  if (Number(ctl.slider.value) !== t) ctl.slider.value = String(t);
  ctl.value.value = `${Math.round(t * 100)}%`;
}

export class DetectMenu {
  /**
   * @param {object} o
   * @param {HTMLElement} o.listEl   container for the categories and their rows
   * @param {HTMLElement} o.badgeEl  count of detectors switched on
   * @param {HTMLElement} o.stateEl  the model card's status line
   * @param {object[]} o.catalog     already in category order
   * @param {(id:string)=>string} o.colorOf
   * @param {(id:string, patch:object)=>void} o.onChange
   * @param {(ids:string[], patch:object)=>void} o.onChangeMany  one write for a category
   * @param {(collapsed:string[])=>void} [o.onCollapse] the user folded or unfolded one
   * @param {HTMLElement} [o.globalEl]  where the all-detectors threshold slider goes
   * @param {(t:number)=>void} [o.onGlobalThreshold]
   * @param {(group:string, t:number)=>void} [o.onGroupThreshold]
   */
  constructor({
    listEl, badgeEl, stateEl, catalog, colorOf, onChange, onChangeMany, onCollapse,
    globalEl, onGlobalThreshold, onGroupThreshold,
  }) {
    this.badgeEl = badgeEl;
    this.stateEl = stateEl;
    this.catalog = catalog;
    this.onChange = onChange;
    this.onChangeMany = onChangeMany;
    this.onCollapse = onCollapse;
    this.onGroupThreshold = onGroupThreshold;
    this.global = thresholdSlider('All sounds', 'Detection threshold for every sound', (t) => onGlobalThreshold?.(t));
    globalEl?.append(this.global.el);
    this.rows = new Map();
    this.groups = new Map(); // name → { head, box, count, toggle, body, ids, on, collapsed }
    let group = null;
    for (const def of catalog) {
      const name = groupOf(def);
      if (name !== group) {
        group = name;
        this.groups.set(name, this._heading(name, listEl));
      }
      const g = this.groups.get(name);
      g.ids.push(def.id);
      const row = this._row(def, colorOf(def.id));
      g.body.append(row.el);
      this.rows.set(def.id, row);
    }
  }

  _heading(name, listEl) {
    const head = document.createElement('div');
    head.className = 'det-group';

    // The switch: the box and the category's name.
    const label = document.createElement('label');
    label.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('aria-label', `All ${name.toLowerCase()} detectors`);
    const title = document.createElement('span');
    title.className = 'tag';
    title.textContent = name;
    label.append(box, title);

    const count = document.createElement('span');
    count.className = 'det-group-count';

    // The fold: a separate button, so folding never toggles the switch.
    const body = document.createElement('div');
    body.className = 'det-group-body';
    body.id = `det-cat-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'icon-cell det-group-toggle';
    toggle.setAttribute('aria-controls', body.id);

    head.append(label, count, toggle);
    listEl.append(head, body);
    const all = thresholdSlider(
      `All ${name.toLowerCase()}`,
      `Detection threshold for every ${name.toLowerCase()} sound`,
      (t) => this.onGroupThreshold?.(name, t)
    );
    body.append(all.el);
    const group = { name, head, box, count, toggle, body, all, ids: [], on: 0, collapsed: false };
    // An indeterminate box comes back checked from a click: some on → all on.
    box.addEventListener('change', () => this.onChangeMany(group.ids, { on: box.checked }));
    toggle.addEventListener('click', () => {
      this._fold(group, !group.collapsed);
      this.onCollapse?.(this.collapsed());
    });
    this._fold(group, false);
    return group;
  }

  _fold(group, collapsed) {
    group.collapsed = collapsed;
    group.body.hidden = collapsed;
    group.head.classList.toggle('is-collapsed', collapsed);
    group.toggle.textContent = collapsed ? '▸' : '▾';
    group.toggle.setAttribute('aria-expanded', String(!collapsed));
    const label = `${collapsed ? 'Show' : 'Hide'} the ${group.name.toLowerCase()} detectors`;
    group.toggle.title = label;
    group.toggle.setAttribute('aria-label', label);
    this._count(group);
  }

  _count(group) {
    const m = group.ids.length;
    group.count.textContent = group.on
      ? `${group.on} of ${m} on`
      : group.collapsed ? `${m} sound${m === 1 ? '' : 's'}` : '';
  }

  /** Names of the folded categories, for saving. */
  collapsed() {
    return [...this.groups.values()].filter((g) => g.collapsed).map((g) => g.name);
  }

  /** Fold exactly these categories — a session's saved state. */
  setCollapsed(names = []) {
    for (const g of this.groups.values()) {
      if (g.collapsed !== names.includes(g.name)) this._fold(g, !g.collapsed);
    }
  }

  _row(def, color) {
    const el = document.createElement('div');
    el.className = 'det-row is-off';
    el.style.setProperty('--det-color', color);

    const label = document.createElement('label');
    label.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const swatch = document.createElement('span');
    swatch.className = 'det-swatch';
    const name = document.createElement('span');
    name.textContent = def.label;
    label.append(box, swatch, name);
    if (def.source === 'spectrum') {
      // Pattern rules read the spectrum directly: no model to load.
      const kind = document.createElement('span');
      kind.className = 'det-kind';
      kind.textContent = 'instant';
      kind.title = 'A pattern rule: works at once, without the sound classifier';
      label.append(kind);
    }
    box.addEventListener('change', () => this.onChange(def.id, { on: box.checked }));

    const desc = document.createElement('p');
    desc.className = 'hint det-desc';
    desc.textContent = def.description;

    const tune = document.createElement('div');
    tune.className = 'det-tune';
    const meter = document.createElement('div');
    meter.className = 'det-meter';
    meter.title = 'How sure the detector is right now';
    const fill = document.createElement('div');
    fill.className = 'det-meter-fill';
    const mark = document.createElement('div');
    mark.className = 'det-meter-mark';
    meter.append(fill, mark);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.05';
    slider.max = '0.95';
    slider.step = '0.05';
    slider.setAttribute('aria-label', `${def.label} detection threshold`);
    slider.title = 'Detection threshold';
    slider.addEventListener('input', () => this.onChange(def.id, { threshold: Number(slider.value) }));

    const value = document.createElement('output');
    value.className = 'num';

    const bell = document.createElement('button');
    bell.type = 'button';
    bell.className = 'icon-cell alarm-bell';
    bell.textContent = '◉';
    const bellLabel = `Chime when ${def.label.toLowerCase()} is detected`;
    bell.title = bellLabel;
    bell.setAttribute('aria-label', bellLabel);
    bell.addEventListener('click', () => this.onChange(def.id, { alarm: bell.getAttribute('aria-pressed') !== 'true' }));

    tune.append(meter, slider, value, bell);
    el.append(label, desc, tune);
    return { el, def, box, fill, mark, slider, value, bell, shown: NaN };
  }

  /**
   * Reflect the settings — checkboxes, thresholds, bells, badge.
   * @param {object} s  `{ detectors, detectThreshold, detectGroupThresholds }`
   */
  sync(s) {
    const config = s.detectors;
    let on = 0;
    showThreshold(this.global, resolveThreshold({ id: '', group: '' }, { ...s, detectGroupThresholds: {} }));
    for (const [id, row] of this.rows) {
      const c = config[id] || {};
      const threshold = resolveThreshold(row.def, s);
      row.box.checked = Boolean(c.on);
      row.el.classList.toggle('is-off', !c.on);
      if (Number(row.slider.value) !== threshold) row.slider.value = String(threshold);
      row.value.value = `${Math.round(threshold * 100)}%`;
      row.mark.style.left = `${(threshold * 100).toFixed(1)}%`;
      row.bell.classList.toggle('on', Boolean(c.alarm));
      row.bell.setAttribute('aria-pressed', String(Boolean(c.alarm)));
      if (c.on) on++;
    }
    for (const g of this.groups.values()) {
      showThreshold(g.all, resolveThreshold({ id: '', group: g.name }, { ...s, detectors: {} }));
      g.on = g.ids.filter((id) => config[id]?.on).length;
      g.box.checked = g.on === g.ids.length;
      g.box.indeterminate = g.on > 0 && g.on < g.ids.length;
      this._count(g);
    }
    this.badgeEl.textContent = String(on);
    this.badgeEl.hidden = on === 0;
  }

  /**
   * Live meters, at the readout's cadence.
   * @param {import('./core/detect/engine.js').DetectionEngine} engine
   */
  update(engine) {
    for (const [id, row] of this.rows) {
      const score = engine.scores.get(id);
      const pct = Number.isFinite(score) ? Math.round(score * 1000) / 10 : 0;
      if (pct !== row.shown) {
        row.fill.style.width = `${pct}%`;
        row.shown = pct;
      }
      row.el.classList.toggle('is-active', engine.active.has(id));
    }
    // A folded category still shows that something in it is sounding.
    for (const g of this.groups.values()) {
      g.head.classList.toggle('is-active', g.ids.some((id) => engine.active.has(id)));
    }
  }

  /**
   * The model card's status line.
   * @param {import('./core/detect/yamnet.js').YamnetClassifier} classifier
   * @param {boolean} listening capture is running
   */
  setModel(classifier, listening) {
    const el = this.stateEl;
    el.classList.toggle('is-ready', classifier.state === 'ready');
    el.classList.toggle('is-error', classifier.state === 'error');
    if (classifier.state === 'loading') {
      el.textContent = 'Loading the model…';
    } else if (classifier.state === 'ready') {
      const speed = Number.isFinite(classifier.ms) ? ` · ${Math.round(classifier.ms)} ms per window` : '';
      const backend = classifier.backend === 'webgl' ? 'GPU' : classifier.backend.toUpperCase();
      el.textContent = listening
        ? `Listening · ${backend}${speed}`
        : `Ready · ${backend} · start capture to listen`;
    } else if (classifier.state === 'error') {
      el.textContent = `Could not run the classifier: ${classifier.error}`;
    } else {
      el.textContent = 'Not loaded — switch on a sound below to load it.';
    }
  }
}
