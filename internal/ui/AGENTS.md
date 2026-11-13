# native-ui subsystem

Owns `internal/ui` (the shell and the plugin widget renderer) and `pkg/` (the
forked Lobe MyGo component library). There is no separate kit layer: views and
widgets call `pkg/` directly, with their shared theme, palette and sizes in
`internal/ui/components.go`.

## Responsibilities

- The native chat shell, rail, sidebar, details panel, settings and plugins
  pages.
- The declarative widget schema and renderer used by UI plugins, in the same
  package (`widget_*.go`).
- Theme consistency, accessibility and native behavior. No WebView2, HTML or
  arbitrary drawing.

## Contracts

- Widget JSON is a public plugin contract. Additive changes only; bump
  `apiVersion` for breaking changes and update `docs/plugin-design.md`.
- Host actions and data bindings are the only way a plugin touches the app.
  `app` hands the shell the raw UI document (`PluginUIFile`); the shell parses
  it, so `internal/app` never imports `internal/ui`.
- A plugin render failure must show a native fallback page, never crash the
  window.

## Checks

```powershell
go test ./internal/ui
```

## Components

- `pkg/` is omo's fork of Lobe MyGo (MIT, `pkg/LICENSE`), part of this module:
  imports read `github.com/QinYangWang/omo/pkg/theme`. See `pkg/README.md` for
  syncing upstream.
- Shared style helpers live in `internal/ui/components.go`: `Apply` (theme),
  `Colors` (palette) and thin omo defaults over `pkg` components. Add a helper
  there only when several screens need the same look.
- Widget `type`s map to those helpers in `widget_render.go`; the JSON schema
  stays unchanged.
