// The capture tap: raw samples off the shared graph, at a fixed hop.
//
// The analyser is right for drawing and wrong for recognition. It is read
// once per animation frame, which is neither a constant hop nor running at all
// in a background tab, and its frames are windowed, smoothed and in dB. A
// recognizer wants the plain waveform at a steady rate, so this hangs an
// AudioWorkletNode off the same source as the analyser and streams what it
// hears over a MessagePort.
//
// The port goes to the consumer — a Worker, normally — so audio crosses from
// the rendering thread to the worker without touching the main thread.
// Pausing capture suspends the context, which stalls the worklet: no samples,
// no work, nothing to tear down.

const WORKLET_URL = new URL('./capture-worklet.js', import.meta.url);
const loaded = new WeakSet(); // contexts that already have the worklet module

export class CaptureTap {
  /** @param {object} [o] @param {number} [o.chunk] samples per message */
  constructor({ chunk = 4096 } = {}) {
    this.chunk = chunk;
    this.node = null;
    this.engine = null;
  }

  get attached() {
    return this.node !== null;
  }

  /**
   * Attach to a running engine.
   * @param {import('./audio.js').AudioEngine} engine
   * @returns {Promise<{ port: MessagePort, sampleRate: number }>} the receiving end
   */
  async open(engine) {
    const ctx = engine.ctx;
    if (!ctx?.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      throw new Error('This browser cannot tap raw audio (no AudioWorklet support).');
    }
    if (!loaded.has(ctx)) {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      loaded.add(ctx);
    }
    this.close();
    this.node = new AudioWorkletNode(ctx, 'soundradar-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { chunk: this.chunk },
    });
    const channel = new MessageChannel();
    this.node.port.postMessage({ type: 'port', port: channel.port1 }, [channel.port1]);
    this.engine = engine;
    engine.addTap(this.node);
    return { port: channel.port2, sampleRate: ctx.sampleRate };
  }

  close() {
    if (!this.node) return;
    this.engine?.removeTap(this.node);
    this.node.port.postMessage({ type: 'close' });
    this.node = null;
    this.engine = null;
  }
}
