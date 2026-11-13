import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual runtime signal-consumption methods and physical filesystem. Native DSH
// execution and unrelated parser/skill imports are explicit stubs; this does not
// claim native integration, Windows, full typecheck or production cutover.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const unexpected = `const no = () => { throw new Error('Native DSH is outside this controlled check') };`
const native = {
  '@deepseek-ai/dsh-session': `${unexpected} export const SessionId=x=>x, SessionLogOffset=x=>x, deriveEventMessage=no, isAppendSurfaceEvent=no;`,
  '@deepseek-ai/dsh-session-persistence': `export class SessionAlreadyOwnedError extends Error{}; export class SessionPersistenceNotFoundError extends Error{};`,
  '@deepseek-ai/dsh-agent': `${unexpected} export const installModelSelection=no;`,
  '@deepseek-ai/dsh-llm': `${unexpected} export const MessageId=x=>x, freezeMessage=no, errorChain=no;`,
  '@deepseek-ai/dsh-llm/assistant-stream': `${unexpected} export const expandAssistantStream=no;`,
}
// v56 imports the real storage adapter class. Resolve its SDK domain from the
// supplied actual Host installation; these tests still use controlled KV ports.
const sdkRequire = process.env.DSS_SDK_HOST_ROOT ? createRequire(path.join(process.env.DSS_SDK_HOST_ROOT, 'package.json')) : undefined
const storageSdkUrls = sdkRequire ? Object.fromEntries(['@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-storage-json'].map(name => [name, pathToFileURL(sdkRequire.resolve(name)).href])) : {}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (storageSdkUrls[specifier]) return { url: storageSdkUrls[specifier], shortCircuit: true }
    if (native[specifier]) return { url: data(native[specifier]), shortCircuit: true }
    if (specifier === 'zod') return { url: data(`const schema=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return schema},apply(){return schema}});export const z=schema;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`${unexpected} export const fromMarkdown=no;`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/skills.ts',sourceRoot).href) return { url:data(`${unexpected} export function isFrameworkSkillDefinitionPath(){throw new Error("Skill definition classification is outside this focused test")} export const frameworkSkillIndexPath='skills/index.md', prepareFrameworkSkillIndex=no, installFrameworkSkillProvider=no, initializeFrameworkSkillIndex=no, readFrameworkSkillCatalog=no;`),shortCircuit:true }
      if (existsSync(fileURLToPath(url))) return { url:url.href,shortCircuit:true }
    }
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')) {
      const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'))
      return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
    }
    return next(url,context)
  },
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { paths } = await import('../src/framework/task-files.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { publishPhysicalRecovery } = await import('../src/framework/physical-recovery.ts')

const {withSnapshot}=await import('../src/framework/transactions.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {FrameworkManualCleanup}=await import('../src/framework/manual-cleanup.ts')
const {frameworkStorageUsage}=await import('../src/framework/maintenance.ts')
const {publishPhysicalHelperReport}=await import('../src/framework/physical-helper-report.ts')
const {hostRecoveryDebugPath,hostRecoverySignalPath}=await import('../src/framework/recovery-debug-record.ts')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-isolated-recovery-'))
const task={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/a.md'}
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++};const rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const deps={hash:t=>createHash('sha256').update(t).digest('hex')}
const events=[],results=[];const event=(name,detail={})=>events.push({sequence:events.length,ms:performance.now(),name,...detail})
function latch(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Timed out: '+label)),5000))])}finally{clearTimeout(timer)}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const readAt=(f,p)=>withSnapshot(f,s=>f.read(s,p))
const taskAt=n=>({...task,taskId:'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),sourcePath:'tasks/'+n+'_P.md'})
const markerAt=t=>paths.state('A',t.taskId)+'/recovery'
const signalAt=(t,date='2026-11-09',suffix='probe')=>paths.state('A',t.taskId)+'/Planner_Recovery_'+date+'_'+suffix
async function seed(f,t){await f.replace(paths.task(t.taskId),JSON.stringify(t));await f.replace(t.sourcePath,'Original task '+t.taskId);await f.replace(paths.inbox(t.taskId,'A'),'Original Inbox\n')}
function makeRuntime(f){
 const v=new Map(),rs={async get(k){return structuredClone(v.get(k))},async set(k,x){v.set(k,structuredClone(x))},async list(prefix){return [...v].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)}))}}
 const r=Object.create(FrameworkRoleRuntime.prototype);Object.assign(r,{files:f,records:rs,prefix:'debug-audit/',config:{member:'A',primary:true},closed:false,transactions:{run(){throw Error('Unexpected generic transaction')}},taskRuntimeReleased:async()=>false,manuallyCleared:async()=>false,currentTask:async record=>record.identity.taskId,pending:[],roleRecords:new Map(),wakeConsumptions:new Map(),safetyRestoreWrites:new Map(),native:new Map(),controls:{execution:async()=>false,taskHeld:async()=>false},beforeTaskUse:async()=>true,observations:{mayApply:async()=>true,deferUnperformed:async()=>{throw Error('Unexpected deferral')}},observationTaskHeld:async()=>false,
  // Already-stopped producer boundary. This probe does not fake a native stop.
  trackedStop:record=>record.stopped===true,continuations:[],errors:[],arrangeNativeContinuation:async(record,context,_inspection,id)=>{r.continuations.push({taskId:record.identity.taskId,id,context});event('native-continuation-port',{taskId:record.identity.taskId});return true},error:(error,context)=>{r.errors.push({message:String(error),context})}})
 r.updateObservationRecord=async(pending,extra={})=>{const key=r.prefix+'observations/'+deps.hash(pending.id),current=await rs.get(key);const value={...current,pending,...extra};await rs.set(key,value);return value}
 return r
}
async function workerObservation(r,t,id){
 const identity={role:'Worker',workId:'work-'+id,executionId:'exec-'+id,workerId:'worker-'+id,taskId:t.taskId,member:'A',owner:'A'}
 r.roleRecords.set(identity.workId,{identity,stopped:true,sessionId:'stopped-session-'+id})
 const pending={id,checkedAt:Date.parse('2026-11-09T10:00:00Z'),cycleStartedAt:1,action:{stage:3,identity,elapsedMs:40*60_000,silentMs:40*60_000}}
 await r.records.set(r.prefix+'observations/'+deps.hash(id),{pending,stopStarted:true})
 return pending
}
function holdPrepared(f,name,match){
 const entered=latch(),release=latch(),original=f[name].bind(f);let hit=false
 f[name]=async(...args)=>{if(!hit&&match(args)){hit=true;const index=name==='appendPrepared'?4:5,save=args[index];args[index]=async prepared=>{await save(prepared);event('prepared-file-held',{path:args[0],stage:args[1]});entered.resolve();await release.promise}}return original(...args)}
 return {entered,release,restore(){f[name]=original}}
}
async function scan(f,t){
 const state=new Map(),errors=[],wakes=[],storage={get:async k=>state.get(k),set:async(k,v)=>state.set(k,structuredClone(v))}
 const scope='debug-audit-host',loop=new FrameworkHostLoop(f,new FrameworkTransactions(f,storage,scope),storage,{member:'A',primary:true,scope,instanceUUID:taskAt(999).taskId},()=>['A'],{
 startup:async()=>{},observe:async()=>{},physicalSignalSources:async()=>[],wake:async q=>{wakes.push(q);event('host-wake-port',{taskId:q.taskId,role:q.role,sources:q.sources});return false},executing:()=>false,sealBusiness:async()=>{},clean:async()=>false,releaseTask:async()=>{},initializeWorkspace:async()=>{},taskStateObserved:async()=>{},error:e=>errors.push(e)})
 const s=await f.snapshot();try{await bounded(loop.scanTask(t,s,performance.now()),'actual Host scan')}finally{await s.release();await loop.stop()}
 check(errors.length,0);return wakes
}
// Execute the actual service methods used by the panel's api.readFile.
const serviceSource=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8')
loaded.set('framework/service.ts',deps.hash(serviceSource))
function serviceMethod(name){const start=serviceSource.indexOf('    '+name);assert(start>=0);const after=serviceSource.slice(start+name.length+4).search(/\n    (?:private |async |[A-Za-z]+\()/);assert(after>=0);return serviceSource.slice(start,start+name.length+4+after)}
const {parseTaskReference,referenceTaskId}=await import('../src/framework/published-references.ts')
const {isConversationAttachmentPath}=await import('../src/framework/conversation-attachment-reference.ts')
const ReadService=new Function('withSnapshot','parseTaskReference','referenceTaskId','isConversationAttachmentPath','PhysicalLocalFiles','createHash',stripTypeScriptTypes('class ReadService {\n'+['private async readFileBytes(','async readFile('].map(serviceMethod).join('\n')+'\n}',{mode:'transform'})+'\nreturn ReadService')(withSnapshot,parseTaskReference,referenceTaskId,isConversationAttachmentPath,PhysicalLocalFiles,createHash)
function uiService(files){const service=new ReadService();Object.assign(service,{access:async()=>({connection:{files,scope:'audit'}}),checkScope:(_a,scope)=>assert.equal(scope,'audit'),foreground:(_a,operation)=>operation()});return service}
async function plannerRead(r,t,signal,recordPath){
 const binding={role:'Planner',taskId:t.taskId,owner:'A',member:'A',workId:r.roleKey('Planner',t.taskId),executionId:'read-'+t.taskId}
 const info=await r.files.fileInfo(signal);assert(info);const sources=[{path:signal,version:info.version}]
 const role={identity:binding,sessionId:'controlled-receiver',lastWake:{id:'read-wake-'+t.taskId,role:'Planner',taskId:t.taskId,sources}}
 r.roleRecords.set(binding.workId,role);await r.records.set(r.prefix+'roles/'+deps.hash(binding.workId),role)
 const installed=new Map(),agent={id:'planner-reader',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>installed.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,binding,{files:r.files,transact:async()=>{throw Error('Unexpected generic transaction')},notifications:(snapshot,b)=>r.notifications(snapshot,b),claimNotifications:b=>r.consumeWakeSignals(b),onError:()=>{}})
 const call=(name,input)=>installed.get(name).execute(input,{agent,callId:'read-'+name,signal:new AbortController().signal,concludeTurn(){}})
 const view=await call('dss_snapshot',{});await call('dss_claim',{snapshotId:view.snapshotId})
 const record=await call('dss_read',{snapshotId:view.snapshotId,path:recordPath})
 check(record.exists,true);check(record.path,recordPath);check(await readAt(r.files,signal),undefined)
 return record.text
}
try{
 // Actual scheduled Worker recovery: each new accepted log has its own file.
 {
  const f=new PhysicalLocalFiles(path.join(root,'independent')),r=makeRuntime(f),a=taskAt(11),b=taskAt(12),c=taskAt(13),day='debug/2026-11-09.md'
  for(const t of[a,b,c])await seed(f,t);await f.replace(day,'old daily original\n')
  const pa=await workerObservation(r,a,'obs-A'),aPath=hostRecoveryDebugPath(day,'observation-recovery:obs-A'),bPath=hostRecoveryDebugPath(day,'observation-recovery:obs-B')
  const hold=holdPrepared(f,'appendPrepared',args=>args[0]===aPath)
  await bounded(r.processObservations(false,'settle',false),'schedule A');await bounded(hold.entered.promise,'A own prepared')
  await workerObservation(r,b,'obs-B');await bounded(r.processObservations(false,'settle',false),'schedule B while A held')
  const bKey=r.prefix+'observations/'+deps.hash('obs-B');await bounded(r.observationOperations.get(bKey),'B independent operation')
  const oldB=signalAt(b,'2026-11-09',deps.hash('observation:obs-B')),newB=hostRecoverySignalPath(oldB,bPath)
  check(await readAt(f,aPath),undefined);check(await readAt(f,markerAt(a)),undefined)
  check(await readAt(f,newB),'');check(await readAt(f,oldB),undefined);check(r.continuations.map(x=>x.taskId),[b.taskId]);check(r.continuations[0].context.debugPath,bPath)
  check((await scan(f,b)).some(w=>w.role==='Planner'&&w.sources.some(x=>x.path===newB)),true)
  const body=await plannerRead(r,b,newB,bPath);check(body.includes('exec-obs-B'),true);check(body.includes('exec-obs-A'),false)
  check(await readAt(f,day),'old daily original\n')
  const aOp=r.observationOperations.get(r.prefix+'observations/'+deps.hash('obs-A'));hold.release.resolve();await bounded(aOp,'A completion')
  check((await readAt(f,aPath)).includes('exec-obs-A'),true);check(r.continuations.at(-1).context.debugPath,aPath)
  // Consumed B notification remains consumed on exact replay.
  await r.arrangeObservation((await r.records.get(bKey)).pending,'settle');check(await readAt(f,newB),undefined)
  check(r.errors,[])
  results.push({case:'actual-observations-and-tools',otherTaskCompletesWhileAPrepared:true,exactNewSignalHostClaimRead:true,legacyDailyUnchanged:true})
  await f.close()
 }
 // Holding real Helper day preparation no longer delays a Host recovery log.
 {
  const f=new PhysicalLocalFiles(path.join(root,'helper')),r=makeRuntime(f),b=taskAt(21),day='debug/2026-11-09.md';await seed(f,b);await f.replace(day,'daily\n')
  const held=holdPrepared(f,'publishPreparedReport',args=>args[0]===day),helper={commandId:'h',originalCommandId:'native-h',path:day,text:'Helper real report\n',append:true,notifyForeground:true}
  const h=publishPhysicalHelperReport(f,helper);await bounded(held.entered.promise,'Helper daily prepared')
  const log=await bounded(r.publishPhysicalMemberRecovery('new-B',{taskId:b.taskId,member:'A'},{path:day,text:'Host B facts\n'},signalAt(b)),'B despite Helper day hold')
  check(log,hostRecoveryDebugPath(day,'new-B'));check(await readAt(f,hostRecoverySignalPath(signalAt(b),log)),'');check(await readAt(f,day),'daily\n')
  held.release.resolve();await h;check(await readAt(f,day),'daily\nHelper real report\n')
  check(await readAt(f,'state/Foreground_Helper_2026-11-09_'+deps.hash('native-h')),'')
  results.push({case:'Helper-compatibility',HelperDayAndNewHostLogIndependent:true,originalForegroundDailySignalPreserved:true});await f.close()
 }
 // Actual Host restoration still saves its own evidence before its batch, but
 // its evidence no longer depends on another Task/day writer.
 {
  const f=new PhysicalLocalFiles(path.join(root,'host')),r=makeRuntime(f),a=taskAt(31),b=taskAt(32),day='debug/2026-11-09.md';for(const t of[a,b])await seed(f,t)
  const held=holdPrepared(f,'appendPrepared',args=>args[0]===day),other=publishPhysicalRecovery(f,{commandId:'legacy-day-writer',debug:{path:day,text:'legacy pending\n'}});await bounded(held.entered.promise,'old day held')
  const row={key:'host',value:{commandId:'host-new',createdAt:'2026-11-09T11:00:00Z',input:{facts:'host original',hypotheses:'unknown',actionsTaken:'preserved',continuation:'continue'},managerPublications:[a,b].map(t=>({taskId:t.taskId,member:'A',role:'Planner'}))}}
  await bounded(r.publishPhysicalHostRestoration(row),'Host batch independent of daily hold')
  const log=hostRecoveryDebugPath(day,'host-restore-debug:host-new')
  check((await readAt(f,log)).includes('host original'),true)
  for(const t of[a,b]){check(await readAt(f,paths.state('A',t.taskId)+'/Planner_Helper'),'');check(JSON.parse(await readAt(f,r.recoveryInputPath(t.taskId,'A','Planner'))).debugPath,log)}
  held.release.resolve();await other;check(await readAt(f,day),'legacy pending\n')
  results.push({case:'host-restoration',ownDebugBeforeManagers:true,otherDailyWriterDoesNotDelayBatch:true});await f.close()
 }
 // Actual role restoration has a separate debug publication and marker
 // publication. Its Worker notice must use the first publication's real path.
 {
  const f=new PhysicalLocalFiles(path.join(root,'role-restore')),r=makeRuntime(f),t=taskAt(41);await seed(f,t)
  const identity={role:'Worker',taskId:t.taskId,member:'A',owner:'A',workId:'worker-restore',executionId:'execution-restore',workerId:'w'}
  r.roleRecords.set(identity.workId,{identity,sessionId:'stopped-role',stopped:true})
  Object.assign(r,{active:()=>false,completeRestore:async(row,outcome)=>{row.value.complete=true;row.value.outcome=outcome},requestKey:q=>q.workId??r.roleKey(q.role,q.taskId,q.workerId)})
  const row={key:'restore/role',value:{commandId:'role-new',createdAt:'2026-11-09T10:05:00Z',complete:false,input:{target:identity,facts:'role original facts',hypotheses:'unknown',actionsTaken:'preserved originals',continuation:'original work'}}}
  await bounded(r.processRestore(row),'actual processRestore')
  const log=hostRecoveryDebugPath('debug/2026-11-09.md','restore-debug:role-new'),old=signalAt(t,'2026-11-09',deps.hash('restore:role-new')),actual=hostRecoverySignalPath(old,log)
  check(await readAt(f,actual),'');check(await readAt(f,old),undefined);check(r.continuations[0].context.debugPath,log)
  check((await plannerRead(r,t,actual,log)).includes('role original facts'),true)
  check(row.value.complete,true);await r.processRestore(row);check(await readAt(f,actual),undefined)
  results.push({case:'actual-role-restore',separateMarkerNamesExactRetainedLog:true});await f.close()
 }
 // Actual unadmitted wake branch includes the saved actual log in the one
 // replacement wake; released-terminal branch preserves evidence too.
 {
  const f=new PhysicalLocalFiles(path.join(root,'wake-release')),r=makeRuntime(f),t=taskAt(51);await seed(f,t)
  const original={request:{id:'not-admitted',role:'Planner',taskId:t.taskId,workId:'pending-work',sources:[],context:{original:'input'}},admission:{reportedAt:1}}
  await r.records.set(r.prefix+'wakes/'+deps.hash(original.request.id),original)
  const wakes=[];Object.assign(r,{requestKey:q=>q.workId,active:()=>false,wake:async q=>wakes.push(q),startTargetedAdmission:id=>event('targeted-admission',{id}),completeRestore:async()=>{}})
  const row={key:'restore/pending',value:{commandId:'pending-new',createdAt:'2026-11-09T10:06:00Z',complete:false,input:{wakeId:original.request.id,facts:'admission original',hypotheses:'unknown',actionsTaken:'inspected',continuation:'continue'}}}
  await r.records.set(row.key,row.value);await bounded(r.restoreUnadmittedWake(row,original),'actual unadmitted restore')
  const log=hostRecoveryDebugPath('debug/2026-11-09.md','restore-debug:pending-new')
  check(wakes.length,1);check(wakes[0].context.debugPath,log);check((await readAt(f,log)).includes('admission original'),true)
  const terminal={...t,status:'complete'};await f.replace(paths.task(t.taskId),JSON.stringify(terminal))
  const identity={role:'Worker',taskId:t.taskId,member:'A',workId:'terminal-worker',executionId:'terminal-execution'}
  r.roleRecords.set(identity.workId,{identity,stopped:true,sessionId:'terminal'})
  Object.assign(r,{stopOwnedRecord:async()=>({status:'stopped'}),observations:{unbind:async()=>{}},saveRole:async record=>r.roleRecords.set(record.identity.workId,record),environment:{changed(){}}})
  const release={key:'restore/release',value:{commandId:'release-new',createdAt:'2026-11-09T10:07:00Z',complete:false,input:{target:identity,disposition:'release',facts:'terminal original',hypotheses:'unknown',actionsTaken:'preserved',continuation:'release'}}}
  await bounded(r.releaseRestoredExecution(release),'actual released execution')
  check((await readAt(f,hostRecoveryDebugPath('debug/2026-11-09.md','restore-debug:release-new'))).includes('terminal original'),true)
  results.push({case:'actual-wake-and-release',replacementWakeRetainsActualDebugPath:true,terminalReleaseEvidenceRetained:true});await f.close()
 }
 // Exact UI data source and manual deletion: both layouts, real bytes, no
 // broader recursion or implicit cleanup of helper/native technical records.
 {
  const f=new PhysicalLocalFiles(path.join(root,'view')),day='debug/2026-11-09.md',log=hostRecoveryDebugPath(day,'view'),late=hostRecoveryDebugPath(day,'later'),named='debug/helper-reports/report.md'
  for(const[p,text]of[[day,'old daily\n'],[log,'new Host\n'],[named,'named\n'],['debug/unrelated.md','not selected\n'],['debug/.recovery/keep.json','technical\n']])await f.replace(p,text)
  const cleanup=new FrameworkManualCleanup(f,{}, {scope:{mode:'local',collaborationId:'audit',assistantId:'audit'},prepare:async()=>{}},{}),preview=await cleanup.previewFiles('debug')
  check(preview.files.map(x=>x.path),[day,log,named].sort((a,b)=>a.localeCompare(b)))
  const actual=[],service=uiService(f);for(const row of preview.files)actual.push(await service.readFile({mode:'local',storageScope:'audit',path:row.path}));check(actual.some(x=>x.path===log&&x.text==='new Host\n'),true)
  await f.append(day,'later user edit\n');await f.replace(late,'new later operation\n')
  const result=await cleanup.clearDebug('explicit-confirmed',preview,'clear-debug-records')
  check(result.deletedPaths.sort(),[log,named].sort());check(result.preservedPaths,[day]);check(await readAt(f,late),'new later operation\n');check(await readAt(f,'debug/unrelated.md'),'not selected\n');check(await readAt(f,'debug/.recovery/keep.json'),'technical\n')
  check((await frameworkStorageUsage(f)).permanent.debugBytes,Buffer.byteLength('old daily\nlater user edit\nnew later operation\nnot selected\ntechnical\n'))
  results.push({case:'UI-preview-read-cleanup',oldAndNewRealFilesListed:true,exactConfirmedSelection:true,newerAndUnrelatedPreserved:true});await f.close()
 }
 console.log(JSON.stringify({status:'passed',assertions,results,events,sourceHashes:Object.fromEntries(loaded),limits:'Full actual runtime classes/tools/Host scan and real Linux files. Native already-stopped producers, technical records, continuation and wake ports controlled. UI actual preview/read/cleanup data contract tested, not rendered native UI. No Windows, power-loss or full static compilation.'},null,2))
}finally{await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
