import path from 'node:path';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {writeApplicationJson} from './application-paths.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function diagnosticsPreview({identity,setup,business={}}){
 const preview={schemaVersion:1,kind:'qq-agent-redacted-local-diagnostics',platform:process.platform,nodeVersion:process.versions.node,instanceFingerprint:hash([identity.hostId,identity.instanceId]),setup:{revision:setup.revision,consentConfirmed:setup.consent?.confirmed===true,projectCount:setup.projects.length,actions:setup.actions.map(a=>({kind:a.kind,state:a.state,...(/^[A-Z_]{1,80}$/.test(a.error||'')?{error:a.error}:{})}))},business:{configured:business.configured===true,running:business.running===true,connected:business.qqConnected===true,executionEnabled:business.executionEnabled===true},redacted:['paths','account identity','bot identity','project names','credentials','chat and task text','source memory','raw logs'],uploaded:false};
 return {preview,sha256:hash(preview)};
}
export function exportDiagnostics(paths,operationId,preview){const fileName='export-'+operationId+'.json',file=path.join(paths.diagnosticDirectory,fileName);if(existsSync(file))throw Error('DIAGNOSTICS_EXPORT_ALREADY_EXISTS');writeApplicationJson(file,preview);return {fileName,sha256:hash(preview),uploaded:false};}
