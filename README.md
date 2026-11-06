# omo — a native console for local ACP agents

omo starts the coding agents installed on your machine (Claude Code, Codex, Gemini CLI, Pi, Kimi CLI,
Qwen Code, or any program that speaks the [Agent Client Protocol](https://agentclientprotocol.com) v1),
shows their plan, tool calls and changes, and asks you before they write or run anything. It is a native
Go desktop app: no web view, no Electron, no Node in the runtime.

- Module: `github.com/QinYangWang/omo`
- Go: **1.27.3** (required by MyGo), `CGO_ENABLED=0` on all targets
- UI: [MyGo](https://mygo.egoist.dev) native toolkit (self-drawn, Metal / D3D11 / OpenGL / CPU)
- Design: Doop canvas `C73kBnDHCY` (omo-app-style v2), rules in [DESIGN.md](DESIGN.md)

Working today:

- a sidebar with the projects you opened, the open project's sessions and the state of every local
  agent process (running, idle, not started, failed)
- a new-session screen with the project and branch, a composer, quick commands (`/review`, `/fix-ci`, …)
  and the recent sessions
- a session view: the conversation, tool calls as cards (consecutive reads folded), the agent's ACP plan,
  the session's facts and the files it changed in a 300 DIP inspector
- approvals inline: allow once, always allow in this session (omo's own grant, never `allow_always`),
  or deny; an error card with the agent's process output and three ways on (sign in again in a
  terminal, retry, hand the message to another agent)
- a 520 DIP panel with the agent's changes as diffs (keep, revert, commit), the project's files and
  up to four native terminals (Ghostty VT)
- search over sessions, files and commands; an agent picker; first-run trust showing the exact launch
- scheduled tasks (saved; the scheduler is not built yet) and settings pages for preferences,
  appearance (light / dark / system), shortcuts, agents, quick commands, projects and more
- the last workspace, the agent session mapping and your preferences live in a local SQLite database

omo finds the ACP agents it knows on `PATH` at startup; each still shows its exact launch details and
asks for trust the first time it starts. What the design shows without a backend yet (usage, MCP,
roles, memory, sharing, the task scheduler, models) is listed in [docs/roadmap.md](docs/roadmap.md) §9.6.

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
internal/view        the window: sidebar, new session, session, inspector and side panel, overlays,
                     scheduled tasks, settings
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
