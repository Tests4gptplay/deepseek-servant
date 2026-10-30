import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoopSettingsSchema, type CoopSettings, type PendingDraft, type RepoConnection } from '../src/experimental/private-git/contracts.js'
import type { CoopStore } from '../src/experimental/private-git/cache.js'
import type { CoopCredentials } from '../src/experimental/private-git/credentials.js'
import { GitHubClient } from '../src/experimental/private-git/github.js'
import { GitHubRepository } from '../src/experimental/private-git/git-repository.js'
import { CoopService } from '../src/experimental/private-git/service.js'
import { CoopConsumer, type CoopAgentPort, type CoopPhysicalState } from '../src/experimental/private-git/consumer.js'
import { CoopSync } from '../src/experimental/private-git/sync.js'
import { runGit } from '../src/experimental/private-git/vendor/git-runner.js'
import { digest, readJson } from '../src/experimental/private-git/journal.js'
import { readOutcome } from '../src/experimental/private-git/outcome.js'
import { CoopReadSchema, readCoopRecord } from '../src/experimental/private-git/record-access.js'
import { planPath, taskPath, type CoopCommand, type ParticipantPlan, type RoleAction } from '../src/experimental/private-git/protocol.js'

class FixtureStore implements CoopStore {
 readonly instanceId='synthetic-cycle-instance'
 readonly values=new Map<string,unknown>()
 settings=CoopSettingsSchema.parse({ownerRepo:'synthetic/background-cycles',repositoryDirectory:'Coop',workerSeats:2,provider:'synthetic-dss-qa',model:'deterministic-no-network'})
 async configure(settings:CoopSettings){this.settings=settings}
 get<T>(key:string){return this.values.get(key) as T|undefined}
 async put(key:string,value:unknown){this.values.set(key,structuredClone(value))}
 async remove(key:string){this.values.delete(key)}
 entries<T>(prefix:string){return [...this.values].filter(([key])=>key.startsWith(prefix)) as Array<[string,T]>}
 connection(){return this.get<RepoConnection>('connection')}
 drafts(){return this.entries<PendingDraft>('draft/').map(([,v])=>v)}
 async close(){}
}
class SyntheticRoleQueue implements CoopAgentPort {
 starts:Array<{action:RoleAction,context:any}>=[]
 states=new Map<string,CoopPhysicalState>()
 taken=new Set<string>()
 async start(action:RoleAction,context:unknown){
  assert.equal(this.starts.some(item=>item.action.binding.executionId===action.binding.executionId),false)
  this.starts.push({action,context});this.states.set(action.binding.executionId,{busy:true,finished:false,transcript:'',jobs:[]})
 }
 state(id:string){return this.states.get(id)}
 finish(action:RoleAction){this.states.set(action.binding.executionId,{busy:false,finished:true,transcript:'Synthetic role completed actual fixture work',jobs:[]})}
 async release(id:string){this.states.delete(id)}
 async dispose(){this.states.clear()}
 async take(role:string,predicate:(action:RoleAction)=>boolean=()=>true){
  return until(()=>{const item=this.starts.find(item=>item.action.binding.role===role&&!this.taken.has(item.action.binding.executionId)&&predicate(item.action));if(item)this.taken.add(item.action.binding.executionId);return item},'new '+role)
 }
}
async function until<T>(read:()=>T|undefined|Promise<T|undefined>,description:string):Promise<T>{
 const deadline=Date.now()+90_000
 while(Date.now()<deadline){const value=await read();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,50))}
 throw new Error('Timed out waiting for '+description)
}
const review={reported:'Artifact produced',checked:'Read independent Git result and actual artifact bytes; checked SHA256',discrepancy:'None',decision:'Accepted',next:'Continue next bounded cycle'}

// Production GitHubRepository, GitJournal, RoleWriter, Consumer, Service and background CoopSync.
// Only external identity API and role reasoning are synthetic. Git is a real local bare remote.
// No manual consumer ticks, manufactured outcome files, external accounts or model calls.
test('Git background executes ten full multi-Worker cycles through real commit/fetch/readback', {timeout:900_000}, async t=>{
 const base=process.env.DSS_QA_EVIDENCE_DIR??tmpdir();await mkdir(base,{recursive:true})
 const root=await mkdtemp(join(base,'dss-git-ten-cycles-')),remote=join(root,'remote.git'),caches=join(root,'cache'),observer=join(root,'observer.git'),artifacts=join(root,'artifacts')
 if(!process.env.DSS_QA_EVIDENCE_DIR)t.after(()=>rm(root,{recursive:true,force:true}))
 for(const dir of [remote,observer,artifacts])await mkdir(dir,{recursive:true})
 const git=async(cwd:string,args:string[])=>(await runGit('git',args,{cwd})).stdout.trim()
 await git(remote,['init','--bare','--initial-branch=main','.']);await git(observer,['init','--bare','.'])
 const store=new FixtureStore();store.settings.workspace=artifacts
 const scope=store.settings.ownerRepo+'/'+store.settings.repositoryDirectory+'/'+store.instanceId
 const cache=join(caches,createHash('sha256').update(scope).digest('hex').slice(0,24));await mkdir(cache,{recursive:true})
 await git(cache,['init','--bare','.']);await git(cache,['remote','add','origin',remote])
 const tokens=async()=>({value:'synthetic-fixture-not-a-credential',source:'synthetic'})
 let identityRequests=0
 const client=new GitHubClient(tokens,async url=>{
  identityRequests++;const path=new URL(url).pathname
  if(path==='/user')return Response.json({id:1,login:'synthetic-fixture'})
  if(path==='/repos/synthetic/background-cycles')return Response.json({id:77,full_name:store.settings.ownerRepo,private:true,default_branch:'main',permissions:{pull:true,push:true,admin:true}})
  throw new Error('No external network is permitted in this fixture: '+path)
 })
 const repo=new GitHubRepository(client,()=>({ownerRepo:store.settings.ownerRepo,repositoryDirectory:store.settings.repositoryDirectory,instanceId:store.instanceId}),tokens,caches)
 const credentials={describe:async()=>({configured:true,writable:false}),resolve:tokens} as unknown as CoopCredentials
 const service=new CoopService(store,credentials,client)
 Object.defineProperty(service,'repository',{value:repo})
 const agents=new SyntheticRoleQueue();let sync:CoopSync
 const consumer=new CoopConsumer({repo,cache:store,journal:()=>service.getJournal(),agents,wake:()=>sync.request()})
 sync=new CoopSync(service,consumer);service.attach(consumer);service.setWake(sync.request,()=>sync.dispose())
 t.after(async()=>{sync.dispose();await service.dispose()})
 const logs:any[]=[];const taskId='task-ten-rounds'
 const command=async(action:RoleAction,operation:CoopCommand)=>{const receipt=await consumer.writer.execute(action.binding,operation);sync.request();return receipt}
 const entry=async(action:RoleAction,id:string,text:string)=>command(action,{op:'entry',id,kind:action.binding.role==='planner'?'memory':'reply',text})
 const final=async(action:RoleAction,id:string,signal:string,text:string)=>{
  const body=await entry(action,id+'-body',text)
  await command(action,{op:'outcome',id,turn_signal:signal as any,...(action.binding.role==='planner'?{memoryPath:body.textPath}:{replyPath:body.textPath}),prerequisitePaths:[]})
  agents.finish(action);sync.request()
 }
 const plan=async()=>{const snapshot=await repo.snapshot();return (await readJson<ParticipantPlan>(repo,snapshot,planPath(taskId,'1',store.instanceId)))??{revision:0,children:[]}}
 const acceptResult=async(planner:RoleAction,worker:RoleAction,accepted=true)=>{
  const outcome=await readOutcome(repo,await repo.snapshot(),worker.binding);assert.ok(outcome)
  const observed=await readCoopRecord(repo,store.settings,CoopReadSchema.parse({path:outcome.textPath}))
  const data=JSON.parse(observed.text!);const bytes=await readFile(join(artifacts,data.file),'utf8');assert.equal(digest(bytes),data.sha256)
  const current=await plan()
  await command(planner,{op:'review',id:'review-'+worker.binding.executionId,childId:worker.binding.childId!,expectedRevision:current.revision,resultExecutionId:worker.binding.executionId,accepted,
   review:{...review,decision:accepted?'Accepted':'Rework concrete synthetic blocker'},...(accepted?{}:{nextDirection:'Use authorized synthetic replacement and verify output bytes'})})
 }
 const workerReply=async(worker:RoleAction,round:number,blocked=false)=>{
  const file=worker.binding.childId+'.json';const bytes=JSON.stringify({round,child:worker.binding.childId,revision:worker.binding.childRevision,status:blocked?'blocked':'verified',payload:'actual isolated fixture bytes'})+'\n'
  await writeFile(join(artifacts,file),bytes)
  await final(worker,'result',blocked?'blocked':'complete',JSON.stringify({file,sha256:digest(bytes),status:blocked?'blocked':'complete'}))
 }
 await service.connect();sync.request()
 await service.send({id:'ten-rounds',text:'Execute ten complete rounds, each with two independently verified synthetic artifacts, then integrate and deliver.'})
 const foreground=(await agents.take('foreground')).action
 await command(foreground,{op:'root',id:'root',title:'Ten bounded background cycles',goal:'Ten multi-Worker cycles with real artifacts and review',initialPlan:'Two workers per cycle, review, then next cycle; preserve completed results'})
 const intro=await entry(foreground,'intro','Created bounded ten-cycle task')
 await command(foreground,{op:'outcome',id:'handoff',turn_signal:'handoff_planner',taskId,replyPath:intro.textPath,prerequisitePaths:[]});agents.finish(foreground);sync.request()
 let planner=(await agents.take('planner')).action
 await command(planner,{op:'root_plan',id:'work',expectedRevision:0,works:[{id:'cycles',title:'Ten cycles',direction:'Two artifacts per round',acceptance:'Actual artifacts, independent readback and review',participantId:'1',instanceId:store.instanceId,version:1}]})
 await command(planner,{op:'claim',id:'claim',workId:'cycles',assignmentVersion:1,scope:'The ten authorized synthetic rounds only'})
 for(let round=1;round<=10;round++){
  const before=await plan();const ids=['a','b'].map(suffix=>'round-'+round+'-'+suffix)
  await command(planner,{op:'participant_plan',id:'plan-round-'+round,expectedRevision:before.revision,children:[...before.children,...ids.map(id=>({id,workId:'cycles',assignmentVersion:1,title:id,direction:'Write and verify actual isolated '+id+' artifact',acceptance:'Exact bytes and SHA256 match',dependencies:[]}))]})
  await final(planner,'dispatch-round-'+round,'done','Dispatch two bounded Workers for round '+round)
  const workers=await Promise.all(ids.map(id=>agents.take('worker',action=>action.binding.childId===id).then(item=>item.action)))
  assert.equal(workers.length,2)
  if(round===7){
   await workerReply(workers[0],round)
   const early=(await agents.take('planner')).action
   await final(early,'wait-late','wait','Second Worker is still running; do not accept uninspected outputs')
   await workerReply(workers[1],round)
  }else await Promise.all(workers.map((worker,index)=>workerReply(worker,round,round===3&&index===0)))
  const received=await agents.take('planner');planner=received.action
  assert.equal(received.context.pendingWorkerResults.length,2,'both published current results are explicit in review context')
  if(round===3){
   const body=await entry(planner,'premature-memory','Attempting no-review done; expected recoverable diagnostic')
   await assert.rejects(command(planner,{op:'outcome',id:'premature',turn_signal:'done',memoryPath:body.textPath,prerequisitePaths:[]}),/Current Worker results/)
   assert.equal(await readOutcome(repo,await repo.snapshot(),planner.binding),undefined)
   await acceptResult(planner,workers[0],false);await acceptResult(planner,workers[1])
   await final(planner,'rework-round-3','rework','Blocked output reviewed; only its direction revised')
   const retried=(await agents.take('worker',action=>action.binding.childId===ids[0]&&action.binding.childRevision===2)).action
   await workerReply(retried,round);planner=(await agents.take('planner')).action;await acceptResult(planner,retried)
  }else for(const worker of workers)await acceptResult(planner,worker)
  const reviewed=await plan();assert.ok(ids.every(id=>reviewed.children.find(child=>child.id===id)?.state==='accepted'))
  const snapshot=await repo.snapshot();await git(observer,['fetch','--no-tags',remote,'+refs/heads/main:refs/remotes/qa/main'])
  assert.equal(await git(observer,['rev-parse','refs/remotes/qa/main']),snapshot.head)
  const stored=JSON.parse(await git(observer,['show','refs/remotes/qa/main:Coop/tasks/'+taskId+'/participants/1/instances/'+store.instanceId+'/plan.json']))
  assert.ok(ids.every(id=>stored.children.find((child:any)=>child.id===id)?.state==='accepted'))
  logs.push({round,head:snapshot.head,planRevision:reviewed.revision,acceptedChildren:reviewed.children.filter(child=>child.state==='accepted').length,workerExecutions:agents.starts.filter(item=>item.action.binding.role==='worker').length})
  console.log('GIT_BACKGROUND_ROUND '+JSON.stringify(logs.at(-1)))
  if(round===5)console.log('GIT_BACKGROUND_CHECKPOINT 5/10; not a full completion')
  if(round===6){
   await final(planner,'pause-boundary','wait','Six full rounds reviewed; pause and resume unchanged authorized goal')
   await service.send({id:'pause-at-six',text:'Pause this same ten-cycle task after six completed rounds.'})
   const pausing=(await agents.take('foreground',action=>action.binding.sourceIntentId==='pause-at-six')).action
   await command(pausing,{op:'control',id:'pause',taskId,expectedRevision:1,state:'pause'});await final(pausing,'paused','respond','Paused between complete rounds')
   await until(async()=>{const value=await readJson<any>(repo,await repo.snapshot(),taskPath(taskId)+'/participants/1/instances/'+store.instanceId+'/join.json');return value?.state==='paused'?true:undefined},'confirmed pause')
   await service.send({id:'resume-after-six',text:'Resume the unchanged authorized ten-cycle task.'})
   const resuming=(await agents.take('foreground',action=>action.binding.sourceIntentId==='resume-after-six')).action
   await command(resuming,{op:'control',id:'resume',taskId,expectedRevision:2,state:'resume'});await final(resuming,'resumed','respond','Resumed unchanged scope')
   planner=(await agents.take('planner')).action;assert.equal(planner.binding.epoch,3)
  }
 }
 await command(planner,{op:'report',id:'report',workId:'cycles',assignmentVersion:1,review,text:'Twenty actual artifacts verified across ten complete multi-Worker rounds'})
 await command(planner,{op:'accept',id:'accept',expectedRevision:1,review,text:'Ten complete cycles integrated; blocked/rework/late/pause-resume handled'})
 await final(planner,'complete','complete','All ten cycles accepted')
 const delivery=(await agents.take('foreground',action=>action.id.startsWith('delivery-'))).action
 await final(delivery,'delivered','respond','Ten full cycles completed; twenty verified artifacts delivered.')
 await until(async()=>{const s=await repo.snapshot();const record=await repo.read(s,'dss-coop/records/'+taskId+'/manifest.json');const active=await repo.read(s,taskPath(taskId)+'/contract.json');return record&&!active?s.head:undefined},'final archive and cleanup')
 const finalHead=await git(remote,['rev-parse','main']),commits=Number(await git(remote,['rev-list','--count','main']))
 assert.equal(logs.length,10);assert.equal(logs.at(-1).acceptedChildren,20)
 assert.equal(agents.starts.filter(item=>item.action.binding.role==='worker').length,21)
 const result={version:'0.3.6-uiqa.20261029.5',mode:'real Git adapter + local bare remote + production background sync + synthetic roles',rounds:logs,finalHead,commits,identityRequests,workerExecutions:21,externalNetworkCalls:0,
  scenarios:['two concurrent Workers each round','blocked/recoverable completion diagnosis/review/rework in round 3','five-round checkpoint only','pause/resume after round 6','late Worker result in round 7','root acceptance/user delivery/archive after round 10'],artifacts:20}
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n')
 console.log('GIT_BACKGROUND_COMPLETE '+JSON.stringify({rounds:10,artifacts:20,workerExecutions:21,commits,finalHead,evidenceRoot:root}))
})
