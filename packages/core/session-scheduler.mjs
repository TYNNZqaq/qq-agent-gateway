import { identifier, integer, reject, scope, scopeKey } from './contracts.mjs';

// Scheduling primitive only. Callers supply work; it imports no executor and
// is not reachable from the deployed management HTTP service.
export class SessionScheduler {
  #queue=[];#active=0;#sessions=new Set();#agents=new Map();#tasks=new Set();#closed=false;
  constructor({maxConcurrent=2,perAgent=1,maxQueued=128}={}){
    this.maxConcurrent=integer(maxConcurrent);this.perAgent=integer(perAgent);this.maxQueued=integer(maxQueued);
    if(this.maxQueued>1024)reject('SCHEDULER_LIMIT_TOO_LARGE');
  }
  submit(value,taskId,work){
    if(this.#closed)reject('SCHEDULER_CLOSED');
    const checked=scope(value),key=scopeKey(checked);identifier(taskId);
    if(typeof work!=='function')reject('INVALID_WORK');
    const taskKey=key+':'+taskId;if(this.#tasks.has(taskKey))reject('TASK_ALREADY_SCHEDULED');
    if(this.#queue.length>=this.maxQueued)reject('SCHEDULER_QUEUE_FULL');
    this.#tasks.add(taskKey);
    const promise=new Promise((resolve,reject)=>this.#queue.push({scope:checked,key,taskKey,work,resolve,reject}));
    this.#drain();return promise;
  }
  #drain(){
    while(this.#active<this.maxConcurrent){
      const i=this.#queue.findIndex(t=>!this.#sessions.has(t.key)&&(this.#agents.get(t.scope.agentId)||0)<this.perAgent);
      if(i<0)return;
      const task=this.#queue.splice(i,1)[0];this.#active++;this.#sessions.add(task.key);this.#agents.set(task.scope.agentId,(this.#agents.get(task.scope.agentId)||0)+1);
      const release=()=>{
        this.#active--;this.#sessions.delete(task.key);this.#tasks.delete(task.taskKey);this.#agents.set(task.scope.agentId,this.#agents.get(task.scope.agentId)-1);this.#drain();
      };
      // Release before settling the public promise: an awaiting caller may
      // immediately schedule the same Task or batch again.
      Promise.resolve().then(task.work).then(value=>{release();task.resolve(value);},error=>{release();task.reject(error);});
    }
  }
  close(){this.#closed=true;for(const task of this.#queue.splice(0)){this.#tasks.delete(task.taskKey);task.reject(Object.assign(new Error('SCHEDULER_CLOSED'),{code:'SCHEDULER_CLOSED'}));}}
}
