# Subsystems

Each subsystem has one owner agent and one `AGENTS.md`. Agents must not edit
another subsystem's files without an explicit cross-subsystem task.

| Subsystem | Paths | Interface |
| --- | --- | --- |
| `core` | `cmd/omo`, `internal/app`, `internal/bots`, `internal/config`, `internal/host`, `docs/core/`, `docs/bots/` | Calls `runtime.Engine`; owns the Bot roster and team state; exposes host actions and permission checks to plugins |
| `runtime` | `pi-runtime/`, `internal/runtime/moejs`, `docs/runtime/` | JS API in `pi-runtime/src/main.ts`; Go engine methods; emits `team` / `bot` / `metric` / `agent` events |
| `telemetry` | `internal/telemetry`, `docs/telemetry/` | `Ingest`/`Totals` over activity facts; imports neither core nor runtime |
| `native-ui` | `internal/ui`, `internal/widgets` | Widget JSON schema and host action names; reads the team projection |
| `plugin` | `internal/plugins`, `examples/plugins`, `docs/plugin-design.md` | `omo-plugin.json` manifest and ZIP layout; built-in GitHub/git adapters |
| `build-infra` | `scripts/`, `.gitignore`, `README.md`, `docs/subsystems.md` | Build commands and artifact layout |

## Shared contracts

- `internal/app` must not import `internal/ui`.
- `internal/ui` renders; it must not own persistence or provider logic.
- `internal/plugins` never executes user plugin code; the built-in channel and
  git adapters are host code with explicit permissions.
- `internal/runtime/moejs` is the only place that bridges Go and JS.
- `telemetry` only adds up facts the runtime reported; no aggregation logic in
  the runtime and no harness access in telemetry.
- The widget schema and the plugin manifest are public; changes are additive
  unless `apiVersion` is bumped.
- `docs/bots/design.md` is the product-level contract (Bot team, groups,
  ledger, channels, work items); subsystem documents refine it, never
  contradict it.
