$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4000/api'

# Register a new user via the simple /auth/register endpoint (no CNIC needed for this test)
$email = "zerotest_$(Get-Random -Maximum 999999)@example.com"
Write-Host ("New user: {0}" -f $email)

$reg = Invoke-RestMethod -Uri "$base/auth/register" -Method Post `
    -ContentType 'application/json' `
    -Body (@{ email = $email; password = 'Verylong1'; fullName = 'Zero Bonus Test' } | ConvertTo-Json)

$headers = @{ Authorization = 'Bearer ' + $reg.token }

# Trigger wallet creation by GET'ing the wallet
$wallet = Invoke-RestMethod -Uri "$base/wallet" -Method Get -Headers $headers
Write-Host ""
Write-Host ("Balance:      Rs {0}" -f $wallet.balance)
Write-Host ("Transactions: {0}" -f $wallet.transactions.Count)
if ($wallet.transactions.Count -eq 0) {
    Write-Host "PASS: new user starts at Rs 0 with no transactions"
} else {
    Write-Host "FAIL: unexpected transactions present:"
    $wallet.transactions | Format-List kind, amount, note
}
