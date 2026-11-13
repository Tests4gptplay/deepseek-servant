import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual dss_snapshot/dss_record installation and physical files. Schema parsing
// and unrelated Markdown/skill dependencies are explicit stubs. No native DSH,
// Windows, full typecheck or production cutover is asserted by this script.
const sourceRoot=new URL('../src/',import.meta.url),loaded=new Map()
const data=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64')
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='zod')return{url:data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`),shortCircuit:true}
 if(specifier==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(){throw new Error('Markdown outside this test')}`),shortCircuit:true}
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot.href)&&specifier.endsWith('.js')){
 const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
 if(url.href===new URL('framework/skills.ts',sourceRoot).href)return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`),shortCircuit:true}
 if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
 return next(specifier,context)},load(url,context,next){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(url===new URL('framework/role-tools.ts',sourceRoot).href && process.env.DSS_AUDIT_ROLE_TOOLS ? process.env.DSS_AUDIT_ROLE_TOOLS : new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const {PhysicalLocalFiles}=await import(new URL('framework/physical-local-files.ts',sourceRoot))
const {installFrameworkRoleTools,workerPaths}=await import(new URL('framework/role-tools.ts',sourceRoot))
const {paths,assertTaskLifecycle,readJson}=await import(new URL('framework/task-files.ts',sourceRoot))
const {withSnapshot}=await import(new URL('framework/transactions.ts',sourceRoot))
const {assertWorkerBusiness,workerTransferPath}=await import(new URL('framework/worker-business.ts',sourceRoot))
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8')
loaded.set('framework/role-runtime.ts',createHash('sha256').update(runtimeSource).digest('hex'))
const js=stripTypeScriptTypes(runtimeSource,{mode:'transform'})
function method(name){const match=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert.ok(match);const start=match.index+1;const next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+match[0].length));assert.ok(next);return js.slice(start,start+match[0].length+next.index)}
const Runtime=new Function('assertTaskLifecycle','assertWorkerBusiness','return class {\n'+['assertWorkerBusinessLive','assertWorkerOwnsBusiness','workerBusinessScope','retireWorkerBusiness'].map(method).join('\n')+'\n}')(assertTaskLifecycle,assertWorkerBusiness)
const {GitAuthorityStore}=await import(new URL('framework/git-authority.ts',sourceRoot))
const serviceStart=runtimeSource.indexOf('      workerBusiness: {',runtimeSource.indexOf('  private services()'))
const serviceEnd=runtimeSource.indexOf('\n      files: this.files,',serviceStart)
assert(serviceStart>0&&serviceEnd>serviceStart)
const serviceJs=stripTypeScriptTypes('const services={'+runtimeSource.slice(serviceStart,serviceEnd)+'};',{mode:'transform'})
const actualBusiness=runtime=>new Function('GitAuthorityStore','workerTransferPath','assertTaskLifecycle','hash','withSnapshot','readJson',serviceJs+'return services.workerBusiness;').call(runtime,GitAuthorityStore,workerTransferPath,assertTaskLifecycle,text=>createHash('sha256').update(text).digest('hex'),withSnapshot,readJson)
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-worker-record-read-reuse-')),files=new PhysicalLocalFiles(root)
const task={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/a.md'}
await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(task.sourcePath,'Original task')
const r=new Runtime();Object.assign(r,{files,roleRecords:new Map(),config:{scope:'scope',member:'A'},native:{detach(){}},drainRetiredWorker(){}})
let assertions=0,call=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,re)=>{await assert.rejects(fn,re);assertions++}
const trace=[],read=files.read.bind(files),append=files.append.bind(files),replace=files.replace.bind(files)
const tracedRead=async(s,p)=>{trace.push(['read',p]);return read(s,p)}
files.read=tracedRead
files.append=async(p,t)=>{trace.push(['append',p]);return append(p,t)}
files.replace=async(p,t)=>{trace.push(['replace',p]);return replace(p,t)}
const summary=items=>Object.fromEntries([...new Set(items)].map(p=>[p,items.filter(q=>q===p).length]))
const counts=()=>summary(trace.filter(([kind])=>kind==='read').map(([,p])=>p))
const checkTransferBeforeWrite=owned=>{
 const markerRead=trace.findIndex(([kind,p])=>kind==='read'&&p===marker(owned))
 const write=trace.findIndex(([kind])=>kind==='append'||kind==='replace')
 check(markerRead>=0&&write>markerRead,true)
}
const rawRead=async p=>{const s=await files.snapshot();try{return await read(s,p)}finally{await s.release()}}
function worker(id,store=files,runtime=r,extra={}) {
 const binding={role:'Worker',taskId:task.taskId,owner:'A',member:'A',workerId:id,workId:'work-'+id,executionId:'execution-'+id,...extra}
 runtime.roleRecords.set(binding.workId,{identity:binding,sessionId:'native-'+id,generation:1})
 const tools=new Map(),agent={id:'agent-'+id,session:{}},events=new Map(),disposers=[]
 const ctx={on:(name,fn)=>{events.set(name,fn);return()=>events.delete(name)},effect:fn=>disposers.push(fn()),systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const transactions=[]
 installFrameworkRoleTools(ctx,agent,binding,{files:store,
  async transact(id,input,options,build){transactions.push({id,input,reevaluate:options.reevaluate});await options.beforeAttempt?.();const s=await store.snapshot();try{const changes=await build(s);for(const change of changes)store.rows.set(change.path,change.content);return{revision:'git-fixed',replay:false}}finally{await s.release()}},
  notifications:async()=>[],claimNotifications:async()=>({signals:[]}),
  workerBusiness:actualBusiness(runtime)})
 return{binding,transactions,
  call:(name,input,signal=new AbortController().signal,fixedCallId)=>tools.get(name).execute(input,{agent,callId:fixedCallId??'call-'+(++call),signal,concludeTurn(){}}),
  endTurn:()=>events.get('session/event')?.(agent.session,{type:'turn/end'}),dispose:async()=>{for(const fn of disposers)await fn()}}
}
const note=w=>workerPaths(task.taskId,'A',w.binding.workerId).notes
const marker=w=>workerTransferPath(r.workerBusinessScope(),w.binding.executionId)
const record=(w,v,text='note',signal,append=true)=>w.call('dss_record',{snapshotId:v.snapshotId,path:note(w),text,append},signal)
const result={}
try {
 const a=worker('a'),b=worker('b'),av=await a.call('dss_snapshot',{}),bv=await b.call('dss_snapshot',{})
 trace.length=0;await record(a,av,'A note');result.ordinary=counts()
 checkTransferBeforeWrite(a)
 check(await rawRead(note(a)),'A note')
 trace.length=0;await record(a,av,'A replacement',undefined,false);result.replace=counts();checkTransferBeforeWrite(a);check(await rawRead(note(a)),'A replacement')
 // Use the actual installed relay and exact runtime service callbacks.
 // Post-success throws from a replacement are not a production fault model;
 // the separate physical Worker test covers a real process exit after acceptance.
 const ap=workerPaths(task.taskId,'A','a'),bp=workerPaths(task.taskId,'A','b')
 const relay={snapshotId:av.snapshotId,successorId:'b',contract:'Actual next contract',reply:'Actual accepted result',records:[]}
 trace.length=0;await record(b,bv,'B continues');result.otherWorker=counts();checkTransferBeforeWrite(b)
 await a.call('dss_worker_relay',relay,undefined,'actual-relay')
 check(JSON.parse(await rawRead(marker(a))).physical.published,true)
 check(r.roleRecords.get(a.binding.workId).businessTransferred,true)
 check(await rawRead(ap.notes),'');check(await rawRead(ap.reply),'Actual accepted result')
 check(await rawRead(bp.contract),'Actual next contract')
 check(await rawRead(paths.state('A',task.taskId)+'/Worker_b'),'')
 result.actualRelayPublishedNormally=true
 trace.length=0;await rejects(()=>record(a,av,'later'),/transferred or ended/);result.knownTransferred=counts();check(trace.some(([kind])=>kind==='append'||kind==='replace'),false);check(await rawRead(note(a)),'')
 // A held exact execution marker does not lock another Worker's record.
 const c=worker('held'),cv=await c.call('dss_snapshot',{});let release,arrive
 const held=new Promise(x=>release=x),arrived=new Promise(x=>arrive=x)
 files.read=async(s,p)=>{if(p===marker(c)){arrive();await held}return tracedRead(s,p)}
 const pending=record(c,cv,'C');await arrived
 await record(b,bv,'B parallel');check(await rawRead(note(b)),'B continuesB parallel')
 release();await pending;check(await rawRead(note(c)),'C');files.read=tracedRead
 result.heldOneMarkerDoesNotHoldOtherWorker=true
 // An already-aborted tool signal and actual installed view-retirement callbacks
 // are controlled callback checks, not native DSH pause/turn/dispose E2E.
 result.finalBoundaryRejects=[]
 for(const kind of ['pause-abort','turn-end','scope-dispose']) {
  const w=worker('cross-'+kind),v=await w.call('dss_snapshot',{}),abort=new AbortController();let hit=false
  files.read=async(s,p)=>{const value=await tracedRead(s,p);if(p===marker(w)&&!hit){hit=true
   if(kind==='pause-abort')abort.abort(new Error('user pause cancelled current tool'))
   if(kind==='turn-end')w.endTurn()
   if(kind==='scope-dispose')await w.dispose()
  }return value}
  await rejects(()=>record(w,v,'must not write',abort.signal),/user pause|Snapshot is released/)
  check(hit,true);check(await rawRead(note(w)),undefined);result.finalBoundaryRejects.push(kind)
  files.read=tracedRead
  if(kind==='pause-abort'){const resumed=await w.call('dss_snapshot',{});await record(w,resumed,'actual resumed note');check(await rawRead(note(w)),'actual resumed note')}
 }
 // Existing ordinary-record contract is not a terminal-status admission
 // gate. Native cancellation is separate; this checks only this real tool's
 // current metadata predicate, without pretending the Host kept it running.
 result.metadataStatusAloneIsNotRecordGate=[]
 for(const status of ['complete','cancelled']) {
  await replace(paths.task(task.taskId),JSON.stringify({...task,status}))
  const w=worker('terminal-record-'+status),v=await w.call('dss_snapshot',{})
  await record(w,v,'retained final facts');check(await rawRead(note(w)),'retained final facts')
  result.metadataStatusAloneIsNotRecordGate.push(status)
 }
 await replace(paths.task(task.taskId),JSON.stringify(task))
 result.liveOwnershipRejects=[]
 for(const condition of ['missing','replaced','stopped','released']) {
  const w=worker('owner-'+condition),v=await w.call('dss_snapshot',{})
  const current=r.roleRecords.get(w.binding.workId)
  if(condition==='missing')r.roleRecords.delete(w.binding.workId)
  else if(condition==='replaced')r.roleRecords.set(w.binding.workId,{...current,identity:{...current.identity,executionId:'replacement'}})
  else r.roleRecords.set(w.binding.workId,{...current,[condition]:true})
  trace.length=0;await rejects(()=>record(w,v,'not owned'),/transferred or ended/)
  check(trace.some(([kind])=>kind==='append'||kind==='replace'),false);check(await rawRead(note(w)),undefined);result.liveOwnershipRejects.push(condition)
 }
 // Fixed-snapshot non-Local port checks original branch semantics and records
 // read counts for observation only. It is not a live Git transport test.
 const gitTrace=[],rows=new Map([[paths.task(task.taskId),JSON.stringify(task)]])
 const git={rows,async snapshot(){const captured=new Map(rows);return{revision:'git-fixed',captured,release:async()=>{}}},async read(s,p){gitTrace.push(p);return s.captured.get(p)}}
 const gr=new Runtime();Object.assign(gr,{files:git,roleRecords:new Map(),config:{scope:'scope',member:'A'}})
 const gw=worker('git',git,gr),gv=await gw.call('dss_snapshot',{})
 gitTrace.length=0;await record(gw,gv,'git original')
 result.git=summary(gitTrace);check(gitTrace.includes(marker(gw)),true)
 check(rows.get(note(gw)),'git original');check(gw.transactions.length,1);check(gw.transactions[0].reevaluate,true)
 const gm=workerTransferPath(gr.workerBusinessScope(),gw.binding.executionId)
 rows.set(gm,JSON.stringify({version:1,record:{identity:gw.binding},successorId:'other'}))
 await rejects(()=>record(gw,gv,'late git'),/transferred its business responsibility/);check(rows.get(note(gw)),'git original')
 result.status='passed';result.assertions=assertions
 result.limits='Controlled callback checks for abort, turn/end and scope disposal do not drive the native DSH UI/lifecycle. Direct Task metadata deletion, same-lifecycle route mutation and JSON-only lifecycle replacement were not established as production-entry regressions and are not asserted here. Actual installed dss_record/dss_worker_relay, actual physical transfer publication and extracted unchanged runtime ownership methods/service callbacks on real PhysicalLocalFiles. Task/marker read counts are observations, not acceptance thresholds. Native Agent/schema parser/Markdown/skill packages are controlled ports. Git checks cover its non-Local branch through an immutable in-memory store, not transport/commit concurrency or actual Git read cost. Pause uses existing abort signaling; this does not claim to drive native DSH pause UI. Existing cross-file time-of-check/time-of-use boundaries are unchanged; no new atomicity, global lock, speed claim or Windows certification.'
 result.sourceHashes=Object.fromEntries(loaded)
 console.log(JSON.stringify(result,null,2))
} finally {await files.close();await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
