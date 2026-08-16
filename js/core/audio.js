// One AudioContext, one AnalyserNode, shared by every view so they can never
// disagree about FFT size, sample rate, or smoothing.

export const FFT_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768];

/** Why the mic could not start, in words a user can act on. */
const START_ERRORS = {
  NotAllowedError:
    'Microphone access was blocked. Allow it for this site in your browser settings, then start again.',
  PermissionDeniedError:
    'Microphone access was blocked. Allow it for this site in your browser settings, then start again.',
  NotFoundError: 'No microphone found. Connect an input device and start again.',
  DevicesNotFoundError: 'No microphone found. Connect an input device and start again.',
  NotReadableError:
    'The microphone is in use by another application. Close it and start again.',
  TrackStartError:
    'The microphone is in use by another application. Close it and start again.',
  OverconstrainedError:
    'That input device is no longer available. Pick another one and start again.',
  SecurityError: 'Microphone access needs a secure page. Open SoundRadar over https:// or on localhost.',
  AbortError: 'The microphone stopped unexpectedly. Start again to retry.',
};

/**
 * Reasons the app cannot run at all, checked before the user clicks anything so
 * the failure shows up as a message instead of a dead button.
 */
export function checkSupport() {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'SoundRadar needs a secure page to reach the microphone. Open it over https:// or on localhost.',
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: 'This browser does not support microphone capture (getUserMedia).' };
  }
  if (!(window.AudioContext || window.webkitAudioContext)) {
    return { ok: false, reason: 'This browser does not support the Web Audio API.' };
  }
  return { ok: true, reason: '' };
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.freqData = null;
    this.timeData = null;
    this.running = false;
    this.paused = false;
    this.deviceId = '';
    this.error = '';
    this._fftSize = 4096;
    this._smoothing = 0.7;
    this.onstatechange = null;
  }

  _emit() {
    if (this.onstatechange) this.onstatechange(this.state);
  }

  get state() {
    if (this.error) return 'error';
    if (!this.running) return 'idle';
    return this.paused ? 'paused' : 'live';
  }

  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  async start(deviceId) {
    const support = checkSupport();
    if (!support.ok) {
      this.error = support.reason;
      this._emit();
      throw new Error(support.reason);
    }
    this.error = '';

    // Browser voice processing is tuned to make speech intelligible: it applies
    // automatic gain, ducks steady tones, and notches out anything it decides is
    // noise. All three destroy the measurement this app exists to make, so every
    // one of them is switched off explicitly.
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (err) {
      // A device that vanished between enumeration and capture fails as
      // OverconstrainedError; retrying on the default input is almost always
      // what the user wanted.
      if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        return this.start('');
      }
      this.error = START_ERRORS[err.name] || `Could not start the microphone (${err.name || 'unknown error'}).`;
      this._emit();
      throw err;
    }

    this.stop({ keepError: false, silent: true });

    this.stream = stream;
    this.deviceId = deviceId || '';

    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    // Wide analyser limits: the user-facing dB window is a display setting, so
    // the analyser itself should not clip the data before we map it.
    this.analyser.minDecibels = -150;
    this.analyser.maxDecibels = 0;
    this.analyser.smoothingTimeConstant = this._smoothing;
    this.setFftSize(this._fftSize);
    this.source.connect(this.analyser);

    // A track ending (device unplugged, permission revoked mid-session) is
    // silent otherwise — the display would just freeze.
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (this.stream === stream) {
          this.error = 'The input device disconnected. Pick another one and start again.';
          this.stop({ keepError: true });
        }
      });
    }

    this.running = true;
    this.paused = false;
    this._emit();
    return this.actualSettings();
  }

  /** What the browser actually gave us, which may differ from what we asked for. */
  actualSettings() {
    const track = this.stream?.getAudioTracks?.()[0];
    const s = track?.getSettings?.() || {};
    return { label: track?.label || '', deviceId: s.deviceId || this.deviceId, sampleRate: this.sampleRate };
  }

  setFftSize(size) {
    this._fftSize = size;
    if (!this.analyser) return;
    this.analyser.fftSize = size;
    this.freqData = new Float32Array(this.analyser.frequencyBinCount);
    this.timeData = new Float32Array(this.analyser.fftSize);
  }

  setSmoothing(v) {
    this._smoothing = v;
    if (this.analyser) this.analyser.smoothingTimeConstant = v;
  }

  /** Latest spectrum in dBFS, or null when there is nothing to show. */
  getFrequencyData() {
    if (!this.analyser || !this.running) return null;
    if (this.paused) return this.freqData; // frozen frame, still drawable
    this.analyser.getFloatFrequencyData(this.freqData);
    return this.freqData;
  }

  /** Input RMS and peak in dBFS, plus a clip flag — a real input-level meter. */
  getLevels() {
    if (!this.analyser || !this.running || this.paused) return null;
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = this.timeData[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / this.timeData.length);
    return {
      rms: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
      peak: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      clipping: peak >= 0.999,
    };
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  get nyquist() {
    return this.sampleRate / 2;
  }

  get fftSize() {
    return this.analyser ? this.analyser.fftSize : this._fftSize;
  }

  get binCount() {
    return this.fftSize / 2;
  }

  /** Width of one FFT bin in Hz — the real resolution limit of the display. */
  get binHz() {
    return this.sampleRate / this.fftSize;
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    // Suspending the context stops the analyser doing work we would throw away.
    this.ctx?.suspend?.().catch(() => {});
    this._emit();
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.ctx?.resume?.().catch(() => {});
    this._emit();
  }

  /** Release the microphone. The context is kept so restarting is instant. */
  stop({ keepError = false, silent = false } = {}) {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.stream = null;
    this.source = null;
    this.running = false;
    this.paused = false;
    if (!keepError) this.error = '';
    if (!silent) this._emit();
  }
}
