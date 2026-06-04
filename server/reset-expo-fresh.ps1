$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== Killing all Expo / Metro processes ==="
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'expo[\\\/]bin[\\\/]cli|expo[ ]start|metro' } |
    ForEach-Object {
        Write-Host ("  - stopping PID {0}" -f $_.ProcessId)
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'jest-worker' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Seconds 1

Write-Host ""
Write-Host "=== Verifying nothing on 8081-8084 anymore ==="
8081, 8082, 8083, 8084 | ForEach-Object {
    $p = $_
    $hits = (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
    if ($hits) {
        Write-Host ("  ! port {0} still has listener(s); force-stopping owner" -f $p)
        $hits | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    } else {
        Write-Host ("  ok: port {0} free" -f $p)
    }
}

Start-Sleep -Milliseconds 600

Write-Host ""
Write-Host "=== Resolving LAN IPv4 ==="
$ip = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp -ErrorAction SilentlyContinue |
        Select-Object -First 1).IPAddress
if (-not $ip) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Manual -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } |
            Select-Object -First 1).IPAddress
}
Write-Host ("  LAN IP: {0}" -f $ip)

Write-Host ""
Write-Host "=== Starting ONE clean Expo server on :8081 ==="
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $repo
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c','start','""','/min','cmd','/c','npx','expo','start','--lan','--clear','--port','8081' `
    -WorkingDirectory $repo
Pop-Location

Write-Host ""
Write-Host "Open these in your phone (Expo Go) or browser:"
Write-Host "  Web:   http://localhost:8081"
if ($ip) { Write-Host ("  LAN:   http://{0}:8081" -f $ip) }
Write-Host ""
Write-Host "Give Metro ~15s to boot, then press 'r' in its window if needed."
