$ErrorActionPreference = 'SilentlyContinue'
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server.\\index\.js' -or $_.CommandLine -match 'server/index\.js' } |
    ForEach-Object {
        Write-Host ("Stopping API node PID {0}" -f $_.ProcessId)
        Stop-Process -Id $_.ProcessId -Force
        $script:killed++
    }
$listeners = Get-NetTCPConnection -State Listen -LocalPort 4000 -ErrorAction SilentlyContinue
foreach ($l in $listeners) {
    Write-Host ("Force-stopping listener PID {0} on :4000" -f $l.OwningProcess)
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
    $script:killed++
}
Start-Sleep -Milliseconds 800
Write-Host ("killed = {0}" -f $script:killed)
