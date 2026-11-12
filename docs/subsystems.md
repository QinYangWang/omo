# Subsystems

Each subsystem has one owner agent and one `AGENTS.md`. Agents must not edit
another subsystem's files without an explicit cross-subsystem task.

| Subsystem | Paths | Interface |
| --- | --- | --- |
| `core` | `cmd/omo`, `internal/app`, `internal/chat`, `internal/config`, `internal/host` | Calls `runtime.Engine`; exposes host actions and permission checks to plugins |
| `runtime` | `pi-runtime/`, `internal/runtime/moejs` | JS API in `pi-runtime/src/main.ts`; Go engine methods |
| `native-ui` | `internal/ui`, `internal/widgets` | Widget JSON schema and host action names |
| `plugin-platform` | `internal/plugins`, `examples/plugins`, `docs/plugin-design.md` | `omo-plugin.json` manifest and ZIP layout |
| `build-infra` | `scripts/`, `.gitignore`, `README.md`, `docs/subsystems.md` | Build commands and artifact layout |

## Shared contracts

- `internal/app` must not import `internal/ui`.
- `internal/ui` renders; it must not own persistence or provider logic.
- `internal/plugins` never executes plugin code.
- `internal/runtime/moejs` is the only place that bridges Go and JS.
- The widget schema and the plugin manifest are public; changes are additive
  unless `apiVersion` is bumped.
