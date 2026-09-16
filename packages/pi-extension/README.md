# @omo/pi-extension

Version-locked Pi extension implementing two feasibility spikes and the daemon
bridge:

- **E0-002** — forward native Pi session events (session, agent, turn, message
  streaming and tool execution) to a local HTTP test receiver.
- **E0-003** — connect OUT to a harness-owned command stream and inject native
  `Prompt` and `Abort` into the **same live `AgentSession`**, with structured
  acks flowing back through the E0-002 event forwarding path.
- **E2-001/E2-002** — connect OUT to the local omo daemon over its Unix socket
  / Windows named pipe, register the current Pi session, keep the attachment
  alive with heartbeats, forward native lifecycle events, and detach on
  shutdown. The daemon is the long-lived management surface; this package never
  opens a listening socket and never owns TLS, CORS, the public bearer token or
  workspace paths.

This package intentionally has **no `test` script and no `build` script**, so the
live-model spikes never run in the default repository gates. It is plain ESM
JavaScript and is loaded directly by Pi with no TypeScript build step.

## Layout

- `index.js` — the extension entry. Plain ESM JavaScript, loadable directly by
  `pi --extension <path>`. All mutable resources are created per
  `session_start` and released idempotently in `session_shutdown`.
- `daemon-channel.mjs` — tiny private-channel client plus the pure version and
  envelope helpers used by the daemon mode and its unit tests.
- `test/spike.test.mjs` — E0-002 live harness (node:test). Starts an ephemeral
  local HTTP receiver, launches the project-locked Pi binary with the extension
  loaded, and asserts the forwarded event stream.
- `test/command-bridge.test.mjs` — E0-003 live harness. Starts the HTTP receiver
  **and** an outbound SSE command stream, launches Pi in RPC mode with both env
  vars, injects a prompt and a mid-stream abort, and asserts the ack sequences,
  streaming deltas and native abort outcome.
- `test/daemon-live.test.mjs` — E2 live harness. Serves a real
  `ExtensionService` over a real Unix socket and asserts register, heartbeat,
  event forwarding, detach, inert-without-env and register-rejection behavior.
- `test/heartbeat-recovery.test.mjs` — E2 in-process recovery test: heartbeat
  expiry triggers the bounded re-register path and forwarding resumes with the
  new generation.
- `test/daemon-lifecycle.test.mjs` — E2 idempotent lifecycle test (double
  shutdown, no leaked timers, new generation on the next `session_start`).
- `test/version.test.mjs`, `test/lifecycle.test.mjs` — pure-helper and E2-001
  spike lifecycle tests.

## Configuration

The extension is configured by environment variables:

- `OMO_EXTENSION_EVENTS_URL` — unset/empty → the extension is completely inert
  (no network, no timers, no command channel). Set → the extension POSTs one
  JSON record per forwarded Pi event and per command ack to that URL.
- `OMO_EXTENSION_COMMANDS_URL` — set (together with the events URL) → the
  extension opens a long-lived **outbound** SSE connection to that URL in
  `session_start`. It never opens a listening socket. Unset → no command
  channel is created and E0-002 behavior is unchanged.
- `OMO_DAEMON_SOCKET` — set → daemon mode activates against that Unix socket /
  Windows named pipe. Unset → daemon mode is fully inert. The spike variables
  and daemon mode are independent and can be active at the same time; the
  launcher sets only daemon mode.
- `OMO_PI_VERSION` — the running Pi version reported in `register`. Unset →
  `"unknown"` is reported. When set it must match the `0.85.x` peer line; a
  mismatch logs one line and leaves the session detached-local (the launcher is
  the real gate, E0-004).

## E0-002/E0-003 spike envelopes

### Event envelope

Forwarded native events have no `kind` field:

```json
{
  "instanceId": "uuid",
  "nativeSequence": 1,
  "sessionId": "…",
  "sessionFile": null,
  "event": "message_update",
  "timestamp": 1733234567890,
  "payload": {}
}
```

`instanceId` is generated once per process, `nativeSequence` is monotonic per
process starting at 1 and is shared by events **and** acks so the receiver can
order the whole stream.

### Command envelope (harness → extension)

One JSON object per SSE `data:` frame:

```json
{ "requestId": "req-1", "commandSequence": 1, "type": "prompt", "text": "…" }
{ "requestId": "abort-1", "commandSequence": 2, "type": "abort" }
```

- `commandSequence` is assigned by the sender and must be strictly increasing.
  Commands with a `commandSequence <= lastApplied` are ignored silently.
- Duplicate `requestId`s are rejected (`duplicate_request`) without executing.
- `prompt` with empty/whitespace text is rejected (`empty_text`); unknown types
  are rejected (`unknown_command_type: …`).

### Ack envelope (extension → harness)

Acks are POSTed to `OMO_EXTENSION_EVENTS_URL` with `kind: "ack"`:

```json
{
  "kind": "ack",
  "requestId": "req-1",
  "commandSequence": 1,
  "status": "accepted",
  "reason": "…",
  "instanceId": "uuid",
  "nativeSequence": 42,
  "sessionId": "…",
  "sessionFile": null,
  "timestamp": 1733234567890
}
```

Status semantics:

- `accepted` — command is valid, uniquely applied and about to be dispatched.
- `started` — Pi emitted `agent_start`; the native run is actually executing.
- `completed` — the run settled (`agent_settled`); `reason` carries the native
  assistant `stopReason` when available (`stop`, `aborted`, `error`, …).
- `rejected` — the command was not applied; `reason` explains why.

`prompt` acks flow `accepted → started → completed`. `abort` acks flow
`accepted → completed`. An abort is only dispatched through `ctx.abort()` while
`ctx.isIdle()` is false, so an ack can never claim an abort that did not reach
the runtime. A dropped command stream is **unknown** to the harness; the
extension never fabricates success after a disconnect, and reconnects with
bounded backoff (3 attempts, 500 ms exponential).

## Daemon mode (E2)

Daemon mode uses the private channel in
[`docs/extension-daemon-hybrid.md`](../../docs/extension-daemon-hybrid.md) §5:

- Every `session_start` (`startup`/`new`/`resume`/`fork`) POSTs
  `/api/v1/extension/register` with `channelVersion: 1`, capabilities
  `["events", "commands"]`, `instanceId`, versions and the current
  `sessionId`/`sessionFile`/`cwd`. On `{ ok: false }` (for example
  `session_already_attached`) the extension logs one line and runs
  detached-local with no retry loop.
- On success the daemon issues `generation` and a short-lived `credential`.
  Both are memory-only, never logged and never written to Session JSONL.
- `/api/v1/extension/heartbeat` runs on the advertised `heartbeatIntervalMs`.
  A 401/404/409 or three consecutive network failures stop heartbeats, drop
  queued events for the old generation, and enter one bounded re-register path
  (500 ms / 1 s / 2 s, max 3 attempts). A successful re-register mints a new
  generation and resumes forwarding.
- Forwarded events are `session_start`, `session_shutdown`, `agent_start`,
  `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`,
  `message_update`, `message_end`, `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`, `session_before_compact`,
  `session_compact`, `session_compact_failed`, `model_select`,
  `thinking_level_select` and `session_info_changed`. Each becomes one
  `ExtensionNativeEvent` with a per-process monotonic `nativeSequence` and a
  JSON-safe `payload`.
- Delivery POSTs `/api/v1/extension/events` with a single-event batch, the
  captured `generation` and the credential. Order is preserved by a serialized
  drain queue; a 409 pauses sending until re-register succeeds.
- `session_shutdown` forwards the shutdown event, drains the queue, then POSTs
  `/api/v1/extension/detach` (best effort, short timeout). All state is
  released idempotently, so a double `session_shutdown` is a no-op.
- Events emitted while registration is pending or failed are dropped; nothing
  is buffered unboundedly.

**Retry observability:** Pi 0.85.0 has no separate extension retry event. A
provider retry or auto-compaction retry is observed through the
`agent_end` / `agent_settled` payloads (and the `message_*` stream), not as a
dedicated event.

## Running the spikes

Requires working `opencode-go` credentials for the project-locked Pi binary.

```bash
cd packages/pi-extension
pnpm run test:spike
```

Manual E0-002 run:

```bash
OMO_EXTENSION_EVENTS_URL=http://127.0.0.1:8788/events \
  ../../node_modules/.bin/pi \
  --print \
  --no-session \
  --provider opencode-go \
  --model deepseek-v4.1-flash \
  --extension "$(pwd)/index.js" \
  "Reply with exactly: hello"
```

Manual E0-003 run: start a small SSE endpoint that emits the command envelope,
then launch Pi in RPC mode (print mode exits after its single-shot prompt, so it
cannot host an externally driven command channel):

```bash
OMO_EXTENSION_EVENTS_URL=http://127.0.0.1:8788/events \
OMO_EXTENSION_COMMANDS_URL=http://127.0.0.1:8788/commands \
  ../../node_modules/.bin/pi \
  --mode rpc \
  --no-session \
  --provider opencode-go \
  --model deepseek-v4.1-flash \
  --extension "$(pwd)/index.js"
```

RPC mode is used because it keeps the native `AgentSession` alive and idle until
an external command arrives; `--print` disposes the session as soon as its
single-shot prompt completes. The injected message still flows exclusively
through the extension (`pi.sendUserMessage`), not through the RPC `prompt`
command.

## Non-goals

No command dispatch over the daemon channel (E2-003), no `/new` `/resume`
`/fork` `/reload` semantics beyond "register on every `session_start`"
(E2-004), no CLI changes, no daemon changes, no additional dependencies and no
TypeScript build step. Delivery is fire-and-forget with a short timeout and a
bounded retry; nothing here claims exactly-once semantics.
