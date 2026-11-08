import { CONTRACT_VERSION, boundedText, freeze, identifier, object, reject } from './contracts.mjs';

export const CAPABILITIES=Object.freeze(['sessions','input','cancel','reconcile','media','toolApproval','fileIsolation','modelSelection']);
export const ADAPTER_METHODS=Object.freeze(['probe','openSession','submit','sendInput','cancel','reconcile','events','close']);
export function validateDescriptor(value) {
  object(value,['id','version','contractVersion','protocolRange','capabilities']);
  identifier(value.id);boundedText(value.version,64);boundedText(value.protocolRange,128);
  if(value.contractVersion!==CONTRACT_VERSION)reject('ADAPTER_CONTRACT_INCOMPATIBLE');
  object(value.capabilities,CAPABILITIES);
  const capabilities={};
  for(const key of CAPABILITIES){
    const c=object(value.capabilities[key],['status','reason']);
    if(!['supported','degraded','unsupported'].includes(c.status))reject('INVALID_CAPABILITY');
    capabilities[key]={status:c.status,reason:boundedText(c.reason,512)};
  }
  return freeze({id:value.id,version:value.version,contractVersion:CONTRACT_VERSION,protocolRange:value.protocolRange,capabilities});
}
export class AdapterRegistry {
  #entries=new Map();
  register(descriptor,factory) {
    const checked=validateDescriptor(descriptor);
    if(this.#entries.has(checked.id))reject('DUPLICATE_ADAPTER');
    if(typeof factory!=='function')reject('INVALID_ADAPTER_FACTORY');
    this.#entries.set(checked.id,{descriptor:checked,factory});
  }
  describe(id) { const entry=this.#entries.get(identifier(id));if(!entry)reject('UNKNOWN_ADAPTER');return entry.descriptor; }
  list() { return [...this.#entries.values()].map(e=>e.descriptor); }
  create(agent, context) {
    const entry=this.#entries.get(identifier(agent.adapterId));if(!entry)reject('UNKNOWN_ADAPTER');
    if(context.agentId!==agent.id)reject('ADAPTER_SCOPE_MISMATCH');
    let adapter;try{adapter=entry.factory(freeze(structuredClone(context)));}catch{reject('ADAPTER_INITIALIZATION_FAILED');}
    if(!adapter||ADAPTER_METHODS.some(method=>typeof adapter[method]!=='function'))reject('ADAPTER_METHOD_MISSING');
    return adapter;
  }
}
