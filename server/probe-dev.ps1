Write-Host '--- LISTEN ON 8081 ---'
netstat -ano | findstr ':8081'
Write-Host ''
Write-Host '--- LISTEN ON 4000 ---'
netstat -ano | findstr ':4000'
Write-Host ''
Write-Host '--- HEALTH PROBES ---'
$probes = @(
    @{ url = 'http://127.0.0.1:8081';        label = 'expo  127.0.0.1:8081' },
    @{ url = 'http://192.168.1.13:8081';     label = 'expo  192.168.1.13:8081' },
    @{ url = 'http://127.0.0.1:4000/api/health';    label = 'api   127.0.0.1:4000' },
    @{ url = 'http://192.168.1.13:4000/api/health'; label = 'api   192.168.1.13:4000' }
)
foreach ($p in $probes) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $p.url -TimeoutSec 4
        Write-Host ("{0,-30} = {1}" -f $p.label, $r.StatusCode)
    } catch {
        Write-Host ("{0,-30} = FAIL: {1}" -f $p.label, $_.Exception.Message)
    }
}
