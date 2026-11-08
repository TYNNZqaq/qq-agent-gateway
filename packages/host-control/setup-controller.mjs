import path from 'node:path';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {record,internalId,label,ManagementError} from '../core/management.mjs';
import {SetupStore} from '../storage/setup-store.mjs';
import {resolveApplicationPaths,readApplicationIdentity,checkedApplicationPath,writeApplicationJson} from './application-paths.mjs';
import {SETUP_PRIVACY_VERSION,SETUP_PRIVACY_TEXT,SETUP_PRIVACY_HASH,SETUP_DESKTOP_PRIVACY_TEXT,SETUP_DESKTOP_PRIVACY_HASH,desktopFeatureConsentValid,setupScope,assertConsentMirror} from './setup-policy.mjs';
import {diagnosticsPreview,exportDiagnostics} from './local-diagnostics.mjs';
import {nativeDesktopLocation} from './native-desktop-location.mjs';
const error=code=>new ManagementError(code,409),inside=(root,target)=>{const p=path.relative(root,target);return !p||p!=='..'&&!p.startsWith('..'+path.sep)&&!path.isAbsolute(p);};
export class SetupController{
 constructor({runtimeDirectory,managementStore,accountControl,businessControl,qqConnection,executionStatus,desktopReady,journal,identity,paths}={}){
  this.paths=paths||resolveApplicationPaths({dataDirectory:runtimeDirectory});this.identity=identity||readApplicationIdentity(this.paths);this.management=managementStore;this.account=accountControl;this.business=businessControl;this.qqConnection=qqConnection;this.executionStatus=executionStatus;this.journal=journal||new SetupStore(path.join(this.paths.dataDirectory,'setup.sqlite'),this.identity);this.data=this.journal.load();this.pairing=null;this.automaticSessionId=null;this.automaticBusy=false;this.automaticError=null;
  this.desktopReady=desktopReady||(()=>nativeDesktopLocation({privateRoots:[this.paths.dataDirectory,this.paths.programDirectory]}).ready);
  this.detachCompletion=this.business?.onWorkflowComplete?.(()=>{if(this.closed)return;try{this.guard();this.synchronize();this.advanceAutomaticSetup();}catch(e){this.automaticError=/^[A-Z_]+$/.test(e.code||e.message)?e.code||e.message:'SETUP_AUTOMATIC_RECONCILIATION_REQUIRED';}});
 }
 guard(){this.journal.assertRevision(this.data.revision);}
 save(){this.data.revision=this.journal.commit(this.data,this.data.revision);}
 check(input,fields){record(input,fields);internalId(input.operationId);if(input.expectedSetupRevision!==this.data.revision)throw error('SETUP_STALE_REVISION');this.guard();}
 context(botId){
  const a=this.account?.data,observed=this.account?.snapshot(),s=this.management.snapshot(),b=s.bindings.find(x=>x.agentId===a?.agentId),bot=s.bots.find(x=>x.id===b?.botId),agent=s.agents.find(x=>x.id===b?.agentId);
  if(!a?.selected?.model||!a.selected.accountEpoch||a.actions.some(x=>['login','logout'].includes(x.kind)&&['intent','awaiting','unknown'].includes(x.state))||observed?.account?.status!=='authenticated'||!observed.associationValid||!b||!bot||bot.id!==botId||bot.status!=='registered'||agent?.status!=='registered'||agent.toolId!=='codex')throw error('SETUP_ACCOUNT_BINDING_REQUIRED');
  const binding={botId:b.botId,agentId:b.agentId,bindingId:b.id,bindingVersion:b.version};return {scope:setupScope({identity:this.identity,account:a,binding}),binding,bot,account:a};
 }
 consent(input,sessionId){
  this.check(input,['operationId','botId','accepted','expectedSetupRevision']);if(typeof input.accepted!=='boolean')throw error('SETUP_CONSENT_VALUE_REQUIRED');const context=this.context(input.botId);
  const business=this.business?.snapshot();if(business?.running||business?.pending)throw error('BUSINESS_STOP_FIRST');
  const current=this.data.consent,sameAcceptance=input.accepted&&current?.policyVersion===SETUP_PRIVACY_VERSION&&current.policyHash===SETUP_PRIVACY_HASH&&JSON.stringify(current.scope)===JSON.stringify(context.scope)&&desktopFeatureConsentValid(current);
  // Reopening the same consented flow must not invalidate the stopped business
  // configuration's exact consent identity merely to establish a new UI window.
  if(sameAcceptance)this.requireConsent(context.scope);
  else{const consent={schemaVersion:1,id:input.operationId,confirmed:input.accepted,policyVersion:SETUP_PRIVACY_VERSION,policyHash:SETUP_PRIVACY_HASH,scope:context.scope,confirmedAt:new Date().toISOString(),desktopFeatures:{policyVersion:1,policyHash:SETUP_DESKTOP_PRIVACY_HASH,enabled:input.accepted}};writeApplicationJson(this.paths.consentFile,consent);this.data.consent=consent;this.save();}
  // Only a validated decision can establish/recover the initiating window.
  // A rejected POST or an unrelated state reader must never move a pairing code.
  this.automaticSessionId=input.accepted?sessionId||null:null;this.automaticError=null;
  return this.snapshot();
 }
 project(input){
  this.check(input,['operationId','botId','name','path','mode','tools','expectedSetupRevision']);const context=this.context(input.botId);this.requireConsent(context.scope);const business=this.business?.snapshot();if(business?.running||business?.pending)throw error('BUSINESS_STOP_FIRST');
  const name=label(input.name),directory=checkedApplicationPath(input.path);if(!existsSync(directory)||!lstatSync(directory).isDirectory()||directory===path.parse(directory).root||[this.paths.programDirectory,this.paths.dataDirectory].some(root=>inside(root,directory)||inside(directory,root)))throw error('SETUP_PROJECT_INVALID');
  if(!['read-only','workspace-write'].includes(input.mode)||!Array.isArray(input.tools)||!input.tools.includes('read')||input.tools.some(t=>!['read','edit','shell'].includes(t))||(input.mode==='workspace-write')!==input.tools.includes('edit'))throw error('SETUP_PROJECT_POLICY_INVALID');
  const active=this.data.projects.filter(p=>JSON.stringify(p.owner)===JSON.stringify(context.scope));if(active.length>=32||this.data.projects.length>=128||active.some(p=>p.label.toLocaleLowerCase()===name.toLocaleLowerCase()||p.path===directory))throw error('SETUP_PROJECT_DUPLICATE_OR_LIMIT');
  this.data.projects.push({id:randomUUID(),grantId:randomUUID(),key:'p_'+randomUUID().replaceAll('-',''),label:name,path:directory,mode:input.mode,tools:input.tools,policyVersion:1,owner:context.scope});this.save();return this.snapshot();
 }
 requireConsent(scope){if(this.data.consent?.confirmed!==true||this.data.consent.policyHash!==SETUP_PRIVACY_HASH||JSON.stringify(this.data.consent.scope)!==JSON.stringify(scope))throw error('SETUP_EXPLICIT_CONSENT_REQUIRED');try{assertConsentMirror(this.paths,this.data.consent);}catch{throw error('SETUP_CONSENT_MIRROR_CHANGED');}}
 verificationProject(input){
  this.check(input,['operationId','botId','expectedSetupRevision']);const context=this.context(input.botId);this.requireConsent(context.scope);const service=this.business?.snapshot();if(service?.running||service?.pending)throw error('BUSINESS_STOP_FIRST');
  if(typeof this.identity.workspaceDirectory!=='string'||!path.isAbsolute(this.identity.workspaceDirectory))throw error('SETUP_WORKSPACE_LOCATION_REQUIRED');
  const directory=checkedApplicationPath(path.join(this.identity.workspaceDirectory,'connection-check'));
  if([this.paths.programDirectory,this.paths.dataDirectory].some(root=>inside(root,directory)||inside(directory,root)))throw error('SETUP_PROJECT_INVALID');
  checkedApplicationPath(directory,{create:true});return this.project({...input,name:'连接验证',path:directory,mode:'workspace-write',tools:['read','edit','shell']});
 }
 synchronize(){
  let changed=false;for(const action of this.data.actions){if(!['intent','running'].includes(action.state))continue;const file=path.join(this.paths.dataDirectory,'setup-result-'+action.id+'.json');
   if(existsSync(file)){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1048576)throw error('SETUP_RESULT_UNSAFE');const result=JSON.parse(readFileSync(file,'utf8'));if(result.operationId!==action.id||result.kind!==action.kind)throw error('SETUP_RESULT_OWNER_CHANGED');action.state=result.result?.state==='unknown'?'unknown':result.error||action.kind==='self-test'&&(result.result?.accepted!==true||result.result?.runtimeEvidence!=='actual-current-cli')||action.kind==='pair'&&result.result?.paired!==true?'failed':'completed';action.error=result.error||result.result?.error||null;changed=true;}
   else{const business=this.business?.snapshot();if(business?.operation?.id===action.id&&['ended','unknown'].includes(business.operation.state)){action.state='unknown';action.error='SETUP_RESULT_REQUIRES_RECONCILIATION';changed=true;}else if(['activate','native-start'].includes(action.kind)&&business?.running){action.state='completed';changed=true;}}
  }if(changed)this.save();
 }
 advanceAutomaticSetup(){
  if(this.automaticBusy||!this.qqConnection||!this.business?.workflow)return;
  this.automaticBusy=true;
  try{
   const binding=this.management.snapshot().bindings.find(x=>x.agentId===this.account?.data?.agentId),context=this.context(binding?.botId);this.requireConsent(context.scope);
   if(!desktopFeatureConsentValid(this.data.consent)||!this.qqConnection.snapshot()?.credentialConfigured)return;
   const service=this.business.snapshot();if(service.running||service.pending||service.processAlive||this.data.actions.some(a=>['intent','running','unknown'].includes(a.state)))return;
   if(service.configured&&service.automaticFeatures?.enabled!==true)return;
   let kind;if(!service.configured)kind='initialize';else if(!service.paired)kind='pair';else if(service.executionConfigured)return;else if(this.executionStatus?.()?.verified===true&&this.data.projects.some(p=>JSON.stringify(p.owner)===JSON.stringify(context.scope)))kind='activate';else kind='native-start';
   const fingerprint=JSON.stringify([kind,context.scope]),previous=this.data.actions.findLast(a=>a.fingerprint===fingerprint&&a.automatic===true);let resumedFrom;
   if(previous){
    if(kind!=='native-start'||previous.state!=='completed'||service.automaticFeatures?.state!=='waiting-for-desktop'||this.data.actions.some(a=>a.resumedFrom===previous.id)||!this.desktopReady())return;
    const file=path.join(this.paths.dataDirectory,'setup-result-'+previous.id+'.json');if(!existsSync(file))return;
    const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1048576)throw error('SETUP_RESULT_UNSAFE');
    const result=JSON.parse(readFileSync(file,'utf8'));if(result.operationId!==previous.id||result.kind!=='native-start'||result.error||result.result?.waitingForDesktop!==true||result.result.configured!==false)return;
    resumedFrom=previous.id;
   }
   // Session ownership is intentionally not persisted. After a manager restart,
   // require an explicit scoped decision instead of letting the next GET take it.
   if(!this.automaticSessionId){this.automaticError='SETUP_AUTOMATIC_SESSION_RESUME_REQUIRED';return;}
   this.workflow(kind,{operationId:randomUUID(),botId:context.bot.id,expectedSetupRevision:this.data.revision},this.automaticSessionId,{automatic:true,resumedFrom});
   this.automaticError=null;
  }catch(e){this.automaticError=/^[A-Z_]+$/.test(e.code||e.message)?e.code||e.message:'SETUP_AUTOMATIC_RECONCILIATION_REQUIRED';}
  finally{this.automaticBusy=false;}
 }
 workflow(kind,input,sessionId,{automatic=false,resumedFrom}={}){
  this.check(input,['operationId','botId','expectedSetupRevision']);const context=this.context(input.botId);this.requireConsent(context.scope);this.synchronize();
  const fingerprint=JSON.stringify(resumedFrom?[kind,context.scope,{resumedFrom}]:[kind,context.scope]),prior=this.data.actions.find(a=>a.id===input.operationId);if(prior){if(prior.kind!==kind||prior.fingerprint!==fingerprint)throw error('SETUP_OPERATION_CONFLICT');return this.snapshot();}
  if(this.data.actions.some(a=>['intent','running','unknown'].includes(a.state)))throw error('SETUP_PRIOR_OPERATION_REQUIRES_RECONCILIATION');
  if(this.data.actions.length>=128)throw error('SETUP_OPERATION_LIMIT');if(!this.data.projects.some(p=>JSON.stringify(p.owner)===JSON.stringify(context.scope))&&!(desktopFeatureConsentValid(this.data.consent)&&(['initialize','pair'].includes(kind)||automatic&&kind==='native-start')))throw error('SETUP_PROJECT_REQUIRED');
  const business=this.business?.snapshot();if(!this.business||business?.running||business?.pending)throw error('BUSINESS_STOP_FIRST');
  if(!automatic&&sessionId){this.automaticSessionId=sessionId;this.automaticError=null;}
  const action={id:input.operationId,kind,fingerprint,state:'intent',createdAt:new Date().toISOString(),...(automatic?{automatic:true}:{}),...(resumedFrom?{resumedFrom}:{})};this.data.actions.push(action);this.save();let privateInput;
  if(kind==='pair'){const code=randomBytes(12).toString('hex');this.pairing={operationId:input.operationId,code,sessionId,expiresAt:Date.now()+600000};privateInput={operationId:input.operationId,code,expiresAt:this.pairing.expiresAt};}
  try{this.business.workflow(kind,{operationId:input.operationId},privateInput);action.state='running';this.save();}catch(e){action.state='unknown';action.error='SETUP_LAUNCH_REQUIRES_RECONCILIATION';this.save();throw e;}
  return this.snapshot();
 }
 initialize(input,sessionId){return this.workflow('initialize',input,sessionId);}
 selfTest(input,sessionId){return this.workflow('self-test',input,sessionId);}
 pair(input,sessionId){return this.workflow('pair',input,sessionId);}
 activate(input,sessionId){return this.workflow('activate',input,sessionId);}
 pairCode(input,sessionId){this.check(input,['operationId','botId','expectedSetupRevision']);this.context(input.botId);if(!this.pairing||this.pairing.operationId!==input.operationId||this.pairing.sessionId!==sessionId||this.pairing.expiresAt<=Date.now()||this.data.actions.find(a=>a.id===input.operationId)?.state!=='running')throw error('PAIRING_CODE_HANDOFF_UNAVAILABLE');return {code:this.pairing.code,expiresAt:this.pairing.expiresAt};}
 diagnostics(){this.guard();this.synchronize();return diagnosticsPreview({identity:this.identity,setup:this.data,business:this.business?.snapshot()});}
 exportDiagnostics(input){this.check(input,['operationId','previewSha256','expectedSetupRevision']);const result=this.diagnostics();if(result.sha256!==input.previewSha256)throw error('DIAGNOSTICS_PREVIEW_CHANGED');return exportDiagnostics(this.paths,input.operationId,result.preview);}
 snapshot(sessionId){
  this.guard();this.synchronize();let context,consentValid=false;try{const b=this.management.snapshot().bindings.find(x=>x.agentId===this.account?.data?.agentId);context=this.context(b?.botId);this.requireConsent(context.scope);consentValid=true;}catch{}
  // GET is also used by background auto-connect clients. Only a validated
  // explicit decision/workflow may own the future pairing handoff.
  this.advanceAutomaticSetup();
  const pairCodeAvailable=!!sessionId&&this.pairing?.sessionId===sessionId&&this.pairing.expiresAt>Date.now()&&this.data.actions.some(a=>a.id===this.pairing.operationId&&a.kind==='pair'&&a.state==='running');
  return {available:true,revision:this.data.revision,instanceId:this.identity.instanceId,dataDirectory:this.paths.dataDirectory,privacy:{version:SETUP_PRIVACY_VERSION,text:SETUP_PRIVACY_TEXT+'\n\n'+SETUP_DESKTOP_PRIVACY_TEXT,hash:SETUP_PRIVACY_HASH,confirmed:consentValid,desktopFeaturesConfirmed:consentValid&&desktopFeatureConsentValid(this.data.consent)},automatic:{enabled:consentValid&&desktopFeatureConsentValid(this.data.consent),error:this.automaticError,requiresModelTest:false},pairCodeAvailable,botId:context?.bot.id||null,model:context?.account.selected?.model||null,projects:this.data.projects.filter(p=>context&&JSON.stringify(p.owner)===JSON.stringify(context.scope)).map(({key,label,path,mode,tools})=>({key,name:label,path,mode,tools})),actions:this.data.actions.map(({id,kind,state,error,automatic})=>({id,kind,state,error,...(automatic?{automatic:true}:{})})),fresh:!existsSync(path.join(this.paths.businessDirectory,'active.json'))};
 }
 async close(){if(this.closed)return;this.closed=true;this.detachCompletion?.();this.pairing=null;this.automaticSessionId=null;this.journal.close();}
}
