param([string]$InstallDir, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
if (!$InstallDir) { $InstallDir = Read-Host 'agentschat installation directory (also accepts the existing Agent Room directory)' }
$root = (Resolve-Path -LiteralPath $InstallDir).Path.TrimEnd('\')
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.format -ne 1 -or !$manifest.files.Count) { throw 'Invalid or empty update manifest' }
function Get-Hash([string]$file) {
  $algorithm = [Security.Cryptography.SHA256]::Create(); $inputFile = [IO.File]::OpenRead($file)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($inputFile)).Replace('-','').ToLowerInvariant() }
  finally { $inputFile.Dispose(); $algorithm.Dispose() }
}
function Target([string]$relative) {
  if ($relative -notmatch '^(Agent Room\.exe|Uninstall (Agent Room|agentschat)\.exe|version|LICENSE[^/\\]*|[^/\\]+\.(dll|pak|bin|dat|json)|resources/(app\.asar|default_app\.asar|elevate\.exe|app-update\.yml)|locales/[^/\\]+\.pak)$' -or $relative.Contains('..')) { throw "Invalid application path: $relative" }
  $result = [IO.Path]::GetFullPath((Join-Path $root $relative))
  if (!$result.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped installation' }
  $cursor = $result
  while ($cursor.Length -ge $root.Length) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked path is not supported: $cursor" }
    $cursor = Split-Path -Parent $cursor
    if (!$cursor) { break }
  }
  return $result
}
$payloadPath = Join-Path $PSScriptRoot 'payload.bin'
if ((Get-Hash $payloadPath) -ne $manifest.payloadHash) { throw 'Update payload checksum mismatch' }
$seen = @{}
foreach ($file in $manifest.files) {
  $target = Target $file.path
  if ($seen.ContainsKey($target)) { throw 'Duplicate target' }; $seen[$target] = $true
  if ($file.oldHash) {
    if (!(Test-Path -LiteralPath $target) -or (Get-Hash $target) -ne $file.oldHash) { throw "Base version mismatch ($($manifest.fromVersion)): $($file.path). No files changed." }
  } elseif (Test-Path -LiteralPath $target) { throw "Unexpected existing file: $target" }
}
# Stage and validate every reconstructed file before stopping or changing the app.
$stage = Join-Path ([IO.Path]::GetTempPath()) ('AgentRoom-update-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$payload = [IO.File]::OpenRead($payloadPath)
try {
  foreach ($file in $manifest.files) {
    $target = Target $file.path; $staged = Join-Path $stage $file.path
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $staged) | Out-Null
    if ($file.oldHash) { [IO.File]::Copy($target, $staged) }
    $stream = [IO.File]::Open($staged, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write)
    try {
      $stream.SetLength([long]$file.length)
      foreach ($block in $file.blocks) {
        if ($block.offset -lt 0 -or $block.length -le 0 -or $block.length -gt 65536 -or ($block.offset + $block.length) -gt $file.length -or $block.payloadOffset -lt 0 -or ($block.payloadOffset + $block.length) -gt $payload.Length) { throw 'Invalid patch block' }
        $buffer = New-Object byte[] $block.length
        $payload.Position = [long]$block.payloadOffset
        if ($payload.Read($buffer,0,$buffer.Length) -ne $buffer.Length) { throw 'Truncated payload' }
        $stream.Position = [long]$block.offset; $stream.Write($buffer,0,$buffer.Length)
      }
    } finally { $stream.Dispose() }
    if ((Get-Hash $staged) -ne $file.newHash) { throw "Reconstructed checksum mismatch: $($file.path)" }
  }
} finally { $payload.Dispose() }
$exe = Join-Path $root 'Agent Room.exe'
$running = @(Get-Process -Name 'Agent Room' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
foreach ($process in $running) { if ($process.MainWindowHandle -ne 0) { $null = $process.CloseMainWindow() } }
foreach ($process in $running) { if (!$process.WaitForExit(30000)) { throw 'Close agentschat / Agent Room before applying the update. No files changed.' } }
# Recheck after shutdown, then back up all originals. Never uninstall or remove data directories.
foreach ($file in $manifest.files) {
  $target = Target $file.path
  if ($file.oldHash -and (Get-Hash $target) -ne $file.oldHash) { throw 'Application changed during update; retry with the correct base.' }
  if (!$file.oldHash -and (Test-Path -LiteralPath $target)) { throw 'Target appeared during update' }
}
$backup = Join-Path $root ('.update-backup-' + $manifest.fromVersion + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($file in $manifest.files) {
  if ($file.oldHash) {
    $saved = Join-Path $backup $file.path
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved) | Out-Null
    [IO.File]::Copy((Target $file.path), $saved)
  }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Destination (Join-Path $backup 'manifest.json')
$changed = @()
try {
  foreach ($file in $manifest.files) {
    $target = Target $file.path
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    $changed += $file
    [IO.File]::Copy((Join-Path $stage $file.path), $target, $true)
    if ((Get-Hash $target) -ne $file.newHash) { throw "Installed checksum mismatch: $target" }
  }
} catch {
  $failure = $_
  foreach ($file in $changed) {
    $target = Target $file.path
    if ($file.oldHash) { [IO.File]::Copy((Join-Path $backup $file.path), $target, $true) }
    elseif (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target }
  }
  throw $failure
}
Write-Host "Updated to $($manifest.toVersion). Backup: $backup"
if (!$NoLaunch) { Start-Process -FilePath $exe -WorkingDirectory $root -WindowStyle Hidden }
