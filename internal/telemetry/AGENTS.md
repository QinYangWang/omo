# telemetry subsystem

Owns `internal/telemetry` and `docs/telemetry/`.

## Responsibilities

- Ingest the runtime's `metric` and `agent` reports into `telemetry.db`.
- Store one row per finished turn and one node per agent; upsert agent nodes,
  append turns.
- Aggregate per conversation, per session and across sessions (totals, per
  session, subagents).
- Keep the cache accounting in one formula.

## Hard rules

- Numeric facts and opaque ids only. No messages, titles, workspace paths or
  provider logic.
- Never import `core` or `runtime`; `core` joins labels and calls this package.
- Aggregation lives here once. The runtime reports facts and must not add them
  up a second way.
- Schema changes update `docs/telemetry/agent-activity.md` and the runtime
  report contract in the same change.

## Checks

```powershell
go test ./internal/telemetry
```
