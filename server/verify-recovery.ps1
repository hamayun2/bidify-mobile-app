$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:4000/api'

$accounts = @(
    @{ email = 'admin@bidify.com';            pwd = 'admin1234'    },
    @{ email = 'hamayunawan2003@gmail.com';   pwd = 'Recover1234'  },
    @{ email = 'shani@gmail.com';             pwd = 'Recover1234'  },
    @{ email = 'baba@gmail.com';              pwd = 'Recover1234'  }
)

foreach ($a in $accounts) {
    try {
        $r = Invoke-RestMethod -Uri "$base/auth/login" -Method Post `
            -ContentType 'application/json' `
            -Body (@{ email = $a.email; password = $a.pwd } | ConvertTo-Json) `
            -TimeoutSec 5
        $cnic = if ($r.user.cnic) { $r.user.cnic } else { '-' }
        Write-Host ("PASS  {0,-32}  id={1}  role={2}  cnic={3}" -f $a.email, $r.user.id, $r.user.role, $cnic)
    } catch {
        Write-Host ("FAIL  {0}  {1}" -f $a.email, $_.Exception.Message)
    }
}
