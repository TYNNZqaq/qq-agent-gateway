import path from 'node:path';
import {existsSync,lstatSync,openSync,closeSync,fstatSync,writeSync,fsyncSync,readFileSync} from 'node:fs';
import {noLinks,sha256,privateFilename,secretText} from './boundaries.mjs';

export const FILE_PROPOSAL_TOOL={type:'function',name:'qq_propose_text_file',description:'Propose one new plain text file in the current run delivery directory when QQ delivery is requested, otherwise at the root of this already writable project. The host displays its complete contents and waits for the owner to approve in QQ or locally before creating it. No overwrite, directory creation, permission change or network access.',inputSchema:{type:'object',properties:{filename:{type:'string',maxLength:128},content:{type:'string',maxLength:8000}},required:['filename','content'],additionalProperties:false}};
export function validateFileProposal(directory,args){
 if(!args||Array.isArray(args)||Object.keys(args).sort().join(',')!=='content,filename'||typeof args.filename!=='string'||!/[.](?:txt|md|csv|json)$/i.test(args.filename)||! /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(args.filename)||privateFilename(args.filename)||typeof args.content!=='string'||Buffer.byteLength(args.content)>8000||secretText(args.content))throw Error('FILE_PROPOSAL_INVALID');
 const root=noLinks(directory),file=path.join(root,args.filename);if(existsSync(file))throw Error('FILE_PROPOSAL_TARGET_EXISTS');
 return {root,file,filename:args.filename,content:args.content,sha256:sha256(args.content),bytes:Buffer.byteLength(args.content)};
}
export function executeFileProposal(store,config,row,pending,accept){
 if(!accept)return {success:false,contentItems:[{type:'inputText',text:JSON.stringify({status:'declined',created:false})}]};
 const original=pending.proposal,current=validateFileProposal(original.root,pending.request.params.arguments);
 if(current.file!==original.file||current.sha256!==original.sha256||current.bytes!==original.bytes)throw Error('FILE_PROPOSAL_CHANGED');
 const key='approvalEffect:'+row.request_key;if(store.get(key))throw Error('FILE_PROPOSAL_EFFECT_REQUIRES_RECONCILIATION');
 config.runtimeGuard?.();store.set(key,{state:'intent',file:current.file,sha256:current.sha256,scopeFingerprint:row.scope_fingerprint});
 let fd;
 try{
  fd=openSync(current.file,'wx',0o600);const opened=fstatSync(fd),linked=lstatSync(noLinks(current.file));
  if(!opened.isFile()||opened.nlink!==1||opened.ino!==linked.ino||opened.dev!==linked.dev||noLinks(path.dirname(current.file))!==current.root)throw Error('FILE_PROPOSAL_PATH_CHANGED');
  config.runtimeGuard?.();const bytes=Buffer.from(current.content);if(writeSync(fd,bytes)!==bytes.length)throw Error('FILE_PROPOSAL_WRITE_INCOMPLETE');fsyncSync(fd);closeSync(fd);fd=undefined;
  if(noLinks(path.dirname(current.file))!==current.root||lstatSync(current.file).nlink!==1||sha256(readFileSync(noLinks(current.file)))!==current.sha256)throw Error('FILE_PROPOSAL_VERIFICATION_FAILED');
  store.set(key,{state:'verified',file:current.file,sha256:current.sha256,bytes:current.bytes,scopeFingerprint:row.scope_fingerprint,verifiedAt:Date.now()});
  return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({status:'created',path:current.filename,absolutePath:current.file,sha256:current.sha256,bytes:current.bytes,ownerApproved:true})}]};
 }catch(error){store.set(key,{state:'unknown',file:current.file,sha256:current.sha256,scopeFingerprint:row.scope_fingerprint,error:/^[A-Z_]+$/.test(error.message)?error.message:'FILE_PROPOSAL_WRITE_FAILED'});throw error;}finally{if(fd!==undefined)closeSync(fd);}
}
