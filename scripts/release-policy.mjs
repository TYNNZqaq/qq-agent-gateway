import path from 'node:path';
import os from 'node:os';
import {existsSync,lstatSync,readFileSync,readdirSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
export const order=(a,b)=>a<b?-1:a>b?1:0;
export const inside=(base,file)=>{const r=path.relative(base,file);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
export const PUBLIC_DOCUMENTS=Object.freeze(['README.md','LICENSE','THIRD_PARTY_NOTICES.md','AGENTS.md','docs/USER-GUIDE.md','docs/AGENT-TEAM.md','docs/ci/windows-ci.yml','licenses/codex-LICENSE.txt','licenses/codex-NOTICE.txt']);
export const PROGRAM_SCRIPTS=Object.freeze(['scripts/Start-Console.ps1','scripts/Stop-Console.ps1','scripts/Resolve-DataDirectory.ps1','scripts/Initialize-Cache.ps1','scripts/Install.ps1','scripts/Desktop-Notify.ps1','scripts/Enable-Native-DesktopApproval.ps1','scripts/Read-NativeApprovalOwner.mjs','scripts/Desktop-AutoConnect.psm1','scripts/Desktop-StartEvents.cs','scripts/Connect-QQOnDesktopStart.ps1','scripts/Watch-CodexStart.ps1','scripts/Enable-CodexAutoConnect.ps1']);
export const SOURCE_SCRIPTS=Object.freeze([...PROGRAM_SCRIPTS,'scripts/build-release.mjs','scripts/build-source.mjs','scripts/build-archives.mjs','scripts/release-policy.mjs','scripts/check-boundaries.mjs','scripts/run-tests.mjs','scripts/verify-configuration.mjs','scripts/preview-ui.mjs']);
export const COMMAND_FILES=Object.freeze(['安装.cmd','打开管理界面.cmd','停止管理界面.cmd']);
export function checked(file){
 for(let p=path.resolve(file);;p=path.dirname(p)){
  if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('RELEASE_LINK_FORBIDDEN');
  if(p===path.dirname(p))break;
 }
 if(existsSync(file)&&lstatSync(file).isFile()&&lstatSync(file).nlink!==1)throw Error('RELEASE_HARDLINK_FORBIDDEN');
 return path.resolve(file);
}
export function freshDestination(source,destination){
 const target=checked(destination);
 if(target===path.parse(target).root||inside(source,target)||inside(target,source)||existsSync(target))throw Error('RELEASE_FRESH_EXTERNAL_DIRECTORY_REQUIRED');
 return target;
}
export function copyReviewedFile(source,target,relative){
 const from=checked(path.join(source,relative)),to=path.join(target,relative);
 if(!lstatSync(from).isFile())throw Error('RELEASE_SOURCE_INVALID');
 mkdirSync(path.dirname(to),{recursive:true});copyFileSync(from,to);
}
export function writePortableLaunchers(target){
 for(const [file,script,open]of [['安装.cmd','Install.ps1',true],['打开管理界面.cmd','Start-Console.ps1',true],['停止管理界面.cmd','Stop-Console.ps1',false]]){
  writeFileSync(path.join(target,file),'@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\'+script+'"'+(open?' -OpenBrowser':'')+'\r\nif errorlevel 1 pause\r\n');
 }
}
export function lockedPackage(root,{programOnly=false}={}){
 const original=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
 if(original.license!=='MIT')throw Error('RELEASE_OPEN_SOURCE_LICENSE_REQUIRED');
 const {name,version,description,repository,bugs,homepage,engines,dependencies}=original;
 if(typeof name!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))throw Error('RELEASE_PACKAGE_INVALID');
 const scripts=programOnly?{start:'node packages/host-control/cli.mjs','install:local':'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install.ps1'}:{
  test:'node scripts/run-tests.mjs',check:'node scripts/check-boundaries.mjs','check:config':'node scripts/verify-configuration.mjs',audit:'node scripts/check-boundaries.mjs',
  start:'node packages/host-control/cli.mjs','install:local':'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install.ps1',
  'release:source':'node scripts/build-source.mjs','release:program':'node scripts/build-release.mjs','release:archives':'node scripts/build-archives.mjs'
 };
 // "private" prevents accidental npm publication; the MIT source remains public.
 const pkg={name,version,description,repository,bugs,homepage,private:true,type:'module',license:'MIT',engines,scripts,dependencies};
 const lock=JSON.parse(readFileSync(path.join(root,'package-lock.json'),'utf8'));
 if(lock.lockfileVersion!==3||!lock.packages?.[''])throw Error('RELEASE_DEPENDENCY_LOCK_INVALID');
 lock.name=name;lock.version=version;Object.assign(lock.packages[''],{name,version,license:'MIT'});
 for(const [key,entry]of Object.entries(lock.packages)){
  if(!key)continue;
  if(!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i.test(key)||entry.link||!entry.version||!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity||'')||!entry.resolved?.startsWith('https://registry.npmjs.org/'))throw Error('RELEASE_DEPENDENCY_LOCK_INVALID');
 }
 return {pkg,lock};
}
export function privacyErrors(relative,bytes,{forbiddenValues=[]}={}){
 const errors=[],text=bytes.toString('utf8');
 const home=os.homedir(),privateValues=[home,home.replaceAll('\\','\\\\'),...forbiddenValues].filter(v=>typeof v==='string'&&v.length>3);
 if(/(?:^|\/)(?:\.codex|\.agents|\.npmrc|QQ插件运行目录|automation|backups|logs|sessions|test-output|\.runtime)(?:\/|$)|(?:^|\/)(?:auth\.json|installation\.local\.json|local-paths\.json|integration-current\.json|config\.local\.json)|\.(?:sqlite(?:-wal|-shm)?|secret|token|env|pfx|pem|key|log)$/i.test(relative))errors.push({file:relative,reason:'private-or-operational-file'});
 for(let i=0;i<privateValues.length;i++)if(text.toLocaleLowerCase().includes(privateValues[i].toLocaleLowerCase()))errors.push({file:relative,reason:'private-value',index:i});
 // Exact exception for a generic example in the locked upstream SDK, preserving vendor bytes.
 const inspected=/^node_modules\/@tencent-connect\/qqbot-nodejs\/(?:src|dist)\/protocol\/utils\/decode-media-path\.(?:ts|js)$/.test(relative)?text.replace(/[A-Za-z]:\\Users\\1\\file\.txt/g,'<reviewed-vendor-path-example>'):text;
 const marker='SYNTHETIC_RELEASE_'+'PRIVATE_CANARY';
 if(/(?:[a-z]:[\\/]+Users[\\/]+[^\s"'<>]+)/i.test(inspected)||inspected.includes(marker))errors.push({file:relative,reason:'machine-data-marker'});
 if(/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})\b|-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(text))errors.push({file:relative,reason:'credential-marker'});
 // Synthetic rejection samples are part of the offline tests. A literal sample is
 // limited to the explicit reviewed fixture; actual private values still fail above.
 const sample=['sk','-synthetic-model-key-123456'].join('');
 const modelKeySample=relative==='tests/qq-connection.test.mjs'?text.replaceAll(sample,'<reviewed-rejection-sample>'):text;
 if(/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/.test(modelKeySample))errors.push({file:relative,reason:'credential-marker'});
 return errors;
}
export function walkFiles(root,{skipGit=false}={}){
 const files=[];
 function walk(relative){for(const entry of readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>order(a.name,b.name))){
  if(skipGit&&!relative&&entry.name==='.git')continue;
  const file=path.posix.join(relative,entry.name),full=checked(path.join(root,file));
  if(entry.isDirectory())walk(file);else{const stat=lstatSync(full);if(!stat.isFile()||stat.size>33554432)throw Error('RELEASE_FILE_UNREVIEWED');files.push({file,full,bytes:stat.size});}
 }}walk('');return files.sort((a,b)=>order(a.file,b.file));
}
export function writePackage(target,packageData){writeFileSync(path.join(target,'package.json'),JSON.stringify(packageData.pkg,null,2)+'\n');writeFileSync(path.join(target,'package-lock.json'),JSON.stringify(packageData.lock,null,2)+'\n');}
