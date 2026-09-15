#!/usr/bin/env bash
# Restart the public omo v2 daemon and serve the built web bundle.
#
# The public entry point intentionally mints a new bootstrap pairing code on
# every restart.  It is printed once to this script's stdout after readiness;
# it is never appended to the daemon log.  The code is also not persisted in
# the daemon data directory: --pairing-code takes precedence over the old
# pairing-code file and the stale file is removed below.
#
# By default, provider/model are resolved from the local Pi settings and auth
# store. Set OMO_DAEMON_FAUX=1 only for an explicit development smoke run.
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${OMO_DAEMON_HOST:-0.0.0.0}"
PORT="${OMO_DAEMON_PORT:-5190}"
DATA_DIR="${OMO_DAEMON_DATA_DIR:-$HOME/.omo-daemon}"
LOG="${OMO_DAEMON_LOG:-/tmp/omo-daemon.log}"
ROOTS="${OMO_WORKSPACE_ROOTS:-$HOME}"
WEB_ROOT="${OMO_WEB_ROOT:-}"
# The public deployment keeps the familiar v1 shell; the daemon's native v2
# API remains available at /v1 and can be selected with OMO_DAEMON_WEB_MODE=v2.
WEB_MODE="${OMO_DAEMON_WEB_MODE:-v1}"
if [ -z "$WEB_ROOT" ] && [ -f "dist/index.html" ]; then
  WEB_ROOT="$(pwd)/dist"
fi
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DAEMON_AUTH_PATH="${OMO_DAEMON_AUTH_PATH:-$PI_AGENT_DIR/auth.json}"

mkdir -p "$DATA_DIR" "$(dirname "$LOG")"

# Public deployments use an ACME certificate.  Keep the old OMO_TLS_* names
# as aliases so an existing acme.sh installation can be adopted without
# moving its installed PEM files.
TLS_DIR="${OMO_DAEMON_TLS_DIR:-$DATA_DIR/tls}"
TLS_CERT="${OMO_DAEMON_TLS_CERT:-${OMO_TLS_CERT:-$TLS_DIR/fullchain.pem}}"
TLS_KEY="${OMO_DAEMON_TLS_KEY:-${OMO_TLS_KEY:-$TLS_DIR/key.pem}}"
ACME_SH="${OMO_ACME_SH:-${LE_WORKING_DIR:-$HOME/.acme.sh}/acme.sh}"
ACME_DOMAIN="${OMO_ACME_DOMAIN:-${OMO_DAEMON_DOMAIN:-${OMO_TLS_DOMAIN:-${OMO_DOMAIN:-}}}}"
ACME_RENEW_BEFORE_SECONDS="${OMO_ACME_RENEW_BEFORE_SECONDS:-2592000}"
ACME_ISSUE_MODE="${OMO_ACME_ISSUE_MODE:-standalone}"

is_loopback_host() {
  [ "$1" = "127.0.0.1" ] || [ "$1" = "localhost" ] || [ "$1" = "::1" ]
}

resolve_real_model() {
  PI_CODING_AGENT_DIR="$PI_AGENT_DIR" \
    OMO_DAEMON_AUTH_PATH="$DAEMON_AUTH_PATH" \
    node --no-warnings --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const authPath = process.env.OMO_DAEMON_AUTH_PATH || join(agentDir, "auth.json");
const readSettings = () => {
  try {
    return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  } catch {
    return {};
  }
};
const settings = readSettings();
const configuredProvider = process.env.OMO_DAEMON_PROVIDER?.trim();
const configuredModel = process.env.OMO_DAEMON_MODEL?.trim();
const provider = configuredProvider || settings.defaultProvider;
const modelId = configuredModel || settings.defaultModel;
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const runtime = await ModelRuntime.create({
  authPath,
  refreshOnCreate: false,
});
const authenticated = async (providerId) => {
  try {
    return await runtime.checkAuth(providerId, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return undefined;
  }
};
if (provider && modelId) {
  if (!runtime.getModel(provider, modelId)) {
    throw new Error(`configured model is unavailable: ${provider}/${modelId}`);
  }
  if (!(await authenticated(provider))) {
    throw new Error(`provider is not authenticated: ${provider}`);
  }
  process.stdout.write(`${provider}\t${modelId}`);
} else {
  let selection = "";
  for (const candidate of runtime.getProviders()) {
    if (!(await authenticated(candidate.id))) {
      continue;
    }
    const model = runtime.getModels(candidate.id)[0];
    if (model) {
      selection = `${candidate.id}\t${model.id}`;
      break;
    }
  }
  if (!selection) {
    throw new Error("no authenticated provider/model found");
  }
  process.stdout.write(selection);
}
NODE
}

certificate_needs_renewal() {
  if [ ! -s "$TLS_CERT" ]; then
    return 0
  fi
  if ! openssl x509 -in "$TLS_CERT" -noout >/dev/null 2>&1; then
    return 0
  fi
  ! openssl x509 -in "$TLS_CERT" -checkend "$ACME_RENEW_BEFORE_SECONDS" -noout >/dev/null 2>&1
}

if ! is_loopback_host "$HOST"; then
  # Prefer an explicitly installed acme.sh, then one found on PATH.
  if [ ! -x "$ACME_SH" ]; then
    ACME_SH="$(command -v acme.sh || true)"
  fi
  if [ ! -x "$ACME_SH" ]; then
    echo "error: public daemon requires acme.sh; install it or set OMO_ACME_SH" >&2
    exit 1
  fi

  # If the caller did not provide a domain, reuse the first certificate
  # managed by this acme.sh home.  A fresh deployment must set
  # OMO_ACME_DOMAIN (or OMO_DAEMON_DOMAIN) explicitly.
  if [ -z "$ACME_DOMAIN" ]; then
    ACME_DOMAIN="$("$ACME_SH" --list 2>/dev/null | awk 'NR > 1 && $1 != "" { print $1; exit }' || true)"
  fi
  if [ -z "$ACME_DOMAIN" ] && ! is_loopback_host "$HOST" && [ "$HOST" != "0.0.0.0" ] && [ "$HOST" != "::" ]; then
    ACME_DOMAIN="$HOST"
  fi
  if [ -z "$ACME_DOMAIN" ]; then
    echo "error: set OMO_ACME_DOMAIN to the public DNS name or IP for the TLS certificate" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$TLS_CERT")" "$(dirname "$TLS_KEY")"
  ACME_HOME="${LE_WORKING_DIR:-$(dirname "$ACME_SH")}"
  ACME_DOMAIN_CONFIG=""
  ACME_ECC_ARGS=()
  for candidate in \
    "$ACME_HOME/${ACME_DOMAIN}_ecc/${ACME_DOMAIN}.conf" \
    "$ACME_HOME/${ACME_DOMAIN}/${ACME_DOMAIN}.conf"; do
    if [ -f "$candidate" ]; then
      ACME_DOMAIN_CONFIG="$candidate"
      if [[ "$candidate" == *_ecc/* ]]; then
        ACME_ECC_ARGS=(--ecc)
      fi
      break
    fi
  done

  if certificate_needs_renewal; then
    echo "TLS certificate is missing, invalid, or expires within ${ACME_RENEW_BEFORE_SECONDS}s; obtaining it with acme.sh" >&2
    if [ -n "$ACME_DOMAIN_CONFIG" ]; then
      renew_status=0
      "$ACME_SH" --renew -d "$ACME_DOMAIN" "${ACME_ECC_ARGS[@]}" || renew_status=$?
      # acme.sh returns 2 when the certificate is not due yet. That is a
      # successful check; install-cert below will keep the existing PEMs.
      if [ "$renew_status" -ne 0 ] && [ "$renew_status" -ne 2 ]; then
        echo "error: acme.sh renewal failed for $ACME_DOMAIN (status $renew_status)" >&2
        exit "$renew_status"
      fi
    else
      case "$ACME_ISSUE_MODE" in
        standalone)
          "$ACME_SH" --issue --standalone -d "$ACME_DOMAIN"
          ;;
        webroot)
          ACME_WEBROOT="${OMO_ACME_WEBROOT:-$WEB_ROOT}"
          if [ -z "$ACME_WEBROOT" ]; then
            echo "error: OMO_ACME_WEBROOT (or OMO_WEB_ROOT) is required for acme.sh webroot mode" >&2
            exit 1
          fi
          "$ACME_SH" --issue --webroot "$ACME_WEBROOT" -d "$ACME_DOMAIN"
          ;;
        dns)
          ACME_DNS_API="${OMO_ACME_DNS_API:-}"
          if [ -z "$ACME_DNS_API" ]; then
            echo "error: OMO_ACME_DNS_API is required for acme.sh DNS mode" >&2
            exit 1
          fi
          "$ACME_SH" --issue --dns "$ACME_DNS_API" -d "$ACME_DOMAIN"
          ;;
        *)
          echo "error: unsupported OMO_ACME_ISSUE_MODE=$ACME_ISSUE_MODE (use standalone, webroot, or dns)" >&2
          exit 1
          ;;
      esac
    fi
  else
    echo "TLS certificate is valid; reusing it until acme.sh renewal is due" >&2
  fi

  # Always install through acme.sh so renewals and the daemon's PEM paths stay
  # in sync.  The daemon is restarted by this script, so no reload hook is
  # necessary here.
  "$ACME_SH" --install-cert -d "$ACME_DOMAIN" "${ACME_ECC_ARGS[@]}" \
    --key-file "$TLS_KEY" \
    --fullchain-file "$TLS_CERT" \
    --reloadcmd "true"
  chmod 600 "$TLS_KEY"
  chmod 644 "$TLS_CERT"
  if ! openssl x509 -in "$TLS_CERT" -checkend 0 -noout >/dev/null 2>&1; then
    echo "error: acme.sh did not install a non-expired certificate at $TLS_CERT" >&2
    exit 1
  fi
fi

# Resolve the execution model before stopping the current daemon. A bad local
# auth/model configuration must fail without taking a healthy public daemon
# offline.
DAEMON_USE_FAUX=0
RESOLVED_PROVIDER=""
RESOLVED_MODEL=""
if [ "${OMO_DAEMON_FAUX:-0}" = "1" ]; then
  DAEMON_USE_FAUX=1
  PROVIDER_DESC="faux (explicit dev smoke)"
else
  if {
    [ -n "${OMO_DAEMON_PROVIDER:-}" ] && [ -z "${OMO_DAEMON_MODEL:-}" ];
  } || {
    [ -z "${OMO_DAEMON_PROVIDER:-}" ] && [ -n "${OMO_DAEMON_MODEL:-}" ];
  }; then
    echo "error: set both OMO_DAEMON_PROVIDER and OMO_DAEMON_MODEL" >&2
    exit 1
  fi
  MODEL_SELECTION="$(resolve_real_model)" || {
    echo "error: no usable local provider/model; authenticate with pi /login or set OMO_DAEMON_PROVIDER and OMO_DAEMON_MODEL" >&2
    exit 1
  }
  IFS=$'\t' read -r RESOLVED_PROVIDER RESOLVED_MODEL <<< "$MODEL_SELECTION"
  if [ -z "$RESOLVED_PROVIDER" ] || [ -z "$RESOLVED_MODEL" ]; then
    echo "error: local provider/model selection was empty" >&2
    exit 1
  fi
  PROVIDER_DESC="${RESOLVED_PROVIDER}/${RESOLVED_MODEL}"
fi

# Stop the old writer only after certificate and model preparation completed.
pkill -f "packages/daemon/bin/omo-daemon.ts" || true
sleep 0.5
# Remove pairing lines written by an older version of this script as a
# one-time credential hygiene step. New daemon output contains no raw code.
if [ -f "$LOG" ]; then
  sed -i '/pairingCode=/d' "$LOG"
fi

# Generate a fresh code for every public restart.  Do not honor
# OMO_DAEMON_PAIRING_CODE here: a fixed code defeats the restart contract.
if [ -n "${OMO_DAEMON_PAIRING_CODE:-}" ]; then
  echo "warning: OMO_DAEMON_PAIRING_CODE is ignored by the public restart script; minting a new code" >&2
fi
PAIRING_CODE="$(node --no-warnings -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
rm -f "$DATA_DIR/pairing-code"

args=(
  packages/daemon/bin/omo-daemon.ts
  --host "$HOST"
  --port "$PORT"
  --data-dir "$DATA_DIR"
  --pairing-code "$PAIRING_CODE"
  --web-mode "$WEB_MODE"
)

if [ "$DAEMON_USE_FAUX" = "1" ]; then
  args+=(--faux)
else
  args+=(
    --provider "$RESOLVED_PROVIDER"
    --model "$RESOLVED_MODEL"
    --auth-path "$DAEMON_AUTH_PATH"
  )
fi

if ! is_loopback_host "$HOST"; then
  args+=(--tls-cert "$TLS_CERT" --tls-key "$TLS_KEY")
fi
if [ -n "$WEB_ROOT" ]; then
  args+=(--web-root "$WEB_ROOT")
else
  echo "warning: no web bundle (run npm run build or set OMO_WEB_ROOT) — protocol-only mode" >&2
fi

# Workspace roots: comma-separated → repeated flags.
IFS=',' read -ra root_list <<< "$ROOTS"
for root in "${root_list[@]}"; do
  trimmed="$(echo "$root" | xargs)"
  [ -n "$trimmed" ] && args+=(--workspace-root "$trimmed")
done

setsid node --no-warnings "${args[@]}" >> "$LOG" 2>&1 < /dev/null &

# Probe through loopback so a wildcard bind does not make readiness depend on
# DNS or a proxy.  -k is needed because the certificate's SAN is the public
# domain/IP, not 127.0.0.1.
SCHEME="http"
if ! is_loopback_host "$HOST"; then
  SCHEME="https"
fi
READY_URL="$SCHEME://127.0.0.1:$PORT"
READY=""
for _ in $(seq 1 50); do
  if curl -sk --max-time 2 "$READY_URL/v1/hello" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.3
done
if [ -z "$READY" ]; then
  echo "error: daemon did not become ready; see $LOG" >&2
  exit 1
fi

PUBLIC_HOST="${OMO_DAEMON_PUBLIC_HOST:-${OMO_PUBLIC_HOST:-${OMO_DAEMON_DOMAIN:-${ACME_DOMAIN:-$HOST}}}}"
if [[ "$PUBLIC_HOST" == *:* && "$PUBLIC_HOST" != \[*\] ]]; then
  URL_HOST="[$PUBLIC_HOST]"
else
  URL_HOST="$PUBLIC_HOST"
fi
BASE_URL="${OMO_DAEMON_PUBLIC_URL:-$SCHEME://$URL_HOST:$PORT}"
BASE_URL="${BASE_URL%/}"

# Keep the deployment summary in the log, but print the secret pairing code
# separately to stdout only.
PARAMS=$(
  cat <<EOF
[deploy] url=$BASE_URL
[deploy] webBundle=${WEB_ROOT:-none}
[deploy] tls=${TLS_CERT:-none}
[deploy] provider=$PROVIDER_DESC
[deploy] dataDir=$DATA_DIR
[deploy] workspaceRoots=$ROOTS
EOF
)
printf '%s\n' "$PARAMS" >> "$LOG"
printf '%s\n' "$PARAMS"
printf '[deploy] pairingCode=%s\n\n' "$PAIRING_CODE"

echo "start"
