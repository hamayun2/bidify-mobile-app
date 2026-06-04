$ErrorActionPreference = 'SilentlyContinue'

Write-Host '== API health =='
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4000/api/health' -UseBasicParsing -TimeoutSec 4
  Write-Host ('   ' + $r.StatusCode + ' ' + $r.Content)
} catch {
  Write-Host ('   FAILED: ' + $_.Exception.Message)
}

Write-Host ''
Write-Host '== LAN IPv4 addresses =='
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } |
  Select-Object IPAddress, InterfaceAlias |
  Format-Table -AutoSize

Write-Host '== Listening ports =='
Get-NetTCPConnection -State Listen -LocalPort 4000,8081,8082,8083,8084 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess |
  Format-Table -AutoSize
