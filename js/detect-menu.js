// The Detect menu: one row per detector in the catalog, plus the classifier's
// model card.
//
// Rows are built once — the catalog does not change at runtime — and mutated
// in place after that, so dragging a threshold slider is never interrupted by
// a rebuild triggered by the very setting it is changing.

export class DetectMenu {
  /**
   * @param {object} o
   * @param {HTMLElement} o.rulesEl  container for 'spectrum' detectors
   * @param {HTMLElement} o.modelEl  container for 'yamnet' detectors
   * @param {HTMLElement} o.badgeEl  count of detectors switched on
   * @param {HTMLElement} o.stateEl  the model card's status line
   * @param {object[]} o.catalog
   * @param {(id:string)=>string} o.colorOf
   * @param {(id:string, patch:object)=>void} o.onChange
   */
  constructor({ rulesEl, modelEl, badgeEl, stateEl, catalog, colorOf, onChange }) {
    this.badgeEl = badgeEl;
    this.stateEl = stateEl;
    this.catalog = catalog;
    this.onChange = onChange;
    this.rows = new Map();
    const lastGroup = new Map(); // container → the group heading it ended on
    for (const def of catalog) {
      const container = def.source === 'yamnet' ? modelEl : rulesEl;
      // Catalog entries that share a `group` sit under one small heading.
      if (def.group && lastGroup.get(container) !== def.group) {
        const heading = document.createElement('p');
        heading.className = 'tag det-group';
        heading.textContent = def.group;
        container.append(heading);
      }
      lastGroup.set(container, def.group);
      const row = this._row(def, colorOf(def.id));
      container.append(row.el);
      this.rows.set(def.id, row);
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
