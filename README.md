# omo

omo is a native desktop AI chat and agent platform:

- **Host UI**: MyGo native widgets (`github.com/egoist/mygo/ui`). The built-in
  chat shell is native.
- **UI plugins**: a declarative native widget language. A UI plugin can replace
  the entire main view without introducing WebView2 or HTML.
- **Plugin sharing**: plugins are plain folders or ZIP files. omo installs and
  exports them locally; there is no marketplace to operate or trust.
- **Agent runtime**: official `@earendil-works/pi-durable` 1.5.2, bundled with
  esbuild and executed in-process by moejs, a pure-Go JavaScript runtime.
- **Providers/models**: pi-ai is the only provider/model registry. Settings
  exposes the pi-ai catalog, and custom OpenAI-compatible endpoints can fetch
  model IDs from `{Base URL}/models`.
- **Storage**: SQLite through `modernc.org/sqlite`, with Pi Durable's portable
  `SqliteStorage` interface over a Go adapter.

The core chain:

```text
MyGo native UI → Go → moejs → pi-durable → pi-ai → LLM (SSE)
                                    ↘ workspace tools → Go file adapter
UI plugin schema → omo native widget library
plugin folder / ZIP → declarative native UI
```

## Quick start (Windows)

```powershell
cd pi-runtime
bun install
bun run build
cd ..
go build -o bin/omo.exe ./cmd/omo
./bin/omo.exe
```

Or:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

Requirements:

- Go 1.27.3 or newer.
- Bun 1.2+ only to build the embedded pi-durable runtime.
- No Node.js, Bun, WebView2 or HTML runtime is needed by the shipped app.

## Settings and credentials

Settings live in `%AppData%\omo` on Windows (`~/.config/omo` on Linux,
`~/Library/Application Support/omo` on macOS). Set `OMO_DATA` to override the
directory; `MYGO_AI_DATA` is still accepted for migration.

- `settings.json` stores the selected provider, model, endpoint override,
  temperature, token limit and workspace.
- `credentials.json` stores one credential per provider.
- The old single `api-key` file is migrated on load.

The pi-ai catalog shipped with 1.5.2 contains 43 built-in providers and 1,643
chat models. The synthetic `openai-compatible` entry adds the current custom
model, so Settings normally shows 44 providers and 1,644 models.

`Fetch models` is manual: it calls `{Base URL}/models`, accepts the common
`data[].id` shape (also `models[].id` and string arrays), and adds discovered
IDs to the custom provider as pi-ai `openai-completions` entries. The discovered
list is not persisted.

## Plugins

Open **Plugins** in the sidebar to install from a folder or a ZIP, enable a
plugin, and choose **Use as UI** to replace the main view. New plugins start
disabled. **Export ZIP** packs an installed plugin so it can be shared
anywhere, together with its SHA-256 digest.

There is no official marketplace, index, or signature authority. A plugin is
whatever folder or ZIP the user chooses, and installing one is an explicit
local action.

Plugin package layout:

```text
omo-plugin.json
ui/
  main.json
```

The manifest declares an API version, permissions and an optional UI entry:

```json
{
  "schemaVersion": 1,
  "id": "omo.sample-dashboard",
  "name": "Sample Dashboard",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": ["ui.replace", "chat.read", "chat.write"],
  "ui": { "main": "ui/main.json" }
}
```

Supported permissions are `ui.replace`, `chat.read`, `chat.write`,
`settings.open` and `workspace.choose`. UI actions are checked against these
permissions at runtime.

### Declarative widget library

`internal/widgets` is omo's own control layer. Plugins describe native UI as
JSON; the host renders it with MyGo widgets. Supported primitives include
`page`, `row`, `column`, `card`, `header`, `heading`, `text`, `button`, `input`,
`textarea`, `list`, `divider` and `spacer`. Host controls include
`chat.transcript`, `chat.composer` and `sessions.list`.

Data binding uses `{{path}}` templates. Available values include `app.name`,
`workspace`, `status`, `activeUi`, `provider`, `model`, `session.title`,
`session.id`, `sessions` and `messages`. Buttons perform host actions such as
`chat.new`, `chat.open`, `chat.send`, `settings.open`, `plugins.open`,
`workspace.choose` and `ui.builtin`.

The example plugin is in
`examples/plugins/omo.sample-dashboard`.
See `docs/plugin-design.md` for the full manifest, permission, lifecycle and
sharing contract.

## Headless checks

```powershell
go run ./cmd/smoketest -data "$env:AppData\omo" -catalog
go run ./cmd/smoketest -data "$env:AppData\omo" -prompt "List the files and summarize sample.txt."
```

## Layout

```text
cmd/omo/             desktop entry point
cmd/smoketest/       headless runtime driver
internal/app/        app state, sessions, settings, plugin actions
internal/ui/         native shell + widget host adapter
internal/plugins/    manifests, install lifecycle, ZIP import/export
internal/widgets/    declarative schema and native renderer
internal/chat/       app SQLite store
internal/config/     settings + per-provider credentials
internal/host/       workspace-scoped file adapter
internal/runtime/    moejs engine + embedded pi-durable bundle
pi-runtime/          esbuild project for the official Pi Durable packages
examples/plugins/    plugin source examples
docs/                plugin design and subsystem ownership
```

## Limitations

- Windows is the only platform actually run. The code is otherwise
  OS-independent apart from paths and process packaging.
- The widget library is declarative, not arbitrary native code. Plugin authors
  can compose supported native widgets; they cannot draw arbitrary pixels.
- Plugins are unsigned. The install page shows the source and permissions, and
  trusting a plugin is the user's decision.
- Credentials are files, not system-keychain entries.
- One window and one active runtime session at a time; compaction, subagents,
  MCP and browser/desktop automation are out of scope for this phase.

## License notes

Pi Durable and pi-ai are MIT-licensed. moejs is Apache-2.0 and ships
third-party notices; distributed builds must include
`THIRD_PARTY_NOTICES` from the moejs module.
