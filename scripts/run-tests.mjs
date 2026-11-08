import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {resolveApplicationPaths} from '../packages/host-control/application-paths.mjs';
import {prepareApplicationCache} from '../packages/host-control/application-cache.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Explicit test roots must not evaluate the real application's default data
// location first (a source checkout may live on the Windows system volume).
const testRoot=process.env.QQ_TEST_ROOT?path.resolve(process.env.QQ_TEST_ROOT):path.resolve(resolveApplicationPaths({environment:{},home:os.homedir()}).dataDirectory,'../..','tests',randomUUID());mkdirSync(testRoot,{recursive:true});
const out=process.env.QQ_TEST_EVIDENCE_ROOT?path.resolve(process.env.QQ_TEST_EVIDENCE_ROOT):path.join(testRoot,'verification');mkdirSync(out,{recursive:true});
const evidenceName=process.env.QQ_TEST_EVIDENCE_NAME||'g1-tests';
if(!/^[a-z0-9][a-z0-9-]{0,95}$/.test(evidenceName))throw Error('INVALID_TEST_EVIDENCE_NAME');
const files=readdirSync(path.join(root,'tests')).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>path.join(root,'tests',f));
const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',...files],{cwd:root,env:{...process.env,...prepareApplicationCache(testRoot),QQ_TEST_ROOT:testRoot},encoding:'utf8',windowsHide:true,timeout:90000});
const transcript=(result.stdout||'')+(result.stderr||'');
writeFileSync(path.join(out,evidenceName+'.tap'),transcript);
const count=name=>Number(transcript.match(new RegExp('# '+name+' (\\d+)'))?.[1]||0);
const summary={passed:result.status===0,exitCode:result.status,signal:result.signal,errorCode:result.error?.code??null,tests:count('tests'),pass:count('pass'),fail:count('fail'),time:new Date().toISOString(),evidence:['synthetic','real local HTTP','no model generation','no QQ connection']};
writeFileSync(path.join(out,evidenceName+'.json'),JSON.stringify(summary,null,2));
console.log(transcript);console.log(JSON.stringify(summary,null,2));process.exitCode=result.status===0?0:1;
