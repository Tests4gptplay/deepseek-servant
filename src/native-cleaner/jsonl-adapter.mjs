import { constants } from 'node:fs';
import { lstat, readdir, open, unlink, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readSessionHeader } from './exact-file.mjs';
import { sameHeader } from './coordinator.mjs';
import { randomUUID } from 'node:crypto';
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format';
import {acquireKernelLock} from './kernel-lock.mjs';
import {RetirementStore} from './retirement-store.mjs';
import {coordinateCacheDomain,cacheLifecycleMatches} from './cache-domain.mjs';
import {pinDirectory} from './pinned-directory.mjs';
import {SessionPersistenceNotFoundError} from '@deepseek-ai/dsh-session-persistence';

// Algorithms reconciled with @deepseek-ai/dsh-session-persistence-jsonl rc.5.
// Original project: deepseek-ai/deepseek-harness, MIT licensed.
export function encodeSegment(raw) {
  if(!raw.length)throw new Error('Empty path segment');
  if(raw==='.')return '~002E';if(raw==='..')return '~002E~002E';
  let out='';for(let i=0;i<raw.length;i++){const c=raw[i];out+=/^[A-Za-z0-9._-]$/.test(c)?c:'~'+raw.charCodeAt(i).toString(16).toUpperCase().padStart(4,'0');}return out;
}
export function projectKey(cwd) {
  if(!cwd.length)throw new Error('Empty cwd');let out='',separator=false;
  for(let i=0;i<cwd.length;i++){const c=cwd[i];if(c==='/'||c==='\\'||c===':'){if(!separator)out+='-';separator=true;}
    else{out+=/^[A-Za-z0-9._-]$/.test(c)?c:'~'+cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4,'0');separator=false;}}
  return `--${(out.replace(/^-+/,'')||'root').slice(0,251)}--`;
}
export function sessionDirectory(root,header){return join(root,header.cwd===undefined?'_no-cwd':projectKey(header.cwd),encodeSegment(header.id));}
const missing=error=>error?.code==='ENOENT';
async function noLink(path,kind='file') {
  const info=await lstat(path);
  if(info.isSymbolicLink()|| (kind==='directory'?!info.isDirectory():!info.isFile()) || kind==='file'&&info.nlink!==1)throw new Error('Unsafe filesystem object: '+path);
  return info;
}
async function firstHeader(path,compressed){
  await noLink(path);
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let header;const errors=[];
  try{header=await readSessionHeader({read:async(file,size)=>{
    const bytes=Buffer.allocUnsafe(size),{bytesRead}=await file.read(bytes,0,size,null);
    return bytes.subarray(0,bytesRead);
  }},handle,compressed);}catch(error){errors.push(error);}
  try{await handle.close();}catch(error){errors.push(error);}
  if(errors.length===1)throw errors[0];
  if(errors.length)throw new AggregateError(errors,'Session header read and close failed');
  return header;
}

/** Exact JSONL generations and projection-cache files. The Windows
 * filesystem backend owns native HANDLE operations; Linux uses pinned paths.
 * No directory rm, no lock unlink, no full database delete, no autonomous disk scan. */
export class ExactJsonlAdapter {
  constructor({ctx,backend,fence,root,storageRoot,filesystem}){Object.assign(this,{ctx,backend,fence,root,storageRoot,filesystem});this.store=new RetirementStore(join(storageRoot,'native-session-cleaner'),root);}
  async catalog(life,{signal}={}){
    // Read this accepted session's native facts, not query/projection caches.
    // The original close/drain precedes this read. The adapter's captured
    // backend does not reopen public admission through the retiring fence.
    let handle;
    try{handle=await this.backend.open(life.id,'read',{signal});}
    catch(error){if(error instanceof SessionPersistenceNotFoundError)return;throw error;}
    let result;const errors=[];
    try{
      if(!sameHeader(handle.header,life.header))throw new Error('Catalog header identity changed: '+life.id);
      const inheritedEventCount=handle.inheritedEventCount,{events}=await handle.read(0,undefined,{signal}),children=[];
      for(const event of events){
        if(event.type!=='subagent/catalog'||event.seq<inheritedEventCount)continue;
        const row=event.data;
        // External executions have no local Session. Other modes, versions
        // and descriptors do not decide whether a local child is retired.
        if(row?.mode==='external')continue;
        if(typeof row?.childId!=='string'||!Number.isSafeInteger(row.childCreatedAt)||row.childCreatedAt<0)
          throw new Error('Invalid native catalog child identity: '+life.id+' at '+event.seq);
        children.push({id:row.childId,createdAt:row.childCreatedAt});
      }
      result={inheritedEventCount,children};
    }catch(error){errors.push(error);}
    try{await handle.close();}catch(error){errors.push(error);}
    if(errors.length===1)throw errors[0];
    if(errors.length)throw new AggregateError(errors,'Native catalog read and close failed: '+life.id);
    return result;
  }
  async cleanup(life){
    this.fence.current(life);if(life.identity!==this.backend.identity)throw new Error('Backend replaced');
    const assertCold=()=>{if(this.ctx.agents.get(life.id)||this.ctx.sessions.get(life.id))throw new Error('A live owner replaced this session');};
    assertCold();let lease,pinned,windowsPlan,outcome;const errors=[];
    try{
      const journal=await this.store.read(life.id,life.header),stored=await this.backend.stat(life.id);
      if(stored&&!sameHeader(stored.header,life.header))throw new Error('Exact header changed');
      if(!stored&&(!journal||!sameHeader(journal.header,life.header)))throw new Error('Absent log has no exact accepted cleanup journal');
      assertCold();this.fence.current(life);
      let targets=[],preservedArtifacts=[];
      if(this.filesystem){
        windowsPlan=await this.filesystem.planLogs({root:this.root,life,allowMissing:!stored});
        targets=windowsPlan.targets;preservedArtifacts=windowsPlan.preservedArtifacts;
      }else{
      try{pinned=await pinDirectory(sessionDirectory(this.root,life.header));}catch(error){if(!missing(error)||stored)throw error;}
      const dir=pinned?.path;
      if(dir)lease=await acquireKernelLock(join(dir,'session.lock'));
      const entries=dir?await readdir(dir):[];
      for(const name of entries){
        if(name==='session.lock')continue;
        const compressed=name.endsWith('.zstd'),plain=compressed?name.slice(0,-5):name;
        const version=parseSessionFormatLogFilename(plain);
        // Official migration/publication temporaries are not generations. Keep
        // unrecognized artifacts untouched while removing verified log files.
        if(version===undefined){preservedArtifacts.push(name);continue;}
        if(version>life.header.version)throw new Error('Future format generation retained');
        const path=join(dir,name),info=await noLink(path),header=await firstHeader(path,compressed);
        if(header.type!=='session'||header.id!==life.id||header.createdAt!==life.header.createdAt||header.cwd!==life.header.cwd
          ||header.version!==version||header.parentSession!==life.header.parentSession
          ||(header.isSeeded??false)!==(life.header.isSeeded??false)||(header.delegationDepth??0)!==(life.header.delegationDepth??0)||header.agentPreset!==life.header.agentPreset)throw new Error('Generation header identity mismatch');
        targets.push({path,info});
      }
      }
      // Preserve the existing unfinished physical-cleanup responsibility.
      await this.store.write(life.header,'prepared',{inheritedEventCount:life.inheritedEventCount});
      if(windowsPlan)await windowsPlan.deleteExact(()=>{this.fence.current(life);assertCold();});
      else for(const {path,info}of targets){
        this.fence.current(life);assertCold();const now=await noLink(path);
        if(now.dev!==info.dev||now.ino!==info.ino||now.size!==info.size||now.mtimeMs!==info.mtimeMs)throw new Error('Generation changed after preflight');
        await unlink(path);
      }
      if(pinned)await pinned.sync();
      await this.store.write(life.header,'logs-removed',{inheritedEventCount:life.inheritedEventCount});
      if(await this.backend.stat(life.id)!==undefined)throw new Error('Log still visible after exact removal');
      outcome={status:'removed',files:targets.length,bytes:windowsPlan?(windowsPlan.bytes>BigInt(Number.MAX_SAFE_INTEGER)?String(windowsPlan.bytes):Number(windowsPlan.bytes)):targets.reduce((n,t)=>n+t.info.size,0),preservedArtifacts,
        ...(windowsPlan?{namespaceDurability:'unverified'}:{})};
    }catch(error){errors.push(error);}
    finally{
      for(const resource of [lease,windowsPlan,pinned])try{await resource?.close();}catch(error){errors.push(error);}
    }
    if(errors.length===1)throw errors[0];
    if(errors.length)throw new AggregateError(errors,'Exact log cleanup and resource release failed');
    await this.store.complete(life.header);
    return outcome;
  }
  async projectionFilesAbsent(life){
    // A missing optional service is not proof of missing files. On Linux,
    // inspect only this configured root and this exact session's cache names.
    if(process.platform!=='linux'||this.filesystem)return;
    if(!/^[a-zA-Z0-9_-]+$/.test(life.id))throw new Error('Session ID is unsupported by official projection storage key codec');
    let directory;
    try{directory=await pinDirectory(join(this.storageRoot,'session_projcache','sessions'));}
    catch(error){if(!missing(error))throw error;}
    try{if(directory&&(await readdir(directory.path)).some(name=>name===life.id+'.json'||name.startsWith(life.id+'.json.bak.')))return;}
    finally{await directory?.close();}
    const root=await pinDirectory(this.storageRoot);
    try{
      const path=join(root.path,'session_projcache.json');let text;
      try{await noLink(path);text=await readFile(path,'utf8');}
      catch(error){if(missing(error))return {status:'absent'};throw error;}
      const ignored=reason=>({status:'absent',preservedLegacyArtifacts:['session_projcache.json'],reason});
      let data;try{data=JSON.parse(text);}catch(error){if(error instanceof SyntaxError)return ignored('Installed Host ignores malformed legacy JSON; the source file is preserved');throw error;}
      if(data===null)throw new Error('Legacy cache is null; the Host bootstrap cannot classify this source');
      const knownRecords=data.unit?.name==='session_projcache'&&data.tables?.sessions;
      // A recognized legacy dictionary without this key proves its absence
      // without loading an optional cache package or fixing a format version.
      if(knownRecords&&typeof knownRecords==='object'&&!Array.isArray(knownRecords)&&!Object.hasOwn(knownRecords,life.id))return {status:'absent'};
      // Use the installed Host's public declaration, not a copied format number.
      let spec;
      try{({projectionCacheDomainSpec:spec}=await import('@deepseek-ai/dsh-session-projection-cache'));}
      catch(cause){throw new Error('Legacy cache format declaration is unavailable; exact session responsibility is retained',{cause});}
      if(!spec||spec.name!=='session_projcache'||!Number.isInteger(spec.version)||spec.compatibleVersions!==undefined&&!Array.isArray(spec.compatibleVersions))throw new Error('The installed cache package exposes no usable public format declaration; exact session responsibility is retained');
      const versions=[spec.version,...spec.compatibleVersions??[]];
      if(data.unit?.name!==spec.name||!versions.includes(data.unit.version))return ignored('Installed Host ignores this legacy unit name/version; the source file is preserved');
      if(typeof data.tables!=='object'||data.tables===null)return ignored('Installed Host ignores legacy data without a tables object; the source file is preserved');
      const records=data.tables.sessions;
      if(records===undefined)return {status:'absent'};
      if(records===null||typeof records!=='object'||Array.isArray(records))throw new Error('Legacy cache sessions table is malformed; exact session absence is unconfirmed');
      return Object.hasOwn(records,life.id)?undefined:{status:'absent'};
    }finally{await root.close();}
  }
  async maintainProjection(life){
    if(!this.ctx.get('storageDomain')?.get('session_projcache')){
      const absent=await this.projectionFilesAbsent(life);
      // A real mount during the physical check must use its live domain path.
      if(!this.ctx.get('storageDomain')?.get('session_projcache'))return absent??{status:'not-mounted'};
    }
    const cache=coordinateCacheDomain(this.ctx,this.storageRoot,this.filesystem);
    const assertCacheIdentity=()=>{
      const row=cache.table.get(life.id);
      if(row&&!cacheLifecycleMatches(life.header,row.identity))throw new Error('Projection cache lifecycle changed');
    };
    // The legacy source has its own exact-file lock and never mutates the
    // mounted domain map. Do not hold unrelated cache writes behind that I/O.
    assertCacheIdentity();
    const legacy=await this.pruneLegacy(life,cache.acceptedVersions);
    return cache.transaction(async()=>{
      // A domain or same-id generation may have changed while legacy work ran.
      assertCacheIdentity();
      let plan,outcome;const errors=[];
      try{
        plan=await cache.planDeletion(life);
        await cache.deleteHeld(life.id,plan);
        outcome={status:'removed',preservedCacheArtifacts:plan.preservedArtifacts,
          preservedLegacyArtifacts:Array.isArray(legacy)?legacy:legacy.preservedArtifacts,
          legacyRecoveryArtifacts:Array.isArray(legacy)?[]:legacy.recoveryArtifacts??[]};
      }catch(error){errors.push(error);}
      finally{try{await plan?.close();}catch(error){errors.push(error);}}
      if(errors.length===1)throw errors[0];
      if(errors.length)throw new AggregateError(errors,'Projection cache maintenance and resource release failed');
      return outcome;
    });
  }
  async pruneLegacy(life,acceptedVersions){
    if(!this.storageRoot)return [];
    if(this.filesystem)return this.filesystem.pruneLegacy({storageRoot:this.storageRoot,life,acceptedVersions,recovery:this.store});
    const pinned=await pinDirectory(this.storageRoot),root=pinned.path;
    const path=join(root,'session_projcache.json');
    try{
    try{await noLink(path);}catch(error){if(missing(error))return [];throw error;}
    // This lock serializes independent cleaner instances changing the shared legacy source.
    // The shipped backend only reads this file during per-record bootstrap.
    const lock=await acquireKernelLock(join(root,'.native-cleaner-legacy.lock'),{wait:true,create:true});
    try{
      const current=await noLink(path),text=await readFile(path,'utf8');let data;
      try{data=JSON.parse(text);}catch(error){if(error instanceof SyntaxError)return ['session_projcache.json'];throw error;}
      // Match the official bootstrap disposition: an ignored whole-unit source
      // stays untouched and cannot block independently verified current files.
      if(data?.unit?.name!=='session_projcache'||!acceptedVersions.includes(data.unit.version)||!data.tables?.sessions||typeof data.tables.sessions!=='object'||Array.isArray(data.tables.sessions))return ['session_projcache.json'];
      const row=data.tables.sessions[life.id];if(row===undefined)return [];
      if(!cacheLifecycleMatches(life.header,row?.identity))return ['session_projcache.json'];
      delete data.tables.sessions[life.id];
      const temp=path+'.native-cleaner-'+randomUUID()+'.tmp';
      try{
      const file=await open(temp,'wx',current.mode&0o777);
      try{await file.writeFile(JSON.stringify(data)+'\n');await file.sync();}finally{await file.close();}
      const latest=await noLink(path);if(latest.ino!==current.ino||latest.size!==current.size||latest.mtimeMs!==current.mtimeMs)throw new Error('Legacy cache changed concurrently');
      await rename(temp,path);await pinned.sync();return [];
      }finally{await unlink(temp).catch(error=>{if(!missing(error))throw error;});}
    }finally{await lock.close();}
    }finally{await pinned.close();}
  }
}
