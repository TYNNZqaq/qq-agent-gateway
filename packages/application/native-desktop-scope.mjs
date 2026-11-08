import {sha256} from './boundaries.mjs';
export const nativeGlobalEnabled=config=>config.desktopNotifications?.enabled===true&&config.desktopNotifications.scope==='all-local';
export function nativeGlobalScope(config,owner){
 if(!owner||!config.binding?.botId||!config.binding?.agentId||!config.binding?.bindingId||!Number.isInteger(config.binding.bindingVersion))throw Error('DESKTOP_NOTIFICATION_OWNER_REQUIRED');
 return {schemaVersion:2,instanceId:config.instanceId,hostId:config.hostId||config.instanceId,dataDirectory:config.runtimeRoot||config.stateDir,binding:config.binding,appId:config.qq.appId,owner,home:config.desktopNotifications.home,since:config.desktopNotifications.since,scope:'all-local'};
}
export function nativeCatalogSnapshot(store,config){
 if(!nativeGlobalEnabled(config))return null;
 const snapshot=store.get('nativeCatalog');
 try{return snapshot?.scopeKey===sha256(JSON.stringify(nativeGlobalScope(config,store.get('owner'))))?snapshot:null;}catch{return null;}
}
export function nativeGlobalNoticeValid(store,config,observation){
 try{return nativeGlobalEnabled(config)&&sha256(JSON.stringify(nativeGlobalScope(config,store.get('owner'))))===observation.scope_key;}catch{return false;}
}
