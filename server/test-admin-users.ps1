$ErrorActionPreference = 'Stop'
$login = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4000/api/auth/login' `
    -ContentType 'application/json' `
    -Body (@{ email='admin@bidify.com'; password='admin1234' } | ConvertTo-Json)

$headers = @{ Authorization = 'Bearer ' + $login.token }
$r = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:4000/api/admin/users' -Headers $headers
Write-Host ("user count = {0}" -f $r.users.Count)
$r.users | Select-Object id, email, fullName, role, phone, cnic, cnicFrontUrl, cnicBackUrl, cnicVerifiedAt | Format-List
