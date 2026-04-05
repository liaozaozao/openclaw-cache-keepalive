# OpenClaw Cache Keepalive Proxy — Windows PowerShell launcher
param(
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

$LauncherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $LauncherDir "../..")).Path
if (-not $ConfigPath) {
  $ConfigPath = Join-Path $RepoRoot "config.conf"
}

if (-not (Test-Path $ConfigPath)) {
  Copy-Item (Join-Path $RepoRoot "config.example.conf") $ConfigPath
  Write-Host "Created config file at: $ConfigPath"
  Write-Host "Edit UPSTREAM_URL before long-running use."
}

$env:CONF_FILE = (Resolve-Path $ConfigPath).Path
node (Join-Path $RepoRoot "proxy.js")
