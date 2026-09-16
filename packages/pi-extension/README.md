# @omo/pi-extension

Version-locked Pi extension implementing two feasibility spikes:

- **E0-002** — forward native Pi session events (session, agent, turn, message
  streaming and tool execution) to a local HTTP test receiver.
- **E0-003** — connect OUT to a harness-owned command stream and inject native
  `Prompt` and `Abort` into the **same live `AgentSession`**, with structured
  acks flowing back through the E0-002 event forwarding path.

This package intentionally has **no `test` script and no `build` script**, so the
live-model spikes never run in the default repository gates. It is plain ESM
JavaScript and is loaded directly by Pi with no TypeScript build step.

## Layout

- `index.js` — the extension entry. Plain ESM JavaScript, loadable directly by
  `pi --extension <path>`.
- `test/spike.test.mjs` — E0-002 live harness (node:test). Starts an ephemeral
  local HTTP receiver, launches the project-locked Pi binary with the extension
  loaded, and asserts the forwarded event stream.
- `test/command-bridge.test.mjs` — E0-003 live harness. Starts the HTTP receiver
  **and** an outbound SSE command stream, launches Pi in RPC mode with both env
  vars, injects a prompt and a mid-stream abort, and asserts the ack sequences,
  streaming deltas and native abort outcome.

## Configuration

The extension is configured by environment variables:

- `OMO_EXTENSION_EVENTS_URL` — unset/empty → the extension is completely inert
  (no network, no timers, no command channel). Set → the extension POSTs one
  JSON record per forwarded Pi event and per command ack to that URL.
- `OMO_EXTENSION_COMMANDS_URL` — set (together with the events URL) → the
  extension opens a long-lived **outbound** SSE connection to that URL in
  `session_start`. It never opens a listening socket. Unset → no command
  channel is created and E0-002 behavior is unchanged.

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

No daemon integration, attachment lease, instance credential, generation
mapping, SQLite, public HTTP API or UI. Delivery is fire-and-forget with a
short timeout and a bounded retry; nothing here claims exactly-once semantics.
