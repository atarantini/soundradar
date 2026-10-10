// Streaming sample-rate conversion, any rate to any rate.
//
// The device decides `AudioContext.sampleRate` (usually 48 kHz, sometimes
// 44.1), while a pretrained model wants exactly the rate it was trained at —
// 16 kHz for YAMNet. This is a windowed-sinc interpolator: a low-pass at 45% of
// the lower rate, evaluated at each output sample's fractional position in the
// input. It keeps its tail between calls, so audio can be fed in arbitrary
// chunks with no seams. Used inside a Worker, which is why it is
// self-contained rather than going through OfflineAudioContext (async,
// allocation-heavy, and not available off the main thread).

const TABLE_RES = 128; // kernel samples per input sample

export class Resampler {
  /**
   * @param {number} fromRate input rate in Hz
   * @param {number} toRate   output rate in Hz
   * @param {object} [o]
   * @param {number} [o.zeros] kernel half-width in zero crossings of the low-pass
   */
  constructor(fromRate, toRate, { zeros = 12 } = {}) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.step = fromRate / toRate; // input samples per output sample
    // Cut-off in cycles per input sample. Below either Nyquist, with margin so
    // the window's transition band does not fold back.
    const fc = (0.45 * Math.min(fromRate, toRate)) / fromRate;
    this.half = Math.ceil(zeros / (2 * fc)); // kernel half-width, input samples

    const n = this.half * TABLE_RES;
    this.table = new Float32Array(n + 2);
    for (let i = 0; i <= n; i++) {
      const t = i / TABLE_RES;
      const x = 2 * fc * t;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = t / this.half; // 0 … 1
      const blackman = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      this.table[i] = 2 * fc * sinc * blackman;
    }
    this.reset();
  }

  reset() {
    // `half` samples of silence in front, so the first output has history.
    this.buf = new Float32Array(this.half);
    this.pos = this.half; // input index of the next output sample
  }

  _kernel(distance) {
    const x = distance * TABLE_RES;
    const i = x | 0;
    if (i >= this.table.length - 1) return 0;
    const f = x - i;
    return this.table[i] * (1 - f) + this.table[i + 1] * f;
  }

  /**
   * @param {Float32Array} input
   * @returns {Float32Array} as many output samples as the input allows
   */
  process(input) {
    const buf = new Float32Array(this.buf.length + input.length);
    buf.set(this.buf);
    buf.set(input, this.buf.length);

    const half = this.half;
    const room = buf.length - half - this.pos;
    const out = new Float32Array(Math.max(0, Math.ceil(room / this.step)));
    let count = 0;
    let pos = this.pos;
    while (pos + half < buf.length && count < out.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      let acc = 0;
      for (let k = 1 - half; k <= half; k++) {
        acc += buf[i0 + k] * this._kernel(Math.abs(k - frac));
      }
      out[count++] = acc;
      pos += this.step;
    }

    // Keep only what the next call's first output can still reach.
    const keepFrom = Math.max(0, Math.floor(pos) - half);
    this.buf = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    return count === out.length ? out : out.subarray(0, count);
  }
}
