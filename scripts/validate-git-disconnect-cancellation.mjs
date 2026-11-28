// Production Service -> Running -> connection.close -> InstanceRegistration.
// Real temporary Git objects and exact-ref CAS; controlled transport/native ports.
// No actual GitHub/network, model, complete DSH Host/UI or user device is exercised.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, devNull } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'

// Match the existing lifecycle checks: this unused parser is not a fake SDK.
// Fail visibly if this suite accidentally enters Markdown parsing.
const supplemental = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'mdast-util-from-markdown') return {
    url: 'data:text/javascript,export function fromMarkdown(){throw Error("Markdown parsing is outside the Git close-lifecycle fixture")}', shortCircuit: true,
  }
  return next(specifier, context)
} })
const { FrameworkService } = await import(new URL('framework/service.ts', sourceRoot))
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts', sourceRoot))
const { RemoteGitRepository } = await import(new URL('experimental/private-git/remote-git-repository.ts', sourceRoot))
const { GitBackendError } = await import(new URL('experimental/private-git/git-object-backend.ts', sourceRoot))
const { GitCommitOutcomeUnknownError } = await import(new URL('experimental/private-git/contracts.ts', sourceRoot))
const { GitFiles, withSnapshot, FilesOutcomeUnknownError } = await import(new URL('framework/transactions.ts', sourceRoot))
const { GitAuthorityStore, SessionGitOperations } = await import(new URL('framework/git-authority.ts', sourceRoot))
const { InstanceRegistration } = await import(new URL('framework/instances.ts', sourceRoot))
const { openFrameworkConnection } = await import(new URL('framework/connection.ts', sourceRoot))

const selectedEvidence = process.env.DSS_GIT_CLOSE_EVIDENCE
if (selectedEvidence && !isAbsolute(selectedEvidence)) throw Error('DSS_GIT_CLOSE_EVIDENCE must be an absolute output file path.')
const evidencePath = selectedEvidence
const scratchRoot = mkdtempSync(join(tmpdir(), 'dss-git-close-tests-'))
const keepFixtures = process.env.DSS_GIT_CLOSE_KEEP_FIXTURES === '1'
const results = []
function gate() { let release; const promise = new Promise(r => { release = r }); return { promise, release } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function waitFor(predicate) { for (let i=0;i<200;i++) { if (predicate()) return; await tick() } throw Error('Condition did not settle') }
function fixture(growth=1_000_000) {
  const root=mkdtempSync(join(scratchRoot,'git-case-')), path=join(root,'objects.git')
  execFileSync('git',['init','--bare','--quiet',path])
  const git=(args,input)=>execFileSync('git',['--git-dir='+path,...args],{input,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:devNull,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},stdio:['pipe','pipe','pipe']})
  const blob=text=>git(['hash-object','-t','blob','-w','--stdin'],Buffer.from(text)).toString().trim()
  const blobs=['a','b','c'].map(letter=>blob(letter.repeat(8200)))
  const inner=git(['mktree'],Buffer.from(blobs.map((id,i)=>`100644 blob ${id}\t${String.fromCharCode(97+i)}.txt\n`).join(''))).toString().trim()
  const tree=git(['mktree'],Buffer.from(`040000 tree ${inner}\tdss-coop\n`)).toString().trim()
  const initial=git(['commit-tree',tree],Buffer.from('Initial fixture\n')).toString().trim();git(['update-ref','refs/heads/main',initial])
  const head=()=>git(['rev-parse','refs/heads/main']).toString().trim()
  const events=[], backends=[];const trace={root,events};results.push(trace);let hook,afterPush,loseAck=false,failResolution=false
  class Backend {
    closed=false;ids=new Set();lifetime={}; constructor(channel,lifetime){this.channel=channel;if(lifetime)this.lifetime=lifetime;backends.push(this);this.number=backends.length}
    async ready(){}
    async release(){if(!this.closed){this.closed=true;events.push({kind:'release',channel:this.channel,backend:this.number})}}
    async storageBytes(){return [...this.ids].reduce((n,id)=>n+Number(git(['cat-file','-s',id])),0)}
    metadata(id){this.ids.add(id); const commit=git(['cat-file','commit',id]).toString(), root=commit.match(/^tree (\w+)/)[1]; const visit=tree=>{this.ids.add(tree); for(const row of git(['ls-tree','-z',tree]).toString().split('\0').filter(Boolean)){const m=row.match(/^\d+ (\w+) (\w+)\t/);if(m[1]==='tree')visit(m[2])}};visit(root);return root}
    async replacement(roots,signal,selected){signal.throwIfAborted();const next=new Backend(this.channel,this.lifetime);const copied=roots.map(row=>({head:row.head,tree:next.metadata(row.head)}));for(const id of selected??[])if(this.ids.has(id))next.ids.add(id);events.push({kind:'replacement',channel:this.channel,from:this.number,to:next.number,selected:[...selected??[]]});return{transport:next,objects:next.ids.size,packBytes:0,rawBytes:await next.storageBytes(),roots:copied}}
    async execute(command,{signal,input}){
      signal.throwIfAborted();if(this.closed)throw new GitBackendError('fatal','Closed tracked fixture')
      const event={kind:'operation',channel:this.channel,backend:this.number,op:command.op,id:command.id};events.push(event)
      if(hook)await hook(command,signal,this)
      signal.throwIfAborted()
      if(command.op==='fetchHead'){if(failResolution)throw new GitBackendError('transport','Controlled read outage');const h=head();this.metadata(h);return Buffer.from(h)}
      if(command.op==='fetchMetadata'){this.metadata(command.revision);return Buffer.alloc(0)}
      if(command.op==='ensureObjects'){for(const id of command.ids)this.ids.add(id);return command.kind==='commit'?git(['rev-list','--max-count='+String(command.commitDepth??1),...command.ids]):Buffer.alloc(0)}
      if(command.op==='readObject')return git(['cat-file',command.kind,command.id])
      if(command.op==='readTree')return git(['ls-tree','-z',command.id])
      if(command.op==='writeBlob'){const id=blob(input);this.ids.add(id);return Buffer.from(id)}
      if(command.op==='writeTree'){const id=git(['mktree','-z'],input).toString().trim();this.ids.add(id);return Buffer.from(id)}
      if(command.op==='writeCommit'){
        const message=String(input).replace(/\n?$/,'\n');const id=git(['commit-tree',command.tree,...command.parent?['-p',command.parent]:[]],Buffer.from(message)).toString().trim();this.ids.add(id)
        return Buffer.from(JSON.stringify({id,tree:command.tree,parents:command.parent?[command.parent]:[],message,timestamp:command.timestamp}))
      }
      if(command.op==='push'){try{git(['update-ref',command.ref,command.commit,command.expected||'0'.repeat(40)])}catch{throw new GitBackendError('stale','Real CAS conflict',{advertisedHead:head()})}if(afterPush)await afterPush(command,signal,this);if(loseAck){loseAck=false;failResolution=true;throw new GitBackendError('transport','Real CAS accepted, controlled reply loss')}return Buffer.alloc(0)}
      throw Error('Unhandled fixture command')
    }
  }
  const binding={ownerRepo:'fixture/project',branch:'main',repositoryDirectory:'dss-coop'}
  const makeRepository=(bound=()=>binding,tokens=async()=>({value:'unused-fixture',source:'fixture'}),options={})=>{
    const repo=new RemoteGitRepository(bound,tokens,{...options,cacheGrowthBytes:growth,remoteUrl:()=> 'http://127.0.0.1:1/unused.git',inspectAuthority:async()=>({identity:{id:1,login:'fixture'},repository:{id:1,fullName:'fixture/project',branch:'main',private:true,permissions:{pull:true,push:true,admin:false}}})})
    const original=repo.newCache.bind(repo);repo.newCache=(channel,transport)=>original(channel,transport??new Backend(channel))
    return repo
  }
  const repo=makeRepository()
  const files=new GitFiles(repo,new SessionGitOperations())
  return {root,repo,files,events,backends,blobs,makeRepository,setHook(value){hook=value},setAfterPush(value){afterPush=value},loseAck(){loseAck=true},allowReads(){failResolution=false},save(name){trace.name=name;trace.assertionsCompleted=true}}
}

const config={accountId:1,repositoryId:'fixture',repositoryOwner:'fixture',login:'fixture',instanceUUID:'00000000-0000-4000-8000-000000000001',workerSeats:1}
const stored=()=>{const values=new Map();return {async get(key){return structuredClone(values.get(key))},async set(key,value){values.set(key,structuredClone(value))},async delete(key){values.delete(key)},async list(prefix=''){return [...values].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)}))}}}
const settings={mode:'git',ownerRepo:'fixture/project',repositoryDirectory:'dss-coop',workerSeats:1}
const credentials={async resolve(){return{value:'unused-fixture',source:'fixture'}}}

// The wall-clock bound is a test failure detector only, not production policy.
async function bounded(work) {let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture did not settle after explicit cancellation')),1500)})])}finally{clearTimeout(timer)}}
const outcome=work=>work.then(value=>({value}),error=>({error}))
const defaults={name:'Fixture',userName:'fixture',localDirectory:'/unused',ownerRepo:'fixture/project',repositoryDirectory:'dss-coop',collaborationId:'fixture',workerSeats:1,workspace:'/fixture'}
async function serviceFixture() {
  const f=fixture(),storage=stored(),connection=await openFrameworkConnection(settings,{storage,credentials,repositoryFactory:(b,t,o)=>f.makeRepository(b,t,o)})
  const service=new FrameworkService({logger:()=>({warn(){},error(){}})},storage,defaults)
  service.saved.set('git',{revision:'before',settings:{...defaults}})
  service.saved.set('local',{revision:'local-before',settings:{...defaults}})
  const makeRunning=connection=>({connection,resources:[],workspaceSelection:service.config('git').settings.workspace,runtime:{config:{workspace:service.config('git').settings.workspace},dispose:async()=>connection.cancelPending(new DOMException('Fixture runtime has drained its native work','AbortError')),executionViews:()=>[],setForegroundModel(){},setBackgroundModel(){}}})
  const active=makeRunning(connection);service.running.set('git',active)
  // Real service owner/configuration/close paths, but no native Host acquisition
  // or background warmup is claimed. The replacement is another real connection.
  let opened=0;const replacements=[]
  service.connect=async(mode,signal)=>{signal?.throwIfAborted();const next=await openFrameworkConnection(settings,{storage,signal,credentials,repositoryFactory:(b,t,o)=>f.makeRepository(b,t,o)});const running=makeRunning(next);replacements.push(running);service.running.set(mode,running);opened++;return running}
  service.prepareGit=()=>{}
  const cleanupErrors=[],cleanupFailure=service.cleanupFailure.bind(service)
  service.cleanupFailure=(mode,error)=>{cleanupErrors.push(error);return cleanupFailure(mode,error)}
  return {...f,f,service,storage,connection,active,replacements,cleanupErrors,get opened(){return opened}}
}
function holdHead(f,nth=1) {
  let count=0,entered=false,signal;const released=gate()
  f.setHook((command,current)=>{if(command.op==='fetchHead'&&++count===nth){entered=true;signal=current;return new Promise((resolve,reject)=>{current.addEventListener('abort',()=>reject(current.reason),{once:true});released.promise.then(resolve);if(current.aborted)reject(current.reason)})}})
  return {get entered(){return entered},get signal(){return signal},release:released.release}
}
async function cleanupFixture(f){f.setHook(undefined);f.setAfterPush(undefined);f.allowReads();f.connection?.cancelPending(new DOMException('Test cleanup','AbortError'));for(const r of f.replacements??[])await r.connection.close().catch(()=>{});await f.connection?.close().catch(()=>{});await f.repo.releaseCache()}

test('participation withdrawal owner is canceled by a validated later configure, without canceling the replacement',async()=>{
  const f=await serviceFixture(),hold=holdHead(f),leaving=outcome(f.service.participation({mode:'git',enabled:false}))
  try {
    await waitFor(()=>hold.entered)
    const next=outcome(f.service.configure({mode:'git',commandId:'later-configure',changedFields:['name'],settings:{...defaults,name:'Replacement'}}))
    const left=await bounded(leaving);assert.equal(left.error?.name,'AbortError')
    const result=await bounded(next);assert.equal(result.error,undefined);assert.equal(result.value.settings.name,'Replacement');assert.equal(f.opened,1)
    assert.notEqual(f.service.running.get('git'),f.active);assert.equal(f.service.configurationOwners.size,0)
    const current=f.service.running.get('git');await current.connection.updateWorkerSeats(2)
    assert.equal(current.connection.registration.workerSeats,2);f.save('participation-superseded-by-configure')
  } finally {hold.release();await cleanupFixture(f)}
})

// Workspace-only selection is hot. These cancellation checks need the real
// nonhot execution-setting path, so each requested root also changes preset.
test('nonhot preset configure shutdown is canceled by withdrawal and does not leave its closed Running in the map',async()=>{
  const f=await serviceFixture(),hold=holdHead(f)
  const changing=outcome(f.service.configure({mode:'git',commandId:'old-configure',changedFields:['workspace','presetId'],settings:{...defaults,workspace:'/different',presetId:'replacement-preset'}}))
  try {
    await waitFor(()=>hold.entered)
    const withdrawal=outcome(f.service.participation({mode:'git',enabled:false}))
    const changed=await bounded(changing);assert.equal(changed.error?.name,'AbortError')
    const result=await bounded(withdrawal);assert.equal(result.error,undefined);assert.equal(result.value.connection.participating,false);assert.equal(f.service.running.has('git'),false)
    assert.equal(f.service.config('git').settings.workspace,'/fixture');assert.equal(f.service.config('git').settings.presetId,undefined);assert.equal(f.opened,0);f.save('configure-canceled-by-withdrawal')
  }finally{hold.release();await cleanupFixture(f)}
})

test('a later validated preset configure cancels an older preset configure close before entering its serial tail',async()=>{
  const f=await serviceFixture(),hold=holdHead(f)
  const old=outcome(f.service.configure({mode:'git',commandId:'first',changedFields:['workspace','presetId'],settings:{...defaults,workspace:'/first',presetId:'first-preset'}}))
  try{
    await waitFor(()=>hold.entered)
    const later=outcome(f.service.configure({mode:'git',commandId:'second',changedFields:['workspace','presetId'],settings:{...defaults,workspace:'/second',presetId:'second-preset'}}))
    assert.equal((await bounded(old)).error?.name,'AbortError')
    const result=await bounded(later);assert.equal(result.error,undefined);assert.equal(result.value.settings.workspace,'/second');assert.equal(result.value.settings.presetId,'second-preset');assert.equal(f.opened,1);f.save('configure-supersedes-configure-close')
  }finally{hold.release();await cleanupFixture(f)}
})

test('invalid later configure cannot cancel the admitted close owner',async()=>{
  const f=await serviceFixture(),hold=holdHead(f),leaving=outcome(f.service.participation({mode:'git',enabled:false}))
  try{
    await waitFor(()=>hold.entered)
    // A genuinely invalid user-entered collaboration domain fails schema
    // admission before it can cancel a prior owned close.
    const invalid=outcome(f.service.configure({mode:'git',commandId:'invalid-later',changedFields:['collaborationId'],settings:{...defaults,collaborationId:''}}))
    await tick();assert.equal(hold.signal.aborted,false)
    hold.release();assert.ok((await bounded(leaving)).value);assert.match((await bounded(invalid)).error.message,/collaborationId/)
    assert.equal(f.opened,0);f.save('invalid-configure-keeps-owner')
  }finally{hold.release();await cleanupFixture(f)}
})

test('dispose cancels a preexisting stopRunning even when no configuration owner exists',async()=>{
  const f=await serviceFixture(),hold=holdHead(f),stopping=outcome(f.service.stopRunning(f.active))
  try{
    await waitFor(()=>hold.entered);assert.equal(f.service.configurationOwners.size,0)
    const disposed=outcome(f.service.dispose());assert.equal((await bounded(stopping)).error?.name,'AbortError')
    const final=await bounded(disposed);assert.ok(final.error instanceof AggregateError);assert.ok(final.error.errors.some(e=>e.name==='AbortError'))
    assert.ok(f.cleanupErrors.some(e=>e.name==='AbortError'));assert.equal(f.service.running.size,0);f.save('dispose-reaches-already-closing-running')
  }finally{hold.release();await cleanupFixture(f)}
})

test('first dispose retains normal stopped publication rather than preemptively canceling it',async()=>{
  const f=await serviceFixture(),path=f.connection.registration.path
  try{
    await f.service.dispose();assert.equal(f.cleanupErrors.length,0)
    const reader=f.makeRepository(),files=new GitFiles(reader,new SessionGitOperations())
    assert.equal(JSON.parse(await withSnapshot(files,s=>files.read(s,path))).status,'stopped');await reader.releaseCache();f.save('first-dispose-normal-stopped')
  }finally{await cleanupFixture(f)}
})

test('Local connection keeps its normal stopped behavior and does not adopt the Git-only close signal',async()=>{
  const root=mkdtempSync(join(scratchRoot,'local-case-')),storage=stored(),controller=new AbortController()
  const local=await openFrameworkConnection({mode:'local',directory:root,login:'fixture',workerSeats:1},{storage,localFilesFactory:async path=>new PhysicalLocalFiles(path)})
  const path=local.registration.path;controller.abort(new DOMException('Git-only owner must not alter Local','AbortError'))
  await local.close(controller.signal)
  const files=new PhysicalLocalFiles(root)
  try{assert.equal(JSON.parse(await withSnapshot(files,s=>files.read(s,path))).status,'stopped');results.push({name:'local-close-regression',root,assertionsCompleted:true,events:[]})}finally{await files.close()}
})

test('cancellation during runtime drain is remembered and prevents any later stopped I/O',async()=>{
  const f=await serviceFixture(),held=gate();let entered=false
  f.active.runtime.dispose=async()=>{f.connection.cancelPending(new DOMException('Runtime cancellation','AbortError'));entered=true;await held.promise}
  const leaving=outcome(f.service.participation({mode:'git',enabled:false}))
  try{
    await waitFor(()=>entered);const before=f.events.filter(e=>e.kind==='operation').length
    const disposed=outcome(f.service.dispose());await tick();held.release()
    assert.equal((await bounded(leaving)).error?.name,'AbortError');assert.ok((await bounded(disposed)).error instanceof AggregateError)
    assert.equal(f.events.filter(e=>e.kind==='operation').length,before);await tick();assert.equal(f.events.filter(e=>e.kind==='operation').length,before)
    f.save('cancel-before-stopped-dispatch')
  }finally{held.release();await cleanupFixture(f)}
})

test('same-scope independent connection remains usable while another close is canceled',async()=>{
  const f=await serviceFixture(),second=await openFrameworkConnection(settings,{storage:f.storage,credentials,repositoryFactory:(b,t,o)=>f.makeRepository(b,t,o)}),controller=new AbortController(),hold=holdHead(f)
  const closing=outcome(f.connection.close(controller.signal))
  try{
    await waitFor(()=>hold.entered);controller.abort(new DOMException('Cancel only first owner','AbortError'))
    assert.equal((await bounded(closing)).error?.name,'AbortError');assert.equal(second.scope,f.connection.scope)
    await second.updateWorkerSeats(3);assert.equal(second.registration.workerSeats,3)
    assert.equal(getEventListeners(controller.signal,'abort').length,0);f.save('same-scope-distinct-owner-isolation')
  }finally{hold.release();await second.close();await cleanupFixture(f)}
})

test('cancel before push stays an unsent cancellation and does not create another I/O epoch',async()=>{
  const f=await serviceFixture(),controller=new AbortController(),before=f.events.filter(e=>e.op==='push').length
  f.setHook((command)=>{if(command.op==='writeCommit')controller.abort(new DOMException('Canceled before dispatch','AbortError'))})
  try{
    const result=await outcome(f.connection.close(controller.signal));assert.equal(result.error?.name,'AbortError')
    assert.equal(f.events.filter(e=>e.op==='push').length,before)
    const count=f.events.filter(e=>e.kind==='operation').length;await tick();assert.equal(f.events.filter(e=>e.kind==='operation').length,count)
    f.save('prepared-but-unsent-cancel')
  }finally{await cleanupFixture(f)}
})

test('cancel after stopped CAS dispatch keeps UNKNOWN and its original operation ID',async()=>{
  const f=await serviceFixture(),controller=new AbortController(),before=f.events.filter(e=>e.op==='push').length
  f.setAfterPush((_command,signal)=>{controller.abort(new DOMException('Lost stopped reply during cancel','AbortError'));throw signal.reason})
  try{
    const result=await outcome(f.connection.close(controller.signal));assert.ok(result.error instanceof FilesOutcomeUnknownError);assert.ok(result.error.operationId)
    assert.equal(f.events.filter(e=>e.op==='push').length,before+1);assert.equal((await f.connection.files.operations.list()).length,0)
    f.save('canceled-dispatched-stop-preserves-unknown')
  }finally{await cleanupFixture(f)}
})

test('CAS success before the production caller accepts its acknowledgement remains UNKNOWN on cancellation',async()=>{
  const f=await serviceFixture(),controller=new AbortController(),before=f.events.filter(e=>e.op==='push').length
  f.setAfterPush(()=>controller.abort(new DOMException('Cancellation after successful CAS','AbortError')))
  try{
    const result=await outcome(f.connection.close(controller.signal));assert.ok(result.error instanceof FilesOutcomeUnknownError)
    assert.equal(f.events.filter(e=>e.op==='push').length,before+1);assert.equal((await f.connection.files.operations.list()).length,0)
    f.save('unaccepted-ack-remains-unknown')
  }finally{await cleanupFixture(f)}
})

test('a production-confirmed stopped publication keeps success during local receipt cleanup cancellation',async()=>{
  const f=await serviceFixture(),controller=new AbortController(),operations=f.connection.files.operations,save=operations.save.bind(operations)
  const before=f.events.filter(e=>e.op==='push').length
  operations.save=async record=>{await save(record);if(record.resolution?.status==='confirmed')controller.abort(new DOMException('Canceled after confirmed receipt was saved','AbortError'))}
  try{
    const result=await outcome(f.connection.close(controller.signal));assert.equal(result.error,undefined)
    assert.equal(f.events.filter(e=>e.op==='push').length,before+1);assert.equal((await operations.list()).length,0)
    f.save('confirmed-stop-wins-late-cancellation')
  }finally{await cleanupFixture(f)}
})

test('cancellation after confirming the old running operation prevents the subsequent new stopped request',async()=>{
  const f=await serviceFixture(),controller=new AbortController();f.loseAck()
  const previous=await outcome(f.connection.updateWorkerSeats(2));assert.ok(previous.error instanceof FilesOutcomeUnknownError);f.allowReads()
  const operations=f.connection.files.operations,save=operations.save.bind(operations),before=f.events.filter(e=>e.op==='push').length
  operations.save=async record=>{await save(record);if(record.operation.id===previous.error.operationId&&record.resolution?.status==='confirmed')controller.abort(new DOMException('Canceled after old exact operation confirmed','AbortError'))}
  try{
    const result=await outcome(f.connection.close(controller.signal));assert.equal(result.error?.name,'AbortError')
    assert.equal(f.events.filter(e=>e.op==='push').length,before);f.save('resolved-old-running-no-new-stop-after-abort')
  }finally{await cleanupFixture(f)}
})

test('a repeated close can attach a new legitimate cancellation owner to the same closing promise',async()=>{
  const f=await serviceFixture(),controller=new AbortController(),hold=holdHead(f),closing=f.connection.close(),pending=outcome(closing)
  try{
    await waitFor(()=>hold.entered);assert.equal(f.connection.close(controller.signal),closing)
    controller.abort(new DOMException('Cancel through later close owner','AbortError'));assert.equal((await bounded(pending)).error?.name,'AbortError')
    assert.equal(getEventListeners(controller.signal,'abort').length,0);f.save('repeated-close-adopts-cancel-owner')
  }finally{hold.release();await cleanupFixture(f)}
})

test('canceling before disconnect starts preserves an existing dispatched UNKNOWN without new I/O',async()=>{
  const f=await serviceFixture(),controller=new AbortController();f.loseAck()
  const previous=await outcome(f.connection.updateWorkerSeats(2));assert.ok(previous.error instanceof FilesOutcomeUnknownError)
  const before=f.events.filter(e=>e.kind==='operation').length;controller.abort(new DOMException('Cancel pending final hint','AbortError'))
  try{
    const result=await outcome(f.connection.close(controller.signal));assert.ok(result.error instanceof FilesOutcomeUnknownError);assert.equal(result.error.operationId,previous.error.operationId)
    assert.equal(f.events.filter(e=>e.kind==='operation').length,before);f.save('existing-unknown-before-stop-start')
  }finally{await cleanupFixture(f)}
})

test('canceling reconciliation retains existing UNKNOWN rather than relabeling it a plain abort',async()=>{
  const f=await serviceFixture(),controller=new AbortController();f.loseAck()
  const previous=await outcome(f.connection.updateWorkerSeats(2));assert.ok(previous.error instanceof FilesOutcomeUnknownError);f.allowReads()
  const hold=holdHead(f,2),closing=outcome(f.connection.close(controller.signal))
  try{
    await waitFor(()=>hold.entered);controller.abort(new DOMException('Cancel original reconciliation','AbortError'))
    const result=await bounded(closing);assert.ok(result.error instanceof FilesOutcomeUnknownError);assert.equal(result.error.operationId,previous.error.operationId)
    f.save('original-unknown-during-reconciliation')
  }finally{hold.release();await cleanupFixture(f)}
})

test('normal stopped publication preserves observer sequence semantics, with no peer acknowledgement',async()=>{
  const f=fixture(),authority=new GitAuthorityStore(f.files,'fixture-instance');let now=Date.parse('2026-11-09T00:00:00Z')
  const registration=new InstanceRegistration(f.files,authority,{...config},()=>now)
  const readerRepo=f.makeRepository(),readerFiles=new GitFiles(readerRepo,new SessionGitOperations())
  const observer=new InstanceRegistration(readerFiles,new GitAuthorityStore(readerFiles,'fixture-observer'),{...config,instanceUUID:'00000000-0000-4000-8000-000000000002'},()=>now)
  const row=await registration.register();assert.equal((await observer.observe())[0].availability,'unknown')
  now+=31_000;await registration.tick();assert.equal((await observer.observe())[0].availability,'online')
  const before=JSON.parse(await withSnapshot(f.files,s=>f.files.read(s,row.path)))
  await registration.disconnect()
  const after=JSON.parse(await withSnapshot(f.files,s=>f.files.read(s,row.path)))
  assert.equal(after.sequence,before.sequence+1);assert.equal(after.status,'stopped')
  assert.equal((await observer.observe())[0].availability,'stopped')
  await registration.register();assert.equal((await observer.observe())[0].availability,'online')
  await authority.close();await f.repo.releaseCache();await readerRepo.releaseCache();f.save('normal-stop-observation-and-resume')
})

test('live UNKNOWN running operation resolves by its original ID before disconnect publishes stopped',async()=>{
  const f=fixture(),authority=new GitAuthorityStore(f.files,'fixture-instance')
  const registration=new InstanceRegistration(f.files,authority,{...config})
  await registration.register();f.loseAck()
  await assert.rejects(registration.updateWorkerSeats(2),FilesOutcomeUnknownError)
  const original=registration.pendingOperationId,prepared=structuredClone(registration.pendingPublication.pending)
  assert.ok(original);assert.ok(await f.files.operations.get(original))
  const pushes=f.events.filter(x=>x.op==='push').length
  f.allowReads();await registration.disconnect()
  assert.equal(f.events.filter(x=>x.op==='push').length,pushes+1)
  const body=JSON.parse(await withSnapshot(f.files,s=>f.files.read(s,prepared.registration.path)))
  assert.equal(body.sequence,prepared.heartbeat.sequence+1);assert.equal(body.status,'stopped')
  assert.equal(registration.pendingOperationId,undefined);assert.equal(await f.files.operations.get(original),undefined)
  await authority.close();await f.repo.releaseCache();f.save('live-original-unknown-resolve-then-stop')
})

test('an unbound first close still waits; old opener abort and repeated close alone do not invent cancellation',async()=>{
  const f=fixture(),opener=new AbortController();let storageCloseCalls=0
  const connection=await openFrameworkConnection(settings,{storage:stored(),signal:opener.signal,credentials,repositoryFactory:(b,t,o)=>f.makeRepository(b,t,o),onStorageOpened(access){const close=access.close;access.close=()=>{storageCloseCalls++;return close()}}})
  connection.cancelPending(new DOMException('Prior runtime cancellation','AbortError'))
  let entered=false,settled=false
  f.setHook((c,signal)=>{if(c.op==='fetchHead'){entered=true;assert.equal(signal.aborted,false);return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason)})}})
  const closing=connection.close(),rejection=assert.rejects(closing);void closing.then(()=>{settled=true},()=>{settled=true})
  await waitFor(()=>entered);assert.equal(storageCloseCalls,0);assert.equal(connection.close(),closing)
  opener.abort(new DOMException('Old configuration owner aborted','AbortError'))
  await tick();assert.equal(settled,false);assert.equal(storageCloseCalls,0)
  connection.cancelPending(new DOMException('Explicit test cleanup','AbortError'))
  await rejection;assert.equal(storageCloseCalls,1);assert.ok(f.backends.every(b=>b.closed));f.save('real-connection-close-cancel-owner-gap')
})

test('closing after stopped CAS loses its reply reports UNKNOWN and clears only session transport facts',async()=>{
  const f=fixture(),storage=stored();let access
  const open=()=>openFrameworkConnection(settings,{storage,credentials,repositoryFactory:(b,t,o)=>f.makeRepository(b,t,o),onStorageOpened(value){access=value}})
  const connection=await open();const originalFiles=connection.files,registration=connection.registration
  f.loseAck();let unknown
  await assert.rejects(connection.close(),e=>{unknown=e;return e instanceof FilesOutcomeUnknownError})
  assert.ok(unknown.operationId)
  assert.equal((await originalFiles.operations.list()).length,0)
  await assert.rejects(originalFiles.resolve(unknown.operationId),/No persisted operation/)
  assert.ok(f.backends.every(b=>b.closed))
  f.allowReads()
  const readerRepo=f.makeRepository(),readerFiles=new GitFiles(readerRepo,new SessionGitOperations())
  const stopped=JSON.parse(await withSnapshot(readerFiles,s=>readerFiles.read(s,registration.path)))
  assert.equal(stopped.status,'stopped')
  const restarted=await open()
  const running=JSON.parse(await withSnapshot(restarted.files,s=>restarted.files.read(s,registration.path)))
  assert.equal(running.status,'running');assert.equal(running.sequence,stopped.sequence+1)
  assert.equal(await restarted.files.operations.get(unknown.operationId),undefined)
  await restarted.close();await readerRepo.releaseCache();f.save('close-unknown-versus-new-registration-authority')
})


// Node's test runner reports the pass/fail outcome. Evidence includes failed
// fixtures too; a trace is marked completed only after its own assertions pass.
after(() => {
  const result = {
    suite: 'Git disconnect cancellation',
    ...evidence(),
    fixtures: { scratchRoot, retained: keepFixtures },
    seams: [
      'Git object backend: real temporary Git CLI objects/CAS, controlled I/O cancellation and lost acknowledgements; no remote network or Dulwich',
      'Service storage: in-memory technical-store fixture; no account credentials',
      'Native runtime: controlled dispose/model/execution-view ports; full production Service/connection/instances remain intact',
      'Replacement connect: real openFrameworkConnection with controlled native/workspace acquisition; unrelated prepareGit warmup omitted',
      'Unused Markdown parser throws if reached; actual selected SDK and zod dependencies otherwise load through dsh-sdk-runtime',
    ],
    cases: results,
  }
  try {
    if (evidencePath) writeFileSync(evidencePath, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ suite: result.suite, evidencePath, cases: results.length, fixtureDirectory: keepFixtures ? scratchRoot : undefined }))
  } finally {
    try { if (!keepFixtures) rmSync(scratchRoot, { recursive: true, force: true }) }
    finally { supplemental.deregister(); hooks.deregister() }
  }
})
