$ErrorActionPreference = 'SilentlyContinue'
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force
}
Start-Sleep -Milliseconds 600

$logPath = Join-Path $env:TEMP 'bidify-api.log'
if (Test-Path $logPath) { Remove-Item $logPath -Force }

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$proc = Start-Process -FilePath 'node' -ArgumentList 'server\index.js' `
    -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" -PassThru
Start-Sleep -Seconds 2

Write-Host "--- stdout ---"
if (Test-Path $logPath) { Get-Content $logPath -Tail 40 }
Write-Host ""
Write-Host "--- stderr ---"
if (Test-Path "$logPath.err") { Get-Content "$logPath.err" -Tail 40 }
