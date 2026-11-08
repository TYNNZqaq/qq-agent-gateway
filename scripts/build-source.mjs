import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {checked,freshDestination,copyReviewedFile,writePortableLaunchers,lockedPackage,writePackage,walkFiles,privacyErrors,hashBytes,order,PUBLIC_DOCUMENTS,SOURCE_SCRIPTS,COMMAND_FILES} from './release-policy.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixtureNames=new Set(['tests/fixtures/host-event-fixture.mjs','tests/fixtures/journal-cas-worker.mjs','tests/fixtures/offline-host-v1.mjs','tests/fixtures/sqlite-journal-v1.mjs','tests/fixtures/offline-host-v1-source.json','tests/fixtures/work-store-v1.sql','tests/fixtures/work-store-v2.sql','tests/fixtures/codex/current-account-protocol.json','tests/fixtures/codex/current-profile-protocol.json','tests/fixtures/codex/current-session-protocol.json','tests/fixtures/codex/current-work-protocol.json','tests/fixtures/codex/pinned-protocol.json','tests/fixtures/codex/reviewed-alpha6-protocol.json']);
const fixed=new Set([...PUBLIC_DOCUMENTS,...SOURCE_SCRIPTS,...COMMAND_FILES,'package.json','package-lock.json','.gitignore','.gitattributes','docs/ci/windows-ci.yml','docs/g1/config.synthetic.json','licenses/codex-LICENSE.txt','licenses/codex-NOTICE.txt']);
export function isPublicSourcePath(file){
 if(file.includes('\\')||file.startsWith('/')||file.split('/').some(p=>p==='..'||p==='.'||!p))return false;
 if(fixed.has(file))return true;
 if(/^packages\/(?:core|storage|gateway-qq|adapters\/codex|host-control|application|management-ui)\/[A-Za-z0-9._/-]+\.(?:mjs|js|css|html|svg)$/.test(file))return true;
 if(/^tests\/(?:preserved\/)?[A-Za-z0-9._-]+\.test\.mjs$/.test(file))return true;
 if(['tests/foundation-fixtures.mjs','tests/helpers/fresh-context.mjs','tests/first-run-fixture.mjs'].includes(file))return true;
 return fixtureNames.has(file);
}
function exportFiles(){
 const files=new Set(fixed);
 // Only these reviewed code trees are enumerated. Runtime and historical docs
 // are never walked, even if they happen to have source-looking extensions.
 for(const root of ['packages','tests'])for(const row of walkFiles(path.join(source,root))){
  const file=path.posix.join(root,row.file);if(!isPublicSourcePath(file))throw Object.assign(Error('SOURCE_FILE_REQUIRES_REVIEW'),{file});files.add(file);
 }
 return [...files].sort(order);
}
export function inspectSource(directory,{forbiddenValues=[]}={}){
 const root=checked(directory),errors=[],files=[];
 for(const row of walkFiles(root,{skipGit:true})){
  if(row.file!=='SOURCE-MANIFEST.json'&&!isPublicSourcePath(row.file))errors.push({file:row.file,reason:'outside-source-whitelist'});
  const bytes=readFileSync(row.full);errors.push(...privacyErrors(row.file,bytes,{forbiddenValues}));
  if(row.file!=='SOURCE-MANIFEST.json')files.push({file:row.file,bytes:row.bytes,sha256:hashBytes(bytes)});
 }
 for(const file of fixed)if(!existsSync(path.join(root,file)))errors.push({file,reason:'source-required-file-missing'});
 const {pkg}=lockedPackage(root);return {passed:!errors.length,version:pkg.version,files,errors,containsUserData:false,containsDependencies:false};
}
export function sealSource(directory,options){
 const audit=inspectSource(directory,options);if(!audit.passed)throw Object.assign(Error('SOURCE_PRIVATE_AUDIT_FAILED'),{audit});
 const manifest={schemaVersion:1,kind:'qq-agent-open-source-release',version:audit.version,containsUserData:false,containsDependencies:false,files:audit.files};
 writeFileSync(path.join(directory,'SOURCE-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
 return {passed:true,version:audit.version,files:audit.files.length,manifestSha256:hashBytes(readFileSync(path.join(directory,'SOURCE-MANIFEST.json')))};
}
export function prepareSource(destination,options){
 const root=freshDestination(source,destination),files=exportFiles(),packageData=lockedPackage(source);
 mkdirSync(root,{recursive:true});for(const file of files)copyReviewedFile(source,root,file);
 writePackage(root,packageData);writePortableLaunchers(root);
 return {...sealSource(root,options),directory:root};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,directory]=process.argv.slice(2);
 if(command==='prepare')console.log(JSON.stringify(prepareSource(directory)));else if(command==='inspect')console.log(JSON.stringify(inspectSource(directory)));else if(command==='seal')console.log(JSON.stringify(sealSource(directory)));else throw Error('SOURCE_COMMAND_REQUIRED');
}
