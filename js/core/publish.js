// Publishing detections to an MQTT broker (opt-in, deployment config only).
//
// One JSON message per detection start and end, plus a retained status message
// that a last-will flips to offline when the browser goes away. Metadata only:
// what was heard, when, and which client heard it — never audio, embeddings or
// clips. The record builders are pure; the browser-specific facts (session
// name, host, user agent) arrive through the `identity()` callback so this file
// stays DOM-free.

export const DEFAULT_TOPIC_ROOT = 'soundradar/v1';
const MAX_TEXT = 120;

export function topicsFor(root, client) {
  return { events: `${root}/${client}/events`, status: `${root}/${client}/status` };
}

const text = (s) => String(s ?? '').slice(0, MAX_TEXT);
const finite = (n) => (Number.isFinite(n) ? n : null);

function who(client, identity) {
  return { client, session: text(identity.session), host: text(identity.host), agent: text(identity.agent) };
}

/**
 * @param {'start'|'end'} type
 * @param {object} entry a DetectionLog record
 */
export function eventRecord(type, entry, client, identity) {
  const dur = Math.max(0, entry.t1 - entry.t0);
  return {
    v: 1,
    type,
    ...who(client, identity),
    id: entry.id,
    detector: entry.detectorId,
    label: text(entry.label),
    source: entry.source,
    detail: text(entry.detail),
    confidence: finite(Math.round(entry.confidence * 1000) / 1000),
    freq: finite(entry.freq === undefined ? NaN : Math.round(entry.freq * 10) / 10),
    start: new Date(entry.wallStart).toISOString(),
    ...(type === 'end' ? { end: new Date(entry.wallStart + dur).toISOString(), durationS: Math.round(dur / 100) / 10 } : {}),
  };
}

export function statusRecord(online, client, identity, now = Date.now()) {
  return {
    v: 1,
    online,
    ...who(client, identity),
    at: new Date(now).toISOString(),
    detectors: online && Array.isArray(identity.detectors) ? identity.detectors.slice(0, 200) : [],
  };
}

export class Publisher {
  /**
   * @param {object} o
   * @param {object} o.config  the `mqtt` block of js/config.js
   * @param {string} o.client  a stable per-browser id
   * @param {() => object} o.identity  `{ session, host, agent, detectors }`, read at send time
   * @param {() => Promise<any>} o.load  resolves the mqtt.js module (a dynamic import, so it is
   *   not fetched while publishing is off)
   */
  constructor({ config, client, identity, load }) {
    this.config = config;
    this.client = client;
    this.identity = identity;
    this.load = load;
    this.topics = topicsFor(config.topicRoot || DEFAULT_TOPIC_ROOT, client);
    this.status = 'connecting'; // connecting | connected | reconnecting | offline | error
    this.error = '';
    this.onstate = () => {};
    this.mqtt = null;
    this.timer = 0;
    this.closed = false;
  }

  _set(status) {
    this.status = status;
    this.onstate(status);
  }

  async start() {
    try {
      const lib = await this.load();
      if (this.closed) return;
      const will = JSON.stringify(statusRecord(false, this.client, this.identity()));
      const c = (lib.default || lib).connect(this.config.url, {
        clientId: `soundradar_${this.client}`,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        ...(this.config.username ? { username: this.config.username, password: this.config.password || '' } : {}),
        will: { topic: this.topics.status, payload: will, qos: 1, retain: true },
      });
      this.mqtt = c;
      c.on('connect', () => {
        this.error = '';
        this._set('connected');
        this.heartbeat();
      });
      c.on('reconnect', () => this._set('reconnecting'));
      c.on('offline', () => this._set('offline'));
      c.on('error', (e) => {
        this.error = e?.message || String(e);
        this._set('error');
      });
      const every = Math.max(5, Number(this.config.heartbeatS) || 30) * 1000;
      this.timer = setInterval(() => this.heartbeat(), every);
    } catch (e) {
      this.error = e?.message || String(e);
      this._set('error');
    }
  }

  /** The retained status message; also called when the session is renamed or switched. */
  heartbeat() {
    this._send(this.topics.status, statusRecord(true, this.client, this.identity()), { qos: 1, retain: true });
  }

  /** Best effort: dropped silently while not connected. */
  event(type, entry) {
    this._send(this.topics.events, eventRecord(type, entry, this.client, this.identity()), { qos: 0 });
  }

  _send(topic, record, opts) {
    if (this.status !== 'connected' || !this.mqtt) return;
    this.mqtt.publish(topic, JSON.stringify(record), opts);
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.mqtt) {
      this.mqtt.publish(this.topics.status, JSON.stringify(statusRecord(false, this.client, this.identity())), { qos: 1, retain: true });
      this.mqtt.end();
    }
    this.mqtt = null;
  }
}
