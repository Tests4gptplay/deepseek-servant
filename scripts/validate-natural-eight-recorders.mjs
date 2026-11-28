// Current requirement: explicit user edits write native SKILL.md; no new
// candidate. Actual service, merge, physical operations, Git object/CAS and
// installed native SkillRegistry are used. UI actions execute their actual AST
// source with display/state ports. Git transport uses a local bare repository.
// No forced failure/UNKNOWN/corruption, no model turn, no Windows claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID,webcrypto} from 'node:crypto'
import {sourceRoot,evidence,hash} from './test-support/dsh-sdk-runtime.mjs'
const ts=await import('typescript')
const {Context}=await import('@deepseek-ai/cordis')
const {SkillRegistry}=await import('@deepseek-ai/dsh-skill')
const {createScope}=await import('@deepseek-ai/dsh-scope')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {FrameworkService}=await import('../src/framework/service.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {installFrameworkSkillProvider,refreshPhysicalFrameworkSkillIndex,prepareFrameworkSkillIndex}=await import('../src/framework/skills.ts')
const {FrameworkSkillCacheRefresh}=await import('../src/framework/skill-cache-refresh.ts')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {initializeTask,paths,readJson}=await import('../src/framework/task-files.ts')
process.env.DSS_AUDIT_SOURCE_ROOT=fileURLToPath(new URL('../',import.meta.url))
const {gitFixture}=await import('./test-support/helper-consume-git-fixture.mjs')
const scratch=await fs.mkdtemp(join(tmpdir(),'dss-direct-save-')),checks=[],fixtures=[],peerHandles=[],timing=[]
const check=(name,a,b)=>{assert.deepEqual(a,b,name);checks.push(name)}
const target='skills/example/SKILL.md',catalog='technical/skills/catalog.json',controls='technical/skills/controls.json',candidate='skills/example/candidates/retained.md',candidateIndex='technical/skills/candidates.json'
const initial='---\nname: example\ndescription: Original description\n---\n# Method\n## A\nalpha before\n## B\nbeta before\n## C\ngamma before\n'
const store=()=>{const rows=new Map();return {get:async k=>structuredClone(rows.get(k)),set:async(k,v)=>rows.set(k,structuredClone(v)),delete:async k=>rows.delete(k),list:async(p='')=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value)}))}}
const read=(f,p)=>withSnapshot(f.files,s=>f.files.read(s,p))
const waitTurn=()=>new Promise(resolve=>setImmediate(resolve))
async function fixture(mode,name){
 const remote=mode==='git'?gitFixture(join(scratch,name+'.git'),'sha1'):undefined
 const files=remote?.files??new PhysicalLocalFiles(join(scratch,name)),records=store(),tx=new FrameworkTransactions(files,records),providers=[],scopes=[],maintenance=[],errors=[],events=[]
 const ctx=new Context();new SkillRegistry(ctx)
 const f={mode,name,files,remote,tx,ctx,providers,scopes,maintenance,errors,events}
 f.publish=async changes=>{if(mode==='local'){for(const change of changes)await files.replace(change.path,change.bytes??change.content)}else await withOperationChannel(files,'write',()=>withSnapshot(files,s=>files.commit(s,changes,'Actual fixture content publication')))}
 f.cache=new FrameworkSkillCacheRefresh(files,()=>providers,error=>errors.push(error))
 const eventWaiters=[]
 f.waitForCatalogEvents=count=>{if(events.filter(e=>e.kind==='cache-request').length>=count)return Promise.resolve();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Expected actual catalog publication notification was not observed within the test deadline.')),30000);eventWaiters.push({count,resolve:()=>{clearTimeout(timer);resolve()}})})}
 f.changed=()=>{events.push({kind:'cache-request',at:performance.now()});f.cache.request();for(const waiter of [...eventWaiters])if(events.filter(e=>e.kind==='cache-request').length>=waiter.count){eventWaiters.splice(eventWaiters.indexOf(waiter),1);waiter.resolve()}}
 f.access={connection:{files,transactions:tx,scope:name}}
 f.service=Object.assign(Object.create(FrameworkService.prototype),{closed:false,access:async()=>f.access,running:new Map([[mode,{runtime:{refreshSkills:f.changed}}]]),localUpgrades:new Map(),changed(){}})
 f.refreshIndex=async path=>{if(mode==='local')await refreshPhysicalFrameworkSkillIndex(files,[path]);else await tx.run('fixture-index:'+randomUUID(),{}, {reevaluate:true,gitReplay:'session-only'},async s=>(await prepareFrameworkSkillIndex(files,s,[{path,bytes:await files.readBytes(s,path)}],{skipUnchanged:true})).changes)}
 f.settle=async()=>{await Promise.all(maintenance);await f.cache.settled();if(errors.length)throw new AggregateError(errors)}
 await f.publish([{path:target,content:initial},{path:candidate,content:'Existing user candidate retained exactly\n'},{path:candidateIndex,content:JSON.stringify({version:1,entries:[{sourcePath:target,path:candidate,hash:hash('Existing user candidate retained exactly\n'),createdAt:'2026-11-01T00:00:00Z'}]})+'\n'}])
 await f.refreshIndex(target)
 for(let i=0;i<2;i++){const key={id:name+'-'+i},scope=createScope(ctx,key),provider=installFrameworkSkillProvider(scope.ctx,key,files);scopes.push({scope,key});providers.push(provider);const replace=provider.replaceCatalog.bind(provider);provider.replaceCatalog=entries=>{replace(entries);events.push({kind:'scope-catalog-applied',scope:i,at:performance.now(),names:entries.map(row=>row.name)})};await provider.settleRegistration();check(name+': provider mounted '+i,provider.available(),true);await ctx.skills.snapshot({scope:key})}
 f.native=async(name='example',index=0)=>ctx.skills.get(name,{scope:scopes[index].key})
 f.list=async(index=0)=>(await ctx.skills.snapshot({scope:scopes[index].key})).skills
 fixtures.push(f);return f
}
let sequence=0
function role(f,task,kind){const tools=new Map(),agent={id:kind+'-'+ ++sequence,session:{}},ctx={on:()=>()=>{},effect(){},systemPrompt:{section(){}},tools:{register:tool=>tools.set(tool.name,tool)}}
 installFrameworkRoleTools(ctx,agent,{role:kind,owner:task.owner,taskId:task.taskId,...(kind==='Planner'?{member:task.owner}:{}),workId:'work-'+sequence,executionId:'execution-'+sequence}, {files:f.files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:error=>f.errors.push(error),transact:(...args)=>f.tx.run(...args),skillsChanged:f.changed})
 return {call:(name,input)=>tools.get(name).execute(input,{agent,callId:'call-'+ ++sequence,signal:new AbortController().signal,concludeTurn(){}})}}
async function recorder(f,name,path=target){const source='tasks/'+name+'_P.md',id=randomUUID();await f.publish([{path:source,content:'Actual parallel skill editing validation task '+name}]);await f.publish((await withSnapshot(f.files,s=>initializeTask(f.files,s,source,'A',['A'],id))).changes);let task=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(id)));const planner=role(f,task,'Planner'),view=await planner.call('dss_snapshot',{});await planner.call('dss_complete',{snapshotId:view.snapshotId,acceptance:'Fixture task acceptance completed.',resultPaths:[]});task=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(id)));const r=role(f,task,'Recorder'),opened=await r.call('dss_snapshot',{}),base=await r.call('dss_read',{snapshotId:opened.snapshotId,path});return {task,base,save:async text=>{const result=await r.call('dss_recorder_save',{snapshotId:opened.snapshotId,outputs:[{path:paths.archive(task)+'/records.md',text:'Actual skill editing task record.'},{path,text,...(base.baseReadId?{baseReadId:base.baseReadId}:{})}],retainedPaths:[]});f.events.push({kind:'recorder-return',task:name,at:performance.now()});return result}}}
const client=readFileSync(new URL('framework/client-page.tsx',sourceRoot),'utf8'),ast=ts.createSourceFile('client-page.tsx',client,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),panel=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='KnowledgePanel')
const names=['run','submit','save','changeStatus'],code=ts.transpileModule(names.map(name=>panel.body.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text===name)).getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
async function editor(f,path=target){const state={selected:await f.service.knowledgeRead({mode:f.mode,storageScope:f.name,path}),edit:undefined,status:undefined,reason:'User selected control',editAttempt:{},statusAttempt:{},operations:new Map(),errors:[],notices:[],requests:[],reading:{current:0},active:{current:true}};state.edit={...state.selected.edit}
 const api={knowledgeEdit:async input=>{state.requests.push(structuredClone(input));return f.service.knowledgeEdit(input)},knowledgeStatus:input=>f.service.knowledgeStatus(input),knowledgeRead:input=>f.service.knowledgeRead(input)}
 state.invoke=async(name='save')=>{let done;const finished=new Promise(resolve=>done=resolve),deps={...state,api,scope:{mode:f.mode,storageScope:f.name},crypto:webcrypto,redraw(){},setBusy:b=>{if(!b)done()},setError:e=>{if(e)state.errors.push(e)},setNotice:n=>{if(n)state.notices.push(n)},setSelected:s=>state.selected=s,setEdit:e=>state.edit=e,setStatus:s=>state.status=s,refresh:()=>f.service.knowledgeList({mode:f.mode,storageScope:f.name}),tr:(_cn,en)=>en,frameworkErrorText:e=>String(e)};const methods=new Function(...Object.keys(deps),code+'\nreturn {save,submit,changeStatus}')(...Object.values(deps));methods[name]();await finished;await f.settle()}
 return state}
try{
 for(const mode of (process.env.DSS_DIRECT_SAVE_MODES??'local,git').split(',')){
  console.error('Starting actual '+mode+' user/Recorder publication cases')
  const f=await fixture(mode,mode+'-edit'),ui=await editor(f),originalCandidates=await read(f,candidateIndex),originalCandidate=await read(f,candidate)
  ui.edit.body=initial.replace('Original description','User description').replace('alpha before','alpha user');await ui.invoke()
  check(mode+': UI saves actual definition',await read(f,target),ui.edit.body);check(mode+': UI original request freezes real full read',ui.requests[0].baseBody,initial)
  check(mode+': first editor save has no error',ui.errors,[]);check(mode+': editor advances saved baseline',ui.selected.text,ui.edit.body)
  for(let i=0;i<2;i++){check(mode+': all native catalogs see new description '+i,(await f.list(i)).find(s=>s.name==='example').description,'User description');check(mode+': native loads saved body '+i,(await f.native('example',i)).content.includes('alpha user'),true)}
  ui.edit.body=ui.edit.body.replace('alpha user','alpha next');await ui.invoke();check(mode+': consecutive edit uses advanced baseline',ui.requests[1].baseBody.includes('alpha user'),true);check(mode+': consecutive edit saved',await read(f,target),ui.edit.body);check(mode+': no pending successful commands',ui.operations.size,0)
  const repeat=await f.service.knowledgeEdit(ui.requests.at(-1));check(mode+': repeated exact edit remains successful',repeat.saved,true)
  check(mode+': old candidate untouched',await read(f,candidate),originalCandidate);check(mode+': old candidate index untouched',await read(f,candidateIndex),originalCandidates)
  const listed=await f.service.knowledgeList({mode,storageScope:f.name});check(mode+': no extra candidate',listed.items.find(r=>r.path===target).candidates.length,1)
  ui.status='disabled';await ui.invoke('changeStatus');const control=await read(f,controls);ui.edit.body+='\nSaved while disabled\n';await ui.invoke();check(mode+': disabled body saved',await read(f,target),ui.edit.body);check(mode+': disabled control exact preservation',await read(f,controls),control);check(mode+': disabled not advertised',(await f.list()).some(s=>s.name==='example'),false);check(mode+': disabled not loadable',await f.native(),undefined)
  ui.status='retired';await ui.invoke('changeStatus');const retired=await read(f,controls);ui.edit.body+='\nSaved while retired\n';await ui.invoke();check(mode+': retired control exact preservation',await read(f,controls),retired);check(mode+': retired remains unavailable',await f.native(),undefined)
  const parallel=await fixture(mode,mode+'-parallel'),user=await editor(parallel),r1=await recorder(parallel,'recorder-one'),r2=await recorder(parallel,'recorder-two')
  user.edit.body=initial.replace('alpha before','alpha user')
  const outcomes=await Promise.all([r1.save(initial.replace('beta before','beta recorder one')),r2.save(initial.replace('gamma before','gamma recorder two')),user.invoke()]);await parallel.settle()
  check(mode+': two actual Recorder saves complete',outcomes.slice(0,2).every(v=>v?.saved===true),true)
  const combined=await read(parallel,target);check(mode+': three independent edits coexist',combined,initial.replace('alpha before','alpha user').replace('beta before','beta recorder one').replace('gamma before','gamma recorder two'))
  check(mode+': parallel editor no conflict/error',user.errors,[]);check(mode+': native latest combined body',(await parallel.native()).content.includes('gamma recorder two'),true)
  const conflictEditor=await editor(parallel),conflictRecorder=await recorder(parallel,'recorder-overlap');conflictEditor.edit.body=combined.replace('alpha user','alpha user newer');const recorderText=combined.replace('alpha user','alpha recorder newer');await conflictRecorder.save(recorderText);await parallel.settle();await conflictEditor.invoke()
  check(mode+': true overlapping Recorder update preserved',await read(parallel,target),recorderText);check(mode+': conflict draft retained', [...conflictEditor.operations.values()][0].input.body,conflictEditor.edit.body);check(mode+': conflict contains actual current text',[...conflictEditor.operations.values()][0].conflicts[0].current,recorderText)
  check(mode+': conflict does not create candidate',(await parallel.service.knowledgeList({mode,storageScope:parallel.name})).items.find(r=>r.path===target).candidates.length,1)
  const overlap1=await recorder(parallel,'two-recorder-overlap-one'),overlap2=await recorder(parallel,'two-recorder-overlap-two'),overlapBase=await read(parallel,target)
  const overlapResults=await Promise.all([overlap1.save(overlapBase.replace('beta recorder one','beta conflicting first')),overlap2.save(overlapBase.replace('beta recorder one','beta conflicting second'))])
  check(mode+': real same-region two Recorder race has one actual winner',overlapResults.filter(r=>r?.saved===true).length,1)
  check(mode+': real same-region two Recorder loser retains original responsibility',overlapResults.filter(r=>r?.saved===false).length,1)
  check(mode+': overlapping Recorder loser receives real conflict detail',overlapResults.find(r=>r?.saved===false).pendingSkills?.length>0||overlapResults.find(r=>r?.saved===false).skillIssues?.length>0,true)
  check(mode+': winner content is one complete authored proposal',[overlapBase.replace('beta recorder one','beta conflicting first'),overlapBase.replace('beta recorder one','beta conflicting second')].includes(await read(parallel,target)),true)

  const next=await recorder(parallel,'recorder-create','skills/new-skill/SKILL.md'),newBody='---\nname: new-skill\ndescription: New Recorder definition\n---\nNew native content\n';await next.save(newBody);await parallel.settle();
  // Physical indexing is intentionally independent. Wait for the actual index
  // callback rather than assuming archive completion is index completion.
  if(mode==='local'){for(let i=0;i<1000 && !(await parallel.list()).some(s=>s.name==='new-skill');i++){await waitTurn();await parallel.settle()}}
  check(mode+': new Recorder skill advertised',(await parallel.list()).some(s=>s.name==='new-skill'),true);check(mode+': new Recorder skill loads',(await parallel.native('new-skill')).content,'New native content')
  // Two independent Tasks publish different definitions to the SAME shared
  // catalog. The peer uses a separate real Files handle to the same authority.
  const shared=await fixture(mode,mode+'-shared-catalog'),peerRemote=mode==='git'?gitFixture(join(scratch,shared.name+'.git'),'sha1',async()=>{},true):undefined,peerFiles=peerRemote?.files??new PhysicalLocalFiles(shared.files.directory),peerTx=new FrameworkTransactions(peerFiles,store())
  peerHandles.push({files:peerFiles,tx:peerTx,remote:peerRemote});const peer={...shared,files:peerFiles,tx:peerTx}
  const onePath='skills/task-one/SKILL.md',twoPath='skills/task-two/SKILL.md',one=await recorder(shared,'new-one',onePath),two=await recorder(peer,'new-two',twoPath)
  const bodies=['---\nname: task-one\ndescription: First simultaneous skill\n---\nOne body\n','---\nname: task-two\ndescription: Second simultaneous skill\n---\nTwo body\n']
  const both=await Promise.all([one.save(bodies[0]),two.save(bodies[1])]);check(mode+': separate Task Recorders both save',both.every(r=>r?.saved===true),true)
  timing.push({name:mode+'-two-skill-return',listedImmediately:(await shared.list()).map(row=>row.name),events:[...shared.events]})
  if(mode==='git')check('Git both definitions and shared entries are durable when both save returns',JSON.parse(await read(shared,catalog)).entries.filter(row=>[onePath,twoPath].includes(row.path)).map(row=>row.path).sort(),[onePath,twoPath].sort())
  if(mode==='local')await shared.waitForCatalogEvents(2)
  await shared.settle()
  check(mode+': one shared catalog retains both independent new skills',JSON.parse(await read(shared,catalog)).entries.filter(row=>[onePath,twoPath].includes(row.path)).map(row=>row.path).sort(),[onePath,twoPath].sort())
  for(let i=0;i<2;i++){check(mode+': warm scope '+i+' discovers both skill names',(await shared.list(i)).filter(row=>['task-one','task-two'].includes(row.name)).map(row=>row.name).sort(),['task-one','task-two']);check(mode+': warm scope '+i+' loads task one',(await shared.native('task-one',i)).content,'One body');check(mode+': warm scope '+i+' loads task two',(await shared.native('task-two',i)).content,'Two body')}
  // Natural finite contention: eight independent task Recorders save distinct
  // definitions concurrently. No blocked queue, injected fault or fake success.
  const eight=[]; for(let i=0;i<8;i++) eight.push(await recorder(shared,'finite-eight-'+i,'skills/finite-eight-'+i+'/SKILL.md'));
  const eventBase=shared.events.filter(e=>e.kind==='cache-request').length;
  const eightStart=performance.now();
  const eightResults=await Promise.all(eight.map((r,i)=>r.save('---\nname: finite-eight-'+i+'\ndescription: Finite natural concurrent publication\n---\nBody '+i+'\n')));
  check(mode+': eight independent Recorder saves complete',eightResults.every(r=>r?.saved===true),true);
  const eightAtReturn=JSON.parse(await read(shared,catalog)).entries.filter(row=>row.path.startsWith('skills/finite-eight-')).length;
  if(mode==='local') await shared.waitForCatalogEvents(eventBase+8);
  await shared.settle();
  const eightAfter=JSON.parse(await read(shared,catalog)).entries.filter(row=>row.path.startsWith('skills/finite-eight-')).length;
  check(mode+': finite eight catalog union',eightAfter,8);
  timing.push({name:mode+'-finite-eight',atReturn:eightAtReturn,after:eightAfter,elapsedMs:performance.now()-eightStart});
  // Normal updates to both existing definitions also preserve each other.
  const reviseOne=await recorder(shared,'revise-one',onePath),reviseTwo=await recorder(peer,'revise-two',twoPath)
  await Promise.all([reviseOne.save(bodies[0].replace('First simultaneous skill','First updated').replace('One body','One updated')),reviseTwo.save(bodies[1].replace('Second simultaneous skill','Second updated').replace('Two body','Two updated'))])
  timing.push({name:mode+'-two-skill-update-return',listedImmediately:(await shared.list()).filter(row=>['task-one','task-two'].includes(row.name)).map(row=>({name:row.name,description:row.description})),events:[...shared.events]})
  if(mode==='local')await shared.waitForCatalogEvents(4)
  await shared.settle()
  for(let i=0;i<2;i++){check(mode+': scope '+i+' retains both updated descriptions',(await shared.list(i)).filter(row=>['task-one','task-two'].includes(row.name)).map(row=>row.description).sort(),['First updated','Second updated']);check(mode+': scope '+i+' loads first updated body',(await shared.native('task-one',i)).content,'One updated');check(mode+': scope '+i+' loads second updated body',(await shared.native('task-two',i)).content,'Two updated')}
 }
 // Real catalog same-file update occupies its existing queue while Recorder
 // publishes its independent skill and archive. No injected exception or fake
 // return value. The late index must still invalidate the already-warm registry.
 const late=await fixture('local','local-late-index');let release,entered;const queued=new Promise(r=>entered=r),hold=new Promise(r=>release=r)
 const occupied=late.files.updateAsync(catalog,async bytes=>{entered();await hold;return {value:undefined,content:bytes}});await queued
 const newPath='skills/late/SKILL.md',newPath2='skills/late-two/SKILL.md',r=await recorder(late,'late-recorder',newPath),r2=await recorder(late,'late-recorder-two',newPath2),cacheEvents=()=>late.events.filter(e=>e.kind==='cache-request').length,eventStart=cacheEvents()
 const [saved,saved2]=await Promise.all([r.save('---\nname: late\ndescription: Catalog queues independently\n---\nLate index body\n'),r2.save('---\nname: late-two\ndescription: Same shared catalog second skill\n---\nSecond late index body\n')])
 check('Local Recorder handoff does not wait for occupied catalog',saved.saved,true);check('Both Local Recorder handoffs stay independent of occupied catalog',saved2.saved,true);check('No premature refresh before actual catalog publication',cacheEvents(),eventStart);check('Native old catalog remains truthful before publish',(await late.list()).some(s=>s.name==='late'),false)
 const bothRefreshed=late.waitForCatalogEvents(eventStart+2);release();await occupied;await bothRefreshed;await late.settle()
 check('Both late catalog publications send refresh',cacheEvents(),eventStart+2);check('Late new skill becomes visible without another save',(await late.list()).some(s=>s.name==='late'),true);check('Late new skill native body',(await late.native('late')).content,'Late index body')
 check('Both late skills coexist in one actual shared catalog',JSON.parse(await read(late,catalog)).entries.filter(row=>[newPath,newPath2].includes(row.path)).map(row=>row.path).sort(),[newPath,newPath2].sort())
 for(let i=0;i<2;i++){check('Both late skills advertised together in scope '+i,(await late.list(i)).filter(row=>['late','late-two'].includes(row.name)).map(row=>row.name).sort(),['late','late-two']);check('Second late skill loads in scope '+i,(await late.native('late-two',i)).content,'Second late index body')}
 timing.push({name:'late-real-catalog-queue',events:late.events,meaning:'Both actual Task archives returned before the shared catalog queue was released. Both actual catalog publications then notified all warm scopes.'})
 const result={status:'passed',checks:checks.length,names:checks,timingObservations:timing,limits:'Actual Linux physical files, two native provider scopes, service and exact UI action code; actual Recorder tools/task completion; real Git CLI object/ref CAS through controlled transport. No public Git transport, full mounted DOM/Host model execution, Windows, or cross-process Local mutual exclusion claimed.',...evidence(),clientHash:hash(client),scriptHash:hash(readFileSync(fileURLToPath(import.meta.url)))}
 console.log(JSON.stringify(result,null,2));if(process.env.DSS_DIRECT_SAVE_RESULT)await fs.writeFile(process.env.DSS_DIRECT_SAVE_RESULT,JSON.stringify(result,null,2)+'\n')
}finally{for(const p of peerHandles){if(p.remote){await p.tx.closeGitSession(new Error('Peer closed'));p.files.operations.close();await p.remote.repo.releaseCache()}else await p.files.close()}for(const f of fixtures){await f.settle();await f.cache.close();for(const p of f.providers)await p.dispose();for(const s of f.scopes)await s.scope.dispose();if(f.mode==='git'){await f.tx.closeGitSession(new Error('Fixture closed'));f.files.operations.close();await f.remote.repo.releaseCache()}else await f.files.close()}await fs.rm(scratch,{recursive:true,force:true})}
