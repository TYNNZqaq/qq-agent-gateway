import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {noLinks} from '../application/boundaries.mjs';
import {nativePath,nativeCwd,NativeDesktopReader} from './native-desktop-reader.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const name=value=>String(value||'杂项').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,80)||'杂项';
const project=(id,label)=>({key:'p_'+id.replaceAll('-',''),desktopId:id,name:name(label),project_key:'project:p_'+id.replaceAll('-',''),project_name:name(label),executable:false,kind:'native',path:null});
export const miscellaneousProject=()=>({key:'misc',name:'杂项',project_key:'misc',project_name:'杂项',executable:false,kind:'native',path:null});

// Only metadata is discovered here. No project filesystem becomes an execution
// grant, and an arbitrary cwd is never converted into a formal project.
export function readNativeCatalog(home,{limit=10000,reader}={}){
 const root=noLinks(nativePath(home)),file=noLinks(path.join(root,'state_5.sqlite'));
 if(lstatSync(file).nlink!==1||!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('DESKTOP_INDEX_LINK');
 let global={};const globalFile=path.join(root,'.codex-global-state.json');
 if(existsSync(globalFile)){const s=lstatSync(noLinks(globalFile));if(!s.isFile()||s.nlink!==1||s.size>8*1024*1024)throw Error('DESKTOP_PROJECT_STATE_INVALID');global=JSON.parse(readFileSync(globalFile,'utf8').replace(/^\uFEFF/,''));}
 reader||=new NativeDesktopReader(root);
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN');
  const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(r=>r.name));
  if(['id','rollout_path','source','originator','cwd','cli_version','title','updated_at'].some(k=>!columns.has(k)))throw Error('DESKTOP_INDEX_SCHEMA_UNVERIFIED');
  const optional=['project_id','thread_source','attached_thread_parent_id','archived'];
  const fields=['id','rollout_path','source','originator','cwd','cli_version','title','updated_at',...optional.filter(k=>columns.has(k))];
  const projects=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()?db.prepare('SELECT id,name,metadata FROM projects').all():[];
  const known=new Map(projects.filter(p=>uuid(p.id)).map(p=>[p.id,project(p.id,p.name)]));
  const localKey='local:'+root,migration=global['app-server-project-id-by-legacy-project-id-by-host']?.[localKey]||{};
  for(const p of projects){try{const legacy=JSON.parse(p.metadata||'{}')['codex.localProjectId'];if(uuid(legacy)&&known.has(p.id))migration[legacy]??=p.id;}catch{}}
  const memberships=global['thread-project-membership-host-ids']||{},assignments=global['thread-project-assignments']||{},projectless=new Set(global['projectless-thread-ids']||[]);
  const all=[];let after='';
  for(;;){const page=db.prepare('SELECT '+fields.join(',')+" FROM threads WHERE source='vscode' AND originator='Codex Desktop' AND id>? ORDER BY id LIMIT 256").all(after);if(!page.length)break;all.push(...page);after=page.at(-1).id;if(all.length>limit)throw Error('DESKTOP_CATALOG_LIMIT');}
  const errors=[],rows=[];
  for(const row of all){
   if(memberships[row.id]&&memberships[row.id]!=='local')continue;
   if(!uuid(row.id)||row.attached_thread_parent_id&&!uuid(row.attached_thread_parent_id)){errors.push({threadId:row.id,error:'DESKTOP_SOURCE_MISMATCH'});continue;}
   let assigned=row.project_id;
   if(!assigned&&!projectless.has(row.id)){
    const a=assignments[row.id];if(a&&a.projectKind!=='local'){errors.push({threadId:row.id,error:'DESKTOP_PROJECT_NOT_LOCAL'});continue;}
    if(a)assigned=known.has(a.projectId)?a.projectId:migration[a.projectId];
    if(a&&!assigned){errors.push({threadId:row.id,error:'DESKTOP_PROJECT_UNRESOLVED'});continue;}
   }
   const scope=assigned?known.get(assigned):miscellaneousProject();
   if(!scope){errors.push({threadId:row.id,error:'DESKTOP_PROJECT_UNRESOLVED'});continue;}
   let cwd;try{cwd=nativeCwd(row.cwd);}catch{errors.push({threadId:row.id,error:'DESKTOP_CWD_UNAVAILABLE'});continue;}
   let metadata;try{metadata=reader.read({...row,cwd},null,{readOnlyCatalog:true,metadataOnly:true}).metadata;}catch(error){errors.push({threadId:row.id,error:/^[A-Z_]+$/.test(error.message)?error.message:'DESKTOP_SOURCE_UNAVAILABLE'});continue;}
   const parent=row.attached_thread_parent_id||metadata.parentThreadId||null;
   if(parent&&!uuid(parent)){errors.push({threadId:row.id,error:'DESKTOP_SOURCE_MISMATCH'});continue;}
   rows.push({...row,cwd,historyCwd:metadata.historyCwd,cwdChanged:metadata.cwdChanged,project:scope.key,projectScope:{project_key:scope.project_key,project_name:scope.project_name},parentThreadId:parent,sourceKind:row.attached_thread_parent_id?'attached':metadata.parentThreadId?'branch':row.thread_source||'legacy',hostId:'local'});
  }
  db.exec('COMMIT');
  return {projects:[...known.values(),miscellaneousProject()],rows:rows.sort((a,b)=>b.updated_at-a.updated_at||a.id.localeCompare(b.id)),errors,checkedAt:Date.now(),source:'read-only-local-native-index',executionGranted:false};
 }finally{db.close();}
}
