// AudioWorklet side of the capture tap (see capture.js).
//
// Runs on the audio rendering thread. It copies each 128-sample quantum into
// a larger chunk and posts the chunk, with its buffer transferred, to whoever
// holds the other end of the port it was handed. Nothing else — no analysis
// here, because a missed render deadline is an audible glitch for everything
// else on the context.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options?.processorOptions?.chunk || 4096;
    this.chunk = new Float32Array(this.size);
    this.filled = 0;
    this.out = null;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'port') {
        this.out = msg.port;
        this.filled = 0;
      } else if (msg.type === 'close') {
        this.out?.close();
        this.out = null;
      }
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || !this.out) return true;
    let i = 0;
    while (i < channel.length) {
      const take = Math.min(channel.length - i, this.size - this.filled);
      this.chunk.set(channel.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === this.size) {
        this.out.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('soundradar-capture', CaptureProcessor);
