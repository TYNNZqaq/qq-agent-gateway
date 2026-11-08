param([string]$CacheDataDirectory)
$ErrorActionPreference='Stop'
$cacheProgram=[IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot,'..'))
$cacheParent=[IO.Directory]::GetParent($cacheProgram).FullName
$cacheBase=if([IO.Path]::GetFileName($cacheParent) -ieq 'programs'){[IO.Directory]::GetParent($cacheParent).FullName}else{$cacheParent}
if($CacheDataDirectory){
 if(-not [IO.Path]::IsPathRooted($CacheDataDirectory)){throw 'APPLICATION_PATH_INVALID'}
 $cacheRoot=[IO.Path]::GetFullPath($CacheDataDirectory)
 if(-not [IO.File]::Exists([IO.Path]::Combine($cacheRoot,'instance.json'))){
  $cacheHasher=[Security.Cryptography.SHA256]::Create()
  try{$cacheRuntimeKey=([BitConverter]::ToString($cacheHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($cacheRoot.ToLowerInvariant())))).Replace('-','').ToLowerInvariant().Substring(0,20)}finally{$cacheHasher.Dispose()}
  $cacheRoot=[IO.Path]::Combine([IO.Directory]::GetParent($cacheRoot).FullName,'.qq-agent-bootstrap',$cacheRuntimeKey)
 }
}else{
 $cacheProfile=[Environment]::GetFolderPath('UserProfile').ToLowerInvariant()
 $cacheHasher=[Security.Cryptography.SHA256]::Create()
 try{$cacheUserKey=([BitConverter]::ToString($cacheHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($cacheProfile)))).Replace('-','').ToLowerInvariant().Substring(0,20)}finally{$cacheHasher.Dispose()}
 $cacheRoot=[IO.Path]::Combine($cacheBase,'QQAgentData','users',$cacheUserKey,'bootstrap')
}
if([IO.Path]::GetPathRoot($cacheRoot) -ieq [IO.Path]::GetPathRoot([Environment]::SystemDirectory)){throw 'SYSTEM_DRIVE_STORAGE_FORBIDDEN'}
# Check every existing component before creating any application-owned directory.
$cacheCursor=$cacheRoot
while($cacheCursor){
 if([IO.File]::Exists($cacheCursor) -or [IO.Directory]::Exists($cacheCursor)){
  if(([IO.File]::GetAttributes($cacheCursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'APPLICATION_PATH_LINK'}
 }
 $cacheNext=[IO.Directory]::GetParent($cacheCursor)
 $cacheCursor=if($cacheNext){$cacheNext.FullName}else{$null}
}
$env:TEMP=[IO.Path]::Combine($cacheRoot,'tmp');$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
$env:XDG_CACHE_HOME=[IO.Path]::Combine($cacheRoot,'cache')
$env:LOCALAPPDATA=[IO.Path]::Combine($env:XDG_CACHE_HOME,'local')
$env:APPDATA=[IO.Path]::Combine($env:XDG_CACHE_HOME,'roaming')
$env:NPM_CONFIG_CACHE=[IO.Path]::Combine($env:XDG_CACHE_HOME,'npm')
$cachePowerShell=[IO.Path]::Combine($env:XDG_CACHE_HOME,'powershell')
$env:PSModuleAnalysisCachePath=[IO.Path]::Combine($cachePowerShell,'ModuleAnalysisCache')
foreach($cacheDirectory in @($env:TEMP,$env:XDG_CACHE_HOME,$env:LOCALAPPDATA,$env:APPDATA,$env:NPM_CONFIG_CACHE,$cachePowerShell)){[IO.Directory]::CreateDirectory($cacheDirectory)|Out-Null}
