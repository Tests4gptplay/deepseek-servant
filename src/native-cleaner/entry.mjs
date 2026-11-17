export const name='deepseek-servant-native-cleaner';
export const inject=['agents','sessions','sessionPersistence','storage','storageDomain'];
/** Failure decisions belong to this wrapper, not a removable cleaner binding.
 * Updating a decision never removes/restarts the ordinary cache or DSS owner. */
export async function apply(ctx,config={}){
 const platform=process.platform,provided=new Set();let failed=false;
 const publish=(key,state)=>{
  state=Object.freeze(state);
  if(provided.has(key)){
   // The provider may already be gone during package unload. Do not recreate it.
   if(ctx.get(key,false))ctx.set(key,state);
  }else{ctx.provide(key,state);provided.add(key);}
 };
 const onFailure=(error,stage='module-load')=>{
  if(failed)return;failed=true;
  const state={status:'failed',platform,stage,error:String(error)};
  ctx.logger.warn(`Native session cleanup failed during ${stage}; DSS remains available without automatic session cleanup. ${String(error)}`);
  publish('nativeSessionCleanerComposition',state);
 };
 if(platform!=='linux'&&platform!=='win32'){
  const state={status:'unsupported-platform',platform};
  ctx.logger.warn(`Native session cleanup is not implemented for ${platform}; DSS remains available without automatic session cleanup.`);
  publish('nativeSessionCleanerComposition',state);return;
 }
 try{
  // A callback during Cleaner.apply is too early: the providing fiber may not
  // be active yet. Observe actual service availability before declaring active.
  const binding=ctx.inject(['nativeSessionCleaner'],ownerCtx=>{
   if(failed)return;
   publish('nativeSessionCleanerComposition',{status:'active',platform});
   ownerCtx.effect(()=>()=>{
    if(!failed)publish('nativeSessionCleanerComposition',{status:'unavailable',platform});
   },'native-cleaner.availability');
  });
  ctx.effect(()=>()=>binding.dispose(),'native-cleaner.composition');
  // Import failures, including native loader failures, enter the same boundary.
  const Cleaner=await import('./plugin.mjs');
  await Cleaner.apply(ctx,config,{onFailure});
 }catch(error){onFailure(error);}
}
