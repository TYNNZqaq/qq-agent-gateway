import path from 'node:path';
import {openSync,closeSync,readSync,lstatSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {noLinks,inside,sha256} from '../application/boundaries.mjs';
import {DESKTOP_PROTOCOL_VERSION,nativePath} from './native-desktop-reader.mjs';
import {verifiedCodexVersion,REVIEWED_CODEX_PROTOCOL_VERSIONS} from './codex-version-policy.mjs';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

// Permission hooks belong to the desktop runtime. Only its index and exact
// transcript metadata/lifecycle are read; credentials and tool output are not.
export function nativePermissionSource(home,payload,{reviewedRuntime=false}={}){
 if(!payload||!uuid(payload.session_id)||!uuid(payload.turn_id)||typeof payload.tool_name!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(payload.tool_name)||!payload.tool_input||typeof payload.tool_input!=='object'||Array.isArray(payload.tool_input)||typeof payload.transcript_path!=='string')throw Error('NATIVE_PERMISSION_INPUT_INVALID');
 const root=noLinks(nativePath(home)),index=noLinks(path.join(root,'state_5.sqlite'));
 if(lstatSync(index).nlink!==1)throw Error('NATIVE_PERMISSION_INDEX_LINK');
 const db=new DatabaseSync(index,{readOnly:true});let row;try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');row=db.prepare('SELECT id,rollout_path,source,originator,cwd,cli_version FROM threads WHERE id=?').get(payload.session_id);}finally{db.close();}
 if(!row||row.source!=='vscode'||row.originator!=='Codex Desktop'||!(verifiedCodexVersion(row.cli_version)||reviewedRuntime===true&&REVIEWED_CODEX_PROTOCOL_VERSIONS.includes(row.cli_version)))throw Error('NATIVE_PERMISSION_SOURCE_UNVERIFIED');
 const file=noLinks(nativePath(row.rollout_path)),stat=lstatSync(file),cwd=noLinks(nativePath(payload.cwd));
 if(!inside(noLinks(path.join(root,'sessions')),file)||file!==noLinks(nativePath(payload.transcript_path))||cwd!==noLinks(nativePath(row.cwd))||!stat.isFile()||stat.nlink!==1||!path.basename(file).endsWith('-'+row.id+'.jsonl'))throw Error('NATIVE_PERMISSION_TRANSCRIPT_MISMATCH');
 const fd=openSync(file,'r');try{
  const head=Buffer.alloc(Math.min(stat.size,1048576));readSync(fd,head,0,head.length,0);const end=head.indexOf(10);if(end<0)throw Error('NATIVE_PERMISSION_METADATA_INCOMPLETE');
  const meta=JSON.parse(head.subarray(0,end).toString('utf8')),p=meta.payload;
  if(meta.type!=='session_meta'||p?.id!==row.id||p.source!==row.source||p.originator!==row.originator||p.cli_version!==row.cli_version||noLinks(nativePath(p.cwd))!==cwd)throw Error('NATIVE_PERMISSION_METADATA_MISMATCH');
  const start=Math.max(end+1,stat.size-4*1048576),tail=Buffer.alloc(stat.size-start);readSync(fd,tail,0,tail.length,start);const text=tail.toString('utf8'),lines=text.slice(start===end+1?0:text.indexOf('\n')+1).split('\n');let active=false;
  for(const line of lines){if(!line.trim())continue;let frame;try{frame=JSON.parse(line);}catch{continue;}if(frame.type!=='event_msg'||frame.payload?.turn_id!==payload.turn_id)continue;if(frame.payload.type==='task_started')active=true;if(['task_complete','turn_aborted'].includes(frame.payload.type))active=false;}
  if(!active)throw Error('NATIVE_PERMISSION_TURN_NOT_ACTIVE');
  return {threadId:row.id,turnId:payload.turn_id,cwd,transcriptPath:file,metadataHash:sha256(head.subarray(0,end)),cliVersion:row.cli_version,toolName:payload.tool_name,toolInput:payload.tool_input,inputHash:sha256(JSON.stringify(payload.tool_input)),toolUseId:typeof payload.tool_use_id==='string'?payload.tool_use_id:null};
 }finally{closeSync(fd);}
}
