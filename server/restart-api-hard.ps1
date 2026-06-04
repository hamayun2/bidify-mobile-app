$ErrorActionPreference = 'SilentlyContinue'
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ("kill node PID {0}" -f $_.Id)
    Stop-Process -Id $_.Id -Force
}
Start-Sleep -Milliseconds 800
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Start-Process -FilePath 'node' -ArgumentList 'server\index.js' -WorkingDirectory $repo -WindowStyle Minimized
Start-Sleep -Milliseconds 1500
try {
    $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4000/api/health' -TimeoutSec 4
    Write-Host ("health = {0}" -f $r.StatusCode)
} catch {
    Write-Host ("health failed: {0}" -f $_.Exception.Message)
}
