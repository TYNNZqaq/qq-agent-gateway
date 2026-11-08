import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {importsOf} from './check-boundaries.mjs';
import {checked,freshDestination,copyReviewedFile,writePortableLaunchers,lockedPackage,writePackage,walkFiles,privacyErrors,hashBytes,order,PUBLIC_DOCUMENTS,PROGRAM_SCRIPTS,COMMAND_FILES} from './release-policy.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(readFileSync(path.join(source,'package.json'),'utf8')).version;
function programFiles(){
 const pending=['packages/host-control/cli.mjs','packages/application/cli.mjs','packages/application/client-question-mcp.mjs','packages/host-control/desktop-autoconnect.mjs'],files=new Set();
 while(pending.length){
  const file=pending.pop();if(files.has(file))continue;
  if(!file.startsWith('packages/')||file.includes('..'))throw Error('RELEASE_IMPORT_OUTSIDE_PROGRAM');
  const absolute=checked(path.join(source,file)),text=readFileSync(absolute,'utf8');files.add(file);
  const imports=importsOf(text);if(imports.opaque||imports.escaped)throw Error('RELEASE_UNREVIEWED_IMPORT');
  for(const spec of imports.imports){if(spec.startsWith('.'))pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file),spec)));else if(!spec.startsWith('node:')&&spec!=='@tencent-connect/qqbot-nodejs')throw Error('RELEASE_UNREVIEWED_DEPENDENCY');}
 }
 for(const file of ['packages/management-ui/index.html','packages/management-ui/app.js','packages/management-ui/styles.css','packages/management-ui/favicon.svg',...PROGRAM_SCRIPTS,...COMMAND_FILES,...PUBLIC_DOCUMENTS])files.add(file);
 return [...files].sort(order);
}
export function prepareRelease(destination){
 const target=freshDestination(source,destination),files=programFiles(),packageData=lockedPackage(source,{programOnly:true});
 mkdirSync(target,{recursive:true});for(const file of files)copyReviewedFile(source,target,file);
 writePortableLaunchers(target);writePackage(target,packageData);
 writeFileSync(path.join(target,'用户指南.md'),'# 用户指南\n\n请阅读 [完整用户指南](docs/USER-GUIDE.md)、[项目介绍](README.md) 和 [Agent 团队说明](docs/AGENT-TEAM.md)。\n');
 return {version,directory:target,sourceFiles:files.length,dependencyInstallRequired:true};
}
export function inspectRelease(directory,{forbiddenValues=[]}={}){
 const target=checked(directory),errors=[],files=[],allowed=new Set([...programFiles(),'package.json','package-lock.json','用户指南.md','MANIFEST.json']);
 for(const row of walkFiles(target)){
  if(!allowed.has(row.file)&&!row.file.startsWith('node_modules/'))errors.push({file:row.file,reason:'outside-release-whitelist'});
  const bytes=readFileSync(row.full);errors.push(...privacyErrors(row.file,bytes,{forbiddenValues}));
  if(row.file!=='MANIFEST.json')files.push({file:row.file,bytes:row.bytes,sha256:hashBytes(bytes)});
 }
 const {pkg,lock}=lockedPackage(target,{programOnly:true});
 if(pkg.version!==version)errors.push({file:'package.json',reason:'release-version-mismatch'});
 for(const [relative,entry]of Object.entries(lock.packages)){
  if(!relative)continue;
  const file=path.join(target,relative,'package.json');
  if(!existsSync(file)||JSON.parse(readFileSync(file,'utf8')).version!==entry.version)errors.push({file:relative,reason:'locked-dependency-missing-or-changed'});
 }
 for(const file of [...allowed].filter(file=>file!=='MANIFEST.json'))if(!existsSync(path.join(target,file)))errors.push({file,reason:'release-required-file-missing'});
 return {passed:errors.length===0,version,files:files.sort((a,b)=>order(a.file,b.file)),errors,privateValuesChecked:forbiddenValues.length+2,dependenciesLocked:true};
}
export function sealRelease(directory,options){
 const result=inspectRelease(directory,options);if(!result.passed)throw Object.assign(Error('RELEASE_PRIVATE_AUDIT_FAILED'),{audit:result});
 const manifest={schemaVersion:1,kind:'qq-agent-clean-program-release',version:result.version,files:result.files,dependenciesLocked:true,containsUserData:false};
 writeFileSync(path.join(directory,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
 return {passed:true,version,files:manifest.files.length,manifestSha256:hashBytes(readFileSync(path.join(directory,'MANIFEST.json')))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,directory]=process.argv.slice(2);
 if(command==='prepare')console.log(JSON.stringify(prepareRelease(directory)));else if(command==='seal')console.log(JSON.stringify(sealRelease(directory)));else if(command==='inspect')console.log(JSON.stringify(inspectRelease(directory)));else throw Error('RELEASE_COMMAND_REQUIRED');
}
