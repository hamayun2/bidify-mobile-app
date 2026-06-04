try {
    $r = Invoke-RestMethod -Uri 'http://192.168.1.13:4000/api/health' -TimeoutSec 4
    Write-Host ("LAN API OK: " + ($r | ConvertTo-Json -Compress))
} catch {
    Write-Host ("LAN API FAIL: {0}" -f $_.Exception.Message)
}

try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/api/health' -TimeoutSec 4
    Write-Host ("LOOPBACK API OK: " + ($r | ConvertTo-Json -Compress))
} catch {
    Write-Host ("LOOPBACK API FAIL: {0}" -f $_.Exception.Message)
}

Write-Host ''
Write-Host 'Active LAN IPv4s (for phone to connect):'
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object IPAddress, InterfaceAlias, PrefixOrigin |
    Format-Table -AutoSize
