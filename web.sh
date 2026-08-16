#!/usr/bin/env bash
# Serves the SoundRadar app with PHP's built-in server and opens it in Chrome.
set -euo pipefail

PORT="${1:-8080}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:${PORT}/"

cd "$DIR"

if ! command -v php >/dev/null 2>&1; then
  echo "php binary not found on PATH" >&2
  exit 1
fi

echo "Serving $DIR at $URL"
php -S "localhost:${PORT}" -t "$DIR" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

# give the server a moment to bind before opening the browser
for _ in $(seq 1 20); do
  if curl -sf -o /dev/null "$URL" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

if command -v open >/dev/null 2>&1; then
  open "$URL"
else
  echo "Open $URL in your browser" >&2
fi

wait "$SERVER_PID"
