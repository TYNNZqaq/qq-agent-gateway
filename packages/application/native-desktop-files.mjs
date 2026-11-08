import path from 'node:path';
import {lstatSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {NativeDesktopReader,nativeCwd} from '../host-control/native-desktop-reader.mjs';
import {readNativeCatalog} from '../host-control/native-desktop-catalog.mjs';
import {nativeGlobalNoticeValid} from './native-desktop-scope.mjs';
import {noLinks,inside,sha256,privateFilename,secretText} from './boundaries.mjs';

const humanTriggers=new Set(['composer','user','human','submit','follow_up','user_message']);

const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.nlink===b.nlink&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;

// The caller supplies an authorized exact path. Pin the opened file identity
// before reading, and read at most the checked size plus one byte. A growing
// or substituted path cannot turn the delivery limit into an unbounded read.
export function readStableArtifact(candidate,{maxBytes,startedAt,completedAt,requireTimeWindow=false}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw Error('TOO_LARGE');
 const file=noLinks(candidate),before=lstatSync(file,{bigint:true});
 if(!before.isFile())throw Error('NOT_REGULAR_FILE');
 if(before.nlink!==1n)throw Error('PRIVATE_FILE');
 if(before.size>BigInt(maxBytes))throw Error('TOO_LARGE');
 if(requireTimeWindow||startedAt!==undefined||completedAt!==undefined){
  if(!Number.isFinite(startedAt)||!Number.isFinite(completedAt)||completedAt<startedAt||Number(before.mtimeMs)<startedAt-2000||Number(before.mtimeMs)>completedAt+2000)throw Error('NOT_FROM_THIS_TURN');
 }
 const descriptor=openSync(file,'r');
 try{
  const opened=fstatSync(descriptor,{bigint:true});
  if(!opened.isFile()||opened.nlink!==1n||!sameFile(before,opened)||noLinks(candidate)!==file||!sameFile(opened,lstatSync(file,{bigint:true})))throw Error('FILE_CHANGED');
  const size=Number(opened.size),buffer=Buffer.alloc(size+1);let count=0;
  while(count<buffer.length){const n=readSync(descriptor,buffer,count,buffer.length-count,null);if(!n)break;count+=n;}
  if(count>maxBytes)throw Error('TOO_LARGE');
  if(count!==size)throw Error('FILE_CHANGED');
  const after=fstatSync(descriptor,{bigint:true});
  if(!sameFile(opened,after)||after.nlink!==1n||noLinks(candidate)!==file||!sameFile(after,lstatSync(file,{bigint:true})))throw Error('FILE_CHANGED');
  return {file,bytes:buffer.subarray(0,count)};
 }finally{closeSync(descriptor);}
}

// Native clients retain their thread output directory across dates and moves
// into archived_sessions. Verify the date components carried by the exact
// candidate path and the exact thread ID under the configured native home.
export function nativeVisualizationRoot(config,threadId,candidate){
 if(typeof threadId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)||typeof config.desktopNotifications?.home!=='string')return null;
 try{
  const base=path.join(noLinks(config.desktopNotifications.home),'visualizations');if(!inside(base,candidate))return null;
  const parts=path.relative(base,candidate).split(path.sep);
  if(parts.length<5||!/^\d{4}$/.test(parts[0])||!/^(?:0[1-9]|1[0-2])$/.test(parts[1])||!/^(?:0[1-9]|[12]\d|3[01])$/.test(parts[2])||parts[3].toLowerCase()!==threadId.toLowerCase())return null;
  const [year,month,day]=parts.slice(0,3).map(Number),date=new Date(Date.UTC(year,month-1,day));
  if(year<1970||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return noLinks(path.join(base,...parts.slice(0,4)));
 }catch{return null;}
}
export class NativeDesktopFiles{
 constructor(store,config){Object.assign(this,{store,config});this.reader=new NativeDesktopReader(config.desktopNotifications.home);}
 read(row){
  const observation=this.store.db.prepare('SELECT * FROM desktop_observations WHERE thread_id=? AND turn_id=?').get(row.thread_id,row.turn_id);
  if(!observation||!nativeGlobalNoticeValid(this.store,this.config,observation)||observation.status!=='completed')throw Error('NATIVE_FILE_SOURCE_CHANGED');
  const native=readNativeCatalog(this.config.desktopNotifications.home,{reader:this.reader}).rows.find(r=>r.id===row.thread_id);
  if(!native||nativeCwd(row.project_root)!==native.cwd)throw Error('NATIVE_FILE_SOURCE_CHANGED');
  const expected=JSON.parse(observation.evidence);let cursor=null,active=null,root=null,startedAt=null,completedAt=null,human=false,final='',terminal=null;const prompts=new Set();
  for(let page=0;page<256;page++){
   const batch=this.reader.read(native,cursor,{readOnlyCatalog:true,includeFrames:true});
   for(const {frame,evidence} of batch.frames){
    const p=frame.payload;
    if(frame.type==='event_msg'&&p?.type==='task_started'){
     active=p.turn_id;if(active===row.turn_id){root=p.root_turn_id??p.turn_id;startedAt=Date.parse(frame.timestamp);human=humanTriggers.has(p.turn_attribution?.turn_trigger);}
    }
    if(active!==row.turn_id)continue;
    if(frame.type==='turn_context'&&p?.turn_id===row.turn_id&&p.cwd&&nativeCwd(p.cwd)!==native.cwd)throw Error('NATIVE_FILE_SOURCE_CHANGED');
    if(human&&frame.type==='event_msg'&&p?.type==='user_message'&&(!p.turn_id||p.turn_id===row.turn_id)&&typeof p.message==='string')prompts.add(p.message.slice(0,128000));
    if(human&&frame.type==='response_item'&&p?.type==='message'&&p.role==='user'){
     const text=(p.content||[]).filter(x=>['text','input_text'].includes(x.type)&&typeof x.text==='string').map(x=>x.text).join('\n');if(text)prompts.add(text.slice(0,128000));
    }
    if(frame.type==='event_msg'&&p?.type==='task_complete'&&p.turn_id===row.turn_id&&(p.root_turn_id??p.turn_id)===root){
     if(p.error!=null||evidence.offset!==expected.offset||evidence.sha256!==expected.sha256)throw Error('NATIVE_FILE_SOURCE_CHANGED');
     final=typeof p.last_agent_message==='string'?p.last_agent_message:'';completedAt=Date.parse(frame.timestamp);terminal=evidence;break;
    }
   }
   cursor=batch.cursor;if(terminal||!batch.more)break;
  }
  if(!terminal||!Number.isFinite(startedAt)||completedAt!==observation.completed_at||completedAt<startedAt)throw Error('NATIVE_FILE_TURN_INCOMPLETE');
  return {prompt:[...prompts].join('\n'),final,cwd:native.cwd,startedAt,completedAt,threadId:native.id,evidence:terminal};
 }
}

// Explicit per-turn delivery authorizes reading these exact output files. The
// catalog itself supplies no file or execution grant. Existing manifests and
// source records are retained, and broader application/control roots are denied.
export function recordNativeArtifacts(store,config,key,context,candidates,limits){
 const roots=[path.join(context.cwd,'outputs'),path.join(context.cwd,'artifacts')];
 const records=[];let total=0;
 for(const candidate of candidates.slice(0,limits.count))try{
  const file=noLinks(candidate),visual=nativeVisualizationRoot(config,context.threadId,file),root=roots.find(root=>inside(root,file))||visual;if(!root||inside(store.directory,file)||privateFilename(file))continue;
  if(/(?:^|[\\/])(?:\.git|\.aws|\.ssh|\.codex|\.agents|node_modules)(?:[\\/]|$)/i.test(path.relative(root,file)))continue;
  const {bytes}=readStableArtifact(file,{maxBytes:Math.min(limits.bytes,limits.total-total),startedAt:context.startedAt,completedAt:context.completedAt,requireTimeWindow:true});if(secretText(bytes.toString('utf8')))continue;
  records.push({path:file,owner:store.get('owner'),sha256:sha256(bytes),bytes:bytes.length,origin:'native-human-turn-delivery',threadId:context.threadId,turnEvidence:context.evidence});total+=bytes.length;
 }catch{}
 store.set('artifactManifest:'+key,records);
 return records;
}
