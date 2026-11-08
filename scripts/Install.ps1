param([string]$RuntimeDirectory,[switch]$OpenBrowser)
$ErrorActionPreference='Stop'
. ([IO.Path]::Combine($PSScriptRoot,'Initialize-Cache.ps1'))
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeDirectory=& (Join-Path $PSScriptRoot 'Resolve-DataDirectory.ps1') -RuntimeDirectory $RuntimeDirectory
& (Join-Path $PSScriptRoot 'Start-Console.ps1') -RuntimeDirectory $RuntimeDirectory -OpenBrowser:$OpenBrowser
if($LASTEXITCODE -and $LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& (Join-Path $PSScriptRoot 'Enable-CodexAutoConnect.ps1') -RuntimeDirectory $RuntimeDirectory
$package=Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw|ConvertFrom-Json
$installation=[ordered]@{product='qq-agent-management';version=$package.version;installedAt=[DateTime]::UtcNow.ToString('o');singleHost=$true;autoStart=$true;autoConnectTrigger='codex-desktop-start';executionEnabled=$false}
[IO.File]::WriteAllText((Join-Path $RuntimeDirectory 'management-installation.json'),($installation|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
