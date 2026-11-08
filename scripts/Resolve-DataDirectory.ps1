param([string]$RuntimeDirectory)
$ErrorActionPreference='Stop'
. ([IO.Path]::Combine($PSScriptRoot,'Initialize-Cache.ps1')) -CacheDataDirectory $RuntimeDirectory
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$entry=Join-Path $PSScriptRoot '../packages/host-control/cli.mjs'
$arguments=@($entry,'paths')
if($RuntimeDirectory){$arguments+=@('--data-dir',$RuntimeDirectory)}
$previousConsoleEncoding=[Console]::OutputEncoding
$previousOutputEncoding=$OutputEncoding
try{
  # Node writes UTF-8 JSON; Windows PowerShell otherwise decodes it using the
  # caller's console code page, which can corrupt CJK paths and JSON escapes.
  [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
  $OutputEncoding=[Text.UTF8Encoding]::new($false)
  $result=& $nodePath @arguments
  $nodeExitCode=$LASTEXITCODE
}finally{
  [Console]::OutputEncoding=$previousConsoleEncoding
  $OutputEncoding=$previousOutputEncoding
}
if($nodeExitCode -ne 0){throw 'USER_DATA_LOCATION_INVALID'}
$paths=$result|ConvertFrom-Json
if(!$paths.dataDirectory -or ![IO.Path]::IsPathRooted($paths.dataDirectory)){throw 'USER_DATA_LOCATION_INVALID'}
Write-Output $paths.dataDirectory
