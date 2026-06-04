$ErrorActionPreference = 'SilentlyContinue'

Write-Host '== killing zombie Expo / Metro servers (ports 8081-8084) =='
$pidsExpo = @()
foreach ($p in 8081,8082,8083,8084) {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    if ($c.OwningProcess -and -not ($pidsExpo -contains $c.OwningProcess)) {
      $pidsExpo += $c.OwningProcess
    }
  }
}
foreach ($pid in $pidsExpo) {
  try {
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host ('   stopping PID ' + $pid + '  (' + $proc.ProcessName + ')')
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}
if (-not $pidsExpo) { Write-Host '   nothing to kill' }

Write-Host ''
Write-Host '== killing stray node processes for server (port 4000) if duplicates =='
$apiPids = @()
$apiConns = Get-NetTCPConnection -State Listen -LocalPort 4000 -ErrorAction SilentlyContinue
foreach ($c in $apiConns) {
  if ($c.OwningProcess -and -not ($apiPids -contains $c.OwningProcess)) {
    $apiPids += $c.OwningProcess
  }
}
Write-Host ('   port 4000 owners: ' + ($apiPids -join ', '))

Write-Host ''
Write-Host '== verifying API still healthy =='
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4000/api/health' -UseBasicParsing -TimeoutSec 4
  Write-Host ('   ' + $r.StatusCode + ' ' + $r.Content)
} catch {
  Write-Host '   API is DOWN — restart it with: node server/index.js'
}

Write-Host ''
Write-Host '== current LAN IP =='
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.InterfaceAlias -notlike 'vEthernet*' } |
  Select-Object IPAddress, InterfaceAlias |
  Format-Table -AutoSize

Write-Host '== done =='
Write-Host 'Now run: npx expo start --lan --clear'
Write-Host '   then open the URL it prints (it will pick a free port and bind to IPv4)'
