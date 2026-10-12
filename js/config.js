// Deployment configuration. What ships in the repository is the safe default:
// nothing leaves the device.
//
// To turn publishing on for a deployment, create `js/config.local.js` next to
// this file (it is gitignored) with the part you want to change:
//
//   export default { mqtt: { enabled: true } };
//
// Its `mqtt` keys are merged over the ones below. While `enabled` is false the
// MQTT library is never fetched and no connection is made.

export default {
  mqtt: {
    enabled: false,
    // MQTT over WebSocket. A public broker: anyone can read what is published.
    url: 'wss://broker.emqx.io:8084/mqtt',
    // Optional credentials, for a private broker.
    username: '',
    password: '',
    // Topics are `<topicRoot>/<client id>/events` and `.../status`.
    topicRoot: 'soundradar/v1',
    // How often the retained status message is refreshed, in seconds.
    heartbeatS: 30,
  },
};
