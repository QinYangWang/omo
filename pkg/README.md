# pkg — omo's UI kit

The Lobe UI components omo draws with, forked from
[lobe-mygo](https://github.com/lobehub/lobe-mygo) (MIT, `LICENSE` here) into
this module so the app owns its style.

- `theme` — design tokens and the MyGo theme they make.
- `action`, `field`, `display`, `layout`, `overlay`, `nav`, `feedback`,
  `choice`, `form`, `code`, `markdown` — components.
- `motion`, `lucide` — animation and icons.

`internal/ui/components.go` holds omo's theme, palette and default component
styles. Change the app's look there first; change `pkg` only for a component's
behavior.

## Syncing upstream

```bash
git clone --depth 1 https://github.com/lobehub/lobe-mygo /tmp/lobe-mygo
rsync -a --delete /tmp/lobe-mygo/pkg/ pkg/
grep -rl github.com/lobehub/lobe-mygo pkg | xargs sed -i 's|github.com/lobehub/lobe-mygo|github.com/QinYangWang/omo|g'
go mod tidy && go test ./pkg/...
```

Keep `pkg/LICENSE` and `pkg/lucide/LICENSE` with the copied code.
