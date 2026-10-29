#!/bin/sh
# Measures omo's startup and idle cost on Linux and macOS.
#
# This is the reproducible baseline for docs/benchmarks.md (docs/roadmap.md P0).
# It reports what the machine does; it is not a product promise.
#
#   ./scripts/bench/bench.sh
#   SAMPLES=5 IDLE_SECONDS=30 ./scripts/bench/bench.sh
#
# The app must be built first: CGO_ENABLED=0 go build -o build/omo .
# On Linux an X11 or Wayland session is required; a headless CI box cannot open
# a window, so the startup half is skipped there.

set -eu

EXE=${EXE:-build/omo}
SAMPLES=${SAMPLES:-9}
IDLE_SECONDS=${IDLE_SECONDS:-60}

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
[ -x "$EXE" ] || { echo "missing $EXE; run: CGO_ENABLED=0 go build -o build/omo ." >&2; exit 1; }

median() {
    sort -n | awk '{a[NR]=$1} END {if (NR==0) {print "n/a"; exit}
        if (NR%2) print a[(NR+1)/2]; else printf "%.1f\n", (a[NR/2]+a[NR/2+1])/2}'
}

echo "== startup (main() to first frame) =="
tmp=$(mktemp)
i=0
while [ "$i" -lt "$SAMPLES" ]; do
    i=$((i + 1))
    ms=$(OMO_BENCH_STARTUP=1 "$EXE" 2>/dev/null | sed -n 's/.*first_frame_ms=\([0-9.]*\).*/\1/p' | head -1)
    if [ -n "$ms" ]; then
        echo "$ms" >>"$tmp"
        echo "  sample $i: $ms ms"
    else
        echo "  sample $i: no measurement (no display?)"
    fi
    sleep 0.3
done
if [ -s "$tmp" ]; then
    echo "  median: $(median <"$tmp") ms   min: $(sort -n <"$tmp" | head -1) ms   max: $(sort -n <"$tmp" | tail -1) ms   n: $(wc -l <"$tmp" | tr -d ' ')"
fi
rm -f "$tmp"

echo
echo "== idle (settled window, ${IDLE_SECONDS}s) =="
"$EXE" >/dev/null 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT INT TERM

sleep 3
if ! kill -0 "$pid" 2>/dev/null; then
    echo "  app exited early; idle not measured" >&2
    exit 0
fi

rss0=$(ps -o rss= -p "$pid" | tr -d ' ')
cpu0=$(ps -o time= -p "$pid" | tr -d ' ')
echo "  settled: rss ${rss0} KB, cpu time ${cpu0}"

sleep "$IDLE_SECONDS"

rss1=$(ps -o rss= -p "$pid" | tr -d ' ')
cpu1=$(ps -o time= -p "$pid" | tr -d ' ')
echo "  after:   rss ${rss1} KB, cpu time ${cpu1}"
echo "  note: ps reports cumulative CPU time ([[dd-]hh:]mm:ss); compute the delta by hand"
echo "        for an exact idle figure, or use: ps -o %cpu= -p $pid"

kill "$pid" 2>/dev/null || true
trap - EXIT INT TERM

echo
echo "Record the numbers in docs/benchmarks.md with the machine and commit they came from."
