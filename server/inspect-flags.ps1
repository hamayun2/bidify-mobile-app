$j = Get-Content '.\server\data\store.json' -Raw | ConvertFrom-Json
Write-Host ('flags: ' + ($j.flags | ConvertTo-Json -Compress))
Write-Host ('admin wallet: ' + ($j.wallets.'1' | ConvertTo-Json -Compress))
