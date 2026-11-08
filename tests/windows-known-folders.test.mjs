import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readWindowsKnownFolders} from '../packages/host-control/windows-known-folders.mjs';
test('Windows known-folder lookup uses a fixed OS helper with no credentials, arbitrary arguments or network inheritance',()=>{
 const root=path.parse(process.cwd()).root,profile=path.join(root,'synthetic-user'),local=path.join(profile,'Local'),documents=path.join(profile,'Documents');let invocation;
 const folders=readWindowsKnownFolders({platform:'win32',environment:{SYSTEMROOT:path.join(root,'Windows'),USERPROFILE:profile,OPENAI_API_KEY:'synthetic-secret',HTTPS_PROXY:'http://127.0.0.1:12345',NODE_OPTIONS:'synthetic-untrusted'},run:(file,args,options)=>{invocation={file,args,options};return {status:0,stdout:JSON.stringify({profile,localAppData:local,documents})};}});
 assert.deepEqual(folders,{profile,localAppData:local,documents});assert.match(invocation.args.at(-1),/GetFolderPath/);assert.equal(invocation.options.shell,false);assert.equal(invocation.options.windowsHide,true);assert.equal(Object.hasOwn(invocation.options.env,'OPENAI_API_KEY'),false);assert.equal(Object.hasOwn(invocation.options.env,'NODE_OPTIONS'),false);assert.equal(Object.hasOwn(invocation.options.env,'HTTPS_PROXY'),false);
});
test('invalid or unavailable known folders do not fall back to a broad drive or arbitrary output',()=>{
 const environment={SYSTEMROOT:path.join(path.parse(process.cwd()).root,'Windows')};for(const stdout of ['not json',JSON.stringify({localAppData:'relative',documents:'relative'})])assert.throws(()=>readWindowsKnownFolders({platform:'win32',environment,run:()=>({status:0,stdout})}),/UNAVAILABLE/);assert.deepEqual(readWindowsKnownFolders({platform:'other'}),{});
});
