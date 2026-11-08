import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {prepareApplicationCache} from './application-cache.mjs';
import {parseAccountProtocolVersion} from './codex-version-policy.mjs';
import { ACCOUNT_CLI_VERSION, accountError, accountEnvironment, accountConfig, accountArguments, checkAccountRpc, checkAccountConfiguration } from './codex-account-policy.mjs';

function noLinks(full) {
  for(let cursor=path.resolve(full);;cursor=path.dirname(cursor)){
    if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw accountError('ACCOUNT_PATH_LINK_FORBIDDEN');
    if(cursor===path.dirname(cursor))break;
  }
}
export function accountDirectories(runtimeDirectory,{fileInfo=lstatSync}={}) {
  const root=path.resolve(runtimeDirectory,'codex-account');noLinks(root);
  if(root===path.parse(root).root)throw accountError('ACCOUNT_DIRECTORY_INVALID');
  const home=path.join(root,'home'),cwd=path.join(root,'empty-cwd');
  for(const directory of [root,home,cwd]){noLinks(directory);mkdirSync(directory,{recursive:true});}
  prepareApplicationCache(home);
  const config=path.join(home,'config.toml');
  if(existsSync(config)){
    const st=fileInfo(config);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||readFileSync(config,'utf8')!==accountConfig)throw accountError('ACCOUNT_CONFIG_CHANGED');
  }else writeFileSync(config,accountConfig,{flag:'wx',mode:0o600});
  return {root:realpathSync(root),home:realpathSync(home),cwd:realpathSync(cwd)};
}
function regularCliFile(file){
  if(!existsSync(file))return null;noLinks(file);const stat=lstatSync(file);
  if(stat.nlink!==1)throw accountError('ACCOUNT_PATH_LINK_FORBIDDEN');
  return stat.isFile()?realpathSync(file):null;
}
function publicPackageMetadata(file){
  if(!existsSync(file))return null;noLinks(file);const stat=lstatSync(file);
  if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw accountError('ACCOUNT_CLI_PACKAGE_UNSAFE');
  try{return JSON.parse(readFileSync(file,'utf8'));}catch{throw accountError('ACCOUNT_CLI_PACKAGE_INVALID');}
}
function npmWindowsCli(directory){
  if(process.platform!=='win32')return null;
  const target={x64:'x86_64-pc-windows-msvc',arm64:'aarch64-pc-windows-msvc'}[process.arch];if(!target)return null;
  // Presence of a public npm entry is enough: never interpret or execute shim text.
  if(!['codex.cmd','codex.ps1'].some(name=>regularCliFile(path.join(directory,name))))return null;
  const roots=[path.join(directory,'node_modules','@openai','codex')];
  if(path.basename(directory).toLowerCase()==='.bin')roots.push(path.join(path.dirname(directory),'@openai','codex'));
  for(const root of roots){
    const pkg=publicPackageMetadata(path.join(root,'package.json'));
    if(pkg?.name!=='@openai/codex'||typeof pkg.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)||!['bin/codex.js','./bin/codex.js'].includes(typeof pkg.bin==='string'?pkg.bin:pkg.bin?.codex)||!regularCliFile(path.join(root,'bin','codex.js')))continue;
    const platformName='@openai/codex-win32-'+process.arch,dependency=pkg.optionalDependencies?.[platformName];
    for(const platformRoot of [path.join(root,'node_modules','@openai','codex-win32-'+process.arch),path.join(path.dirname(root),'codex-win32-'+process.arch)]){
      const platform=publicPackageMetadata(path.join(platformRoot,'package.json'));if(!platform)continue;
      // npm publishes platform packages as aliases whose internal name remains
      // @openai/codex. Both the exact alias target and architecture must agree.
      const alias=platform.name==='@openai/codex'&&platform.version===pkg.version+'-win32-'+process.arch&&dependency==='npm:@openai/codex@'+platform.version;
      const named=platform.name===platformName&&platform.version===pkg.version&&dependency===pkg.version;
      if((!alias&&!named)||!Array.isArray(platform.os)||!platform.os.includes('win32')||!Array.isArray(platform.cpu)||!platform.cpu.includes(process.arch))throw accountError('ACCOUNT_CLI_PACKAGE_INVALID');
      for(const leaf of ['bin','codex']){const file=regularCliFile(path.join(platformRoot,'vendor',target,leaf,'codex.exe'));if(file)return file;}
    }
    // Older public npm releases bundled vendor executables in the main package.
    for(const leaf of ['bin','codex']){const file=regularCliFile(path.join(root,'vendor',target,leaf,'codex.exe'));if(file)return file;}
  }
  return null;
}
export function locateAccountCli(environment=process.env) {
  // Official public CLI only: current app-provided executable or PATH, never local-paths.json.
  const explicit=environment.CODEX_APP_RUNTIME_CLI_PATH;
  if(explicit&&path.isAbsolute(explicit)&&/^codex(?:\.exe)?$/i.test(path.basename(explicit))){const file=regularCliFile(explicit);if(file)return file;}
  for(const directory of (environment.PATH||environment.Path||'').split(path.delimiter).filter(Boolean)){
    if(!path.isAbsolute(directory))continue;
    const direct=regularCliFile(path.join(directory,process.platform==='win32'?'codex.exe':'codex'));if(direct)return direct;
    const packaged=npmWindowsCli(directory);if(packaged)return packaged;
  }
  throw accountError('ACCOUNT_CLI_NOT_FOUND',503);
}

export async function openAccountProcess({runtimeDirectory,onNotification=()=>{},onClose=()=>{},onSpawn=()=>{},guard=()=>{},environment=process.env,spawnProcess=spawn,versionProcess=spawnSync,timeoutMs=12000}={}) {
  guard();const directories=accountDirectories(runtimeDirectory),executable=locateAccountCli(environment),env=accountEnvironment(environment,directories.home);
  const options={cwd:directories.cwd,env,windowsHide:true,shell:false};
  const version=versionProcess(executable,['--version'],{...options,encoding:'utf8',timeout:12000,maxBuffer:4096});
  const actualVersion=parseAccountProtocolVersion(version.stdout);
  if(version.status!==0||!actualVersion)throw accountError('ACCOUNT_CLI_VERSION_UNVERIFIED',503);
  guard();const child=spawnProcess(executable,[...accountArguments],{...options,stdio:['pipe','pipe','pipe']});
  let ended=false,ending=false,sequence=0,buffer='',closedResolve;
  const pending=new Map(),closed=new Promise(resolve=>closedResolve=resolve);
  const failPending=()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(accountError('ACCOUNT_TRANSPORT_UNKNOWN'));}pending.clear();};
  const abort=()=>{if(!ending){ending=true;child.kill();}};
  child.on('error',()=>{failPending();abort();});
  child.on('close',()=>{ended=true;failPending();closedResolve();try{onClose();}catch{}});
  child.stdin.on('error',()=>{failPending();abort();});
  child.stderr.on('data',()=>{}); // Never forward CLI diagnostics: they may contain sign-in material.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;if(Buffer.byteLength(buffer)>2*1024*1024){failPending();abort();return;}
    const lines=buffer.split('\n');buffer=lines.pop();
    for(const line of lines){
      if(!line.trim())continue;let frame;try{frame=JSON.parse(line);}catch{failPending();abort();return;}
      if(!frame||typeof frame!=='object'||Array.isArray(frame)||(frame.id!==undefined&&typeof frame.id!=='string'&&typeof frame.id!=='number')){failPending();abort();return;}
      if(frame.method&&frame.id!==undefined){child.stdin.write(JSON.stringify({id:frame.id,error:{code:-32601,message:'Account control denies server requests'}})+'\n');continue;}
      if(frame.id!==undefined){const item=pending.get(frame.id);if(!item)continue;pending.delete(frame.id);clearTimeout(item.timer);if(frame.error)item.reject(accountError('ACCOUNT_RPC_REJECTED'));else item.resolve(frame.result);continue;}
      if(['account/login/completed','account/updated'].includes(frame.method)){try{guard();onNotification(frame.method,frame.params);}catch{failPending();abort();}}
    }
  });
  const request=(method,params)=>{
    checkAccountRpc(method,params);guard();if(ended||ending)throw accountError('ACCOUNT_TRANSPORT_UNKNOWN');
    return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(accountError('ACCOUNT_RPC_TIMEOUT'));},timeoutMs);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,...(params===undefined?{}:{params})})+'\n');});
  };
  const close=async()=>{if(ended)return;ending=true;child.stdin.end();const timer=setTimeout(()=>child.kill(),2000);await closed;clearTimeout(timer);};
  try{
    onSpawn(child.pid);
    const result=await request('initialize',{clientInfo:{name:'qq_gateway_account_control',title:'QQ Gateway account control',version:'1.0.0'},capabilities:{experimentalApi:false}});
    if(typeof result?.userAgent!=='string'||!result.userAgent.split(/[^0-9A-Za-z.-]+/).includes(actualVersion))throw accountError('ACCOUNT_HANDSHAKE_UNVERIFIED');
    guard();child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    checkAccountConfiguration(await request('config/read',{includeLayers:false}));
    return {request,close,pid:child.pid,version:actualVersion};
  }catch(error){await close();throw error;}
}
