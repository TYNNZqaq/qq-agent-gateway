import { conversationId, principalId, scope } from '../packages/core/contracts.mjs';

export function configuration(){
  return {schemaVersion:1,contractVersion:1,revision:1,hostId:'host-test',executionEnabled:false,
    bots:[{id:'bot-a',channel:'qq',appId:'10000001',credentialRef:null,enabled:true},{id:'bot-b',channel:'qq',appId:'10000002',credentialRef:null,enabled:true}],
    agents:[{id:'agent-a',adapterId:'synthetic-one',workspaceRef:'project-x',policyRef:'offline',modelRef:null,enabled:true},{id:'agent-b',adapterId:'synthetic-two',workspaceRef:'project-y',policyRef:'offline',modelRef:null,enabled:true}],
    bindings:[{id:'binding-a',botId:'bot-a',agentId:'agent-a',version:1,enabled:true},{id:'binding-b',botId:'bot-b',agentId:'agent-b',version:1,enabled:true}],
    projects:[{id:'project-x',grantRef:null},{id:'project-y',grantRef:null}],
    policies:[{id:'offline',version:1,approvalChannel:'local',fileAccess:'none',shell:false,network:false}]};
}
export function testScope(bot='a',overrides={}){
  return scope({hostId:'host-test',botId:'bot-'+bot,agentId:'agent-'+bot,bindingId:'binding-'+bot,bindingVersion:1,
    principalId:principalId('host-test','bot-'+bot,'same-user'),conversationId:conversationId('bot-'+bot,'same-conversation'),projectId:bot==='a'?'project-x':'project-y',policyVersion:1,...overrides});
}
export const inbound=(eventId='event-1',text='synthetic work')=>({eventId,kind:'work',text});
export const event=(seq,type,data={},correlationId='dispatch-event-1')=>({schemaVersion:1,id:'event-'+seq,seq,type,occurredAt:'2026-01-01T00:00:00.000Z',correlationId,data});
