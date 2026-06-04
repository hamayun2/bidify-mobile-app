$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server.\\index\.js' } |
    ForEach-Object {
        Write-Host ("Stopping API node PID {0}" -f $_.ProcessId)
        Stop-Process -Id $_.ProcessId -Force
    }
Start-Sleep -Milliseconds 600
$apiCwd  = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $apiCwd
Push-Location $repoDir
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','node','server\index.js' -WindowStyle Minimized
Pop-Location
Start-Sleep -Milliseconds 800
try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4000/api/health' -TimeoutSec 4
    Write-Host ("API health: {0}" -f $r.StatusCode)
} catch {
    Write-Host ("API health probe failed: {0}" -f $_.Exception.Message)
}
