# Save and review, then: powershell -NoProfile -File .\bootstrap.ps1 -Version 0.7.1
param([ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$')][string]$Version = '0.7.1')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'This bootstrap supports Windows only.' }
$native = $env:PROCESSOR_ARCHITEW6432
if (!$native) { $native = $env:PROCESSOR_ARCHITECTURE }
if ($native -ne 'AMD64') { throw 'Only native Windows x64 is supported.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Download-Bounded([string]$Url, [string]$Destination, [long]$Limit) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $response = $null; $inputStream = $null; $outputStream = $null
    try {
        for ($redirects = 0; ; $redirects++) {
            $uri = [Uri]$Url
            if ($uri.Scheme -ne 'https' -or $uri.UserInfo) { throw 'Unsafe download URL.' }
            $request = [Net.HttpWebRequest]::Create($uri)
            $request.AllowAutoRedirect = $false
            $request.Timeout = 20000; $request.ReadWriteTimeout = 20000
            $request.UseDefaultCredentials = $false
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
                if ($redirects -ge 5 -or !$response.Headers['Location']) { throw 'Too many or invalid redirects.' }
                $Url = ([Uri]::new($uri,$response.Headers['Location'])).AbsoluteUri
                $response.Dispose(); $response = $null
                continue
            }
            if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt $Limit) { throw 'Download status or size rejected.' }
            break
        }
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $buffer = New-Object byte[] 65536
        [long]$total = 0
        while (($count = $inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
            $total += $count
            if ($total -gt $Limit -or $clock.Elapsed.TotalSeconds -gt 600) { throw 'Download exceeds size or time limit.' }
            $outputStream.Write($buffer,0,$count)
        }
        if ($total -eq 0 -or $clock.Elapsed.TotalSeconds -gt 600) { throw 'Empty or timed out download.' }
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Validate-Portable([string]$File, [string]$ExpectedVersion) {
    $stream = [IO.File]::OpenRead($File)
    try {
        $header = New-Object byte[] 64
        if ($stream.Length -lt 256 -or $stream.Read($header,0,64) -ne 64 -or $header[0] -ne 0x4d -or $header[1] -ne 0x5a) { throw 'Invalid portable executable.' }
        $offset = [BitConverter]::ToUInt32($header,60)
        if ($offset -lt 64 -or $offset + 24 -gt $stream.Length) { throw 'Invalid PE offset.' }
        [void]$stream.Seek($offset,[IO.SeekOrigin]::Begin)
        $pe = New-Object byte[] 6
        if ($stream.Read($pe,0,6) -ne 6 -or $pe[0] -ne 0x50 -or $pe[1] -ne 0x45 -or $pe[2] -ne 0 -or $pe[3] -ne 0 -or [BitConverter]::ToUInt16($pe,4) -notin @(0x014c,0x8664)) { throw 'Invalid Windows PE architecture.' }
    } finally { $stream.Dispose() }
    # electron-builder may use an x86 launcher for the release-verified x64 payload.
    $identity = [Diagnostics.FileVersionInfo]::GetVersionInfo($File)
    if ($identity.ProductName -ne 'ShelfDock' -or $identity.ProductVersion -ne $ExpectedVersion) { throw 'Application identity or version mismatch.' }
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('shelfdock-bootstrap-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    # Private directory: equivalent to POSIX mode 700, inherited by downloaded files.
    $acl = Get-Acl -LiteralPath $temporary
    $acl.SetAccessRuleProtection($true,$false)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($user)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($user,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $temporary -AclObject $acl
    $base = 'https://github.com/LexiLominite/ShelfDock/releases/download/v' + $Version + '/'
    $payload = 'ShelfDock-' + $Version + '-win-x64.exe'
    foreach ($entry in @(@('SHA256SUMS.txt',131072),@('install.ps1',262144),@($payload,1572864000))) {
        Download-Bounded ($base + $entry[0]) (Join-Path $temporary $entry[0]) $entry[1]
    }
    $checksums = @{}
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $temporary 'SHA256SUMS.txt'))) {
        if ($line -cnotmatch '^([a-fA-F0-9]{64}) [ *]([^\s/\\]+)$') { throw 'Invalid checksum manifest line.' }
        $name = $Matches[2]; $hash = $Matches[1].ToLowerInvariant()
        if ($checksums.ContainsKey($name)) { throw 'Duplicate checksum manifest entry.' }
        $checksums[$name] = $hash
    }
    foreach ($name in @('install.ps1',$payload)) {
        # Hashtable keys are case-insensitive, so additionally require exact filename spelling.
        if (@($checksums.Keys | Where-Object { $_ -ceq $name }).Count -ne 1) { throw 'Missing exact checksum manifest entry.' }
        if ((Get-FileHash -LiteralPath (Join-Path $temporary $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $checksums[$name]) { throw ('SHA-256 mismatch: ' + $name) }
    }
    Validate-Portable (Join-Path $temporary $payload) $Version
    & (Join-Path $temporary 'install.ps1') -AppName ShelfDock -Edition public -Payload $payload -Sha256 $checksums[$payload] -Version $Version -Architecture x64
    if (!$?) { throw 'Verified payload installer failed.' }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
