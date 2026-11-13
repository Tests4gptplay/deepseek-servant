import {fixture,check,checks,results,trace,deferred,until,root,dir,evidence,fs,path,withSnapshot} from './candidate-fixture.mjs'
const {dispatchPlannerObjective,paths,readJson}=await import('../../src/framework/task-files.ts')
async function poll(f){const r=f.g.files.readRound('host-poll');f.rt.loop.actions.readRoundStarted(r);return f.rt.loop.remotePoll(r,performance.now())}
try {
 const f=await fixture('new-child-view');let release,flight
 try {
  f.rt.loop.actions.observe=async()=>{};f.rt.loop.actions.admitDiscovered=async()=>{}
  const parent=await f.task('O'),outside=await f.task('O');flight=await poll(f);await Promise.all(await flight.promise)
  check('original Host parent parsed before new child existed',f.rt.loop.observedTask(parent.taskId).children,undefined)
  await f.publish(await withSnapshot(f.g.files,s=>dispatchPlannerObjective(f.g.files,s,parent,'new','A','Actual newly dispatched child')))
  const changed=await withSnapshot(f.g.files,s=>readJson(f.g.files,s,paths.task(parent.taskId)))
  const child=await withSnapshot(f.g.files,s=>readJson(f.g.files,s,paths.task(changed.children[0].taskId)))
  const index=f.rt.loop.taskLanes.get(paths.task(parent.taskId)).metadata,list=index.list.bind(index)
  index.list=(...args)=>trace.run('actual-parent-index',()=>list(...args))
  const read=f.g.files.readBytes.bind(f.g.files);release=deferred();let arrived=false
  f.g.files.readBytes=async(s,p,...rest)=>{if(p===paths.task(parent.taskId)&&trace.getStore()==='actual-parent-index'&&!arrived){arrived=true;await release.promise}return read(s,p,...rest)}
  flight=await poll(f);await flight.promise;await until(()=>arrived,'original updated parent Task lane')
  await until(()=>f.rt.loop.observedTask(child.taskId),'new child original Host lane')
  await f.rt.loop.taskLanes.get(paths.task(child.taskId)).owned
  await f.observe();await f.drainMaintenance()
  const rows=await f.rt.admissionWakes(),actual=rows.find(x=>!x.value.delivered&&x.value.request.taskId===child.taskId).value.request
  const state=f.rt.localWakeAdmissions.get(f.key(actual))
  check('new child original eligibility is established while parent reread waits',state.eligibleSince,100000)
  await f.userControl('unrelated-pause',outside,'paused')
  check(process.env.EXPECT_FIXED==='1'?'old Host parent view cannot erase the actual bound new-child relation':'REPRO: old Host parent view loses new-child relation and unrelated pause clears timing',state.eligibleSince,process.env.EXPECT_FIXED==='1'?100000:undefined)
  results.push({errors:f.errors,boundary:'Real dispatch append, original Host per-Task reread held; child binding and Service control remain real.'})
 } finally {release?.resolve();if(flight)await Promise.all(await flight.promise);await f.close()}
} finally {await fs.writeFile(path.join(dir,'parent-new-child-results.json'),JSON.stringify({checks,results,evidence:evidence(),root},null,2));console.error('NEW CHILD VIEW CHECKS: '+checks.length)}
