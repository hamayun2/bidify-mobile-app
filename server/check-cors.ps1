$ErrorActionPreference = 'SilentlyContinue'
Write-Host '== API reachable from loopback IPv4 (127.0.0.1) =='
try { (Invoke-WebRequest 'http://127.0.0.1:4000/api/health' -UseBasicParsing -TimeoutSec 4).Content }
catch { Write-Host ('FAIL: ' + $_.Exception.Message) }

Write-Host ''
Write-Host '== API reachable as localhost =='
try { (Invoke-WebRequest 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 4).Content }
catch { Write-Host ('FAIL: ' + $_.Exception.Message) }

Write-Host ''
Write-Host '== API reachable from LAN IP =='
try { (Invoke-WebRequest 'http://192.168.1.13:4000/api/health' -UseBasicParsing -TimeoutSec 4).Content }
catch { Write-Host ('FAIL: ' + $_.Exception.Message) }

Write-Host ''
Write-Host '== CORS preflight from browser origin localhost:8081 =='
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:4000/api/health' -UseBasicParsing -Method Options `
       -Headers @{ 'Origin' = 'http://localhost:8081'; 'Access-Control-Request-Method' = 'GET' } -TimeoutSec 4
  Write-Host ('   HTTP ' + $r.StatusCode)
  Write-Host ('   ACAO: ' + $r.Headers['Access-Control-Allow-Origin'])
  Write-Host ('   ACAC: ' + $r.Headers['Access-Control-Allow-Credentials'])
} catch { Write-Host ('FAIL: ' + $_.Exception.Message) }
