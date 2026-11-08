import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ClientQuestionGateway} from './client-question-gateway.mjs';
import {openClientQuestionContext} from './client-question-context.mjs';

export const QUESTION_MCP_INSTRUCTIONS='For ordinary clarifications in the paired QQ workflow, use ask_qq_question and read_qq_answer, then ack_qq_answer after receiving the result. This returns the human QQ answer to this original client through MCP tool results. Generate request_key and reply_key UUIDs once and reuse both on retries; never send reply_key to QQ. Respect explicit requests for no real tests: initialization, status and offline tests are allowed, but do not create a test question. These tools grant no execution or approval authority and cannot answer a native Q form or an application permission card. Keep original approval flows. Source titles/thread IDs are client supplied, not verified native control identities. Pending is not delivery or an answer. Poll at most 25 seconds per call; keep useful work moving between polls. If the bot is offline, report it and preserve the pending identity instead of creating repeated requests.';
const string={type:'string'},uuid={type:'string',format:'uuid'},handle={request_key:uuid,reply_key:uuid};
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const option=schema({label:string,description:string},['label']);
const question=schema({id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,64}$'},question:{type:'string',minLength:1,maxLength:8000},options:{type:'array',maxItems:12,items:{anyOf:[string,option]}},allow_freeform:{type:'boolean'}},['id','question']);
export const QUESTION_MCP_TOOLS=[
 {name:'question_bridge_status',description:'Read the local QQ ordinary-question bridge status without creating a question or sending a message.',inputSchema:schema({}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'ask_qq_question',description:'Send an ordinary clarification (1–3 questions with complete choices) to the original paired QQ owner. Returns a durable B reference; this call sends a real QQ notice. Never use for approval, secret input or a no-real-test probe. Reuse both UUIDs on retry.',inputSchema:schema({...handle,source:schema({title:{type:'string',maxLength:100},thread_id:uuid},['title']),questions:{type:'array',minItems:1,maxItems:3,items:question}}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
 {name:'read_qq_answer',description:'Read the exact question identified by request_key plus private reply_key. Optionally wait up to 25 seconds. Returns ordinary human answers as an original-client tool result; never implies native form completion or approval.',inputSchema:schema({...handle,wait_ms:{type:'integer',minimum:0,maximum:25000}},['request_key','reply_key']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'ack_qq_answer',description:'After actually receiving an answered tool result, acknowledge that exact answer_hash. Sends one QQ receipt. Does not grant permissions or resolve native Q cards.',inputSchema:schema({...handle,answer_hash:{type:'string',pattern:'^[a-f0-9]{64}$'}}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
 {name:'cancel_qq_question',description:'Cancel this caller’s still-pending ordinary B question and its unsent notice. Keeps history and answers already supplied.',inputSchema:schema(handle),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
const code=error=>/^[A-Z][A-Z0-9_]{0,100}$/.test(error?.message||'')?error.message:'CLIENT_QUESTION_TOOL_FAILED';
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
export function createQuestionMcp({openContext,write,now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 let initialized=false;const running=new Map();
 const respond=(id,value)=>write({jsonrpc:'2.0',id,...value});
 async function tool(name,args,signal){
  const declared=QUESTION_MCP_TOOLS.find(t=>t.name===name);if(!declared)throw Error('CLIENT_QUESTION_TOOL_UNKNOWN');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(declared.inputSchema.properties,k))||declared.inputSchema.required.some(k=>!Object.hasOwn(args,k)))throw Error('CLIENT_QUESTION_ARGUMENTS_INVALID');
  if(args.wait_ms!==undefined&&(!Number.isInteger(args.wait_ms)||args.wait_ms<0||args.wait_ms>25000))throw Error('CLIENT_QUESTION_WAIT_INVALID');
  const context=openContext();
  try{
   if(name==='question_bridge_status')return context.status();
   const gateway=new ClientQuestionGateway(context.store,context.config,{guard:context.guard,now});
   if(name==='ask_qq_question')return gateway.ask(args);
   if(name==='ack_qq_answer')return gateway.acknowledge(args);
   if(name==='cancel_qq_question')return gateway.cancel(args);
   const deadline=now()+(args.wait_ms||0);
   for(;;){
    if(signal.aborted)throw Error('CLIENT_QUESTION_CALL_CANCELLED');
    const answer=gateway.read(args);
    if(answer.status!=='pending'||now()>=deadline)return answer;
    await sleep(Math.min(250,Math.max(0,deadline-now())));
   }
  }finally{context.close();}
 }
 async function receive(message){
  const hasId=Object.hasOwn(message||{},'id'),id=message?.id;
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string'||hasId&&!(typeof id==='string'&&id.length<=160||Number.isSafeInteger(id))){if(hasId)await respond(null,{error:{code:-32600,message:'Invalid request'}});return;}
  if(!hasId){
   if(message.method==='notifications/cancelled')running.get(message.params?.requestId)?.abort();
   return;
  }
  if(running.has(id)){await respond(id,{error:{code:-32600,message:'Duplicate active request ID'}});return;}
  if(message.method==='initialize'){
   if(initialized){await respond(id,{error:{code:-32600,message:'Already initialized'}});return;}
   initialized=true;const version=message.params?.protocolVersion;
   await respond(id,{result:{protocolVersion:['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(version)?version:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'qq-agent-client-questions',version:'1.0.0'},instructions:QUESTION_MCP_INSTRUCTIONS}});return;
  }
  if(!initialized){await respond(id,{error:{code:-32002,message:'Not initialized'}});return;}
  if(message.method==='ping'){await respond(id,{result:{}});return;}
  if(message.method==='tools/list'){await respond(id,{result:{tools:QUESTION_MCP_TOOLS}});return;}
  if(message.method!=='tools/call'){await respond(id,{error:{code:-32601,message:'Method not found'}});return;}
  if(running.size>=4){await respond(id,{error:{code:-32000,message:'Too many active tool calls'}});return;}
  const controller=new AbortController();running.set(id,controller);
  try{const value=await tool(message.params?.name,message.params?.arguments||{},controller.signal);await respond(id,{result:result(value)});}
  catch(error){await respond(id,{result:{...result({error:code(error),authorization_effect:'none'}),isError:true}});}
  finally{running.delete(id);}
 }
 return {receive,close(){for(const controller of running.values())controller.abort();},get activeCalls(){return running.size;}};
}
export async function serveQuestionMcp(settingsFile,{input=process.stdin,output=process.stdout,openContext=()=>openClientQuestionContext(settingsFile)}={}){
 let buffer='',writing=Promise.resolve();const pending=new Set();
 const write=frame=>{writing=writing.then(()=>new Promise((resolve,reject)=>output.write(JSON.stringify(frame)+'\n',error=>error?reject(error):resolve())));return writing;};
 const server=createQuestionMcp({openContext,write});
 try{
  input.setEncoding('utf8');
  for await(const chunk of input){
   buffer+=chunk;
   if(Buffer.byteLength(buffer)>256*1024)throw Error('CLIENT_QUESTION_FRAME_TOO_LARGE');
   let end;
   while((end=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
    if(Buffer.byteLength(line)>65536)throw Error('CLIENT_QUESTION_FRAME_TOO_LARGE');
    let frame;try{frame=JSON.parse(line);}catch{await write({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue;}
    const task=server.receive(frame).finally(()=>pending.delete(task));pending.add(task);
    if(pending.size>=12)await Promise.race(pending);
   }
  }
 }finally{server.close();await Promise.allSettled(pending);await writing.catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2]||!path.isAbsolute(process.argv[2]))process.exitCode=1;
 else await serveQuestionMcp(process.argv[2]).catch(()=>{process.stderr.write('CLIENT_QUESTION_MCP_STOPPED\n');process.exitCode=1;});
}
