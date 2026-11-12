# plugin-platform subsystem

Owns `internal/plugins`, `examples/plugins` and `docs/plugin-design.md`.

## Responsibilities

- Plugin manifest validation, install/replace/uninstall, enable/disable, active
  UI state and the ZIP import/export path.
- Permission enforcement support and safe archive handling.
- The example plugin and the plugin design document.

## Hard rules

- No marketplace, index, signature verification, URL download, or auto-update.
  Sharing is a ZIP the user exports and another user imports.
- Plugins are data. Do not add JavaScript or native code execution without an
  isolated moejs Realm and a permission-checked bridge.
- Reject absolute paths, `..` escapes, symlinks, non-regular files, and archives
  over 64 MiB.
- UI schema changes require coordination with `native-ui`.

## Checks

```powershell
go test ./internal/plugins
```
