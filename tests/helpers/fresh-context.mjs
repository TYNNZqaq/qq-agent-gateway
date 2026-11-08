import path from 'node:path';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {initializeApplicationData,writeApplicationJson} from '../../packages/host-control/application-paths.mjs';
import {accountDirectories} from '../../packages/host-control/codex-account-process.mjs';
import {SETUP_PRIVACY_HASH,SETUP_PRIVACY_VERSION,setupScope} from '../../packages/host-control/setup-policy.mjs';
import {ManagementStore} from '../../packages/storage/management-store.mjs';
import {AccountControlStore} from '../../packages/storage/account-control-store.mjs';
import {QQControlStore} from '../../packages/storage/qq-control-store.mjs';
import {SetupStore} from '../../packages/storage/setup-store.mjs';
export function freshContext(){
 const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'fresh-context-')),initialized=initializeApplicationData({dataDirectory:path.join(root,'data'),home:root}),{paths,identity}=initialized,project=path.join(root,'project');mkdirSync(project);accountDirectories(paths.dataDirectory);mkdirSync(paths.qqDirectory);
 const management=new ManagementStore(paths.managementDatabase,['codex']),bot=management.createBot({name:'Synthetic QQ',appId:'12345',expectedRevision:0}),agent=management.createAgent({name:'Synthetic Codex',toolId:'codex',expectedRevision:1});management.bind({botId:bot.id,agentId:agent.id,expectedRevision:2});const b=management.snapshot().bindings[0],binding={botId:bot.id,agentId:agent.id,bindingId:b.id,bindingVersion:b.version};management.close();
 const a={schemaVersion:1,connectionId:randomUUID(),agentId:agent.id,lease:null,process:null,selected:{model:'synthetic-user-selected',accountEpoch:randomUUID()},actions:[]},account=new AccountControlStore(path.join(paths.accountDirectory,'control.sqlite'),a);account.close();
 const owner={...binding,accountConnectionId:a.connectionId},qq=new QQControlStore(path.join(paths.qqDirectory,'control.sqlite'),{schemaVersion:1,salt:'synthetic',lease:null,owner,credential:{appId:'12345',environment:'sandbox',version:1,reference:randomUUID(),encrypted:'synthetic-ciphertext-not-real'},observation:null,actions:[]});qq.close();
 const scope=setupScope({identity,account:a,binding}),journal=new SetupStore(path.join(paths.dataDirectory,'setup.sqlite'),identity),state=journal.load();state.consent={schemaVersion:1,id:randomUUID(),confirmed:true,policyVersion:SETUP_PRIVACY_VERSION,policyHash:SETUP_PRIVACY_HASH,scope};state.projects=[{key:'own',id:randomUUID(),grantId:randomUUID(),label:'My project',path:project,mode:'read-only',tools:['read'],policyVersion:1,owner:scope}];journal.commit(state,state.revision);journal.close();writeApplicationJson(paths.consentFile,state.consent);return {root,paths,identity,binding};
}
