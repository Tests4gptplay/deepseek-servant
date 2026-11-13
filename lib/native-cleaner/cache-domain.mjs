import {join} from 'node:path';
import {lstat,readdir,readFile,unlink} from 'node:fs/promises';
import {pinDirectory} from './pinned-directory.mjs';
import {canonicalStorePath} from './retirement-store.mjs';

/** Match a stored cache to the authoritative lifecycle, not its fold semantics.
 * Official compatible predecessors may omit or predate the Session format. */
export function cacheLifecycleMatches(header,identity){return !!identity
 && identity.createdAt===header.createdAt&&identity.cwd===header.cwd
 && (identity.isSeeded??false)===(header.isSeeded??false)
 && (identity.formatVersion===undefined||Number.isInteger(identity.formatVersion)&&identity.formatVersion>=0&&identity.formatVersion<=header.version);}

/** The cache's own queue protects cache maintenance only. Ordinary host writes
 * keep their original methods; this adapter never makes them consult DSS. */
export function coordinateCacheDomain(ctx,storageRoot,filesystem){
 const domain=ctx.get('storageDomain')?.get('session_projcache');
 if(!domain)throw new Error('Projection cache domain must already be mounted');
 const table=domain.table('sessions'),unit=domain.unit;
 if(!(table.records instanceof Map)||typeof domain.enqueue!=='function')throw new Error('Unsupported projection domain implementation');
 if(typeof unit?.dir!=='string'||canonicalStorePath(unit.dir)!==canonicalStorePath(join(storageRoot,'session_projcache')))throw new Error('Projection cache storage route does not match configured root');
 const acceptedVersions=[unit.descriptor.version,...unit.descriptor.compatibleVersions??[]];
 async function deleteHeld(id,plan){
  if(plan.deleteExact)await plan.deleteExact();
  else{for(const item of plan.targets){const now=await lstat(item.path);if(!now.isFile()||now.isSymbolicLink()||now.nlink!==1||now.dev!==item.stat.dev||now.ino!==item.stat.ino||now.size!==item.stat.size||now.mtimeMs!==item.stat.mtimeMs)throw new Error('Projection cache changed after preflight');await unlink(item.path);}await plan.sync();}
  // Disk deletion is mandatory even when this process's map is stale/absent.
  const had=table.records.delete(id);
  if(had)domain.emitChanged({domain:'session_projcache',table:'sessions',key:id,operation:'deleted'});return had;
 }
 async function planDeletion(life){
  if(filesystem)return filesystem.planCache({directory:join(unit.dir,'sessions'),life,acceptedVersions});
  if(!/^[a-zA-Z0-9_-]+$/.test(life.id))throw new Error('Session ID is unsupported by official projection storage key codec');
  let pinned;try{pinned=await pinDirectory(join(unit.dir,'sessions'));}catch(error){if(error?.code==='ENOENT')return{targets:[],preservedArtifacts:[],sync:async()=>{},close:async()=>{}};throw error;}
  try{
   const names=(await readdir(pinned.path)).filter(name=>name===life.id+'.json'||name.startsWith(life.id+'.json.bak.'));
   const targets=[],preservedArtifacts=[];
   for(const name of names){
    try{
    const path=join(pinned.path,name),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('Unsafe projection cache file');
    const row=JSON.parse(await readFile(path,'utf8'));
    if(!acceptedVersions.includes(row.version)||!cacheLifecycleMatches(life.header,row?.record?.identity))throw new Error('Projection cache file has another or unsupported lifecycle');
    targets.push({path,stat});
    }catch(error){
     if(name===life.id+'.json')throw error;
     // The official domain retains schema-invalid backups. An unassignable
     // backup stays untouched and must not block verified current artifacts.
     preservedArtifacts.push(name);
    }
   }
   return{targets,preservedArtifacts,sync:()=>pinned.sync(),close:()=>pinned.close()};
  }catch(error){
   try{await pinned.close();}catch(closeError){throw new AggregateError([error,closeError],'Projection cache planning and resource release failed');}
   throw error;
  }
 }
 return{domain,table,unit,acceptedVersions,deleteHeld,planDeletion,
  transaction:operation=>domain.enqueue(operation)};
}
