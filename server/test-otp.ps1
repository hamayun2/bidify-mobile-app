$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4000/api'
$email = 'admin@bidify.com'

Write-Host '== register admin =='
try {
  $reg = Invoke-RestMethod -Method Post -Uri "$base/auth/register" -ContentType 'application/json' -Body (@{ email = $email; password = 'admin1234'; fullName = 'Admin' } | ConvertTo-Json)
  Write-Host '   created'
} catch {
  Write-Host '   exists'
}

Write-Host '== request OTP =='
$req = Invoke-RestMethod -Method Post -Uri "$base/auth/password/request-otp" -ContentType 'application/json' -Body (@{ email = $email } | ConvertTo-Json)
$req | ConvertTo-Json
$otp = $req.devOtp
if (-not $otp) { throw 'No devOtp returned (set SMTP creds or check store).' }

Write-Host "== verify OTP $otp =="
$ver = Invoke-RestMethod -Method Post -Uri "$base/auth/password/verify-otp" -ContentType 'application/json' -Body (@{ email = $email; code = $otp } | ConvertTo-Json)
$ver | ConvertTo-Json
$resetToken = $ver.resetToken
if (-not $resetToken) { throw 'No resetToken' }

Write-Host '== reset password =='
$rst = Invoke-RestMethod -Method Post -Uri "$base/auth/password/reset" -ContentType 'application/json' -Body (@{ email = $email; resetToken = $resetToken; newPassword = 'newSecret1' } | ConvertTo-Json)
$rst | ConvertTo-Json

Write-Host '== sign in with new password =='
$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' -Body (@{ email = $email; password = 'newSecret1' } | ConvertTo-Json)
$login | ConvertTo-Json

Write-Host '== OTP test complete =='
