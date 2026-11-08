import path from 'node:path';
import {existsSync,lstatSync,openSync,readSync,closeSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {checkedApplicationPath} from './application-paths.mjs';

// The pinned CLI owns this index. Only paths to already-copied, identity-checked
// session files are changed; authentication and conversation content stay opaque.
export function relocateNativeSessionPaths(home,{workspaceFrom,workspaceTo}={}){
 const root=checkedApplicationPath(home),file=path.join(root,'state_5.sqlite');
 if(!existsSync(file))return {indexPresent:false,checked:0,changed:0};
 const st=lstatSync(checkedApplicationPath(file));if(!st.isFile()||st.nlink!==1)throw Error('NATIVE_SESSION_INDEX_UNSAFE');
 const db=new DatabaseSync(file),changes=[];
 const clean=value=>value.replace(/^\\\\\?\\(?=[A-Za-z]:)/,'');
 const inside=(base,target)=>{const r=path.relative(base,target);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
 try{
  const columns=db.prepare('PRAGMA table_info(threads)').all().map(c=>c.name);if(!['id','rollout_path','cwd'].every(c=>columns.includes(c)))throw Error('NATIVE_SESSION_INDEX_SCHEMA_UNSUPPORTED');
  db.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');
  const rows=db.prepare('SELECT id,rollout_path,cwd FROM threads').all();
  for(const row of rows){
   const normalized=String(row.rollout_path).replaceAll('\\','/'),at=normalized.lastIndexOf('/sessions/'),relative=at<0?'':normalized.slice(at+10);
   if(!/^[a-f0-9-]{36}$/i.test(row.id)||!/^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(relative)||!relative.endsWith('-'+row.id+'.jsonl'))throw Error('NATIVE_SESSION_REFERENCE_INVALID');
   const target=checkedApplicationPath(path.join(root,'sessions',...relative.split('/'))),s=lstatSync(target);if(!s.isFile()||s.nlink!==1)throw Error('NATIVE_SESSION_FILE_UNSAFE');
   const fd=openSync(target,'r'),buffer=Buffer.alloc(65536);let header;
   try{const bytes=readSync(fd,buffer,0,buffer.length,0),line=buffer.subarray(0,bytes).toString('utf8').split('\n')[0];header=JSON.parse(line);}finally{closeSync(fd);}
   if(header.type!=='session_meta'||header.payload?.id!==row.id)throw Error('NATIVE_SESSION_FILE_IDENTITY_MISMATCH');
   let cwd=row.cwd;
   if(workspaceFrom&&workspaceTo&&inside(checkedApplicationPath(workspaceFrom),clean(cwd)))cwd=checkedApplicationPath(path.join(workspaceTo,path.relative(workspaceFrom,clean(cwd))));
   if(row.rollout_path!==target||row.cwd!==cwd){db.prepare('UPDATE threads SET rollout_path=?,cwd=? WHERE id=? AND rollout_path=? AND cwd=?').run(target,cwd,row.id,row.rollout_path,row.cwd);changes.push({threadId:row.id,previous:row.rollout_path,current:target,cwdChanged:row.cwd!==cwd});}
  }
  db.exec('COMMIT');return {indexPresent:true,checked:rows.length,changed:changes.length,changes};
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
}
