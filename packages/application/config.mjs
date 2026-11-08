import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {completionText} from './completion.mjs';
import {noLinks,projectBoundary,inside} from './boundaries.mjs';
import {PROGRAM_DIRECTORY,resolveApplicationPaths,readApplicationIdentity} from '../host-control/application-paths.mjs';
export const PROJECT_ROOT=PROGRAM_DIRECTORY;
export const DEFAULT_STATE=resolveApplicationPaths().businessDirectory;
export const DEFAULT_CONFIG=path.join(DEFAULT_STATE,'config.local.json');
export const redact=value=>completionText(value).slice(0,1000);
export const powerShellEnvironment=source=>Object.fromEntries(Object.entries(source||process.env).filter(([k])=>k.toUpperCase()!=='PSMODULEPATH'));
export function evidence(){return null;}
export function loadConfig(file=DEFAULT_CONFIG){
 const target=noLinks(path.resolve(file));if(lstatSync(target).nlink!==1)throw Error('CONFIG_HARDLINK');
 const config=JSON.parse(readFileSync(target,'utf8').replace(/^\uFEFF/,''));
 if(config.schemaVersion!==3 || !config.qq || !config.executor || !/^[a-f0-9-]{36}$/i.test(config.instanceId||''))throw Error('BUSINESS_CONFIG_REQUIRED');
 config.stateDir=noLinks(path.dirname(target));
 const dataRoot=noLinks(path.resolve(config.stateDir,'../..'));
 const paths=resolveApplicationPaths({dataDirectory:dataRoot}),identity=readApplicationIdentity(paths);
 config.dataIdentityHash=createHash('sha256').update(readFileSync(paths.identityFile)).digest('hex');
 if(path.basename(path.dirname(config.stateDir))!=='business'||path.basename(config.stateDir)!==config.binding?.botId||config.hostId!==identity.hostId||config.runtimeRoot&&noLinks(config.runtimeRoot)!==dataRoot)throw Error('BUSINESS_INSTANCE_OWNER_CHANGED');
 if(!config.accountHome || !path.isAbsolute(config.accountHome) || noLinks(config.accountHome)!==noLinks(paths.accountHome))throw Error('OWN_ACCOUNT_HOME_REQUIRED');
 config.projects||={};if(Object.keys(config.projects).length>32)throw Error('PROJECT_LIMIT');
 for(const [id,project]of Object.entries(config.projects)){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)||['__proto__','prototype','constructor'].includes(id))throw Error('PROJECT_KEY_INVALID');
  if(project.aliases!==undefined&&(!Array.isArray(project.aliases)||project.aliases.length>8||project.aliases.some(a=>typeof a!=='string'||!a.trim()||a!==a.trim()||a.length>60||/[\x00-\x1f]/.test(a))))throw Error('PROJECT_ALIAS_INVALID');
  project.path=projectBoundary(path.resolve(project.path),PROJECT_ROOT,dataRoot);
  if(!['read-only','workspace-write'].includes(project.mode)||!Array.isArray(project.tools)||project.tools.some(t=>!['read','edit','shell'].includes(t))||!project.tools.includes('read')||(project.mode==='workspace-write')!==project.tools.includes('edit'))throw Error('PROJECT_POLICY_INVALID');
 }
 if(!/^\d{1,30}$/.test(config.qq.appId)||config.qq.credentialFile!=='qq.secret')throw Error('BOT_CREDENTIAL_REQUIRED');
 config.qq.credentialFile=path.join(config.stateDir,'qq.secret');noLinks(config.qq.credentialFile);
 if(!Number.isInteger(config.qq.passiveWindowSeconds)||config.qq.passiveWindowSeconds<1||config.qq.passiveWindowSeconds>3600||!Number.isInteger(config.qq.maxPassiveReplies)||config.qq.maxPassiveReplies<1||config.qq.maxPassiveReplies>4||config.qq.minimumSendIntervalMs<3100)throw Error('QQ_POLICY_INVALID');
 if(!Number.isInteger(config.executor.timeoutMs)||config.executor.timeoutMs<1000||config.executor.timeoutMs>3600000||!Number.isInteger(config.executor.dailyTaskLimit)||config.executor.dailyTaskLimit<1||config.executor.dailyTaskLimit>100||!Number.isInteger(config.executor.maxQueuedTasks)||config.executor.maxQueuedTasks<1||config.executor.maxQueuedTasks>50)throw Error('EXECUTION_POLICY_INVALID');
 config.fileReceive||={};config.fileReceive.directory=noLinks(config.fileReceive.directory||path.join(config.stateDir,'received'),{create:true});
 if(!inside(config.stateDir,config.fileReceive.directory))throw Error('INPUT_DIRECTORY_INVALID');
 config.integration={backend:'app-server'};config.policyVersion=3;
 if(config.serviceMode!==undefined&&(config.serviceMode!=='native-only'||config.executor.enabled!==false||config.automaticSetup?.schemaVersion!==1))throw Error('NATIVE_ONLY_CONFIGURATION_INVALID');
 for(const feature of ['desktop','desktopTasks','desktopApprovals','desktopQuestions'])config[feature]={enabled:false};
 config.desktopNotifications||={enabled:false};
 config.remoteApprovals||={enabled:false};
 config.nativeDesktopApprovals||={enabled:false};
 config.nativeDesktopQuestions||={enabled:false};
 config.nativeDesktopControl||={enabled:false};
 if(config.nativeDesktopControl.enabled===true){if(config.nativeDesktopControl.transport!=='codex-ipc'||config.desktopNotifications?.enabled!==true||config.desktopNotifications.scope!=='all-local')throw Error('NATIVE_OWNER_CONFIGURATION_INVALID');if(!config.nativeDesktopQuestions?.enabled||noLinks(config.nativeDesktopQuestions.home)!==noLinks(config.desktopNotifications.home))throw Error('NATIVE_OWNER_HOME_MISMATCH');}
 if(config.nativeDesktopQuestions.enabled===true){config.nativeDesktopQuestions.home=noLinks(config.nativeDesktopQuestions.home);if(!Number.isSafeInteger(config.nativeDesktopQuestions.since)||config.nativeDesktopQuestions.since<1||config.nativeDesktopQuestions.since>Date.now()+30000)throw Error('NATIVE_QUESTION_CONFIGURATION_INVALID');if(config.nativeDesktopApprovals.enabled===true&&config.nativeDesktopQuestions.home!==noLinks(config.nativeDesktopApprovals.home))throw Error('NATIVE_QUESTION_HOME_MISMATCH');}
 if(config.nativeDesktopApprovals.enabled===true){config.nativeDesktopApprovals.home=noLinks(config.nativeDesktopApprovals.home);const settings=noLinks(config.nativeDesktopApprovals.settingsFile);if(path.dirname(settings)!==config.stateDir)throw Error('NATIVE_PERMISSION_SETTINGS_OUTSIDE_INSTANCE');config.nativeDesktopApprovals.settingsFile=settings;}
 config.runtimeRoot=dataRoot;config.programDirectory=PROJECT_ROOT;config.file=target;return config;
}
