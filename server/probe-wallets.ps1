$ErrorActionPreference = 'Stop'
$path = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'data\store.json'
$store = Get-Content $path -Raw | ConvertFrom-Json

Write-Host "Wallets after migration:"
Write-Host ("-" * 60)
$store.wallets.PSObject.Properties | ForEach-Object {
    $uid = $_.Name
    $w = $_.Value
    $bonus = @($w.transactions | Where-Object { $_.kind -eq 'signup_bonus' }).Count
    Write-Host ("  user {0,-3}  balance = Rs {1,-9}  tx = {2,-2}  legacy_bonus_rows = {3}" -f $uid, $w.balance, $w.transactions.Count, $bonus)
}
Write-Host ("-" * 60)
