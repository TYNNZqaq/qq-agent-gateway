import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,utimesSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {prepareSource,inspectSource,isPublicSourcePath,sealSource} from '../scripts/build-source.mjs';
import {prepareRelease,sealRelease,inspectRelease} from '../scripts/build-release.mjs';
import {packageArchives,deterministicZip,crc32} from '../scripts/build-archives.mjs';
import {privacyErrors,hashBytes} from '../scripts/release-policy.mjs';

function fixture(){
 const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'public-release-')),source=path.join(root,'source'),program=path.join(root,'program');
 prepareSource(source);prepareRelease(program);
 const lock=JSON.parse(readFileSync(path.join(program,'package-lock.json')));
 for(const [relative,value]of Object.entries(lock.packages)){if(!relative)continue;mkdirSync(path.join(program,relative),{recursive:true});writeFileSync(path.join(program,relative,'package.json'),JSON.stringify({version:value.version}));}
 sealRelease(program);return {root,source,program};
}
function unzipStored(bytes){
 const entries=new Map();let at=0;
 while(bytes.readUInt32LE(at)===0x04034b50){
  assert.equal(bytes.readUInt16LE(at+6),0x800);assert.equal(bytes.readUInt16LE(at+8),0);assert.equal(bytes.readUInt16LE(at+12),0x21);
  const size=bytes.readUInt32LE(at+18),length=bytes.readUInt16LE(at+26),extra=bytes.readUInt16LE(at+28),name=bytes.subarray(at+30,at+30+length).toString('utf8'),start=at+30+length+extra,body=bytes.subarray(start,start+size);
  assert.equal(crc32(body),bytes.readUInt32LE(at+14));entries.set(name,body);at=start+size;
 }
 assert.equal(bytes.readUInt32LE(at),0x02014b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);assert.equal(entries.size,bytes.readUInt16LE(bytes.length-12));return entries;
}
test('open-source export uses only reviewed paths and portable launchers with all public licenses',()=>{
 const f=fixture(),audit=inspectSource(f.source);assert.equal(audit.passed,true,JSON.stringify(audit.errors));
 for(const file of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','AGENTS.md','docs/USER-GUIDE.md','docs/AGENT-TEAM.md','licenses/codex-LICENSE.txt','licenses/codex-NOTICE.txt','docs/g1/config.synthetic.json','scripts/build-source.mjs','scripts/build-archives.mjs','docs/ci/windows-ci.yml'])assert.ok(existsSync(path.join(f.source,file)),file);
 for(const file of ['installation.local.json','.npmrc','node_modules','docs/g1/STATUS.md','QQ插件运行目录','scripts/Start-Installed.ps1','scripts/probe-runtimes.mjs','scripts/finalize-codex-qq-integration.mjs','scripts/resume-owner-clarified-validation.mjs'])assert.equal(existsSync(path.join(f.source,file)),false,file);
 for(const file of ['安装.cmd','打开管理界面.cmd','停止管理界面.cmd'])assert.doesNotMatch(readFileSync(path.join(f.source,file),'utf8'),/Start-Installed|installation\.local/);
 const pkg=JSON.parse(readFileSync(path.join(f.source,'package.json')));assert.equal(pkg.license,'MIT');assert.equal(pkg.scripts.probe,undefined);
});
test('public source path policy rejects traversals, private histories and unexpected operational files',()=>{
 for(const file of ['../README.md','/README.md','packages/../auth.json','packages\\host-control\\private.mjs','node_modules/ws/index.js','docs/g1/STATUS.md','docs/g1/secrets.json','scripts/verify-migrated-work.mjs','tests/private.json','.npmrc','installation.local.json'])assert.equal(isPublicSourcePath(file),false,file);
 assert.equal(isPublicSourcePath('tests/fixtures/codex/reviewed-alpha6-protocol.json'),true);assert.equal(isPublicSourcePath('packages/host-control/setup-controller.mjs'),true);
});
test('artifact audits reject injected private values, credential files and recognizable real key formats',()=>{
 const f=fixture(),value='SYNTHETIC_PRIVATE_VALUE_'+randomUUID(),readme=path.join(f.source,'README.md');writeFileSync(readme,readFileSync(readme,'utf8')+'\n'+value);
 assert.equal(inspectSource(f.source,{forbiddenValues:[value]}).passed,false);assert.throws(()=>sealSource(f.source,{forbiddenValues:[value]}),/SOURCE_PRIVATE_AUDIT_FAILED/);
 const auth=path.join(f.program,'packages','auth.json');writeFileSync(auth,'{}');assert.equal(inspectRelease(f.program).passed,false);
 const values=[['gh','p_', 'X'.repeat(36)].join(''),['github','_pat_', 'X'.repeat(40)].join(''),['sk','-proj-', 'x'.repeat(36)].join(''),['-----BEGIN ','PRIVATE KEY-----'].join('')];
 for(const content of values)assert.ok(privacyErrors('README.md',Buffer.from(content)).some(e=>e.reason==='credential-marker'));
});
test('published synthetic rejection fixtures remain valid without broad credential exemptions',()=>{
 const content=['sk','-synthetic-model-key-123456'].join('');assert.deepEqual(privacyErrors('tests/qq-connection.test.mjs',Buffer.from(content)),[]);
 assert.ok(privacyErrors('README.md',Buffer.from(content)).length);
 const actualShape=['sk','-', 'Y'.repeat(36)].join('');assert.ok(privacyErrors('tests/qq-connection.test.mjs',Buffer.from(actualShape)).length);
});
test('source audit rejects extra files rather than silently adding them to an open-source archive',()=>{
 const f=fixture(),file=path.join(f.source,'private-export.txt');writeFileSync(file,'must remain local');assert.equal(inspectSource(f.source).passed,false);assert.throws(()=>packageArchives(f.source,f.program,path.join(f.root,'archives')),/ARCHIVE_PRIVATE_AUDIT_FAILED/);
});
test('deterministic ZIP preserves Unicode names, bytes, CRC and stable ordering with no path escapes',()=>{
 const entries=[{name:'项目/启动.cmd',bytes:Buffer.from('中文\r\n')},{name:'项目/LICENSE',bytes:Buffer.from('MIT\n')}],zip=deterministicZip(entries);
 assert.deepEqual(zip,deterministicZip([...entries].reverse()));const unpacked=unzipStored(zip);assert.deepEqual(unpacked.get('项目/启动.cmd'),entries[0].bytes);assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
 for(const name of ['../secret','/secret','nested/../secret','nested\\secret','nested//secret'])assert.throws(()=>deterministicZip([{name,bytes:Buffer.from('x')}]));
 assert.throws(()=>deterministicZip([{name:'A',bytes:[]},{name:'a',bytes:[]}]),/ENTRY_INVALID/);
});
test('both release archives reproduce exactly and their checksums cover the full downloadable files',()=>{
 const f=fixture(),first=packageArchives(f.source,f.program,path.join(f.root,'archives-one'));
 utimesSync(path.join(f.source,'README.md'),0,0);utimesSync(path.join(f.program,'README.md'),Date.now()/1000,Date.now()/1000);
 const second=packageArchives(f.source,f.program,path.join(f.root,'archives-two'));
 assert.deepEqual(first.archives,second.archives);assert.equal(first.archives.length,2);
 const checksums=readFileSync(path.join(first.directory,'SHA256SUMS'),'utf8');
 for(const artifact of first.archives){const bytes=readFileSync(path.join(first.directory,artifact.file));assert.equal(hashBytes(bytes),artifact.sha256);assert.ok(checksums.includes(artifact.sha256+'  '+artifact.file));assert.deepEqual(bytes,readFileSync(path.join(second.directory,artifact.file)));const unpacked=unzipStored(bytes);assert.equal(unpacked.size,artifact.files);assert.equal([...unpacked.keys()].some(name=>name.includes('/.git/')||name.includes('/installation.local.json')),false);}
});
test('packaging requires unchanged sealed source and program manifests',()=>{
 const f=fixture();writeFileSync(path.join(f.source,'README.md'),readFileSync(path.join(f.source,'README.md'),'utf8')+'\nchanged');assert.throws(()=>packageArchives(f.source,f.program,path.join(f.root,'archives')),/ARCHIVE_MANIFEST_CHANGED/);
 const other=fixture();writeFileSync(path.join(other.program,'README.md'),readFileSync(path.join(other.program,'README.md'),'utf8')+'\nchanged');assert.throws(()=>packageArchives(other.source,other.program,path.join(other.root,'archives')),/ARCHIVE_MANIFEST_CHANGED/);
});
test('public Markdown links close within each downloadable artifact',()=>{
 const f=fixture();
 for(const root of [f.source,f.program])for(const file of ['README.md','THIRD_PARTY_NOTICES.md','AGENTS.md','docs/USER-GUIDE.md','docs/AGENT-TEAM.md',...(root===f.program?['用户指南.md']:[])]){
  const text=readFileSync(path.join(root,file),'utf8').replace(/```[\s\S]*?```/g,'');
  for(const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)){
   const link=match[1];if(/^(?:[a-z]+:|#)/i.test(link))continue;
   const target=path.resolve(root,path.dirname(file),decodeURIComponent(link.split('#')[0]));
   assert.ok(!path.relative(root,target).startsWith('..')&&existsSync(target),file+' -> '+link);
  }
 }
});
test('Git stages the exact manifest bytes even when automatic newline conversion is enabled',t=>{
 const available=spawnSync('git',['--version'],{windowsHide:true,encoding:'utf8'});if(available.status!==0){t.skip('Git is not installed');return;}
 const f=fixture(),run=(args,options={})=>{const r=spawnSync('git',['-C',f.source,...args],{windowsHide:true,...options});assert.equal(r.status,0,r.stderr?.toString());return r.stdout;};
 run(['init','--quiet']);run(['-c','core.autocrlf=true','add','--all']);
 const manifest=JSON.parse(readFileSync(path.join(f.source,'SOURCE-MANIFEST.json'))),tracked=run(['ls-files','-z']).toString('utf8').split('\0').filter(Boolean).sort();
 assert.deepEqual(tracked,[...manifest.files.map(row=>row.file),'SOURCE-MANIFEST.json'].sort());
 for(const file of ['README.md','package.json','安装.cmd','scripts/Install.ps1','scripts/Desktop-AutoConnect.psm1'])assert.deepEqual(run(['show',':'+file]),readFileSync(path.join(f.source,file)),file);
 assert.equal(inspectSource(f.source).passed,true);
});
test('Windows archive extraction accepts the UTF-8 ZIP without altering contents',{skip:process.platform!=='win32'},()=>{
 const root=mkdtempSync(path.join(process.env.QQ_TEST_ROOT,'zip-extract-')),file=path.join(root,'archive.zip'),output=path.join(root,'out');writeFileSync(file,deterministicZip([{name:'包/中文 文件.txt',bytes:Buffer.from('exact bytes\n')}]));
 const script="$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:QQ_TEST_ZIP,$env:QQ_TEST_UNZIP)";
 const r=spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,QQ_TEST_ZIP:file,QQ_TEST_UNZIP:output},windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(path.join(output,'包','中文 文件.txt'),'utf8'),'exact bytes\n');
});
