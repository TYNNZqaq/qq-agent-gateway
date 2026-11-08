import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
const entry=fileURLToPath(new URL('../packages/host-control/cli.mjs',import.meta.url));
async function start(directory){
 const child=spawn(process.execPath,[entry,'serve','--data-dir',directory,'--port','0'],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']}),ended=new Promise(resolve=>child.once('exit',resolve));let diagnostics='';child.stderr.on('data',bytes=>{diagnostics+=bytes.toString().slice(0,1000);});child.stdout.on('data',()=>{});
 const file=path.join(directory,'management-service.json');let metadata;
 for(let i=0;i<100;i++){if(existsSync(file)){const m=JSON.parse(readFileSync(file));if(m.pid===child.pid&&m.status==='running'){metadata=m;break;}}if(child.exitCode!==null)throw Error('FRESH_START_FAILED '+diagnostics);await new Promise(r=>setTimeout(r,30));}
 if(!metadata){child.kill();await ended;throw Error('FRESH_START_UNCONFIRMED');}
 const stop=async()=>{writeFileSync(path.join(directory,'management-stop.request'),JSON.stringify({instance:metadata.instance}));const timeout=setTimeout(()=>child.kill(),5000);try{assert.equal(await ended,0);}finally{clearTimeout(timeout);}};
 try{const boot=await fetch(metadata.url+'/api/bootstrap'),cookie=boot.headers.get('set-cookie').split(';')[0],csrf=(await boot.json()).csrf;
 const request=async(route,body)=>fetch(metadata.url+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:metadata.url,'X-CSRF-Token':csrf,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {directory,metadata,request,stop};
 }catch(error){await stop();throw error;}
}
test('clean CLI startup needs no legacy files, opens independent empty stores, keeps identities through restart and never adopts developer login or consent',async()=>{
 const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'fresh-user-cli-')),directoryA=path.join(root,'instance-a'),directoryB=path.join(root,'instance-b'),a=await start(directoryA);let b,restarted;
 try{
  b=await start(directoryB);assert.notEqual(a.metadata.url,b.metadata.url);await assert.rejects(start(directoryA),/MANAGEMENT_ALREADY_RUNNING/);assert.equal(JSON.parse(readFileSync(path.join(directoryA,'management-service.json'))).pid,a.metadata.pid);
  const stateA=await(await a.request('/api/state')).json(),stateB=await(await b.request('/api/state')).json();
  for(const state of [stateA,stateB]){assert.equal(state.bots.length,0);assert.equal(state.agents.length,0);assert.equal(state.bindings.length,0);assert.equal(state.business.configured,false);assert.equal(state.codexAccount.agentId,null);assert.equal(state.codexAccount.account.status,'not_checked');assert.equal(state.codexWork.verified,false);assert.equal(state.setup.available,true);assert.equal(state.setup.privacy.confirmed,false);assert.deepEqual(state.setup.projects,[]);}
  const identityA=JSON.parse(readFileSync(path.join(directoryA,'instance.json'))),identityB=JSON.parse(readFileSync(path.join(directoryB,'instance.json')));assert.notEqual(identityA.hostId,identityB.hostId);assert.notEqual(identityA.instanceId,identityB.instanceId);assert.notEqual(stateA.codexAccount.connectionId,stateB.codexAccount.connectionId);
  for(const directory of [directoryA,directoryB])for(const file of ['local-paths.json','integration-current.json','consent.json','codex-account/home/auth.json','codex-account-work/accepted.json'])assert.equal(existsSync(path.join(directory,file)),false);
  const created=await a.request('/api/bots',{name:'Synthetic first-instance bot',expectedRevision:0});assert.equal(created.status,200);assert.equal((await(await b.request('/api/state')).json()).bots.length,0);
  await a.stop();restarted=await start(directoryA);const after=await(await restarted.request('/api/state')).json();assert.equal(after.bots.length,1);assert.deepEqual(JSON.parse(readFileSync(path.join(directoryA,'instance.json'))),identityA);assert.equal(after.codexAccount.selectedModel,null);
 }finally{if(restarted)await restarted.stop();else if(a)await a.stop();if(b)await b.stop();}
});
