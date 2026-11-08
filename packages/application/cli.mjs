import path from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolveApplicationPaths} from '../host-control/application-paths.mjs';
import {applyApplicationCache} from '../host-control/application-cache.mjs';
import {prepareFreshBusiness,activeBusinessConfig,activateFreshBusiness} from './fresh-bootstrap.mjs';
import {loadConfig} from './config.mjs';
import {runBusiness} from './business-runtime.mjs';
import {runCodexSelfTest} from './self-test.mjs';
import {runPairing} from './pairing-runtime.mjs';
import {atomicJson} from './boundaries.mjs';
import {configureFirstRunFeatures,prepareNativeOnlyBusiness} from './first-run-features.mjs';
const args=process.argv.slice(2),command=args[0],argument=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const paths=resolveApplicationPaths({dataDirectory:argument('--data-dir')||argument('--runtime')}),runtime=paths.dataDirectory,operationId=argument('--operation');
if(existsSync(paths.identityFile))applyApplicationCache(runtime);
const active=()=>{const a=activeBusinessConfig(runtime);if(!a)throw Error('BUSINESS_NOT_PREPARED');return {...a,config:loadConfig(a.file)};};
async function privateInput(){let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>4096)throw Error('SETUP_INPUT_LIMIT');}try{return JSON.parse(text);}catch{throw Error('SETUP_PRIVATE_INPUT_REQUIRED');}}
try{
 let result;
 if(['prepare','initialize'].includes(command)){const prepared=prepareFreshBusiness(runtime);result={prepared:true,alreadyPrepared:prepared.alreadyPrepared,executionEnabled:false,botId:prepared.config.binding.botId};}
 else if(command==='self-test'){const c=prepareFreshBusiness(runtime).config;result=await runCodexSelfTest(c,{operationId});if(!result.accepted||result.runtimeEvidence!=='actual-current-cli')process.exitCode=1;}
 else if(command==='pair'){const c=prepareFreshBusiness(runtime).config,input=await privateInput();if(input.operationId!==operationId)throw Error('SETUP_OPERATION_CHANGED');result=await runPairing(c,{operationId,code:input.code,expiresAt:input.expiresAt});if(result.paired&&c.automaticSetup?.enabled===true)result.automaticFeatures=configureFirstRunFeatures(runtime,c.file);}
 else if(command==='native-start'){const a=active(),configured=prepareNativeOnlyBusiness(runtime,a.file);if(configured.configured)await runBusiness(loadConfig(a.file));result={nativeOnly:true,configured:configured.configured,waitingForDesktop:!configured.configured,stopped:configured.configured};}
 else if(command==='activate'){const c=activateFreshBusiness(runtime);await runBusiness(c);result={stopped:true};}
 else if(command==='serve'){const a=active();if(a.config.serviceMode==='native-only'){const configured=prepareNativeOnlyBusiness(runtime,a.file);if(!configured.configured)throw Error(configured.reason||'NATIVE_DESKTOP_HOME_NOT_READY');}await runBusiness(loadConfig(a.file));result={stopped:true};}
 else if(command==='status'){
  const a=activeBusinessConfig(runtime);if(!a)result={configured:false};else{const c=loadConfig(a.file),status=path.join(c.stateDir,'service.json');result={configured:true,botId:c.binding.botId,agentId:c.binding.agentId,executionEnabled:c.executor.enabled,service:existsSync(status)?JSON.parse(readFileSync(status,'utf8')):{state:'not_started'}};}
 }else if(command==='stop'){const c=active().config,s=JSON.parse(readFileSync(path.join(c.stateDir,'service.json'),'utf8'));atomicJson(path.join(c.stateDir,'stop.request.json'),{instance:s.instance});result={stopRequested:true};}
 else throw Error('BUSINESS_COMMAND_UNSUPPORTED');
 if(operationId&&command!=='activate')atomicJson(path.join(runtime,'setup-result-'+operationId+'.json'),{schemaVersion:1,operationId,kind:command,result});
 console.log(JSON.stringify({command,...(result?.operationId?{operationId:result.operationId}:{}),prepared:result?.prepared,paired:result?.paired,accepted:result?.accepted,configured:result?.configured,stopped:result?.stopped}));
}catch(error){const code=/^[A-Z_]+$/.test(error.message)?error.message:'BUSINESS_OPERATION_FAILED';atomicJson(path.join(runtime,'business-last-error.json'),{command,error:code,time:new Date().toISOString()});if(operationId)atomicJson(path.join(runtime,'setup-result-'+operationId+'.json'),{schemaVersion:1,operationId,kind:command,error:code});console.error(JSON.stringify({error:code}));process.exitCode=1;}
