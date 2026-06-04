$port = 8081
try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/status" -f $port) -TimeoutSec 4
    Write-Host ("OK: Expo /status on {0} returned HTTP {1}" -f $port, $r.StatusCode)
} catch {
    Write-Host ("FAIL: {0}" -f $_.Exception.Message)
}

$listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($listeners) {
    Write-Host ("Listening on :{0}:" -f $port)
    $listeners | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
} else {
    Write-Host ("Nothing listening on :{0}" -f $port)
}
