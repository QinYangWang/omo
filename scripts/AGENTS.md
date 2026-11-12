# build-infra subsystem

Owns `scripts/`, `.gitignore`, `README.md` and `docs/subsystems.md`.

## Responsibilities

- Reproducible Windows builds: `scripts/build.ps1` runs Bun for the runtime
  bundle, then builds `bin/omo.exe`.
- Artifact hygiene: `bin/`, `.tmp/`, `.data/`, build caches and the generated
  `internal/runtime/moejs/assets/pi-durable.js` stay out of Git.
- Documentation entry points and the subsystem registry.

## Rules

- Never commit credentials, plugin signing keys, databases or build output.
- Keep the quick start working from a clean clone: Bun only for the embedded
  runtime, Go for the app.
- Update `README.md` when a build step or output path changes.

## Checks

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```
