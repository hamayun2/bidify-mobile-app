# Deploy Express backend (server/) to Railway from the terminal.
# Prerequisites: railway login (or RAILWAY_TOKEN / RAILWAY_API_TOKEN set)
param(
  [string]$ProjectName = "Bidify",
  [string]$ServiceName = "bidify-api",
  [string]$EnvFile = (Join-Path $PSScriptRoot ".." ".env"),
  [switch]$CreateNewProject
)

$ErrorActionPreference = "Stop"
$serverDir = Join-Path $PSScriptRoot ".." "server" | Resolve-Path

Write-Host "==> Railway backend deploy" -ForegroundColor Cyan
Write-Host "    Service dir: $serverDir"

railway whoami
if ($LASTEXITCODE -ne 0) {
  throw @"
Not logged in to Railway.
Run in an interactive terminal:
  railway login
Then click Verify in the browser when prompted.

Or create a token at https://railway.com/account/tokens and run:
  `$env:RAILWAY_TOKEN = 'your-token'
"@
}

Push-Location $serverDir
try {
  $linked = Test-Path ".railway" -PathType Container
  if (-not $linked) {
    if ($CreateNewProject) {
      Write-Host "==> Creating project '$ProjectName'..." -ForegroundColor Cyan
      railway init --name $ProjectName --json | Out-Null
    } else {
      Write-Host "==> Linking to existing Railway project (select Bidify in the prompt)..." -ForegroundColor Cyan
      railway link
    }
  }

  Write-Host "==> Ensuring service '$ServiceName' exists..." -ForegroundColor Cyan
  railway add --service $ServiceName --json 2>$null | Out-Null

  Write-Host "==> Selecting service '$ServiceName'..." -ForegroundColor Cyan
  railway service $ServiceName

  Write-Host "==> Uploading environment variables from $EnvFile..." -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot "railway-sync-env.ps1") -EnvFile $EnvFile -SkipDeploys

  Write-Host "==> Deploying backend (railway up)..." -ForegroundColor Cyan
  railway up --detach

  Write-Host "==> Waiting for deployment..." -ForegroundColor Cyan
  Start-Sleep -Seconds 20

  Write-Host "==> Resolving public URL..." -ForegroundColor Cyan
  $domainJson = railway domain --json 2>$null
  $publicUrl = $null
  if ($domainJson) {
    try {
      $parsed = $domainJson | ConvertFrom-Json
      if ($parsed -is [array] -and $parsed.Count -gt 0) {
        $publicUrl = $parsed[0].domain
      } elseif ($parsed.domain) {
        $publicUrl = $parsed.domain
      }
    } catch { }
  }
  if (-not $publicUrl) {
    $statusJson = railway status --json 2>$null | ConvertFrom-Json
    if ($statusJson.service?.url) { $publicUrl = $statusJson.service.url }
  }
  if (-not $publicUrl) {
    $rawDomain = railway domain 2>$null
    if ($rawDomain -match 'https?://\S+') { $publicUrl = $Matches[0] }
    elseif ($rawDomain -match '\S+\.railway\.app') { $publicUrl = "https://$($Matches[0])" }
  }

  if ($publicUrl) {
    $publicUrl = $publicUrl -replace '/$', ''
    if ($publicUrl -notmatch '^https?://') { $publicUrl = "https://$publicUrl" }
    $apiBase = "$publicUrl/api"
    Write-Host ""
    Write-Host "Deployment complete." -ForegroundColor Green
    Write-Host "Live backend URL: $apiBase" -ForegroundColor Green
    Write-Host ""
    Write-Host "Update your local .env:" -ForegroundColor Yellow
    Write-Host "  EXPO_PUBLIC_API_URL=$apiBase"
    Write-Host "  API_PUBLIC_URL=$publicUrl"

    try {
      $health = Invoke-RestMethod -Uri "$apiBase/health" -TimeoutSec 30
      Write-Host "Health check: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
    } catch {
      Write-Host "Health check pending (service may still be starting): $($_.Exception.Message)" -ForegroundColor Yellow
    }
  } else {
    Write-Host "Deployed, but could not resolve public URL automatically." -ForegroundColor Yellow
    Write-Host "Run: railway domain" -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}
