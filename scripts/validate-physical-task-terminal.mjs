import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Current requirement: real physical dss_complete/cancelTask preserve authored
// Notes, child originals and results. Children notify only parent O; one root
// notifies independent Foreground + Recorder. Real process exits below exercise
// prepared-file handoffs. Schemas/Markdown/skills are explicit unrelated stubs.
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
    const source = readFileSync(new URL(url),'utf8'); loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'))
    return { format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true }
  }
  return next(url,context)
} })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { physicalReceiver } = await import('./test-support/physical-receiver.mjs')
const signalSources = files => async path => (await physicalReceiver(files, path.split('/').length === 4 ? path.split('/')[1] : 'A', loaded)).sources(path)
const consume = async (files,path) => (await physicalReceiver(files, path.split('/').length === 4 ? path.split('/')[1] : 'A', loaded)).accept(path)
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { paths, taskWorkingRoots, taskInitializationFiles, childCompletionSignal, foregroundTaskSignal } = await import('../src/framework/task-files.ts')
const { cancelTask } = await import('../src/framework/task-cancellation.ts')
const { resumePhysicalTaskTerminalHandoff, physicalTaskTerminalPath } = await import('../src/framework/physical-task-terminal.ts')
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
  const snapshot=await files.snapshot();try{await host.scanTask(task,snapshot,performance.now())}finally{await snapshot.release()}
  // Local Host releases native resources and continues its own Cleaner lane
  // after scanTask returns. Wait for those accepted operations, not a timer.
  for(;;){
    const owned=[...host.physicalCleanupOperations.values(),...host.physicalReleaseOperations.values()]
    if(!owned.length)break
    await Promise.allSettled(owned)
  }
  cleaner.close()
  if(errors.length)throw new AggregateError(errors,'Actual total cleanup/retirement failed')
  check(await read(files,paths.task(task.taskId)),undefined)
  check(await read(files,task.sourcePath),undefined)
  check(await read(files,paths.archive(task)+'/state.json'),undefined)
  for(const directory of taskWorkingRoots(task))check(existsSync(path.join(files.directory,directory)),false)
  return task
}
if(process.argv[2]==='--interrupt') {
  const files=new PhysicalLocalFiles(process.argv[3]),mode=process.argv[4],family=tasks(mode==='cancel-child'),root=family[0]
  const replace=files.replace.bind(files),rename=files.rename.bind(files),update=files.update.bind(files),nativeRename=fs.rename.bind(fs)
  const exit=()=>process.exit(79)
  files.replace=async(p,text)=>{
    await replace(p,text)
    if(p.endsWith('.foreground.json')) {
      const progress=JSON.parse(text)
      if(mode==='fg-prepared'&&progress.prepared&&!progress.published)exit()
      if(mode==='fg-published'&&progress.published){await files.delete(foregroundTaskSignal(root.taskId));exit()}
    }
  }
  const remove=files.delete.bind(files)
  files.delete=async p=>{const result=await remove(p);if(mode==='fg-progress-removed'&&p.endsWith('.foreground.json')){await remove(foregroundTaskSignal(root.taskId));exit()}return result}
  fs.rename=async(from,to)=>{
    await nativeRename(from,to)
    if(mode==='note-staged'&&String(to).endsWith('/acceptance.md'))exit()
    if(mode==='note-published'&&String(to).endsWith('/Planner_Memory.md'))exit()
    if(mode==='fg-stage'&&String(to).endsWith('.foreground.stage'))exit()
  }
  files.update=async(p,fn)=>{
    const result=await update(p,fn)
    if(p===physicalTaskTerminalPath(root)) {
      const text=await read(files,p),pending=text&&JSON.parse(text)
      if(mode==='pending'&&!pending?.acceptance?.prepared)exit()
      if(mode==='note-prepared'&&pending?.acceptance?.prepared&&!pending.acceptance.published)exit()
      if(mode==='signals-prepared'&&pending?.signals.length&&pending.signals.every(x=>x.prepared))exit()
      if(mode==='root-retire-phase'&&pending?.finished){await files.delete(foregroundTaskSignal(root.taskId));exit()}
    }
    if(mode==='terminal'&&p===paths.task(root.taskId))exit()
    if(mode==='cancel-child'&&p===paths.task(family[2].taskId))exit()
    return result
  }
  files.rename=async(from,to)=>{
    const result=await rename(from,to)
    if(mode==='foreground-consumed'&&to===foregroundTaskSignal(root.taskId)){await consume(files,to);exit()}
    if(mode==='recorder-consumed'&&to===paths.state(root.owner,root.taskId)+'/Recorder'){await consume(files,to);exit()}
    return result
  }
  if(mode==='cancel-child')await cancelTask(cancellation(files,root),{taskId:root.taskId},'cancel')
  else await complete(files,root)
  throw new Error('The requested real process interruption was not reached: '+mode)
}
const base=await fs.mkdtemp(path.join(os.tmpdir(),'dss-physical-terminal-')),opened=[]
async function fixture(name,tree=true) { const files=new PhysicalLocalFiles(path.join(base,name));opened.push(files);const family=tasks(tree);await seed(files,family);return {files,family} }
try {
  const {files,family:[root,group,leaf,sibling]}=await fixture('tree')
  const originals=new Map(await Promise.all([root,group,leaf,sibling].map(async t=>[evidence(t),await read(files,evidence(t))])))
  await complete(files,leaf);check(await signals(files),[childCompletionSignal(leaf.parent,leaf.taskId)])
  check(await read(files,note(leaf)),'Existing note\r\nAccepted actual evidence.\n')
  check(JSON.parse(await read(files,paths.memberStatus(leaf.taskId,leaf.owner))),{state:'complete'})
  await complete(files,group);await complete(files,sibling)
  check((await signals(files)).some(p=>p.endsWith('/Recorder')||p.endsWith('/Cleaner')||p.startsWith('state/Foreground')),false)
  await complete(files,root)
  check((await signals(files)).filter(p=>p.endsWith('/Recorder')),[paths.state(root.owner,root.taskId)+'/Recorder'])
  check((await signals(files)).filter(p=>p.startsWith('state/Foreground')),[foregroundTaskSignal(root.taskId)])
  const producedWakes=await hostResume(files,await metadata(files,root),{task:false})
  const producedForeground=producedWakes.find(w=>w.role==='Foreground'&&w.sources.some(s=>s.path===foregroundTaskSignal(root.taskId)))
  check(!!producedForeground,true)
  check(producedForeground.taskId,root.taskId)
  check(producedForeground.context.taskPath,paths.task(root.taskId))
  check(JSON.parse(await read(files,producedForeground.context.taskPath)).sourcePath,root.sourcePath)
  check(path.basename(root.sourcePath),'root_O.md')
  for(const t of [root,group,leaf,sibling]) {
    check((await metadata(files,t)).status,'complete');check(await read(files,evidence(t)),originals.get(evidence(t)))
    check((await metadata(files,t)).resultPaths,[evidence(t)]);check(await read(files,physicalTaskTerminalPath(t)),undefined)
    check(await read(files,t.sourcePath),'Task ID: '+t.taskId+'\nOriginal requirement '+t.taskId)
  }
  // The registered Organizer acceptance follows a real reciprocal grandchild
  // result and stores that child's already-retained exact logical file.
  const mapped=await fixture('mapped-grandchild'),[mappedRoot,mappedGroup,mappedLeaf,mappedSibling]=mapped.family
  await complete(mapped.files,mappedLeaf);await complete(mapped.files,mappedGroup);await complete(mapped.files,mappedSibling)
  const mappedTarget=paths.archive(mappedLeaf)+'/retained/evidence.md'
  await mapped.files.replace(mappedTarget,'Retained accepted evidence')
  await mapped.files.replace(paths.archive(mappedLeaf)+'/retention.json',JSON.stringify({version:1,relocatedReferences:{[evidence(mappedLeaf)]:mappedTarget}}))
  const mappedRole=role(mapped.files,mappedRoot),mappedView=await mappedRole.call('dss_snapshot',{})
  await mappedRole.call('dss_complete',{snapshotId:mappedView.snapshotId,acceptance:'Accepted the actual retained grandchild evidence.',resultPaths:[evidence(mappedLeaf)]},'mapped-grandchild-complete')
  check((await metadata(mapped.files,mappedRoot)).resultPaths,[mappedTarget])
  check((await metadata(mapped.files,mappedRoot)).status,'complete')
  await rejects(()=>complete(files,leaf),/already closed/)
  for(const p of await signals(files))await files.delete(p)
  for(const t of [root,group,leaf,sibling])await resumePhysicalTaskTerminalHandoff(files,await metadata(files,t))
  check(await signals(files),[])

  for(const selectedRoot of [false,true]) {
    const {files,family:[root,group,leaf,sibling]}=await fixture('cancel-'+selectedRoot)
    const selected=selectedRoot?root:group,stops=[]
    const access=cancellation(files,selected,{afterCancel:async(ids,lifecycles)=>stops.push({ids,lifecycles})})
    const result=await cancelTask(access,{taskId:selected.taskId},'cancel')
    await hostResume(files,await metadata(files,selected),{task:false})
    check(new Set(result.cancelledTaskIds),new Set((selectedRoot?[root,group,leaf,sibling]:[group,leaf]).map(t=>t.taskId)))
    check(stops.length,1)
    if(selectedRoot)check(await signals(files),[foregroundTaskSignal(root.taskId),paths.state(root.owner,root.taskId)+'/Recorder'].sort())
    else {check((await signals(files)).length,1);check((await signals(files))[0].startsWith(paths.state(root.owner,root.taskId)+'/Organizer_ChildCancelled_'),true);check((await metadata(files,root)).status,'running');check((await metadata(files,sibling)).status,'running')}
    const beforeSignals=await signals(files)
    check(await cancelTask(access,{taskId:selected.taskId},'different-command'),result);check(await signals(files),beforeSignals)
    for(const t of [root,group,leaf,sibling]){check(await read(files,note(t)),'Existing note\r\n');check(await read(files,evidence(t)),'Original selected evidence '+t.taskId)}
  }
  // Completed descendants are preserved by a later total cancellation.
  const retained=await fixture('completed-child');await complete(retained.files,retained.family[2])
  await cancelTask(cancellation(retained.files,retained.family[0]),{taskId:retained.family[0].taskId},'cancel')
  check((await metadata(retained.files,retained.family[2])).status,'complete')
  check((await metadata(retained.files,retained.family[2])).resultPaths,[evidence(retained.family[2])])

  // Business validation precedes the first pending fact or authored write.
  const invalid=await fixture('invalid');const invalidLeaf=invalid.family[2]
  await rejects(()=>complete(invalid.files,invalid.family[0]),/Each assigned child/)
  await invalid.files.delete(evidence(invalidLeaf));await rejects(()=>complete(invalid.files,invalidLeaf),/Result reference is missing/)
  check(await read(invalid.files,physicalTaskTerminalPath(invalidLeaf)),undefined)
  check(await read(invalid.files,note(invalidLeaf)),'Existing note\r\n')
  await rejects(()=>cancelTask({...cancellation(invalid.files,invalid.family[0]),member:'outsider'},{taskId:invalid.family[0].taskId},'cancel'),/no registered/)
  await rejects(()=>cancelTask(cancellation(invalid.files,invalid.family[0]),{taskId:invalid.family[0].taskId,lifecycleId:'stale'},'cancel'),/different lifecycle/)
  check((await metadata(invalid.files,invalid.family[0])).status,'running')

  // A newly arrived notification is ordinary work, not a failed acceptance.
  // The actual tool keeps the native turn and signal open without terminal facts.
  const notified=await fixture('notifications',false),notifiedTask=notified.family[0]
  const incoming=paths.state(notifiedTask.owner,notifiedTask.taskId)+'/Planner_New'
  await notified.files.replace(incoming,'')
  let hasNotification=true
  const waiting=await complete(notified.files,notifiedTask,'complete',{notifications:async()=>hasNotification?[incoming]:[]})
  check(waiting.result.notifications,[incoming]);check(waiting.r.ended,0)
  check(await read(notified.files,incoming),'');check((await metadata(notified.files,notifiedTask)).status,'running')
  check(await read(notified.files,note(notifiedTask)),'Existing note\r\n')
  check(await read(notified.files,physicalTaskTerminalPath(notifiedTask)),undefined)
  await notified.files.delete(incoming);hasNotification=false
  await waiting.r.call('dss_complete',waiting.input,'complete');check(waiting.r.ended,1)
  check((await metadata(notified.files,notifiedTask)).status,'complete')

  // True process termination, fresh handle and the actual Host's Task lane.
  const modes=['pending','note-staged','note-prepared','note-published','signals-prepared','terminal','foreground-consumed','recorder-consumed','cancel-child','fg-stage','fg-prepared','fg-published','root-retire-phase','fg-progress-removed']
  for(const mode of modes) {
    if(process.env.DSS_TRACE_TEST)console.error('terminal interruption',mode)
    const {files,family}=await fixture('crash-'+mode,mode==='cancel-child'),selected=family[0]
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt',files.directory,mode],{encoding:'utf8'})
    check(child.status,79);processInterruptions++
    const globalSnapshot=await files.snapshot();const globalPending=(await files.listDirectory(globalSnapshot,'state/')).find(e=>/\.Task_Terminal_[^/.]+\.json$/.test(e.path));await globalSnapshot.release()
    const pending=JSON.parse(await read(files,mode==='foreground-consumed'?globalPending.path:physicalTaskTerminalPath(selected)))
    check(pending.commandId,mode==='cancel-child'?'task-cancel:cancel':'agent-'+selected.taskId+':complete')
    if(mode==='note-staged')check(pending.acceptance.prepared,undefined)
    if(mode==='note-prepared')check(typeof pending.acceptance.prepared?.stageVersion,'string')
    if(mode==='note-published')check(pending.acceptance.published,undefined)
    if(mode==='pending'){await hostResume(files,await metadata(files,selected),{task:false});check(await read(files,foregroundTaskSignal(selected.taskId)),undefined)}
    // Existing unrelated signal and a new ordinary Note append must survive.
    await files.replace(paths.state('other',ids[4])+'/Planner_Inbox','')
    await files.append(note(selected),'Appended after interruption.\n')
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    if(mode==='note-published') {
      await rejects(async()=>hostResume(cold,await metadata(cold,selected)),/Host resume failed/)
      check((await metadata(cold,selected)).status,'running')
      check((await read(cold,note(selected))).split('Accepted actual evidence.\n').length-1,1)
      check((await read(cold,note(selected))).includes('Appended after interruption.\n'),true)
      check(!!await read(cold,physicalTaskTerminalPath(selected)),true)
      continue
    }
    await hostResume(cold,await metadata(cold,selected))
    const stored=await metadata(cold,selected)
    check(stored.status,mode==='cancel-child'?'cancelled':'complete')
    const text=await read(cold,note(selected))
    check(text.includes('Existing note\r\n'),true);check(text.includes('Appended after interruption.\n'),true)
    check(text.split('Accepted actual evidence.\n').length-1,mode==='cancel-child'?0:1)
    check(await read(cold,physicalTaskTerminalPath(selected)),undefined)
    const expectedSignals=[paths.state('other',ids[4])+'/Planner_Inbox']
    if(!['foreground-consumed','fg-published','root-retire-phase','fg-progress-removed'].includes(mode))expectedSignals.push(foregroundTaskSignal(selected.taskId))
    if(mode!=='recorder-consumed')expectedSignals.push(paths.state(selected.owner,selected.taskId)+'/Recorder')
    check(await signals(cold),expectedSignals.sort())
    if(mode==='cancel-child')for(const t of family)check((await metadata(cold,t)).status,'cancelled')
    const before=await signals(cold);await hostResume(cold,stored);check(await signals(cold),before)
  }

  // After terminal publication, a repeated pending handoff cannot recreate
  // member working files already removed by an in-progress total cleanup.
  const partialCleanup=await fixture('partial-cleanup',false),pct=partialCleanup.family[0]
  const interrupted=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt',partialCleanup.files.directory,'recorder-consumed'],{encoding:'utf8'})
  check(interrupted.status,79);processInterruptions++
  await partialCleanup.files.removeDirectory(paths.member(pct.taskId,pct.owner))
  await hostResume(partialCleanup.files,await metadata(partialCleanup.files,pct))
  check(await read(partialCleanup.files,paths.memberStatus(pct.taskId,pct.owner)),undefined)
  check(await read(partialCleanup.files,note(pct)),undefined)
  check(await read(partialCleanup.files,paths.state(pct.owner,pct.taskId)+'/Recorder'),undefined)

  // Full Foreground preparation is independent, not merely its final rename.
  // Hold/fail actual native rename inside stage creation or prepared-fact
  // replacement. Its physical file queue remains owned while Task lanes run.
  for(const seam of ['stage','prepared-fact'])for(const fail of [false,true]) {
    const test=await fixture('foreground-prepare-'+seam+'-'+fail,false),files=test.files,selected=test.family[0]
    let fgPreparationCalls=0
    const create=files.createIfAbsent.bind(files)
    files.createIfAbsent=async(p,text)=>{if(p.endsWith('.foreground.stage'))fgPreparationCalls++;return create(p,text)}
    await complete(files,selected,'complete',{},false)
    check((await metadata(files,selected)).status,'complete');check(fgPreparationCalls,0)
    check(await read(files,paths.state(selected.owner,selected.taskId)+'/Recorder'),'')
    const nativeRename=fs.rename.bind(fs);let entered,release
    const arrived=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
    fs.rename=async(from,to)=>{
      if(String(to).startsWith(files.directory+path.sep)&&String(to).endsWith(seam==='stage'?'.foreground.stage':'.foreground.json')) {
        entered();if(fail)throw new Error('controlled Foreground '+seam+' failure');await gate
      }
      return nativeRename(from,to)
    }
    try {
    const foreground=hostResume(files,await metadata(files,selected),{task:false}).then(value=>({value}),error=>({error}))
    await arrived
    const wakes=await hostResume(files,await metadata(files,selected),{signals:false})
    check(wakes.some(w=>w.role==='Recorder'),true)
    const history=await cleanThroughHost(files,selected)
    check(!!await read(files,physicalTaskTerminalPath(selected)),true)
    if(!fail)release()
    const result=await foreground
    fs.rename=nativeRename
    if(fail){check(result.error.message,'controlled Foreground '+seam+' failure');const cold=new PhysicalLocalFiles(files.directory);opened.push(cold);await hostResume(cold,history,{task:false})}
    check(await read(files,foregroundTaskSignal(selected.taskId)),'')
    check(await read(files,physicalTaskTerminalPath(selected)),undefined)
    check(await read(files,paths.task(selected.taskId)),undefined)
    } finally {release();fs.rename=nativeRename}
  }
  // Recorder stage/prepared-fact failures or held SAME-FILE writes cannot
  // hold Foreground's own preparation, publication or actual Host wake.
  for(const seam of ['stage','prepared-fact'])for(const fail of [false,true]) {
    const test=await fixture('recorder-prepare-'+seam+'-'+fail,false),files=test.files,selected=test.family[0]
    const nativeRename=fs.rename.bind(fs),update=files.update.bind(files)
    let terminal=false,entered,release;const arrived=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
    files.update=async(p,fn)=>{const result=await update(p,fn);if(p===paths.task(selected.taskId))terminal=true;return result}
    fs.rename=async(from,to)=>{
      if(terminal&&String(to).startsWith(files.directory+path.sep)&&(seam==='stage'?String(to).endsWith('.task-signal-0.stage'):String(to)===path.join(files.directory,physicalTaskTerminalPath(selected)))) {
        entered();if(fail)throw new Error('controlled Recorder '+seam+' failure');await gate
      }
      return nativeRename(from,to)
    }
    try {
    const completing=complete(files,selected,'complete',{},false).then(value=>({value}),error=>({error}))
    await arrived
    const actual=await metadata(files,selected);check(actual.status,'complete')
    const wakes=await hostResume(files,actual,{task:false})
    check(wakes.some(w=>w.role==='Foreground'),true)
    check(await read(files,foregroundTaskSignal(selected.taskId)),'')
    await files.delete(foregroundTaskSignal(selected.taskId))
    if(!fail)release()
    const result=await completing;fs.rename=nativeRename;files.update=update
    if(fail)check(result.error.message,'controlled Recorder '+seam+' failure')
    await hostResume(files,actual)
    check(await read(files,paths.state(selected.owner,selected.taskId)+'/Recorder'),'')
    check(await read(files,foregroundTaskSignal(selected.taskId)),undefined)
    check(await read(files,physicalTaskTerminalPath(selected)),undefined)
    } finally {release();fs.rename=nativeRename;files.update=update}
  }

  // The existing global signal lane is independent of Recorder and Cleaner.
  // Hold Foreground's actual rename while the Task lane discovers Recorder and
  // the actual total Cleaner deletes the tree. Global prepared material survives.
  for(const fail of [false,true]) {
    const branch=await fixture('foreground-independent-'+fail,false),selected=branch.family[0],files=branch.files
    await complete(files,selected,'complete',{},false)
    const stored=await metadata(files,selected),rename=files.rename.bind(files)
    let entered,release;const arrived=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
    files.rename=async(from,to)=>{
      if(to===foregroundTaskSignal(selected.taskId)){entered();if(fail)throw new Error('controlled Foreground publication failure');await gate}
      return rename(from,to)
    }
    try {
    const foreground=hostResume(files,stored,{task:false}).then(value=>({value}),error=>({error}))
    await arrived
    const wakes=await hostResume(files,stored,{signals:false})
    check(wakes.some(w=>w.role==='Recorder'),true)
    await files.replace(paths.state(selected.owner,selected.taskId)+'/Cleaner','')
    const cleaner=new FrameworkCleaner(files,{},async()=>{})
    for(let pass=0;pass<3;pass++) {
      const snapshot=await files.snapshot()
      try{if((await cleaner.clean(stored,await observeCleanup(files,snapshot,stored,performance.now()))).status==='released')break}
      finally{await snapshot.release()}
    }
    cleaner.close()
    check(await read(files,note(selected)),undefined)
    check(!!await read(files,physicalTaskTerminalPath(selected)),true)
    const snapshot=await files.snapshot();const remaining=await files.listDirectory(snapshot,'state/');await snapshot.release()
    check(remaining.some(e=>/\.Task_Terminal_[^/.]+\.json$/.test(e.path)),true)
    if(!fail)release()
    const outcome=await foreground
    if(fail) {
      check(outcome.error.message,'controlled Foreground publication failure');files.rename=rename
      // Use the actual minimum history projection and remove runnable metadata.
      // This tests the Foreground read fallback, not automatic retirement.
      const history=taskHistoryChange(stored);await files.replace(history.path,history.content)
      await files.delete(paths.task(selected.taskId))
      const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
      await hostResume(cold,stored,{task:false})
      check(await read(cold,paths.task(selected.taskId)),undefined)
    }
    check(await read(files,foregroundTaskSignal(selected.taskId)),'')
    const after=await files.snapshot();check((await files.listDirectory(after,'state/')).some(e=>e.path.includes('/.Task_Terminal_')),false);await after.release()
    } finally {release();files.rename=rename}
  }
  // Conversely a failed Recorder publication cannot prevent Foreground.
  const recorderFailure=await fixture('recorder-independent',false),rf=recorderFailure.files,rt=recorderFailure.family[0],originalRename=rf.rename.bind(rf)
  rf.rename=async(from,to)=>{if(to===paths.state(rt.owner,rt.taskId)+'/Recorder')throw new Error('controlled Recorder publication failure');return originalRename(from,to)}
  await rejects(()=>complete(rf,rt,'complete',{},false),/Recorder publication failure/)
  check((await metadata(rf,rt)).status,'complete')
  await hostResume(rf,await metadata(rf,rt),{task:false})
  check(await read(rf,foregroundTaskSignal(rt.taskId)),'')
  check(await read(rf,paths.state(rt.owner,rt.taskId)+'/Recorder'),undefined)
  await rf.delete(foregroundTaskSignal(rt.taskId));rf.rename=originalRename
  await hostResume(rf,await metadata(rf,rt))
  check(await read(rf,foregroundTaskSignal(rt.taskId)),undefined)
  check(await read(rf,paths.state(rt.owner,rt.taskId)+'/Recorder'),'')

  // Actual Recorder publication can succeed immediately before its phase-save
  // failure. The already-existing Cleaner notice takes priority over that save,
  // removes Task metadata/state, and the global lane finishes the original
  // handoff from existing Recorder archive/history after its source roles are gone.
  for(const crash of [false,true]) {
    const test=await fixture('recorder-published-before-save-'+crash,false),files=test.files,selected=test.family[0]
    if(crash) {
      const stopped=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt',files.directory,'recorder-consumed'],{encoding:'utf8'})
      check(stopped.status,79);processInterruptions++
    } else {
      const update=files.update.bind(files)
      files.update=async(p,decide)=>update(p,bytes=>{
        const result=decide(bytes)
        if(p===physicalTaskTerminalPath(selected)&&result.content) {
          const next=JSON.parse(result.content)
          if(!next.finished&&next.signals.every(signal=>signal.published))throw new Error('controlled Recorder published-phase failure')
        }
        return result
      })
      await rejects(()=>complete(files,selected,'complete',{},false),/published-phase failure/)
    }
    const common=JSON.parse(await read(files,physicalTaskTerminalPath(selected)))
    check(typeof common.signals[0].prepared?.version,'string');check(common.signals[0].published,undefined)
    check(await read(files,common.signals[0].stage),undefined)
    const history=await cleanThroughHost(files,selected)
    check(!!await read(files,physicalTaskTerminalPath(selected)),true)
    const cold=new PhysicalLocalFiles(files.directory);opened.push(cold)
    await hostResume(cold,history,{task:false})
    check(await read(cold,foregroundTaskSignal(selected.taskId)),'')
    check(await read(cold,paths.state(selected.owner,selected.taskId)+'/Recorder'),undefined)
    check(await read(cold,physicalTaskTerminalPath(selected)),undefined)
    check(await read(cold,paths.task(selected.taskId)),undefined)
  }

  // Ordinary writes to the same Note queue behind only the actual prepared
  // append; another Task and an independent Worker file continue immediately.
  const racing=await fixture('concurrent-note',false),selected=racing.family[0],files2=new PhysicalLocalFiles(racing.files.directory);opened.push(files2)
  const originalUpdate=racing.files.update.bind(racing.files);let entered,release,paused=false
  const arrived=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
  racing.files.update=async(p,decide)=>{
    const value=await originalUpdate(p,decide)
    if(!paused&&p===physicalTaskTerminalPath(selected)&&JSON.parse(await read(racing.files,p)).acceptance?.prepared){paused=true;entered();await gate}
    return value
  }
  try {
  const completing=complete(racing.files,selected)
  await arrived
  const appending=files2.append(note(selected),'Concurrent ordinary append.\n')
  await files2.append(paths.run(ids[4])+'/worker.md','Independent Worker')
  check(await read(files2,paths.run(ids[4])+'/worker.md'),'Independent Worker')
  const independent={...selected,taskId:ids[4],sourcePath:'tasks/independent_P.md',archiveFolder:ids[4]}
  await seed(files2,[independent]);await complete(files2,independent)
  check((await metadata(files2,independent)).status,'complete')
  const competingCancellation=cancelTask(cancellation(files2,selected),{taskId:selected.taskId},'cancel').then(()=>({ok:true}),error=>({error}))
  release();await completing;await appending
  check((await competingCancellation).error.message,'A completed Task cannot be cancelled or reopened.')
  check(await read(files2,note(selected)),'Existing note\r\nAccepted actual evidence.\nConcurrent ordinary append.\n')
  } finally {release();racing.files.update=originalUpdate}
  // Failed Note append publication does not kill another Task or fabricate state.
  const failed=await fixture('append-failed',false),failTask=failed.family[0]
  failed.files.appendPrepared=async()=>{throw new Error('controlled actual Note failure')}
  await rejects(()=>complete(failed.files,failTask),/actual Note failure/)
  check((await metadata(failed.files,failTask)).status,'running');check(await signals(failed.files),[])
  const other=await fixture('unrelated-success',false);await complete(other.files,other.family[0]);check((await metadata(other.files,other.family[0])).status,'complete')
  console.log(JSON.stringify({status:'passed',assertions,processInterruptions,node:process.version,scope:'Real physical dss_complete/cancelTask/Host continuation; explicit schema/Markdown/skills stubs; no native DSH, Windows, full typecheck, package or default cutover',sourceHashes:Object.fromEntries(loaded)},null,2))
} finally {for(const files of opened)await files.close();hooks.deregister();await fs.rm(base,{recursive:true,force:true})}
