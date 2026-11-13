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
 return next(specifier,context)},load(url,context,next){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const { PhysicalLocalFiles }=await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools,workerPaths }=await import('../src/framework/role-tools.ts')
const { paths }=await import('../src/framework/task-files.ts')
const {spawnSync}=await import('node:child_process')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {taskInitializationFiles}=await import('../src/framework/task-files.ts')
const {resumePhysicalTaskRequirement}=await import('../src/framework/physical-task-dispatch.ts')
const {cancelPhysicalTask}=await import('../src/framework/physical-task-terminal.ts')
const ids=[1,2,3].map(n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'))
const task=(route='P',id=ids[0])=>({version:1,taskId:id,route,owner:'A',members:['A','B'],status:'running',sourcePath:'tasks/'+id+'_'+route+'.md',archiveFolder:id})
const original='原始要求\r\nKeep original bytes.\r\n',supplement='新增要求\r\nNo invented facts.',plan='实际目标\r\nIndependent requirement.',decision='Organizer original decision\r\n'
let assertions=0,processInterruptions=0,interruptedOperations=0,hostInterleavings=0
const faultCases={},processExitPhases=[],hostInterleavingPhases=[]
const check=(a,b)=>{assert.deepEqual(a,b);assertions++},rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const read=async(files,p)=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const metadata=async(files,t)=>JSON.parse(await read(files,paths.task(t.taskId)))
async function seed(files,t){await files.replace(paths.task(t.taskId),JSON.stringify(t));await files.replace(t.sourcePath,'Task ID: '+t.taskId+'\n'+original);for(const change of taskInitializationFiles(t))await files.replace(change.path,change.content);if(t.route==='O')await files.replace(paths.run(t.taskId)+'/Dispatch.md','Existing decision\n')}
// Controlled recipient persistence boundary. Values are actual file
// observations and are saved before production deleteObserved, never invented
// from a missing stage. Full native receiver/runtime integration is separate.
async function acceptedSources(files){try{return JSON.parse(await fs.readFile(path.join(files.directory,'.test-receiver-sources.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return [];throw e}}
async function consumePublished(files,target){const info=await files.fileInfo(target);assert(info);const sources=await acceptedSources(files);await fs.writeFile(path.join(files.directory,'.test-receiver-sources.json'),JSON.stringify([...sources,{path:target,version:info.version}]));await files.deleteObserved(target,info.version)}
function role(files,t,roleName,extra={}){
 const tools=new Map(),agent={id:roleName+'-agent',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const binding={role:roleName,owner:t.owner,...(roleName==='Foreground'?{}:{taskId:t.taskId,lifecycleId:t.lifecycleId,member:t.owner}),workId:'work-'+roleName,executionId:'exec-'+roleName}
 installFrameworkRoleTools(ctx,agent,binding,{files,physicalSignalSources:()=>acceptedSources(files),transact:async()=>{throw new Error('Unexpected generic transaction')},notifications:async snapshot=>(await files.listDirectory(snapshot,paths.state(t.owner,t.taskId))).filter(row=>row.path.split('/').at(-1).startsWith(roleName+'_')).map(row=>row.path),claimNotifications:async()=>({signals:[]}),onError:()=>{},...extra})
 return (name,input,id=name)=>tools.get(name).execute(input,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){}})
}
async function append(files,t,command='supplement',text=supplement){const call=role(files,t,'Foreground'),view=await call('dss_snapshot',{taskId:t.taskId});return call('dss_supplement_task',{snapshotId:view.snapshotId,text},command)}
async function dispatch(files,t,routeName='P',command='dispatch',objectiveId='objective',extra={}){const call=role(files,t,'Organizer'),view=await call('dss_snapshot',{});return call('dss_planner_dispatch',{snapshotId:view.snapshotId,objectiveId,member:'B',route:routeName,plan,decision,...extra},command)}
async function complete(files,t){const call=role(files,t,t.route==='O'?'Organizer':'Planner'),view=await call('dss_snapshot',{});return call('dss_complete',{snapshotId:view.snapshotId,acceptance:'Final acceptance\n',resultPaths:[]},'complete')}
function host(files,member='A',primary=true){
 const state=new Map(),errors=[],wakes=[],observed=[],storage={get:async k=>state.get(k),set:async(k,v)=>state.set(k,structuredClone(v))}
 const scope='dispatch-test-'+member,loop=new FrameworkHostLoop(files,new FrameworkTransactions(files,storage,scope),storage,{member,primary,scope,instanceUUID:ids[2]},()=>['A','B'],{
 startup:async()=>{},observe:async()=>{},physicalSignalSources:()=>acceptedSources(files),wake:async request=>{wakes.push(request);return false},executing:()=>false,sealBusiness:async()=>{},clean:async()=>false,
 releaseTask:async()=>{},initializeWorkspace:async()=>{},taskStateObserved:async t=>observed.push(t),error:e=>errors.push(e)})
 return {loop,errors,wakes,observed,async start(){await loop.start();await loop.firstPoll},async close(){await loop.stop()}}
}
async function hostResume(files,t){const h=host(files,t.owner);const s=await files.snapshot();try{await h.loop.scanTask(t,s,performance.now())}finally{await s.release();await h.close()}if(h.errors.length)throw new AggregateError(h.errors,'Host scan failed');return h.wakes}
if(process.argv[2]==='--interrupt'){
 const files=new PhysicalLocalFiles(process.argv[3]),mode=process.argv[4],t=task(mode.startsWith('child-')?'O':'P')
 const exit=()=>process.exit(78),replace=files.replace.bind(files),rename=files.rename.bind(files),create=files.createIfAbsent.bind(files),update=files.update.bind(files),nativeRename=fs.rename.bind(fs)
 files.update=async(p,f)=>{const result=await update(p,f);const current=p.startsWith('tasks/')&&p.endsWith('.json')?JSON.parse(await read(files,p)):undefined
  if(mode==='supplement-attached'&&current?.requirementPublications)exit()
  if(mode==='child-accepted-prepared'&&current?.requirementPublications?.length)exit()
  if(mode==='child-linked'&&current?.children?.length)exit()
  return result}
 files.createIfAbsent=async(p,c)=>{const result=await create(p,c);if(mode==='child-metadata'&&p.startsWith('tasks/')&&p.endsWith('.json')&&p!==paths.task(t.taskId))exit();return result}
 files.replace=async(p,c)=>{await replace(p,c);if(p.endsWith('/publication.json')){const fact=JSON.parse(c);if(mode==='supplement-source-prepared'&&fact.sourcePrepared&&!fact.sourcePublished)exit();if(mode==='child-signal-prepared'&&fact.signalVersion&&!fact.published)exit()}}
 fs.rename=async(a,b)=>{await nativeRename(a,b);if(mode==='supplement-source-renamed'&&String(b)===path.join(files.directory,t.sourcePath))exit();if(mode==='child-source'&&String(a).endsWith('/source.stage'))exit()}
 files.rename=async(a,b)=>{const result=await rename(a,b);if((mode==='supplement-signal-consumed'||mode==='child-signal-consumed')&&b.startsWith('state/')){await consumePublished(files,b);exit()}return result}
 if(mode.startsWith('child-'))await dispatch(files,t);else await append(files,t)
 throw new Error('Interruption phase was not reached: '+mode)
}
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-task-dispatch-'))
try{
 // Actual Foreground port: P/O destination, original bytes and once-per-command
 // append, with a subsequent request and a retry of the earlier command.
 for(const routeName of ['P','O']){
  const files=new PhysicalLocalFiles(path.join(scratch,'supplement-'+routeName)),t=task(routeName);await seed(files,t)
  await append(files,t);const signal=paths.state('A',t.taskId)+'/'+(routeName==='P'?'Planner':'Organizer')+'_Foreground'
  check(await read(files,t.sourcePath),'Task ID: '+t.taskId+'\n'+original+'\n\n'+supplement);check(await read(files,signal),'')
  await files.delete(signal);await files.append(t.sourcePath,'\nUser edit')
  await append(files,t);check(await read(files,signal),undefined)
  await append(files,t,'next-supplement','Second requirement');await files.delete(signal);await append(files,t)
  check(await read(files,t.sourcePath),'Task ID: '+t.taskId+'\n'+original+'\n\n'+supplement+'\nUser edit\n\nSecond requirement')
  await rejects(()=>append(files,t,'supplement','changed same command'),/unchanged content/)
  check((await metadata(files,t)).requirementPublications,undefined);await files.close()
 }
 // Independent P and nested O retain actual scope, reciprocal identity,
 // separate runtime roots, archive hierarchy and original Dispatcher records.
 const files=new PhysicalLocalFiles(path.join(scratch,'tree')),parent=task('O');await seed(files,parent)
 await dispatch(files,parent,'O','group','group');let p=await metadata(files,parent),group=JSON.parse(await read(files,paths.task(p.children[0].taskId)))
 check(group.route,'O');check(group.members,['B','A']);check(group.parent,{taskId:parent.taskId,owner:'A',objectiveId:'group'})
 check(group.archiveFolder,parent.archiveFolder+'/'+group.taskId);check(group.workspaceFolder,undefined)
 check(await read(files,group.sourcePath),'Task ID: '+group.taskId+'\n'+plan);check(await read(files,paths.run(group.taskId)+'/Organizer_Note.md'),'')
 const groupCall=role(files,group,'Organizer'),groupView=await groupCall('dss_snapshot',{})
 await groupCall('dss_planner_dispatch',{snapshotId:groupView.snapshotId,objectiveId:'leaf',member:'A',route:'P',plan:'Leaf raw requirement',decision:'Nested real decision'})
 group=await metadata(files,group);const leaf=JSON.parse(await read(files,paths.task(group.children[0].taskId)))
 check(leaf.route,'P');check(leaf.members,['A']);check(leaf.parent.taskId,group.taskId);check(await read(files,paths.inbox(leaf.taskId,'A')),'Leaf raw requirement')
 check(existsSync(path.join(files.directory,paths.run(group.taskId),leaf.taskId)),false)
 check(await read(files,paths.run(parent.taskId)+'/Dispatch.md'),'Existing decision\n'+decision)
 await files.delete(paths.state(group.owner,group.taskId)+'/Organizer_Task');await dispatch(files,parent,'O','group','group');check(await read(files,paths.state(group.owner,group.taskId)+'/Organizer_Task'),undefined)
 await dispatch(files,parent,'P','single','single');p=await metadata(files,parent);const child=JSON.parse(await read(files,paths.task(p.children.find(x=>x.objectiveId==='single').taskId)))
 const inbox=paths.inbox(child.taskId,'B');await files.append(inbox,'\nExisting Inbox note');await files.append(child.sourcePath,'\nExisting source edit')
 await dispatch(files,parent,'P','supplement-single','single',{plan:'New actual plan',decision:'New actual decision'})
 check(await read(files,child.sourcePath),'Task ID: '+child.taskId+'\n'+plan+'\nExisting source edit\n\nNew actual plan')
 check(await read(files,inbox),plan+'\nExisting Inbox note\n\nNew actual plan')
 await rejects(()=>dispatch(files,parent,'P','outside','outside',{member:'not-registered'}),/actual member/)
 await rejects(()=>dispatch(files,parent,'P','scope','single',{members:['B','A']}),/assigned member scope/)
 await files.replace(paths.task(child.taskId),JSON.stringify({...await metadata(files,child),status:'complete'}))
 await rejects(()=>dispatch(files,parent,'P','closed','single'),/completed child Task/)
 for(const target of [group,leaf,child]){check(await read(files,paths.state(target.owner,target.taskId)+'/Recorder'),undefined);check(await read(files,paths.state(target.owner,target.taskId)+'/Cleaner'),undefined)}
 await files.close()
 // Cold store/actual Host continuation after process exit, including original
 // notification already consumed before its phase was saved. No tool retry.
 for(const mode of ['supplement-attached','supplement-source-prepared','supplement-source-renamed','supplement-signal-consumed','child-accepted-prepared','child-metadata','child-linked','child-source','child-signal-prepared','child-signal-consumed']){
  const dir=path.join(scratch,mode);let files=new PhysicalLocalFiles(dir),t=task(mode.startsWith('child-')?'O':'P');await seed(files,t);await files.close()
  const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--interrupt',dir,mode],{encoding:'utf8',timeout:30000});check(result.status,78);if(result.status!==78)throw new Error(result.stderr);processInterruptions++;processExitPhases.push(mode)
  files=new PhysicalLocalFiles(dir);await hostResume(files,await metadata(files,t))
  const current=await metadata(files,t);check(current.requirementPublications,undefined)
  if(mode.startsWith('child-')){
   check(current.children.length,1);const actual=JSON.parse(await read(files,paths.task(current.children[0].taskId)))
   check(actual.parent.taskId,t.taskId);check(actual.requirementPublications,undefined)
   check(await read(files,actual.sourcePath),'Task ID: '+actual.taskId+'\n'+plan)
   check(await read(files,paths.inbox(actual.taskId,'B')),plan);check(await read(files,paths.run(t.taskId)+'/Dispatch.md'),'Existing decision\n'+decision)
   check(await read(files,paths.state('B',actual.taskId)+'/Planner_Inbox'),mode==='child-signal-consumed'?undefined:'')
  }else{check(await read(files,t.sourcePath),'Task ID: '+t.taskId+'\n'+original+'\n\n'+supplement);check(await read(files,paths.state('A',t.taskId)+'/Planner_Foreground'),mode==='supplement-signal-consumed'?undefined:'')}
  await files.close()
 }

 // Faults before/after every addressed filesystem method in each real port,
 // then reconstruct the store and retry the same real tool command. This also
 // covers the between-command distinction: equal prose is not retry identity.
 for(const kind of ['foreground','child-new','child-existing']){
  const t=task(kind==='foreground'?'P':'O'),methods=['replace','rename','renameIfAbsent','createIfAbsent','update','appendPrepared','delete']
  async function setup(dir){const f=new PhysicalLocalFiles(dir);await seed(f,t);if(kind==='child-existing')await dispatch(f,t,'P','initial');return f}
  const invoke=f=>kind==='foreground'?append(f,t):dispatch(f,t,'P','fault-command')
  const trace=await setup(path.join(scratch,'trace-'+kind));let operationCount=0
  for(const method of methods){const actual=trace[method].bind(trace);trace[method]=async(...args)=>{operationCount++;return actual(...args)}}
  await invoke(trace);await trace.close();faultCases[kind]=operationCount*2
  for(const when of ['before','after'])for(let at=0;at<operationCount;at++){
   let f=await setup(path.join(scratch,'fault-'+kind+'-'+when+'-'+at)),index=0,consumed=false
   for(const method of methods){const actual=f[method].bind(f);f[method]=async(...args)=>{
    const n=index++;if(n===at&&when==='before')throw new Error('addressed failure')
    const result=await actual(...args)
    if(method==='rename'&&args[1].startsWith('state/')&&result){consumed=true;await consumePublished(f,args[1])}
    if(n===at&&when==='after')throw new Error('addressed failure');return result
   }}
   await rejects(()=>invoke(f),/addressed failure/);interruptedOperations++
   const dir=f.directory;await f.close();f=new PhysicalLocalFiles(dir);await invoke(f)
   const current=await metadata(f,t);check(current.requirementPublications,undefined)
   if(kind==='foreground'){
    check(await read(f,t.sourcePath),'Task ID: '+t.taskId+'\n'+original+'\n\n'+supplement)
    check(await read(f,paths.state('A',t.taskId)+'/Planner_Foreground'),consumed?undefined:'')
   }else{
    check(current.children.length,1);const child=JSON.parse(await read(f,paths.task(current.children[0].taskId)))
    const suffix=kind==='child-existing'?'\n\n'+plan:''
    check(await read(f,child.sourcePath),'Task ID: '+child.taskId+'\n'+plan+suffix)
    check(await read(f,paths.inbox(child.taskId,'B')),plan+suffix)
    check(await read(f,paths.run(t.taskId)+'/Dispatch.md'),'Existing decision\n'+decision+(kind==='child-existing'?decision:''))
    check(await read(f,paths.state('B',child.taskId)+'/Planner_Inbox'),consumed?undefined:'')
   }
   await f.close()
  }
 }
 // Actual Host.start/poll lanes interleave at child metadata, reciprocal link,
 // source, and signal publication. A held related lane never blocks another
 // Task's wake. No child is classified/initialized as a root midway through.
 for(const phase of ['metadata','linked','source','signal']){
  const f=new PhysicalLocalFiles(path.join(scratch,'interleave-'+phase)),parent=task('O'),other=task('P',ids[1]);await seed(f,parent);await seed(f,other)
  await f.replace(paths.state('A',other.taskId)+'/Planner_Foreground','')
  let release,entered,held=false,childId
  const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r)
  async function hold(){if(!held){held=true;entered();await gate}}
  const create=f.createIfAbsent.bind(f),update=f.update.bind(f),rename=f.rename.bind(f),renameIfAbsent=f.renameIfAbsent.bind(f)
  f.createIfAbsent=async(p,c)=>{const result=await create(p,c);if(p.startsWith('tasks/')&&p.endsWith('.json')&&![paths.task(parent.taskId),paths.task(other.taskId)].includes(p)){childId=JSON.parse(c).taskId;if(phase==='metadata')await hold()}return result}
  f.update=async(p,cb)=>{const result=await update(p,cb);if(phase==='linked'&&p===paths.task(parent.taskId)&&(await metadata(f,parent)).children?.length)await hold();return result}
  f.renameIfAbsent=async(a,b)=>{const result=await renameIfAbsent(a,b);if(phase==='source'&&b.startsWith('tasks/')&&b.endsWith('.md'))await hold();return result}
  f.rename=async(a,b)=>{const result=await rename(a,b);if(phase==='signal'&&b.startsWith('state/B/'))await hold();return result}
  const work=dispatch(f,parent);await reached
  check(typeof childId,'string')
  const pendingChild=JSON.parse(await read(f,paths.task(childId)))
  check(pendingChild.parent.taskId,parent.taskId)
  check(await read(f,pendingChild.sourcePath),phase==='metadata'||phase==='linked'?undefined:'Task ID: '+childId+'\n'+plan)
  const owner=host(f,'A'),recipient=host(f,'B',false)
  const opening=owner.start(),otherOpening=recipient.start()
  await Promise.race([(async()=>{for(let n=0;n<1000&&!owner.wakes.some(w=>w.taskId===other.taskId);n++)await new Promise(r=>setTimeout(r,1));check(owner.wakes.some(w=>w.taskId===other.taskId),true)})(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Unrelated Task was blocked by dispatch')),3000))])
  check(owner.errors.length,0);check(recipient.errors.length,0)
  check([...owner.wakes,...recipient.wakes].some(w=>w.taskId===childId),false)
  release();await work;await Promise.all([opening,otherOpening]);await owner.loop.poll();await recipient.loop.poll()
  check(owner.errors.length,0);check(recipient.errors.length,0)
  const actual=JSON.parse(await read(f,paths.task(childId)))
  check(actual.owner,'B');check(actual.parent.taskId,parent.taskId)
  check(recipient.wakes.some(w=>w.taskId===childId&&w.role==='Planner'),true)
  check(Object.values(owner.loop.record.initial).some(v=>v.taskId===childId),false)
  check(Object.values(recipient.loop.record.initial).some(v=>v.taskId===childId),false)
  await Promise.all([owner.close(),recipient.close()]);await f.close();hostInterleavings++;hostInterleavingPhases.push(phase)
 }


 // Two actual dss_planner_dispatch calls on the SAME O package publish
 // independent objectives. Hold child one's own metadata/file operation;
 // child two must finish with its own source, reciprocal link and signal.
 const parallel=new PhysicalLocalFiles(path.join(scratch,'parallel-objectives')),packageTask=task('O');await seed(parallel,packageTask)
 let releaseChild,enteredChild,heldChild=false
 const childGate=new Promise(r=>releaseChild=r),childReached=new Promise(r=>enteredChild=r),nativeCreate=parallel.createIfAbsent.bind(parallel)
 parallel.createIfAbsent=async(p,c)=>{const result=await nativeCreate(p,c);if(p.startsWith('tasks/')&&p.endsWith('.json')&&p!==paths.task(packageTask.taskId)&&!heldChild){heldChild=true;enteredChild();await childGate}return result}
 const firstChild=dispatch(parallel,packageTask,'P','first-child','first');await childReached
 await Promise.race([dispatch(parallel,packageTask,'P','second-child','second'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Independent objective blocked behind another child file')),3000))])
 let packageNow=await metadata(parallel,packageTask),secondChild=JSON.parse(await read(parallel,paths.task(packageNow.children.find(x=>x.objectiveId==='second').taskId)))
 check(await read(parallel,secondChild.sourcePath),'Task ID: '+secondChild.taskId+'\n'+plan)
 check(await read(parallel,paths.state('B',secondChild.taskId)+'/Planner_Inbox'),'')
 check(packageNow.requirementPublications.length,1)
 releaseChild();await firstChild;packageNow=await metadata(parallel,packageTask)
 check(packageNow.children.map(x=>x.objectiveId).sort(),['first','second']);check(packageNow.requirementPublications,undefined)
 check(await read(parallel,paths.run(packageTask.taskId)+'/Dispatch.md'),'Existing decision\n'+decision+decision)
 await parallel.close()

 // Completion itself resumes an interrupted supplement and returns the actual
 // pending notification to the Planner rather than sealing or blocking forever.
 const terminal=new PhysicalLocalFiles(path.join(scratch,'complete')),target=task();await seed(terminal,target)
 const rename=terminal.rename.bind(terminal);terminal.rename=async(a,b)=>{if(b.startsWith('state/'))throw new Error('before notify');return rename(a,b)}
 await rejects(()=>append(terminal,target),/before notify/);terminal.rename=rename
 const completion=await complete(terminal,target);check(completion.notifications,[paths.state('A',target.taskId)+'/Planner_Foreground']);check((await metadata(terminal,target)).status,'running')
 await terminal.delete(paths.state('A',target.taskId)+'/Planner_Foreground');await complete(terminal,target);check((await metadata(terminal,target)).status,'complete')
 await rejects(()=>append(terminal,target,'late'),/closed/);await terminal.close()


 // Cancelling a real interrupted child dispatch first preserves the exact
 // accepted input and relationship, then cancels the resulting whole family.
 const cancelling=new PhysicalLocalFiles(path.join(scratch,'cancel-pending')),cancelParent=task('O');await seed(cancelling,cancelParent)
 const createChild=cancelling.createIfAbsent.bind(cancelling);let interrupted=false
 cancelling.createIfAbsent=async(p,c)=>{const result=await createChild(p,c);if(p.startsWith('tasks/')&&p.endsWith('.json')&&p!==paths.task(cancelParent.taskId)&&!interrupted){interrupted=true;throw new Error('child metadata boundary')}return result}
 await rejects(()=>dispatch(cancelling,cancelParent),/child metadata boundary/);cancelling.createIfAbsent=createChild
 const beforeUnauthorized=await read(cancelling,paths.task(cancelParent.taskId))
 await rejects(()=>cancelPhysicalTask(cancelling,cancelParent,'outsider','wrong-cancel'),/registered execution domain/)
 check(await read(cancelling,paths.task(cancelParent.taskId)),beforeUnauthorized)
 const cancelled=await cancelPhysicalTask(cancelling,cancelParent,'A','actual-cancel')
 check(cancelled.length,2);const cancelledRoot=await metadata(cancelling,cancelParent),cancelledChild=JSON.parse(await read(cancelling,paths.task(cancelledRoot.children[0].taskId)))
 check(cancelledRoot.status,'cancelled');check(cancelledChild.status,'cancelled')
 check(await read(cancelling,cancelledChild.sourcePath),'Task ID: '+cancelledChild.taskId+'\n'+plan)
 check(await read(cancelling,paths.state(cancelledChild.owner,cancelledChild.taskId)+'/Recorder'),undefined)
 await cancelling.close()

 // Real acceptance races in both directions: an in-flight supplement wins
 // before its signal and completion rechecks; a committed terminal wins first
 // and the later supplement cannot mutate that closed original requirement.
 for(const first of ['supplement','complete']){
  const f=new PhysicalLocalFiles(path.join(scratch,'race-'+first)),t=task();await seed(f,t)
  let entered,release,held=false;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r)
  const appendPrepared=f.appendPrepared.bind(f),update=f.update.bind(f)
  f.appendPrepared=async(...args)=>{if(first==='supplement'&&args[0]===t.sourcePath&&!held){held=true;entered();await gate}return appendPrepared(...args)}
  f.update=async(...args)=>{const result=await update(...args);if(first==='complete'&&args[0].startsWith('state/.Task_Terminal_')&&!held){held=true;entered();await gate}return result}
  const one=first==='supplement'?append(f,t):complete(f,t);await reached
  let laterSettled=false
  const two=(first==='supplement'?complete(f,t):append(f,t,'late-race')).then(result=>({result}),error=>({error})).finally(()=>{laterSettled=true})
  await new Promise(r=>setTimeout(r,10));if(first==='supplement')check(laterSettled,false)
  release();await one;const outcome=await two
  if(first==='supplement'){check(outcome.error,undefined);check(outcome.result.notifications,[paths.state('A',t.taskId)+'/Planner_Foreground']);check((await metadata(f,t)).status,'running')}
  else{check(!!outcome.error,true);check((await metadata(f,t)).status,'complete');check(await read(f,t.sourcePath),'Task ID: '+t.taskId+'\n'+original)}
  await f.close()
 }

 // Removing a stage is not evidence that its target was published. Exercise
 // the real method returning false, retain accepted facts, and never signal.
 for(const missing of ['publication','child-source','supplement-source']){
  const f=new PhysicalLocalFiles(path.join(scratch,'missing-'+missing)),t=task(missing==='supplement-source'?'P':'O');await seed(f,t)
  const rename=f.rename.bind(f),renameIfAbsent=f.renameIfAbsent.bind(f);let erased=false
  f.rename=async(a,b)=>{
   if(!erased&&((missing==='publication'&&a.endsWith('/prepared.json'))||(missing==='child-source'&&a.endsWith('/source.stage')))){
    erased=true;await f.delete(a);await f.delete(b)
   }
   return rename(a,b)
  }
  f.renameIfAbsent=async(a,b)=>{if(!erased&&missing==='child-source'&&a.endsWith('/source.stage')){erased=true;await f.delete(a);await f.delete(b)}return renameIfAbsent(a,b)}
  const appendPrepared=f.appendPrepared.bind(f)
  if(missing==='supplement-source')f.appendPrepared=async(...args)=>{await appendPrepared(...args);await f.delete(args[0]);throw new Error('source removed after accepted append')}
  await rejects(()=>missing==='supplement-source'?append(f,t):dispatch(f,t),missing==='publication'?/fact is missing or changed/:missing==='child-source'?/not confirmed/:/source removed/)
  f.rename=rename;f.renameIfAbsent=renameIfAbsent;f.appendPrepared=appendPrepared
  const parent=await metadata(f,t);check(parent.requirementPublications.length,1)
  if(missing==='supplement-source')await rejects(()=>hostResume(f,parent),error=>error instanceof AggregateError&&error.errors.some(item=>/original task requirement is missing/i.test(item.message)))
  if(parent.children?.length){const child=JSON.parse(await read(f,paths.task(parent.children[0].taskId)));check(await read(f,child.sourcePath),undefined);check(await read(f,paths.state('B',child.taskId)+'/Planner_Inbox'),undefined)}
  else check(await read(f,paths.state('A',t.taskId)+'/Planner_Foreground'),undefined)
  await f.close()
 }

 // File absence without an existing recipient acceptance is not success.
 // A newly recreated same-name signal cannot impersonate this staged signal.
 for(const newSignal of [false,true]){
  const f=new PhysicalLocalFiles(path.join(scratch,'unknown-signal-'+newSignal)),t=task();await seed(f,t)
  const rename=f.rename.bind(f);let target
  f.rename=async(a,b)=>{if(a.endsWith('/signal.stage')){target=b;await f.delete(a);if(newSignal)await f.replace(b,'');return false}return rename(a,b)}
  await rejects(()=>append(f,t),/not confirmed/);check((await metadata(f,t)).requirementPublications.length,1)
  check(await read(f,target),newSignal?'':undefined);check(await acceptedSources(f),[]);await f.close()
 }

 console.log(JSON.stringify({status:'passed',assertions,processInterruptions,interruptedOperations,faultCases,hostInterleavings,processExitPhases,hostInterleavingPhases,limits:'Actual installed role tools, physical files, Host scanTask continuation and fresh Linux process exit. Schema/Markdown/skills and native action ports controlled; receiver persistence port stores actual observations before deleteObserved, not a full native receiver. No native DSH/Windows/power-loss/full tsc acceptance.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
