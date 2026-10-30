import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { gitTaskViews } from '../src/mode-router/git-view.js'
import { GitExecutionRecords, GitResultDocuments } from '../src/client/git-task-records.js'
import { en, zh } from '../src/client/locales.js'
import { actionPath, executionPath, planPath, taskPath } from '../src/experimental/private-git/protocol.js'
import { statusPath } from '../src/experimental/private-git/status.js'
import { textChanges } from '../src/experimental/private-git/journal.js'
import type { RoleBinding, GitRepository } from '../src/experimental/private-git/contracts.js'
import type { CoopService } from '../src/experimental/private-git/service.js'
import type { ServantView } from '../src/contracts/views.js'

function fixture() {
 const values = new Map<string, string>(), reads: string[] = [], lists: string[] = []
 const root=taskPath('task'), head='a'.repeat(40)
 const put=(p:string,v:unknown)=>values.set(p,JSON.stringify(v))
 const text=(p:string,v:string)=>textChanges(p,v).forEach(c=>values.set(c.path,c.content!))
 put(root+'/contract.json',{id:'task',title:'Goal',goalPath:root+'/goal',goalRevision:1,revision:1,status:'active',originatingParticipantId:'1'})
 put(root+'/plan.json',{revision:1,works:[{}]});text(root+'/goal','Goal')
 const action=(id:string,revision=1,instance='instance',role:RoleBinding['role']='worker',state='active')=>{
  const b:RoleBinding={participantId:'1',instanceId:instance,taskId:'task',role,actionId:id,executionId:'exec-'+id,sessionId:'session-'+id,generation:1,epoch:1,fence:'f',assignmentVersion:1,childId:role==='worker'?'child':undefined,childRevision:revision,outputPath:''}
  b.outputPath=executionPath(b)+'/outcome.json';put(actionPath(b),{id,binding:b,state,createdAt:id});return b
 }
 const old=action('old',1,'instance','worker','closed'),current=action('new',2),planner=action('planner',1,'instance','planner'),other=action('other',1,'other')
 const outcome=(b:RoleBinding,body:string)=>{put(b.outputPath,{binding:b,kind:'result',turn_signal:'complete',textPath:executionPath(b)+'/output/text',createdAt:'now'});text(executionPath(b)+'/output/text',body)}
 outcome(old,'accepted old report');outcome(current,'{"file":"/private/not-a-contract","sha256":"fiction"}');outcome(other,'other instance report')
 const child=(revision:number,result?:string)=>({id:'child',title:'Child',direction:'Do',acceptance:'Check',dependencies:[],revision,assignmentVersion:1,state:result?'accepted':'pending',result})
 const plan=(instance:string,c:unknown)=>put(planPath('task','1',instance),{revision:1,children:[c],writer:{...planner,instanceId:instance}})
 plan('instance',child(1,old.outputPath));plan('other',child(1,other.outputPath))
 const snapshot={head,files:new Map([...values].map(([p])=>[p,'hash']))}
 const repo={read:async(_s:unknown,p:string)=>{reads.push(p);return values.get(p)},list:async(_s:unknown,p:string)=>{lists.push(p)},snapshot:()=>{throw Error('No additional snapshot/fetch allowed')}} as unknown as GitRepository
 const service={displaySnapshot:()=>snapshot,repository:repo,view:async()=>({connection:{identity:{id:1},repository:{branch:'main'}},settings:{ownerRepo:'synthetic/repo',repositoryDirectory:'Coop'},instanceId:'instance',tasks:[{id:'task',title:'Goal',status:'active'}]}),cache:{put:async()=>assert.fail('Unexpected read error')}} as unknown as CoopService
 const base={assistant:{id:'assistant',workspace:{directory:'/owned'}}} as ServantView
 return {service,base,old,current,planner,other,put,plan,child,snapshot,reads,lists,values}
}
test('Git projection exposes real action lifecycle and exact accepted result, without invented artifacts or extra fetch',async()=>{
 const f=fixture();const [task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.remote!.executions!.length,4);assert.ok(![...f.values.keys()].some(p=>p.startsWith(executionPath(f.planner)+'/')));assert.ok(task.remote!.executions!.find(e=>e.executionId===f.planner.executionId)!.recordsUrl.endsWith('/Coop/'+actionPath(f.planner).slice('dss-coop/'.length)));assert.equal(task.remote!.executions!.find(e=>e.executionId===f.planner.executionId)!.state,'active')
 assert.equal(task.remote!.executions!.find(e=>e.executionId===f.old.executionId)!.state,'closed')
 assert.deepEqual(task.remote!.results!.map(r=>r.executionId),[f.old.executionId,f.other.executionId])
 assert.equal(task.reports[f.old.executionId].summary,'accepted old report');assert.deepEqual(task.executions,{})
 assert.ok(task.remote!.results![0].recordsUrl.includes('/tree/'+f.snapshot.head+'/Coop/'))
 assert.equal(task.remote!.results![0].path,executionPath(f.old)+'/output/text')
 assert.deepEqual(f.lists,[taskPath('task')+'/participants/',taskPath('task')+'/actions/'])
 assert.ok(!f.reads.includes(f.current.outputPath),'Wrong child revision must not be read as accepted')
 assert.ok(Object.values(task.reports).every(r=>!r.artifacts.length))
})
test('pending current revision excludes old result; accepted mismatching result never appears',async()=>{
 const f=fixture();f.plan('instance',f.child(2));let [task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.children['1/instance/child'].currentResultId,f.current.executionId)
 assert.ok(!task.remote!.results!.some(r=>r.childId==='1/instance/child'))
 f.plan('instance',f.child(2,f.old.outputPath));[task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.children['1/instance/child'].currentResultId,undefined)
 assert.ok(!task.remote!.results!.some(r=>r.childId==='1/instance/child'))
})
test('published binding is required; artifact-looking free text is only a result document',async()=>{
 const f=fixture();f.plan('instance',f.child(2,f.current.outputPath));let [task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.reports[f.current.executionId].summary,'{"file":"/private/not-a-contract","sha256":"fiction"}')
 assert.ok(!f.reads.some(p=>p.startsWith('/private')))
 f.put(f.current.outputPath,{binding:{...f.current,generation:99},turn_signal:'complete'});[task]=await gitTaskViews(f.service,f.base)
 assert.ok(!task.remote!.results!.some(r=>r.childId==='1/instance/child'))
})
test('Git rendered rows use safe document links, never Local stop/reconcile/artifact controls',async()=>{
 const f=fixture();const [task]=await gitTaskViews(f.service,f.base);const t=(key:keyof typeof en)=>en[key]
 const execution=renderToStaticMarkup(createElement(GitExecutionRecords,{remote:task.remote!,t}));const result=renderToStaticMarkup(createElement(GitResultDocuments,{remote:task.remote!,t}))
 assert.match(execution,/Execution record open/);assert.match(execution,/Execution record closed/);assert.match(result,/Accepted result document/)
 assert.ok(!execution.includes('<button'));assert.ok(!result.includes('<button'));assert.ok(!execution.includes('No execution is in flight'));assert.ok(!result.includes('No accepted artifacts yet'))
 assert.match(result,/rel="noreferrer"/)
 const archived={...task.remote!,archived:true,executions:[],results:[]};assert.equal(renderToStaticMarkup(createElement(GitExecutionRecords,{remote:archived,t})), '')
 assert.equal(renderToStaticMarkup(createElement(GitResultDocuments,{remote:archived,t})), '')
})

test('unpublished state-protocol outcome and wrong action path do not become accepted evidence',async()=>{
 const f=fixture();const raw=JSON.parse(f.values.get(actionPath(f.old))!);f.put(actionPath(f.old),{...raw,stateProtocol:1})
 const forged=actionPath(f.current)+'-wrong.json';f.put(forged,JSON.parse(f.values.get(actionPath(f.current))!));f.snapshot.files.set(forged,'hash')
 const [task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.remote!.executions!.length,4)
 assert.ok(!task.remote!.results!.some(r=>r.executionId===f.old.executionId))
})

test('stateProtocol1 accepts only the matching published completed outcome',async()=>{
 const f=fixture();const raw=JSON.parse(f.values.get(actionPath(f.old))!);f.put(actionPath(f.old),{...raw,stateProtocol:1})
 f.put(statusPath(f.old,'completed'),{version:1,kind:'completed',binding:f.old,createdAt:'now',turn_signal:'complete',outcomePath:f.old.outputPath})
 const [task]=await gitTaskViews(f.service,f.base)
 assert.ok(task.remote!.results!.some(r=>r.executionId===f.old.executionId))
 const t=(key:keyof typeof zh)=>zh[key]
 assert.match(renderToStaticMarkup(createElement(GitResultDocuments,{remote:task.remote!,t})),/已验收结果文档/)
 assert.match(renderToStaticMarkup(createElement(GitExecutionRecords,{remote:task.remote!,t})),/执行记录已关闭/)
})
test('archived task retains snapshot-pinned record reference without inventing active execution or empty artifact facts',async()=>{
 const f=fixture();f.values.delete(taskPath('task')+'/contract.json');f.snapshot.files.delete(taskPath('task')+'/contract.json')
 const [task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.remote!.archived,true);assert.deepEqual(task.remote!.executions,[]);assert.deepEqual(task.remote!.results,[])
 assert.ok(task.remote!.recordsUrl.endsWith('/Coop/records/task'));assert.ok(task.remote!.recordsUrl.includes('/tree/'+f.snapshot.head+'/'))
 assert.deepEqual(f.lists,[])
})

test('unpublished Planner projection is updating, not an empty-results claim; other participant remains visible',async()=>{
 const f=fixture()
 const raw=JSON.parse(f.values.get(actionPath(f.planner))!)
 f.put(actionPath(f.planner),{...raw,stateProtocol:1})
 f.put(statusPath(f.planner,'started'),{version:1,kind:'started',binding:f.planner,createdAt:'now'})
 const [task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.remote!.projectionUpdating,true)
 assert.equal(task.phase,'executing')
 assert.equal(task.children['1/instance/child'],undefined)
 assert.equal(task.children['1/other/child'].status,'accepted')
 assert.deepEqual(task.remote!.results!.map(r=>r.executionId),[f.other.executionId])
 for (const locale of [en,zh]) {
  const markup=renderToStaticMarkup(createElement(GitResultDocuments,{remote:task.remote!,t:(key:keyof typeof en)=>locale[key]}))
  assert.ok(markup.includes(locale['tasks.gitResultsUpdating']))
  assert.ok(!markup.includes(locale['tasks.noAcceptedResults']))
  assert.ok(markup.includes('1/other/child'))
 }
 assert.deepEqual(f.lists,[taskPath('task')+'/participants/',taskPath('task')+'/actions/'])
})

test('cold all-unpublished view is explicitly updating, then matching completion restores results without retained state',async()=>{
 const f=fixture();f.values.delete(planPath('task','1','other'));f.snapshot.files.delete(planPath('task','1','other'))
 const raw=JSON.parse(f.values.get(actionPath(f.planner))!);f.put(actionPath(f.planner),{...raw,stateProtocol:1})
 let [task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.remote!.projectionUpdating,true);assert.deepEqual(task.remote!.results,[])
 let html=renderToStaticMarkup(createElement(GitResultDocuments,{remote:task.remote!,t:(key:keyof typeof en)=>en[key]}))
 assert.match(html,/Results updating/);assert.ok(!html.includes('No accepted results yet'))
 f.put(statusPath(f.planner,'completed'),{version:1,kind:'completed',binding:f.planner,createdAt:'later',turn_signal:'done',outcomePath:f.planner.outputPath})
 ;[task]=await gitTaskViews(f.service,f.base)
 assert.equal(task.remote!.projectionUpdating,undefined);assert.equal(task.children['1/instance/child'].status,'accepted')
 assert.deepEqual(task.remote!.results!.map(r=>r.executionId),[f.old.executionId])
})

test('cancelled and archived projections do not acquire an updating state',async()=>{
 const f=fixture();const original=f.service.view.bind(f.service)
 f.service.view=async()=>({...await original(),tasks:[{id:'task',title:'Goal',status:'cancelled'}]}) as never
 const raw=JSON.parse(f.values.get(actionPath(f.planner))!);f.put(actionPath(f.planner),{...raw,stateProtocol:1})
 let [task]=await gitTaskViews(f.service,f.base);assert.equal(task.remote!.projectionUpdating,undefined);assert.equal(task.control,'cancelled')
 f.values.delete(taskPath('task')+'/contract.json');f.snapshot.files.delete(taskPath('task')+'/contract.json')
 ;[task]=await gitTaskViews(f.service,f.base);assert.equal(task.remote!.projectionUpdating,undefined);assert.equal(task.remote!.archived,true)
 const html=renderToStaticMarkup(createElement(GitResultDocuments,{remote:{...task.remote!,projectionUpdating:true},t:(key:keyof typeof en)=>en[key]}));assert.equal(html,'')
})

test('missing plan remains genuinely empty, never classified as an in-progress publication',async()=>{
 const f=fixture();for(const instance of ['instance','other']){f.values.delete(planPath('task','1',instance));f.snapshot.files.delete(planPath('task','1',instance))}
 const [task]=await gitTaskViews(f.service,f.base);assert.equal(task.remote!.projectionUpdating,undefined)
 const html=renderToStaticMarkup(createElement(GitResultDocuments,{remote:task.remote!,t:(key:keyof typeof en)=>en[key]}));assert.match(html,/No accepted results yet/)
})
