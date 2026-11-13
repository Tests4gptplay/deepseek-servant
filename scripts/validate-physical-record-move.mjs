import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import {sourceRoot,loaded,hash,hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const root=sourceRoot
const {copyRecordTree,recordTreeFingerprint}=await import(new URL('framework/record-tree-copy.ts',sourceRoot))
const {FrameworkRecordMove,recordMoveKey}=await import(new URL('framework/record-move.ts',sourceRoot))
const {LocalLocationRegistry,LocalLocationMovedError}=await import(new URL('framework/local-location.ts',sourceRoot))
const {prepareLocalRecordCopy,localRecordFingerprint}=await import(new URL('framework/maintenance.ts',sourceRoot))
const {PhysicalLocalFiles}=await import(new URL('framework/physical-local-files.ts',sourceRoot))
async function json(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;return fallback}}
async function saveJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(value));await fs.rename(file+'.tmp',file)}
const nativeFixtures=[]
async function adapter(base,initial){
 const fixture=await openDshStorageFixture(initial,path.join(base,'native-locator'))
 nativeFixtures.push(fixture)
 return fixture.adapter
}

if(process.argv[2]==='--copy-exit'){
 const base=process.argv[3],mode=process.argv[4],target=path.join(base,'target','big.bin'),original=fs.open
 fs.open=async(...args)=>{const h=await original(...args);if(String(args[0])===target){if(mode==='owner-gap')process.exit(82);const write=h.write.bind(h);h.write=async(...a)=>{const r=await write(...a);process.exit(81);return r}}return h};syncBuiltinESMExports()
 await copyRecordTree(path.join(base,'source'),path.join(base,'target'),undefined,s=>saveJson(path.join(base,'receipt.json'),s));throw new Error('Expected copy interruption')
}
if(process.argv[2]==='--technical-exit'){
 const base=process.argv[3],store=await adapter(base,path.join(base,'source')),target=path.join(base,'target','deepseek_servant','extra.bin'),original=fs.open
 fs.open=async(...args)=>{const h=await original(...args);if(String(args[0])===target){const write=h.write.bind(h);h.write=async(...a)=>{const r=await write(...a);process.exit(83);return r}}return h};syncBuiltinESMExports()
 await store.moveRecords(path.join(base,'target'),path.join(base,'source'),new AbortController().signal,undefined,'technical-cold');throw new Error('Expected technical interruption')
}
let assertions=0,processInterruptions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++},rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const base=await fs.mkdtemp(path.join(os.tmpdir(),'dss-record-move-')),opened=[]
const put=async(root,file,body)=>{await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),body)}
try{
 const source=path.join(base,'tree-source'),target=path.join(base,'tree-target');await put(source,'archives/task/records.md','长期原文\r\n');await put(source,'binary.bin',Buffer.from([0,255,13,10]));await fs.mkdir(path.join(source,'empty'));let state
 const initial=await recordTreeFingerprint(source);await copyRecordTree(source,target,undefined,async s=>{state=s});check(await recordTreeFingerprint(target),initial);check(await recordTreeFingerprint(source),initial)
 await copyRecordTree(source,target,state,async s=>{state=s});check(await recordTreeFingerprint(target),initial)
 await rejects(()=>copyRecordTree(source,target,undefined,async()=>{}),/EEXIST/)
 await rejects(()=>copyRecordTree(source,path.join(source,'nested'),undefined,async()=>{}),/non-overlapping/)
 await rejects(()=>copyRecordTree(source,path.dirname(source),undefined,async()=>{}),/non-overlapping/)
 await put(target,'user-added.txt','do not remove');await rejects(()=>copyRecordTree(source,target,state,async()=>{}),/verification failed/);check(await fs.readFile(path.join(target,'user-added.txt'),'utf8'),'do not remove')
 const linkSource=path.join(base,'link-source');await fs.mkdir(linkSource);await fs.symlink(path.join(source,'binary.bin'),path.join(linkSource,'link'));await rejects(()=>copyRecordTree(linkSource,path.join(base,'link-target'),undefined,async()=>{}),/symbolic links/)
 // Bounded buffers, short writes and cancellation run against real files.
 const largeSource=path.join(base,'large-source'),largeTarget=path.join(base,'large-target');await put(largeSource,'large.bin',Buffer.alloc(8*1024*1024,43));await put(largeSource,'__proto__','ordinary filename')
 const nativeOpen=fs.open;let maxRead=0,maxWrite=0,largeState
 fs.open=async(...args)=>{const h=await nativeOpen(...args),read=h.read.bind(h),write=h.write.bind(h);h.read=async(b,o,l,p)=>{maxRead=Math.max(maxRead,l);return read(b,o,l,p)};h.write=async(b,o,l,p)=>{maxWrite=Math.max(maxWrite,l);return write(b,o,Math.min(l,8191),p)};return h};syncBuiltinESMExports()
 try{await copyRecordTree(largeSource,largeTarget,undefined,async s=>{largeState=s})}finally{fs.open=nativeOpen;syncBuiltinESMExports()}
 check(maxRead<=256*1024,true);check(maxWrite<=256*1024,true);check(Object.hasOwn(largeState.owned,'__proto__'),true);check(await recordTreeFingerprint(largeTarget),await recordTreeFingerprint(largeSource))
 const cancelSource=path.join(base,'cancel-source'),cancelTarget=path.join(base,'cancel-target'),cancel=new AbortController();await put(cancelSource,'a.bin',Buffer.alloc(1024*1024,9));let cancelState
 fs.open=async(...args)=>{const h=await nativeOpen(...args);if(String(args[0])===path.join(cancelTarget,'a.bin')){const write=h.write.bind(h);h.write=async(...a)=>{const r=await write(...a);cancel.abort(new Error('explicit abort'));return r}}return h};syncBuiltinESMExports()
 try{await rejects(()=>copyRecordTree(cancelSource,cancelTarget,undefined,async s=>{cancelState=s},cancel.signal),/explicit abort/)}finally{fs.open=nativeOpen;syncBuiltinESMExports()}
 check((await fs.stat(path.join(cancelTarget,'a.bin'))).size,256*1024);await copyRecordTree(cancelSource,cancelTarget,cancelState,async s=>{cancelState=s});check(await recordTreeFingerprint(cancelSource),await recordTreeFingerprint(cancelTarget))
 const changeSource=path.join(base,'change-source'),changeTarget=path.join(base,'change-target');await put(changeSource,'original.txt','before');const prepared=await prepareLocalRecordCopy(changeSource,changeTarget,undefined,'physical',{save:async()=>{}});await put(changeSource,'original.txt','after');await rejects(()=>prepared.publish(),/changed/);await prepared.dispose();check(existsSync(changeTarget),false)
 // A real process stop leaves an owned prefix, which a new process resumes.
 for(const mode of ['partial','owner-gap']){
  const b=path.join(base,mode);await put(path.join(b,'source'),'big.bin',Buffer.alloc(1024*1024,91))
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--copy-exit',b,mode],{encoding:'utf8'});check(child.status,mode==='partial'?81:82);processInterruptions++
  const prior=await json(path.join(b,'receipt.json'));check((await fs.stat(path.join(b,'target','big.bin'))).size,mode==='partial'?256*1024:0)
  if(mode==='partial'){await copyRecordTree(path.join(b,'source'),path.join(b,'target'),prior,s=>saveJson(path.join(b,'receipt.json'),s));check(await recordTreeFingerprint(path.join(b,'source')),await recordTreeFingerprint(path.join(b,'target')))}
  else {await rejects(()=>copyRecordTree(path.join(b,'source'),path.join(b,'target'),prior,async()=>{}),/EEXIST/);check((await fs.stat(path.join(b,'target','big.bin'))).size,0)}
 }
 const edited=path.join(base,'edited');await put(path.join(edited,'source'),'big.bin',Buffer.alloc(1024*1024,91));check(spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--copy-exit',edited,'partial']).status,81);processInterruptions++
 await fs.writeFile(path.join(edited,'target','big.bin'),'user edit')
 // Verify edited output using the exact retained receipt, not content adoption.
 await rejects(async()=>copyRecordTree(path.join(edited,'source'),path.join(edited,'target'),await json(path.join(edited,'receipt.json')),async()=>{}),/edited/);check(await fs.readFile(path.join(edited,'target','big.bin'),'utf8'),'user edit')
 const cold=path.join(base,'technical-cold'),coldSource=path.join(cold,'source');let tech=await adapter(cold,coldSource);await tech.set('framework-instance-uuid','identity');await put(path.join(coldSource,'deepseek_servant'),'extra.bin',Buffer.alloc(768*1024,17));await tech.close()
 check(spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--technical-exit',cold],{encoding:'utf8'}).status,83);processInterruptions++
 tech=await adapter(cold,coldSource);opened.push(tech);await tech.moveRecords(path.join(cold,'target'),coldSource,new AbortController().signal,undefined,'technical-cold');check(tech.storageView().directory,path.join(cold,'target'));check(await tech.get('framework-instance-uuid'),'identity');check((await fs.stat(path.join(coldSource,'deepseek_servant','extra.bin'))).size,768*1024)
 // Technical writes already accepted during relocation wait at the existing
 // adapter barrier, then publish into the selected target, not the old copy.
 const concurrent=path.join(base,'technical-concurrent'),concurrentSource=path.join(concurrent,'source'),concurrentTarget=path.join(concurrent,'target'),concurrentStore=await adapter(concurrent,concurrentSource);opened.push(concurrentStore);await concurrentStore.set('framework-instance-uuid','before');await put(path.join(concurrentSource,'deepseek_servant'),'gate.bin',Buffer.alloc(1024*1024,8))
 let releaseRead,enteredRead,held=false;const gate=new Promise(r=>releaseRead=r),entered=new Promise(r=>enteredRead=r)
 fs.open=async(...args)=>{const h=await nativeOpen(...args);if(String(args[0])===path.join(concurrentSource,'deepseek_servant','gate.bin')){const read=h.read.bind(h);h.read=async(...a)=>{if(!held){held=true;enteredRead();await gate}return read(...a)}}return h};syncBuiltinESMExports()
 const moving=concurrentStore.moveRecords(concurrentTarget,concurrentSource,new AbortController().signal,undefined,'concurrent')
 await entered;let written=false;const queued=concurrentStore.set('framework-instance-uuid','later-technical-write').then(()=>{written=true});await new Promise(r=>setTimeout(r,15));check(written,false);releaseRead()
 try{await moving;await queued}finally{fs.open=nativeOpen;syncBuiltinESMExports()}
 check(await concurrentStore.get('framework-instance-uuid'),'later-technical-write');check(concurrentStore.storageView().directory,concurrentTarget)
 const alias=path.join(base,'source-alias');await fs.symlink(largeSource,alias);let aliasState;await copyRecordTree(alias,path.join(base,'alias-target'),undefined,async s=>{aliasState=s});check(aliasState.source,largeSource);check(await recordTreeFingerprint(path.join(base,'alias-target')),await recordTreeFingerprint(largeSource))
 // Actual coordinator + actual adapter + actual physical long-record tree.
 for(const kind of ['owned','custom']){
  const b=path.join(base,'framework-'+kind),sourceRecords=path.join(b,'records'),targetRecords=path.join(b,'new-records'),sourceLocal=kind==='owned'?path.join(sourceRecords,'deepseek_servant','framework'):path.join(b,'selected-local')
  const store=await adapter(b,sourceRecords);opened.push(store);await put(sourceLocal,'archives/task/records.md','archive original');await put(sourceLocal,'knowledge/user.txt','user-owned original');await put(sourceLocal,'conversations/chat.jsonl','{"message":"exact"}\n');await fs.mkdir(path.join(sourceLocal,'empty'))
  const scope=JSON.stringify(['local',sourceLocal]),before={revision:'before',settings:{localDirectory:sourceLocal}};await store.set('framework-settings/local',before)
  let stopped=0,reopened=0,fail=true
  const lifecycle={quiesce:async()=>{stopped++},applySettings:async r=>{await store.set('framework-settings/local',r.settingsAfter)},reopen:async r=>{reopened++;if(fail){fail=false;await put(r.targetLocal,'after-reopen.txt','legitimate new write');throw new Error('controlled reopen acknowledgement loss')}}}
  const mover=new FrameworkRecordMove(store,store,lifecycle),request={sourceRecords,targetRecords,sourceLocal,scope,localBackend:'physical',settingsBefore:before,nextSettingsRevision:'after'}
  await rejects(()=>mover.run('move-'+kind,request,new AbortController().signal),/acknowledgement loss/)
  const receipt=await mover.receipt('move-'+kind);check(receipt.phase,'reopening');check(stopped,1);check(await new LocalLocationRegistry(store).resolve(receipt.targetLocal),scope);await rejects(()=>new LocalLocationRegistry(store).resolve(sourceLocal),LocalLocationMovedError)
  check((await new FrameworkRecordMove(store,store,lifecycle).resumePending(new AbortController().signal)).phase,'applied');check(stopped,1);check(reopened,2)
  check(await fs.readFile(path.join(receipt.targetLocal,'after-reopen.txt'),'utf8'),'legitimate new write');check(await fs.readFile(path.join(sourceLocal,'archives/task/records.md'),'utf8'),'archive original');check(await fs.readFile(path.join(receipt.targetLocal,'knowledge/user.txt'),'utf8'),'user-owned original')
  await rejects(()=>mover.run('move-'+kind,{...request,localBackend:'sqlite'},new AbortController().signal),/reused/)
  check((await store.get(recordMoveKey)).receipts[0].phase,'applied')
 }
 // Execute the production service's exact move and quiesce method bodies.
 // All unrelated service dependencies are explicit ports, not a mocked method.
 const serviceSource=readFileSync(new URL('framework/service.ts',root),'utf8');loaded.set('framework/service.ts',hash(serviceSource))
 function method(name){const js=stripTypeScriptTypes(serviceSource,{mode:'transform'}),m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert(m);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));assert(next);return js.slice(start,start+m[0].length+next.index)}
 class SqlMarker{}
 const Service=new Function('LocalFiles','PhysicalLocalFiles','randomUUID','FrameworkRoleRuntime','return class {\n'+method('moveRecords')+'\n'+method('quiesceRecords')+'\n'+method('stopManualCleanup')+'\n}')(SqlMarker,PhysicalLocalFiles,()=> 'after',class {constructor(){throw new Error('Unexpected new runtime')}})
 const svc=new Service(),physical=new PhysicalLocalFiles(path.join(base,'service-local'));let captured,gitStopped=0,localStopped=0,localClosed=0
 svc.serialMode=(_mode,run)=>run();svc.assertOpen=()=>{};svc.mover=()=>({receipt:async()=>undefined,run:async(_id,request)=>{captured=request},pendingReceipt:async()=>undefined});svc.config=()=>({revision:'before',settings:{localDirectory:physical.directory}});svc.access=async()=>({connection:{files:physical,scope:'service-scope'}});svc.checkScope=(access,scope)=>assert.equal(access.connection.scope,scope);svc.storage={storageView:()=>({directory:path.join(base,'service-records')})};svc.clearResolvedErrors=()=>{};svc.changed=()=>{};svc.view=()=>({ok:true});svc.report=()=>{}
 const serviceResult=await svc.moveRecords({mode:'local',storageScope:'service-scope',expectedRevision:'before',commandId:'service-move',directory:path.join(base,'service-destination')});check(serviceResult.ok,true);check(serviceResult.recordMoveOutcome,{status:'applied',commandId:'service-move',requestedDirectory:path.join(base,'service-destination'),directory:path.join(base,'service-records')});check(captured.localBackend,'physical');check(captured.sourceLocal,physical.directory)
 svc.localUpgrades=new Map();svc.accessOpening=new Map();svc.backgroundOpening=new Map();svc.opening=new Map();svc.relocationOwners=new Map();svc.running=new Map([['local',{runtime:{settleForStorageMove:async()=>{localStopped++}},connection:{close:async()=>{localClosed++}}}],['git',{runtime:{settleForStorageMove:async()=>{gitStopped++}},connection:{close:async()=>{gitStopped++}}}]]);svc.accesses=new Map();svc.archiveViews=new Map();svc.closeAccess=async()=>{}
 await svc.quiesceRecords(captured,new AbortController().signal);check(localStopped,1);check(localClosed,1);check(gitStopped,0);check(svc.running.has('git'),true);check(svc.running.has('local'),false)
 const panel=readFileSync(new URL('framework/record-move-panel.tsx',root),'utf8');loaded.set('framework/record-move-panel.tsx',hash(panel));check(panel.includes('both Local and Git modes'),false);check(panel.includes('Git executions and native Host log locations are unchanged'),true);await physical.close()
 // Legacy SQL route still uses SQLite backup and its original digest.
 const sql=path.join(base,'sql'),sqlTarget=path.join(base,'sql-target');await fs.mkdir(sql);const db=new DatabaseSync(path.join(sql,'dss-files.sqlite'));db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,body BLOB);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE git_operations(id TEXT PRIMARY KEY,value TEXT);');db.prepare('INSERT INTO files VALUES(?,?)').run('records.md',Buffer.from('sql original'));db.close()
 const sqlFp=await localRecordFingerprint(sql),copy=await prepareLocalRecordCopy(sql,sqlTarget);await copy.publish();await copy.dispose();check(await localRecordFingerprint(sqlTarget),sqlFp);check(await localRecordFingerprint(sql),sqlFp)
 console.log(JSON.stringify({status:'passed',assertions,processInterruptions,runtime:process.version,...evidence(),limits:'Real recovered rc.5 SDK Context/Storage/locator Domain/Json backend with integrated adapter and real coordinator/copy. Service methods still use explicit unrelated controlled ports. Linux process interruption, no Windows/native UI, user data or device acceptance.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await Promise.allSettled(opened.map(s=>s.close()));await Promise.allSettled(nativeFixtures.map(f=>f.close()));hooks.deregister();await fs.rm(base,{recursive:true,force:true})}
