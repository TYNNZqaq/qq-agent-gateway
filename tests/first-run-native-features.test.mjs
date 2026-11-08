import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {firstRunFixture} from './first-run-fixture.mjs';
import {prepareFreshBusiness,activateFreshBusiness} from '../packages/application/fresh-bootstrap.mjs';
import {configureFirstRunFeatures,prepareNativeOnlyBusiness} from '../packages/application/first-run-features.mjs';
import {nativeDesktopLocation} from '../packages/host-control/native-desktop-location.mjs';
import {runBusiness} from '../packages/application/business-runtime.mjs';
import {Store} from '../packages/application/store.mjs';
import {connectionDecision} from '../packages/host-control/desktop-autoconnect.mjs';
import {SetupController} from '../packages/host-control/setup-controller.mjs';
import {randomUUID} from 'node:crypto';
const read=f=>JSON.parse(readFileSync(f,'utf8'));
const prepare=f=>prepareFreshBusiness(f.paths.dataDirectory,{executable:process.execPath,featureOptions:f.featureOptions}).config;

test('fresh native-only setup configures notifications, original Q and owner control without granting a work project',t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f);
 assert.equal(c.serviceMode,'native-only');assert.equal(c.executor.enabled,false);assert.deepEqual(c.projects,{});assert.equal(c.desktopNotifications.scope,'all-local');assert.equal(c.desktopNotifications.home,f.desktopHome);assert.equal(c.nativeDesktopQuestions.home,f.desktopHome);assert.equal(c.nativeDesktopControl.transport,'codex-ipc');assert.equal(c.automaticSetup.state,'configured');assert.equal(existsSync(path.join(f.paths.dataDirectory,'codex-account-work','accepted.json')),false);
});
test('native feature consent is separate from legacy consent and old instances are not silently enrolled',t=>{
 const f=firstRunFixture({desktopConsent:false,grants:true});t.after(()=>f.close());const c=prepare(f);assert.equal(c.serviceMode,undefined);assert.equal(c.automaticSetup,undefined);assert.equal(c.desktopNotifications.enabled,false);assert.equal(c.nativeDesktopControl.enabled,false);
});
test('missing desktop history creates no foreign directory and leaves a clear deferred setup state',t=>{
 const f=firstRunFixture({desktop:false});t.after(()=>f.close());const c=prepare(f);assert.equal(c.automaticSetup.state,'waiting-for-desktop');assert.equal(c.automaticSetup.reason,'NATIVE_DESKTOP_HOME_NOT_READY');assert.equal(c.nativeDesktopControl.enabled,false);assert.equal(existsSync(f.desktopHome),false);
 mkdirSync(path.join(f.desktopHome,'sessions'),{recursive:true});writeFileSync(path.join(f.desktopHome,'state_5.sqlite'),'synthetic');const configured=configureFirstRunFeatures(f.paths.dataDirectory,c.file,f.featureOptions);assert.equal(configured.configured,true);assert.equal(read(c.file).nativeDesktopControl.enabled,true);
});
test('repeated automatic feature configuration preserves the original observation boundary and exact bytes',t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f),before=readFileSync(c.file);const result=configureFirstRunFeatures(f.paths.dataDirectory,c.file,{...f.featureOptions,now:()=>Date.now()+1000});assert.equal(result.changed,false);assert.ok(before.equals(readFileSync(c.file)));assert.equal(read(c.file).desktopNotifications.since,c.desktopNotifications.since);
});
test('a live business never has its configuration fingerprint rewritten by automatic setup',t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f),before=readFileSync(c.file);writeFileSync(path.join(c.stateDir,'service.json'),JSON.stringify({pid:1234,state:'running'}));assert.throws(()=>configureFirstRunFeatures(f.paths.dataDirectory,c.file,{...f.featureOptions,pidAlive:()=>true}),/BUSINESS_STOP_FIRST/);assert.ok(before.equals(readFileSync(c.file)));
});
test('a user feature switch is preserved instead of being enabled again at the next connection',t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f),raw=read(c.file);raw.nativeDesktopControl.enabled=false;writeFileSync(c.file,JSON.stringify(raw));const before=readFileSync(c.file),result=configureFirstRunFeatures(f.paths.dataDirectory,c.file,f.featureOptions);assert.equal(result.reason,'NATIVE_FEATURES_CUSTOMIZED');assert.ok(before.equals(readFileSync(c.file)));assert.equal(read(c.file).nativeDesktopControl.enabled,false);
});
test('disabling automatic feature configuration is durable and does not prevent static native-only service settings',t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f),raw=read(c.file);raw.automaticSetup.enabled=false;raw.nativeDesktopControl.enabled=false;writeFileSync(c.file,JSON.stringify(raw));const store=new Store(c.stateDir,{numberingConfig:c});store.set('owner',JSON.stringify(['12345','c2c','synthetic-person']));store.close();const before=readFileSync(c.file),result=prepareNativeOnlyBusiness(f.paths.dataDirectory,c.file,f.featureOptions);assert.equal(result.reason,'AUTOMATIC_FEATURES_DISABLED');assert.ok(before.equals(readFileSync(c.file)));
});
test('automatic configuration cannot adopt a different account binding or create a pairing owner',t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f);assert.throws(()=>prepareNativeOnlyBusiness(f.paths.dataDirectory,c.file,f.featureOptions),/SETUP_QQ_PAIRING_REQUIRED/);const raw=read(c.file);raw.accountConnectionId='different-account';writeFileSync(c.file,JSON.stringify(raw));assert.throws(()=>configureFirstRunFeatures(f.paths.dataDirectory,c.file,f.featureOptions),/BUSINESS_BINDING_CHANGED/);
});
test('desktop location discovery rejects private data overlap and does not probe an alternative after an explicit bad choice',t=>{
 const f=firstRunFixture();t.after(()=>f.close());assert.equal(nativeDesktopLocation({environment:{CODEX_HOME:f.paths.dataDirectory},privateRoots:[f.paths.dataDirectory]}).reason,'NATIVE_DESKTOP_HOME_OVERLAP');assert.equal(nativeDesktopLocation({environment:{CODEX_HOME:path.join(f.root,'missing')},home:f.root}).ready,false);
});
test('native-only activation keeps the real model proof gate closed and desktop auto-connect accepts its separate service readiness',t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f);assert.throws(()=>activateFreshBusiness(f.paths.dataDirectory),/CODEX_WORK_NOT_VERIFIED/);assert.equal(read(c.file).executor.enabled,false);assert.equal(connectionDecision({business:{configured:true,paired:true,executionConfigured:false,serviceConfigured:true}}),'start');
});
test('native-only runtime connects the synthetic QQ transport while never invoking the independent model factory',async t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f),store=new Store(c.stateDir,{numberingConfig:c});store.set('owner',JSON.stringify(['12345','c2c','synthetic-person']));store.close();
 let finish,started,stopped=false;const transport={bot:new EventEmitter(),onMessage(handler){this.receive=handler;},async send(){throw Error('NO_TEST_SEND_EXPECTED');},start(signal){return new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>this.stop(),{once:true});this.bot.emit('ready');started=read(path.join(c.stateDir,'service.json'));setTimeout(()=>this.stop(),20);});},stop(){if(stopped)return;stopped=true;finish?.();}};
 await runBusiness(c,{transportFactory:async()=>transport,workFactory:()=>assert.fail('independent model factory must remain unused')});assert.equal(started.qqConnected,true);assert.equal(started.executionEnabled,false);assert.equal(started.observationOnly,true);assert.equal(started.executionBlockedReason,'CODEX_WORK_NOT_VERIFIED');assert.equal(read(c.file).executor.enabled,false);assert.equal(existsSync(path.join(f.paths.dataDirectory,'codex-account-work','accepted.json')),false);
});
test('reconfirming an unchanged first-run scope preserves its consent identity and permits guarded native-only startup',async t=>{
 const f=firstRunFixture();t.after(()=>f.close());const c=prepare(f),beforeConfig=readFileSync(c.file),beforeConsent=readFileSync(f.paths.consentFile),store=new Store(c.stateDir,{numberingConfig:c});store.set('owner',JSON.stringify(['12345','c2c','synthetic-person']));store.close();
 const setup=new SetupController({paths:f.paths,identity:f.identity,managementStore:f.management,accountControl:{data:f.account,snapshot:()=>({associationValid:true,account:{status:'authenticated'}})},businessControl:{snapshot:()=>({configured:true,paired:true,running:false,pending:false})}});t.after(()=>setup.close());
 setup.consent({operationId:randomUUID(),botId:f.bot.id,accepted:true,expectedSetupRevision:setup.data.revision},'reopened-window');assert.equal(setup.automaticSessionId,'reopened-window');assert.ok(beforeConsent.equals(readFileSync(f.paths.consentFile)));assert.ok(beforeConfig.equals(readFileSync(c.file)));assert.equal(read(c.file).externalUseConsent.id,read(f.paths.consentFile).id);assert.equal(prepareNativeOnlyBusiness(f.paths.dataDirectory,c.file,f.featureOptions).configured,true);
 let finish,started,stopped=false;const transport={bot:new EventEmitter(),onMessage(handler){this.receive=handler;},async send(){throw Error('NO_TEST_SEND_EXPECTED');},start(signal){return new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>this.stop(),{once:true});this.bot.emit('ready');started=read(path.join(c.stateDir,'service.json'));setTimeout(()=>this.stop(),20);});},stop(){if(stopped)return;stopped=true;finish?.();}};
 await runBusiness(c,{transportFactory:async()=>transport,workFactory:()=>assert.fail('independent model factory must remain unused')});assert.equal(started.qqConnected,true);assert.equal(started.executionEnabled,false);assert.equal(existsSync(path.join(f.paths.dataDirectory,'codex-account-work','accepted.json')),false);
});
