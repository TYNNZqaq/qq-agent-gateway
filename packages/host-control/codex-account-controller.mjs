import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AccountControlStore } from '../storage/account-control-store.mjs';
import { record, internalId, expectedRevision } from '../core/management.mjs';
import { accountError, safeModel, safeReference, loginHandoff } from './codex-account-policy.mjs';
import { accountDirectories, openAccountProcess } from './codex-account-process.mjs';

const unfinished=new Set(['intent','awaiting','unknown']);
const plans=new Set(['free','go','plus','pro','prolite','promax','team','business','enterprise','edu','unknown','self_serve_business_prolite','self_serve_business_usage_based','ent26','enterprise_cbp_automation','enterprise_cbp_usage_based','edu_plus','edu_pro','sci','sci_plus']);
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return true;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const initial=()=>({schemaVersion:1,connectionId:randomUUID(),agentId:null,lease:null,process:null,selected:null,actions:[]});

export class CodexAccountController {
  constructor({runtimeDirectory,managementStore,journal,openProcess=openAccountProcess,pidAlive=alive,now=()=>Date.now()}={}) {
    this.management=managementStore;this.openProcess=openProcess;this.now=now;this.runtimeDirectory=runtimeDirectory;
    const dirs=journal?null:accountDirectories(runtimeDirectory);
    this.journal=journal||new AccountControlStore(path.join(dirs.root,'control.sqlite'),initial());
    this.data=this.journal.load();this.leaseId=randomUUID();this.transport=null;this.auth={status:'not_checked',plan:null};this.models=[];this.epoch=null;this.identity=null;this.handoff=null;this.early=[];this.busy=false;this.closed=false;this.disabled=false;
    if(this.data.lease&&pidAlive(this.data.lease.pid)||this.data.process?.state!=='closed'&&this.data.process?.pid&&pidAlive(this.data.process.pid)){this.journal.close();throw accountError('ACCOUNT_CONTROL_IN_USE');}
    if(this.data.process&&this.data.process.state!=='closed'&&!this.data.process.pid){this.journal.close();throw accountError('ACCOUNT_PREVIOUS_PROCESS_UNKNOWN');}
    for(const action of this.data.actions)if(['intent','awaiting'].includes(action.state)){action.state='unknown';action.reason='previous_controller_ended';}
    if(this.data.process)this.data.process.state='closed';
    this.data.lease={id:this.leaseId,pid:process.pid};this.save();
  }
  guard() {
    if(this.closed||this.disabled)throw accountError('ACCOUNT_CONTROL_UNAVAILABLE');
    try{this.journal.assertRevision(this.data.revision);if(this.data.lease?.id!==this.leaseId)throw accountError('ACCOUNT_CONTROL_STALE');}catch(error){this.disabled=true;throw error;}
  }
  save(){try{this.guard();this.data.revision=this.journal.commit(this.data,this.data.revision);}catch(error){this.disabled=true;throw error;}}
  check(input,keys) {record(input,keys);expectedRevision(input.expectedAccountRevision);this.guard();}
  current(input){if(input.expectedAccountRevision!==this.data.revision)throw accountError('ACCOUNT_STALE_REVISION');}
  owner(active=true) {
    const agent=this.management.snapshot().agents.find(a=>a.id===this.data.agentId);
    if(!agent||agent.toolId!=='codex')throw accountError('ACCOUNT_AGENT_REQUIRED');
    if(active&&agent.status!=='registered')throw accountError('ACCOUNT_AGENT_PAUSED');
    return agent;
  }
  invalidate(status='not_checked'){this.auth={status,plan:null};this.models=[];this.epoch=null;this.identity=null;this.handoff=null;}
  snapshot() {
    this.guard();const login=[...this.data.actions].reverse().find(a=>a.kind==='login');
    const expired=login?.state==='awaiting'&&this.now()-login.createdAt>600000;
    const agent=this.management.snapshot().agents.find(a=>a.id===this.data.agentId&&a.toolId==='codex');
    return {available:true,revision:this.data.revision,connectionId:this.data.connectionId,agentId:this.data.agentId,associationValid:!!agent,
      transport:this.data.process?.state==='ready'?'ready':this.data.process?.state||'not_started',account:{...this.auth,label:this.auth.status==='authenticated'?'ChatGPT 用户账号':null},
      login:login?{operationId:login.id,method:login.type,state:expired?'unknown':login.state,reason:expired?'login_wait_expired':login.reason||null,
        canCancel:!!login.loginId&&unfinished.has(login.state)&&!login.cancellationId&&login.processId===this.data.process?.id&&this.data.process?.state==='ready',
        handoffAvailable:!!this.handoff&&this.handoff.operationId===login.id&&!expired}:null,
      actions:this.data.actions.map(a=>({operationId:a.id,kind:a.kind,state:a.state,reason:a.reason||null})),
      models:this.models.map(m=>({...m})),selectedModel:this.data.selected?.model||null,
      selectionStatus:!this.data.selected?'needs_selection':this.epoch&&this.data.selected.accountEpoch===this.epoch?'selected_unverified':'needs_reconfirmation',
      modelAccessVerified:false,runtimeConnected:false,qqConnected:false,executionEnabled:false};
  }
  async exclusive(work){this.guard();if(this.closing)throw accountError('ACCOUNT_CONTROL_UNAVAILABLE');if(this.busy)throw accountError('ACCOUNT_CONTROL_BUSY');this.busy=true;
    const pending=Promise.resolve().then(work);this.inFlight=pending;try{return await pending;}finally{this.busy=false;if(this.inFlight===pending)this.inFlight=null;}}
  associate(input){
    this.check(input,['agentId','expectedAccountRevision']);this.current(input);internalId(input.agentId);
    if(this.busy)throw accountError('ACCOUNT_CONTROL_BUSY');
    const agent=this.management.snapshot().agents.find(a=>a.id===input.agentId&&a.toolId==='codex'&&a.status==='registered');
    if(!agent)throw accountError('ACCOUNT_AGENT_REQUIRED');
    if(this.data.agentId&&this.data.agentId!==input.agentId)throw accountError('ACCOUNT_ALREADY_ASSOCIATED');
    if(this.data.agentId!==input.agentId){this.data.agentId=input.agentId;this.save();}
    return this.snapshot();
  }
  existing(input,kind,details={}) {
    internalId(input.operationId);
    const fingerprint=JSON.stringify({kind,agentId:this.data.agentId,...details});
    const old=this.data.actions.find(a=>a.id===input.operationId);
    if(old){if(old.fingerprint!==fingerprint)throw accountError('ACCOUNT_OPERATION_CONFLICT');return old;}
    this.current(input);if(this.data.actions.length>=(kind==='login'?56:64))throw accountError('ACCOUNT_ACTION_LIMIT');return null;
  }
  action(input,kind,details={}) {
    this.guard();this.owner(kind!=='cancel'&&kind!=='logout'&&kind!=='close');
    const action={id:input.operationId,kind,agentId:this.data.agentId,fingerprint:JSON.stringify({kind,agentId:this.data.agentId,...details}),state:'intent',processId:this.data.process?.id||null,createdAt:this.now(),...details};
    this.data.actions.push(action);this.save();return action;
  }
  async ensureProcess() {
    this.guard();if(this.transport)return this.transport;
    const generation=randomUUID();this.data.process={id:generation,state:'starting',pid:null};this.save();
    const guard=()=>{this.guard();if(this.data.process?.id!==generation||this.data.process.state==='closed')throw accountError('ACCOUNT_PROCESS_STALE');};
    try{
      const transport=await this.openProcess({runtimeDirectory:this.runtimeDirectory,guard,
        onSpawn:pid=>{guard();if(!Number.isSafeInteger(pid)||pid<=0)throw accountError('ACCOUNT_PROCESS_UNVERIFIED');this.data.process.pid=pid;this.save();},
        onNotification:(method,params)=>this.notification(generation,method,params),
        onClose:()=>{if(this.closed||this.disabled||this.data.process?.id!==generation)return;this.transport=null;this.data.process.state='closed';
          for(const action of this.data.actions)if(action.processId===generation&&unfinished.has(action.state)){action.state='unknown';action.reason||='process_exit';}
          this.invalidate('unknown');this.save();}});
      guard();this.transport=transport;this.data.process.state='ready';this.save();return transport;
    }catch(error){if(!this.disabled){this.data.process.state='closed';this.invalidate('unknown');this.save();}throw error;}
  }
  notification(generation,method,params) {
    this.guard();if(this.data.process?.id!==generation)return;
    if(method==='account/updated'){
      this.invalidate(params?.authMode===null?'not_authenticated':params?.authMode==='chatgpt'?'not_checked':'forbidden');return;
    }
    if(method!=='account/login/completed'||!safeReference(params?.loginId)||typeof params.success!=='boolean')return;
    const action=this.data.actions.find(a=>a.kind==='login'&&a.processId===generation&&a.loginId===params.loginId);
    if(!action){if(this.early.length<8)this.early.push({generation,loginId:params.loginId,success:params.success});return;}
    if(!unfinished.has(action.state))return;
    action.state=params.success?'completed':'failed';action.reason=params.success?'awaiting_account_status':'official_login_failed';
    this.handoff=null;this.save();
  }
  async readAccount(transport) {
    const result=await transport.request('account/read',{refreshToken:false});this.guard();
    if(result?.requiresOpenaiAuth!==true||result.account!==null&&result.account?.type!=='chatgpt'){this.invalidate('forbidden');return;}
    if(result.account===null){this.auth={status:'not_authenticated',plan:null};this.models=[];this.epoch=null;this.identity=null;
      for(const action of this.data.actions)if(action.kind==='logout'&&action.state==='unknown'&&action.processId!==this.data.process?.id){action.state='closed_unknown';action.reason='original_process_ended_and_signed_out_observed';this.save();}
      return;}
    const account=result.account;
    const identity=createHash('sha256').update(JSON.stringify([account.email??null,account.workspaceRouting?.chatgptAccountId??null])).digest('hex');
    if(identity!==this.identity||!this.epoch){this.epoch=randomUUID();this.models=[];}
    this.identity=identity;this.auth={status:'authenticated',plan:plans.has(account.planType)?account.planType:'unknown'};
  }
  async refresh(input) {
    this.check(input,['expectedAccountRevision']);this.current(input);
    return this.exclusive(async()=>{
      try{const transport=await this.ensureProcess();await this.readAccount(transport);
        this.models=[];if(this.auth.status==='authenticated'){
          const models=[],seen=new Set();let cursor=null;
          for(let page=0;page<4;page++){
            const result=await transport.request('model/list',{includeHidden:false,limit:100,cursor});this.guard();
            if(!Array.isArray(result?.data)||result.data.length>100)throw accountError('ACCOUNT_CATALOG_INVALID');
            for(const m of result.data){if(m.hidden)continue;if(!safeModel(m.id)||!safeModel(m.model)||seen.has(m.model)||models.length>=128)throw accountError('ACCOUNT_CATALOG_INVALID');seen.add(m.model);models.push({id:m.id,model:m.model,displayName:typeof m.displayName==='string'?m.displayName.slice(0,100):m.model});}
            if(!result.nextCursor){this.models=models;break;}if(typeof result.nextCursor!=='string'||result.nextCursor===cursor||page===3)throw accountError('ACCOUNT_CATALOG_INCOMPLETE');cursor=result.nextCursor;
          }
        }
        return this.snapshot();
      }catch(error){this.invalidate('unknown');throw error;}
    });
  }
  async login(input,sessionId) {
    this.check(input,['operationId','type','expectedAccountRevision']);
    if(!['chatgpt','chatgptDeviceCode'].includes(input.type))throw accountError('ACCOUNT_AUTH_MODE_FORBIDDEN',400);
    if(this.existing(input,'login',{type:input.type}))return this.snapshot();
    return this.exclusive(async()=>{
      this.owner();if(this.data.actions.some(a=>['login','logout'].includes(a.kind)&&unfinished.has(a.state)))throw accountError('ACCOUNT_LOGIN_PENDING_OR_UNKNOWN');
      const transport=await this.ensureProcess();await this.readAccount(transport);this.owner();
      if(this.auth.status!=='not_authenticated')throw accountError(this.auth.status==='authenticated'?'ACCOUNT_ALREADY_AUTHENTICATED':'ACCOUNT_AUTH_MODE_FORBIDDEN');
      const action=this.action(input,'login',{type:input.type});
      try{
        const result=await transport.request('account/login/start',{type:input.type});this.guard();
        const handoff=loginHandoff(result,input.type);
        if(this.data.process?.id!==action.processId||this.data.process.state!=='ready')throw accountError('ACCOUNT_PROCESS_STALE');
        action.loginId=handoff.loginId;action.state='awaiting';this.save();
        this.handoff={operationId:action.id,sessionId,...handoff};
        for(const event of this.early.splice(0))this.notification(event.generation,'account/login/completed',event);
      }catch(error){if(!this.disabled){action.state='unknown';action.reason=error.code==='ACCOUNT_RPC_REJECTED'?'official_rejected_outcome_unverified':'login_outcome_unknown';this.handoff=null;this.save();}throw error;}
      return this.snapshot();
    });
  }
  reveal(input,sessionId) {
    this.check(input,['operationId','expectedAccountRevision']);internalId(input.operationId);this.current(input);
    const login=this.data.actions.find(a=>a.id===input.operationId&&a.kind==='login');
    if(!login||login.state!=='awaiting'||this.now()-login.createdAt>600000||this.handoff?.operationId!==login.id||this.handoff.sessionId!==sessionId)throw accountError('ACCOUNT_HANDOFF_UNAVAILABLE');
    return {url:this.handoff.url,...(this.handoff.userCode?{userCode:this.handoff.userCode}:{}),operationId:login.id};
  }
  async cancel(input) {
    this.check(input,['operationId','loginOperationId','expectedAccountRevision']);internalId(input.loginOperationId);
    if(this.existing(input,'cancel',{loginOperationId:input.loginOperationId}))return this.snapshot();
    return this.exclusive(async()=>{
      this.owner(false);const login=this.data.actions.find(a=>a.id===input.loginOperationId&&a.kind==='login');
      if(!login||!unfinished.has(login.state)||!login.loginId||login.cancellationId||!this.transport||login.processId!==this.data.process?.id)throw accountError('ACCOUNT_EXACT_LOGIN_UNAVAILABLE');
      const action=this.action(input,'cancel',{loginOperationId:login.id});login.cancellationId=action.id;this.save();this.handoff=null;
      try{const result=await this.transport.request('account/login/cancel',{loginId:login.loginId});this.guard();
        if(!['canceled','notFound'].includes(result?.status))throw accountError('ACCOUNT_CANCEL_RESPONSE_INVALID');
        action.state=result.status==='canceled'?'canceled':'unknown';action.reason=result.status==='notFound'?'original_login_not_found':null;
        if(result.status==='canceled'&&login.state!=='completed'){login.state='canceled';login.reason=null;}
        else if(unfinished.has(login.state)){login.state='unknown';login.reason=action.reason;}
        this.save();
      }catch(error){if(!this.disabled){action.state='unknown';action.reason='cancel_outcome_unknown';if(unfinished.has(login.state))login.state='unknown';this.save();}throw error;}
      return this.snapshot();
    });
  }
  select(input) {
    this.check(input,['model','expectedAccountRevision']);this.current(input);this.owner();if(this.busy)throw accountError('ACCOUNT_CONTROL_BUSY');
    if(this.auth.status!=='authenticated'||!this.epoch||!this.models.some(m=>m.model===input.model))throw accountError('ACCOUNT_EXPLICIT_MODEL_REQUIRED');
    this.data.selected={model:input.model,accountEpoch:this.epoch};this.save();return this.snapshot();
  }
  async logout(input) {
    this.check(input,['operationId','expectedAccountRevision']);if(this.existing(input,'logout'))return this.snapshot();
    return this.exclusive(async()=>{
      this.owner(false);
      if(this.data.actions.some(a=>a.kind==='logout'&&unfinished.has(a.state)))throw accountError('ACCOUNT_LOGOUT_UNKNOWN');
      if(this.data.actions.some(a=>a.kind==='login'&&unfinished.has(a.state)&&a.processId===this.data.process?.id&&this.data.process?.state==='ready'))throw accountError('ACCOUNT_CANCEL_OR_CLOSE_FIRST');
      const transport=await this.ensureProcess(),action=this.action(input,'logout');
      try{const result=await transport.request('account/logout');this.guard();if(!result||Object.keys(result).length)throw accountError('ACCOUNT_LOGOUT_RESPONSE_INVALID');
        action.state='completed';for(const old of this.data.actions)if(old.kind==='login'&&unfinished.has(old.state)&&old.processId!==action.processId){old.state='closed_unknown';old.reason='original_process_ended_then_explicit_plugin_logout';}
        this.data.selected=null;this.invalidate('not_checked');this.save();await this.readAccount(transport);
      }catch(error){if(!this.disabled){action.state='unknown';action.reason='logout_outcome_unknown';this.invalidate('unknown');this.save();}throw error;}
      return this.snapshot();
    });
  }
  async disconnect(input) {
    this.check(input,['operationId','expectedAccountRevision']);if(this.existing(input,'close'))return this.snapshot();
    return this.exclusive(async()=>{const action=this.action(input,'close'),transport=this.transport;if(transport)await transport.close();this.guard();
      action.state='completed';if(this.data.process)this.data.process.state='closed';this.transport=null;this.invalidate('not_checked');this.save();return this.snapshot();});
  }
  async close() {
    if(this.closed)return;
    this.closing=true;
    try{
      try{await this.inFlight;}catch{}
      if(this.transport)await this.transport.close();
      if(!this.disabled){this.guard();const released={...this.data,lease:null,process:this.data.process?{...this.data.process,state:'closed'}:null};released.revision=this.journal.commit(released,this.data.revision);this.data=released;}
    }finally{this.closed=true;this.handoff=null;this.journal.close();}
  }
}
