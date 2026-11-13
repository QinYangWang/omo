# omo plugin design

Status: phase 1 (local plugins and ZIP sharing). No marketplace.

## Goals

- Let a plugin replace the whole native chat UI, or (later) add a piece to a
  named slot, without WebView2, HTML, or arbitrary native code.
- Keep plugin installation and sharing independent of any server operated by
  the omo project. Users can publish a ZIP anywhere.
- Keep the trust surface small: a plugin is data, and every host action it can
  request is declared and checked at runtime.

## Non-goals

- No official plugin index, no hosted marketplace, no signature authority, and
  no automatic updates.
- No JavaScript or native code execution in phase 1.
- No silent installs. The user always picks a folder or a ZIP.

## Distribution model

A plugin is a directory:

```text
todo-plugin/
  omo-plugin.json
  ui/
    main.json
  assets/
```

It is shared as a ZIP whose entries are the files above at the archive root
(`omo-plugin.json` must be the first-level entry). `Export ZIP` in the Plugins
page produces `"<id>-<version>.zip"` and reports the archive SHA-256 so the
author can publish that digest next to the download.

Install sources:

- a directory (development, or a cloned Git repository);
- a `.zip` file chosen by the user;
- a directory copied manually into `<data>/plugins/<id>/`.

There is no download button and no URL install in phase 1.

## Manifest

`omo-plugin.json`:

```json
{
  "schemaVersion": 1,
  "id": "com.example.todo",
  "name": "Todo",
  "version": "1.2.0",
  "apiVersion": 1,
  "description": "A todo list in the sidebar.",
  "author": "Example",
  "homepage": "https://github.com/example/omo-todo",
  "permissions": ["ui.replace", "chat.read", "chat.write"],
  "ui": { "main": "ui/main.json" }
}
```

Rules:

- `id` is lowercase letters, digits, `.`, `_` and `-`; it is also the install
  directory name.
- `apiVersion` must be `1`.
- `schemaVersion` is optional and defaults to `1`.
- Every path is relative, must stay inside the plugin directory, and must point
  to a regular file.
- Installing a plugin with an existing `id` replaces it in place. The previous
  enabled/active state is preserved when the new version still has a UI.
- New installs are disabled until the user enables them.

Fields reserved for later phases: `engines`, `kind`, `contributes.slots`,
`provides`, `requires`, and `main` for a sandboxed capability entry point.
They are documented here so plugin authors can plan, but phase 1 ignores them.

## Permissions

| Permission | Allows |
| --- | --- |
| `ui.replace` | Render the plugin UI as the whole main view |
| `chat.read` | Read the current session transcript |
| `chat.write` | Send messages and stop the active response |
| `settings.open` | Open the native settings page |
| `workspace.choose` | Open the native workspace picker |

Permissions are enforced in the host action dispatcher, not in the plugin
JSON. A button that is not allowed by the manifest does nothing. `ui.replace`
is the strongest permission and is shown prominently on the install/plugin
card.

## UI contract

Phase 1 supports one extension point: `ui.main` with `ui.replace`.

The plugin UI is a declarative widget tree rendered by
`internal/widgets` using MyGo native widgets. The tree may embed host controls
(`chat.transcript`, `chat.composer`, `sessions.list`) and request host actions
(`chat.new`, `chat.open`, `chat.send`, `chat.stop`, `settings.open`,
`plugins.open`, `workspace.choose`, `ui.builtin`).

Phase 2 adds named slots (`shell.header`, `chat.sidebar`,
`chat.composer.actions`, `settings.section`) and a page-level error boundary.

## Lifecycle

```text
installed (disabled) -> enabled -> active UI
        ^                  |           |
        +------ disable ---+-----------+
                     uninstall / replace
```

- State (`enabled`, `activeUi`) is persisted in `<data>/plugins/state.json`.
- Disabling or removing the active UI plugin immediately falls back to the
  built-in UI.
- A plugin UI that fails to parse or render shows a native failure page with
  "Use built-in UI" and "Plugins" actions; the rest of the app keeps running.
- Install and uninstall use a staging directory and an atomic rename, so a
  failed install cannot leave a half-written plugin behind.

## Security

- No code execution: the plugin supplies JSON only. There is no HTML, no
  WebView, no network access, and no filesystem API.
- ZIP extraction rejects absolute paths, `..` escapes, symlinks, oversized
  members, and archives that expand beyond 64 MiB.
- Because there is no marketplace, there is no signature verification and no
  implied publisher identity. The UI shows the source and the permission list;
  trusting a plugin is the user's decision.
- A future capability entry point must run in an isolated moejs Realm behind a
  permission-checked host bridge, never with direct Go or Node access.

## Ownership

This design belongs to the `plugin` subsystem, which also owns the built-in
channel and git adapters (host code behind permissions, not user scripts). The
widget schema and renderer belong to `native-ui`; changes to the schema require
both owners.
