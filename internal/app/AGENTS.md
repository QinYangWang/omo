# core subsystem

Owns `cmd/omo`, `internal/app`, `internal/bots`, `internal/config` and
`internal/host`.

## Responsibilities

- App lifecycle, window wiring, Bot switching and turn orchestration.
- Settings and per-provider credentials. pi-ai is the only model catalog; do not
  add a second provider registry.
- The settings form, model fetch (`{BaseURL}/models`) and workspace selection.
- Host capabilities exposed to the JS runtime (`internal/host`) are
  workspace-scoped and must reject paths escaping the workspace.

## Contracts

- The JS runtime is called through `moejsruntime.Engine`; keep this seam narrow.
- Runtime metric and agent reports are stored through `internal/telemetry`.
  Their contract is `docs/telemetry/agent-activity.md`; change it together
  with `docs/runtime/agent-contract.md`.
- Skills are discovered here and passed to the runtime as content; the runtime
  never reads skill files.
- `internal/bots` owns the team: roster, groups and the append-only message
  ledger. It is the only writer of messages; every reader derives from it (see
  `docs/bots/design.md`).
- Plugin host actions are permission-checked in `internal/app/plugins.go`. Do
  not bypass `ActiveUIPluginAllows`.
- Do not import `internal/ui` from this package.

## Checks

```powershell
go test ./internal/app ./internal/bots ./internal/config ./internal/host
```
