# omo — Go native AI coding IDE with ACP agents

Native Go desktop IDE (no web view, no Electron, no Node in the runtime) that talks to local
agent runtimes over the [Agent Client Protocol](https://agentclientprotocol.com) v1.

- Module: `github.com/QinYangWang/omo`
- Go: **1.27.3** (required by MyGo), `CGO_ENABLED=0` on all targets
- UI: [MyGo](https://mygo.egoist.dev) native toolkit (self-drawn, Metal / D3D11 / OpenGL / CPU)

**Status: P3 and P4 (terminal, git) implemented.** Working today:

- open a workspace with the native folder picker, browse a lazily loaded file tree
- edit and save files (atomic writes); a file changed under you raises a conflict dialog instead of
  overwriting the agent's write
- see what differs from git HEAD, review it in a split diff with per-hunk revert/keep, apply the result,
  and stage every changed path under the workspace
- run a real native terminal (Ghostty VT) in the workspace root, up to four sessions side by side
- a window that draws its own title bar, with the project's sessions on the left, the conversation in
  the middle and the project's files, changes, quick commands and browser on the right
- configure and trust a local ACP v1 agent, chat with streamed updates, approve or reject permissions,
  cancel a turn, and restart with session restore when the agent supports it
- review what the agent changed: the files it touched, the lines it added and deleted, per-hunk
  keep/revert, or revert every file to what it was before the agent touched it
- reopen where you left off: the last workspace, its open files and the agent session mapping live in
  a local SQLite database
- use the platform's own menu bar (File / Edit / View) with accelerators

Use **Agents…** in the chat panel to add an executable and its arguments (one per line). The first
start shows the exact launch details and requires trust. Agent file changes show up under Changes,
with **Review** opening the list of files it touched.

Not yet: workspace search and LSP. See
[docs/roadmap.md](docs/roadmap.md).

## Run

```sh
go build -o build/omo .        # or: go run .
./build/omo
```

## Check

```sh
go build ./... && go vet ./... && go test ./... && go test -race ./...
go run github.com/egoist/mygo/cmd/mygo@v0.7.3 vet .   # UI element lifetime checks
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
Screenshots of the UI (generated, not hand-taken) and the current layout: [docs/ui.md](docs/ui.md).
The visual rules the whole UI follows: [DESIGN.md](DESIGN.md).
The UI design system (tokens and components): [docs/kit.md](docs/kit.md).
Working in this repo as an agent: [AGENTS.md](AGENTS.md).
Contributing (branches, commit messages, squash-only PRs): [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

```
main.go              assembly only: app.New, window, Run
internal/app         state, intents, commands, terminals, agent UI state, startup benchmark
internal/agent       JSON catalog, ACP raw protocol adapter, process/session/permission governance
internal/view        panels and the window (sessions, editor, session window, status bar)
internal/kit         design system: tokens, components, icons (docs/kit.md)
internal/workspace   os.Root boundary, reads/writes, watcher
internal/documents   editor buffers, atomic save, disk conflicts
internal/git         system git: branch, changed files, HEAD text
internal/diff        review baselines and applying a review
internal/persistence SQLite: workspaces, layout, session mapping, bounded events
internal/commands    command registry
internal/i18n        message catalogs (en, zh-Hans) + lookup
docs/                architecture, dependencies, interfaces, security, roadmap, ADR
```

Rules that the design depends on: code comments and identifiers are English, all user-visible
text goes through `internal/i18n`, everything drawn in a panel comes from `internal/kit`, the view
layer never imports an ACP SDK or opens a process, and app state is written on the main thread only.

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
