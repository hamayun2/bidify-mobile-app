$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4000/api'

$email = "topup_$(Get-Random)@test.com"
$reg = Invoke-RestMethod "$base/auth/register" -Method Post -ContentType 'application/json' -Body (@{ email = $email; password = 'pw12345'; fullName = 'Topup Tester' } | ConvertTo-Json)
$token = $reg.token
$headers = @{ Authorization = "Bearer $token" }
Write-Host ("Registered: {0}" -f $email)

$w = Invoke-RestMethod "$base/wallet" -Headers $headers
Write-Host ("Initial wallet balance: {0}" -f $w.balance)

Write-Host ''
Write-Host '=== Min validation (Rs. 500) ==='
try {
  Invoke-RestMethod "$base/payments/stripe/wallet-topup" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ amount = 500; currency = 'PKR' } | ConvertTo-Json) | Out-Null
  Write-Host '  UNEXPECTED: 500 PKR was accepted'
} catch {
  if ($_.ErrorDetails) { Write-Host ("  rejected (expected): {0}" -f $_.ErrorDetails.Message) }
  else { Write-Host ("  rejected (expected): {0}" -f $_.Exception.Message) }
}

foreach ($p in @('easypaisa', 'jazzcash', 'stripe')) {
  Write-Host ''
  Write-Host ("=== Top up via {0} (Rs. 5000) ===" -f $p)
  try {
    $resp = Invoke-RestMethod "$base/payments/$p/wallet-topup" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ amount = 5000; currency = 'PKR' } | ConvertTo-Json)
    Write-Host ("  status         : {0}" -f $resp.status)
    Write-Host ("  url            : {0}" -f $resp.url)
    Write-Host ("  walletBalance  : {0}" -f $resp.walletBalance)
  } catch {
    Write-Host ("  FAILED: {0}" -f $_.Exception.Message)
  }
}

Write-Host ''
$w2 = Invoke-RestMethod "$base/wallet" -Headers $headers
Write-Host ("Final wallet balance: {0}" -f $w2.balance)
Write-Host ("Transactions: {0}" -f $w2.transactions.Count)
