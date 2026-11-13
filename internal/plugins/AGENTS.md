# plugin subsystem

Owns `internal/plugins`, `examples/plugins`, `docs/plugin-design.md`, and the
built-in integration adapters for channels and git.

## Responsibilities

- Plugin manifest validation, install/replace/uninstall, enable/disable, active
  UI state and the ZIP import/export path.
- Permission enforcement support and safe archive handling.
- The example plugin and the plugin design document.
- Built-in adapters behind explicit permissions: the GitHub issues channel
  (polling ingress, comments and labels as egress) and the git/PR adapter used
  by the work-item lifecycle.

## Hard rules

- No marketplace, index, signature verification, URL download, or auto-update.
  Sharing is a ZIP the user exports and another user imports.
- User plugins are data. Do not add JavaScript or native code execution without
  an isolated moejs Realm and a permission-checked bridge.
- Adapters are host code, not user plugin code. Each one needs an explicit
  permission (`channel.github`, `git.push`, ...) and must never run inside the
  agent's sandbox.
- Reject absolute paths, `..` escapes, symlinks, non-regular files, and archives
  over 64 MiB.
- UI schema changes require coordination with `native-ui`.

## Checks

```powershell
go test ./internal/plugins
```
