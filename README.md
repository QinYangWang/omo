# omo — Go native AI coding IDE with ACP agents

Native Go desktop IDE (no web view, no Electron, no Node in the runtime) that talks to local
agent runtimes over the [Agent Client Protocol](https://agentclientprotocol.com) v1.

- Module: `github.com/QinYangWang/omo`
- Go: **1.27.3** (required by MyGo), `CGO_ENABLED=0` on all targets
- UI: [MyGo](https://mygo.egoist.dev) native toolkit (self-drawn, Metal / D3D11 / OpenGL / CPU)

**Status: P1 done.** Working today:

- open a workspace with the native folder picker, browse a lazily loaded file tree
- edit and save files (atomic writes); a file changed under you raises a conflict dialog instead of
  overwriting the agent's write
- see what differs from git HEAD, review it in a split diff with per-hunk revert/keep, apply the result
- run a real native terminal (Ghostty VT) in the workspace root, several sessions side by side
- use the platform's own menu bar (File / Edit / View) with accelerators

Not yet: workspace search, LSP, and ACP chat. Agents can already run in the terminal — the files they
edit show up under Changes. See [docs/roadmap.md](docs/roadmap.md).

## Run

```sh
go build -o build/omo .        # or: go run .
./build/omo
```

## Check

```sh
go build ./... && go vet ./... && go test ./... && go test -race ./...
go run github.com/egoist/mygo/cmd/mygo@v0.7.3 vet ./...   # UI element lifetime checks
```

## Measure

```powershell
go build -o build/omo.exe .
pwsh -File scripts/bench/bench.ps1
```

```sh
CGO_ENABLED=0 go build -o build/omo .
./scripts/bench/bench.sh
```

Baseline numbers and their caveats: [docs/benchmarks.md](docs/benchmarks.md).
Screenshots of the UI, and how to reproduce them: [docs/ui.md](docs/ui.md).

## Layout

```
main.go              assembly only: app.New, window, Run
internal/app         state, intents, commands, terminals, startup benchmark
internal/view        the view layer (rail, panels, editor, diff, terminal, status bar)
internal/workspace   os.Root boundary, reads/writes, watcher
internal/documents   editor buffers, atomic save, disk conflicts
internal/git         system git: branch, changed files, HEAD text
internal/diff        review baselines and applying a review
internal/commands    command registry
internal/i18n        message catalogs (en, zh-Hans) + lookup
docs/                architecture, dependencies, interfaces, security, roadmap, ADR
```

Rules that the design depends on: code comments and identifiers are English, all user-visible
text goes through `internal/i18n`, the view layer never imports an ACP SDK or opens a process,
and app state is written on the main thread only.

## Docs

| Doc | What it covers |
|---|---|
| [docs/README.md](docs/README.md) | index, one-page conclusions |
| [docs/architecture.md](docs/architecture.md) | diagrams, module rules, data flows, threading, lifecycle |
| [docs/interfaces.md](docs/interfaces.md) | Go interface drafts, session state machine |
| [docs/dependencies.md](docs/dependencies.md) | pinned versions, licenses, verified build matrix |
| [docs/security.md](docs/security.md) | trust model, path confinement, permissions, retention |
| [docs/roadmap.md](docs/roadmap.md) | phases, acceptance criteria, risks |
| [docs/benchmarks.md](docs/benchmarks.md) | measured baseline |
| [docs/adr/0001-native-ui-acp.md](docs/adr/0001-native-ui-acp.md) | why MyGo, why ACP v1, why a subprocess |
