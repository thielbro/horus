# dev-watchdog.ps1 — run `next dev` with a hard process-count kill-switch.
#
# This is the DEFAULT `npm run dev` (the raw, unguarded server is `npm run dev:raw`).
# HORUS once made Turbopack's dev server spawn node.exe workers without bound (a
# deprecated `middleware.ts`, since migrated to `proxy.ts`). This script guards against
# any regression: it starts `next dev` and watches the live node process count for the
# WHOLE lifetime of the server; if the count ever blows past the threshold it kills the
# entire dev tree instantly, so a regression can never take the machine down again.
#
# Usage:
#   npm run dev                          # guarded (this script)
#   npm run dev:raw                      # raw `next dev`, no guard
#   pwsh ./scripts/dev-watchdog.ps1 -Threshold 80
#
# Healthy: the count settles (typically well under 40), it reports "serving", and KEEPS
# guarding until the server exits or you press Ctrl+C (which also stops the server).

param(
  [int]$Threshold = 80
)

$root = $null
try {
  $root = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev:raw" -PassThru -WindowStyle Hidden
} catch {
  Write-Host "Failed to start next dev: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
$rootPid = $root.Id
Write-Host "next dev started (pid $rootPid). Guarding: kill if node procs > $Threshold. Ctrl+C to stop." -ForegroundColor Cyan

$peak = 0
$served = $false
try {
  while (-not $root.HasExited) {
    $c = (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($c -gt $peak) { $peak = $c }

    if ($c -gt $Threshold) {
      Write-Host "`nFORK-BOMB DETECTED ($c > $Threshold). Killing dev tree $rootPid..." -ForegroundColor Red
      taskkill /T /F /PID $rootPid 2>$null | Out-Null
      Start-Sleep -Milliseconds 1200
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*\.next\dev*' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
      Write-Host "Killed. The fork-bomb is NOT fixed — investigate before retrying." -ForegroundColor Red
      exit 1
    }

    if (-not $served) {
      try {
        if ((Invoke-WebRequest -UseBasicParsing http://localhost:3005 -TimeoutSec 2).StatusCode -eq 200) {
          $served = $true
          Write-Host "`nServing at http://localhost:3005 (peak node procs: $peak). Still guarding." -ForegroundColor Green
        }
      } catch {}
    }

    Write-Host ("`r[guard] node procs: {0,-5} peak {1,-5}" -f $c, $peak) -NoNewline
    Start-Sleep -Milliseconds 400
  }
} finally {
  # Make sure the dev tree dies with the watchdog (e.g. on Ctrl+C).
  if ($root -and -not $root.HasExited) { taskkill /T /F /PID $rootPid 2>$null | Out-Null }
}

Write-Host "`nnext dev exited. Peak node procs: $peak"
