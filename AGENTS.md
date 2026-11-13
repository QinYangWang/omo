# omo repository guide

omo is a native Windows desktop chat app: MyGo widgets, a Go host, and the
official `@earendil-works/pi-durable` runtime executed by moejs.

## Non-negotiables

- No WebView2 and no HTML UI. Plugin UI is declarative JSON rendered by
  `internal/ui`.
- No marketplace, plugin index, signature authority, or background plugin
  updates. Plugins are installed from a user-chosen folder or ZIP and shared by
  exporting a ZIP.
- pi-ai is the only provider/model registry. omo stores settings and credentials
  only; the catalog comes from the bundled pi-ai version.
- Keep the shipped app free of Node.js and Bun. Bun is build-time only.

## Subsystems and owners

| Subsystem | Owned paths | Agent file |
| --- | --- | --- |
| `core` | `cmd/omo`, `internal/app`, `internal/bots`, `internal/config`, `internal/host`, `docs/bots/` | `internal/app/AGENTS.md` |
| `runtime` | `pi-runtime/`, `internal/runtime/moejs` | `pi-runtime/AGENTS.md` |
| `native-ui` | `internal/ui`, `pkg/` | `internal/ui/AGENTS.md` |
| `telemetry` | `internal/telemetry`, `docs/telemetry/` | `internal/telemetry/AGENTS.md` |
| `plugin` | `internal/plugins`, `examples/plugins`, `docs/plugin-design.md` | `internal/plugins/AGENTS.md` |
| `build-infra` | `scripts/`, `.gitignore`, `README.md`, `docs/subsystems.md` | `scripts/AGENTS.md` |

## Routing

- Change only the subsystem that owns the files. A cross-subsystem change needs
  an explicit task that names both owners.
- `docs/bots/design.md` is the product contract (the Bot team, groups, the
  message ledger, channels, work items). Subsystem documents refine it; a
  change there names `core` plus every subsystem whose contract moves.
- UI plugin schema changes are a `native-ui` + `plugin` change; update
  `docs/plugin-design.md` in the same commit.
- Build and release changes go through `build-infra`; do not edit another
  subsystem's build assumptions silently.

## Required checks

```powershell
gofmt -l cmd internal
go vet ./...
go test ./...
go build -trimpath -o bin/omo.exe ./cmd/omo
```

The app is accepted only by running it on Windows. `pi-runtime` also needs
`bun install && bun run build` before a fresh Go build can embed the runtime.
