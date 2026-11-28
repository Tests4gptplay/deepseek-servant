import {fixture,check,checks,results,deferred,until,root,dir,evidence,fs,path,withSnapshot} from './candidate-fixture.mjs'
const {dispatchPlannerObjective,paths,readJson,encodeJson}=await import('../../src/framework/task-files.ts')
async function child(f,parent,id,route='P'){
 await f.publish(await withSnapshot(f.g.files,async s=>dispatchPlannerObjective(f.g.files,s,await readJson(f.g.files,s,paths.task(parent.taskId)),id,'A','Cold child '+id,[],route)))
 const current=await withSnapshot(f.g.files,s=>readJson(f.g.files,s,paths.task(parent.taskId)))
 return withSnapshot(f.g.files,s=>readJson(f.g.files,s,paths.task(current.children.find(c=>c.objectiveId===id).taskId)))
}
try {
 const f=await fixture('parent-cold-startup');let rt,release
 try {
  const top=await f.task('O'),mid=await child(f,top,'mid','O'),leaf=await child(f,mid,'leaf'),outside=await f.task()
  const original=await f.wake(leaf),originalOther=await f.wake(outside)
  rt=new f.rt.constructor(f.rt.ctx,f.g.files,f.records,f.config,f.rt.environment)
  rt.admissionNow=()=>f.clock;rt.startOwnedPump=()=>{} // native startup scheduling explicit port
  f.service.running.get('git').runtime=rt
  await rt.startup();while(rt.maintenance?.size)await Promise.all([...rt.maintenance.values()])
  check('actual Git startup retains original full batch before Host Task lanes',rt.taskMetadataIndex.observed(mid.taskId)?.taskId,mid.taskId)
  check('cold Task relation does not depend on a hand-populated Host lane',rt.loop.observedTask(leaf.taskId),undefined)
  await rt.observeWakeAdmissions(f.g.files.readRound('host-poll'));while(rt.maintenance?.size)await Promise.all([...rt.maintenance.values()])
  const rows=await rt.admissionWakes()
  const selected=t=>(rows.find(x=>!x.value.delivered&&x.value.request.taskId===t.taskId&&x.value.recovery)??rows.find(x=>!x.value.delivered&&x.value.request.taskId===t.taskId)).value.request
  const w=selected(leaf),other=selected(outside)
  check('startup selected a genuinely pending wake for this Task',rows.some(row=>!row.value.delivered&&row.value.request.id===w.id&&row.value.request.taskId===leaf.taskId),true)
  const state=rt.localWakeAdmissions.get(f.key(w)),otherState=rt.localWakeAdmissions.get(f.key(other))
  check('actual cold pending starts from observed current qualification',state.eligibleSince,100000)
  check('pending retains only its already-read startup ancestry',state.taskFacts.size,3)
  const held=rt.controls.taskHeld.bind(rt.controls);release=deferred();let arrived=false
  rt.controls.taskHeld=async(...args)=>{const value=await held(...args);if(args[0]===leaf.taskId&&!arrived){arrived=true;await release.promise}return value}
  await rt.observeWakeAdmissions(f.g.files.readRound('host-poll'));await until(()=>arrived,'cold original leaf controls')
  await f.userControl('cold-parent-pause',top,'paused')
  check('same Host pause reaches cold descendant without new ancestor GET',state.eligibleSince,undefined)
  check('cold unrelated pending preserves original interval',otherState.eligibleSince,100000)
  release.resolve();while(rt.maintenance?.size)await Promise.all([...rt.maintenance.values()])
  check('late cold read cannot erase local pause',state.held,true)
  await rt.deleteRuntimeRecord(f.key(w),await f.records.get(f.key(w)))
  check('original exact wake retirement releases its startup ancestry',rt.localWakeAdmissions.has(f.key(w)),false)
  results.push({errors:f.errors,boundary:'Original Git startup branch and pending retirement; native startup pump controlled, original Git/Task methods real.'})
 } finally {release?.resolve();if(rt){rt.closed=true;while(rt.maintenance?.size)await Promise.all([...rt.maintenance.values()])}await f.close()}
} finally {await fs.writeFile(path.join(dir,'parent-cold-startup-results.json'),JSON.stringify({checks,results,evidence:evidence(),root},null,2));console.error('COLD PARENT CHECKS: '+checks.length)}
