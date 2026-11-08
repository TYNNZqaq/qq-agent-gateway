import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,lstatSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Store} from './store.mjs';
import {noLinks,sha256} from './boundaries.mjs';

const program=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function json(file){
 const checked=noLinks(file),stat=lstatSync(checked);
 if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)throw Error('CLIENT_QUESTION_CONTEXT_FILE_UNSAFE');
 const bytes=readFileSync(checked);return {file:checked,bytes,value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''))};
}
export function openClientQuestionContext(settingsFile){
 const input=json(settingsFile),settings=input.value;
 if(settings.schemaVersion!==1||settings.kind!=='qq-client-question-mcp'||settings.enabled!==true||noLinks(settings.programDirectory)!==program)throw Error('CLIENT_QUESTION_SETTINGS_INVALID');
 const directory=noLinks(settings.businessDirectory),runtime=noLinks(path.resolve(directory,'../..'));
 if(directory!==noLinks(path.join(runtime,'business',settings.binding.botId))||input.file!==path.join(directory,'client-question-mcp-settings.json'))throw Error('CLIENT_QUESTION_SETTINGS_PATH_INVALID');
 const file=path.join(directory,'config.local.json'),original=json(file),config=original.value;
 const active=()=>json(path.join(runtime,'business','active.json')).value;
 if(config.instanceId!==settings.instanceId||config.hostId!==settings.hostId||config.qq.appId!==settings.appId||JSON.stringify(config.binding)!==JSON.stringify(settings.binding)||noLinks(config.runtimeRoot)!==runtime||config.externalUseConsent?.confirmed!==true)throw Error('CLIENT_QUESTION_BINDING_INVALID');
 if(!Array.isArray(settings.modules)||settings.modules.length!==3||new Set(settings.modules.map(entry=>entry.file)).size!==3)throw Error('CLIENT_QUESTION_MODULE_PROOF_MISSING');
 for(const entry of settings.modules){if(!/^packages\/application\/client-question-(?:gateway|context|mcp)\.mjs$/.test(entry.file)||sha256(readFileSync(noLinks(path.join(program,entry.file))))!==entry.sha256)throw Error('CLIENT_QUESTION_MODULE_CHANGED');}
 const dbFile=noLinks(path.join(directory,'state.sqlite'));if(lstatSync(dbFile).nlink!==1)throw Error('CLIENT_QUESTION_STATE_LINK');
 const managementFile=noLinks(path.join(runtime,'management.sqlite'));if(lstatSync(managementFile).nlink!==1)throw Error('CLIENT_QUESTION_MANAGEMENT_LINK');
 let store,management;
 try{
  management=new DatabaseSync(managementFile,{readOnly:true});management.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
  store=new Store(directory,{numberingConfig:config});
  const owner=store.get('owner');let identity;try{identity=JSON.parse(owner);}catch{}
  if(!Array.isArray(identity)||identity[0]!==settings.appId||identity[1]!=='c2c'||!identity[2]||sha256(owner)!==settings.ownerHash)throw Error('CLIENT_QUESTION_OWNER_INVALID');
  config.stateDir=directory;
  const online=()=>{try{const s=json(path.join(directory,'service.json')).value,age=Date.now()-s.updatedAt;return s.botId===config.binding.botId&&s.agentId===config.binding.agentId&&s.state==='running'&&s.qqConnected===true&&age>=-1500&&age<=15000;}catch{return false;}};
  const guard=({online:requireOnline=false}={})=>{
   const binding=management.prepare('SELECT * FROM ui_bindings WHERE id=? AND active=1').get(config.binding.bindingId),selected=active();
   if(sha256(readFileSync(input.file))!==sha256(input.bytes)||sha256(readFileSync(file))!==sha256(original.bytes)||store.get('owner')!==owner||selected.botId!==config.binding.botId||selected.configRelative!==config.binding.botId+'/config.local.json'||!binding||binding.bot_id!==config.binding.botId||binding.agent_id!==config.binding.agentId||binding.version!==config.binding.bindingVersion)throw Error('CLIENT_QUESTION_CONTEXT_CHANGED');
   if(requireOnline&&!online())throw Error('CLIENT_QUESTION_BOT_OFFLINE');
  };
  guard();
  return {store,config,guard,status:()=>{guard();return {configured:true,business_online:online(),flow:'original-client-mcp-tool-result',ordinary_answers:true,native_q_form_writeback:false,approvals:false,real_roundtrip_verified:false};},close(){management.close();store.close();}};
 }catch(error){management?.close();store?.close();throw error;}
}
