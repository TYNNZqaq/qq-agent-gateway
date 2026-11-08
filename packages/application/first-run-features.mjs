import path from 'node:path';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readSetupContext,desktopFeatureConsentValid} from '../host-control/setup-policy.mjs';
import {nativeDesktopLocation} from '../host-control/native-desktop-location.mjs';
import {atomicJson,noLinks} from './boundaries.mjs';
import {Store} from './store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const featureFingerprint=config=>hash(JSON.stringify([config.desktopNotifications,config.nativeDesktopQuestions,config.nativeDesktopControl]));
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
export function firstRunFeatureDefaults(context,{now=()=>Date.now(),environment=process.env,home}={}){
 if(!desktopFeatureConsentValid(context.consent))return {};
 const location=nativeDesktopLocation({environment,home,privateRoots:[context.paths.dataDirectory,context.paths.accountHome,context.paths.programDirectory]});
 const since=now();
 const defaults={
  serviceMode:'native-only',
  automaticSetup:{schemaVersion:1,enabled:true,since,consentFingerprint:hash(JSON.stringify(context.consent.desktopFeatures)),state:location.ready?'configured':'waiting-for-desktop',reason:location.reason||null},
  desktopNotifications:location.ready?{enabled:true,scope:'all-local',home:location.home,since,observationOnlyFallback:true}:{enabled:false},
  nativeDesktopQuestions:location.ready?{enabled:true,home:location.home,since}:{enabled:false},
  nativeDesktopControl:location.ready?{enabled:true,transport:'codex-ipc'}:{enabled:false}
 };
 defaults.automaticSetup.featureFingerprint=featureFingerprint(defaults);
 return defaults;
}
export function configureFirstRunFeatures(runtime,configFile,{environment=process.env,home,pidAlive=alive,now=()=>Date.now()}={}){
 const context=readSetupContext(runtime),file=noLinks(configFile),expected=path.join(context.paths.businessDirectory,context.binding.botId,'config.local.json');
 if(file!==noLinks(expected)||lstatSync(file).nlink!==1)throw Error('BUSINESS_BINDING_CHANGED');
 const bytes=readFileSync(file),config=JSON.parse(bytes.toString('utf8'));
 if(config.automaticSetup?.enabled!==true)return {changed:false,configured:false,reason:'AUTOMATIC_FEATURES_NOT_SELECTED'};
 if(JSON.stringify(config.binding)!==JSON.stringify(context.binding)||config.accountConnectionId!==context.account.connectionId||config.hostId!==context.identity.hostId)throw Error('BUSINESS_BINDING_CHANGED');
 if(!desktopFeatureConsentValid(context.consent)||hash(JSON.stringify(context.consent.desktopFeatures))!==config.automaticSetup.consentFingerprint)throw Error('SETUP_DESKTOP_CONSENT_REQUIRED');
 if(config.automaticSetup.featureFingerprint&&config.automaticSetup.featureFingerprint!==featureFingerprint(config))return {changed:false,configured:true,reason:'NATIVE_FEATURES_CUSTOMIZED'};
 const serviceFile=path.join(path.dirname(file),'service.json');
 if(existsSync(serviceFile)){
  const stat=lstatSync(serviceFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1048576)throw Error('BUSINESS_FILE_UNSAFE');
  const service=JSON.parse(readFileSync(serviceFile,'utf8'));
  if(pidAlive(service.pid)&&service.state!=='stopped')throw Error('BUSINESS_STOP_FIRST');
 }
 const defaults=firstRunFeatureDefaults(context,{environment,home,now:()=>config.automaticSetup.since||now()});
 const next={...config,...defaults,executor:{...config.executor,enabled:config.executor.enabled===true}};
 // Native feature setup cannot upgrade independently verified work execution.
 if(config.executor.enabled===true){next.serviceMode=config.serviceMode; if(next.serviceMode===undefined)delete next.serviceMode;}
 if(JSON.stringify(next)!==JSON.stringify(config)){
  if(!readFileSync(file).equals(bytes))throw Error('BUSINESS_CONFIGURATION_CHANGED');
  atomicJson(file,next);
  return {changed:true,configured:defaults.automaticSetup.state==='configured',reason:defaults.automaticSetup.reason};
 }
 return {changed:false,configured:defaults.automaticSetup.state==='configured',reason:defaults.automaticSetup.reason};
}
export function prepareNativeOnlyBusiness(runtime,configFile,options={}){
 const configured=configureFirstRunFeatures(runtime,configFile,options),context=readSetupContext(runtime),config=JSON.parse(readFileSync(configFile,'utf8'));
 if(config.serviceMode!=='native-only'||config.executor.enabled!==false)throw Error('NATIVE_ONLY_CONFIGURATION_REQUIRED');
 if(!desktopFeatureConsentValid(context.consent))throw Error('SETUP_DESKTOP_CONSENT_REQUIRED');
 const store=new Store(path.dirname(configFile),{numberingConfig:config});
 try{let owner;try{owner=JSON.parse(store.get('owner'));}catch{}if(!Array.isArray(owner)||owner[0]!==config.qq.appId||owner[1]!=='c2c'||!owner[2])throw Error('SETUP_QQ_PAIRING_REQUIRED');}finally{store.close();}
 return config.automaticSetup.enabled===false?{changed:false,configured:true,reason:'AUTOMATIC_FEATURES_DISABLED'}:configured;
}
