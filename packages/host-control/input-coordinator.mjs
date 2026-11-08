import { freeze, identifier, reject, scope } from '../core/contracts.mjs';
import { inputLimits, normalizeInput } from '../core/input-contracts.mjs';
import { SessionScheduler } from '../core/session-scheduler.mjs';

// Offline host composition only. Not imported by the deployed management
// service. No SDK, executor, timers, model turn or QQ sending implementation.
export class InputCoordinator {
  #store; #scheduler; #ownScheduler; #prepare; #confirm; #limits;
  constructor({store,scheduler,prepareDispatch,confirmDispatch=()=>{},limits={}}) {
    if(!store||typeof prepareDispatch!=='function'||typeof confirmDispatch!=='function')reject('INVALID_INPUT_COORDINATOR');
    this.#store=store;this.#ownScheduler=!scheduler;this.#scheduler=scheduler??new SessionScheduler();this.#prepare=prepareDispatch;this.#confirm=confirmDispatch;this.#limits=inputLimits(limits);
  }
  accept(value,input){return this.#store.queueInput(scope(value),normalizeInput(input),this.#limits);}
  flush(value,batchId){
    const checked=scope(value);identifier(batchId);
    return this.#scheduler.submit(checked,'input-'+batchId,async()=>{
      const claimed=this.#store.claimInput(checked,batchId);
      if(!claimed.request)return claimed;
      const request=freeze(claimed.request);
      let completed;
      try{
        // Preparation cannot accept input. After any asynchronous preparation,
        // check again immediately before invoking the receiver entry point.
        const receive=await this.#prepare(request);
        if(typeof receive!=='function')reject('INVALID_INPUT_RECEIVER');
        const permission=this.#store.authorizeInputDispatch(checked,batchId,request.attemptToken);
        if(!permission.authorized)return permission;
        const receipt=await receive(request);
        completed=this.#store.completeInput(checked,batchId,{...receipt,attemptToken:request.attemptToken});
      }catch{
        // A receiver may have accepted before throwing. Never infer rejection
        // from an exception, retain the attempt and do not retry it.
        return this.#store.markInputUnknown(checked,batchId,request.attemptToken);
      }
      // Optional trusted synchronous Host acknowledgement AFTER the WorkStore
      // commit. Failure must reject this call, not disguise a lost Host ack as
      // success or undo the already durable input consumption. No re-dispatch.
      if(completed.state==='consumed'){
        const confirmation=this.#confirm(request,completed);
        if(confirmation&&typeof confirmation.then==='function')reject('INPUT_CONFIRMATION_MUST_BE_SYNCHRONOUS');
      }
      return completed;
    });
  }
  close(){if(this.#ownScheduler)this.#scheduler.close();}
}
