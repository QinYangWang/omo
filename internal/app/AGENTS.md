# core subsystem

Owns `cmd/omo`, `internal/app`, `internal/chat`, `internal/config` and
`internal/host`.

## Responsibilities

- App lifecycle, window wiring, session switching and chat orchestration.
- Settings and per-provider credentials. pi-ai is the only model catalog; do not
  add a second provider registry.
- The settings form, model fetch (`{BaseURL}/models`) and workspace selection.
- Host capabilities exposed to the JS runtime (`internal/host`) are
  workspace-scoped and must reject paths escaping the workspace.

## Contracts

- The JS runtime is called through `moejsruntime.Engine`; keep this seam narrow.
- Plugin host actions are permission-checked in `internal/app/plugins.go`. Do
  not bypass `ActiveUIPluginAllows`.
- Do not import `internal/ui` from this package.

## Checks

```powershell
go test ./internal/app ./internal/config ./internal/chat ./internal/host
```
