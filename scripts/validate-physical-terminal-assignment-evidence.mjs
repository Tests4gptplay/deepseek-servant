import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Boundary-specific actual tool/Host tests. A missing stage is not success;
// exact accepted receiver sources or actual root Recorder results settle only
// the responsibility they own. Technical admission/persistence and schemas are
// explicit controlled ports. No installed native DSH/Windows claim.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'zod') return { url: data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`), shortCircuit: true }
  if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(){return {type:'root',children:[]}}`), shortCircuit: true }
  if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0,-3) + '.ts', context.parentURL)
    if (url.href === new URL('framework/skills.ts',sourceRoot).href) return { url: data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`), shortCircuit: true }
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url,context,next) {
  if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
    const name=url.split('/').at(-1), selected=process.env.DSS_BASELINE_SOURCE && ['physical-task-terminal.ts','physical-worker-assignment.ts'].includes(name) && (!process.env.DSS_BASELINE_COMPONENT || name.includes(process.env.DSS_BASELINE_COMPONENT)) ? path.join(process.env.DSS_BASELINE_SOURCE,name) : new URL(url)
    const source = readFileSync(selected,'utf8'); loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'))
    return { format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true }
  }
  return next(url,context)
} })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { physicalReceiver } = await import('./test-support/physical-receiver.mjs')
const signalSources = files => async path => (await physicalReceiver(files, path.split('/').length === 4 ? path.split('/')[1] : 'A', loaded)).sources(path)
const consume = async (files,path) => (await physicalReceiver(files, path.split('/').length === 4 ? path.split('/')[1] : 'A', loaded)).accept(path)
const { installFrameworkRoleTools, workerPaths } = await import('../src/framework/role-tools.ts')
const { paths, taskWorkingRoots, taskInitializationFiles, childCompletionSignal, foregroundTaskSignal } = await import('../src/framework/task-files.ts')
const { cancelTask } = await import('../src/framework/task-cancellation.ts')
const { physicalControlSignalSources } = await import('../src/framework/physical-control-signal-sources.ts')
const { resumePhysicalTaskTerminalHandoff, resumePhysicalForegroundTaskNotice, physicalTaskTerminalPath } = await import('../src/framework/physical-task-terminal.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { FrameworkCleaner, observeCleanup } = await import('../src/framework/cleaner.ts')
const { taskHistoryChange } = await import('../src/framework/task-history.ts')
let assertions = 0, processInterruptions = 0
const check = (actual, expected) => { assert.deepEqual(actual,expected); assertions++ }
const rejects = async (fn, re) => { await assert.rejects(fn,re); assertions++ }
const ids = [1,2,3,4,5].map(n => '10000000-0000-4000-8000-' + String(n).padStart(12,'0'))
const note = task => task.route === 'O' ? paths.run(task.taskId) + '/Organizer_Note.md' : paths.member(task.taskId,task.owner) + '/Planner_Memory.md'
const evidence = task => paths.run(task.taskId) + '/evidence.md'
const read = async (files,p) => { const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()} }
const metadata = async (files,task) => JSON.parse(await read(files,paths.task(task.taskId)))
const signals = async files => { const s=await files.snapshot();try{return (await files.list(s,'state/')).map(e=>e.path).filter(p=>!p.endsWith('/recovery')&&!p.split('/').at(-1).startsWith('.')).sort()}finally{await s.release()} }
function tasks(tree=true) {
  const root={version:1,taskId:ids[0],route:tree?'O':'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/root_'+(tree?'O':'P')+'.md',archiveFolder:ids[0]}
  if(!tree)return [root]
  const group={...root,taskId:ids[1],route:'O',owner:'B',members:['B'],sourcePath:'tasks/group_O.md',archiveFolder:ids[0]+'/'+ids[1],parent:{taskId:root.taskId,owner:'A',objectiveId:'group'}}
  const leaf={...root,taskId:ids[2],route:'P',owner:'C',members:['C'],sourcePath:'tasks/leaf_P.md',archiveFolder:group.archiveFolder+'/'+ids[2],parent:{taskId:group.taskId,owner:'B',objectiveId:'leaf'}}
  const sibling={...leaf,taskId:ids[3],owner:'D',members:['D'],sourcePath:'tasks/sibling_P.md',archiveFolder:ids[0]+'/'+ids[3],parent:{taskId:root.taskId,owner:'A',objectiveId:'sibling'}}
  root.children=[{taskId:group.taskId,member:'B',objectiveId:'group'},{taskId:sibling.taskId,member:'D',objectiveId:'sibling'}]
  group.children=[{taskId:leaf.taskId,member:'C',objectiveId:'leaf'}]
  return [root,group,leaf,sibling]
}
async function seed(files,family) {
  for(const task of family) {
    await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(task.sourcePath,'Task ID: '+task.taskId+'\nOriginal requirement '+task.taskId)
    for(const change of taskInitializationFiles(task)) await files.replace(change.path,change.content)
    await files.replace(note(task),'Existing note\r\n');await files.replace(evidence(task),'Original selected evidence '+task.taskId)
  }
}
function role(files,task,extra={}) {
  const tools=new Map(),agent={id:'agent-'+task.taskId,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
  const binding={role:extra.testRole??(task.route==='O'?'Organizer':'Planner'),taskId:task.taskId,lifecycleId:task.lifecycleId,owner:task.owner,member:task.owner,workId:agent.id,executionId:agent.id}
  let ended=0
  installFrameworkRoleTools(ctx,agent,binding,{files,physicalSignalSources:signalSources(files),transact:async()=>{throw new Error('Unexpected generic transaction')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:()=>{},...extra})
  return {get ended(){return ended},call:(name,input,callId=name,signal=new AbortController().signal)=>tools.get(name).execute(input,{agent,callId,signal,concludeTurn(){ended++}})}
}
async function complete(files,task,callId='complete',extra={},flush=true) {
  const r=role(files,task,extra),view=await r.call('dss_snapshot',{}),input={snapshotId:view.snapshotId,acceptance:'Accepted actual evidence.\n',resultPaths:[evidence(task)]}
  const result=await r.call('dss_complete',input,callId)
  if(flush)await hostResume(files,await metadata(files,task),{task:false})
  return {r,input,result}
}
const cancellation=(files,task,extra={})=>({files,member:task.owner,physicalSignalSources:signalSources(files),transact:async()=>{throw new Error('Unexpected generic transaction')},...extra})
async function hostResume(files,task,options={}) {
  const state=new Map(),errors=[],wakes=[]
  const member=task.owner,identity={member,primary:true,scope:'physical-terminal-test',instanceUUID:ids[4]}
  const host=new FrameworkHostLoop(files,{}, {get:async k=>state.get(k),set:async(k,v)=>{state.set(k,v)}}, identity,()=>[member],{
    physicalSignalSources:signalSources(files),wake:async req=>{wakes.push(req);return false},executing:()=>false,sealBusiness:async()=>{},error:e=>errors.push(e),clean:async()=>false,
    cancelledBusinessStopped:async()=>true,cancelledOrganizerStopped:async()=>true
  })
  if(options.task!==false){const snapshot=await files.snapshot();try{await host.scanTask(task,snapshot,performance.now())}finally{await snapshot.release()}}
  if(options.signals!==false)await Promise.all(await host.runSignalPoll())
  if(errors.length)throw new AggregateError(errors,'Host resume failed')
  return wakes
}
async function cleanThroughHost(files,selected) {
  const task=await metadata(files,selected)
  const recorder=role(files,task,{testRole:'Recorder'}),view=await recorder.call('dss_snapshot',{})
  await recorder.call('dss_recorder_save',{snapshotId:view.snapshotId,outputs:[{path:paths.archive(task)+'/records.md',text:'Actual root Recorder summary.\n'}],retainedPaths:[evidence(task)]},'save')
  check(recorder.ended,1)
  const state=new Map(),errors=[],identity={member:task.owner,primary:true,scope:'terminal-total-cleanup',instanceUUID:ids[4]}
  const cleaner=new FrameworkCleaner(files,{},async()=>{})
  const host=new FrameworkHostLoop(files,{}, {get:async k=>state.get(k),set:async(k,v)=>state.set(k,structuredClone(v))},identity,()=>[task.owner],{
    error:e=>errors.push(e),executing:()=>false,wake:async()=>false,sealBusiness:async()=>{},releaseTask:async()=>{},
    clean:async(t,_snapshot,observation)=>(await cleaner.clean(t,observation)).status==='released'
  })
  check(await read(files,paths.state(task.owner,task.taskId)+'/Cleaner'),'')
  const snapshot=await files.snapshot();try{await host.scanTask(task,snapshot,performance.now())}finally{await snapshot.release();cleaner.close()}
  if(errors.length)throw new AggregateError(errors,'Actual total cleanup/retirement failed')
  check(await read(files,paths.task(task.taskId)),undefined)
  check(await read(files,task.sourcePath),undefined)
  check(await read(files,paths.archive(task)+'/state.json'),undefined)
  for(const directory of taskWorkingRoots(task))check(existsSync(path.join(files.directory,directory)),false)
  return task
}
async function assign(files, task, call='assign', contract='Actual Worker contract\n', decision='Actual Planner decision\n') {
  const r=role(files,task),view=await r.call('dss_snapshot',{})
  await r.call('dss_worker_assign',{snapshotId:view.snapshotId,childId:'worker',contract,decision},call)
  return r
}
const workerSignal=task=>paths.state(task.owner,task.taskId)+'/Worker_worker'
const rootRecorder=task=>paths.state(task.owner,task.taskId)+'/Recorder'
const assignmentPath=task=>workerPaths(task.taskId,task.owner,'worker').root+'/assignment.json'
const pending=async(files,task)=>JSON.parse(await read(files,physicalTaskTerminalPath(task)))
const loseBefore=(files,target)=>{
  const rename=files.rename.bind(files)
  files.rename=async(from,to)=>{if(to===target)await files.delete(from);return rename(from,to)}
  return ()=>{files.rename=rename}
}
if(process.argv[2]==='--interrupt-boundary') {
  const files=new PhysicalLocalFiles(process.argv[3]),mode=process.argv[4],task=JSON.parse(await read(files,paths.task(process.argv[5])))
  const rename=files.rename.bind(files),w=workerPaths(task.taskId,task.owner,'worker')
  files.rename=async(from,to)=>{
    const ok=await rename(from,to)
    if(ok&&mode==='contract-renamed'&&to===w.contract)process.exit(81)
    if(ok&&mode==='worker-consumed'&&to===workerSignal(task)){await consume(files,to);process.exit(81)}
    if(ok&&mode==='child-consumed'&&to===childCompletionSignal(task.parent,task.taskId)){await consume(files,to);process.exit(81)}
    return ok
  }
  if(mode==='child-consumed')await complete(files,task,'complete',{},false)
  else await assign(files,task)
  throw Error('Real interruption boundary was not reached: '+mode)
}
const base=await fs.mkdtemp(path.join(os.tmpdir(),'dss-terminal-assignment-evidence-')),opened=[]
async function fixture(name,tree=false){const files=new PhysicalLocalFiles(path.join(base,name));opened.push(files);const family=tasks(tree);
  // Physical Local runtime uses its one actual Host identity. Multi-member Git
  // roles are not simulated as if this callback could read another Host store.
  for(const task of family){task.owner='A';task.members=['A'];if(task.parent)task.parent.owner='A';for(const child of task.children??[])child.member='A'}
  await seed(files,family);return{files,family}}
try {
  // Lost prepared contract must not fabricate a successful assignment or
  // overwrite an unrelated current contract, even when its text is identical.
  for(const existing of [false,true]) {
    const {files,family:[task]}=await fixture('contract-lost-'+existing),w=workerPaths(task.taskId,task.owner,'worker')
    if(existing)await files.replace(w.contract,'Actual Worker contract\n')
    const target=await read(files,w.contract),restore=loseBefore(files,w.contract)
    await rejects(()=>assign(files,task),/not confirmed/);restore()
    const fact=await read(files,assignmentPath(task));check(JSON.parse(fact).contractPublished,undefined)
    check(await read(files,w.contract),target);check(await read(files,note(task)),'Existing note\r\n');check(await read(files,workerSignal(task)),undefined)
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    await rejects(()=>assign(cold,task),/not confirmed/);check(await read(cold,assignmentPath(task)),fact);check(await read(cold,w.contract),target)
  }
  // A stale accepted source has the same path but the wrong physical identity.
  // It cannot certify a later lost signal, and a later contract edit survives.
  for(const oldSource of [false,true]) {
    const {files,family:[task]}=await fixture('worker-signal-lost-'+oldSource),w=workerPaths(task.taskId,task.owner,'worker')
    if(oldSource){await files.replace(workerSignal(task),'');await consume(files,workerSignal(task))}
    const restore=loseBefore(files,workerSignal(task));await rejects(()=>assign(files,task),/not confirmed/);restore()
    const fact=await read(files,assignmentPath(task)),memory=await read(files,note(task))
    check(JSON.parse(fact).published,undefined);check(JSON.parse(fact).contractPublished,true)
    await files.replace(w.contract,'Edited after confirmed contract publication')
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    await rejects(()=>assign(cold,task),/not confirmed/)
    check(await read(cold,assignmentPath(task)),fact);check(await read(cold,note(task)),memory)
    check(await read(cold,w.contract),'Edited after confirmed contract publication');check(await read(cold,workerSignal(task)),undefined)
  }
  // Actual Recorder loss leaves its original responsibility, while global
  // Foreground still completes. Task status/history alone does not prove R.
  {
    const {files,family:[task]}=await fixture('recorder-lost'),restore=loseBefore(files,rootRecorder(task))
    await rejects(()=>complete(files,task,'complete',{},false),/not confirmed/);restore()
    const fact=await read(files,physicalTaskTerminalPath(task));check((await metadata(files,task)).status,'complete')
    await hostResume(files,await metadata(files,task),{task:false});check(await read(files,foregroundTaskSignal(task.taskId)),'')
    check(await read(files,physicalTaskTerminalPath(task)),fact)
    const history=taskHistoryChange(await metadata(files,task));await files.replace(history.path,history.content)
    await hostResume(files,await metadata(files,task),{task:false});check(await read(files,physicalTaskTerminalPath(task)),fact)
    await rejects(()=>resumePhysicalTaskTerminalHandoff(files,task,signalSources(files)),/not confirmed/)
    check(await read(files,rootRecorder(task)),undefined);check((await read(files,note(task))).split('Accepted actual evidence.\n').length-1,1)
  }
  // Missing Foreground stage likewise leaves only its own original branch.
  {
    const {files,family:[task]}=await fixture('foreground-lost');await complete(files,task,'complete',{},false)
    const restore=loseBefore(files,foregroundTaskSignal(task.taskId))
    await rejects(()=>resumePhysicalForegroundTaskNotice(files,physicalTaskTerminalPath(task),signalSources(files)),/not confirmed/);restore()
    const fact=await pending(files,task),progress=await read(files,fact.foreground.progress)
    check(JSON.parse(progress).published,undefined);check(await read(files,rootRecorder(task)),'')
    await rejects(()=>resumePhysicalForegroundTaskNotice(files,physicalTaskTerminalPath(task),signalSources(files)),/not confirmed/)
    check(await read(files,fact.foreground.progress),progress);check(await read(files,foregroundTaskSignal(task.taskId)),undefined)
  }
  // Child only hands off to actual parent Organizer. No child Recorder/F/C.
  {
    const {files,family:[,parent,child]}=await fixture('child-lost',true),target=childCompletionSignal(child.parent,child.taskId),restore=loseBefore(files,target)
    await rejects(()=>complete(files,child,'complete',{},false),/not confirmed/);restore()
    const fact=await read(files,physicalTaskTerminalPath(child));check((await metadata(files,child)).status,'complete')
    await rejects(()=>resumePhysicalTaskTerminalHandoff(files,child,signalSources(files)),/not confirmed/)
    check(await read(files,physicalTaskTerminalPath(child)),fact);check(await signals(files),[]);check((await metadata(files,parent)).status,'running')
  }
  // Real process termination after real rename or actual receiver consumption;
  // new process/store uses existing exact source records, never recreates wake.
  for(const mode of ['contract-renamed','worker-consumed','child-consumed']) {
    const {files,family}=await fixture(mode,mode==='child-consumed'),task=mode==='child-consumed'?family[2]:family[0]
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt-boundary',files.directory,mode,task.taskId],{encoding:'utf8'})
    check(child.status,81);processInterruptions++
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    if(mode==='child-consumed') {
      // The real parent may have processed the consumed child signal and
      // completed before the child's original publisher resumes.
      const parent=await metadata(cold,{taskId:task.parent.taskId})
      await complete(cold,parent,'parent-complete',{},false)
      await consume(cold,childCompletionSignal(parent.parent,parent.taskId))
      await resumePhysicalTaskTerminalHandoff(cold,await metadata(cold,task),signalSources(cold))
      check(await read(cold,physicalTaskTerminalPath(task)),undefined);check(await signals(cold),[])
    } else {
      await assign(cold,task);check(JSON.parse(await read(cold,assignmentPath(task))).published,true)
      check(await read(cold,workerSignal(task)),mode==='worker-consumed'?undefined:'')
      check((await read(cold,note(task))).split('Actual Planner decision\n').length-1,1)
    }
  }
  // Current child contract updates are the existing tool semantics. An older
  // accepted wake cannot consume the new notification. No invented job queue.
  {
    const {files,family:[task]}=await fixture('actual-repeat'),receiver=await physicalReceiver(files,'A',loaded),w=workerPaths(task.taskId,task.owner,'worker')
    await assign(files,task);const original=await receiver.accept(workerSignal(task),{consume:false})
    await assign(files,task,'next','Revised current contract','Next decision\n')
    await receiver.runtime.consumeWakeSignals(original.identity)
    check(await read(files,workerSignal(task)),'');check(await read(files,w.contract),'Revised current contract')
    await receiver.accept(workerSignal(task));await assign(files,task,'next','Revised current contract','Next decision\n')
    check(await read(files,workerSignal(task)),undefined)
    check(await read(files,note(task)),'Existing note\r\nActual Planner decision\nNext decision\n')
  }
  // An ordinary successful rename is enough. No target/stat or receiver read
  // follows it on the terminal/Worker successful publication path.
  {
    const {files,family:[task]}=await fixture('no-reread'),w=workerPaths(task.taskId,task.owner,'worker'),info=files.fileInfo.bind(files)
    const forbidden=new Set([w.contract,workerSignal(task),rootRecorder(task),foregroundTaskSignal(task.taskId)])
    files.fileInfo=async p=>{if(forbidden.has(p))throw Error('Unexpected target reread after successful rename');return info(p)}
    await assign(files,task);await complete(files,task);check(await read(files,physicalTaskTerminalPath(task)),undefined)
  }
  // Recorder can finish and total Cleaner can retire its role source before
  // the original publisher resumes. Existing R history+catalog, not absent
  // stages, settle this responsibility without delaying that cleanup.
  {
    const {files,family:[task]}=await fixture('recorder-finished-before-publisher'),rename=files.rename.bind(files)
    files.rename=async(a,b)=>{const ok=await rename(a,b);if(ok&&b===rootRecorder(task)){await consume(files,b);throw Error('after actual consumed Recorder publication')}return ok}
    await rejects(()=>complete(files,task,'complete',{},false),/after actual consumed/);files.rename=rename
    const history=await cleanThroughHost(files,task)
    await files.removeDirectory('.test-runtime/A') // controlled technical-store retirement after actual Cleaner
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    const retentionPath=paths.archive(task)+'/retention.json',catalog=await read(cold,retentionPath)
    await cold.delete(retentionPath)
    await hostResume(cold,history,{task:false})
    check(!!await read(cold,physicalTaskTerminalPath(task)),true)
    const fgVersion=(await cold.fileInfo(foregroundTaskSignal(task.taskId))).version
    await cold.replace(retentionPath,JSON.stringify({...JSON.parse(catalog),lifecycleId:'another-round'}))
    await hostResume(cold,history,{task:false})
    check(!!await read(cold,physicalTaskTerminalPath(task)),true)
    await cold.replace(retentionPath,catalog)
    await hostResume(cold,history,{task:false})
    check((await cold.fileInfo(foregroundTaskSignal(task.taskId))).version,fgVersion)
    check(await read(cold,physicalTaskTerminalPath(task)),undefined);check(await read(cold,rootRecorder(task)),undefined)
    check(await read(cold,foregroundTaskSignal(task.taskId)),'');check(await read(cold,paths.task(task.taskId)),undefined)
  }
  // Storage-only cancellation callback addresses the same exact existing
  // role records as Runtime, without starting Host or scanning record stores.
  {
    const {files,family:[task]}=await fixture('cold-cancel'),receiver=await physicalReceiver(files,'A',loaded),hash=s=>createHash('sha256').update(s).digest('hex')
    receiver.runtime.prefix='framework-runtime/'+hash('scope')+'/'
    const lookup=physicalControlSignalSources(receiver.runtime.records,'scope','A'),signal=rootRecorder(task),rename=files.rename.bind(files)
    files.rename=async(a,b)=>{const ok=await rename(a,b);if(ok&&b===signal){await receiver.accept(b);throw Error('after actual cancellation notice consumed')}return ok}
    await rejects(()=>cancelTask(cancellation(files,task,{physicalSignalSources:lookup}),{taskId:task.taskId},'cancel'),/after actual cancellation notice consumed/);files.rename=rename
    check(await lookup(signal),await receiver.sources(signal))
    check(await lookup('state/B/'+task.taskId+'/Recorder'),[]);check(await lookup('state/A/'+task.taskId+'/Worker_worker'),[])
    for(const [role,source] of [['Foreground','state/Foreground_ControlCheck'],['Organizer','state/A/'+task.taskId+'/Organizer_ControlCheck'],['Planner','state/A/'+task.taskId+'/Planner_ControlCheck']]) {
      await files.replace(source,'')
      const record=await receiver.accept(source,{role,consume:false})
      record.delivery={request:record.lastWake};record.notificationClaims={claim:{sources:[...record.lastWake.sources,{path:'state/other',version:'unrelated'}]}}
      await receiver.runtime.records.set(receiver.runtime.prefix+'roles/'+hash(record.identity.workId),record)
      const count=receiver.gets.length
      check(await lookup(source),await receiver.sources(source));check(receiver.gets.length,count+2)
    }
    const before=receiver.gets.length
    await cancelTask(cancellation(files,task,{physicalSignalSources:lookup}),{taskId:task.taskId},'cancel')
    check(receiver.gets.length,before+1);check(await read(files,signal),undefined)
    await hostResume(files,await metadata(files,task),{task:false});check(await read(files,physicalTaskTerminalPath(task)),undefined)
  }
  console.log(JSON.stringify({status:'passed',assertions,processInterruptions,node:process.version,scope:'Actual installed tool/Host/Recorder/Cleaner and extracted verbatim Runtime consumption/source methods; controlled native admission/technical store/schema/Markdown ports. No native DSH/Windows/cross-process durability/default cutover.',sourceHashes:Object.fromEntries(loaded)},null,2))
} finally {for(const files of opened)await files.close();hooks.deregister();await fs.rm(base,{recursive:true,force:true})}
