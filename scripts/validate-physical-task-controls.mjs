import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Production controls, resume publisher, observation store/scheduler, service
// taskControl and Foreground write methods; physical JSON test StoragePort.
// SDK/schema, native scheduling and session ownership are explicit test ports.
const root = new URL('../src/', import.meta.url), loaded = new Map(), hash = s => createHash('sha256').update(s).digest('hex')
const data = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64')
const hooks = registerHooks({ resolve(s,c,n) {
  if(s==='@deepseek-ai/dsh-storage-json') return {url:data(`import fs from 'node:fs/promises';import path from 'node:path';
    export class JsonStorageBackend {constructor(root){this.root=root;this.kv={open:async()=>{
      const file=path.join(root,'record.json');let value;try{value=JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;value={tables:{records:{}},global:null}}
      const save=async()=>{await fs.mkdir(root,{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(value));await fs.rename(file+'.tmp',file)};
      return {loadAll:async()=>structuredClone(value),putRecord:async(t,k,v)=>{value.tables[t][k]=structuredClone(v);await save()},deleteRecord:async(t,k)=>{delete value.tables[t][k];await save()},close:async()=>{}}}}}async close(){}}
    `),shortCircuit:true}
  if(s==='zod') return {url:data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return z},apply(){return z}});export {z}`),shortCircuit:true}
  if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')) {const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}
  return n(s,c)
},load(u,c,n) {if(u.startsWith(root.href)&&u.endsWith('.ts')) {const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),hash(s));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})
const { DshStorageAdapter }=await import('../src/adapters/dsh/storage.ts')
const { PhysicalLocalFiles }=await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles }=await import('../src/framework/local-record-files.ts')
const { ExecutionControls }=await import('../src/framework/execution-control.ts')
const { publishTaskResume }=await import('../src/framework/task-resume.ts')
const { physicalControlSignalSources }=await import('../src/framework/physical-control-signal-sources.ts')
const { ExecutionObservations }=await import('../src/framework/execution-observation.ts')
const { DurableObservationStore }=await import('../src/framework/observation-store.ts')
const { GitAuthorityStore }=await import('../src/framework/git-authority.ts')
const { paths, readJson, readMemberStatus, taskLifecycle, isTerminalTask }=await import('../src/framework/task-files.ts')
const { withSnapshot, withOperationChannel }=await import('../src/framework/transactions.ts')
const { FrameworkCleaner, readTaskCleanupRecord }=await import('../src/framework/cleaner.ts')
const { foregroundFullGuide }=await import('../src/framework/role-prompts.ts')
const { upgradeForegroundGuide }=await import('../src/framework/foreground-guide-upgrade.ts')
const { RecordFilesBackend, recordCategory, recordFolder }=await import('../src/adapters/dsh/record-files.ts')
const { taskFamily }=await import('../src/framework/task-relations.ts')
const { createObservation, memberRecoveryEligible, scanMemberRecovery }=await import('../src/framework/recovery.ts')
class TechnicalRecords {
 constructor(directory){this.files=new LocalRecordFiles(directory)}
 async get(key){const bytes=await this.files.readBytes(key+'.json');return bytes===undefined?undefined:JSON.parse(new TextDecoder().decode(bytes))}
 async set(key,value){await this.files.replace(key+'.json',JSON.stringify(value))}
 async list(prefix){const rows=await this.files.listMetadata(prefix.endsWith('/')?prefix:prefix+'/',true);return Promise.all(rows.filter(r=>r.path.endsWith('.json')).map(async r=>({key:r.path.slice(0,-5),value:await this.get(r.path.slice(0,-5))})))}
 async delete(key){await this.files.delete(key+'.json')}
}
const ids=[1,2,3,4].map(n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'))
const scope='physical-controls',instanceUUID=ids[3],controlKey='framework-user-controls/'+hash(scope)
const tasks=()=>{
 const a={version:1,taskId:ids[0],route:'O',owner:'A',members:['A'],status:'running',sourcePath:'tasks/root_O.md',archiveFolder:ids[0]}
 const b={...a,taskId:ids[1],route:'P',owner:'B',members:['B'],sourcePath:'tasks/child_P.md',archiveFolder:ids[0]+'/'+ids[1],parent:{taskId:a.taskId,owner:a.owner,objectiveId:'child'}}
 const c={...b,taskId:ids[2],owner:'C',members:['C'],sourcePath:'tasks/sibling_P.md',archiveFolder:ids[0]+'/'+ids[2],parent:{taskId:a.taskId,owner:a.owner,objectiveId:'sibling'}}
 a.children=[{taskId:b.taskId,member:b.owner,objectiveId:'child'},{taskId:c.taskId,member:c.owner,objectiveId:'sibling'}];return[a,b,c]
}
async function seed(files){for(const t of tasks()){await files.replace(paths.task(t.taskId),JSON.stringify(t));await files.replace(paths.inbox(t.taskId,t.owner),'Existing work '+t.taskId)}}
function fixture(directory){const files=new PhysicalLocalFiles(directory),store=new TechnicalRecords(path.join(directory,'technical-test'));const controls=new ExecutionControls(store,scope,()=> '2026-11-09T01:00:00.000Z',files,store,instanceUUID);return{files,store,controls}}
const transactions={run(){throw new Error('Generic Local transaction reached')}}
const access=f=>({...f,transactions,member:'A',active:false,physicalSignalSources:physicalControlSignalSources(f.store,scope,'A')})
const input={taskId:ids[0]},resumePath=cmd=>paths.run(ids[0])+'/.user-resume-'+hash(cmd)+'.json'
const read=(files,p)=>withSnapshot(files,s=>files.read(s,p))
const notifications=(files)=>withSnapshot(files,async s=>(await files.list(s,'state/')).map(e=>e.path).sort())
function method(source,name){const js=stripTypeScriptTypes(source,{mode:'transform'}),match=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert(match);const start=match.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+match[0].length));assert(next);return js.slice(start,start+match[0].length+next.index)}
function actualEntryPoints(f){
 const serviceSource=readFileSync(new URL('framework/service.ts',root),'utf8'),runtimeSource=readFileSync(new URL('framework/role-runtime.ts',root),'utf8');loaded.set('framework/service.ts',hash(serviceSource));loaded.set('framework/role-runtime.ts',hash(runtimeSource))
 const dependencies={PhysicalLocalFiles,withSnapshot,withOperationChannel,readTaskCleanupRecord,readJson,paths,taskLifecycle,publishTaskResume,physicalControlSignalSources,z:{enum:()=>({parse:v=>v})},submitTaskCancellation:()=>{throw new Error('Terminal cancellation covered separately')}}
 const Service=new Function(...Object.keys(dependencies),'return class {\n'+method(serviceSource,'taskControl')+'\n}')(...Object.values(dependencies));const svc=new Service(),scheduled=[]
 const connection={files:f.files,sharedRecords:f.store,records:f.store,scope,transactions,identity:{instanceUUID},registration:{member:'A'}}
 const publications=[]
 const runtime={...f,config:{primary:true,member:'A',collaborationId:'collab'},roleRecords:new Map(),stopOperations:new Map(),transactions,archiveHostKey:()=> 'fixture-host',scheduleTaskResume:(...args)=>scheduled.push(args),taskControlPublished:(...args)=>publications.push(args),physicalSignalSources:physicalControlSignalSources(f.store,scope,'A')}
 svc.config=()=>({settings:{collaborationId:'collab'}});svc.running=new Map([['local',{connection,runtime}]]);svc.withAccessOperation=async(_input,fn)=>fn({connection,commandHostKey:'fixture-host'});svc.controls=()=>f.controls
 // These fixtures are new physical Tasks, with no original SQL or pending upgrade.
 // The separate Task-upgrade suite exercises this preparation boundary.
 svc.beforeLocalTaskUse=async (current,taskId)=>{assert.equal(current,connection);assert(tasks().some(t=>t.taskId===taskId));return true}
 const start=runtimeSource.indexOf('      taskControl: {',runtimeSource.indexOf('  private services()')),end=runtimeSource.indexOf('\n      cancelTask:',start)
 assert(start>0&&end>start)
 const literal=stripTypeScriptTypes('const services={'+runtimeSource.slice(start,end)+'};',{mode:'transform'})
 runtime.taskControl=new Function('GitAuthorityStore',...Object.keys(dependencies),literal+'return services.taskControl;').call(runtime,GitAuthorityStore,...Object.values(dependencies))
 const binding={role:'Foreground',owner:'A',member:'A',workId:'Foreground',executionId:'fg-execution',collaborationId:'collab'}
 runtime.roleRecords.set(binding.workId,{identity:{role:'Foreground',executionId:binding.executionId},sessionId:'fixture-session',generation:1})
 return{svc,runtime,binding,scheduled,publications}
}
if(process.argv[2]==='--interrupt'){
 const f=fixture(process.argv[3]),mode=process.argv[4],cmd='restart-'+mode,rename=f.files.rename.bind(f.files),exit=()=>process.exit(79)
 const remove=f.files.delete.bind(f.files),update=f.files.updateInExistingDirectory.bind(f.files)
 // A consumed source is owned by the existing receiver record. Removing it
 // without this original fact is no longer valid proof of successful delivery.
 const consume=async p=>{const info=await f.files.fileInfo(p);assert(info);const role=p.split('/').at(-1).startsWith('Organizer_')?'Organizer':'Planner',taskId=p.split('/')[2]
  await f.store.set('framework-runtime/'+hash(scope)+'/roles/'+hash(JSON.stringify([role,taskId,null,null])),{lastWake:{sources:[{path:p,version:info.version}]}})
  await remove(p)}
 f.files.updateInExistingDirectory=async(p,decide,signal,coordinateRemoval)=>{const value=await update(p,decide,signal,coordinateRemoval)
  if(mode==='receipt'&&p===f.controls.taskRecordPath(ids[0])&&(JSON.parse(await read(f.files,p))).commands[hash(cmd)]?.resumeHandled){const row=JSON.parse(await read(f.files,resumePath(cmd)));await consume(row.signals[0].path);exit()}
  if(mode==='stage'&&p.endsWith('.stage'))exit()
  if(p===resumePath(cmd)){const row=JSON.parse(await read(f.files,p));if(mode==='planned'&&!row.signals.some(v=>v.prepared))exit();if(mode==='prepared'&&row.signals.some(v=>v.prepared&&!v.published))exit();if(mode==='published'&&row.signals.some(v=>v.published)){await consume(row.signals.find(v=>v.published).path);exit()}}
  return value}
 f.files.delete=async p=>{let row;if(mode==='retired'&&p===resumePath(cmd))row=JSON.parse(await read(f.files,p));const result=await remove(p);if(row){await consume(row.signals[0].path);exit()}return result}
 f.files.rename=async(from,to)=>{const r=await rename(from,to);if(mode==='consumed'&&to.includes('UserResume_')){await consume(to);exit()}return r}
 await publishTaskResume(access(f),input,cmd);throw new Error('Expected interruption did not occur')
}
let assertions=0,processInterruptions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++},rejects=async(fn,re)=>{await assert.rejects(fn,re);assertions++}
const timeout=(p,label)=>Promise.race([p,new Promise((_,reject)=>{const id=setTimeout(()=>reject(new Error('Blocked independent '+label)),2000);id.unref()})])
const gate=()=>{let open,enter;return{wait:new Promise(r=>open=r),entered:new Promise(r=>enter=r),open:()=>open(),enter:()=>enter()}}
const base=await fs.mkdtemp(path.join(os.tmpdir(),'dss-task-controls-')),opened=[]
const make=async name=>{const f=fixture(path.join(base,name));opened.push(f);await seed(f.files);return f}
try {
 const fullGuide=foregroundFullGuide(),oldControlSentence='Local mode keeps the same control value in its scoped StoragePort; this logical address does not create a physical JSON file.',newControlSentence='Local Task controls live in task-runs/<taskId>/control.json and are reclaimed with that Task directory; this tool submits the validated request without replacing the file envelope.'
 check(fullGuide.includes(newControlSentence),true);check(fullGuide.includes(oldControlSentence),false)
 const priorGuide=fullGuide.replace(newControlSentence,oldControlSentence)
 check(upgradeForegroundGuide(priorGuide).text,fullGuide);check(upgradeForegroundGuide(priorGuide).changedRules,1)
 check(upgradeForegroundGuide(priorGuide.replaceAll('\n','\r\n')+'\r\nKeep this user edit.').text,fullGuide.replaceAll('\n','\r\n')+'\r\nKeep this user edit.')
 check(upgradeForegroundGuide('Custom user guide. '+oldControlSentence).text,'Custom user guide. '+oldControlSentence)
 const backendRoot=path.join(base,'record-backend'),backend=new RecordFilesBackend(backendRoot),descriptor={name:'deepseek_servant',version:1,tables:['records'],hasGlobal:false}
 const unit=await backend.kv.open(descriptor),keys=[controlKey,...['tasks','executions','commands'].map(kind=>controlKey+'/'+kind+'/'+hash(kind))]
 for(const key of keys){check(recordCategory(key),'state/user-controls');await unit.putRecord('records',key,{key,value:{test:key}});check(existsSync(path.join(backendRoot,recordFolder(key),'record.json')),true)}
 await backend.close();const reopenedBackend=new RecordFilesBackend(backendRoot),reopenedUnit=await reopenedBackend.kv.open(descriptor)
 check(Object.keys((await reopenedUnit.loadAll()).tables.records).sort(),keys.sort())
 for(const key of keys)await reopenedUnit.deleteRecord('records',key)
 check(Object.keys((await reopenedUnit.loadAll()).tables.records),[]);await reopenedBackend.close()
 for(const key of [controlKey+'/unknown/'+hash('x'),controlKey+'/tasks/not-a-hash',controlKey+'/tasks/'+hash('x')+'/extra']){check(recordCategory(key),undefined);check((()=>{try{recordFolder(key);return false}catch{return true}})(),true)}
 const f=await make('actual-entry'),[a,b,c]=tasks(),{svc,runtime,binding,scheduled,publications}=actualEntryPoints(f)
 await svc.taskControl({mode:'local',taskId:a.taskId,intent:'paused',commandId:'ui-pause'});check(await f.controls.taskHeld(b.taskId),true)
 check(publications.map(([task,intent])=>[task.taskId,intent]),[[a.taskId,'paused']])
 await f.controls.setTask('child-pause',b.taskId,'paused')
 const before=await read(f.files,paths.task(a.taskId))
 await svc.taskControl({mode:'local',taskId:a.taskId,intent:'running',commandId:'ui-resume'})
 check(await f.controls.taskHeld(a.taskId),false);check(await f.controls.taskHeld(b.taskId),true);check(await f.controls.taskHeld(c.taskId),false);check(scheduled.length,1);check(await read(f.files,paths.task(a.taskId)),before)
 const uiSignals=await notifications(f.files);check(uiSignals.some(p=>p.includes('/'+b.taskId+'/')),false);check(uiSignals.some(p=>p.includes('/'+c.taskId+'/Planner_')),true)
 for(const signal of uiSignals){check(await read(f.files,signal),'');await f.files.delete(signal)}
 await svc.taskControl({mode:'local',taskId:a.taskId,intent:'running',commandId:'ui-resume'});check(await notifications(f.files),[])
 await runtime.taskControl.write(binding,{taskId:a.taskId,intent:'paused'},'fg-pause',new AbortController().signal)
 check(await f.controls.taskHeld(c.taskId),true)
 await runtime.taskControl.write(binding,{taskId:a.taskId,intent:'running'},'fg-resume',new AbortController().signal)
 check(await f.controls.taskHeld(c.taskId),false);check(await f.controls.taskHeld(b.taskId),true);check(scheduled.at(-1),[a.taskId,'fg-resume',''])
 await rejects(()=>runtime.taskControl.write({...binding,executionId:'stale'},{taskId:a.taskId,intent:'paused'},'fg-stale',new AbortController().signal),/unavailable Foreground/)
 // The original runtime resume method reads real current Task and worker
 // notes. Its native continuation boundary must retain the same lifecycle,
 // workId, executionId and user-selected child pause, including a nonempty round.
 const resumed=await make('runtime-resume'),family=tasks().map(t=>({...t,lifecycleId:'existing-round',owner:'A',members:['A'],...(t.parent?{parent:{...t.parent,owner:'A'}}:{}),...(t.children?{children:t.children.map(c=>({...c,member:'A'}))}:{})}))
 for(const t of family){await resumed.files.replace(paths.task(t.taskId),JSON.stringify(t));await resumed.files.replace(paths.inbox(t.taskId,'A'),'Accepted original responsibility');if(t.route==='P')await resumed.files.replace(paths.member(t.taskId,'A')+'/workers/original-worker/notes.md','Existing unfinished work')}
 const rs=readFileSync(new URL('framework/role-runtime.ts',root),'utf8'),deps={PhysicalLocalFiles,paths,readJson,readMemberStatus,taskLifecycle,isTerminalTask,withSnapshot,taskFamily,scanMemberRecovery,memberRecoveryEligible}
 const ResumeRuntime=new Function(...Object.keys(deps),'return class {\n'+['resumeTask','scanMembers'].map(name=>method(rs,name)).join('\n')+'\n}')(...Object.values(deps)),rr=new ResumeRuntime(),continuations=[]
 rr.files=resumed.files;rr.controls=resumed.controls;rr.config={member:'A'};rr.roleRecords=new Map();rr.stopOperations=new Map();rr.knownTaskLifecycles=new Map();rr.manuallyCleared=async()=>false;rr.rememberTerminalTask=t=>rr.knownTaskLifecycles.set(t.taskId,taskLifecycle(t));rr.error=e=>{throw e};rr.active=()=>false;rr.serialWork=async(_key,fn)=>fn();rr.roleKey=(role,task,worker)=>JSON.stringify([role,task,worker??null]);rr.requestKey=request=>rr.roleKey(request.role,request.taskId,request.workerId);rr.currentTask=async record=>record.identity.taskId;rr.queueOrganizerLedger=async()=>{};rr.pump=async()=>{};rr.wake=async()=>{throw new Error('Must continue the original owned records')}
 rr.arrangeNativeContinuation=async(record,_context,_inspection,_id,_fallback,replacement)=>{check(replacement.taskId,record.identity.taskId);check(taskLifecycle(replacement),taskLifecycle(record.identity));continuations.push(structuredClone(record.identity));return replacement}
 for(const t of family){const role=t.route==='O'?'Organizer':'Worker',workerId=role==='Worker'?'original-worker':undefined,workId=rr.roleKey(role,t.taskId,workerId);rr.roleRecords.set(workId,{identity:{role,taskId:t.taskId,lifecycleId:t.lifecycleId,workId,executionId:'original-'+t.taskId,workerId},stopped:true,lastWake:{id:'original-wake',role,taskId:t.taskId,lifecycleId:t.lifecycleId,sources:[]}})}
 await resumed.controls.setTask('selected-child-paused',family[1].taskId,'paused',family[1].lifecycleId)
 await resumed.controls.setTask('same-round-resume',family[0].taskId,'running',family[0].lifecycleId)
 const beforeResume=await Promise.all(family.map(t=>read(resumed.files,paths.task(t.taskId))))
 await rr.resumeTask(family[0].taskId,'same-round-resume',family[0].lifecycleId,true)
 check(continuations.map(i=>i.taskId).sort(),[family[0].taskId,family[2].taskId].sort());check(continuations.every(i=>i.executionId==='original-'+i.taskId&&i.lifecycleId==='existing-round'),true)
 check(await Promise.all(family.map(t=>read(resumed.files,paths.task(t.taskId)))),beforeResume)
 await resumed.controls.setTask('later-pause',family[0].taskId,'paused',family[0].lifecycleId);await rr.resumeTask(family[0].taskId,'same-round-resume',family[0].lifecycleId,true);check(continuations.length,2)
 // A real Task write stalls. Another Task, another execution and another
 // controls handle using this same StoragePort still finish independently.
 const held=gate(),update=f.files.updateInExistingDirectory.bind(f.files),blockedPath=f.controls.taskRecordPath(c.taskId)
 f.files.updateInExistingDirectory=(p,decide,signal,coordinateRemoval)=>update(p,async bytes=>{const result=await decide(bytes);if(p===blockedPath&&JSON.parse(result.content??'{}').tasks?.[hash(c.taskId)]?.commandId==='held'){held.enter();await held.wait}return result},signal,coordinateRemoval)
 const slow=f.controls.setTask('held',c.taskId,'paused');await held.entered
 const peer=new ExecutionControls(f.store,scope,undefined,f.files,f.store,instanceUUID)
 await timeout(peer.setTask('other',b.taskId,'running'),'Task control');check((await peer.task(b.taskId)).commandId,'other')
 const targetX={workId:'work-x',executionId:'execution-x',taskId:b.taskId}
 await timeout(peer.requestExecutionStop('stop-x',targetX),'execution control')
 check((await peer.execution(targetX)).result,undefined);await peer.settleExecution('stop-x',targetX,{state:'unconfirmed',detail:'actual stop pending'});check((await peer.execution(targetX)).result.state,'unconfirmed')
 held.open();await slow;f.files.updateInExistingDirectory=update
 await rejects(()=>f.controls.setTask('other',b.taskId,'paused'),/different arguments/)
 // UI random command UUIDs and tool call identities are selected-Task scoped.
 // An unrelated Task does not acquire a global registry dependency.
 await f.controls.setTask('other',c.taskId,'running');check((await f.controls.task(c.taskId)).commandId,'other')
 // There is no split SDK claim in a physical Task. Failure before the atomic
 // file publication leaves no accepted command; retry is its first commit.
 let fail=true;f.files.updateInExistingDirectory=(p,decide,signal,coordinateRemoval)=>update(p,async bytes=>{const result=await decide(bytes);if(fail&&p===f.controls.taskRecordPath(a.taskId)){fail=false;throw new Error('Task write failed before atomic publication')}return result},signal,coordinateRemoval)
 await rejects(()=>f.controls.setTask('lost',a.taskId,'paused'),/Task write failed/);f.files.updateInExistingDirectory=update
 check((JSON.parse(await read(f.files,f.controls.taskRecordPath(a.taskId)))).commands[hash('lost')],undefined)
 await f.controls.setTask('newer',a.taskId,'running');await f.controls.setTask('lost',a.taskId,'paused');check((await f.controls.task(a.taskId)).commandId,'lost')
 let loss=true;f.files.updateInExistingDirectory=async(p,decide,signal,coordinateRemoval)=>{const result=await update(p,decide,signal,coordinateRemoval);if(loss&&p===f.controls.taskRecordPath(a.taskId)){loss=false;throw new Error('Task acknowledgement lost')}return result}
 await rejects(()=>f.controls.setTask('committed',a.taskId,'paused'),/acknowledgement lost/);f.files.updateInExistingDirectory=update
 await f.controls.setTask('committed',a.taskId,'paused');check((await f.controls.task(a.taskId)).commandId,'committed')
 // Legacy Task SDK data is retained, not silently adopted, migrated or
 // deleted by the new physical Task path. No compatibility Task write occurs.
 const legacy=await make('legacy'),prior={taskId:a.taskId,intent:'cancelled',commandId:'legacy-cancel',requestedAt:'old'},stop={taskId:b.taskId,workId:'old-work',executionId:'old-exec',commandId:'legacy-stop',requestedAt:'old'}
 const old={version:1,tasks:{[hash(a.taskId)]:prior},executions:{[hash(stop.executionId)]:stop},commands:{[hash(prior.commandId)]:{signature:JSON.stringify(['task',a.taskId,'cancelled']),value:prior},[hash(stop.commandId)]:{signature:JSON.stringify(['execution-stop',stop.workId,stop.executionId,b.taskId]),value:stop}}}
 await legacy.store.set(controlKey,old);check(await legacy.controls.priorTaskCommand('legacy-cancel',undefined,a),undefined);check(await legacy.controls.taskHeld(c.taskId),false);check(await legacy.controls.pendingStops(),[])
 await legacy.controls.setTask('legacy-resume',a.taskId,'running');check(await legacy.controls.taskHeld(c.taskId),false);check(await legacy.store.get(controlKey),old)
 await legacy.controls.releaseTask(b.taskId);check(await legacy.controls.execution(stop),undefined);check(await legacy.store.get(controlKey),old)
 // Exact old Git call path remains the transaction builder, not Local staging.
 let gitCalls=0;const gitFiles={snapshot:async()=>({release:async()=>{}}),read:async(_s,p)=>p===paths.task(a.taskId)?JSON.stringify({...a,children:[]}):p===paths.inbox(a.taskId,a.owner)?'work':undefined}
 await publishTaskResume({files:gitFiles,controls:{taskStates:async()=>new Map([[a.taskId,{commandId:'git-resume',intent:'running'}]])},transactions:{run:async(id,_r,_o,build)=>{gitCalls++;check(id,'task-resume-signals:git-resume');const changes=await build({});check(changes.length,2);check(changes.every(x=>x.content===''),true)}},member:'A',active:false},input,'git-resume');check(gitCalls,1)
 // Actual child-process exits at every handoff edge. The parent reopens exact
 // persisted files and retries the same command, without re-seeding signals.
 for(const mode of ['planned','stage','prepared','consumed','published','receipt','retired']){
  const q=await make('restart-'+mode),cmd='restart-'+mode;await q.controls.setTask(cmd,a.taskId,'running')
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt',q.files.directory,mode],{encoding:'utf8'});check(child.status,79);processInterruptions++
  const raw=await read(q.files,resumePath(cmd)),pending=raw&&JSON.parse(raw),first=pending?.signals[0].path??paths.state('A',a.taskId)+'/Organizer_UserResume_'+hash(cmd)
  await publishTaskResume(access(q),input,cmd)
  check((await notifications(q.files)).includes(first),!['consumed','published','receipt','retired'].includes(mode))
  for(const signal of await notifications(q.files)){check(await read(q.files,signal),'');await q.files.delete(signal)}
  await publishTaskResume(access(q),input,cmd);check(await notifications(q.files),[]);check(await read(q.files,resumePath(cmd)),undefined);check(await q.controls.resumeHandled(cmd,input),true)
 }
 const interruptedPause=await make('interrupted-later-pause'),pausedCommand='restart-prepared'
 await interruptedPause.controls.setTask(pausedCommand,a.taskId,'running')
 const pausedChild=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt',interruptedPause.files.directory,'prepared'],{encoding:'utf8'});check(pausedChild.status,79);processInterruptions++
 await interruptedPause.controls.setTask('new-user-pause',a.taskId,'paused');await publishTaskResume(access(interruptedPause),input,pausedCommand);check(await notifications(interruptedPause.files),[])
 const wrongPath=await make('invalid-publication'),invalidCommand='restart-planned';await wrongPath.controls.setTask(invalidCommand,a.taskId,'running')
 const invalidChild=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt',wrongPath.files.directory,'planned'],{encoding:'utf8'});check(invalidChild.status,79);processInterruptions++
 const invalid=JSON.parse(await read(wrongPath.files,resumePath(invalidCommand)));invalid.signals[0].stage='skills/user-owned.md';await wrongPath.files.replace(resumePath(invalidCommand),JSON.stringify(invalid));await wrongPath.files.replace('skills/user-owned.md','protected')
 await rejects(()=>publishTaskResume(access(wrongPath),input,invalidCommand),/outside its addressed Task/);check(await read(wrongPath.files,'skills/user-owned.md'),'protected')
 // Physical Task control commands never read the legacy aggregate SDK fact.
 const fact=await make('previous-once'),factGet=fact.store.get.bind(fact.store);let previousReads=0
 fact.store.get=async k=>{if(k===controlKey)previousReads++;return factGet(k)}
 await fact.controls.setTask('fact-a',a.taskId,'running');await fact.controls.setTask('fact-b',b.taskId,'paused')
 const factPeer=new ExecutionControls(fact.store,scope,undefined,fact.files,fact.store,instanceUUID);await factPeer.setTask('fact-c',c.taskId,'running');await factPeer.priorTaskCommand('missing-old-command',undefined,c)
 check(previousReads,0)
 const factRead=fact.files.read.bind(fact.files),metadataReads=new Map()
 fact.files.read=async(s,p)=>{if(p.startsWith('tasks/'))metadataReads.set(p,(metadataReads.get(p)??0)+1);return factRead(s,p)}
 await withSnapshot(fact.files,s=>fact.controls.taskStates(tasks(),s));check([...metadataReads],[])
 await withSnapshot(fact.files,s=>fact.controls.taskStates([b,c],s));check([...metadataReads],[[paths.task(a.taskId),1]])
 metadataReads.clear();await fact.controls.taskHeld(b.taskId);check([...metadataReads],[])
 const originalList=fact.store.list.bind(fact.store);fact.store.list=async()=>{throw new Error('Cleanup must not enumerate controls')}
 const factStop={workId:'fact-work',executionId:'fact-execution',taskId:c.taskId}
 await fact.controls.requestExecutionStop('fact-stop',factStop)
 await fact.controls.releaseTask(c.taskId,'',['fact-execution']);check((await fact.controls.execution(factStop)).commandId,'fact-stop');check(previousReads,0)
 const cleanedFamily=tasks().map(t=>({...t,status:'complete'})),cleaned=cleanedFamily[0];for(const t of cleanedFamily)await fact.files.replace(paths.task(t.taskId),JSON.stringify(t));await new FrameworkCleaner(fact.files,transactions).clean(cleaned,{snapshot:{},task:cleaned,family:cleanedFamily,startedAt:0,status:'delete'})
 check(await fact.controls.execution(factStop),undefined);fact.store.list=originalList;fact.files.read=factRead
 // Removed: mutating the old shared Task SDK document during release is no
 // longer a production path. The preceding legacy fixture proves preservation.
 // Actual retireTaskRuntime uses the existing startup roleBases fact for an
 // already-released role absent from live roleRecords. Retired observations
 // remain selected after cleanupWorkerTransfers removed the retired map entry.
 const retirement=await make('cold-runtime-retirement'),runtimeText=readFileSync(new URL('framework/role-runtime.ts',root),'utf8'),retiredSessions=[]
 const Retirement=new Function('DshStorageAdapter','PhysicalLocalFiles','GitAuthorityStore','hash','taskLifecycle','retireNativeSession','return class {\n'+method(runtimeText,'localTaskRetirementRows')+'\n'+method(runtimeText,'retireTaskRuntime')+'\n'+method(runtimeText,'settleOperations')+'\n}')(DshStorageAdapter,PhysicalLocalFiles,GitAuthorityStore,hash,taskLifecycle,(_ctx,id)=>retiredSessions.push(id)),ret=new Retirement()
 const own={identity:{role:'Worker',taskId:a.taskId,workId:'cold-own',executionId:'cold-execution'},stopped:true,released:true,sessionId:'cold-session'},foreign={identity:{role:'Worker',taskId:b.taskId,workId:'other-work',executionId:'other-execution'},stopped:true,sessionId:'other-session'},oldRetired={identity:{role:'Worker',taskId:a.taskId,workId:'retired-own',executionId:'retired-execution'},stopped:true,released:true,sessionId:'retired-session'}
 ret.files=retirement.files;ret.pendingControlStops=[];ret.prefix='framework-runtime/'+hash('retirement')+'/';ret.records=retirement.store;ret.roleRecords=new Map();ret.roleBases=new Map([[own.identity.workId,own],[foreign.identity.workId,foreign]]);ret.retiredWorkers=new Map();ret.roleWriteOwners=new Map();ret.wakeWriteOwners=new Map();ret.wakeWrites=new Map();ret.observationRecordWrites=new Map();ret.restoreWriteOwners=new Map();ret.safetyRestoreWrites=new Map();ret.wakeConsumptions=new Map();ret.config={member:'A'};ret.ctx={}
 ret.withRoleWrite=async(_id,fn)=>fn();ret.deleteRuntimeRecord=async key=>ret.records.delete(key);ret.taskReleaseWakes=async()=>[];ret.restoreTaskOwner=()=>undefined;ret.serialRecoveryWatch=async(_id,member,fn)=>fn(ret.prefix+'recovery-watch/'+hash(member))
 const coldStore=new DurableObservationStore(retirement.store,'cold-retirement');ret.observations=new ExecutionObservations(coldStore,{arrange:async()=>{}},e=>{throw e})
 await retirement.store.set(ret.prefix+'roles/'+hash(own.identity.workId),own);await retirement.store.set(ret.prefix+'roles/'+hash(foreign.identity.workId),foreign)
 for(const record of [own,foreign,oldRetired])await coldStore.set(record.identity.workId,{observation:createObservation(record.identity,0),executing:false},undefined)
 const retirementList=retirement.store.list.bind(retirement.store);retirement.store.list=async prefix=>{if(prefix===ret.prefix+'roles/'||prefix.startsWith('framework-observations/'))throw new Error('Cold retirement cannot enumerate owned roles or observations');return retirementList(prefix)}
 await ret.retireTaskRuntime(a,[oldRetired]);check(retiredSessions,['cold-session']);check(await retirement.store.get(ret.prefix+'roles/'+hash(own.identity.workId)),undefined);check(await coldStore.get(own.identity.workId),undefined);check(await coldStore.get(oldRetired.identity.workId),undefined);check((await coldStore.get(foreign.identity.workId)).observation.identity.taskId,b.taskId);check((await retirement.store.get(ret.prefix+'roles/'+hash(foreign.identity.workId))).sessionId,'other-session')
 // Durable 5/5/30 observation, exact-work independence, no global cleanup scan.
 const q=await make('observations'),obStore=new DurableObservationStore(q.store,'observations'),arranged=[],errors=[];let now=0
 const observations=new ExecutionObservations(obStore,{arrange:async p=>arranged.push(p)},e=>errors.push(e),()=>now)
 const agents=new Map(),identity=(work,task=a.taskId)=>({workId:work,executionId:'execution-'+work,role:'Worker',taskId:task,member:'A',workerId:work})
 const agent=work=>{let state='running',progress,status;const api={observe:()=>({state}),subscribeProgress:fn=>{progress=fn;return()=>{progress=undefined}},subscribe:(fn,initial)=>{status=fn;if(initial)fn();return()=>{status=undefined}},set:s=>{state=s;status?.()},progress:e=>progress?.(e)};agents.set(work,api);return api}
 await observations.bind(identity('a'),agent('a'));await observations.bind(identity('b',b.taskId),agent('b'))
 now=300000;await observations.tick();check(arranged.map(p=>p.action.stage),[1,1]);now=600000;await observations.tick();check(arranged.slice(-2).map(p=>p.action.stage),[2,2]);now=2400000;await observations.tick();check(arranged.slice(-2).map(p=>p.action.stage),[3,3])
 const current=await obStore.get('a');await observations.reset(identity('a'),'consumed-probe',current.observation.cycleStartedAt);check((await observations.reset(identity('a'),'consumed-probe',current.observation.cycleStartedAt)).status,'already-handled')
 check((await observations.reset(identity('a'),'sibling-warning',current.observation.cycleStartedAt)).status,'superseded')
 await observations.bind(identity('c',c.taskId),agent('c'));const slowGate=gate(),get=obStore.get.bind(obStore);let slowReads=0
 obStore.get=async work=>{if(work==='a'){slowReads++;slowGate.enter();await slowGate.wait}return get(work)}
 agents.get('a').progress({kind:'model-text',observedAt:now+1});now+=300000
 await timeout(observations.tick(false),'Host tick');await slowGate.entered
 await timeout(observations.bind(identity('d',b.taskId),agent('d')),'work binding')
 await observations.tick(false);await new Promise(r=>setTimeout(r,30));check(arranged.some(p=>p.action.identity.workId==='c'),true);check(slowReads,1)
 now+=300000;await observations.tick(false);await new Promise(r=>setTimeout(r,30));check(arranged.filter(p=>p.action.identity.workId==='c').length,2);check(arranged.some(p=>p.action.identity.workId==='d'),true)
 // Saved observation lacking a live binding is retired through known workId.
 const dormant=identity('dormant',b.taskId);await obStore.set(dormant.workId,{observation:createObservation(dormant,now),executing:false},undefined)
 obStore.list=async()=>{throw new Error('Forbidden broad observation scan')}
 await timeout(observations.releaseTask(b.taskId,'',['dormant']),'other Task release');check(await get('b'),undefined);check(await get('d'),undefined);check(await get('dormant'),undefined)
 slowGate.open();obStore.get=get;await observations.flush();await observations.dispose();check(errors,[])
 // Actual separate runtime/maintenance observation handles share a single
 // StoragePort and scope. An old captured retirement cannot delete a newer
 // lifecycle, and old disposal cannot overwrite that replacement either.
 const shared=await make('two-observation-handles'),one=new DurableObservationStore(shared.store,'same-scope'),two=new DurableObservationStore(shared.store,'same-scope')
 const owner1={workId:'same-work',executionId:'old-execution',role:'Worker',taskId:a.taskId,lifecycleId:'old'},owner2={...owner1,executionId:'new-execution',lifecycleId:'new'}
 const oldRow={observation:createObservation(owner1,0),executing:false},newRow={observation:createObservation(owner2,100),executing:true}
 await one.set(owner1.workId,oldRow,undefined);const captured=await one.get(owner1.workId);await two.set(owner2.workId,newRow,captured);await one.delete(owner1.workId,captured)
 check((await two.get(owner2.workId)).observation.identity,owner2)
 const priorProgress=await one.get(owner2.workId),progressed={...priorProgress,observation:{...priorProgress.observation,lastProgressAt:200},executing:false}
 await two.set(owner2.workId,progressed,priorProgress);await one.delete(owner2.workId,priorProgress);check(await two.get(owner2.workId),progressed)
 await two.set(owner2.workId,newRow,progressed)
 await rejects(()=>one.set(owner1.workId,{...oldRow,executing:false},captured),/ownership changed/);check((await two.get(owner2.workId)).executing,true)
 // Put a real physical delete between the old retirement comparison and
 // completion. Another handle's new bind waits only this work, then survives.
 await two.delete(owner2.workId,newRow);await one.set(owner1.workId,oldRow,undefined)
 const deletionGate=gate(),remove=shared.store.delete.bind(shared.store);shared.store.delete=async key=>{if(key==='framework-observations/'+hash('same-scope')+'/'+hash(owner1.workId)){deletionGate.enter();await deletionGate.wait}return remove(key)}
 const deleting=one.delete(owner1.workId,oldRow);await deletionGate.entered
 let replaced=false;const replacing=two.set(owner2.workId,newRow,oldRow).then(()=>{replaced=true})
 const unrelated={workId:'independent-work',executionId:'independent-execution',role:'Worker',taskId:b.taskId};await timeout(two.set(unrelated.workId,{observation:createObservation(unrelated,0),executing:true},undefined),'independent observation key')
 check(replaced,false);deletionGate.open();await Promise.all([deleting,replacing]);shared.store.delete=remove;check((await two.get(owner2.workId)).observation.identity,owner2)

 console.log(JSON.stringify({status:'passed',assertions,processInterruptions,runtime:process.version,platform:process.platform,limits:'Actual production methods and physical files; StoragePort JSON fixture, DSH native JSON unit behind actual RecordFilesBackend, schema/native scheduling/owned agent events are explicit test ports. No installed DSH/native Windows QA, remote Git commit, default Local cutover, or full dependency typecheck.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{for(const f of opened)await f.files.close();hooks.deregister();await fs.rm(base,{recursive:true,force:true})}
