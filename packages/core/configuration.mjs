import { CONTRACT_VERSION, boundedText, digest, freeze, identifier, integer, object, reject } from './contracts.mjs';

const bool = v => { if (typeof v !== 'boolean') reject('INVALID_BOOLEAN'); return v; };
const array = v => { if (!Array.isArray(v) || v.length>1000) reject('INVALID_ARRAY'); return v; };
const ref = v => v===null ? null : identifier(v);
const unique = rows => { const ids=new Set();for(const row of rows){if(ids.has(row.id))reject('DUPLICATE_ID');ids.add(row.id);}return ids; };

// No paths, credentials or runtime-specific SDKs. References are resolved by the
// trusted host only, after OS/runtime permission gates have passed.
export function validateConfiguration(input) {
  object(input,['schemaVersion','contractVersion','revision','hostId','executionEnabled','bots','agents','bindings','projects','policies']);
  if (input.schemaVersion!==1 || input.contractVersion!==CONTRACT_VERSION) reject('INCOMPATIBLE_CONFIGURATION');
  if (input.executionEnabled!==false) reject('EXECUTION_DISABLED');
  const value={schemaVersion:1,contractVersion:CONTRACT_VERSION,revision:integer(input.revision),hostId:identifier(input.hostId),executionEnabled:false};
  value.bots=array(input.bots).map(b => {
    object(b,['id','channel','appId','credentialRef','enabled']);
    if(b.channel!=='qq'||typeof b.appId!=='string'||!/^\d{1,30}$/.test(b.appId))reject('INVALID_BOT');
    return {id:identifier(b.id),channel:'qq',appId:b.appId,credentialRef:ref(b.credentialRef),enabled:bool(b.enabled)};
  });
  value.agents=array(input.agents).map(a => {
    object(a,['id','adapterId','workspaceRef','policyRef','modelRef','enabled']);
    return {id:identifier(a.id),adapterId:identifier(a.adapterId),workspaceRef:identifier(a.workspaceRef),policyRef:identifier(a.policyRef),modelRef:ref(a.modelRef),enabled:bool(a.enabled)};
  });
  value.projects=array(input.projects).map(p => {
    object(p,['id','grantRef']);return {id:identifier(p.id),grantRef:ref(p.grantRef)};
  });
  value.policies=array(input.policies).map(p => {
    object(p,['id','version','approvalChannel','fileAccess','shell','network']);
    if(p.approvalChannel!=='local'||p.fileAccess!=='none'||p.shell!==false||p.network!==false)reject('UNVERIFIED_POLICY');
    return {id:identifier(p.id),version:integer(p.version),approvalChannel:'local',fileAccess:'none',shell:false,network:false};
  });
  const bots=unique(value.bots),agents=unique(value.agents),projects=unique(value.projects),policies=unique(value.policies);
  const appIds=new Set();for(const b of value.bots){if(appIds.has(b.appId))reject('APP_ID_CONFLICT');appIds.add(b.appId);}
  for(const a of value.agents)if(!projects.has(a.workspaceRef)||!policies.has(a.policyRef))reject('DANGLING_AGENT_REFERENCE');
  value.bindings=array(input.bindings).map(b => {
    object(b,['id','botId','agentId','version','enabled']);
    if(!bots.has(b.botId)||!agents.has(b.agentId))reject('DANGLING_BINDING');
    return {id:identifier(b.id),botId:b.botId,agentId:b.agentId,version:integer(b.version),enabled:bool(b.enabled)};
  });
  unique(value.bindings);
  const boundBots=new Set(),boundAgents=new Set();
  for(const b of value.bindings.filter(b=>b.enabled)){
    if(boundBots.has(b.botId)||boundAgents.has(b.agentId))reject('BINDING_CONFLICT');
    if(!value.bots.find(x=>x.id===b.botId).enabled||!value.agents.find(x=>x.id===b.agentId).enabled)reject('DISABLED_BINDING_TARGET');
    boundBots.add(b.botId);boundAgents.add(b.agentId);
  }
  if(value.bots.some(b=>b.enabled&&!boundBots.has(b.id)))reject('UNBOUND_ENABLED_BOT');
  return freeze(value);
}

export function activeBinding(configuration, botId) {
  const config=validateConfiguration(configuration), bot=config.bots.find(b=>b.id===botId&&b.enabled);
  const binding=bot&&config.bindings.find(b=>b.botId===botId&&b.enabled);
  if(!binding)reject('BOT_NOT_BOUND');
  const agent=config.agents.find(a=>a.id===binding.agentId&&a.enabled);
  const policy=config.policies.find(p=>p.id===agent.policyRef);
  return {bot,binding,agent,policy};
}

// Deliberately accepts only the documented credential-free synthetic V0 fixture.
// This is a reversible migration rehearsal, not a production 0.2.0 importer.
export function migrateSyntheticV0(input) {
  object(input,['schemaVersion','qq','executor','settings']);
  if(input.schemaVersion!==0)reject('LEGACY_SCHEMA_UNSUPPORTED');
  object(input.qq,['appId','credentialRef']);
  object(input.executor,['adapterId','workspaceRef','policyRef','modelRef']);
  object(input.settings,['displayName','numberingBase']);
  boundedText(input.settings.displayName,80);integer(input.settings.numberingBase,0);
  const original=structuredClone(input);
  const configuration=validateConfiguration({schemaVersion:1,contractVersion:1,revision:1,hostId:'synthetic-host',executionEnabled:false,
    bots:[{id:'bot-a',channel:'qq',...input.qq,enabled:true}],agents:[{id:'agent-a',...input.executor,enabled:true}],
    bindings:[{id:'binding-a',botId:'bot-a',agentId:'agent-a',version:1,enabled:true}],
    projects:[{id:input.executor.workspaceRef,grantRef:null}],
    policies:[{id:input.executor.policyRef,version:1,approvalChannel:'local',fileAccess:'none',shell:false,network:false}]});
  return freeze({migrationVersion:1,sourceDigest:digest(JSON.stringify(original)),original,configuration});
}
export function rollbackSyntheticV0(envelope) {
  object(envelope,['migrationVersion','sourceDigest','original','configuration']);
  if(envelope.migrationVersion!==1||digest(JSON.stringify(envelope.original))!==envelope.sourceDigest)reject('ROLLBACK_BACKUP_MISMATCH');
  // Validate both formats before returning the preserved original.
  migrateSyntheticV0(envelope.original);validateConfiguration(envelope.configuration);
  return structuredClone(envelope.original);
}
