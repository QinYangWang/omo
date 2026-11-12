# native-ui subsystem

Owns `internal/ui` and `internal/widgets`.

## Responsibilities

- The native chat shell, sidebar, settings and plugins pages.
- The declarative widget schema and renderer used by UI plugins.
- Theme consistency, accessibility and native behavior. No WebView2, HTML or
  arbitrary drawing.

## Contracts

- Widget JSON is a public plugin contract. Additive changes only; bump
  `apiVersion` for breaking changes and update `docs/plugin-design.md`.
- Host actions and data bindings are the only way a plugin touches the app.
- A plugin render failure must show a native fallback page, never crash the
  window.

## Checks

```powershell
go test ./internal/widgets ./internal/ui
```
