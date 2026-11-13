import {symbols} from '@deepseek-ai/cordis';
import {LifecycleFence,decoratePersistence,NativeCleanerCoordinator} from './coordinator.mjs';
import {ExactJsonlAdapter} from './jsonl-adapter.mjs';
import {canonicalStorePath} from './retirement-store.mjs';
import {acquireKernelLock} from './kernel-lock.mjs';
import {parseSessionFormatLogFilename} from '@deepseek-ai/dsh-session-format';
export const name='deepseek-servant-native-cleaner';
export const inject=['agents','sessions','sessionPersistence','storage','storageDomain'];

/** Isolated composition adapter for DSS-owned native sessions.
 * This is not a DSS Scheduler/resource component. Existing service instances
 * are wrapped only for this plugin lifetime; official packages stay untouched.
 */
export async function apply(ctx,config={},hooks={}){
 let failed=false,failure,stage='configuration';const rollbacks=new Set();
 const fail=(error,at=stage)=>failure??=(async()=>{
  failed=true;
  const errors=[error];
  for(const rollback of rollbacks)try{await rollback();}catch(cleanupError){errors.push(cleanupError);}
  const reason=errors.length===1?error:new AggregateError(errors,'Cleaner initialization and rollback failed');
  if(!hooks.onFailure)throw reason;
  await hooks.onFailure(reason,at);
 })();
 try{
 const backend=ctx.sessionPersistence,agents=ctx.agents;
 const cacheRoute=ctx.storageDomain.config.routes?.session_projcache??ctx.storageDomain.config.backend;
 const cacheBackend=ctx.storage.backend.get(cacheRoute),storageRoot=cacheBackend.root;
 if(typeof backend.root!=='string'||typeof storageRoot!=='string'||config.storageRoot!==undefined&&typeof config.storageRoot!=='string')throw new Error('Concrete JSONL/cache roots required');
 // Optional configuration asserts the route; it never substitutes another I/O root.
 if(config.storageRoot!==undefined&&canonicalStorePath(config.storageRoot)!==canonicalStorePath(storageRoot))throw new Error('Projection cache storage route does not match configured root');
 let filesystem;
 if(process.platform==='win32'){
  stage='windows-backend';
  const {loadWindowsStorageBackend}=await import('./windows-storage-backend.mjs');
  filesystem=await loadWindowsStorageBackend({acquireLock:acquireKernelLock,parseGeneration:parseSessionFormatLogFilename});
 }
 const activate=async ownerCtx=>{
  if(failed)return;
  let adapter,cleaner,revokeCleaner,rollbackPromise,cacheBinding;
  let closing=false,restore=()=>{};
  const rollback=()=>rollbackPromise??=(async()=>{
   closing=true;
   const serviceDisposal=revokeCleaner?.();serviceDisposal?.catch(()=>{});
   const cacheDisposal=cacheBinding?.dispose();cacheDisposal?.catch(()=>{});
   try{await cleaner?.dispose();}
   finally{
    restore();
    rollbacks.delete(rollback);
   }
  })();
  rollbacks.add(rollback);ownerCtx.effect(()=>rollback,'native-cleaner.adapters');
  try{
  const rawBackend=backend[symbols.original]??backend,rawAgents=agents[symbols.original]??agents;
  const original={create:rawBackend.create,open:rawBackend.open,agentCreate:rawAgents.create,agentResume:rawAgents.resume};
  const raw={identity:backend.identity,create:backend.create.bind(backend),open:backend.open.bind(backend),
   stat:backend.stat.bind(backend),list:backend.list.bind(backend),flush:backend.flush.bind(backend)};
  const fence=new LifecycleFence(raw.identity),persistence=decoratePersistence(raw,fence);
  adapter=new ExactJsonlAdapter({ctx:ownerCtx,backend:raw,fence,root:backend.root,storageRoot,filesystem});
  cleaner=new NativeCleanerCoordinator(ownerCtx,fence,adapter,(life,outcome)=>{
   if(outcome.status==='failed')ownerCtx.logger?.warn?.(`Native session cleanup ${outcome.stage??'physical'} failed ${life.id===undefined?'at the original retirement store':'for '+life.id}: ${outcome.error}`);
  });
  let decoratedCreate,decoratedResume;const cacheRestores=new Set();
  restore=()=>{
   if(rawBackend.create===persistence.create)rawBackend.create=original.create;
   if(rawBackend.open===persistence.open)rawBackend.open=original.open;
   for(const release of cacheRestores)release();cacheRestores.clear();
   if(decoratedCreate&&rawAgents.create===decoratedCreate)rawAgents.create=original.agentCreate;
   if(decoratedResume&&rawAgents.resume===decoratedResume)rawAgents.resume=original.agentResume;
  };
  rawBackend.create=persistence.create;rawBackend.open=persistence.open;
  const bindCache=cacheCtx=>{
   if(closing)return;
   const cache=cacheCtx.sessionProjectionCache??cacheCtx.get('sessionProjectionCache'),rawCache=cache?.[symbols.original]??cache;
   if(typeof rawCache?.put!=='function')return;
   const put=rawCache.put;
   const decorated=rawCache.put=function(id,identity,rows){return fence.cacheWrite(id,identity,()=>Reflect.apply(put,this,[id,identity,rows]));};
   const release=()=>{if(rawCache.put===decorated)rawCache.put=put;cacheRestores.delete(release);};
   cacheRestores.add(release);cacheCtx.effect(()=>release,'native-cleaner.cache-writes');
   // A real cache service becoming available can finish its retained duty.
   // This existing retry runs in the background and never gates Host admission.
   if(!cleaner.recoveryNeeded)void cleaner.retry().catch(()=>{});
  };
  // Optional cache access belongs to its injected scope, even when already
  // mounted. The same binding follows real service unload and remount.
  cacheBinding=ownerCtx.inject(['sessionProjectionCache'],bindCache);
  const wrapFactory=originalMethod=>async function(...args){
   const callerCtx=this.ctx;
   const native=await Reflect.apply(originalMethod,this,args);
   const parent=args[0]?.parentAgent;
   const isOwned=cleaner.owned.has(native.agent)||!!parent&&cleaner.owned.has(parent);
   if(closing||!isOwned)return native;
   const wrapped=cleaner.enroll(native,parent);
   let settled=false;
   const removeOwnerHook=callerCtx.effect(()=>()=>settled?undefined:wrapped.dispose(),'native-cleaner.owned-lifecycle');
   cleaner.owned.get(native.agent).onDisposalSettled=()=>{settled=true;Promise.resolve(removeOwnerHook()).catch(()=>{});};
   return wrapped;
  };
  decoratedCreate=rawAgents.create=wrapFactory(original.agentCreate);decoratedResume=rawAgents.resume=wrapFactory(original.agentResume);
  if(closing||failed)return;
  revokeCleaner=ownerCtx.provide('nativeSessionCleaner',{
   register:agent=>cleaner.register(agent),retire:id=>cleaner.retire(id),
   drain:()=>cleaner.drain(),retry:()=>cleaner.retry()});
  // Only explicitly transferred, unfinished retirement facts in the original
  // journal are resumed. Ordinary service admission does not wait for them.
  void cleaner.recoverAccepted().catch(()=>{});
  }catch(error){await fail(error,'activation');}
 };
 await activate(ctx);
 }catch(error){await fail(error);}
}
