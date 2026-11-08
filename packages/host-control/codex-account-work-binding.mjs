import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,existsSync,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {scope,scopeKey,digest,identifier,freeze} from '../core/contracts.mjs';
import {SqliteJournal} from '../storage/sqlite-journal.mjs';
import {accountConfig} from './codex-account-policy.mjs';

const within=(root,file)=>{const r=path.relative(root,file);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
function checked(value,{directory=false}={}){
  if(typeof value!=='string'||!path.isAbsolute(value)||path.resolve(value)===path.parse(value).root)throw Error('ACCOUNT_WORK_PATH_INVALID');
  for(let p=path.resolve(value);;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('ACCOUNT_WORK_PATH_LINK');if(p===path.dirname(p))break;}
  const st=lstatSync(value);if(directory?!st.isDirectory():!st.isFile()||st.nlink!==1)throw Error('ACCOUNT_WORK_FILE_INVALID');return realpathSync(value);
}
// This bridge recognizes only the plugin's own account journal and fixed home.
// It never reads, parses, exports or copies an authentication token/file.
export function bindCodexAccountWork({runtimeDirectory,owner,grant,processKey,authorize,environment=process.env}={}){
  const s=scope(owner);identifier(processKey);if(typeof authorize!=='function')throw Error('ACCOUNT_WORK_AUTHORIZER_REQUIRED');
  const root=checked(runtimeDirectory,{directory:true}),home=checked(path.join(root,'codex-account','home'),{directory:true}),project=checked(grant?.projectPath,{directory:true});
  if(grant?.schemaVersion!==1||grant.projectPath!==project||scopeKey(grant.scope)!==scopeKey(s)||grant.network!==false||!Array.isArray(grant.tools)||!grant.tools.includes('file-read')||grant.tools.some(t=>!['file-read','file-write','command'].includes(t))||within(root,project)||within(project,root)||within(home,project)||within(project,home))throw Error('ACCOUNT_WORK_GRANT_REJECTED');
  const grantIdentity=digest(JSON.stringify(grant)),configFile=checked(path.join(home,'config.toml'));
  if(readFileSync(configFile,'utf8')!==accountConfig)throw Error('ACCOUNT_WORK_CONFIG_CHANGED');
  const management=new DatabaseSync(checked(path.join(root,'management.sqlite')),{readOnly:true});
  let account,journal;
  try{
    account=new DatabaseSync(checked(path.join(root,'codex-account','control.sqlite')),{readOnly:true});
    const readAccount=()=>JSON.parse(account.prepare('SELECT snapshot FROM account_control WHERE id=1').get().snapshot);
    const initialAccount=readAccount();
    if(initialAccount.agentId!==s.agentId||!initialAccount.connectionId||!initialAccount.selected?.model)throw Error('ACCOUNT_WORK_ASSOCIATION_REQUIRED');
    const connectionId=initialAccount.connectionId,model=initialAccount.selected.model;
    const marker=path.join(root,'codex-account','work-owner.json'),manifest=JSON.stringify({schemaVersion:1,kind:'qq-plugin-account-work-owner',agentId:s.agentId,connectionId,home});
    if(existsSync(marker)){checked(marker);if(readFileSync(marker,'utf8')!==manifest)throw Error('ACCOUNT_WORK_HOME_OWNER_CHANGED');}
    else writeFileSync(marker,manifest,{flag:'wx',mode:0o600});
    const directory=path.join(root,'codex-account-work');if(existsSync(directory))checked(directory,{directory:true});else mkdirSync(directory);
    const database=path.join(directory,'bindings.sqlite');if(existsSync(database))checked(database);
    journal=new SqliteJournal(database,{hostId:s.hostId,agentId:s.agentId,channel:'account-work:'+processKey});
    if(journal.load())throw Error('ACCOUNT_WORK_PRIOR_PROCESS_REQUIRES_REVIEW');
    let state={schemaVersion:1,revision:1,owner:{hostId:s.hostId,agentId:s.agentId},scope:s,grantIdentity,connectionId,model,home,project,processKey,state:'intent',pid:null};
    if(!journal.commit(state,0))throw Error('ACCOUNT_WORK_CAS_CONFLICT');
    let closed=false;
    const guard=()=>{
      if(closed||journal.load()?.revision!==state.revision)throw Error('ACCOUNT_WORK_STALE');
      const b=management.prepare('SELECT bot_id,agent_id,version FROM ui_bindings WHERE id=? AND active=1').get(s.bindingId),bot=management.prepare('SELECT status,archived FROM ui_bots WHERE id=?').get(s.botId),agent=management.prepare('SELECT status,archived,tool_id FROM ui_agents WHERE id=?').get(s.agentId),a=readAccount();
      if(!b||b.bot_id!==s.botId||b.agent_id!==s.agentId||b.version!==s.bindingVersion||bot?.status!=='registered'||bot.archived||agent?.status!=='registered'||agent.archived||agent.tool_id!=='codex'||a.agentId!==s.agentId||a.connectionId!==connectionId||a.selected?.model!==model||a.actions.some(action=>['login','logout'].includes(action.kind)&&['intent','awaiting','unknown'].includes(action.state)))throw Error('ACCOUNT_WORK_OWNER_REVOKED');
      checked(home,{directory:true});checked(project,{directory:true});checked(marker);checked(configFile);
      if(readFileSync(marker,'utf8')!==manifest||readFileSync(configFile,'utf8')!==accountConfig||authorize(freeze({scope:s,grant:structuredClone(grant),operation:'account-work',processKey}))!==true)throw Error('ACCOUNT_WORK_AUTHORIZATION_REJECTED');
    };
    const save=next=>{const value={...state,...next,revision:state.revision+1};if(!journal.commit(value,state.revision))throw Error('ACCOUNT_WORK_STALE');state=value;};
    guard();
    const binding=freeze({botId:s.botId,agentId:s.agentId,bindingId:s.bindingId,bindingVersion:s.bindingVersion});
    return Object.freeze({accountHome:home,runtimeRoot:root,model,binding,owner:s,grantIdentity,connectionId,runtimeGuard:guard,allowTurns:false,
      onSpawn(pid){guard();if(!Number.isSafeInteger(pid)||pid<1||state.state!=='intent')throw Error('ACCOUNT_WORK_SPAWN_INVALID');save({state:'running',pid});},
      onSessionOpened({threadId,sessionId,cwd,profileId}){guard();identifier(threadId);identifier(sessionId);identifier(profileId);if(cwd!==project||(state.sessions||[]).length>=64)throw Error('ACCOUNT_WORK_SESSION_REJECTED');const prior=(state.sessions||[]).find(x=>x.threadId===threadId);if(prior&&(prior.sessionId!==sessionId||prior.profileId!==profileId))throw Error('ACCOUNT_WORK_SESSION_CHANGED');if(!prior)save({sessions:[...(state.sessions||[]),{threadId,sessionId,cwd,profileId,grantIdentity}]});},
      onProcessClosed(){if(closed)return;try{if(journal.load()?.revision===state.revision)save({state:'closed'});}finally{closed=true;journal.close();management.close();account.close();}},
      snapshot(){guard();return structuredClone(state);}
    });
  }catch(error){journal?.close();account?.close();management.close();throw error;}
}
