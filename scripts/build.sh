#!/usr/bin/env sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

(cd "$root/pi-runtime" && bun install && bun run build)
mkdir -p "$root/bin"
(cd "$root" && go build -trimpath -o "$root/bin/omo" ./cmd/omo)
echo "built bin/omo"
