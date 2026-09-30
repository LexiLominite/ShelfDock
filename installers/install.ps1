param(
  [Parameter(Mandatory=$true)][ValidateSet('ShelfDock','LexBridge')][string]$AppName,
  [Parameter(Mandatory=$true)][ValidateSet('public','personal')][string]$Edition,
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Payload,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$')][string]$Version,
  [Parameter(Mandatory=$true)][ValidateSet('x64')][string]$Architecture
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (($AppName -eq 'ShelfDock' -and $Edition -ne 'public') -or ($AppName -eq 'LexBridge' -and $Edition -ne 'personal')) { throw 'App edition mismatch.' }
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'The destination is not Windows.' }
$nativeArchitecture = $env:PROCESSOR_ARCHITEW6432
if (!$nativeArchitecture) { $nativeArchitecture = $env:PROCESSOR_ARCHITECTURE }
if ($nativeArchitecture -notin @('AMD64','ARM64')) { throw 'Unsupported Windows processor.' }
$actualArchitecture = if ($nativeArchitecture -eq 'ARM64') { 'arm64' } else { 'x64' }
if ($actualArchitecture -ne $Architecture) { throw 'Destination architecture changed.' }
$payloadPath = Join-Path $PSScriptRoot $Payload
if (!(Test-Path -LiteralPath $payloadPath -PathType Leaf)) { throw 'Package file was not found.' }
if ((Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash -ne $Sha256) { throw 'Package checksum mismatch.' }
$stream = [IO.File]::OpenRead($payloadPath)
try {
  $header = New-Object byte[] 64
  if ($stream.Read($header,0,$header.Length) -lt 64 -or $header[0] -ne 0x4D -or $header[1] -ne 0x5A) { throw 'Package is not a Windows executable.' }
  $peOffset = [BitConverter]::ToUInt32($header,0x3C)
} finally { $stream.Dispose() }
$stream = [IO.File]::OpenRead($payloadPath)
try {
  [void]$stream.Seek($peOffset,[IO.SeekOrigin]::Begin)
  $pe = New-Object byte[] 6
  if ($stream.Read($pe,0,$pe.Length) -ne 6 -or $pe[0] -ne 0x50 -or $pe[1] -ne 0x45 -or $pe[2] -ne 0 -or $pe[3] -ne 0) { throw 'Invalid executable header.' }
  $machine = [BitConverter]::ToUInt16($pe,4)
  # The portable launcher can be x86 while its checksum-pinned payload is x64.
  if ($Architecture -ne 'x64' -or $machine -notin @(0x014c,0x8664)) { throw 'Package architecture mismatch.' }
} finally { $stream.Dispose() }

$identity = [Diagnostics.FileVersionInfo]::GetVersionInfo($payloadPath)
if ($identity.ProductName -ne $AppName -or $identity.ProductVersion -ne $Version) { throw 'Package application identity or version mismatch.' }

$base = Join-Path $env:LOCALAPPDATA 'Programs'
$destination = Join-Path $base $AppName
if (!(Test-Path -LiteralPath $base)) { [IO.Directory]::CreateDirectory($base) | Out-Null }
foreach ($candidate in @($base,$destination)) {
  if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a redirected install path.' }
}
if (Test-Path -LiteralPath $destination) { throw 'An app already exists at this destination; remove or rename it before installing.' }
$shortcutFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
if ([String]::IsNullOrWhiteSpace($shortcutFolder)) { throw 'The user Start Menu folder is unavailable.' }
if (!(Test-Path -LiteralPath $shortcutFolder)) { [IO.Directory]::CreateDirectory($shortcutFolder) | Out-Null }
if ((Get-Item -LiteralPath $shortcutFolder -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a redirected Start Menu folder.' }
$shortcut = Join-Path $shortcutFolder ($AppName + '.lnk')
if (Test-Path -LiteralPath $shortcut) { throw 'A Start Menu shortcut already exists; remove or rename it before installing.' }
$committed = $false
$shortcutInstalled = $false
$stage = Join-Path $base ('.' + $AppName + '.install-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage) | Out-Null
$stagedShortcut = $stage + '.lnk'
try {
  $stagedExe = Join-Path $stage ($AppName + '.exe')
  [IO.File]::Copy($payloadPath,$stagedExe,$false)
  $link = $null
  $shell = New-Object -ComObject WScript.Shell
  try {
    $link = $shell.CreateShortcut($stagedShortcut)
    $link.TargetPath = Join-Path $destination ($AppName + '.exe')
    $link.WorkingDirectory = $destination
    $link.Description = $AppName
    $link.Save()
  } finally {
    if ($null -ne $link) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
  [IO.Directory]::Move($stage,$destination)
  $committed = $true
  [IO.File]::Move($stagedShortcut,$shortcut)
  $shortcutInstalled = $true
} catch {
  if ($shortcutInstalled) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
  if ($committed) { Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $stagedShortcut) { Remove-Item -LiteralPath $stagedShortcut -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  throw
}
[Console]::WriteLine('DH_INSTALLED=yes')
