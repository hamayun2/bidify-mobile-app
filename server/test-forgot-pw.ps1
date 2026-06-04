$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4000/api'

Write-Host '=== 1. Health check ==='
$h = Invoke-RestMethod -Uri "$base/health" -Method Get -TimeoutSec 4
Write-Host ("  status: {0}" -f ($h | ConvertTo-Json -Compress))

Write-Host ''
Write-Host '=== 2. Login admin (admin@bidify.com / admin1234) ==='
try {
    $login = Invoke-RestMethod -Uri "$base/auth/login" -Method Post `
        -ContentType 'application/json' `
        -Body (@{ email = 'admin@bidify.com'; password = 'admin1234' } | ConvertTo-Json) `
        -TimeoutSec 5
    Write-Host ("  OK: id={0}  role={1}" -f $login.user.id, $login.user.role)
} catch {
    Write-Host ("  FAIL: {0}" -f $_.Exception.Message)
    if ($_.ErrorDetails.Message) { Write-Host ("    body: {0}" -f $_.ErrorDetails.Message) }
}

Write-Host ''
Write-Host '=== 3. Request OTP for admin email ==='
try {
    $req = Invoke-RestMethod -Uri "$base/auth/password/request-otp" -Method Post `
        -ContentType 'application/json' `
        -Body (@{ email = 'admin@bidify.com' } | ConvertTo-Json) `
        -TimeoutSec 6
    Write-Host ("  OK: ok={0}  devOtp={1}  message={2}" -f $req.ok, $req.devOtp, $req.message)
    $script:OTP = $req.devOtp
} catch {
    Write-Host ("  FAIL: {0}" -f $_.Exception.Message)
    if ($_.ErrorDetails.Message) { Write-Host ("    body: {0}" -f $_.ErrorDetails.Message) }
}

Write-Host ''
Write-Host '=== 4. Verify OTP ==='
if (-not $script:OTP) {
    Write-Host '  SKIPPED (no devOtp returned).'
} else {
    try {
        $verify = Invoke-RestMethod -Uri "$base/auth/password/verify-otp" -Method Post `
            -ContentType 'application/json' `
            -Body (@{ email = 'admin@bidify.com'; code = $script:OTP } | ConvertTo-Json) `
            -TimeoutSec 5
        Write-Host ("  OK: resetToken={0}..." -f ($verify.resetToken.Substring(0, 12)))
        $script:TOK = $verify.resetToken
    } catch {
        Write-Host ("  FAIL: {0}" -f $_.Exception.Message)
        if ($_.ErrorDetails.Message) { Write-Host ("    body: {0}" -f $_.ErrorDetails.Message) }
    }
}

Write-Host ''
Write-Host '=== 5. Reset password back to admin1234 ==='
if (-not $script:TOK) {
    Write-Host '  SKIPPED.'
} else {
    try {
        $rst = Invoke-RestMethod -Uri "$base/auth/password/reset" -Method Post `
            -ContentType 'application/json' `
            -Body (@{ email = 'admin@bidify.com'; resetToken = $script:TOK; newPassword = 'admin1234' } | ConvertTo-Json) `
            -TimeoutSec 5
        Write-Host ("  OK: {0}" -f $rst.message)
    } catch {
        Write-Host ("  FAIL: {0}" -f $_.Exception.Message)
        if ($_.ErrorDetails.Message) { Write-Host ("    body: {0}" -f $_.ErrorDetails.Message) }
    }
}

Write-Host ''
Write-Host '=== 6. Login again with reset password ==='
try {
    $login2 = Invoke-RestMethod -Uri "$base/auth/login" -Method Post `
        -ContentType 'application/json' `
        -Body (@{ email = 'admin@bidify.com'; password = 'admin1234' } | ConvertTo-Json) `
        -TimeoutSec 5
    Write-Host ("  OK: id={0}" -f $login2.user.id)
} catch {
    Write-Host ("  FAIL: {0}" -f $_.Exception.Message)
}
