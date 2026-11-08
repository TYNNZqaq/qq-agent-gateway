import path from 'node:path';
import { mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { record, internalId, expectedRevision, ManagementError } from '../core/management.mjs';
import { QQControlStore } from '../storage/qq-control-store.mjs';
import { createQQCredentialProtector } from './qq-credential-process.mjs';
import { createQQPlatformClient } from './qq-platform-client.mjs';

const err=(code,status=409)=>new ManagementError(code,status);
const pending=new Set(['intent','verifying','unknown']);
const live=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const initial=()=>({schemaVersion:1,salt:randomBytes(32).toString('hex'),lease:null,owner:null,credential:null,observation:null,actions:[]});
function directory(runtime){const full=path.resolve(runtime,'qq-connection');for(let p=full;;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw err('QQ_CONTROL_PATH_UNSAFE');if(p===path.dirname(p))break;}mkdirSync(full,{recursive:true});return realpathSync(full);}

export class QQConnectionController {
  constructor({runtimeDirectory,managementStore,accountControl,journal,protector=createQQCredentialProtector(),client=createQQPlatformClient(),now=()=>Date.now(),pidAlive=live}={}){
    this.management=managementStore;this.account=accountControl;this.protector=protector;this.client=client;this.now=now;
    this.journal=journal||new QQControlStore(path.join(directory(runtimeDirectory),'control.sqlite'),initial());this.data=this.journal.load();
    this.lease=randomUUID();this.closed=false;this.disabled=false;this.busy=false;this.active=null;
    if(this.data.lease&&pidAlive(this.data.lease.pid)){this.journal.close();throw err('QQ_CONTROL_IN_USE');}
    for(const action of this.data.actions)if(['intent','verifying'].includes(action.state)){action.state='unknown';action.reason='previous_controller_ended';}
    this.data.observation=null;this.data.lease={id:this.lease,pid:process.pid};this.save();
  }
  guard(){if(this.closed||this.disabled)throw err('QQ_CONTROL_UNAVAILABLE');try{this.journal.assertRevision(this.data.revision);if(this.data.lease?.id!==this.lease)throw err('QQ_CONTROL_STALE');}catch(e){this.disabled=true;throw e;}}
  save(){try{this.guard();this.data.revision=this.journal.commit(this.data,this.data.revision);}catch(e){this.disabled=true;throw e;}}
  owner(botId,active=true){
    this.guard();internalId(botId);const s=this.management.snapshot(),a=this.account?.snapshot(),bot=s.bots.find(b=>b.id===botId),binding=s.bindings.find(b=>b.botId===botId),agent=s.agents.find(x=>x.id===binding?.agentId);
    if(!bot||!binding||!agent||agent.toolId!=='codex'||!a?.available||a.agentId!==agent.id||!a.associationValid)throw err('QQ_CODEX_BINDING_REQUIRED');
    const registeredAppId=this.management.get('ui_bots',botId).app_id;
    if(this.data.credential&&registeredAppId&&registeredAppId!==this.data.credential.appId)throw err('QQ_APP_ID_METADATA_MISMATCH');
    if(active&&(bot.status!=='registered'||agent.status!=='registered'))throw err('QQ_CONFIGURATION_PAUSED');
    const owner={botId,agentId:agent.id,bindingId:binding.id,bindingVersion:binding.version,accountConnectionId:a.connectionId};
    if(this.data.owner&&JSON.stringify(this.data.owner)!==JSON.stringify(owner))throw err('QQ_CONNECTION_OWNER_CHANGED');
    return owner;
  }
  check(input,keys){record(input,keys);expectedRevision(input.expectedConnectionRevision);this.guard();}
  existing(input,kind,fingerprint){internalId(input.operationId);const old=this.data.actions.find(a=>a.id===input.operationId);if(old){if(old.kind!==kind||old.fingerprint!==fingerprint)throw err('QQ_OPERATION_CONFLICT');return old;}if(input.expectedConnectionRevision!==this.data.revision)throw err('QQ_STALE_REVISION');if(this.data.actions.length>=(kind==='verify'?56:64))throw err('QQ_ACTION_LIMIT');return null;}
  digest(value){return createHash('sha256').update(this.data.salt).update(JSON.stringify(value)).digest('hex');}
  action(input,kind,fingerprint){const a={id:input.operationId,kind,fingerprint,botId:input.botId,state:'intent',createdAt:this.now(),credentialVersion:this.data.credential?.version||0,networkStarted:false};this.data.actions.push(a);this.save();return a;}
  async exclusive(work){this.guard();if(this.busy||this.closing)throw err('QQ_CONTROL_BUSY');this.busy=true;const promise=Promise.resolve().then(work);this.inFlight=promise;try{return await promise;}finally{this.busy=false;if(this.inFlight===promise)this.inFlight=null;}}
  snapshot(){
    this.guard();const c=this.data.credential,latest=[...this.data.actions].reverse().find(a=>a.kind==='verify');let ownerValid=false;
    if(this.data.owner)try{this.owner(this.data.owner.botId);ownerValid=true;}catch{}
    const authenticated=!!this.data.observation&&ownerValid&&this.now()<this.data.observation.expiresAt,working=latest&&['intent','verifying'].includes(latest.state)&&this.active?.id===latest.id;
    return {available:true,revision:this.data.revision,botId:this.data.owner?.botId||null,agentId:this.data.owner?.agentId||null,ownerValid,credentialConfigured:!!c,appIdMasked:c?'•••• '+c.appId.slice(-4):null,environment:c?.environment||'sandbox',credentialVersion:c?.version||0,
      state:authenticated?'authenticated':working?'verifying':latest&&pending.has(latest.state)?'unknown':latest?.state==='authentication_failed'?'authentication_failed':c?'configured':'unconfigured',identityVerified:authenticated,platformAccountMasked:authenticated?'•••• '+this.data.observation.platformUserId.slice(-4):null,expiresAt:authenticated?this.data.observation.expiresAt:null,
      verification:latest?{operationId:latest.id,state:latest.state,reason:latest.reason||null,canCancel:!!working}:null,
      actions:this.data.actions.map(a=>({operationId:a.id,kind:a.kind,state:a.state,reason:a.reason||null})),eventTransportConnected:false,qqConnected:false,runtimeConnected:false,executionEnabled:false};
  }
  async credentials(input){
    this.check(input,['botId','operationId','appId','appSecret','environment','expectedConnectionRevision']);internalId(input.botId);
    if(typeof input.appId!=='string'||!/^\d{1,30}$/.test(input.appId)||/\s/.test(input.appId)||typeof input.appSecret!=='string'||!/^\S{16,256}$/.test(input.appSecret)||/\s/.test(input.appSecret)||/^sk-|^Bearer\s/i.test(input.appSecret)||!['sandbox','production'].includes(input.environment))throw err('QQ_CREDENTIAL_INPUT_INVALID',400);
    const fingerprint=this.digest([input.botId,input.appId,input.appSecret,input.environment]);if(this.existing(input,'credentials',fingerprint))return this.snapshot();
    return this.exclusive(async()=>{
      const owner=this.owner(input.botId),originalRevision=this.management.revision();
      const bot=this.management.get('ui_bots',input.botId);if(bot.app_id&&bot.app_id!==input.appId)throw err('QQ_APP_ID_METADATA_MISMATCH');
      if(this.data.credential&&this.data.credential.appId!==input.appId)throw err('QQ_PLATFORM_APP_ID_CHANGE_REQUIRES_REBIND');
      const action=this.action(input,'credentials',fingerprint);
      try{
        const plaintext=JSON.stringify({owner,appId:input.appId,appSecret:input.appSecret}),encrypted=await this.protector.seal(plaintext);
        this.guard();this.owner(input.botId);if(this.management.revision()!==originalRevision)throw err('QQ_CONFIGURATION_CHANGED');
        if(typeof encrypted!=='string'||!encrypted.length||encrypted.length>32768||encrypted.includes(input.appSecret))throw err('QQ_CREDENTIAL_PROTECTION_FAILED');
        this.data.owner=owner;this.data.credential={appId:input.appId,environment:input.environment,version:(this.data.credential?.version||0)+1,reference:randomUUID(),encrypted,pinnedPlatformUserId:this.data.credential?.pinnedPlatformUserId||null};this.data.observation=null;action.state='saved';this.save();
      }catch(e){if(!this.disabled){action.state='failed';action.reason='credential_save_not_confirmed';this.save();}throw e instanceof ManagementError?e:err('QQ_CREDENTIAL_PROTECTION_FAILED');}
      return this.snapshot();
    });
  }
  async verify(input){
    this.check(input,['botId','operationId','expectedConnectionRevision']);const fingerprint=this.digest([input.botId,this.data.credential?.version||0]);if(this.existing(input,'verify',fingerprint))return this.snapshot();
    return this.exclusive(async()=>{
      this.owner(input.botId);const credential=this.data.credential;if(!credential)throw err('QQ_CREDENTIAL_REQUIRED');
      if(this.data.actions.some(a=>a.kind==='verify'&&a.credentialVersion===credential.version&&pending.has(a.state)))throw err('QQ_VERIFICATION_UNKNOWN');
      const action=this.action(input,'verify',fingerprint),abort=new AbortController(),owner=JSON.stringify(this.data.owner),configurationRevision=this.management.revision();this.active={id:action.id,abort};this.data.observation=null;
      const guard=()=>{this.guard();this.owner(input.botId);if(configurationRevision!==this.management.revision()||owner!==JSON.stringify(this.data.owner)||credential.version!==this.data.credential?.version)throw err('QQ_CONFIGURATION_CHANGED');};
      try{
        const raw=await this.protector.open(credential.encrypted);guard();let secret;try{secret=JSON.parse(raw);}catch{throw err('QQ_CREDENTIAL_PROTECTION_FAILED');}
        if(JSON.stringify(secret.owner)!==owner||secret.appId!==credential.appId||typeof secret.appSecret!=='string')throw err('QQ_CREDENTIAL_OWNER_MISMATCH');
        if(abort.signal.aborted){action.state='canceled_before_request';this.save();return this.snapshot();}
        action.state='verifying';action.networkStarted=true;this.save();
        const result=await this.client.verifyIdentity({appId:secret.appId,clientSecret:secret.appSecret,environment:credential.environment,signal:abort.signal,guard});guard();
        if(abort.signal.aborted)throw err('QQ_PLATFORM_OUTCOME_UNKNOWN');
        if(typeof result?.platformUserId!=='string'||!result.platformUserId.length||result.platformUserId.length>128||/[\x00-\x20\x7f]/.test(result.platformUserId)||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=this.now()||result.trustBasis!=='official_app_credentials_and_authenticated_bot_profile')throw err('QQ_PLATFORM_IDENTITY_INVALID');
        if(credential.pinnedPlatformUserId&&credential.pinnedPlatformUserId!==result.platformUserId)throw err('QQ_PLATFORM_IDENTITY_CHANGED');
        credential.pinnedPlatformUserId=result.platformUserId;this.data.observation={platformUserId:result.platformUserId,expiresAt:result.expiresAt,trustBasis:result.trustBasis,operationId:action.id};action.state='authenticated';this.save();
      }catch(e){if(!this.disabled){action.state=action.networkStarted?(e?.code==='QQ_PLATFORM_AUTHENTICATION_FAILED'?'authentication_failed':'unknown'):'failed';action.reason=action.networkStarted?'platform_outcome_not_authenticated':'local_preparation_failed';this.data.observation=null;this.save();}if(!this.disabled)return this.snapshot();throw e instanceof ManagementError?e:err('QQ_PLATFORM_OUTCOME_UNKNOWN');}
      finally{if(this.active?.id===action.id)this.active=null;}
      return this.snapshot();
    });
  }
  cancel(input){
    this.check(input,['botId','operationId','verificationOperationId','expectedConnectionRevision']);internalId(input.verificationOperationId);const fingerprint=this.digest([input.botId,input.verificationOperationId]);if(this.existing(input,'cancel',fingerprint))return this.snapshot();
    this.owner(input.botId,false);const original=this.data.actions.find(a=>a.id===input.verificationOperationId&&a.kind==='verify'&&a.botId===input.botId);
    if(!original||this.active?.id!==original.id)throw err('QQ_EXACT_VERIFICATION_UNAVAILABLE');
    const action=this.action(input,'cancel',fingerprint);this.active.abort.abort();action.state='local_abort_requested';action.reason='not_a_platform_cancellation_confirmation';this.save();return this.snapshot();
  }
  disconnect(input){
    this.check(input,['botId','operationId','expectedConnectionRevision']);const fingerprint=this.digest([input.botId]);if(this.existing(input,'disconnect',fingerprint))return this.snapshot();this.owner(input.botId,false);
    if(this.busy)throw err('QQ_CANCEL_ACTIVE_VERIFICATION_FIRST');const action=this.action(input,'disconnect',fingerprint);this.data.observation=null;action.state='local_observation_cleared';this.save();return this.snapshot();
  }
  async close(){if(this.closed)return;this.closing=true;this.active?.abort.abort();try{try{await this.inFlight;}catch{}if(!this.disabled){this.guard();const released={...this.data,lease:null,observation:null};released.revision=this.journal.commit(released,this.data.revision);this.data=released;}}finally{this.closed=true;this.journal.close();}}
}
