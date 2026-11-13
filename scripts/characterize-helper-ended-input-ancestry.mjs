// Actual Local FrameworkService, SDK tools, Planner completion, Recorder and Cleaner.
// Model tool choices are controlled. Ordinary dss_help reports are synthetic test
// diagnostics; no I/O fault or Task/role completion state is injected.
import fs from 'node:fs/promises'
import path from 'node:path'
const {fixture:localFixture,trace,check,checks,until:localUntil,mark,root,evidence,hash}=await import('./helper-service-sdk.mjs')
const gitMode=process.argv.includes('--git'),fixture=gitMode?(await import('./helper-task-end-git.mjs')).fixture:localFixture
// Local CLI object transport has process-per-object overhead; test budget only.
const until=gitMode?async(name,fn)=>{const end=Date.now()+120000;for(;;){const value=await fn();if(value)return value;if(Date.now()>end)throw Error('Git experiment wait expired: '+name);await new Promise(r=>setTimeout(r,20))}}:localUntil
const {DshStorageAdapter}=await import('../src/adapters/dsh/storage.ts')
const originalStorageSet=DshStorageAdapter.prototype.set
DshStorageAdapter.prototype.set=async function(key,value){const result=await originalStorageSet.call(this,key,value);if(value?.safetyAttempts?.some(a=>a.attemptId.endsWith(':pending-original-B-report')))mark('original-B-attempt-persisted',{key,value});return result}
let f,sequence=0
const mixed=process.argv.includes('--mixed'),safetyB=process.argv.includes('--safety-b'),expectRetired=process.env.DSS_HELPER_END_EXPECT==='retired'
const wakeTask=w=>w.context?.target?.taskId??w.context?.identity?.taskId??w.context?.taskId??w.taskId
const publish=(p,text)=>gitMode?f.publish(p,text):fs.writeFile(path.join(f.dir,'business',p),text)
const read=p=>gitMode?f.read(p):fs.readFile(path.join(f.dir,'business',p),'utf8').catch(e=>{if(e.code==='ENOENT')return undefined;throw e})
const ready=async(role,taskId)=>until(role+' model ready '+(taskId??''),()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role===role&&!r.stopped&&(!taskId||r.identity.taskId===taskId)&&r.delivery?.confirmed&&f.model.waiting.has(r.sessionId)))
async function command(role,name,input={},ends=false){
 const id='task-end-claim-'+(++sequence),start=trace.length;f.model.command(role.sessionId,{name,input,callId:id})
 const event=await until(name+' result',()=>trace.slice(start).find(x=>x.event==='tool'&&x.id===role.sessionId&&x.type==='tool/result'&&x.data.message.toolCallId===id))
 check(name+' succeeds '+sequence,event.data.message.isError,false)
 if(!ends)await until(name+' next model step',()=>f.model.waiting.has(role.sessionId))
 return JSON.parse(event.data.message.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))
}
// A successful handoff concludes its tool with no value. A non-error
// completed:false is a continuation, not acceptance; follow the real notice.
async function completeTask(role,acceptance){
 const end=Date.now()+(gitMode?120000:20000)
 for(;;){
  const claimed=await command(role,'dss_claim')
  const result=await command(role,'dss_complete',{snapshotId:claimed.snapshotId,acceptance,resultPaths:[]},true)
  if(result?.completed===false){
   mark('completion-deferred',{taskId:role.identity.taskId,notifications:result.notifications})
   if(Date.now()>end)throw Error('Test completion budget expired while processing actual notifications')
   await until('deferred acceptance next model step',()=>f.model.waiting.has(role.sessionId))
   continue
  }
  const actual=JSON.parse(await read('tasks/'+role.identity.taskId+'.json'))
  check('actual Task metadata accepted '+role.identity.taskId,actual.status,'complete')
  return
 }
}
try{
 f=await fixture('task-end-helper-claims')
 const tasks=path.join(f.dir,'business/tasks');await fs.mkdir(tasks,{recursive:true})
 await publish('tasks/claimA_P.md','# Controlled Task A\nComplete the independent A objective after normal Helper inspection.\n')
 const a=await ready('Planner');await command(a,'dss_claim')
 await command(a,'dss_help',{facts:'Controlled diagnostic request A: inspect this isolated task record. No I/O fault is injected.'})
 let helper=await ready('Helper');await command(helper,'dss_claim')
 await publish('tasks/claimB_P.md','# Controlled Task B\nKeep the independent B objective running while A ends.\n')
 const b=await until('second actual Planner ready',()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Planner'&&r.identity.taskId!==a.identity.taskId&&!r.stopped&&f.model.waiting.has(r.sessionId)))
 await command(b,'dss_claim')
 if(safetyB){
  f.model.waiting.get(b.sessionId).reject(new Error('Controlled actual model source failure B'))
  await until('actual B SDK error captured',()=>[...f.rt.safetyEpisodes.values()].some(e=>(e.fault.taskId??e.fault.identity?.taskId)===b.identity.taskId))
 }else await command(b,'dss_help',{facts:'Controlled diagnostic request B: inspect B without completing it. No I/O fault is injected.'})
 await until('B actual Helper signal publication',async()=>{const rows=await f.active.connection.records.list(f.prefix+'wakes/');const r=rows.find(r=>wakeTask(r.value.request)===b.identity.taskId&&r.value.helperSignal);return r&&read(r.value.helperSignal).then(value=>value!==undefined)})
 const bClaim=mixed?undefined:await command(helper,'dss_claim')
 if(bClaim)check('B real notification is returned',bClaim.helperNotifications.some(w=>wakeTask(w)===b.identity.taskId),true)
 await command(a,'dss_help',{facts:'Controlled later request A: record inspection before actual A completion.'})
 await until('later A actual Helper signal publication',async()=>{const rows=await f.active.connection.records.list(f.prefix+'wakes/');const r=rows.find(r=>r.value.request.context?.target?.taskId===a.identity.taskId&&r.value.request.context?.facts?.startsWith('Controlled later')&&r.value.helperSignal);return r&&read(r.value.helperSignal).then(value=>value!==undefined)})
 const aClaim=await command(helper,'dss_claim')
 check('later A real notification is returned',aClaim.helperNotifications.some(w=>w.context?.target?.taskId===a.identity.taskId),true)
 const before=structuredClone(f.rt.roleRecords.get(helper.identity.workId).notificationClaims)
 const aKeys=Object.entries(before).filter(([,c])=>c.helperWakes?.length&&(mixed?c.helperWakes.some(w=>w.context?.target?.taskId===a.identity.taskId):c.helperWakes.every(w=>w.context?.target?.taskId===a.identity.taskId))).map(([id])=>id)
 const bKeys=Object.entries(before).filter(([,c])=>c.helperWakes?.some(w=>wakeTask(w)===b.identity.taskId)).map(([id])=>id)
 check('one A claim selected',aKeys.length,1);check('one B claim selected',bKeys.length,1)
 if(mixed)check('actual one claim contains two Tasks',aKeys[0],bKeys[0])
 const logs=[...new Set(aClaim.helperNotifications.map(w=>w.context?.helperDebugPath).filter(Boolean))]
 for(const log of logs){const view=await command(helper,'dss_snapshot');await command(helper,'dss_record',{snapshotId:view.snapshotId,path:log,text:'Controlled diagnostic inspection recorded. This log is permanent; no completion is inferred from Helper idle.\n',append:true})}
 if(!safetyB&&!process.argv.includes('--helper-active')){f.model.command(helper.sessionId,'idle');await until('Helper idle',()=>f.rt.native.get(helper.identity.workId)?.observe().state==='idle')}
 check('idle does not erase A claim',!!f.rt.roleRecords.get(helper.identity.workId).notificationClaims[aKeys[0]],true)
 check('idle does not erase B claim',!!f.rt.roleRecords.get(helper.identity.workId).notificationClaims[bKeys[0]],true)
 await completeTask(a,'Controlled independent A objective actually accepted via registered tool.')
 const recorder=await ready('Recorder',a.identity.taskId),archive=await command(recorder,'dss_claim')
 await command(recorder,'dss_recorder_save',{snapshotId:archive.snapshotId,outputs:[{path:archive.archiveRecordsPath,text:'# Task A result\nActual Planner acceptance and Recorder handoff.\n'}],retainedPaths:[]},true)
 await until('real A runtime retirement',()=>![...f.rt.roleRecords.values()].some(r=>r.identity.taskId===a.identity.taskId))
 await until('A-only claim retired',()=>!f.rt.roleRecords.get(helper.identity.workId)?.notificationClaims?.[aKeys[0]])
 const after=f.rt.roleRecords.get(helper.identity.workId),persisted=await f.row(helper)
 check('A-only claim absent on disk',persisted.notificationClaims?.[aKeys[0]],undefined)
 if(!mixed)check('B original claim bytes unchanged',JSON.stringify(after.notificationClaims[bKeys[0]]),JSON.stringify(before[bKeys[0]]))
 else {
  check('no stored mixed-claim copies of finished A',Object.values(persisted.notificationClaims??{}).some(c=>c.helperWakes?.some(w=>w.context?.target?.taskId===a.identity.taskId)),false)
  const pending=await f.active.connection.records.list(f.prefix+'wakes/')
  check('B remains in its original consumed WakeRecord',pending.some(r=>r.value.signalsConsumed&&wakeTask(r.value.request)===b.identity.taskId),true)
 }
 check('B still executing',f.rt.roleRecords.get(b.identity.workId)?.identity.executionId,b.identity.executionId)
 check('B context remains available',f.rt.helperResponsibilities(after).some(w=>wakeTask(w)===b.identity.taskId),true)
 for(const log of logs)check('long-term Debug retained '+log,(await read(log)).includes('inspection recorded'),true)
 if(safetyB){
  const view=await command(helper,'dss_snapshot'),fault=view.safetyFaults.find(x=>(x.taskId??x.identity?.taskId)===b.identity.taskId)
  check('unfinished B Safety responsibility available after A cleanup',!!fault,true)
  const bLog=view.helperNotifications.find(w=>wakeTask(w)===b.identity.taskId)?.context.helperDebugPath
  const pendingText='Actual unfinished B inspection, accepted before normal user participation withdrawal.\n'
  const beforeReport=trace.length,atPublication=Promise.withResolvers(),releasePublication=Promise.withResolvers()
  let publicationPaused=false,callSignal
  const files=f.rt.files,replace=files.replace.bind(files)
  files.replace=async function(p,text,...args){
   const result=await replace(p,text,...args)
   if(!publicationPaused&&p.startsWith('debug/.helper-publications/')&&p.endsWith('/publication.json')){
    const value=JSON.parse(text)
    if(value.reportSaved&&!value.signalSaved&&!value.complete){publicationPaused=true;atPublication.resolve({p,value});await releasePublication.promise}
   }
   return result
  }
  const stopObserving=f.sdk.ctx.on('tools/execute',(request,next)=>{if(request.name==='dss_record'&&request.arguments?.text===pendingText)callSignal=request.signal;return next()})
  const pendingCall='pending-original-B-report'
  f.model.command(helper.sessionId,{name:'dss_record',callId:pendingCall,input:{snapshotId:view.snapshotId,path:bLog,text:pendingText,append:true,notifyForeground:true,repairAttempt:{faultId:fault.id,actionsTaken:'Read the actual B model failure and surviving Task context after A cleanup.',outcome:'attempted-not-repaired',result:'B remains unresolved and awaits its original restoration.'}}})
  const accepted=await atPublication.promise
  mark('accepted-original-B-report-before-withdrawal',{accepted,helper,claims:f.rt.roleRecords.get(helper.identity.workId).notificationClaims,fault})
  check('actual native call owns interruptible report signal',!!callSignal,true)
  const oldFile=f.file(helper),withdrawal=f.service.participation({mode:'local',enabled:false})
  await until('actual user participation withdrawal aborts original native tool',()=>callSignal.aborted)
  releasePublication.resolve()
  await withdrawal
  files.replace=replace;stopObserving()
  check('original Helper stop actually confirmed',(await f.row(helper)).stopped,true)
  check('accepted report is incomplete after actual cancellation',JSON.parse(await read(accepted.p)).complete,undefined)
  check('original partial report body exists',(await read(bLog)).includes(pendingText),true)
  await f.service.participation({mode:'local',enabled:true});f.active=f.service.running.get('local');f.rt=f.active.runtime
  let replacement=await ready('Helper')
  check('normal startup actually replaces stopped Helper',replacement.identity.executionId!==helper.identity.executionId,true)
  const originalCommand=helper.sessionId+':'+pendingCall
  await until('original B attempt recovered through normal startup',async()=>(await f.active.connection.records.list(f.prefix+'wakes/')).some(r=>r.value.safetyAttempts?.some(a=>a.attemptId===originalCommand&&a.fault.id===fault.id)))
  await until('accepted original B publication retires',async()=>!await read(accepted.p))
  await until('old replaced Helper native log retires',()=>fs.access(oldFile).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e}))
  const afterRows=await f.active.connection.records.list(f.prefix+'wakes/')
  const originalB=afterRows.find(r=>r.value.safetyAttempts?.some(a=>a.attemptId===originalCommand))
  check('unfinished B original wake survives retired old Session',wakeTask(originalB.value.request),b.identity.taskId)
  check('original B attempt recorded once',originalB.value.safetyAttempts.filter(a=>a.attemptId===originalCommand).length,1)
  check('retired mixed A/B claim not recreated by startup',Object.hasOwn(f.rt.roleRecords.get(replacement.identity.workId).notificationClaims??{},aKeys[0]),false)
  const reportIndex=trace.findIndex(e=>e.event==='original-B-attempt-persisted'),replacementIndex=trace.findIndex(e=>e.event==='role-persisted'&&e.record.identity.role==='Helper'&&e.record.identity.executionId===replacement.identity.executionId)
  check('normal startup saves original B attempt before replacing its owning Helper',reportIndex>=0&&reportIndex<replacementIndex,true)
  if(expectRetired){
   const liveInput=f.rt.roleRecords.get(replacement.identity.workId),inputKey=f.prefix+'wakes/'+hash(liveInput.delivery.request.id),oldFile=f.file(liveInput)
   check('ended A current native input still exists while that Helper uses it',!!await f.active.connection.records.get(inputKey),true)
   check('B is genuinely unfinished before independent A input retirement',JSON.parse(await read('tasks/'+b.identity.taskId+'.json')).status,'running')
   const originalBBytes=JSON.stringify(await f.active.connection.records.get(originalB.key))
   await f.service.participation({mode:'local',enabled:false})
   await f.service.participation({mode:'local',enabled:true});f.active=f.service.running.get('local');f.rt=f.active.runtime
   replacement=await ready('Helper')
   await until('exact A input owner native log retired while B remains open',()=>fs.access(oldFile).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e}))
   await until('exact A input last-consumer cleanup drained',()=>!f.rt.roleRecords.get(replacement.identity.workId)?.nativeRetirements?.some(item=>item.sessionId===liveInput.sessionId))
   check('ended A exact input retires without awaiting B completion',await f.active.connection.records.get(inputKey),undefined)
   check('unfinished B original wake and report-attempt bytes are preserved',JSON.stringify(await f.active.connection.records.get(originalB.key)),originalBBytes)
   check('B remains genuinely running after independent A retirement',JSON.parse(await read('tasks/'+b.identity.taskId+'.json')).status,'running')
   mark('A-input-retired-while-B-open',{inputKey,oldFile,originalBKey:originalB.key,replacement})
  }
  const resumedB=await ready('Planner',b.identity.taskId),currentView=await command(replacement,'dss_snapshot')
  await command(replacement,'dss_record',{snapshotId:currentView.snapshotId,path:bLog,text:'Actual normal startup resumed the original B Task model stream; its original Task remains available.\n',append:true,repairAttempt:{faultId:fault.id,actionsTaken:'Observed actual B Planner model waiting after normal Service restart.',outcome:'repaired',result:'Original B Task continuation is active; business acceptance follows separately.'}})
  await completeTask(resumedB,'Actual independent B objective accepted after observed normal startup continuation.')
  const recB=await ready('Recorder',b.identity.taskId),archiveB=await command(recB,'dss_claim')
  await command(recB,'dss_recorder_save',{snapshotId:archiveB.snapshotId,outputs:[{path:archiveB.archiveRecordsPath,text:'# B result\nB really accepted and archived after normal native restart.\n'}],retainedPaths:[]},true)
  await until('B runtime really released',()=>![...f.rt.roleRecords.values()].some(r=>r.identity.taskId===b.identity.taskId))
  const captureA=async label=>{const all=await f.active.connection.records.list(f.prefix+'wakes/'),retained=all.filter(r=>wakeTask(r.value.request)===a.identity.taskId);mark('finished-A-ancestry-observation',{label,A:a.identity.taskId,B:b.identity.taskId,retained,helper:f.rt.roleRecords.get(replacement.identity.workId),originalBRemaining:all.filter(r=>wakeTask(r.value.request)===b.identity.taskId)});return retained}
  const atBEnd=await captureA('after-real-B-Recorder-Cleaner')
  if(!expectRetired)check('characterization: ended A continuation persists after B finishes',atBEnd.some(r=>r.value.request.id.startsWith('closed-continuation:')),true)
  for(const ordinal of [1,2]){
   const priorHelper=f.rt.roleRecords.get(replacement.identity.workId),priorNativeFile=f.file(priorHelper)
   await f.service.participation({mode:'local',enabled:false})
   await f.service.participation({mode:'local',enabled:true});f.active=f.service.running.get('local');f.rt=f.active.runtime
   await ready('Helper')
   await until('exact previous Helper native log retirement '+ordinal,()=>fs.access(priorNativeFile).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e}))
   await until('exact previous Helper retirement responsibility drains '+ordinal,()=>!f.rt.roleRecords.get(replacement.identity.workId)?.nativeRetirements?.some(item=>item.sessionId===priorHelper.sessionId))
   const subsequent=await captureA('after-normal-active-stop-rejoin-'+ordinal)
   check((expectRetired?'regression: last native consumer retires ended-A continuation ':'characterization: last native consumer leaves ended-A continuation ')+ordinal,subsequent.some(row=>row.value.request.id===atBEnd[0]?.value.request.id),!expectRetired)
   if(expectRetired)check('no extra ended-A diagnostic wake remains '+ordinal,subsequent.length,0)
  }
  mark('mixed-pending-report-result',{originalCommand,fault,originalB,helper,replacement,oldFile,accepted})
  await fs.writeFile(path.join(root,'finished-A-ancestry-characterization.json'),JSON.stringify({checks,trace,sdk:evidence(),limits:'Actual Local Service/SDK, real A/B Task lifecycle and original claim consumption. Controlled model source failure enters real SDK/Safety. A barrier only delays return from an already completed real report metadata write; ordinary user participation withdrawal aborts the real tool. No injected I/O failure or seeded completion, and no private retirement call. Linux only.'},null,2))
  console.log(JSON.stringify({status:expectRetired?'passed':'characterized-defect',checks:checks.length},null,2))

 }
 mark('task-end-claims-result',{mode:gitMode?'git-local-bare':'local',gitCost:f.gitEvents?{fetchHead:f.gitEvents.filter(e=>e.op==='fetchHead').length,push:f.gitEvents.filter(e=>e.op==='push').length}:undefined,a:a.identity,b:b.identity,aKeys,bKeys,before,after:after.notificationClaims,logs})
 await fs.writeFile(path.join(root,'task-end-claims-evidence.json'),JSON.stringify({checks,trace,limits:gitMode?'Linux actual Runtime/Host/SDK/Recorder/Cleaner and local bare Git object/CAS transport. No Service Git login, Dulwich, online Git or Windows. Model choices controlled; no I/O fault or seeded completion.':'Linux Local actual FrameworkService/SDK/Host/Recorder/Cleaner. Model choices controlled, no I/O fault or seeded completion. Mixed/cold coverage only when selected; Safety closure remains unfinished.'},null,2))
 console.log(JSON.stringify({status:'passed',checks:checks.length,checksDetail:checks,...evidence()},null,2))
}catch(error){console.error(error);await fs.writeFile(path.join(root,'task-end-claims-failure.json'),JSON.stringify({error:String(error),checks,trace},null,2));process.exitCode=1}
finally{await f?.close()}
