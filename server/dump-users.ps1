$path = 'd:\BidifyMobile\server\data\store.json'
if (-not (Test-Path $path)) {
    Write-Host "MISSING: $path"
    exit 1
}
$json = Get-Content $path -Raw | ConvertFrom-Json
Write-Host ("File size: {0} bytes" -f (Get-Item $path).Length)
Write-Host ("Users: {0}" -f $json.users.Count)
Write-Host ("Listings: {0}" -f $json.listings.Count)
Write-Host ""
Write-Host "User accounts:"
foreach ($u in $json.users) {
    Write-Host ("  - id={0}  email={1}  role={2}  fullName={3}" -f $u.id, $u.email, $u.role, $u.fullName)
}
Write-Host ""
Write-Host "Listings:"
foreach ($l in $json.listings) {
    Write-Host ("  - id={0}  title={1}  status={2}" -f $l.id, $l.title, $l.moderationStatus)
}
