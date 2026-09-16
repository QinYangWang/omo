#!/usr/bin/env bash
# Build the Web client and restart the authenticated omo Server as a detached
# process. The Server serves dist/ and binds to all interfaces for phone access.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${OMO_PID_FILE:-/tmp/omo-server.pid}"
LOG_FILE="${OMO_LOG_FILE:-/tmp/omo-server.log}"

cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${OMO_TOKEN:-}" ]]; then
  echo "OMO_TOKEN is required when exposing omo Server on 0.0.0.0" >&2
  exit 1
fi

pnpm build

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE")"
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill -- "-$OLD_PID"
    for _ in {1..20}; do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "$PID_FILE"
fi

export OMO_HOST=0.0.0.0
setsid pnpm server >>"$LOG_FILE" 2>&1 < /dev/null &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"

SCHEME=http
if [[ -n "${OMO_TLS_CERT:-}" && -n "${OMO_TLS_KEY:-}" ]]; then
  SCHEME=https
fi

echo "omo Web server started: ${SCHEME}://0.0.0.0:${OMO_PORT:-5189}"
echo "pid: $SERVER_PID"
echo "log: $LOG_FILE"
