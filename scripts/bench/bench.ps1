# Measures omo's startup and idle cost on Windows.
#
# This is the reproducible baseline for docs/benchmarks.md (docs/roadmap.md P0,
# acceptance item 2 and 3). Nothing here is a product promise: it reports what
# this machine does, so a regression shows up as a changed number.
#
#   pwsh -File scripts/bench/bench.ps1
#   pwsh -File scripts/bench/bench.ps1 -Samples 5 -IdleSeconds 30
#
# The app must be built first: go build -o build/omo.exe .

param(
    [string]$Exe = "build/omo.exe",
    [int]$Samples = 9,
    [int]$IdleSeconds = 60
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exePath = Join-Path $root $Exe
if (-not (Test-Path $exePath)) {
    throw "missing $exePath; run: go build -o build/omo.exe ."
}

function Get-Median([double[]]$values) {
    if ($values.Count -eq 0) { return [double]::NaN }
    $sorted = $values | Sort-Object
    $mid = [int][math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2 -eq 1) { return [double]$sorted[$mid] }
    return [double](($sorted[$mid - 1] + $sorted[$mid]) / 2)
}

Write-Output "== startup (main() to first frame) =="
$startup = @()
for ($i = 0; $i -lt $Samples; $i++) {
    $env:OMO_BENCH_STARTUP = "1"
    try {
        $out = & $exePath 2>$null
    }
    finally {
        Remove-Item Env:OMO_BENCH_STARTUP -ErrorAction SilentlyContinue
    }
    $m = [regex]::Match(($out -join "`n"), "first_frame_ms=([0-9.]+)")
    if ($m.Success) {
        $ms = [double]$m.Groups[1].Value
        $startup += $ms
        Write-Output ("  sample {0}: {1:N1} ms" -f ($i + 1), $ms)
    }
    else {
        Write-Output ("  sample {0}: no measurement" -f ($i + 1))
    }
    Start-Sleep -Milliseconds 300
}
if ($startup.Count -gt 0) {
    $sorted = $startup | Sort-Object
    Write-Output ("  median: {0:N1} ms   min: {1:N1} ms   max: {2:N1} ms   n: {3}" -f `
            (Get-Median $startup), $sorted[0], $sorted[$sorted.Count - 1], $startup.Count)
}

Write-Output ""
Write-Output "== idle (settled window, $IdleSeconds s) =="
$proc = Start-Process -FilePath $exePath -PassThru
try {
    Start-Sleep -Seconds 3
    $proc.Refresh()
    $cpu0 = $proc.CPU
    $ws0 = $proc.WorkingSet64
    $priv0 = $proc.PrivateMemorySize64
    Write-Output ("  settled: working set {0:N1} MB, private {1:N1} MB" -f ($ws0 / 1MB), ($priv0 / 1MB))

    Start-Sleep -Seconds $IdleSeconds
    $proc.Refresh()
    $cpu1 = $proc.CPU
    $ws1 = $proc.WorkingSet64
    $priv1 = $proc.PrivateMemorySize64

    $cpuDelta = $cpu1 - $cpu0
    $pct = 100.0 * $cpuDelta / $IdleSeconds
    Write-Output ("  cpu: {0:N3} s over {1} s  ({2:N3} % of one core)" -f $cpuDelta, $IdleSeconds, $pct)
    Write-Output ("  after:  working set {0:N1} MB, private {1:N1} MB" -f ($ws1 / 1MB), ($priv1 / 1MB))
}
finally {
    Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue
}

Write-Output ""
Write-Output "Record the numbers in docs/benchmarks.md with the machine and commit they came from."
