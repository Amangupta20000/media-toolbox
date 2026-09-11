$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$targetDirectory = Join-Path $projectDirectory "vendor\untrunc\win32-x64"
$targetPath = Join-Path $targetDirectory "untrunc.exe"
$downloadUrl = "https://github.com/anthwlock/untrunc/releases/download/latest/untrunc_x64.zip"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("media-toolbox-untrunc-" + [guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $temporaryDirectory "untrunc.zip"

if (Test-Path -LiteralPath $targetPath) {
  Write-Host "Bundled Untrunc already exists at $targetPath"
  exit 0
}

New-Item -ItemType Directory -Force -Path $targetDirectory, $temporaryDirectory | Out-Null
try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
  Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryDirectory -Force
  $binary = Get-ChildItem -LiteralPath $temporaryDirectory -Filter "untrunc.exe" -File -Recurse | Select-Object -First 1
  if (-not $binary) { throw "The official Untrunc archive did not contain untrunc.exe." }
  Copy-Item -Path (Join-Path $binary.DirectoryName "*") -Destination $targetDirectory -Force
  if (Test-Path -LiteralPath (Join-Path $binary.DirectoryName "COPYING")) {
    Copy-Item -LiteralPath (Join-Path $binary.DirectoryName "COPYING") -Destination (Join-Path $projectDirectory "vendor\untrunc\UNTRUNC-COPYING") -Force
  }
  Write-Host "Staged bundled Untrunc at $targetPath"
}
finally {
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
