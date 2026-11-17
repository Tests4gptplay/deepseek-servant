import { isDeepStrictEqual } from 'node:util';
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence';
import { errorChain } from '@deepseek-ai/dsh-llm';

// Keep actual cause/aggregate details in the existing report and logger path.
// This text is diagnostic only; retry and Host decisions still use the error.
const describeError=error=>error instanceof Error?`${error.name}: ${errorChain(error)}`:errorChain(error);

export const isRetryable=(error,seen=new Set())=>{
  if(!error||seen.has(error))return false;seen.add(error);
  return ['EBUSY','EAGAIN','SQLITE_BUSY','SQLITE_LOCKED'].includes(error.code)||String(error).includes('database is locked')
    ||isRetryable(error.cause,seen)||error instanceof AggregateError&&error.errors.some(value=>isRetryable(value,seen));
};
export const sameHeader=(a,b)=>isDeepStrictEqual({...a,delegationDepth:a.delegationDepth??0},{...b,delegationDepth:b.delegationDepth??0});

/** Actual persistence handles are coordinated per session, independently of DSS tasks. */
export class LifecycleFence {
  lifecycles = new Map();
  constructor(identity) { this.identity = identity; }
  reserve(id, header) {
    let life = this.lifecycles.get(id);
    if (life && life.phase !== 'active') throw new SessionAlreadyOwnedError(id);
    if (!life) {
      life = { id, header: header && Object.freeze(structuredClone(header)), identity: this.identity,
        phase: 'active', handles: new Set(), writes: new Set(), idle: new Set(), failure: undefined };
      this.lifecycles.set(id, life);
    } else if (header && life.header && !sameHeader(header, life.header)) {
      throw new Error('Different lifecycle cannot reuse an admitted session id');
    }
    const reservation = {};
    life.handles.add(reservation);
    return {life, reservation};
  }
  bind(life, header) {
    if (life.header && !sameHeader(life.header, header)) throw new Error('Stored lifecycle identity changed');
    life.header ??= Object.freeze(structuredClone(header));
  }
  release(life, reservation, failure) {
    if (failure) life.failure = failure;
    life.handles.delete(reservation); this.wake(life);
  }
  forgetUnused(life) {
    if(!life.enrolled&&!life.handles.size&&!life.writes.size&&life.phase==='active'&&this.lifecycles.get(life.id)===life)this.lifecycles.delete(life.id);
  }
  current(life) {
    if (life.identity !== this.identity || this.lifecycles.get(life.id) !== life) throw new Error('Lifecycle/backend binding changed');
  }
  wake(life) { if (!life.handles.size) { for (const resolve of life.idle) resolve(); life.idle.clear(); } }
  async drain(life,{signal}={}) {
    signal?.throwIfAborted();
    while (life.handles.size) await new Promise((resolve,reject)=>{
      const cleanup=()=>{life.idle.delete(wake);signal?.removeEventListener('abort',abort);};
      const wake=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(signal.reason??new Error('Drain aborted'));};
      life.idle.add(wake);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  }
  matchesCache(life, identity) {
    const h = life.header;
    return h && identity.formatVersion === h.version && identity.createdAt === h.createdAt
      && identity.cwd === h.cwd && (identity.isSeeded ?? false) === h.isSeeded;
  }
  cacheWrite(id, identity, operation) {
    const life = this.lifecycles.get(id);
    // An old asynchronous checkpoint must not replace a new same-id lifecycle.
    if (life && (life.phase !== 'active' || !this.matchesCache(life, identity))) return Promise.resolve();
    const pending = Promise.resolve().then(operation);
    if (life) {
      life.writes.add(pending);
      void pending.finally(() => { life.writes.delete(pending); this.wake(life); this.forgetUnused(life); }).catch(() => {});
    }
    return pending;
  }

}

/** All callers in this composition use this public handle decorator. */
export function decoratePersistence(backend, fence) {
  const wrap = (handle, life, reservation) => {
    let closing;
    const operations = new Set();
    const call = (method, args) => {
      if (closing) return Promise.reject(new Error('Session handle is closing'));
      const operation = Promise.resolve().then(() => handle[method](...args));
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch(() => {});
      return operation;
    };
    const result = { id:handle.id, header:handle.header, access:handle.access,
      inheritedEventCount:handle.inheritedEventCount,
      read:(...args)=>call('read',args), append:(...args)=>call('append',args), flush:(...args)=>call('flush',args),
      close:()=>closing ??= (async()=>{
        let failure;
        try { await Promise.allSettled([...operations]); await handle.close(); }
        catch(error) {failure=error; throw error;}
        finally {fence.release(life,reservation,failure);fence.forgetUnused(life);}
      })(),
      [Symbol.asyncDispose]() { return this.close(); },
    };
    return result;
  };
  async function acquire(id, header, action) {
    const {life,reservation}=fence.reserve(id,header);
    let handle;
    try {handle=await action(); fence.bind(life,handle.header); return wrap(handle,life,reservation);}
    catch(error) {let closeError;try{await handle?.close();}catch(failure){closeError=failure;}finally{fence.release(life,reservation,closeError);fence.forgetUnused(life);}
      if(closeError)throw new AggregateError([error,closeError],'Acquire and cleanup failed');throw error;}
  }
  return { identity:backend.identity,
    create:(header,options)=>acquire(header.id,header,()=>backend.create(header,options)),
    open:(id,access,options)=>acquire(id,undefined,()=>backend.open(id,access,options)),
    stat:backend.stat.bind(backend), list:backend.list.bind(backend), flush:backend.flush.bind(backend),
  };
}

/** Explicit identity enrollment; no title/prefix/task-state inference and no DSS imports. */
export class NativeCleanerCoordinator {
  owned=new WeakMap(); preparing=new Set(); maintenance=new Set(); pending=new Map(); retained=new Map(); retryable=new WeakSet(); workers=new Map(); stopped=false; recoveryNeeded=true;
  projectionRetained=new Map(); projectionRetryable=new WeakSet(); projectionWorkers=new Map(); retryFlights=new Set(); logRetryPreparations=new Map();
  constructor(ctx,fence,adapter,report=()=>{}) {
    this.abort=new AbortController();this.ctx=ctx;this.fence=fence;this.adapter=adapter;this.report=report;
  }
  register(agent) {
    const current=this.owned.get(agent);if(current)return current.registration;
    if(this.stopped)throw new Error('Cleanup adapter is unloaded');
    const life=this.fence.lifecycles.get(agent.id);
    if(!life || !sameHeader(life.header,agent.session.header))throw new Error('Lifecycle not owned by this persistence composition');
    const previous=life.entry;
    const entry={agent,life,native:undefined,disposal:undefined,closeSucceeded:false,retired:false,queued:false,
      parent:undefined,children:previous?.children??new Set()};
    entry.registration=Object.freeze({closed:result=>this.closed(entry,result)});
    if(previous)previous.parent?.children.delete(previous);
    for(const child of entry.children)child.parent=entry;
    life.entry=entry;life.enrolled=true;life.inheritedEventCount=agent.session.inheritedEventCount;
    this.owned.set(agent,entry);
    return entry.registration;
  }
  enroll(native,parent) {
    this.register(native.agent);
    const entry=this.owned.get(native.agent);entry.native=native;
    const owner=parent&&this.owned.get(parent);
    if(owner){entry.parent?.children.delete(entry);entry.parent=owner;owner.children.add(entry);}
    return {agent:native.agent, dispose:()=>this.finishDisposal(entry)};
  }
  closed(entry,result) {
    // A close result belongs to this actual Agent, not a later same-id resume.
    if(entry.life.entry!==entry)return;
    if(result.status==='failed'){
      entry.closeSucceeded=false;entry.closeFailure=result.error;entry.life.failure=result.error;
      this.publish(entry.life,{status:'failed',stage:'native-close',error:describeError(result.error)});return;
    }
    if(result.status!=='closed')throw new Error('Unknown native close result');
    if(entry.life.failure===entry.closeFailure)entry.life.failure=undefined;
    entry.closeFailure=undefined;
    entry.closeSucceeded=true;this.maybePrepare(entry);
  }
  retire(id) {
    if(this.stopped)throw new Error('Cleanup adapter is unloaded');
    const known=this.fence.lifecycles.get(id),entry=known?.entry;
    if(!entry)return this.retireStored(id,known);
    if(known.retirement)return known.retirement;
    const entries=[];
    const collect=current=>{
      if(current.life.entry!==current||current.life.phase==='removed')return;
      entries.push(current);for(const child of current.children)collect(child);
    };
    collect(entry);
    // The promise transfers durable responsibility only. Actual close, log
    // deletion and cache maintenance remain independent background work.
    const operation=Promise.resolve().then(async()=>{
      const awaiting=entries.filter(current=>!current.life.retirementAccepted);
      const accepted=awaiting.length?await this.adapter.store.accept(awaiting.map(current=>current.life),life=>{
        this.fence.current(life);
        if(!entries.some(current=>current.life===life&&life.entry===current))throw new Error('Retired native owner changed before acceptance');
      }):[];
      for(let index=0;index<awaiting.length;index++)this.restoreDuties(awaiting[index].life,accepted[index]);
      for(const current of entries){current.life.retirementAccepted=true;current.retired=true;this.maybePrepare(current);}
    }).catch(error=>{this.publish(known,{status:'failed',stage:'retirement',error:describeError(error)});throw error;})
      .finally(()=>{this.preparing.delete(operation);if(known.retirement===operation)known.retirement=undefined;});
    known.retirement=operation;this.preparing.add(operation);void operation.catch(()=>{});return operation;
  }
  retireStored(id,known) {
    if(known?.retirement)return known.retirement;
    if(known?.retirementAccepted)return Promise.resolve();
    // The Host names one permanently retired session after restart. Look up
    // only that identity; an old closed journal alone never authorizes work.
    const life=known??{id,identity:this.adapter.backend.identity,phase:'retiring',handles:new Set(),writes:new Set(),idle:new Set()};
    this.fence.lifecycles.set(id,life);
    const operation=Promise.resolve().then(async()=>{
      const stored=await this.adapter.backend.stat(id);
      const journal=await this.adapter.store.read(id,stored?.header);
      if(!stored&&!journal){
        this.publish(life,{status:'absent'});
        if(this.fence.lifecycles.get(id)===life)this.fence.lifecycles.delete(id);
        return;
      }
      this.fence.bind(life,stored?.header??journal.header);
      life.inheritedEventCount=journal?.inheritedEventCount;
      const [accepted]=await this.adapter.store.accept([life],value=>this.fence.current(value));
      this.restoreDuties(life,accepted);
      life.retirementAccepted=true;
      this.resumeDuties(life);
    }).catch(error=>{
      life.phase='active';
      const outcome={status:'failed',stage:'retirement',error:describeError(error),retryable:isRetryable(error)};
      // Before acceptance the Host retains its original role responsibility.
      // Do not turn an unaccepted in-memory request into physical retry work.
      if(!known&&!life.retirementAccepted&&this.fence.lifecycles.get(id)===life)this.fence.lifecycles.delete(id);
      this.publish(life,outcome);throw error;
    }).finally(()=>{this.preparing.delete(operation);if(life.retirement===operation)life.retirement=undefined;});
    life.retirement=operation;this.preparing.add(operation);
    // The public caller can report the failure; the adapter also observes it
    // when the Host sends a fire-and-forget notification.
    void operation.catch(()=>{});return operation;
  }
  finishDisposal(entry){
    return entry.disposal??=Promise.resolve().then(async()=>{
      try {
        await entry.native.dispose();
        if(this.ctx.agents.get(entry.life.id)===entry.agent||this.ctx.sessions.get(entry.life.id)===entry.agent.session)throw new Error('Exact native lifecycle remains registered');
        this.closed(entry,{status:'closed'});
      } catch(error) {this.closed(entry,{status:'failed',error});throw error;}
      finally{entry.onDisposalSettled?.();}
    });
  }
  maybePrepare(entry) {
    if(this.stopped||!entry.retired||!entry.closeSucceeded||entry.queued)return;
    this.queuePreparation(entry);
  }
  queuePreparation(entry) {
    if(this.stopped||entry.queued)return;
    entry.queued=true;
    const preparation=Promise.resolve().then(()=>this.prepare(entry));
    this.preparing.add(preparation);
    void preparation.catch(error=>{const life=entry.life;life.phase='active';const outcome={status:'failed',error:describeError(error),retryable:isRetryable(error)};this.retain(life,outcome);this.publish(life,outcome);if(outcome.retryable)this.scheduleRetry();})
      .finally(()=>this.preparing.delete(preparation));
  }
  async continueCatalog(life){
    // Acceptance remains the original Host handoff. Discovery belongs to
    // this accepted parent's background work, before its own log removal.
    const catalog=await this.adapter.catalog(life,{signal:this.abort.signal});
    // An accepted log may already be gone after interrupted physical cleanup.
    if(!catalog)return;
    life.inheritedEventCount=catalog.inheritedEventCount;
    const failures=[];
    for(const child of catalog.children){
      if(this.stopped)return;
      let target,created=false;
      try{
        const matches=header=>header?.id===child.id&&header.createdAt===child.createdAt
          &&header.parentSession===life.id&&header.origin==='subagent';
        target=this.fence.lifecycles.get(child.id);
        if(target?.retirementAccepted&&matches(target.header))continue;
        // Do not read the child's body here: once its exact header is accepted,
        // its own journal row and native log carry its descendants independently.
        const stored=await this.adapter.backend.stat(child.id,{signal:this.abort.signal});
        if(!stored){
          this.publish({id:child.id},{status:'absent',stage:'catalog',parentSession:life.id,createdAt:child.createdAt,
            reason:'Catalog child log is absent; unavailable descendant facts were not reconstructed'});continue;
        }
        const header=stored.header;
        if(header.id!==child.id)throw new Error('Native catalog lookup returned another session: '+child.id);
        if(header.createdAt!==child.createdAt){
          this.publish({id:child.id},{status:'deferred',stage:'catalog',parentSession:life.id,createdAt:child.createdAt,
            reason:'Historical catalog generation is no longer stored; current generation is preserved'});continue;
        }
        if(!matches(header))throw new Error('Native catalog child lineage differs: '+life.id+' -> '+child.id);
        target=this.fence.lifecycles.get(child.id);
        if(target?.retirementAccepted&&matches(target.header))continue;
        if(target?.entry||this.ctx.agents.get(child.id)||this.ctx.sessions.get(child.id))throw new Error('Current native child owner is outside the accepted retiring tree: '+child.id);
        if(!target){
          target={id:child.id,identity:this.adapter.backend.identity,phase:'active',handles:new Set(),writes:new Set(),idle:new Set()};
          this.fence.lifecycles.set(child.id,target);created=true;
        }
        this.fence.bind(target,header);
        const [accepted]=await this.adapter.store.accept([target],value=>{
          this.fence.current(life);this.fence.current(value);
          if(value.entry||this.ctx.agents.get(value.id)||this.ctx.sessions.get(value.id))throw new Error('Native child owner changed before catalog acceptance: '+value.id);
        });
        this.restoreDuties(target,accepted);target.retirementAccepted=true;
        this.resumeDuties(target);
      }catch(error){
        if(!this.stopped){
          failures.push(error);
          this.publish({id:child.id},{status:'failed',stage:'catalog',parentSession:life.id,error:describeError(error)});
        }
      }finally{
        if(created&&!target.retirementAccepted)this.fence.forgetUnused(target);
      }
    }
    // Readable siblings have already transferred. An unreadable direct header
    // cannot be invented: retain this parent's original accepted row/catalog.
    if(failures.length===1)throw failures[0];
    if(failures.length)throw new AggregateError(failures,'Native catalog child responsibility remains pending: '+life.id);
  }
  async prepare(entry) {
    const {life}=entry;this.fence.current(life);
    if(!life.retirementAccepted)throw new Error('Permanent retirement has not been durably accepted');
    if(life.failure)throw life.failure;
    life.phase='retiring';
    // The exact retirement fact is already durable. Do not write a second
    // closed row or wait for physical cleanup before acknowledging acceptance.
    try{await this.fence.drain(life,{signal:this.abort.signal});}catch(error){if(!this.stopped)throw error;}
    if(this.stopped){this.publish(life,{status:'deferred',reason:'Host shutdown; exact permanent retirement is journaled'});return;}
    this.fence.current(life);if(life.failure)throw life.failure;
    try{await this.continueCatalog(life);}catch(error){if(!this.stopped)throw error;}
    if(this.stopped){this.publish(life,{status:'deferred',reason:'Host shutdown; exact permanent retirement is journaled'});return;}
    this.fence.current(life);
    if(!life.logsCompleted){this.pending.set(life.id,life);this.start();}
    this.maintainProjection(life);
  }
  restoreDuties(life,row){life.logsCompleted=row.logsCompleted;life.projectionCompleted=row.projectionCompleted;}
  resumeDuties(life){
    if(life.logsCompleted){life.phase='removed';this.maintainProjection(life);}
    else this.queuePreparation({life});
  }
  recoverAccepted() {
    if(this.stopped||!this.recoveryNeeded)return Promise.resolve();
    if(this.recovering)return this.recovering;
    const operation=Promise.resolve().then(async()=>{
      const rows=await this.adapter.store.accepted();
      for(const row of rows){
        const id=row.header.id,known=this.fence.lifecycles.get(id);
        if(known?.retirementAccepted)continue;
        if(known?.header&&!sameHeader(known.header,row.header)){
          this.publish({id},{status:'failed',stage:'retirement-recovery',error:'Accepted retirement identity differs from the current native lifecycle'});continue;
        }
        // An already opened/resumed lifecycle in this process still belongs to
        // its current owner. Recovery must not mark that Agent retired, even
        // when its immutable header matches. Keep the exact durable obligation
        // for an explicit current Host retirement instead of changing its role.
        if(known||this.ctx.agents.get(id)||this.ctx.sessions.get(id)){
          this.publish({id},{status:'deferred',stage:'retirement-recovery',reason:'Current native owner requires an explicit Host retirement'});continue;
        }
        const life={id,identity:this.adapter.backend.identity,phase:'retiring',handles:new Set(),writes:new Set(),idle:new Set()};
        this.fence.lifecycles.set(id,life);this.fence.bind(life,row.header);
        life.inheritedEventCount=row.inheritedEventCount;life.retirementAccepted=true;
        this.restoreDuties(life,row);this.resumeDuties(life);
      }
      this.recoveryNeeded=false;
    }).catch(error=>{this.publish({},{status:'failed',stage:'retirement-recovery',error:describeError(error)});throw error;})
      .finally(()=>{this.preparing.delete(operation);if(this.recovering===operation)this.recovering=undefined;});
    this.recovering=operation;this.preparing.add(operation);void operation.catch(()=>{});return operation;
  }
  maintainProjection(life) {
    if(this.stopped||life.projectionCompleted||!this.adapter.maintainProjection)return;
    if(this.projectionWorkers.has(life.id))return this.projectionWorkers.get(life.id);
    life.projectionPending=true;
    // Already-started cache checkpoints belong to cache maintenance, not to
    // physical session ownership. Their failure or delay cannot hold log removal.
    const operation=Promise.allSettled([...life.writes]).then(async()=>{
        this.fence.current(life);
        if(this.ctx.agents.get(life.id)||this.ctx.sessions.get(life.id))throw new Error('A live owner replaced this session');
        const outcome=await this.adapter.maintainProjection(life);
        if(outcome.status==='removed'||outcome.status==='absent'){
          await this.adapter.store.completeProjection(life.header);
          life.projectionCompleted=true;this.projectionRetained.delete(life.id);this.projectionRetryable.delete(life);
        }else this.retainProjection(life,outcome);
        this.publish(life,{...outcome,stage:'projection-cache'});
      }).catch(error=>{
        const outcome={status:'failed',stage:'projection-cache',error:describeError(error),retryable:isRetryable(error)};
        this.retainProjection(life,outcome);this.publish(life,outcome);if(outcome.retryable)this.scheduleRetry();
      })
      .finally(()=>{
        life.projectionPending=false;this.maintenance.delete(operation);this.projectionWorkers.delete(life.id);
        this.releaseCompleted(life);
      });
    this.projectionWorkers.set(life.id,operation);this.maintenance.add(operation);return operation;
  }
  retainProjection(life,outcome){this.projectionRetained.set(life.id,life);if(outcome.retryable)this.projectionRetryable.add(life);else this.projectionRetryable.delete(life);}
  releaseCompleted(life){if(life.logsCompleted&&life.projectionCompleted&&!life.projectionPending&&this.fence.lifecycles.get(life.id)===life)this.fence.lifecycles.delete(life.id);}
  start() {
    // Each accepted session owns its work. A busy or still-draining session
    // must not hold unrelated retirements behind one cleaner worker.
    for(const [id,life] of this.pending) {
      if(this.workers.has(id))continue;
      const worker=Promise.resolve().then(async()=>{
        let outcome;
        try {this.fence.current(life);outcome=await this.adapter.cleanup(life);}
        catch(error){outcome={status:'failed',error:describeError(error),retryable:isRetryable(error)};}
        const done=outcome.status==='removed'||outcome.status==='absent';
        life.phase=done?'removed':'active';if(done){life.logsCompleted=true;this.retained.delete(id);this.retryable.delete(life);}else this.retain(life,outcome);
        if(this.pending.get(id)===life)this.pending.delete(id);
        this.publish(life,outcome);if(outcome.retryable)this.scheduleRetry();
        this.releaseCompleted(life);
      }).finally(()=>{this.workers.delete(id);if(this.pending.size)this.start();});
      this.workers.set(id,worker);
    }
  }
  retain(life,outcome){this.retained.set(life.id,life);if(outcome.retryable)this.retryable.add(life);else this.retryable.delete(life);}
  scheduleRetry(){
    if(this.stopped||this.retryTimer)return;
    // Coalesce dispatch, not unrelated physical I/O. A running maintenance
    // operation must not postpone another identity's next retry attempt.
    if(this.retrying){this.retrying.retryRequested=true;return;}
    this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;void this.retry({automatic:true}).catch(()=>{});},100);this.retryTimer.unref();
  }
  retry({automatic=false}={}){
    if(this.stopped)return Promise.resolve();
    // Coalesce callers around actual work, not only its eventual cleanup queue.
    // An explicit request after an automatic flight still rechecks all retained
    // failures, including states whose dependencies may have been repaired.
    if(this.retrying)return !automatic&&this.retrying.automatic?this.retrying.promise.then(()=>this.retry()):this.retrying.promise;
    clearTimeout(this.retryTimer);this.retryTimer=undefined;
    const flight={automatic,promise:undefined};
    this.retrying=flight;
    const releaseDispatch=()=>{
      if(this.retrying!==flight)return;
      this.retrying=undefined;
      if(flight.retryRequested&&([...this.retained.values()].some(life=>this.retryable.has(life))
        ||[...this.projectionRetained.values()].some(life=>this.projectionRetryable.has(life))))this.scheduleRetry();
    };
    flight.promise=Promise.resolve().then(async()=>{
      if(this.recoveryNeeded)await this.recoverAccepted();
      const projections=new Map(this.projectionRetained);
      if(!automatic)for(const id of this.projectionWorkers.keys())projections.set(id,this.fence.lifecycles.get(id));
      const projectionRetries=[...projections.values()].map(async life=>{
        if(!life||automatic&&this.projectionWorkers.has(life.id))return;
        // A cache-mounted retry can arrive before an in-flight not-mounted
        // result is retained. Join only that identity before checking its duty.
        await this.projectionWorkers.get(life.id);
        if(!this.projectionRetained.has(life.id)||automatic&&!this.projectionRetryable.has(life))return;
        if(this.ctx.agents.get(life.id)||this.ctx.sessions.get(life.id))return;
        await this.maintainProjection(life);
      });
      const logRetries=[...this.retained.values()].map(life=>{
        if(automatic&&!this.retryable.has(life))return;
        if(this.workers.has(life.id))return;
        const preparing=this.logRetryPreparations.get(life);
        if(preparing)return automatic?undefined:preparing;
        // Coalesce this exact lifecycle's handle drain before workers exists.
        // Another lifecycle can still dispatch and retry independently.
        const attempt=Promise.resolve().then(async()=>{
          if(this.ctx.agents.get(life.id)||this.ctx.sessions.get(life.id))return;
          try{
            this.fence.current(life);if(life.failure)throw life.failure;
            life.phase='retiring';
            if(!life.retirementAccepted)throw new Error('Permanent retirement has not been durably accepted');
            await this.fence.drain(life,{signal:this.abort.signal});if(this.stopped)return;
            if(life.failure)throw life.failure;
            await this.continueCatalog(life);
            if(this.stopped)return;
            this.fence.current(life);
            this.pending.set(life.id,life);this.start();
          }catch(error){life.phase='active';if(!this.stopped){const outcome={status:'failed',error:describeError(error),retryable:isRetryable(error)};this.retain(life,outcome);this.publish(life,outcome);if(outcome.retryable)this.scheduleRetry();}}
        }).finally(()=>{if(this.logRetryPreparations.get(life)===attempt)this.logRetryPreparations.delete(life);});
        this.logRetryPreparations.set(life,attempt);return attempt;
      });
      releaseDispatch();
      await Promise.all([...projectionRetries,...logRetries]);
      // Explicit callers retain the public drain semantics. Automatic retries
      // own only their dispatched work, never another session's held cache.
      if(!automatic)await this.drain();
    }).finally(()=>{
      releaseDispatch();this.retryFlights.delete(flight.promise);
    });
    this.retryFlights.add(flight.promise);
    return flight.promise;
  }
  publish(life,outcome){try{this.report(life,outcome);}catch{}}
  async drain(){while(this.preparing.size||this.workers.size||this.maintenance.size)await Promise.allSettled([...this.preparing,...this.workers.values(),...this.maintenance]);}
  async dispose(){this.stopped=true;this.abort.abort(new Error('Cleaner shutdown'));clearTimeout(this.retryTimer);await Promise.all([this.drain(),...this.retryFlights]);}
}
