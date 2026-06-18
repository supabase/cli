param(
  [Parameter(Mandatory = $true)]
  [string] $Version,

  [string] $PackageId = 'Supabase.CLI',
  [string] $Repo = 'supabase/cli',
  [string] $WingetCreatePath = '',
  [string] $OutDir = '',
  [switch] $Submit,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'WingetCreate must run on Windows.'
}

if ($Submit -and [string]::IsNullOrWhiteSpace($env:WINGET_CREATE_GITHUB_TOKEN)) {
  throw 'WINGET_CREATE_GITHUB_TOKEN is required when submitting Winget manifests.'
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $PWD 'dist\winget'
}

function Resolve-WingetCreate {
  if (-not [string]::IsNullOrWhiteSpace($WingetCreatePath)) {
    return $WingetCreatePath
  }

  $downloadPath = Join-Path ([System.IO.Path]::GetTempPath()) 'wingetcreate.exe'
  Invoke-WebRequest 'https://aka.ms/wingetcreate/latest' -OutFile $downloadPath
  return $downloadPath
}

$wingetCreate = Resolve-WingetCreate
$releaseUrl = "https://github.com/$Repo/releases/tag/v$Version"
$amd64Url = "https://github.com/$Repo/releases/download/v$Version/supabase_${Version}_windows_amd64.zip|x64"
$arm64Url = "https://github.com/$Repo/releases/download/v$Version/supabase_${Version}_windows_arm64.zip|arm64"

$wingetCreateArgs = @(
  'update'
  $PackageId
  '--version'
  $Version
  '--urls'
  $amd64Url
  $arm64Url
  '--release-notes-url'
  $releaseUrl
  '--out'
  $OutDir
  '--prtitle'
  "New version: $PackageId version $Version"
  '--no-open'
)

if ($Submit -and -not $DryRun) {
  $wingetCreateArgs += '--submit'
}

Write-Host "Running WingetCreate for $PackageId $Version"
& $wingetCreate @wingetCreateArgs
