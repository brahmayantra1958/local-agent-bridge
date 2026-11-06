param(
  [string]$Apps,
  [switch]$NonInteractive,
  [switch]$ReplaceSkills,
  [switch]$DryRun,
  [string]$UserHome,
  [string]$StateRoot,
  [string]$NodePath,
  [switch]$Help
)
# agent-bridge Setup bootstrap. Keep this file ASCII: Windows PowerShell 5.1
# reads BOM-less scripts in the ANSI code page.
# Node.js is fetched into <install>\runtime only: pinned version, SHA-256
# checked, no administrator rights, no PATH or system change.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'agent-bridge Setup requires x64 Windows.' }

if ($NodePath) {
  if (-not (Test-Path -LiteralPath $NodePath)) { throw ('Node executable not found: ' + $NodePath) }
  $node = $NodePath
} else {
  $dist = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-distribution.json') -Raw | ConvertFrom-Json
  $runtime = Join-Path $root 'runtime'
  $nodeDir = Join-Path $runtime ('node-v' + $dist.version + '-win-x64')
  $node = Join-Path $nodeDir 'node.exe'
  $archive = Join-Path $runtime $dist.file
  New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
  if (-not (Test-Path -LiteralPath $archive)) {
    Write-Host ('Downloading Node.js ' + $dist.version + ' (about 30 MB, one time)...')
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    $download = $archive + '.download'
    Invoke-WebRequest -UseBasicParsing -Uri ($dist.baseUrl + 'v' + $dist.version + '/' + $dist.file) -OutFile $download
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $dist.sha256) {
      Remove-Item -LiteralPath $download -Force
      throw 'Node.js archive checksum mismatch; nothing was installed.'
    }
    Move-Item -LiteralPath $download -Destination $archive -Force
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $dist.sha256) { throw 'Node.js archive checksum mismatch; delete the runtime folder and run Setup again.' }
  if (-not (Test-Path -LiteralPath $node)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
      foreach ($name in @('node.exe', 'LICENSE')) {
        $entry = $zip.GetEntry('node-v' + $dist.version + '-win-x64/' + $name)
        if (-not $entry) { throw ('Node.js archive is missing ' + $name) }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $nodeDir $name), $true)
      }
    } finally { $zip.Dispose() }
  }
}

$arguments = @((Join-Path $PSScriptRoot 'setup.mjs'))
if ($Apps) { $arguments += @('--apps', $Apps) }
if ($NonInteractive) { $arguments += '--non-interactive' }
if ($ReplaceSkills) { $arguments += '--replace-skills' }
if ($DryRun) { $arguments += '--dry-run' }
if ($UserHome) { $arguments += @('--home', $UserHome) }
if ($StateRoot) { $arguments += @('--state-root', $StateRoot) }
if ($Help) { $arguments += '--help' }
& $node @arguments
exit $LASTEXITCODE
