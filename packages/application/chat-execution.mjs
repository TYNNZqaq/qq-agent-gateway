import {randomUUID} from 'node:crypto';
import {AppServerRPC,taskPermissionConfig} from './app-server-rpc.mjs';
import {instructionIntake} from './instruction-intake.mjs';
import {evaluateChatEvents} from './chat-runner.mjs';
import {PROJECT_ROOT} from './config.mjs';

export function createChatExecution(config,store,{rpcFactory=c=>new AppServerRPC(c)}={}){
  return async({prompt,schema,model,reasoning,signal,turn})=>{
    config.runtimeGuard?.();
    if(turn.owner_key!==store.get('owner'))throw Error('CHAT_OWNER_CHANGED');
    const key='chatDispatch:'+turn.id+':'+(turn.recompute_count||0);
    if(store.get(key))return {status:'unknown',error:'CHAT_PRIOR_ATTEMPT_REQUIRES_REVIEW'};
    const scope={owner:turn.owner_key,instanceId:config.instanceId,binding:config.binding,localTurnId:turn.id};
    store.set(key,{...scope,state:'intent',threadId:null,turnId:null});
    const rpc=rpcFactory({...config,executionCwd:config.chatWorkspace},turn),profile=rpc.permissionProfile||'qq-project-'+randomUUID();
    const policy=taskPermissionConfig(config.chatWorkspace,{profile,controlRoots:[PROJECT_ROOT,config.runtimeRoot||config.stateDir,config.accountHome]});
    const instructions=instructionIntake({project:config.chatWorkspace,accountHome:config.accountHome});
    let threadId=null,turnId=null,sent=false,finished=false,frames=[],cancelTimer,deadline;
    const events=[];let resolveResult;
    const result=new Promise(resolve=>resolveResult=resolve);
    const guard=()=>{config.runtimeGuard?.();if(store.get('owner')!==scope.owner)throw Error('CHAT_OWNER_CHANGED');};
    const finish=value=>{if(!finished){finished=true;resolveResult(value);}};
    const apply=frame=>{
      guard();const p=frame.params||{},id=p.turnId||p.turn?.id;
      if(p.threadId!==threadId||id&&id!==turnId)return;
      if(frame.method==='item/completed'&&p.item?.type==='agentMessage'&&[null,undefined,'final','final_answer'].includes(p.item.phase)){
        if(typeof p.item.text!=='string'||p.item.text.length>30000){finish({status:'failed',error:'CHAT_REPLY_LIMIT'});return;}
        events.push({type:'item.completed',item:{type:'agent_message',text:p.item.text}});
      }
      if(frame.method==='turn/completed'&&p.turn?.id===turnId){
        if(p.turn.status==='completed'){events.push({type:'turn.completed'});finish(evaluateChatEvents(events,0));}
        else finish({status:p.turn.status==='interrupted'?'cancelled':'failed',error:'CHAT_TURN_'+String(p.turn.status).toUpperCase()});
      }
    };
    const cancel=()=>{
      if(finished||cancelTimer)return;
      if(!sent){finish({status:'cancelled'});return;}
      if(threadId&&turnId)void rpc.call('turn/interrupt',{threadId,turnId},{timeoutMs:3000}).catch(()=>{});
      cancelTimer=setTimeout(()=>finish({status:'unknown',error:'CHAT_CANCEL_CONFIRMATION_UNKNOWN'}),5000);
    };
    rpc.on('request',request=>rpc.reject(request.id));
    rpc.on('closed',()=>finish({status:sent?'unknown':'failed',error:'CHAT_CONNECTION_ENDED'}));
    rpc.on('notification',frame=>{
      if(frame.params?.threadId!==threadId)return;
      if(!turnId){if(!sent)return;if(frames.length>=128||Buffer.byteLength(JSON.stringify(frames))>256000){finish({status:'unknown',error:'CHAT_INGRESS_LIMIT'});return;}
        frames.push(frame);store.set('chatIngress:'+turn.id,{...scope,state:'awaiting_exact_turn',frames});return;}
      apply(frame);
    });
    try{
      await rpc.start();guard();
      const auth=await rpc.call('account/read',{refreshToken:false});guard();if(auth.account?.type!=='chatgpt')throw Error('CHAT_ACCOUNT_NOT_AUTHENTICATED');
      if(signal?.aborted)return {status:'cancelled'};
      const opened=await rpc.call('thread/start',{cwd:config.chatWorkspace,config:policy,permissions:profile,model,ephemeral:true,approvalPolicy:'on-request',approvalsReviewer:'user',developerInstructions:instructions.text});guard();
      if(typeof opened.thread?.id!=='string'||opened.cwd!==config.chatWorkspace||opened.activePermissionProfile?.id!==profile||opened.sandbox?.type!=='readOnly'||opened.sandbox.networkAccess!==false)throw Error('CHAT_PERMISSION_REJECTED');
      threadId=opened.thread.id;
      store.set(key,{...scope,state:'opened',threadId,turnId:null,instructionHash:instructions.fingerprint});
      signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)return {status:'cancelled'};
      store.set(key,{...scope,state:'dispatching',threadId,turnId:null});sent=true;
      const started=await rpc.call('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}],model,effort:reasoning,permissions:profile,outputSchema:schema},{mutation:true});guard();
      if(typeof started.turn?.id!=='string'||!started.turn.id)throw Error('CHAT_TURN_REFERENCE_REQUIRED');turnId=started.turn.id;
      store.set(key,{...scope,state:'submitted',threadId,turnId});
      store.set('chatIngress:'+turn.id,{...scope,state:'bound_to_exact_turn',threadId,turnId,frames});
      for(const frame of frames)apply(frame);frames=[];
      deadline=setTimeout(cancel,config.executor.timeoutMs);
      if(signal?.aborted)cancel();
      const output=await result;guard();
      store.set(key,{...scope,state:['succeeded','failed','cancelled'].includes(output.status)?'finished':'unknown',threadId,turnId,outcome:output.status});return {...output,threadId};
    }catch(error){
      store.set(key,{...scope,state:sent?'unknown':'failed',threadId,turnId,error:/^[A-Z_]+$/.test(error.message)?error.message:'CHAT_TRANSPORT_ERROR'});
      return {status:sent?'unknown':'failed',error:'CHAT_TRANSPORT_UNCONFIRMED'};
    }finally{clearTimeout(cancelTimer);clearTimeout(deadline);signal?.removeEventListener('abort',cancel);await rpc.close();}
  };
}
