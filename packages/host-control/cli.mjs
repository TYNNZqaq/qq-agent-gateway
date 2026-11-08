import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { createManagementServer } from './local-server.mjs';
import {resolveApplicationPaths,initializeApplicationData,acquireManagementDataLock} from './application-paths.mjs';
import {applyApplicationCache} from './application-cache.mjs';
import {transferUserData,rollbackUserDataTransfer} from './user-data-transfer.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2);const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const options={dataDirectory:value('--data-dir')||value('--runtime')};
const layout=['stop','paths','import','rollback-import'].includes(args[0])?resolveApplicationPaths(options):initializeApplicationData(options).paths;
const runtime=layout.dataDirectory;
const port=Number(value('--port')||17391);
if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('PORT_INVALID');
const stateFile=path.join(runtime,'management-service.json'),stopFile=path.join(runtime,'management-stop.request');
if(args[0]==='import'){
 const result=await transferUserData({...options,sourceDirectory:value('--source'),confirmOwnInstance:args.includes('--confirm-own-data'),confirmExistingConsent:args.includes('--retain-current-consent')});console.log(JSON.stringify(result));
}else if(args[0]==='rollback-import'){
 console.log(JSON.stringify(rollbackUserDataTransfer(runtime)));
}else if(args[0]==='paths'){
  console.log(JSON.stringify(layout));
}else if(args[0]==='stop'){
  if(!existsSync(stateFile)){console.log(JSON.stringify({running:false}));process.exit(0);}
  const state=JSON.parse(readFileSync(stateFile,'utf8'));
  if(state.status!=='running'){console.log(JSON.stringify({running:false}));process.exit(0);}
  writeFileSync(stopFile,JSON.stringify({instance:state.instance}));console.log(JSON.stringify({stopRequested:true}));
}else{
  applyApplicationCache(runtime);
  const releaseManagement=acquireManagementDataLock(layout);
  mkdirSync(runtime,{recursive:true});
  if(existsSync(stopFile))unlinkSync(stopFile);
  const instance=crypto.randomUUID();
  let app;
  try{app=await createManagementServer({runtimeDirectory:runtime,port,instanceId:instance});}
  catch(error){if(error.code!=='EADDRINUSE'||port===0){releaseManagement();throw error;}try{app=await createManagementServer({runtimeDirectory:runtime,port:0,instanceId:instance});}catch(second){releaseManagement();throw second;}}
  writeFileSync(stateFile,JSON.stringify({service:'qq-agent-management',status:'running',instance,pid:process.pid,url:app.origin,startedAt:new Date().toISOString(),executionEnabled:false},null,2));
  console.log(JSON.stringify({url:app.origin,mode:'foundation',executionEnabled:false}));
  let stopping=false;
  const shutdown=async()=>{if(stopping)return;stopping=true;clearInterval(timer);try{await app.close();writeFileSync(stateFile,JSON.stringify({service:'qq-agent-management',status:'stopped',instance,executionEnabled:false}));if(existsSync(stopFile))unlinkSync(stopFile);}finally{releaseManagement();}};
  const timer=setInterval(()=>{try{if(existsSync(stopFile)&&JSON.parse(readFileSync(stopFile,'utf8')).instance===instance)void shutdown();}catch{}},500);
  process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
}
