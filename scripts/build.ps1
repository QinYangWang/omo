# Builds the Pi Durable bundle and the omo desktop app on Windows.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Push-Location (Join-Path $root "pi-runtime")
try {
  bun install
  bun run build
} finally {
  Pop-Location
}

Push-Location $root
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $root "bin") | Out-Null
  go build -trimpath -o (Join-Path $root "bin\omo.exe") ./cmd/omo
  Write-Host "built bin\omo.exe"
} finally {
  Pop-Location
}
