# Plan: publish detections over MQTT

Opt-in at deployment. Modelled on audiomesh's "Publish Network Stats" (`../audiomesh/src/stats/`).

- `js/config.js` ships `mqtt.enabled: false`; an untracked `js/config.local.js` turns it on. No UI switch.
- `js/core/publish.js`: pure record builders + `Publisher` (connect, last-will, heartbeat, event publish).
- `js/vendor/mqtt.esm.js`: mqtt.js 5.16.0 (MIT), dynamic import only when enabled.
- `app.js`: `startPublishing()` subscribes to the `DetectionLog` (add -> start, close -> end); status dot beside the session name.
- Topics: `soundradar/v1/<client>/events`, retained `.../status` with last-will.
- Payload: detector, label, source, detail, confidence, freq, start/end, session, host, user agent, client id. Never audio.
- Broker: `wss://broker.emqx.io:8084/mqtt` by default (public; configurable).
- Docs: `CLAUDE.md`, `spec-recognition.md` (local-only principle gets one explicit exception).

Verified: record shape and Publisher against a fake client (Node); vendored bundle and full publish/subscribe round trip in headless Chrome against `broker.hivemq.com` (the emqx broker refused every connection from this network with "Server unavailable", even a plain connect).
