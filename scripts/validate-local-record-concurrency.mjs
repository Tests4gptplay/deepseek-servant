import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {syncBuiltinESMExports} from 'node:module'
import {sourceRoot,hash,hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'

// Real SDK services and native per-record JSON units. Observers below record
// calls and hold accepted writes for concurrency checks; faults use real files.
const {JsonStorageBackend}=await import('@deepseek-ai/dsh-storage-json')
const {recordFolder,recordCategories}=await import(new URL('adapters/dsh/record-files.ts',sourceRoot))
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-record-concurrency-')),opened=[],controllers=new Map(),gates=new Set()
const mkdirChecks=[],markerReads=[],nativeMkdir=fs.mkdir,nativeReadFile=fs.readFile
fs.mkdir=async(...args)=>{mkdirChecks.push(String(args[0]));return nativeMkdir(...args)}
fs.readFile=async(...args)=>{if(path.basename(String(args[0]))==='layout.json')markerReads.push(String(args[0]));return nativeReadFile(...args)}
syncBuiltinESMExports()
const nativeOpen=JsonStorageBackend.prototype.openUnit
JsonStorageBackend.prototype.openUnit=async function(...args){
 const unit=await nativeOpen.apply(this,args)
 const controller=[...controllers].find(([tree])=>this.root.startsWith(tree+path.sep))?.[1]
 if(controller&&args[0].name==='record'){
  const put=unit.putRecord.bind(unit)
  unit.putRecord=async(table,key,value)=>{
   controller.events.push(['enter',key,value.value]);await controller.before(key,value)
   await put(table,key,value)
   controller.events.push(['commit',key,value.value])
  }
 }
 return unit
}
const key=n=>'framework-user-controls/'+hash('scope')+'/tasks/'+hash(n)
const gate=()=>{let resolve,enter;const held={wait:new Promise(r=>resolve=r),entered:new Promise(r=>enter=r),open:()=>resolve(),enter:()=>enter()};gates.add(held);return held}
const limit=async(p,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Unexpected wait: '+label)),2000)})])}finally{clearTimeout(timer)}}
let assertions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++},rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
async function fixture(name){
 const directory=path.join(temp,name),tree=path.join(directory,'deepseek_servant')
 const controller={before:async()=>{},events:[]};controllers.set(tree,controller)
 const native=await openDshStorageFixture(directory,path.join(temp,name+'-locator'));opened.push(native)
 const adapter=native.adapter,files=adapter.records.files,close=files.close.bind(files);let closed=0
 files.close=()=>{closed++;return close()}
 return {adapter,controller,tree,filename:key=>path.join(tree,recordFolder(key),'record.json'),closed:()=>closed}
}
try{
 const f=await fixture('parallel'),a=key('a'),b=key('b'),c=key('c'),g=gate()
 f.controller.before=async(k,v)=>{if(k===a&&v.value===1){g.enter();await g.wait}}
 const first=f.adapter.set(a,1);await g.entered
 await limit(f.adapter.set(b,2),'another Task record');check(await f.adapter.get(b),2)
 let sameStarted=false;const second=f.adapter.set(a,3).then(()=>{sameStarted=true});await limit(f.adapter.set(c,4),'other key while same-key successor waits');check(sameStarted,false)
 check(f.controller.events.filter(e=>e[0]==='enter'&&e[1]===a).map(e=>e[2]),[1]);g.open();await Promise.all([first,second]);check(await f.adapter.get(a),3)
 check(f.controller.events.filter(e=>e[0]==='commit'&&e[1]===a).map(e=>e[2]),[1,3])
 // Normal publication keeps the real root/marker checks without mkdir on
 // every unrelated category. The target writer still creates its own parent.
 mkdirChecks.length=0;markerReads.length=0;await f.adapter.set(b,5);check(mkdirChecks.includes(f.tree),false);check(mkdirChecks.every(directory=>directory===f.tree||directory===path.dirname(f.filename(b))),true);check(markerReads,[])
 const unused=path.join(f.tree,'state/roles');await fs.rm(unused,{recursive:true});mkdirChecks.length=0
 await f.adapter.set(c,6);check(mkdirChecks.includes(f.tree),false);check(mkdirChecks.every(directory=>directory===f.tree||directory===path.dirname(f.filename(c))),true);check(existsSync(unused),false)
 const deleted=key('deleted');await f.adapter.set(deleted,1);mkdirChecks.length=0;await f.adapter.delete(deleted);check(mkdirChecks.includes(f.tree),false);check(mkdirChecks.every(directory=>directory===f.tree||directory===path.dirname(f.filename(deleted))),true);check(existsSync(unused),false)
 // Explicit repair and the original same-destination move path retain full
 // layout preparation and their existing exclusive boundary.
 await f.adapter.ensureRecordsDirectory();check(existsSync(unused),true)
 await fs.rm(unused,{recursive:true});await f.adapter.moveRecords(path.dirname(f.tree),path.dirname(f.tree),new AbortController().signal);check(existsSync(unused),true)
 await rejects(()=>f.adapter.moveRecords(path.join(f.tree,'nested'),path.dirname(f.tree),new AbortController().signal),/子文件夹/)
 check(await f.adapter.get(b),5)
 await f.adapter.set(b,5);check(await f.adapter.get(b),5)
 // Removing only one record does not trigger the old full-table write replay,
 // but its still-open native memory must not present the removed value.
 const removedOnly=key('removed-only');await f.adapter.set(removedOnly,'old')
 await fs.unlink(f.filename(removedOnly));await f.adapter.set(b,5)
 check(existsSync(f.filename(removedOnly)),false)
 check(await f.adapter.get(removedOnly),undefined)
 check((await f.adapter.list('framework-user-controls/')).some(row=>row.key===removedOnly),false)
 await f.adapter.ensureRecordsDirectory();check(existsSync(f.filename(removedOnly)),false)

 // A missing marker recreates only layout metadata. An independently removed
 // record is not restored from this Host's old in-memory table.
 const marker=path.join(f.tree,'layout.json'),savedMarker=await fs.readFile(marker,'utf8')
 await fs.unlink(marker);await fs.unlink(f.filename(c));mkdirChecks.length=0;await f.adapter.set(b,7)
 check(recordCategories.every(category=>mkdirChecks.includes(path.join(f.tree,category))),true)
 check(existsSync(f.filename(c)),false);check(await f.adapter.get(c),undefined)
 check(await fs.readFile(marker,'utf8'),savedMarker)
 const unknown='{"format":"unknown","version":99}'
 await fs.writeFile(marker,unknown);const beforeUnknown=f.controller.events.length;markerReads.length=0
 await f.adapter.set(b,8);check(f.controller.events.length,beforeUnknown+2);check(await f.adapter.get(b),8);check(markerReads,[])
 check(await fs.readFile(marker,'utf8'),unknown)
 const backups=await fs.readdir(path.join(f.tree,'backups'))
 await fs.writeFile(marker,'{truncated');await fs.rm(unused,{recursive:true});markerReads.length=0;await f.adapter.set(b,9)
 check(markerReads,[]);check(existsSync(unused),false);check(await fs.readdir(path.join(f.tree,'backups')),backups)
 check(await fs.readFile(marker,'utf8'),'{truncated')
 // Explicit directory repair still creates missing category folders without
 // rewriting existing descriptive metadata.
 await f.adapter.ensureRecordsDirectory();check(existsSync(unused),true);check(await fs.readFile(marker,'utf8'),'{truncated')

 // The actual exclusive barrier waits every accepted lease, not merely the
 // last admitted per-key tail; later writes wait outside the new generation.
 const h1=gate(),h2=gate();f.controller.before=async(k,v)=>{if(v.value===11){h1.enter();await h1.wait}if(v.value===22){h2.enter();await h2.wait}}
 const p1=f.adapter.set(a,11),p2=f.adapter.set(b,22);await Promise.all([h1.entered,h2.entered]);let exclusive=false,after=false
 const barrier=f.adapter.exclusive(async()=>{exclusive=true;check(after,false)})
 const later=f.adapter.set(c,44).then(()=>{after=true});await new Promise(r=>setTimeout(r,20));check(exclusive,false);check(after,false)
 h1.open();await p1;check(exclusive,false);h2.open();await Promise.all([p2,barrier,later]);check(exclusive,true);check(after,true)
 // A real target obstruction fails the native atomic rename. Repairing the
 // directory then permits fresh same-key and different-key writes.
 f.controller.before=async()=>{};await f.adapter.set(a,100);await f.adapter.set(b,101);check(await f.adapter.get(a),100);check(await f.adapter.get(b),101)
 const target=f.filename(a);await fs.rename(target,target+'.retained');await fs.mkdir(target)
 await rejects(()=>f.adapter.set(a,999),/EISDIR|ENOTDIR/);await rejects(()=>f.adapter.get(a),/不是普通文件/)
 await fs.rmdir(target);await fs.rename(target+'.retained',target);check(await f.adapter.get(a),100)
 await f.adapter.set(a,102);await f.adapter.set(b,103);check(await f.adapter.get(a),102);check(await f.adapter.get(b),103)
 // A user can remove the technical root outside the app. A later normal write
 // creates only its own record; old memory is not restored to disk or reads.
 const rebuild=await fixture('rebuild'),old=key('retained');await rebuild.adapter.set(a,'old-a');await rebuild.adapter.set(old,'retain-me')
 await fs.rm(rebuild.tree,{recursive:true,force:true});check(await rebuild.adapter.get(a),undefined);check(await rebuild.adapter.list('framework-user-controls/'),[])
 await rebuild.adapter.set(b,'new-b');check(await rebuild.adapter.get(b),'new-b')
 check(existsSync(rebuild.filename(old)),false);check(await rebuild.adapter.get(old),undefined)
 await rebuild.adapter.set(a,'fresh-a');check(await rebuild.adapter.get(a),'fresh-a')
 // An explicit move copies only the still-present source files, even when its
 // in-memory native table was opened before a user removed another record.
 const moving=await fixture('moving');await moving.adapter.set(a,'keep');await moving.adapter.set(old,'remove')
 await fs.unlink(moving.filename(old))
 const destination=path.join(temp,'moved-records')
 await moving.adapter.moveRecords(destination,path.dirname(moving.tree),new AbortController().signal)
 check(await moving.adapter.get(a),'keep');check(await moving.adapter.get(old),undefined)
 check(existsSync(path.join(destination,'deepseek_servant',recordFolder(a),'record.json')),true)
 check(existsSync(path.join(destination,'deepseek_servant',recordFolder(old),'record.json')),false)
 // Failed root preparation never starts record publication. Later calls may
 // retry the same supported root after that concrete filesystem fault is fixed.
 const broken=await fixture('broken');await fs.rm(broken.tree,{recursive:true});await fs.writeFile(broken.tree,'blocked-root')
 await rejects(()=>broken.adapter.set(a,'not-written'),/EEXIST|ENOTDIR|普通/);check(broken.controller.events,[]);await fs.unlink(broken.tree);await broken.adapter.set(a,'after-repair');check(await broken.adapter.get(a),'after-repair')
 await f.adapter.set(b,104);check(await f.adapter.get(b),104)
 await Promise.all(opened.map(fixture=>fixture.close()));check(f.closed(),1);check(rebuild.closed(),1);check(f.adapter.leases.size,0);await rejects(()=>f.adapter.set(a,200),/closed/)
 console.log(JSON.stringify({status:'passed',assertions,...evidence(),
  limits:'Actual pinned SDK Context/Storage/locator Domain/Json backend and production DshStorageAdapter/RecordFilesBackend. Timing holds only check accepted-write ordering; deletion and rename failure use real filesystem operations. Linux temporary data; no Windows/device acceptance, model, Git transport, full build or typecheck.',
  testDoubles:['Native putRecord before timing hook for concurrency only; filesystem observation wrappers only. No fake SDK exports or private adapter storage constructor.']},null,2))
}finally{
 for(const held of gates)held.open()
 await Promise.allSettled(opened.map(fixture=>fixture.close()))
 JsonStorageBackend.prototype.openUnit=nativeOpen
 fs.mkdir=nativeMkdir;fs.readFile=nativeReadFile;syncBuiltinESMExports();hooks.deregister()
 await fs.rm(temp,{recursive:true,force:true})
}
