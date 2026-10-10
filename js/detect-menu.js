// The Detect menu: the detectors of the catalog, listed by category, plus the
// classifier's model card.
//
// Each category heading is also its on/off switch: ticked when every detector
// in it is on, half-ticked when some are, and a click switches the whole
// category. Its state is read off the detectors, so there is nothing extra to
// save and it can never disagree with them.
//
// Rows are built once — the catalog does not change at runtime — and mutated
// in place after that, so dragging a threshold slider is never interrupted by
// a rebuild triggered by the very setting it is changing.

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
   */
  constructor({ listEl, badgeEl, stateEl, catalog, colorOf, onChange, onChangeMany }) {
    this.badgeEl = badgeEl;
    this.stateEl = stateEl;
    this.catalog = catalog;
    this.onChange = onChange;
    this.onChangeMany = onChangeMany;
    this.rows = new Map();
    this.groups = new Map(); // name → { box, count, ids }
    let group = null;
    for (const def of catalog) {
      const name = def.group || 'Other';
      if (name !== group) {
        group = name;
        this.groups.set(name, this._heading(name, listEl));
      }
      this.groups.get(name).ids.push(def.id);
      const row = this._row(def, colorOf(def.id));
      listEl.append(row.el);
      this.rows.set(def.id, row);
    }
  }

  _heading(name, listEl) {
    const label = document.createElement('label');
    label.className = 'check det-group';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('aria-label', `All ${name.toLowerCase()} detectors`);
    const title = document.createElement('span');
    title.className = 'tag';
    title.textContent = name;
    const count = document.createElement('span');
    count.className = 'det-group-count';
    label.append(box, title, count);
    listEl.append(label);
    const group = { box, count, ids: [] };
    // An indeterminate box comes back checked from a click: some on → all on.
    box.addEventListener('change', () => this.onChangeMany(group.ids, { on: box.checked }));
    return group;
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

  /** Reflect `settings.detectors` — checkboxes, thresholds, bells, badge. */
  sync(config) {
    let on = 0;
    for (const [id, row] of this.rows) {
      const c = config[id] || {};
      const threshold = Number.isFinite(c.threshold) ? c.threshold : row.def.threshold;
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
      const n = g.ids.filter((id) => config[id]?.on).length;
      g.box.checked = n === g.ids.length;
      g.box.indeterminate = n > 0 && n < g.ids.length;
      g.count.textContent = n ? `${n} of ${g.ids.length} on` : '';
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
