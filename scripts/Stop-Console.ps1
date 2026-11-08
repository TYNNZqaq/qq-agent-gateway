param([string]$RuntimeDirectory)
$ErrorActionPreference='Stop'
. ([IO.Path]::Combine($PSScriptRoot,'Initialize-Cache.ps1'))
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeDirectory=& (Join-Path $PSScriptRoot 'Resolve-DataDirectory.ps1') -RuntimeDirectory $RuntimeDirectory
$stateFile=Join-Path $RuntimeDirectory 'management-service.json'
if(!(Test-Path -LiteralPath $stateFile)){Write-Output 'MANAGEMENT_NOT_RUNNING';exit 0}
$state=Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json
if($state.status -eq 'stopped'){Write-Output 'MANAGEMENT_STOPPED';exit 0}
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
& $nodePath (Join-Path $projectRoot 'packages\host-control\cli.mjs') stop --runtime $RuntimeDirectory
for($attempt=0;$attempt -lt 40;$attempt++){
  Start-Sleep -Milliseconds 250
  $current=Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json
  if($current.instance -eq $state.instance -and $current.status -eq 'stopped'){Write-Output 'MANAGEMENT_STOPPED_DATA_PRESERVED';exit 0}
}
throw 'MANAGEMENT_STOP_UNCONFIRMED'
