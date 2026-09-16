# @omo/pi-extension

E0-002 feasibility spike: a version-locked Pi extension that forwards native Pi
session events (session, agent, turn, message streaming and tool execution) to a
local HTTP test receiver.

This package intentionally has **no `test` script and no `build` script**, so the
live-model spike never runs in the default repository gates. It is plain ESM
JavaScript and is loaded directly by Pi with no TypeScript build step.

## Layout

- `index.js` — the extension entry. Plain ESM JavaScript, loadable directly by
  `pi --extension <path>`.
- `test/spike.test.mjs` — live spike harness (node:test). Starts an ephemeral
  local HTTP receiver, launches the project-locked Pi binary with the extension
  loaded, and asserts the forwarded event stream.

## Configuration

The extension is configured entirely by `OMO_EXTENSION_EVENTS_URL`:

- unset/empty → the extension is completely inert (no network, no timers).
- set → it POSTs one JSON envelope per forwarded Pi event to that URL.

Each envelope contains `instanceId` (random UUID, once per process),
`nativeSequence` (monotonic per process, starts at 1), `sessionId`,
`sessionFile` (when available), `event`, `timestamp` and a JSON-safe `payload`.

Delivery is fire-and-forget with a short timeout and at most one retry. A dead
receiver can never throw into Pi; error output is bounded.

## Running the spike

Requires working `opencode-go` credentials for the project-locked Pi binary.

```bash
cd packages/pi-extension
pnpm run test:spike
```

Equivalent manual run:

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

## Non-goals

No daemon integration, attachment lease, command channel, SQLite, SSE, public
HTTP API or UI. This is a single version-locked spike.
