$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4000/api'

Write-Host '== 1) Login as seeded admin =='
$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' `
  -Body (@{ email = 'admin@bidify.com'; password = 'admin1234' } | ConvertTo-Json)
Write-Host ('   token len: ' + $login.token.Length + '  role: ' + $login.user.role)

Write-Host ''
Write-Host '== 2) Register a NEW user =='
$email = "user_$([DateTime]::Now.ToString('HHmmss'))@bidify.com"
$reg = Invoke-RestMethod -Method Post -Uri "$base/auth/register" -ContentType 'application/json' `
  -Body (@{ email = $email; password = 'pass1234'; fullName = 'Persist Test' } | ConvertTo-Json)
Write-Host ('   registered: ' + $email)

Write-Host ''
Write-Host '== 3) Wait for debounced flush + verify store.json was written =='
Start-Sleep -Milliseconds 500
$store = Get-Content 'D:\BidifyMobile\server\data\store.json' -Raw | ConvertFrom-Json
Write-Host ('   users on disk: ' + $store.users.Count + '  (admin + new = 2 expected)')
$found = $store.users | Where-Object { $_.email -eq $email }
if (-not $found) { throw 'New user not flushed to disk!' }
Write-Host '   FLUSHED OK'

Write-Host ''
Write-Host '== 4) Run forgot-password OTP flow for the new user =='
$req = Invoke-RestMethod -Method Post -Uri "$base/auth/password/request-otp" -ContentType 'application/json' `
  -Body (@{ email = $email } | ConvertTo-Json)
$otp = $req.devOtp
if (-not $otp) { throw 'No devOtp returned!' }
Write-Host ('   OTP: ' + $otp)

$ver = Invoke-RestMethod -Method Post -Uri "$base/auth/password/verify-otp" -ContentType 'application/json' `
  -Body (@{ email = $email; code = $otp } | ConvertTo-Json)
Write-Host ('   resetToken: ' + $ver.resetToken.Substring(0,16) + '…')

$rst = Invoke-RestMethod -Method Post -Uri "$base/auth/password/reset" -ContentType 'application/json' `
  -Body (@{ email = $email; resetToken = $ver.resetToken; newPassword = 'newpass1' } | ConvertTo-Json)
Write-Host ('   reset: ' + $rst.message)

$relog = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' `
  -Body (@{ email = $email; password = 'newpass1' } | ConvertTo-Json)
Write-Host ('   re-login OK, user id ' + $relog.user.id)

Write-Host ''
Write-Host '== ALL TESTS PASSED =='
