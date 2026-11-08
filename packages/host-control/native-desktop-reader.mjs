import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, readSync, lstatSync, existsSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { noLinks, inside, sha256 } from '../application/boundaries.mjs';
import { verifiedCodexVersion, DESKTOP_READ_ONLY_VERSIONS } from './codex-version-policy.mjs';
import {nativeArchiveSlice} from './native-archive-slice.mjs';

// A versioned, read-only reconciliation adapter. No desktop account/configuration
// database is opened, and no desktop executable is imported or started.
export const DESKTOP_PROTOCOL_VERSION = '0.164.0-alpha.11.1';
export const nativePath = value => typeof value === 'string' ? value.replace(/^\\\\\?\\(?=[A-Za-z]:)/, '') : value;
// A deleted working directory does not prevent reading its retained history.
// Resolve existing ancestors without creating directories or granting access.
export function nativeCwd(value){
 const target=nativePath(value);if(typeof target!=='string'||!path.isAbsolute(target)||/[\x00-\x1f]/.test(target)||/^[/\\]{2}/.test(target))throw Error('UNSAFE_PATH');
 const absolute=path.resolve(target);let ancestor=absolute;while(!existsSync(ancestor)){const next=path.dirname(ancestor);if(next===ancestor)throw Error('PATH_MISSING');ancestor=next;}
 return path.join(noLinks(ancestor),path.relative(ancestor,absolute));
}
const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const required = ['id', 'rollout_path', 'source', 'originator', 'cwd', 'cli_version', 'title', 'updated_at'];
// Existing desktop chats retain their creation version. These observed legacy
// formats are accepted only for typed, read-only question events, never for
// execution, approval or terminal-completion evidence.
const questionCreationVersions=new Set(['0.163.0-alpha.11.1','0.165.0-alpha.1.2']);

export class NativeDesktopReader {
  constructor(home) { this.home = noLinks(nativePath(home)); this.sessions = noLinks(path.join(this.home, 'sessions')); this.archives=new Map();this.archiveBytes=0;this.metadata=new Map();this.largeArchives=new Set(); }
  list(projects, since = 0) {
    const file = noLinks(path.join(this.home, 'state_5.sqlite'));
    if (lstatSync(file).nlink !== 1) throw Error('DESKTOP_INDEX_LINK');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(c => c.name));
      if (required.some(name => !columns.has(name))) throw Error('DESKTOP_INDEX_SCHEMA_UNVERIFIED');
      return db.prepare("SELECT id,rollout_path,source,originator,cwd,cli_version,title FROM threads WHERE source='vscode' AND originator='Codex Desktop' AND updated_at>=? ORDER BY updated_at DESC,id").all(Math.max(0, Math.floor(since / 1000) - 60))
        .filter(row => projects.some(project => inside(project.path, nativePath(row.cwd)))).map(row => ({ ...row, cwd: noLinks(nativePath(row.cwd)) }));
    } finally { db.close(); }
  }
  listAll(since=0){
    const file=noLinks(path.join(this.home,'state_5.sqlite'));
    if(lstatSync(file).nlink!==1)throw Error('DESKTOP_INDEX_LINK');
    const db=new DatabaseSync(file,{readOnly:true});
    try{
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
      const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(c=>c.name));
      if(required.some(name=>!columns.has(name)))throw Error('DESKTOP_INDEX_SCHEMA_UNVERIFIED');
      return db.prepare("SELECT id,rollout_path,source,originator,cwd,cli_version,title FROM threads WHERE source='vscode' AND originator='Codex Desktop' AND updated_at>=? ORDER BY updated_at DESC,id LIMIT 10001").all(Math.max(0,Math.floor(since/1000)-60)).flatMap(row=>{try{return [{...row,cwd:noLinks(nativePath(row.cwd))}];}catch{return [];}});
    }finally{db.close();}
  }
  read(row, cursor = null, {includeFrames=false,questionEventsOnly=false,readOnlyCatalog=false,metadataOnly=false} = {}) {
    if (!id(row.id) || row.source !== 'vscode' || row.originator !== 'Codex Desktop' || !(verifiedCodexVersion(row.cli_version)||readOnlyCatalog&&DESKTOP_READ_ONLY_VERSIONS.includes(row.cli_version)||questionEventsOnly&&includeFrames&&(questionCreationVersions.has(row.cli_version)||DESKTOP_READ_ONLY_VERSIONS.includes(row.cli_version)))) throw Error('DESKTOP_PROTOCOL_UNVERIFIED');
    const file = path.resolve(nativePath(row.rollout_path));
    noLinks(path.dirname(file));
    const compressed=!existsSync(file),physical=noLinks(compressed?file+'.zst':file),stat=lstatSync(physical);
    const archived=path.join(this.home,'archived_sessions'),allowed=inside(this.sessions,file)||row.archived===1&&inside(archived,file);
    const standard=path.basename(file).endsWith('-'+row.id+'.jsonl'),windowFile=readOnlyCatalog&&new RegExp('-'+row.id+'_[a-f0-9-]{36}\\.jsonl$','i').test(path.basename(file));
    if (!allowed || !stat.isFile() || stat.nlink !== 1 || !standard&&!windowFile) throw Error('DESKTOP_TRANSCRIPT_REFERENCE_INVALID');
    const metaKey=physical+'|'+stat.size+'|'+stat.mtimeMs+'|'+stat.ino+'|'+row.id+'|'+row.cli_version+'|'+row.cwd;
    if(metadataOnly&&this.metadata.has(metaKey))return {metadata:this.metadata.get(metaKey)};
    let fd=null,content=null,window=null;
    try {
      if(compressed){
        const key=physical+'|'+stat.size+'|'+stat.mtimeMs+'|'+stat.ino;
        content=this.archives.get(key);
        const archiveOffset=cursor&&path.basename(cursor.file)!==path.basename(file)?null:cursor?.offset??null;
        if(!content&&(stat.size>16*1024*1024||this.largeArchives.has(key)))window=nativeArchiveSlice(physical,archiveOffset,{headOnly:metadataOnly});
        else if(!content){
          try{content=zstdDecompressSync(readFileSync(physical),{maxOutputLength:64*1024*1024});}
          catch(error){if(error.code!=='ERR_BUFFER_TOO_LARGE')throw Error('DESKTOP_ARCHIVE_INVALID');this.largeArchives.add(key);window=nativeArchiveSlice(physical,archiveOffset,{headOnly:metadataOnly});}
          if(content){if(this.archiveBytes+content.length>64*1024*1024){this.archives.clear();this.archiveBytes=0;}this.archives.set(key,content);this.archiveBytes+=content.length;}
        }
      }else fd=openSync(physical,'r');
      const size=window?window.size:content?content.length:stat.size;
      const read=(offset,length)=>{if(window)return offset===0?window.head.subarray(0,length):window.bytes.subarray(offset-window.from,offset-window.from+length);if(content)return content.subarray(offset,offset+length);const bytes=Buffer.alloc(length);readSync(fd,bytes,0,length,offset);return bytes;};
      const head=read(0,Math.min(size,1024*1024));
      const end = head.indexOf(10); if (end < 0) throw Error('DESKTOP_METADATA_INCOMPLETE');
      const first = head.subarray(0, end), meta = JSON.parse(first.toString('utf8')), p = meta.payload;
      if (meta.type !== 'session_meta' || p?.id !== row.id || p.originator !== 'Codex Desktop' || p.source !== 'vscode' || p.cli_version !== row.cli_version) throw Error('DESKTOP_SOURCE_MISMATCH');
      const historyCwd=nativeCwd(p.cwd);if(!readOnlyCatalog&&historyCwd!==row.cwd)throw Error('DESKTOP_SOURCE_MISMATCH');
      if(windowFile&&(p.history_mode!=='paginated'||p.history_base?.thread_id!==row.id||!Number.isSafeInteger(p.history_base.end_ordinal_exclusive)||p.history_base.end_ordinal_exclusive<0||!Number.isSafeInteger(p.history_base.end_byte_offset)||p.history_base.end_byte_offset<0))throw Error('DESKTOP_TRANSCRIPT_REFERENCE_INVALID');
      if(metadataOnly){const metadata={id:p.id,source:p.source,originator:p.originator,cliVersion:p.cli_version,cwd:row.cwd,historyCwd,cwdChanged:historyCwd!==row.cwd,parentThreadId:p.forked_from_id||p.parent_thread_id||null};if(this.metadata.size>10000)this.metadata.clear();this.metadata.set(metaKey,metadata);return {metadata};}
      const identity = sha256(first),rollover=readOnlyCatalog&&windowFile&&cursor&&cursor.file!==file&&cursor.threadId===row.id&&cursor.protocol===row.cli_version&&(inside(this.sessions,cursor.file)||inside(archived,cursor.file));
      if(rollover)cursor={...cursor,file,identity,offset:end+1,anchor:null,skipping:false};
      const offset = cursor?.offset ?? end + 1;
      const relocated=cursor&&path.basename(cursor.file)===path.basename(file)&&(inside(this.sessions,cursor.file)||inside(archived,cursor.file));
      if (cursor && (cursor.identity !== identity || cursor.file !== file&&!relocated || !Number.isSafeInteger(offset) || offset < end + 1 || offset > size)) throw Error('DESKTOP_TRANSCRIPT_CHANGED');
      if(cursor?.anchor&&cursor.anchor!==sha256(read(Math.max(end+1,offset-256),offset-Math.max(end+1,offset-256))))throw Error('DESKTOP_TRANSCRIPT_CHANGED');
      let bytes=read(offset,Math.min(size-offset,4*1024*1024)),base=offset;
      const readLength=bytes.length,skipCursor=()=>{
        const next=offset+readLength,anchor=sha256(read(Math.max(end+1,next-256),next-Math.max(end+1,next-256)));
        return {events:[],...(includeFrames?{frames:[]}:{}),more:next<size,cursor:{file,identity,threadId:row.id,protocol:row.cli_version,offset:next,anchor,pending:cursor?.pending??{},skipping:true,skippedLargeRecords:(cursor?.skippedLargeRecords||0)+(cursor?.skipping?0:1)}};
      };
      if(cursor?.skipping){const firstNewline=bytes.indexOf(10);if(firstNewline<0)return skipCursor();base+=firstNewline+1;bytes=bytes.subarray(firstNewline+1);}
      const last = bytes.lastIndexOf(10);
      if (last < 0 && bytes.length === 4 * 1024 * 1024) return skipCursor();
      const events = [],frames=[];
      if (last >= 0) {
        let at = 0;
        for (const line of bytes.subarray(0, last).toString('utf8').split('\n')) {
          const start = base + at; at += Buffer.byteLength(line) + 1;
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          if(includeFrames&&['event_msg','response_item','turn_context'].includes(frame.type))frames.push({frame,evidence:{file,offset:start,sha256:sha256(line),protocol:row.cli_version}});
          if(questionEventsOnly)continue;
          if (frame.type !== 'event_msg' || !['task_started', 'task_complete', 'turn_aborted'].includes(frame.payload?.type)) continue;
          const payload = frame.payload, timestamp = Date.parse(frame.timestamp);
          if (!id(payload.turn_id) || !id(payload.root_turn_id??payload.turn_id) || !Number.isFinite(timestamp)) throw Error('DESKTOP_TERMINAL_SCHEMA_UNVERIFIED');
          if(payload.turn_attribution?.turn_id&&payload.turn_attribution.turn_id!==payload.turn_id||payload.turn_attribution?.root_turn_id&&payload.turn_attribution.root_turn_id!==(payload.root_turn_id??payload.turn_id))throw Error('DESKTOP_TERMINAL_SCHEMA_UNVERIFIED');
          if (payload.type === 'task_complete' && payload.last_agent_message != null && (typeof payload.last_agent_message !== 'string' || payload.last_agent_message.length > 500000)) throw Error('DESKTOP_TERMINAL_SCHEMA_UNVERIFIED');
          events.push({ type: payload.type, turnId: payload.turn_id, rootTurnId: payload.root_turn_id ?? payload.turn_id, timestamp,
            body: payload.last_agent_message ?? null, failed: payload.error != null, evidence: { file, offset: start, sha256: sha256(line), protocol: row.cli_version } });
        }
      }
      const next=base+(last<0?0:last+1),anchor=sha256(read(Math.max(end+1,next-256),next-Math.max(end+1,next-256)));
      return { events,...(includeFrames?{frames}:{}),more:offset+readLength<size, cursor: { file, identity,threadId:row.id,protocol:row.cli_version,offset: next, anchor, pending: cursor?.pending ?? {},skippedLargeRecords:cursor?.skippedLargeRecords||0 } };
    } finally { if(fd!==null)closeSync(fd); }
  }
}
