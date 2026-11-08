import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,mkdirSync,existsSync} from 'node:fs';
import {resolveApplicationPaths,initializeApplicationData,requireStorageVolume} from '../packages/host-control/application-paths.mjs';
import {prepareApplicationCache,withApplicationCache} from '../packages/host-control/application-cache.mjs';
import {accountEnvironment} from '../packages/host-control/codex-account-policy.mjs';
import {runtimeEnvironment,taskPermissionConfig} from '../packages/application/app-server-rpc.mjs';
const within=(root,target)=>{const rel=path.relative(root,target);return rel===''||!rel.startsWith('..')&&!path.isAbsolute(rel);};
function fixture(){const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'cache-volume-'));return {root,program:path.join(root,'programs','one')};}

test('Windows storage rejects the system volume even for an explicit override',()=>{
 if(process.platform!=='win32')return;
 const system=path.parse(process.env.SystemRoot||process.env.SYSTEMROOT).root,destination=path.join(system,'synthetic-qq-agent-cache');
 assert.throws(()=>requireStorageVolume(destination),/SYSTEM_DRIVE_STORAGE_FORBIDDEN/);
 const f=fixture();assert.throws(()=>resolveApplicationPaths({programDirectory:f.program,dataDirectory:destination}),/SYSTEM_DRIVE_STORAGE_FORBIDDEN/);
 assert.equal(existsSync(destination),false);
});
test('versioned installations keep user data across upgrades and separate different profiles',()=>{
 const f=fixture(),a=resolveApplicationPaths({platform:'win32',programDirectory:f.program,home:path.join(f.root,'profile-a')}),upgraded=resolveApplicationPaths({platform:'win32',programDirectory:path.join(f.root,'programs','two'),home:path.join(f.root,'profile-a')}),b=resolveApplicationPaths({platform:'win32',programDirectory:f.program,home:path.join(f.root,'profile-b')});
 assert.equal(a.dataDirectory,upgraded.dataDirectory);assert.notEqual(a.dataDirectory,b.dataDirectory);assert.ok(within(f.root,a.dataDirectory));assert.equal(within(f.program,a.dataDirectory),false);
});
test('account and business children replace inherited cache paths case insensitively without inheriting tokens',()=>{
 const f=fixture(),own=path.join(f.root,'own-home'),dirs=prepareApplicationCache(own),source={PATH:'public-cli',Temp:'foreign-temp',tmp:'foreign-temp',AppData:'foreign-cache',LocalAppData:'foreign-cache',OPENAI_API_KEY:'synthetic-forbidden-token'};
 for(const env of [accountEnvironment(source,own),runtimeEnvironment(own,source)]){
  for(const [key,value]of Object.entries(dirs)){assert.equal(env[key],value);assert.ok(within(own,value));assert.equal(Object.keys(env).filter(k=>k.toUpperCase()===key.toUpperCase()).length,1);}
  assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(JSON.stringify(env).includes('foreign-'),false);
 }
 assert.ok(existsSync(dirs.TEMP));assert.ok(existsSync(dirs.LOCALAPPDATA));assert.equal(withApplicationCache({Temp:'old'},own).Temp,undefined);
});
test('new validation workspaces and model shell temporary files stay beside data and inside the granted project',()=>{
 const f=fixture();mkdirSync(f.program,{recursive:true});const app=initializeApplicationData({programDirectory:f.program,dataDirectory:path.join(f.root,'instance')}),workspace=app.identity.workspaceDirectory,policy=taskPermissionConfig(workspace,{write:true,shell:true,controlRoots:[app.paths.dataDirectory,f.program]});
 assert.ok(within(f.root,workspace));assert.equal(within(app.paths.dataDirectory,workspace),false);assert.equal(within(f.program,workspace),false);
 const env=policy['shell_environment_policy.set'];for(const k of ['TEMP','TMP','TMPDIR','PSModuleAnalysisCachePath'])assert.ok(within(workspace,env[k]));assert.equal(policy['permissions.qq-project.filesystem'][':root'],'deny');assert.equal(policy['permissions.qq-project.filesystem'][app.paths.dataDirectory],'deny');
});
