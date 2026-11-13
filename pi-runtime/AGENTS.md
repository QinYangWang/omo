# runtime subsystem

Owns `pi-runtime/` and `internal/runtime/moejs`.

## Responsibilities

- Bundle the official `@earendil-works/pi-durable` and pi-ai packages with
  esbuild and run them inside moejs.
- Maintain the Go/JS bridge: host functions, storage adapter, catalog listing,
  and streaming callbacks.
- Keep the bundle IIFE format. moejs loads scripts, not ES modules; ESM wrappers
  break hoisted initialization.

## Contracts

- The data contract with `core` is `docs/runtime/agent-contract.md`.
- The shipped app must not require Node.js or Bun.
- Keep the exported JS API in `pi-runtime/src/main.ts` stable; `core` depends on
  it. It is `openTeam`, `sendToBot`, `abortBot`, `closeTeam` and `listCatalog`.
- Host reports `__host_metric` and `__host_agent` are fire-and-forget JSON
  strings. `core` decodes them (`telemetry.AgentRun`, `telemetry.Agent`) and
  must never fail a run because a report was rejected. `teamId` in
  `TeamConfig` is echoed as `sessionId` in every report.
- Skills are discovered by `core` and passed in `TeamConfig.skills` with
  their full content; the runtime must not read skill files itself.
- Node-only pi subpaths (`storage/*/node`, `images/node`) are unavailable. Keep
  the adapter boundary instead of polyfilling Node APIs.
- Rebuild `internal/runtime/moejs/assets/pi-durable.js` after changing
  `pi-runtime/src` (`bun run build`).

## Checks

```powershell
cd pi-runtime
bun run build
cd ..
go test ./internal/runtime/...
```
