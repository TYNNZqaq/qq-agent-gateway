import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,writeFileSync,mkdirSync,lstatSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {readSetupContext,desktopFeatureConsentValid} from '../host-control/setup-policy.mjs';
import {firstRunFeatureDefaults} from './first-run-features.mjs';
import {locateAccountCli} from '../host-control/codex-account-process.mjs';
import {readCodexLiveProof} from '../host-control/codex-live-status.mjs';
import {createHash} from 'node:crypto';
import {Store} from './store.mjs';
import {loadConfig,PROJECT_ROOT} from './config.mjs';
import {atomicJson,noLinks,projectBoundary} from './boundaries.mjs';

export function activeBusinessConfig(runtime){
 const file=path.join(runtime,'business','active.json');if(!existsSync(file))return null;const active=JSON.parse(readFileSync(file,'utf8'));
 if(active.schemaVersion!==1||!/^[a-f0-9-]{36}$/i.test(active.botId||'')||active.configRelative!==active.botId+'/config.local.json')throw Error('BUSINESS_ACTIVE_REFERENCE_INVALID');
 return {active,file:path.join(runtime,'business',active.configRelative)};
}
export function prepareFreshBusiness(runtime,{executable=locateAccountCli(),featureOptions}={}){
 const context=readSetupContext(runtime),existing=activeBusinessConfig(runtime);
 if(existing){const config=loadConfig(existing.file);if(config.binding.botId!==context.binding.botId||config.binding.agentId!==context.binding.agentId||config.binding.bindingId!==context.binding.bindingId||config.binding.bindingVersion!==context.binding.bindingVersion)throw Error('BUSINESS_BINDING_CHANGED');return {config,alreadyPrepared:true};}
 const projects=Object.fromEntries(context.setup.projects.filter(p=>JSON.stringify(p.owner)===JSON.stringify(context.scope)).map(p=>[p.key,{id:p.id,grantId:p.grantId,label:p.label,path:projectBoundary(p.path,PROJECT_ROOT,context.paths.dataDirectory),mode:p.mode,tools:p.tools,policyVersion:p.policyVersion}]));
 if(!Object.keys(projects).length&&!desktopFeatureConsentValid(context.consent))throw Error('SETUP_PROJECT_REQUIRED');
 let qq;const db=new DatabaseSync(path.join(context.paths.qqDirectory,'control.sqlite'),{readOnly:true});try{qq=JSON.parse(db.prepare('SELECT snapshot FROM qq_control WHERE id=1').get().snapshot);}finally{db.close();}
 const expected={...context.binding,accountConnectionId:context.account.connectionId};
 if(!qq.credential||JSON.stringify(qq.owner)!==JSON.stringify(expected)||qq.credential.appId!==context.bot.app_id)throw Error('SETUP_QQ_CREDENTIAL_REQUIRED');
 const directory=noLinks(path.join(context.paths.businessDirectory,context.binding.botId),{create:true}),intentFile=path.join(directory,'preparing.json'),intent={schemaVersion:1,instanceId:context.identity.instanceId,owner:expected,credentialVersion:qq.credential.version,credentialReference:qq.credential.reference};
 if(existsSync(intentFile)){if(JSON.stringify(JSON.parse(readFileSync(intentFile)))!==JSON.stringify(intent))throw Error('BUSINESS_PREPARATION_OWNER_CHANGED');}
 else{if(readdirSync(directory).length)throw Error('BUSINESS_UNRECOGNIZED_DATA');writeFileSync(intentFile,JSON.stringify(intent),{flag:'wx',mode:0o600});}
 if(typeof context.identity.workspaceDirectory!=='string'||!path.isAbsolute(context.identity.workspaceDirectory))throw Error('SETUP_WORKSPACE_LOCATION_REQUIRED');
 const chatWorkspace=noLinks(path.join(context.identity.workspaceDirectory,'chat',context.binding.botId),{create:true});projectBoundary(chatWorkspace,PROJECT_ROOT,context.paths.dataDirectory);
 const file=path.join(directory,'config.local.json'),config={schemaVersion:3,policyVersion:3,instanceId:randomUUID(),hostId:context.identity.hostId,runtimeRoot:context.paths.dataDirectory,stateDir:directory,accountHome:context.paths.accountHome,accountConnectionId:context.account.connectionId,binding:context.binding,externalUseConsent:context.consent,integration:{backend:'app-server'},executor:{binary:noLinks(executable),enabled:false,timeoutMs:600000,dailyTaskLimit:20,maxQueuedTasks:10},qq:{appId:qq.credential.appId,credentialFile:'qq.secret',credentialFormat:'dpapi-qq-owner-v1',credentialVersion:qq.credential.version,environment:qq.credential.environment,passiveWindowSeconds:300,maxPassiveReplies:4,minimumSendIntervalMs:3200,allowProactive:false},chat:{model:context.account.selected.model,reasoning:'low'},work:{model:context.account.selected.model,reasoning:'low'},chatWorkspace,chatProjectId:randomUUID(),chatGrantId:randomUUID(),projects,fileReceive:{enabled:true,directory:path.join(directory,'received')},fileDelivery:{enabled:true,sendEnabled:true},desktop:{enabled:false},desktopTasks:{enabled:false},desktopApprovals:{enabled:false},desktopQuestions:{enabled:false}};
 const credentialFile=path.join(directory,'qq.secret');if(existsSync(credentialFile)){const s=lstatSync(credentialFile);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||readFileSync(credentialFile,'utf8')!==qq.credential.encrypted)throw Error('BUSINESS_CREDENTIAL_PREPARATION_CHANGED');}else writeFileSync(credentialFile,qq.credential.encrypted,{mode:0o600,flag:'wx'});
 Object.assign(config,firstRunFeatureDefaults(context,featureOptions));
 mkdirSync(config.fileReceive.directory,{recursive:true});const store=new Store(directory,{numberingConfig:config});try{if(store.get('owner'))throw Error('FRESH_INITIALIZATION_CANNOT_ADOPT_OWNER');}finally{store.close();}
 if(existsSync(file)){const previous=loadConfig(file);if(JSON.stringify(previous.binding)!==JSON.stringify(context.binding)||previous.accountConnectionId!==context.account.connectionId)throw Error('BUSINESS_PREPARATION_OWNER_CHANGED');config.instanceId=previous.instanceId;}
 atomicJson(file,config);atomicJson(path.join(context.paths.businessDirectory,'active.json'),{schemaVersion:1,botId:context.binding.botId,agentId:context.binding.agentId,bindingVersion:context.binding.bindingVersion,configRelative:context.binding.botId+'/config.local.json'});return {config:loadConfig(file),alreadyPrepared:false};
}
export function activateFreshBusiness(runtime){
 const context=readSetupContext(runtime),active=activeBusinessConfig(runtime);if(!active)throw Error('BUSINESS_NOT_PREPARED');const config=loadConfig(active.file);
 if(JSON.stringify(config.binding)!==JSON.stringify(context.binding)||config.accountConnectionId!==context.account.connectionId)throw Error('BUSINESS_BINDING_CHANGED');
 const fingerprint=createHash('sha256').update(JSON.stringify(context.account.actions.filter(a=>['login','logout'].includes(a.kind)))).digest('hex'),proof=readCodexLiveProof({runtimeDirectory:runtime,agentId:context.binding.agentId,connectionId:context.account.connectionId,model:context.account.selected.model,selectionEpoch:context.account.selected.accountEpoch,accountActionsFingerprint:fingerprint,binding:context.binding,environment:{...process.env,CODEX_APP_RUNTIME_CLI_PATH:config.executor.binary}});
 if(!proof.verified)throw Error(proof.reason||'SELF_TEST_REQUIRED');
 const store=new Store(config.stateDir,{numberingConfig:config});try{let owner;try{owner=JSON.parse(store.get('owner'));}catch{}if(!Array.isArray(owner)||owner[0]!==config.qq.appId||owner[1]!=='c2c'||!owner[2])throw Error('SETUP_QQ_PAIRING_REQUIRED');}finally{store.close();}
 const c=JSON.parse(readFileSync(active.file,'utf8'));c.externalUseConsent=context.consent;c.executor.enabled=true;delete c.serviceMode;c.work={...c.work,model:context.account.selected.model};
 const grants=context.setup.projects.filter(p=>JSON.stringify(p.owner)===JSON.stringify(context.scope));if(!grants.length)throw Error('SETUP_PROJECT_REQUIRED');c.projects=Object.fromEntries(grants.map(p=>[p.key,{id:p.id,grantId:p.grantId,label:p.label,...(p.aliases?{aliases:p.aliases}:{}),path:projectBoundary(p.path,PROJECT_ROOT,runtime),mode:p.mode,tools:p.tools,policyVersion:p.policyVersion}]));
 atomicJson(active.file,c);return loadConfig(active.file);
}
