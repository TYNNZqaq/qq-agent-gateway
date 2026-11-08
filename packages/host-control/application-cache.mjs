import path from 'node:path';
import {checkedApplicationPath,requireStorageVolume} from './application-paths.mjs';

// Overrides are scoped to QQ Agent and its children, never to the user's global environment.
export function applicationCacheEnvironment(directory){
 const root=requireStorageVolume(checkedApplicationPath(directory)),cache=path.join(root,'cache'),temp=path.join(root,'tmp');
 return {TEMP:temp,TMP:temp,TMPDIR:temp,XDG_CACHE_HOME:cache,LOCALAPPDATA:path.join(cache,'local'),APPDATA:path.join(cache,'roaming'),NPM_CONFIG_CACHE:path.join(cache,'npm'),PSModuleAnalysisCachePath:path.join(cache,'powershell','ModuleAnalysisCache')};
}
export function prepareApplicationCache(directory){
 const environment=applicationCacheEnvironment(directory);
 for(const dir of [environment.TEMP,environment.XDG_CACHE_HOME,environment.LOCALAPPDATA,environment.APPDATA,environment.NPM_CONFIG_CACHE,path.dirname(environment.PSModuleAnalysisCachePath)])checkedApplicationPath(dir,{create:true});
 return environment;
}
export function withApplicationCache(environment,directory){
 const overrides=applicationCacheEnvironment(directory),keys=new Set(Object.keys(overrides).map(k=>k.toUpperCase()));
 return {...Object.fromEntries(Object.entries(environment).filter(([key])=>!keys.has(key.toUpperCase()))),...overrides};
}
export function applyApplicationCache(directory){
 const environment=prepareApplicationCache(directory),keys=new Set(Object.keys(environment).map(k=>k.toUpperCase()));
 for(const key of Object.keys(process.env))if(keys.has(key.toUpperCase()))delete process.env[key];
 Object.assign(process.env,environment);return environment;
}
