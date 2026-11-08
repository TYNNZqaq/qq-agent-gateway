import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolveApplicationPaths,initializeApplicationData,acquireManagementDataLock} from '../packages/host-control/application-paths.mjs';
function fixture(){const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'application-paths-')),program=path.join(root,'program'),local=path.join(root,'current-user-local');mkdirSync(program);mkdirSync(local);return {root,program,local,options:{programDirectory:program,platform:'win32',home:root,environment:{LOCALAPPDATA:local}}};}
test('default user data uses the current user application directory and is independent of the program location',()=>{
 const f=fixture(),p=resolveApplicationPaths(f.options),user=createHash('sha256').update(path.resolve(f.root).toLowerCase()).digest('hex').slice(0,20);assert.equal(p.dataDirectory,path.join(f.root,'QQAgentData','users',user,'instances','default'));const moved=path.join(f.root,'program-upgrade');mkdirSync(moved);assert.equal(resolveApplicationPaths({...f.options,programDirectory:moved}).dataDirectory,p.dataDirectory);assert.notEqual(p.accountHome,path.join(f.program,'codex-account','home'));assert.equal(existsSync(p.dataDirectory),false);
});
test('two clean data directories receive independent random identities and reopening preserves each instance',()=>{
 const f=fixture(),a=initializeApplicationData({...f.options,dataDirectory:path.join(f.root,'user-a')}),b=initializeApplicationData({...f.options,dataDirectory:path.join(f.root,'user-b')});assert.notEqual(a.identity.instanceId,b.identity.instanceId);assert.notEqual(a.identity.hostId,b.identity.hostId);assert.deepEqual(initializeApplicationData({...f.options,dataDirectory:a.paths.dataDirectory}).identity,a.identity);assert.equal(existsSync(a.paths.accountHome),false);assert.equal(existsSync(a.paths.consentFile),false);assert.doesNotMatch(readFileSync(a.paths.identityFile,'utf8'),/botId|agentId|account|secret|hardware|MAC|username|accepted/);
});
test('explicit user data cannot include program code, a foreign account directory or a filesystem root',()=>{
 const f=fixture();for(const dataDirectory of [f.program,path.join(f.program,'data'),f.root,path.parse(f.root).root])assert.throws(()=>resolveApplicationPaths({...f.options,dataDirectory}));assert.throws(()=>resolveApplicationPaths({...f.options,dataDirectory:path.join(f.root,'foreign-account','data'),environment:{CODEX_HOME:path.join(f.root,'foreign-account')}}),/FOREIGN_ACCOUNT/);assert.throws(()=>resolveApplicationPaths({...f.options,dataDirectory:'relative-data'}),/APPLICATION_PATH_INVALID/);
});
test('foreign nonempty data and malformed identities require an explicit import rather than being adopted',()=>{
 const f=fixture(),data=path.join(f.root,'foreign-data');mkdirSync(data);writeFileSync(path.join(data,'foreign.sqlite'),'synthetic private data');assert.throws(()=>initializeApplicationData({...f.options,dataDirectory:data}),/REQUIRES_IMPORT/);const second=initializeApplicationData({...f.options,dataDirectory:path.join(f.root,'fresh')});writeFileSync(second.paths.identityFile,JSON.stringify({schemaVersion:99}));assert.throws(()=>initializeApplicationData({...f.options,dataDirectory:second.paths.dataDirectory}),/IDENTITY_INVALID/);
});
test('a data directory has one management owner while separate instances can hold independent locks',()=>{
 const f=fixture(),a=initializeApplicationData({...f.options,dataDirectory:path.join(f.root,'lock-a')}),b=initializeApplicationData({...f.options,dataDirectory:path.join(f.root,'lock-b')}),releaseA=acquireManagementDataLock(a.paths),releaseB=acquireManagementDataLock(b.paths);try{assert.throws(()=>acquireManagementDataLock(a.paths),/MANAGEMENT_ALREADY_RUNNING/);}finally{releaseA();releaseB();}const again=acquireManagementDataLock(a.paths);again();
});
test('packaged AppData redirection cannot become another application dependency or change the default user instance',()=>{
 const f=fixture(),profile=path.join(f.root,'known-profile'),privateRoot=path.join(profile,'AppData','Local','Packages','Synthetic.OtherApp','LocalCache','Local'),expected=resolveApplicationPaths({...f.options,knownFolders:{profile,localAppData:f.local}}).dataDirectory;assert.equal(resolveApplicationPaths({...f.options,knownFolders:{profile,localAppData:privateRoot}}).dataDirectory,expected);assert.throws(()=>resolveApplicationPaths({...f.options,home:profile,dataDirectory:path.join(privateRoot,'QQAgent')}),/FOREIGN_PACKAGED_APPLICATION_DATA/);
});
