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
const fileIdentity = version => { const fields=version.split(':');return [fields[1],fields[2],fields[6]] }
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
async function assign(files, task, call='assign', contract='Actual Worker contract\n', decision='Actual Planner decision\n', childId='worker') {
  const r=role(files,task),view=await r.call('dss_snapshot',{})
  await r.call('dss_worker_assign',{snapshotId:view.snapshotId,childId,contract,decision},call)
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
const oldContract='Original accepted contract\n',oldDecision='Original accepted Planner decision\n',newContract='Latest requested contract\n',newDecision='Latest Planner decision\n'
const assignment=async(files,task)=>JSON.parse(await read(files,assignmentPath(task)))
async function interruptOld(files,task,mode,die=false) {
  const w=workerPaths(task.taskId,task.owner,'worker'),rename=files.rename.bind(files),replace=files.replace.bind(files),append=files.appendPrepared.bind(files)
  let once=true
  const stop=()=>{once=false;if(die)process.exit(82);throw Error('actual old assignment interruption: '+mode)}
  files.rename=async(a,b)=>{
    if(once&&mode==='before-contract'&&b===w.contract)stop()
    if(once&&mode==='before-signal'&&b===workerSignal(task))stop()
    const ok=await rename(a,b)
    if(once&&ok&&mode==='after-contract'&&b===w.contract)stop()
    if(once&&ok&&mode==='signal-consumed'&&b===workerSignal(task)){await consume(files,b);stop()}
    if(once&&ok&&mode==='signal-accepted'&&b===workerSignal(task)){await (await physicalReceiver(files,'A',loaded)).accept(b,{consume:false});stop()}
    return ok
  }
  files.replace=async(p,text)=>{
    await replace(p,text)
    if(once&&p===assignmentPath(task)) {
      const next=JSON.parse(text)
      if(mode==='decision-prepared'&&next.decisionPrepared&&!next.decisionPublished)stop()
      if(mode==='published-before-cleanup'&&next.published)stop()
    }
  }
  files.appendPrepared=async(...args)=>{await append(...args);if(once&&mode==='after-decision'&&args[0]===note(task))stop()}
  try {await assign(files,task,'old',oldContract,oldDecision)}
  finally {files.rename=rename;files.replace=replace;files.appendPrepared=append}
  throw Error('The requested old interruption was not reached: '+mode)
}
if(process.argv[2]==='--interrupt-continuation') {
  const files=new PhysicalLocalFiles(process.argv[3]),task=JSON.parse(await read(files,paths.task(process.argv[5])))
  await interruptOld(files,task,process.argv[4],true)
}
const base=await fs.mkdtemp(path.join(os.tmpdir(),'dss-worker-assignment-continuation-')),opened=[]
async function fixture(name){const files=new PhysicalLocalFiles(path.join(base,name));opened.push(files);const [task]=tasks(false);await seed(files,[task]);return{files,task}}
try {
  // The actual new Planner tool invocation first finishes the old accepted
  // body and decision. The contract observed at each real wake is the right
  // one, and only then does the latest requested contract replace it.
  const modes=['before-contract','after-contract','decision-prepared','after-decision','before-signal','signal-consumed','signal-accepted','published-before-cleanup']
  for(const mode of modes) {
    const {files,task}=await fixture(mode)
    await rejects(()=>interruptOld(files,task,mode),/actual old assignment interruption/)
    const old=await assignment(files,task),events=[],rename=files.rename.bind(files),w=workerPaths(task.taskId,task.owner,'worker')
    files.rename=async(a,b)=>{const ok=await rename(a,b);if(ok&&b===workerSignal(task))events.push(await read(files,w.contract));return ok}
    await assign(files,task,'new',newContract,newDecision)
    check(events,['signal-consumed','signal-accepted','published-before-cleanup'].includes(mode)?[newContract]:[oldContract,newContract])
    check(await read(files,w.contract),newContract);check(await read(files,note(task)),'Existing note\r\n'+oldDecision+newDecision)
    const latest=await assignment(files,task);check(latest.commandId,'agent-'+task.taskId+':new');check(latest.published,true)
    check(old.commandId,'agent-'+task.taskId+':old');check(await read(files,workerSignal(task)),'')
    check((await fs.readdir(path.join(files.directory,w.root))).filter(x=>x.startsWith('.assignment-')),[])
    if(mode==='signal-accepted') {
      const receiver=await physicalReceiver(files,'A',loaded),workId=receiver.runtime.roleKey('Worker',task.taskId,'worker')
      const record=await receiver.runtime.records.get(receiver.runtime.prefix+'roles/'+createHash('sha256').update(workId).digest('hex'))
      receiver.runtime.roleRecords.set(workId,record)
      await receiver.runtime.consumeWakeSignals(record.identity)
      check(await read(files,workerSignal(task)),'')
    }
    // Same accepted latest tool command remains a retry, not another append.
    await consume(files,workerSignal(task));await assign(files,task,'new',newContract,newDecision)
    check(await read(files,workerSignal(task)),undefined);check(await read(files,note(task)),'Existing note\r\n'+oldDecision+newDecision)
  }
  // Interruption during the new request after the old one was completed
  // leaves only the new accepted fact. Retrying it must not replay the old
  // decision or re-emit its already-consumed notification.
  {
    const {files,task}=await fixture('new-interrupted-after-old'),w=workerPaths(task.taskId,task.owner,'worker')
    await rejects(()=>interruptOld(files,task,'before-contract'),/interruption/)
    const rename=files.rename.bind(files);let contracts=0,oldSignals=0,newSignals=0
    files.rename=async(a,b)=>{
      if(b===w.contract&&++contracts===2)throw Error('new request interrupted after old completion')
      const ok=await rename(a,b)
      if(ok&&b===workerSignal(task)){
        if(await read(files,w.contract)===oldContract){oldSignals++;await consume(files,b)}else newSignals++
      }
      return ok
    }
    await rejects(()=>assign(files,task,'new',newContract,newDecision),/new request interrupted/)
    check((await assignment(files,task)).commandId,'agent-'+task.taskId+':new')
    check(await read(files,note(task)),'Existing note\r\n'+oldDecision)
    await assign(files,task,'new',newContract,newDecision)
    check(oldSignals,1);check(newSignals,1);check(await read(files,note(task)),'Existing note\r\n'+oldDecision+newDecision)
  }
  // A new command with identical text is still a new continuation, even when
  // the previous identical request was interrupted before publication.
  {
    const {files,task}=await fixture('same-text-new-command')
    await rejects(()=>interruptOld(files,task,'before-contract'),/interruption/)
    await assign(files,task,'new-same-text',oldContract,oldDecision)
    check(await read(files,note(task)),'Existing note\r\n'+oldDecision+oldDecision)
    check((await assignment(files,task)).commandId,'agent-'+task.taskId+':new-same-text')
  }
  // Cold process restarts continue the accepted original, not a fabricated
  // new-command replay. Actual Runtime consumption is persisted before exit.
  for(const mode of ['before-contract','after-decision','signal-consumed']) {
    const {files,task}=await fixture('process-'+mode),child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt-continuation',files.directory,mode,task.taskId],{encoding:'utf8'})
    check(child.status,82);processInterruptions++
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    await assign(cold,task,'new',newContract,newDecision)
    check(await read(cold,workerPaths(task.taskId,task.owner,'worker').contract),newContract)
    check(await read(cold,note(task)),'Existing note\r\n'+oldDecision+newDecision);check((await assignment(cold,task)).published,true)
  }
  // D026: a real exited producer, an ordinary later edit, then a genuinely
  // new registered Planner call for this same childId. The old continuation
  // must not put its former bytes back over the later user edit.
  for(const edited of ['contract','decision']) {
    const mode=edited==='contract'?'after-contract':'after-decision'
    const {files,task}=await fixture('process-user-edit-'+edited)
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt-continuation',files.directory,mode,task.taskId],{encoding:'utf8'})
    check(child.status,82);processInterruptions++
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    const worker=workerPaths(task.taskId,task.owner,'worker')
    const target=edited==='contract'?worker.contract:note(task)
    const change='User edited original '+edited+' after old rename\n'
    const editedText=(await read(cold,target))+change
    await fs.appendFile(path.join(cold.directory,target),change)
    const old=await assignment(cold,task)
    const stageVersion=edited==='contract'?old.contractPrepared.version:old.decisionPrepared.stageVersion
    check(fileIdentity((await cold.fileInfo(target)).version),fileIdentity(stageVersion))
    const signalReads=[],rename=cold.rename.bind(cold)
    cold.rename=async(a,b)=>{const done=await rename(a,b);if(done&&b===workerSignal(task))signalReads.push({contract:await read(cold,worker.contract),memory:await read(cold,note(task))});return done}
    await assign(cold,task,'new',newContract,newDecision)
    check(signalReads.length,2)
    check(signalReads[0].contract,edited==='contract'?editedText:oldContract)
    check(signalReads[0].memory,edited==='decision'?editedText:'Existing note\r\n'+oldDecision)
    check(signalReads[1].contract,newContract)
    check(signalReads[1].memory,(edited==='decision'?editedText:'Existing note\r\n'+oldDecision)+newDecision)
    check((await assignment(cold,task)).commandId,'agent-'+task.taskId+':new')
    check(old.commandId,'agent-'+task.taskId+':old')
    check(await read(cold,worker.root+'/.assignment-contract.stage'),undefined)
  }
  // If old bytes/publication proof really is missing, do not stage the new
  // request, overwrite old evidence, or report completion. Other Workers can
  // still progress from their own exact operations.
  for(const target of ['contract','decision','signal']) {
    const {files,task}=await fixture('unknown-'+target),mode=target==='signal'?'before-signal':'before-contract',w=workerPaths(task.taskId,task.owner,'worker')
    await rejects(()=>interruptOld(files,task,mode),/interruption/)
    if(target==='contract')await files.delete(w.root+'/.assignment-contract.stage')
    if(target==='decision')await files.delete(w.root+'/.assignment-decision.txt')
    if(target==='signal')await files.delete(w.root+'/.assignment-signal.stage')
    const factBefore=await read(files,assignmentPath(task)),decisionBefore=await read(files,w.root+'/.assignment-decision.txt'),memoryBefore=await read(files,note(task))
    await rejects(()=>assign(files,task,'new',newContract,newDecision),target==='decision'?/decision is missing/:/not confirmed/)
    // Missing decision may follow one now-confirmed contract, but the old
    // command still owns the fact and no new stage/request is accepted.
    check((await assignment(files,task)).commandId,JSON.parse(factBefore).commandId)
    if(target!=='decision')check(await read(files,assignmentPath(task)),factBefore)
    check(await read(files,w.root+'/.assignment-decision.txt'),decisionBefore)
    check(await read(files,note(task)),memoryBefore);check(await read(files,workerSignal(task)),undefined)
    await assign(files,task,'other','Other Worker contract','Other Worker decision\n','other')
    check(await read(files,workerPaths(task.taskId,task.owner,'other').contract),'Other Worker contract')
    check((await assignment(files,task)).commandId,'agent-'+task.taskId+':old')
  }
  // An already-renamed old contract or appended decision can subsequently be
  // edited before confirmation. A new assignment replaces only its own
  // contract; the old continuation cannot undo the intervening edit.
  for(const edited of ['contract','decision']) {
    const {files,task}=await fixture('edited-'+edited),w=workerPaths(task.taskId,task.owner,'worker')
    await rejects(()=>interruptOld(files,task,edited==='contract'?'after-contract':'after-decision'),/interruption/)
    const target=edited==='contract'?w.contract:note(task),change='User edit after uncertain '+edited+' publication\n'
    const text=(await read(files,target))+change
    await fs.appendFile(path.join(files.directory,target),change)
    const signals=[],rename=files.rename.bind(files)
    files.rename=async(a,b)=>{const done=await rename(a,b);if(done&&b===workerSignal(task))signals.push({contract:await read(files,w.contract),memory:await read(files,note(task))});return done}
    await assign(files,task,'new',newContract,newDecision)
    check(signals.length,2)
    check(signals[0].contract,edited==='contract'?text:oldContract)
    check(signals[0].memory,edited==='decision'?text:'Existing note\r\n'+oldDecision)
    check(await read(files,w.contract),newContract)
    check(await read(files,note(task)),(edited==='decision'?text:'Existing note\r\n'+oldDecision)+newDecision)
  }
  // An external editor's atomic replacement changes inode. The persisted
  // stage identity cannot prove that replacement ever contained old bytes;
  // retain the old fact and issue no stale Worker wake or new same-child job.
  for(const edited of ['contract','decision']) {
    const mode=edited==='contract'?'after-contract':'after-decision'
    const {files,task}=await fixture('atomic-replace-'+edited)
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt-continuation',files.directory,mode,task.taskId],{encoding:'utf8'})
    check(child.status,82);processInterruptions++
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    const worker=workerPaths(task.taskId,task.owner,'worker'),target=edited==='contract'?worker.contract:note(task)
    const text='Atomic editor replacement of '+edited+'\n'
    const old=await assignment(cold,task)
    await cold.replace(target,text)
    const stageVersion=edited==='contract'?old.contractPrepared.version:old.decisionPrepared.stageVersion
    assert.notDeepEqual(fileIdentity((await cold.fileInfo(target)).version),fileIdentity(stageVersion));assertions++
    await rejects(()=>assign(cold,task,'new',newContract,newDecision),/not confirmed/)
    check(await read(cold,target),text)
    check((await assignment(cold,task)).commandId,old.commandId)
    check(await read(cold,workerSignal(task)),undefined)
    await assign(cold,task,'other','Other contract\n','Other decision\n','other')
    check(await read(cold,workerPaths(task.taskId,task.owner,'other').contract),'Other contract\n')
  }
  // Deleted target is likewise unprovable, not permission to wake a Worker.
  {
    const {files,task}=await fixture('deleted-published-contract'),worker=workerPaths(task.taskId,task.owner,'worker')
    await rejects(()=>interruptOld(files,task,'after-contract'),/interruption/)
    const old=await assignment(files,task)
    await files.delete(worker.contract)
    await rejects(()=>assign(files,task,'new',newContract,newDecision),/not confirmed/)
    check((await assignment(files,task)).commandId,old.commandId)
    check(await read(files,worker.contract),undefined)
    check(await read(files,workerSignal(task)),undefined)
  }
  // A later Planner command is admissible only while the original Task still
  // runs. Use the actual terminal entry points, not a hand-written status.
  for(const terminal of ['complete','cancelled']) {
    const {files,task}=await fixture('terminal-'+terminal)
    await rejects(()=>interruptOld(files,task,'after-contract'),/interruption/)
    const prior=await assignment(files,task),worker=workerPaths(task.taskId,task.owner,'worker')
    if(terminal==='complete') await complete(files,task,'terminal-complete',{},false)
    else await cancelTask(cancellation(files,task),{taskId:task.taskId},'terminal-cancel')
    check((await metadata(files,task)).status,terminal)
    await rejects(()=>assign(files,task,'new',newContract,newDecision),/closed/)
    check((await assignment(files,task)).commandId,prior.commandId)
    check(await read(files,worker.contract),oldContract)
  }
  // Only the resumed Worker's exact lane waits. A second Worker under the
  // same Planner and another Task both finish while its contract rename holds.
  {
    const {files,task}=await fixture('parallel')
    await rejects(()=>interruptOld(files,task,'before-contract'),/interruption/)
    const rename=files.rename.bind(files),w=workerPaths(task.taskId,task.owner,'worker')
    let entered,release,heldOnce=false
    const arrived=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
    files.rename=async(a,b)=>{if(b===w.contract&&!heldOnce){heldOnce=true;entered();await gate}return rename(a,b)}
    const advancing=assign(files,task,'new',newContract,newDecision);await arrived
    await assign(files,task,'parallel-other','Independent other contract','Independent other decision\n','other')
    check(await read(files,workerPaths(task.taskId,task.owner,'other').contract),'Independent other contract')
    const independent={...task,taskId:ids[4],sourcePath:'tasks/independent_P.md',archiveFolder:ids[4]};await seed(files,[independent])
    await assign(files,independent,'parallel-task','Independent Task contract','Independent Task decision\n')
    check(await read(files,workerPaths(independent.taskId,independent.owner,'worker').contract),'Independent Task contract')
    release();await advancing
    check(await read(files,w.contract),newContract)
    check(await read(files,note(task)),'Existing note\r\nIndependent other decision\n'+oldDecision+newDecision)
  }
  // No cross-lifecycle recovery and no reuse of one command with new bytes.
  {
    const {files,task}=await fixture('identity')
    await rejects(()=>interruptOld(files,task,'before-contract'),/interruption/)
    const original=await read(files,assignmentPath(task))
    await rejects(()=>assign(files,task,'old',newContract,newDecision),/original contract and decision/)
    check(await read(files,assignmentPath(task)),original)
    const changed={...task,lifecycleId:'different'};await files.replace(paths.task(task.taskId),JSON.stringify(changed))
    await rejects(()=>assign(files,changed,'new',newContract,newDecision),/different Task lifecycle/)
    check(await read(files,assignmentPath(task)),original)
  }
  console.log(JSON.stringify({status:'passed',assertions,processInterruptions,node:process.version,scope:'Actual installed Planner dss_worker_assign, file-backed cold restart, real process exit and extracted actual Runtime source/consumption methods. Controlled native/schema/storage ports; no native DSH/Windows/default-cutover claim.',sourceHashes:Object.fromEntries(loaded)},null,2))
} finally {for(const files of opened)await files.close();hooks.deregister();await fs.rm(base,{recursive:true,force:true})}
