import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Real production startup/admission methods and Linux physical files. Markdown's
// parser, native DSH imports and unrelated role tools are explicit controlled
// ports. These checks do not claim native UI/Windows/typecheck acceptance.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'koffi') return {url:new URL('./helpers/fixture-no-replace-koffi.mjs',import.meta.url).href,shortCircuit:true}
    if (specifier === 'zod') return {url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true}
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){const children=[];for(const m of text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g))children.push({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}});return {type:'root',children}}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/skills.ts',root).href) return {url:data(`export const frameworkSkillIndexPath='technical/skills/catalog.json';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw Error('Skill parsing is outside this Host check')} export function refreshPhysicalFrameworkSkillIndex(){throw Error('Skill parsing is outside this Host check')}`),shortCircuit:true}
      if (existsSync(fileURLToPath(url))) return {url:url.href,shortCircuit:true}
    }
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url.startsWith(root.href)&&url.endsWith('.ts')) {
      const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(root.href.length),createHash('sha256').update(source).digest('hex'))
      return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
    }
    return next(url,context)
  },
})
const { restoreLegacyTask, legacyTaskNeedsRestoration } = await import('../src/framework/local-upgrade-task.ts')
const { legacyConversationNeedsRestoration } = await import('../src/framework/local-upgrade-conversation.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { FrameworkHostLoop, helperSignalWakeHash } = await import('../src/framework/host-loop.ts')
const { taskArchiveHostKey } = await import('../src/framework/task-archive.ts')
const { taskInitializationFiles } = await import('../src/framework/task-files.ts')
const scratch=process.argv[2]==='--restore'?process.argv[3]:await fs.mkdtemp(path.join(os.tmpdir(),'dss-upgrade-host-'))
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',instance='20000000-0000-4000-8000-000000000001',scope='exact-original-scope',hostKey=taskArchiveHostKey(undefined,scope,instance)
const task={version:1,taskId:id,route:'P',owner:'owner',members:['owner'],status:'running',sourcePath:'tasks/original_P.md',archiveFolder:id}
const names=[],check=(n,a,b)=>{assert.deepEqual(a,b);names.push(n)},hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,null,2)+'\n'
class DiskRecords{
 constructor(directory){this.files=new LocalRecordFiles(path.join(directory,'host-records'))}
 async get(k){const bytes=await this.files.read(hash(k)+'.json');return bytes===undefined?undefined:JSON.parse(bytes)}
 async set(k,v){await this.files.replace(hash(k)+'.json',json(v))}
 async delete(k){await this.files.delete(hash(k)+'.json')}
 async list(){throw Error('No global Host-record scan')}
}
const sourcePathFor=root=>path.join(root,'files'),note='task-runs/'+id+'/owner/Planner_Memory.md'
async function seed(root,released=false){
 const directory=sourcePathFor(root);await fs.mkdir(directory,{recursive:true});const db=new DatabaseSync(path.join(directory,'dss-files.sqlite'))
 db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT')
 const put=(p,v)=>{const bytes=Buffer.from(typeof v==='string'?v:json(v));db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)').run(p,'','fixture',bytes.length,bytes)}
 const value={...task,...(released?{status:'complete'}:{})}
 put('tasks/'+id+'.json',value);put(task.sourcePath,'Task ID: '+id+'\n# Preserve original requirement\n')
 for(const file of taskInitializationFiles(value))put(file.path,file.content??'')
 put(note,'original authored notes');put('state/owner/'+id+'/Planner_Inbox','')
 if(released)put('archives/'+id+'/state.json',{version:1,taskId:id,lifecycles:{'':{hosts:{[hostKey]:{released:true}},cleanup:{phase:'released'}}}})
 db.close();return value
}
if(process.argv[2]==='--restore'){
 const phase=process.argv[4],directory=sourcePathFor(scratch)
 await restoreLegacyTask(directory,id,hostKey,new DiskRecords(scratch),{onProgress:p=>{
  if(phase==='before-metadata'&&p.path==='tasks/'+id+'.json'&&p.step==='ready'||phase==='metadata'&&p.path==='tasks/'+id+'.json'&&p.step==='published'||phase==='source'&&p.path===task.sourcePath&&p.step==='published'||phase==='history-source'&&p.path===task.sourcePath&&p.step==='published'||phase==='signal'&&p.path==='state/owner/'+id+'/Planner_Inbox'&&p.step==='ready')process.exit(79)
 }})
 throw Error('Requested exit boundary was not reached')
}
const serviceSource=readFileSync(new URL('framework/service.ts',root),'utf8'),serviceJs=stripTypeScriptTypes(serviceSource,{mode:'transform'})
loaded.set('framework/service.ts',hash(serviceSource))
const method=name=>{const m=new RegExp('\n    (?:async )?'+name+'\\(').exec(serviceJs);assert.ok(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(serviceJs.slice(start+m[0].length));assert.ok(next,name);return serviceJs.slice(start,start+m[0].length+next.index)}
let agentConfigurations=[],agentStarts=0
class ControlledAgent{constructor(_ctx,_storage,config){this.config=config;agentConfigurations.push(config)}async start(){agentStarts++;return {status:'not-needed'}}}
const dependencies={PhysicalLocalFiles,legacyTaskNeedsRestoration,legacyConversationNeedsRestoration,LocalStartupUpgradeAgent:ControlledAgent,taskArchiveHostKey}
const Service=new Function(...Object.keys(dependencies),'return class {\n'+['startLocalUpgrade','beforeLocalTaskDiscovery','beforeLocalTaskUse','prepareConversationWrite'].map(method).join('\n')+'\n}')(...Object.values(dependencies))
const newService=records=>Object.assign(new Service(),{storage:records,ctx:{},localUpgrades:new Map(),accesses:new Map(),running:new Map(),opening:new Map(),changes:0,errors:[],changed(){this.changes++},report(_mode,error){this.errors.push(error)}})
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await sleep(10)}throw Error('Controlled condition did not settle')}
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {paths,readJson,readMemberStatus,taskLifecycle,taskLifecycleKey,isTerminalTask,assertTaskLifecycle}=await import('../src/framework/task-files.ts')
const {readTaskHistoryIdentity,taskHistoryChange}=await import('../src/framework/task-history.ts')
const {FrameworkTaskIndex}=await import('../src/framework/task-index.ts')
const {scanMemberRecovery,memberRecoveryEligible,createRecoveryWatch,dueRecoveryWatch}=await import('../src/framework/recovery.ts')
const {randomUUID}=await import('node:crypto')
const {resolveNativeRecoveryInput,nativeRecoveryWakeId}=await import('../src/framework/native-recovery-input.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',root),'utf8'),runtimeJs=stripTypeScriptTypes(runtimeSource,{mode:'transform'})
loaded.set('framework/role-runtime.ts',hash(runtimeSource))
function runtimeMethod(name){const m=new RegExp('\n    (?:async )?'+name+'\\(').exec(runtimeJs);assert.ok(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(runtimeJs.slice(start+m[0].length));assert.ok(next,name);return runtimeJs.slice(start,start+m[0].length+next.index)}
const methods=['settlePhysicalDirectDelivery','physicalSignalSources','physicalDirectInput','beforeTaskUse','currentTask','roleKey','requestKey','serialWork','settleOperations','scanMembers','memberContinuationEligible','diagnoseMissingTask','startup','retryStartupTasks','readStartupRecoveryFacts','startupRecovery','resumeImportedTask','startMaintenance','arrangeNativeContinuation','admissionWakes','runQueue','runQueueInChannel','confirmAdoptedWakes','taskRuntimeReleased','updateWake','wakeAdmission','checkWakeAdmissions','observeWakeAdmissions','rememberAdmissionWake','forgetAdmissionWake','clearLocalAdmissionInterval','localAdmissionHeld','admissionTask','admissionParent','rememberAdmissionAncestry','persistLocalAdmission','localAdmissionRecord','wake','storeWake','scheduleHelperSignal','publishHelperSignal','serialRecoveryWatch','watchKey','scheduleHostRestoreRetirement','scheduleCompletedHostRestoreRetirement','finishGitAuxiliaryRound','retrySettledHelperWakeRetirement','retireSettledHelperWakes','resetRecoveryCheck','helperResponsibilities']
class ControlledSessions{constructor(ctx){this.ctx=ctx}async inspect(id){return this.ctx.sessionEvidence?.get(id)?.inspection??{exists:false}}async inputs(id){return this.ctx.sessionEvidence?.get(id)?.inputs??new Map()}async capture(id){return {finished:this.ctx.sessionEvidence?.get(id)?.finished??false}}async events(){return []}}
const {retirePublishedDirectDelivery,resumePhysicalDirectDelivery}=await import('../src/framework/physical-direct-delivery.ts')
const {resumePhysicalHelperReportsFromEvents}=await import('../src/framework/physical-helper-report.ts')
const {parseDirectSignal,signalWorkerId}=await import('../src/framework/role-tools.ts')
const {retirePhysicalPublicationsFromEvents}=await import('../src/framework/physical-publication-retirement.ts')
const deps={DshStorageAdapter: class ControlledNonDshStorageAdapter {},resumePhysicalHelperReportsFromEvents,retirePublishedDirectDelivery,resumePhysicalDirectDelivery,retirePhysicalPublicationsFromEvents,helperSignalWakeHash,resolveNativeRecoveryInput,nativeRecoveryWakeId,taskLifecycleKey,createRecoveryWatch,PhysicalLocalFiles,GitAuthorityStore,withSnapshot,withOperationChannel,paths,readJson,readMemberStatus,taskLifecycle,isTerminalTask,assertTaskLifecycle,readTaskHistoryIdentity,FrameworkTaskIndex,scanMemberRecovery,memberRecoveryEligible,randomUUID,hash,DshSessionReader:ControlledSessions,parseDirectSignal,signalWorkerId,listAuthorityInRound:(records,prefix)=>records.list(prefix),DshAgentCreationCancelled:class extends Error{}}
const Runtime=new Function(...Object.keys(deps),'return class {\n'+methods.map(runtimeMethod).join('\n')+'\n}')(...Object.values(deps))
class RuntimeRecords{
 values=new Map();lists=[]
 async get(k){return structuredClone(this.values.get(k))}
 async set(k,v){this.values.set(k,structuredClone(v))}
 async list(p){this.lists.push(p);return [...this.values].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value)}))}
}
function runtime(files,service,connection){
 const records=new RuntimeRecords(),events=[],opens=[],errors=[],config={scope,member:'owner',mode:'local',workerSeats:3,workspace:'/controlled-workspace'}
 const rt=Object.assign(new Runtime(),{files,records,ctx:{logger:()=>({error(){}})},loop:{files,record:{completed:{}},ownsPhysicalTaskCleanup:FrameworkHostLoop.prototype.ownsPhysicalTaskCleanup,observedTask:()=>undefined},observedTerminalTasks:new Map(),wakeWrites:new Map(),wakeWriteOwners:new Map(),localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),admissionNow:()=>100000,taskSealAt:async()=>undefined,config,prefix:'runtime/',bootId:'boot',roleRecords:new Map(),knownTaskLifecycles:new Map(),admissionCancellations:new Map(),
  environment:{beforeTaskUse:(id,wait)=>service.beforeLocalTaskUse(connection,id,wait),members:()=>['owner'],resources:()=>[],error:e=>{errors.push({message:e.message});return true}},
  controls:{taskHeld:async()=>false,execution:async()=>false},startSafetyResolutionLoad(){},processObservations:async()=>{},manuallyCleared:async()=>false,rememberTerminalTask(){},
  active:r=>r.active===true,error:(e,c)=>errors.push({message:e.message,stage:c?.stage}),assertOrganizerBusiness(){},replaySafetyWake(){},replaySafetyWakes(){},waitingSafetyResolution:()=>false,transferredWorkerWake:()=>false,trackedStop(){throw Error('Unexpected stop')},
  startOwnedPump(){this.pumps=(this.pumps??0)+1},
  async wake(request,recovery){events.push({request,recovery});await records.set('runtime/wakes/'+hash(request.id),{request,recovery});return true},
  async saveRole(r){rt.roleRecords.set(r.identity.workId,r)},
  workspaces:{ensure:async id=>{await withSnapshot(files,async s=>{const t=await readJson(files,s,paths.task(id));assert.ok(t);assert.notEqual(await files.read(s,t.sourcePath),undefined)});return {directory:'/controlled/'+id}}},
  plannerWorkerExecutions:()=>[],binding:r=>r.identity,gateway:{exists:async()=>false},
  native:{open:async(identity)=>{opens.push(identity);return {send:async()=>{},hasMessage:()=>false}}},
 })
 const role=(taskId,name='Planner',props={})=>({identity:{taskId,member:'owner',role:name,workId:rt.roleKey(name,taskId),executionId:taskId+'-'+name},sessionId:'saved-'+taskId,generation:1,stopped:true,lastWake:{id:'original-'+taskId+'-'+name,role:name,taskId,reason:'notification',sources:[]},...props})
 return {rt,records,events,opens,errors,role}
}
async function drain(rt){for(let n=0;n<20;n++){const jobs=[...rt.maintenance?.values()??[],...rt.admissions?.values()??[]];if(!jobs.length)return;await Promise.all(jobs)}throw Error('Owners did not settle')}
async function independent(files){const value={...task,taskId:other,sourcePath:'tasks/independent_P.md',archiveFolder:other};await files.createIfAbsent(paths.task(other),json(value));await files.createIfAbsent(value.sourcePath,'Independent original');for(const file of taskInitializationFiles(value))await files.createIfAbsent(file.path,file.content??'');return value}
try{
 for(const phase of ['before-metadata','metadata','source','history-source']){
  const directory=path.join(scratch,phase);await seed(directory,phase==='history-source')
  const exited=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--restore',directory,phase],{encoding:'utf8'});check('Real cold exit '+phase,exited.status,79)
  const files=new PhysicalLocalFiles(sourcePathFor(directory)),records=new DiskRecords(directory),service=newService(records),connection={files,scope,identity:{instanceUUID:instance}}
  await independent(files)
  const {rt,events,errors,role}=runtime(files,service,connection)
  rt.roleRecords.set(rt.roleKey('Planner',id),role(id));rt.roleRecords.set(rt.roleKey('Planner',other),role(other))
  await rt.startup();await drain(rt)
  check('Unrelated native startup continues during '+phase,events.some(e=>e.request.taskId===other&&e.request.role==='Planner'),true)
  check('Original partial/released Task not continued '+phase,events.some(e=>e.request.taskId===id&&e.request.role==='Planner'),false)
  check('Migration never becomes missing-metadata Helper fault '+phase,errors,[])
  check('Original startup responsibility retained unless fully restored '+phase,rt.pendingStartupTasks.has(id),true)
  const work=restoreLegacyTask(files.directory,id,hostKey,records);service.localUpgrades.set(files.directory,{controller:new AbortController(),tasks:new Map([[id,work]]),conversations:new Map(),independentTasks:new Set()});await work
  rt.retryStartupTasks();await drain(rt)
  check('Only running Task resumes after exact restore '+phase,events.some(e=>e.request.taskId===id&&e.request.role==='Planner'),phase!=='history-source')
  check('Restored/released startup responsibility removed '+phase,rt.pendingStartupTasks.has(id),false)
  const before=events.filter(e=>e.request.taskId===id&&e.request.role==='Planner').length;rt.retryStartupTasks();await drain(rt)
  check('Retry does not duplicate original continuation '+phase,events.filter(e=>e.request.taskId===id&&e.request.role==='Planner').length,before)
  check('Restored/released Task produces no false missing fault '+phase,errors,[])
  await files.close()
 }
 const late=path.join(scratch,'late-task');await seed(late)
 const lateDb=new DatabaseSync(path.join(sourcePathFor(late),'dss-files.sqlite')),lateBody=Buffer.from('Original assigned work still needs continuation')
 lateDb.prepare('UPDATE files SET binary=?,bytes=? WHERE path=?').run(lateBody,lateBody.length,paths.inbox(id,'owner'))
 lateDb.prepare('DELETE FROM files WHERE path=?').run('state/owner/'+id+'/Planner_Inbox');lateDb.close()
 const lateFiles=new PhysicalLocalFiles(sourcePathFor(late)),lateRecords=new DiskRecords(late),lateService=newService(lateRecords),lateConnection={files:lateFiles,scope,identity:{instanceUUID:instance}}
 const l=runtime(lateFiles,lateService,lateConnection);await l.rt.startup();await drain(l.rt)
 check('Old Task absent at boot has no invented startup identity',l.rt.pendingStartupTasks.size,0)
 const originalInventoryReads=l.records.lists.length
 lateService.running.set('local',{connection:lateConnection,runtime:l.rt});lateService.startLocalUpgrade(lateConnection,'/workspace',{collaborationId:'chat'})
 const actual=restoreLegacyTask(lateFiles.directory,id,hostKey,lateRecords)
 agentConfigurations.at(-1).onTaskRestoration(id,actual);await actual
 await until(()=>l.rt.completedStartupTasks?.has(id));await drain(l.rt)
 check('Actual AI completion discovers late original member material',l.events.some(e=>e.request.taskId===id&&e.request.role==='Planner'),true)
 const lateCount=l.events.length;l.rt.resumeImportedTask(id);await drain(l.rt)
 check('Repeated AI completion does not repeat cold startup',l.events.length,lateCount)
 check('Late Task reuses boot inventory without repeated global scans',l.records.lists.length,originalInventoryReads)
 check('Late original Task stays out of missing-Task Helper repair',l.errors,[]);await lateFiles.close()
 const directory=path.join(scratch,'parallel-live');await seed(directory)
 const files=new PhysicalLocalFiles(sourcePathFor(directory)),records=new DiskRecords(directory),service=newService(records),connection={files,scope,identity:{instanceUUID:instance}}
 await independent(files)
 let release,paused=false;const wait=new Promise(r=>release=r)
 const work=restoreLegacyTask(files.directory,id,hostKey,records,{onProgress:async p=>{if(p.path===paths.task(id)&&p.step==='published'){paused=true;await wait}}})
 service.localUpgrades.set(files.directory,{controller:new AbortController(),tasks:new Map([[id,work]]),conversations:new Map(),independentTasks:new Set()});await until(()=>paused)
 const {rt,events,opens,errors,role}=runtime(files,service,connection)
 rt.roleRecords.set(rt.roleKey('Planner',id),role(id));rt.roleRecords.set(rt.roleKey('Planner',other),role(other))
 let eligibleSettled=false;const eligible=rt.memberContinuationEligible(role(id)).then(v=>{eligibleSettled=true;return v})
 let missingSettled=false;const missing=rt.diagnoseMissingTask(role(id)).then(v=>{missingSettled=true;return v})
 await rt.startup();await until(()=>events.some(e=>e.request.taskId===other&&e.request.role==='Planner'))
 check('Actual startup returns while only imported Task waits',eligibleSettled||missingSettled,false)
 check('Exact pending native startup owns real Promise',rt.maintenance.has('startup-task:'+id),true)
 // Existing queue has no previous native role. Actual runQueue reaches native.open
 // only after the task's physical source exists; other Task opens independently.
 const q=runtime(files,service,connection)
 for(const taskId of [id,other])await q.records.set('runtime/wakes/'+hash(taskId),{request:{id:taskId,role:'Planner',taskId,reason:'user-resume',sources:[]}})
 await q.rt.runQueue(false,undefined,false);await until(()=>q.opens.some(r=>r.taskId===other))
 check('Unrelated queued native admission opens before old restore',q.opens.map(r=>r.taskId),[other])
 check('Pending old wake is not marked delivered',(await q.records.get('runtime/wakes/'+hash(id))).delivered,undefined)
 const diagnostic=runtime(files,service,connection)
 await diagnostic.records.set('runtime/wakes/delayed',{request:{id:'delayed',role:'Planner',taskId:id,reason:'user-resume',sources:[]},admission:{eligibleSince:1,phase:'queued'}})
 await diagnostic.rt.observeWakeAdmissions();await drain(diagnostic.rt);await diagnostic.rt.checkWakeAdmissions()
 check('Migration wait is not an admission timeout',diagnostic.errors,[])
 check('Diagnostic non-wait probe does not block independent startup',diagnostic.rt.restoringAdmissionWakes.has('runtime/wakes/delayed'),true)
 release();await work;check('Eligibility succeeds after own source/materials',await eligible,true);check('Own restoration is not missing metadata',await missing,false)
 await drain(rt);await drain(q.rt)
 await diagnostic.rt.observeWakeAdmissions();await drain(diagnostic.rt);await diagnostic.rt.checkWakeAdmissions()
 check('Restoration time is excluded from admission age',(await diagnostic.records.get('runtime/wakes/delayed')).admission.eligibleSince,100000)
 check('No spurious Helper after restoration',diagnostic.errors,[])
 check('Waiting queued Task opens after restoration',q.opens.map(r=>r.taskId).sort(),[id,other].sort())
 check('Queued native admission confirms original wake',(await q.records.get('runtime/wakes/'+hash(id))).delivered,true)
 check('Native startup has no migration diagnostic',errors,[]);check('Native admissions have no errors',q.errors,[])
 // History is a visibility/reference identity, never replacement runtime.
 const history=taskHistoryChange({...task,status:'complete'});await files.replace(history.path,history.content);await files.delete(paths.task(id))
 for(const name of ['Planner','Worker','Organizer','Recorder'])check('Historical '+name+' cannot continue',await rt.memberContinuationEligible(role(id,name)),false)
 check('Historical Task is not a missing-runtime fault',await rt.diagnoseMissingTask(role(id)),true);check('Historical diagnosis stays quiet',errors,[])
 const archived=runtime(files,service,connection);await archived.records.set('runtime/wakes/released',{request:{id:'released',role:'Organizer',taskId:id,reason:'user-resume',sources:[]}})
 await archived.rt.runQueue();check('Released queued Organizer is never opened',archived.opens,[]);check('Released wake is retained for actual runtime retirement',(await archived.records.get('runtime/wakes/released')).delivered,undefined);await archived.rt.checkWakeAdmissions()
 check('Archive retirement leaves no native errors',archived.errors,[])
 // Reconstruct the saved, already-delivered Helper responsibility after a Host
 // restart. Native evidence is controlled, but actual startup/continuation,
 // storeWake signal publication and explicit recovery-reset methods execute.
 const helper=runtime(files,service,connection);delete helper.rt.wake
 helper.rt.publishedHelperSignals=new Set();helper.rt.helperWakeWrites=new Map()
 helper.rt.organizerWakeWrites=new Map();helper.rt.replaySafetyWake=()=>{}
 const oldSignal='state/Helper_owner_'+hash('old-check'),marker='state/owner/'+other+'/recovery',cycle=500
 await files.createIfAbsent(marker,'')
 const observation={kind:'recovery-check',taskId:other,member:'owner',cycleStartedAt:cycle,stage:1}
 const original={id:'recovery-check-original',role:'Helper',taskId:other,reason:'notification',sources:[{path:marker,version:'original-recovery'},{path:oldSignal,version:'consumed-old-helper'}],context:{observation}}
 const prior={identity:{role:'Helper',workId:helper.rt.roleKey('Helper'),executionId:'original-helper-execution'},sessionId:'original-helper-session',generation:1,lastWake:original,delivery:{request:original,messageId:'original-native-input',text:'Original recovery check',confirmed:true}}
 await fs.writeFile(path.join(directory,'saved-helper.json'),json({role:prior,wake:{request:original,delivered:true,signalsConsumed:true}}))
 const saved=JSON.parse(await fs.readFile(path.join(directory,'saved-helper.json'),'utf8'))
 helper.rt.roleRecords.set(prior.identity.workId,saved.role)
 await helper.records.set('runtime/wakes/'+hash(original.id),saved.wake)
 const watchKey=helper.rt.watchKey(other,'owner');await helper.records.set(watchKey,{taskId:other,member:'owner',watch:{...createRecoveryWatch({taskId:other,member:'owner'},cycle),stage:1}})
 helper.rt.ctx.sessionEvidence=new Map([[prior.sessionId,{inspection:{exists:true,lifecycleKnown:true,lastTurn:{turn:3,closed:false,reason:'interrupted'},unresolvedToolCallIds:[],queuedInbox:{nextTurn:[],nextStep:[]}},inputs:new Map([[prior.delivery.messageId,{state:'consumed',active:false,text:prior.delivery.text,source:'deepseek-servant'}]])}]])
 await helper.rt.startup();await drain(helper.rt)
 const continued=(await helper.records.list('runtime/wakes/')).find(row=>row.value.recovery?.targetExecutionId===prior.identity.executionId)
 check('Original delivered unfinished Helper owns cold continuation',!!continued,true)
 check('Cold Helper keeps original recovery-check cycle',continued.value.request.context.observation,observation)
 check('Cold Helper adopts exact original delivery',continued.value.recovery.original.messageId,prior.delivery.messageId)
 check('Consumed old Helper source is preserved as history',continued.value.request.sources.some(s=>s.path===oldSignal),true)
 check('Cold continuation requires its own Helper signal',typeof continued.value.helperSignal,'string')
 check('New signal is not a substitute recovery identity',continued.value.helperSignal!==oldSignal,true)
 check('Actual signal publication precedes native wake',await withSnapshot(files,s=>files.read(s,continued.value.helperSignal)),'')
 await helper.rt.runQueue(false,undefined,false);await drain(helper.rt)
 check('Unattached new Helper signal prevents native admission',helper.opens,[])
 check('Unfinished Helper check does not restart the recovery timer',(await helper.records.get(watchKey)).watch.cycleStartedAt,cycle)
 const completing={...prior,sessionId:'continued-helper-session',stopped:false,lastWake:continued.value.request,delivery:{request:continued.value.request,messageId:'continued-native-input',confirmed:true}}
 helper.rt.ctx.sessionEvidence.set(completing.sessionId,{finished:false})
 await helper.rt.finishGitAuxiliaryRound(completing)
 check('Unfinished native capture cannot reset recovery cycle',(await helper.records.get(watchKey)).watch.cycleStartedAt,cycle)
 helper.rt.ctx.sessionEvidence.set(completing.sessionId,{finished:true})
 await helper.rt.finishGitAuxiliaryRound(completing)
 check('Native completion alone leaves the original check pending',(await helper.records.get(watchKey)).watch.stage,1)
 check('Continued Helper explicitly resets its original check',(await helper.rt.resetRecoveryCheck(completing.identity,continued.value.request.id,new AbortController().signal)).reset,true)
 const reset=(await helper.records.get(watchKey)).watch
 check('Explicitly completed original Helper resets exact recovery watch',reset.stage,0)
 check('Completed Helper begins a new interval',reset.cycleStartedAt>cycle,true)
 check('Reset interval does not immediately emit a new check',dueRecoveryWatch(reset,reset.cycleStartedAt+1000).action,undefined)
 check('Planner recovery marker remains untouched',await withSnapshot(files,s=>files.read(s,marker)),'')
 check('Cold original Helper recovery produces no errors',helper.errors,[])
 await files.close()
 console.log(JSON.stringify({status:'passed',assertions:names.length,names,platform:process.platform,runtime:process.version,limits:'Actual full selected startup/admission/member/missing-task methods, real service per-Task wait, physical files and four real process exits. Native engine, session inspection, surrounding error/control ports are controlled. No real DSH/model/Windows acceptance or dependency-backed full typecheck.',sourceHashes:Object.fromEntries([...loaded].sort()),scriptHash:hash(readFileSync(fileURLToPath(import.meta.url)))},null,2))
}finally{hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
