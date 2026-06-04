$ErrorActionPreference = 'SilentlyContinue'

Write-Host '== 8081 listeners =='
Get-NetTCPConnection -State Listen -LocalPort 8081 | Format-Table LocalAddress, LocalPort, OwningProcess -AutoSize

Write-Host '== reach 127.0.0.1:8081 (loopback IPv4) =='
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:8081/' -UseBasicParsing -TimeoutSec 5
  Write-Host ('   HTTP ' + $r.StatusCode)
} catch {
  Write-Host ('   FAILED: ' + $_.Exception.Message)
}

Write-Host '== reach 192.168.1.13:8081 (LAN) =='
try {
  $r = Invoke-WebRequest 'http://192.168.1.13:8081/' -UseBasicParsing -TimeoutSec 5
  Write-Host ('   HTTP ' + $r.StatusCode)
} catch {
  Write-Host ('   FAILED: ' + $_.Exception.Message)
}
