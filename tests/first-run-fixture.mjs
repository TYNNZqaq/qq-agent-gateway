import path from 'node:path';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {initializeApplicationData,writeApplicationJson} from '../packages/host-control/application-paths.mjs';
import {accountDirectories} from '../packages/host-control/codex-account-process.mjs';
import {SETUP_PRIVACY_HASH,SETUP_PRIVACY_VERSION,SETUP_DESKTOP_PRIVACY_HASH,setupScope} from '../packages/host-control/setup-policy.mjs';
import {ManagementStore} from '../packages/storage/management-store.mjs';
import {AccountControlStore} from '../packages/storage/account-control-store.mjs';
import {QQControlStore} from '../packages/storage/qq-control-store.mjs';
import {SetupStore} from '../packages/storage/setup-store.mjs';

export function firstRunFixture({desktop=true,grants=false,consent=true,desktopConsent=true}={}){
 const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'first-run-')),program=path.join(root,'program');mkdirSync(program);
 const {paths,identity}=initializeApplicationData({programDirectory:program,dataDirectory:path.join(root,'data'),home:root});accountDirectories(paths.dataDirectory);mkdirSync(paths.qqDirectory);
 const management=new ManagementStore(paths.managementDatabase,['codex']),bot=management.createBot({name:'Synthetic first-run bot',appId:'12345',expectedRevision:0}),agent=management.createAgent({name:'Synthetic first-run agent',toolId:'codex',expectedRevision:1});management.bind({botId:bot.id,agentId:agent.id,expectedRevision:2});
 const b=management.snapshot().bindings[0],binding={botId:bot.id,agentId:agent.id,bindingId:b.id,bindingVersion:b.version},account={schemaVersion:1,connectionId:randomUUID(),agentId:agent.id,lease:null,process:null,selected:{model:'synthetic-user-choice',accountEpoch:randomUUID()},actions:[]};
 const accountStore=new AccountControlStore(path.join(paths.accountDirectory,'control.sqlite'),account);accountStore.close();
 const owner={...binding,accountConnectionId:account.connectionId},qq=new QQControlStore(path.join(paths.qqDirectory,'control.sqlite'),{schemaVersion:1,salt:'synthetic',lease:null,owner,credential:{appId:'12345',environment:'sandbox',version:1,reference:randomUUID(),encrypted:'synthetic-own-encrypted-envelope'},observation:null,actions:[]});qq.close();
 const scope=setupScope({identity,account,binding}),journal=new SetupStore(path.join(paths.dataDirectory,'setup.sqlite'),identity),state=journal.load();
 if(consent)state.consent={schemaVersion:1,id:randomUUID(),confirmed:true,policyVersion:SETUP_PRIVACY_VERSION,policyHash:SETUP_PRIVACY_HASH,scope,confirmedAt:new Date().toISOString(),...(desktopConsent?{desktopFeatures:{policyVersion:1,policyHash:SETUP_DESKTOP_PRIVACY_HASH,enabled:true}}:{})};
 if(grants){const project=path.join(root,'project');mkdirSync(project);state.projects=[{key:'own',id:randomUUID(),grantId:randomUUID(),label:'Owned project',path:project,mode:'read-only',tools:['read'],policyVersion:1,owner:scope}];}
 journal.commit(state,state.revision);journal.close();if(consent)writeApplicationJson(paths.consentFile,state.consent);
 const desktopHome=path.join(root,'desktop-home');if(desktop){mkdirSync(path.join(desktopHome,'sessions'),{recursive:true});writeFileSync(path.join(desktopHome,'state_5.sqlite'),'synthetic-index-not-opened-by-configuration');}
 return {root,paths,identity,management,bot,agent,binding,account,scope,desktopHome,featureOptions:{environment:{CODEX_HOME:desktopHome},home:root},close(){management.close();}};
}
