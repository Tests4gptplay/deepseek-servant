// Actual KnowledgePanel actions -> Service -> Knowledge -> Transactions ->
// GitFiles -> RemoteGitRepository -> real Git CLI objects/update-ref CAS.
// UI display/lifecycle and authenticated object transport are explicit ports.
// No forced UNKNOWN, transport failure, deletion, corruption or rollback.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, webcrypto } from 'node:crypto'
import ts from 'typescript'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
process.env.DSS_AUDIT_SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const { gitFixture } = await import('./test-support/helper-consume-git-fixture.mjs')
const { FrameworkService } = await import(new URL('framework/service.ts', sourceRoot))
const { FrameworkTransactions } = await import(new URL('framework/command-transactions.ts', sourceRoot))
const { withSnapshot, withOperationChannel } = await import(new URL('framework/transactions.ts', sourceRoot))
const { installFrameworkRoleTools } = await import(new URL('framework/role-tools.ts', sourceRoot))
const { initializeTask, paths, readJson } = await import(new URL('framework/task-files.ts', sourceRoot))
const sha = value => createHash('sha256').update(value).digest('hex')
const target = 'skills/example/SKILL.md', index = 'technical/skills/candidates.json', controls = 'technical/skills/controls.json'
const native = '---\nname: example\ndescription: Actual editable skill\n---\nAlpha original\nKeep middle\nBeta original\n'
const proposed = native.replace('Alpha original', 'Alpha user')
const retainedPath='skills/example/candidates/retained.md',retainedBody='Existing retained candidate body\n',catalog='technical/skills/catalog.json'
const receipt = path => path.includes('/command-receipts/')
const root = await mkdtemp(join(tmpdir(), 'dss-knowledge-edit-')), handles = [], checks = [], traces = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const store = () => { const rows = new Map(); return { rows, get: async k => structuredClone(rows.get(k)), set: async (k,v) => rows.set(k, structuredClone(v)), delete: async k => rows.delete(k), list: async (p='') => [...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value)})) } }
async function handle(name, reopen) {
  const f = gitFixture(reopen ?? join(root, name+'.git'), 'sha1', async()=>{}, !!reopen)
  f.directory = reopen ?? join(root, name+'.git'); f.records = store(); f.tx = new FrameworkTransactions(f.files, f.records, 'knowledge-edit'); f.reads=[];f.commits=[];f.options=[]
  const run=f.tx.run.bind(f.tx); f.tx.run=(id,input,options,build)=>{f.options.push({id,options});return run(id,input,options,build)}
  const commit=f.repo.commitPrepared.bind(f.repo);f.repo.commitPrepared=async(...args)=>{f.commits.push({paths:args[1].map(c=>c.path),operationId:args[3].id});return commit(...args)}
  for(const key of ['read','readBytes']){const read=f.repo[key].bind(f.repo);f.repo[key]=async(s,p)=>{f.reads.push(p);return read(s,p)}}
  f.publish=changes=>withOperationChannel(f.files,'write',()=>withSnapshot(f.files,s=>f.files.commit(s,changes,'Fixture ordinary original publication')))
  f.read=path=>f.git(['show','refs/heads/main:dss-coop/'+path]).toString()
  f.names=()=>f.git(['ls-tree','-r','--name-only','refs/heads/main']).toString().trim().split('\n').filter(Boolean)
  f.candidates=()=>JSON.parse(f.read(index)).entries
  f.access={connection:{files:f.files,transactions:f.tx,scope:'knowledge-edit'}}
  f.notices=0
  f.service=Object.assign(Object.create(FrameworkService.prototype),{closed:false,access:async()=>f.access,running:new Map(),localUpgrades:new Map(),changed(){f.notices++}})
  if(!reopen)await f.publish([{path:target,content:native},{path:catalog,content:JSON.stringify({version:1,entries:[{path:target,hash:sha(native)}]})+'\n'},{path:retainedPath,content:retainedBody},{path:index,content:JSON.stringify({version:1,entries:[{sourcePath:target,path:retainedPath,hash:sha(retainedBody),createdAt:'2026-11-01T00:00:00Z'}]})+'\n'}])
  f.commits.length=0;f.reads.length=0;handles.push(f);return f
}
async function close(f){await f.tx.closeGitSession(new Error('Fixture session closes'));f.files.operations.close();await f.repo.releaseCache()}
let toolSequence=0
function roleTools(f,task,role){
  const tools=new Map(),agent={id:role+'-'+ ++toolSequence,session:{}},ctx={on:()=>()=>{},effect(){},systemPrompt:{section(){}},tools:{register:tool=>tools.set(tool.name,tool)}}
  installFrameworkRoleTools(ctx,agent,{role,owner:task.owner,taskId:task.taskId,lifecycleId:task.lifecycleId,...(role==='Planner'?{member:task.owner}:{}),workId:'work-'+toolSequence,executionId:'execution-'+toolSequence},
    {files:f.files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:error=>{throw error},transact:(...args)=>f.tx.run(...args)})
  return {call:(name,input)=>tools.get(name).execute(input,{agent,callId:'tool-'+ ++toolSequence,signal:new AbortController().signal,concludeTurn(){}})}
}
async function reviseThroughRecorder(f,path,text,expected){
  const id='10000000-0000-4000-8000-000000000001',source='tasks/refine-exact-skill-file_P.md'
  // Actual task completion and Recorder full-read/save, never a synthetic write.
  await f.publish([{path:source,content:'Refine this exact skill file from verified work: '+path+'\n'}])
  const initialized=await withSnapshot(f.files,s=>initializeTask(f.files,s,source,'A',['A'],id));await f.publish(initialized.changes)
  let task=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(id)))
  const planner=roleTools(f,task,'Planner'),view=await planner.call('dss_snapshot',{})
  await planner.call('dss_complete',{snapshotId:view.snapshotId,acceptance:'Fixture exact-file refinement accepted.',resultPaths:[]})
  task=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(id)));check('Recorder follows actual Task completion: '+f.directory,task.status,'complete')
  const recorder=roleTools(f,task,'Recorder'),opened=await recorder.call('dss_snapshot',{})
  const base=await recorder.call('dss_read',{snapshotId:opened.snapshotId,path})
  check('Recorder receives full actual target base: '+path,base.text,expected)
  const result=await recorder.call('dss_recorder_save',{snapshotId:opened.snapshotId,outputs:[{path:paths.archive(task)+'/records.md',text:'Verified exact-file refinement saved.'},{path,text,baseReadId:base.baseReadId}],retainedPaths:[]})
  check('registered Recorder publishes exact file: '+path,result.saved,true)
  check('Recorder proposal reaches exact file: '+path,f.read(path),text)
  return {taskId:id,readBase:base.baseReadId,result}
}
const client=readFileSync(new URL('framework/client-page.tsx',sourceRoot),'utf8')
const ast=ts.createSourceFile('client-page.tsx',client,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const panel=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='KnowledgePanel')
const selectedStatements=['run','submit','save','changeStatus'].map(name=>{
  const statements=panel.body.statements.filter(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text===name))
  assert.equal(statements.length,1);return {name,text:statements[0].getText(ast),line:ast.getLineAndCharacterOfPosition(statements[0].getStart(ast)).line+1}
})
const code=ts.transpileModule(selectedStatements.map(x=>x.text).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
async function page(f,status='disabled'){
  let current=f,done
  const state={selected:await f.service.knowledgeRead({mode:'git',storageScope:'knowledge-edit',path:target}),edit:{body:proposed},errors:[],notices:[],requests:[],results:[],refreshes:[],operations:new Map(),editAttempt:{},statusAttempt:{},reading:{current:0},active:{current:true}}
  const api={knowledgeEdit:async input=>{state.requests.push(structuredClone(input));const result=await current.service.knowledgeEdit(input);state.results.push(result);return result},knowledgeStatus:input=>current.service.knowledgeStatus(input),knowledgeRead:input=>current.service.knowledgeRead(input)}
  state.reconnect=f=>{current=f}
  state.invoke=async name=>{
    // Recreate the actual event closure after state updates, as React rerenders.
    const deps={...state,api,scope:{mode:'git',storageScope:'knowledge-edit'},status,reason:'User selected status',crypto:webcrypto,
      setBusy:value=>{if(!value)done?.()},setError:value=>{if(value)state.errors.push(value)},setNotice:value=>{if(value)state.notices.push(value)},setStatus(){},setSelected:v=>state.selected=v,setEdit:v=>state.edit=v,redraw(){},
      refresh:()=>{const task=current.service.knowledgeList({mode:'git',storageScope:'knowledge-edit'});state.refreshes.push(task);return task},frameworkErrorText:String,tr:(_cn,en)=>en}
    const methods=new Function(...Object.keys(deps),code+'\nreturn {save,changeStatus,submit}')(...Object.values(deps))
    await new Promise(resolve=>{done=resolve;methods[name]()});await Promise.allSettled(state.refreshes.splice(0))
  }
  return state
}
try {
  for(const status of ['disabled','retired']){
    const f=await handle(status),ui=await page(f,status),initialRevision=ui.selected.revision,indexBefore=f.read(index)
    await ui.invoke('save')
    const original=structuredClone(ui.requests[0])
    check(status+': normal UI save has no error',ui.errors,[])
    check(status+': direct SKILL.md publication',f.read(target),proposed)
    check(status+': UI freezes actual full read',original.baseBody,native)
    check(status+': shared catalog matches final definition',JSON.parse(f.read(catalog)).entries.find(r=>r.path===target).hash,sha(proposed))
    check(status+': body and catalog share one actual commit',f.commits[0].paths.sort(),['dss-coop/'+target,'dss-coop/'+catalog].sort())
    check(status+': existing candidate index retained',f.read(index),indexBefore)
    check(status+': existing candidate bytes retained',f.read(retainedPath),retainedBody)
    check(status+': UI reports direct saved definition',ui.notices.at(-1),'Skill definition saved; existing disabled or retired status is unchanged.')
    check(status+': editor advances actual current baseline',ui.selected.text,proposed)
    check(status+': editor revision advances after save',ui.selected.revision!==initialRevision,true)
    const published=f.commits.length
    const repeat=await f.service.knowledgeEdit(original)
    check(status+': exact original repeat observes existing result',{saved:repeat.saved,replay:repeat.replay,observationOnly:repeat.observationOnly},{saved:true,replay:false,observationOnly:true})
    check(status+': original repeat creates no commit',f.commits.length,published)
    await ui.invoke('save')
    check(status+': subsequent UI action uses current body baseline',ui.requests[1].baseBody,proposed)
    check(status+': unchanged explicit save creates no commit',f.commits.length,published)
    await ui.invoke('changeStatus')
    const statusBytes=f.read(controls),before=f.commits.length
    check(status+': actual status control saved',JSON.parse(statusBytes).entries[target].status,status)
    await ui.invoke('save')
    check(status+': status then unchanged body remains valid',ui.errors,[])
    check(status+': no-op edit does not rewrite controls',f.read(controls),statusBytes)
    check(status+': status then unchanged edit adds no commit',f.commits.length,before)
    ui.edit.body=proposed+'New direct edit after status\n';await ui.invoke('save')
    check(status+': explicit edit succeeds while disabled/retired',ui.errors,[])
    check(status+': actual new definition saved',f.read(target),ui.edit.body)
    check(status+': editing does not enable disabled/retired skill',f.read(controls),statusBytes)
    check(status+': no new candidate',f.candidates().length,1)
    check(status+': no replacement local ledger',f.records.rows.size,0)
    check(status+': edit/status avoid receipts',f.commits.some(c=>c.paths.some(receipt)),false)
    traces.push({case:status,firstInput:original,commits:f.commits,reads:f.reads,errors:ui.errors,notices:ui.notices})
  }
  {
    const first=await handle('reconnect'),ui=await page(first);await ui.invoke('save')
    const original=structuredClone(ui.requests[0]),before=first.read(index),directory=first.directory
    await close(first);const fresh=await handle('fresh',directory);ui.reconnect(fresh)
    const repeated=await fresh.service.knowledgeEdit(original);await ui.invoke('save')
    check('backend reconnect observes exact original result',repeated.observationOnly,true)
    check('backend reconnect does not assert historical replay',repeated.replay,false)
    check('backend reconnect current UI freezes advanced baseline',ui.requests.at(-1).baseBody,proposed)
    check('backend reconnect adds no business commit',fresh.commits.length,0)
    check('backend reconnect retains old candidate index',fresh.read(index),before)
    check('backend reconnect does not create error',ui.errors,[])
  }
  {
    const f=await handle('reopened-status'),first=await page(f);await first.invoke('save')
    const reopened=await page(f),before=f.commits.length;await reopened.invoke('save')
    check('reopened explicit unchanged body adds no commit',f.commits.length,before)
    check('reopened explicit save has different command',reopened.requests[0].commandId!==first.requests[0].commandId,true)
    await reopened.invoke('changeStatus');const statusBytes=f.read(controls),count=f.commits.length
    await reopened.invoke('save')
    check('reopened repeat succeeds after normal status change',reopened.errors,[])
    check('reopened repeat keeps controls intact',f.read(controls),statusBytes)
    check('reopened unchanged save adds no commit',f.commits.length,count)
  }
  {
    // Historical candidate resources remain ordinary retained files. No current
    // user save creates them or silently restores older candidate content.
    const f=await handle('retained-resource'),ui=await page(f);await ui.invoke('save')
    const indexBefore=f.read(index),revised=retainedBody+'Recorder verified refinement.\n'
    const publication=await reviseThroughRecorder(f,retainedPath,revised,retainedBody)
    check('Recorder retained resource leaves candidate index untouched',f.read(index),indexBefore)
    check('Recorder retained resource leaves active skill untouched',f.read(target),proposed)
    const before=f.commits.length;await ui.invoke('save')
    check('user repeat never overwrites refined historical candidate',f.read(retainedPath),revised)
    check('user repeat after resource refinement adds no commit',f.commits.length,before)
    traces.push({case:'retained-resource',publication,currentBody:f.read(retainedPath)})
  }
  {
    const f=await handle('recorder-direct-conflict'),first=await page(f);await first.invoke('save')
    const stale=await page(f);stale.edit.body=proposed.replace('Alpha user','Alpha newer user')
    const revised=proposed.replace('Alpha user','Alpha recorder')
    const publication=await reviseThroughRecorder(f,target,revised,proposed),before=f.commits.length
    await stale.invoke('save')
    const request=stale.requests[0],result=stale.results.at(-1)
    check('actual overlapping Recorder edit is not overwritten',f.read(target),revised)
    check('real overlap adds no new commit',f.commits.length,before)
    check('real overlap reports saved false',result.saved,false)
    check('UI receives exact current conflicting body',result.conflicts[0].current,revised)
    check('UI retains exact original conflicting draft',stale.operations.get(request.commandId).input.body,request.body)
    check('conflict does not append candidate',f.candidates().length,1)
    const resolved=await page(f);resolved.edit.body=revised+'User reconciled contribution\n';await resolved.invoke('save')
    check('explicit reread/reconciled edit succeeds',resolved.errors,[])
    check('reconciled definition includes Recorder and user',f.read(target),resolved.edit.body)
    traces.push({case:'recorder-direct-conflict',publication,originalRequest:request,conflict:result})
  }
  {
    const old=await handle('old-receipt'),ui=await page(old),run=old.tx.run
    // Keep the prior transaction-contract assertion with an actual atomic
    // historical receipt; no forged receipt bytes or transport failure.
    old.tx.run=(id,input,options,build)=>run(id,input,{...options,gitReplay:undefined},build)
    await ui.invoke('save');old.tx.run=run
    const request=ui.requests[0],oldPath=old.names().find(receipt),oldBytes=old.git(['show','refs/heads/main:'+oldPath])
    await close(old);const fresh=await handle('old-receipt-reopen',old.directory)
    await fresh.service.knowledgeEdit(request)
    check('historical receipt bytes are not deleted/replaced',fresh.git(['show','refs/heads/main:'+oldPath]),oldBytes)
    check('historical receipt causes no additional publication',fresh.commits.length,0)
    check('current direct result does not read old receipt',fresh.reads.some(receipt),false)
  }
  {
    const a=await handle('concurrent'),b=await handle('peer',a.directory)
    const first=await page(a),second=await page(b);second.edit.body=native.replace('Beta original','Beta independent user')
    await Promise.all([first.invoke('save'),second.invoke('save')])
    check('two ordinary non-overlapping UI saves both succeed',[first.errors,second.errors],[[],[]])
    const combined=proposed.replace('Beta original','Beta independent user')
    check('real same-file Git merge preserves both user contributions',a.read(target),combined)
    check('shared catalog matches the merged definition',JSON.parse(a.read(catalog)).entries.find(r=>r.path===target).hash,sha(combined))
    check('concurrent direct saves retain only historical candidate',a.candidates().length,1)
    check('real CAS contention adds no receipt',a.names().some(receipt),false)
    traces.push({case:'concurrent',commits:[...a.commits,...b.commits],events:[...a.events,...b.events]})
  }
  console.log(JSON.stringify({status:'passed',assertions:checks.length,checks,traces,ui:{sourceSHA256:sha(client),statements:selectedStatements.map(({name,text,line})=>({name,line,sha256:sha(text)}))},...evidence(),limits:[
    'Actual current KnowledgePanel run/submit/save/changeStatus statements, not a mounted React page. Display/state updates and API carrier are explicit ports; handlers recreate closures after setters.',
    'Actual Service knowledgeRead/Edit/Status/List, withAccessOperation/checkScope/foreground/knowledge; acquisition and native skill refresh endpoints controlled.',
    'Actual RemoteGitRepository with real local Git CLI object/CAS. Credentials/transport are fixture ports; no GitHub, Dulwich wire, Windows/full Host claim.',
    'No UNKNOWN/failure/corruption injection. Reconnect uses new session objects against same real bare repository. Existing receipt is created by normal atomic transaction.',
    'Historical candidate refinement and formal skill overlap use actual Task initialization/completion and registered Recorder read/save. Current user edits never create candidates.'
  ]},null,2))
} finally { for(const f of handles)await close(f);await rm(root,{recursive:true,force:true});hooks.deregister() }
