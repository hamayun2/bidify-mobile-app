$ErrorActionPreference = 'Stop'

$base = 'http://127.0.0.1:4000/api'

function Try-Login($email, $password) {
  try {
    return Invoke-RestMethod "$base/auth/login" -Method Post -ContentType 'application/json' -Body (@{ email = $email; password = $password } | ConvertTo-Json)
  } catch {
    return $null
  }
}

$buyerEmail = "buyer_$(Get-Random)@test.com"
$buyer = Invoke-RestMethod "$base/auth/register" -Method Post -ContentType 'application/json' -Body (@{ email = $buyerEmail; password = 'pw12345'; fullName = 'Buyer Test' } | ConvertTo-Json)
$buyerToken = $buyer.token
Write-Host ("Registered buyer  : {0}" -f $buyerEmail)
Write-Host ("Buyer token       : {0}..." -f $buyerToken.Substring(0,20))

$listings = (Invoke-RestMethod "$base/listings" -Method Get).listings
$buyNow = $listings | Where-Object { $_.type -eq 'buy_now' -or $_.buyNowPrice } | Select-Object -First 1
if (-not $buyNow) {
  Write-Host 'No buy_now listing found in seed data; using first listing'
  $buyNow = $listings | Select-Object -First 1
}
$displayPrice = if ($buyNow.buyNowPrice) { $buyNow.buyNowPrice } else { $buyNow.price }
Write-Host ("Picked listing    : id={0} title='{1}' price={2}" -f $buyNow.id, $buyNow.title, $displayPrice)

if ($buyNow.buyNowPrice) { $amount = [int]$buyNow.buyNowPrice } else { $amount = [int]$buyNow.price }
if (-not $amount) { $amount = 1000 }

$wallet = Invoke-RestMethod "$base/wallet" -Headers @{ Authorization = "Bearer $buyerToken" }
Write-Host ("Buyer wallet bal  : {0}" -f $wallet.balance)

if ($wallet.balance -lt $amount) {
  Write-Host 'Topping up wallet'
  Invoke-RestMethod "$base/wallet/topup" -Method Post -Headers @{ Authorization = "Bearer $buyerToken" } -ContentType 'application/json' -Body (@{ amount = ($amount - $wallet.balance + 5000) } | ConvertTo-Json) | Out-Null
}

foreach ($provider in @('stripe', 'easypaisa', 'jazzcash')) {
  Write-Host ''
  Write-Host ("=== Trying {0} ===" -f $provider)
  $body = @{ listingId = $buyNow.id; amount = $amount; currency = 'PKR' } | ConvertTo-Json
  $endpoint = if ($provider -eq 'stripe') { "$base/payments/$provider/checkout-session" } else { "$base/payments/$provider/session" }
  try {
    $resp = Invoke-RestMethod $endpoint -Method Post -Headers @{ Authorization = "Bearer $buyerToken" } -ContentType 'application/json' -Body $body
    Write-Host ("  status         : {0}" -f $resp.status)
    Write-Host ("  url            : {0}" -f $resp.url)
    Write-Host ("  walletBalance  : {0}" -f $resp.walletBalance)
    Write-Host ("  amount         : {0}, due: {1}, heldCredit: {2}" -f $resp.amount, $resp.due, $resp.heldCredit)
  } catch {
    Write-Host ("  FAILED: {0}" -f $_.Exception.Message)
    if ($_.ErrorDetails) { Write-Host ("  body: {0}" -f $_.ErrorDetails.Message) }
  }
}

Write-Host ''
Write-Host '=== Receipt page check ==='
try {
  $resp = Invoke-WebRequest "$base/payments/sessions" -Headers @{ Authorization = "Bearer $buyerToken" } -UseBasicParsing -ErrorAction SilentlyContinue
} catch {}
