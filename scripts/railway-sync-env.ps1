# Sync key=value pairs from a .env file to Railway (service must be linked).
param(
  [string]$EnvFile = (Join-Path $PSScriptRoot ".." ".env"),
  [switch]$SkipDeploys
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $EnvFile)) {
  throw "Env file not found: $EnvFile"
}

railway whoami | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Not logged in. Run: railway login"
}

$skip = if ($SkipDeploys) { @("--skip-deploys") } else { @() }

Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  if ($line -match '^\s*export\s+') { $line = $line -replace '^\s*export\s+', '' }
  $eq = $line.IndexOf("=")
  if ($eq -lt 1) { return }

  $key = $line.Substring(0, $eq).Trim()
  $value = $line.Substring($eq + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  if (-not $key) { return }

  Write-Host "Setting $key..."
  railway variable set "$key=$value" @skip | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set $key"
  }
}

Write-Host "Done syncing variables from $EnvFile"
