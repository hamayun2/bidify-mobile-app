$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4000/api'

Write-Host '== ensure admin =='
try {
  Invoke-RestMethod -Method Post -Uri "$base/auth/register" -ContentType 'application/json' -Body (@{ email = 'imgtest@bidify.com'; password = 'imgtest1234'; fullName = 'Img Test' } | ConvertTo-Json) | Out-Null
  Write-Host '   created'
} catch { Write-Host '   exists' }

$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' -Body (@{ email = 'imgtest@bidify.com'; password = 'imgtest1234' } | ConvertTo-Json)
$token = $login.token

Write-Host '== generate a 1x1 PNG and upload as listing =='
# 1x1 transparent PNG (base64)
$pngBytes = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
$tmp = Join-Path $env:TEMP 'bidify-test.png'
[IO.File]::WriteAllBytes($tmp, $pngBytes)

# multipart upload via curl.exe (PowerShell aliases `curl` to Invoke-WebRequest, so use full name)
$resp = & curl.exe -s -H "Authorization: Bearer $token" -F "title=Image Upload Smoke Test" -F "price=12000" -F "type=buynow" -F "images=@$tmp" "$base/listings"
Write-Host '   raw response:'
Write-Host $resp

$obj = $resp | ConvertFrom-Json
$listing = $obj.listing
if (-not $listing) { throw 'No listing in response' }
Write-Host ('   listing id  : ' + $listing.id)
Write-Host ('   listing.image: ' + $listing.image)
Write-Host ('   images count : ' + $listing.images.Count)

if (-not $listing.image) { throw 'Listing has no image URL — upload failed.' }

Write-Host '== fetch image URL to verify it is reachable =='
$resp2 = Invoke-WebRequest -Uri $listing.image -UseBasicParsing
Write-Host ('   HTTP ' + $resp2.StatusCode + '  ' + $resp2.Headers['Content-Type'] + '  ' + $resp2.RawContentLength + ' bytes')
if ($resp2.StatusCode -ne 200) { throw 'Image URL not 200' }

Write-Host '== verify URL is rebuilt with current API host (no stale absolute URL) =='
if ($listing.image -notmatch 'http://') { throw 'Expected absolute http URL' }
if ($listing.image -notmatch '/uploads/') { throw 'Expected /uploads/ path' }

Write-Host '== image upload + serve test complete =='
