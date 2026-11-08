param([string]$RuntimeDirectory)
$ErrorActionPreference='Stop'
. ([IO.Path]::Combine($PSScriptRoot,'Initialize-Cache.ps1')) -CacheDataDirectory $RuntimeDirectory
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$entry=Join-Path $PSScriptRoot '../packages/host-control/cli.mjs'
$arguments=@($entry,'paths')
if($RuntimeDirectory){$arguments+=@('--data-dir',$RuntimeDirectory)}
$result=& $nodePath @arguments
if($LASTEXITCODE -ne 0){throw 'USER_DATA_LOCATION_INVALID'}
$paths=$result|ConvertFrom-Json
if(!$paths.dataDirectory -or ![IO.Path]::IsPathRooted($paths.dataDirectory)){throw 'USER_DATA_LOCATION_INVALID'}
Write-Output $paths.dataDirectory
