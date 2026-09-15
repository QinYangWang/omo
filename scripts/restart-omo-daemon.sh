#!/usr/bin/env bash
# Restart the omo v2 daemon (protocol + web bundle) fully detached.
#
# Same contract as restart-omo-server.sh: `setsid` detaches the daemon into
# its own session so it survives the invoking shell; the script then waits
# for the readiness gate and prints every connection parameter — INCLUDING
# the bootstrap pairing code — to the log and stdout (owner convenience;
# the pairing code is a sensitive credential, keep the log private).
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${OMO_DAEMON_HOST:-127.0.0.1}"
PORT="${OMO_DAEMON_PORT:-5190}"
DATA_DIR="${OMO_DAEMON_DATA_DIR:-$HOME/.omo-daemon}"
LOG="${OMO_DAEMON_LOG:-/tmp/omo-daemon.log}"
ROOTS="${OMO_WORKSPACE_ROOTS:-$HOME}"
# Default: serve the built web bundle when present (complete deployment).
WEB_ROOT="${OMO_WEB_ROOT:-}"
if [ -z "$WEB_ROOT" ] && [ -f "dist/index.html" ]; then
  WEB_ROOT="$(pwd)/dist"
fi

args=(
  packages/daemon/bin/omo-daemon.ts
  --host "$HOST"
  --port "$PORT"
  --data-dir "$DATA_DIR"
)

if [ "${OMO_DAEMON_FAUX:-0}" = "1" ]; then
  args+=(--faux)
  PROVIDER_DESC="faux (explicit dev smoke)"
elif {
  [ -n "${OMO_DAEMON_PROVIDER:-}" ] && [ -z "${OMO_DAEMON_MODEL:-}" ];
} || {
  [ -z "${OMO_DAEMON_PROVIDER:-}" ] && [ -n "${OMO_DAEMON_MODEL:-}" ];
}; then
  echo "error: set both OMO_DAEMON_PROVIDER and OMO_DAEMON_MODEL" >&2
  exit 1
elif [ -n "${OMO_DAEMON_PROVIDER:-}" ] && [ -n "${OMO_DAEMON_MODEL:-}" ]; then
  args+=(--provider "$OMO_DAEMON_PROVIDER" --model "$OMO_DAEMON_MODEL")
  PROVIDER_DESC="${OMO_DAEMON_PROVIDER}/${OMO_DAEMON_MODEL}"
else
  PROVIDER_DESC="auto (Pi settings/auth store)"
fi

if [ -n "${OMO_DAEMON_AUTH_PATH:-}" ]; then
  args+=(--auth-path "$OMO_DAEMON_AUTH_PATH")
fi

# Resolve the provider mode before stopping the current daemon. With no
# explicit provider/model, the daemon itself selects Pi's local default or
# the first authenticated real provider/model.
pkill -f "packages/daemon/bin/omo-daemon.ts" || true
sleep 0.5

if [ -n "${OMO_DAEMON_PAIRING_CODE:-}" ]; then
  args+=(--pairing-code "$OMO_DAEMON_PAIRING_CODE")
fi
if [ -n "${OMO_DAEMON_TLS_CERT:-}" ] && [ -n "${OMO_DAEMON_TLS_KEY:-}" ]; then
  args+=(--tls-cert "$OMO_DAEMON_TLS_CERT" --tls-key "$OMO_DAEMON_TLS_KEY")
fi
if [ -n "$WEB_ROOT" ]; then
  args+=(--web-root "$WEB_ROOT")
else
  echo "warning: no web bundle (run npm run build or set OMO_WEB_ROOT) — protocol-only mode" >&2
fi
if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ] && [ -z "${OMO_DAEMON_TLS_CERT:-}" ]; then
  echo "warning: non-loopback host without TLS — see plan §4.2" >&2
fi

# Workspace roots: comma-separated → repeated flags.
IFS=',' read -ra root_list <<< "$ROOTS"
for root in "${root_list[@]}"; do
  trimmed="$(echo "$root" | xargs)"
  [ -n "$trimmed" ] && args+=(--workspace-root "$trimmed")
done

setsid node --no-warnings "${args[@]}" >> "$LOG" 2>&1 < /dev/null &

# Readiness gate: the daemon prints its startup line only once /v1/hello is
# served; the lock guarantees we are the only writer of the data dir.
SCHEME="http"
[ -n "${OMO_DAEMON_TLS_CERT:-}" ] && SCHEME="https"
BASE_URL="$SCHEME://$HOST:$PORT"
READY=""
for _ in $(seq 1 50); do
  if curl -sk "$BASE_URL/v1/hello" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.3
done
if [ -z "$READY" ]; then
  echo "error: daemon did not become ready; see $LOG" >&2
  exit 1
fi

# Resolve the bootstrap pairing code: explicit env wins; otherwise read the
# daemon-generated file (mode 0600).
PAIRING_CODE="${OMO_DAEMON_PAIRING_CODE:-}"
if [ -z "$PAIRING_CODE" ] && [ -f "$DATA_DIR/pairing-code" ]; then
  PAIRING_CODE="$(tr -d '[:space:]' < "$DATA_DIR/pairing-code")"
fi

PARAMS=$(
  cat <<EOF
[deploy] url=$BASE_URL
[deploy] webBundle=${WEB_ROOT:-none}
[deploy] pairingCode=${PAIRING_CODE:-unknown}
[deploy] provider=$PROVIDER_DESC
[deploy] dataDir=$DATA_DIR
[deploy] workspaceRoots=$ROOTS
EOF
)
printf '%s\n' "$PARAMS" >> "$LOG"
printf '%s\n\n' "$PARAMS"

echo "start"
