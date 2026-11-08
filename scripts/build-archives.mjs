import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {inspectSource} from './build-source.mjs';
import {inspectRelease} from './build-release.mjs';
import {checked,freshDestination,inside,hashBytes,order} from './release-policy.mjs';

const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export function deterministicZip(entries){
 if(!entries.length||entries.length>65535)throw Error('ARCHIVE_ENTRY_LIMIT');
 const names=new Set(),parts=[],central=[];let offset=0;
 for(const entry of [...entries].sort((a,b)=>order(a.name,b.name))){
  if(typeof entry.name!=='string'||!entry.name||/[\\:\x00-\x1f]/.test(entry.name)||entry.name.startsWith('/')||entry.name.split('/').some(p=>!p||p==='.'||p==='..')||names.has(entry.name.toLowerCase()))throw Error('ARCHIVE_ENTRY_INVALID');
  names.add(entry.name.toLowerCase());const name=Buffer.from(entry.name,'utf8'),bytes=Buffer.from(entry.bytes),crc=crc32(bytes);
  if(name.length>65535||bytes.length>0xffffffff||offset>0xffffffff)throw Error('ARCHIVE_SIZE_LIMIT');
  // STORE plus a fixed DOS timestamp (1980-01-01) makes output independent of
  // source mtimes, local timezone, compression library and traversal order.
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(0,8);local.writeUInt16LE(0,10);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
  const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(0,10);directory.writeUInt16LE(0,12);directory.writeUInt16LE(0x21,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(bytes.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
  parts.push(local,name,bytes);central.push(directory,name);offset+=local.length+name.length+bytes.length;
 }
 const index=Buffer.concat(central),end=Buffer.alloc(22);if(index.length>0xffffffff||offset+index.length>0xffffffff)throw Error('ARCHIVE_SIZE_LIMIT');
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...parts,index,end]);
}
function verifiedEntries(root,manifestName,inspect,kind,options){
 const audit=inspect(root,options);if(!audit.passed)throw Object.assign(Error('ARCHIVE_PRIVATE_AUDIT_FAILED'),{audit});
 const manifestBytes=readFileSync(checked(path.join(root,manifestName))),manifest=JSON.parse(manifestBytes);
 if(manifest.schemaVersion!==1||manifest.kind!==kind||manifest.version!==audit.version||JSON.stringify(manifest.files)!==JSON.stringify(audit.files))throw Error('ARCHIVE_MANIFEST_CHANGED');
 const entries=audit.files.map(row=>{
  const bytes=readFileSync(checked(path.join(root,row.file)));if(bytes.length!==row.bytes||hashBytes(bytes)!==row.sha256)throw Error('ARCHIVE_SOURCE_CHANGED');
  return {name:row.file,bytes};
 });
 entries.push({name:manifestName,bytes:manifestBytes});return {version:audit.version,entries};
}
export function packageArchives(sourceDirectory,programDirectory,outputDirectory,options={}){
 const source=checked(sourceDirectory),program=checked(programDirectory),target=freshDestination(source,outputDirectory);
 if(inside(program,target)||inside(target,program)||inside(source,program)||inside(program,source))throw Error('ARCHIVE_DIRECTORIES_OVERLAP');
 const sourceFiles=verifiedEntries(source,'SOURCE-MANIFEST.json',inspectSource,'qq-agent-open-source-release',options),programFiles=verifiedEntries(program,'MANIFEST.json',inspectRelease,'qq-agent-clean-program-release',options);
 if(sourceFiles.version!==programFiles.version)throw Error('ARCHIVE_VERSION_MISMATCH');
 const version=sourceFiles.version,artifacts=[];mkdirSync(target,{recursive:true});
 for(const [suffix,prefix,items]of [['source','qq-agent-gateway-'+version+'-source',sourceFiles.entries],['windows','QQAgent-'+version+'-windows',programFiles.entries]]){
  const file='QQAgent-'+version+'-'+suffix+'.zip',bytes=deterministicZip(items.map(item=>({name:prefix+'/'+item.name,bytes:item.bytes})));writeFileSync(path.join(target,file),bytes,{flag:'wx'});artifacts.push({file,sha256:hashBytes(bytes),bytes:bytes.length,files:items.length});
 }
 writeFileSync(path.join(target,'SHA256SUMS'),artifacts.map(a=>a.sha256+'  '+a.file).join('\n')+'\n',{flag:'wx'});
 const release={schemaVersion:1,version,license:'MIT',containsUserData:false,archives:artifacts};writeFileSync(path.join(target,'RELEASE.json'),JSON.stringify(release,null,2)+'\n',{flag:'wx'});
 return {passed:true,...release,directory:target};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [source,program,destination]=process.argv.slice(2);if(!source||!program||!destination)throw Error('ARCHIVE_SOURCE_PROGRAM_OUTPUT_REQUIRED');console.log(JSON.stringify(packageArchives(source,program,destination)));
}
