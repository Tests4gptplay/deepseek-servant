import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ModeRouter } from '../src/mode-router/mode-router.js'
import { SharedForeground } from '../src/mode-router/shared-foreground.js'
import type { ServantView } from '../src/contracts/views.js'
import { foregroundMemoryPath } from '../src/experimental/private-git/protocol.js'
import { mergeRepositoryGuide } from '../src/experimental/private-git/repository-guide.js'
import { CoopSettingsSchema, type CoopSettings, type GitChange, type GitRepository, type GitSnapshot, type PendingDraft, type RepoConnection, type RoleBinding, type UserIntent } from '../src/experimental/private-git/contracts.js'
import type { CoopStore } from '../src/experimental/private-git/cache.js'
import { GitConflictError, GitHubClient, GitHubError, GitHubMembers, inspectPrivateRepo } from '../src/experimental/private-git/github.js'
import { digest, GitJournal, json, readJson, readText, textChanges } from '../src/experimental/private-git/journal.js'
import { CoopConsumer, type CoopAgentPort, type CoopPhysicalState } from '../src/experimental/private-git/consumer.js'
import { RoleWriter, plannerTrigger } from '../src/experimental/private-git/role-writer.js'
import { CoopNativeAgents } from '../src/experimental/private-git/native-agents.js'
import { isProtocolPath, legacySignal, readOutcome, signalDisposition } from '../src/experimental/private-git/outcome.js'
import { statusPath } from '../src/experimental/private-git/status.js'
import { CoopSync } from '../src/experimental/private-git/sync.js'
import { conversationPage } from '../src/experimental/private-git/conversation.js'
import { CoopService } from '../src/experimental/private-git/service.js'
import type { CoopCredentials } from '../src/experimental/private-git/credentials.js'
import { actionPath, executionPath, joinPath, planPath, roleCommandSchema, taskPath, type CoopCommand, type RoleAction, type RoleOutcome, type RootTask } from '../src/experimental/private-git/protocol.js'

const connection = (id: number): RepoConnection => ({ identity: { id, login: 'participant-' + id }, repository: {
  id: 77, fullName: 'example/private-collaboration', branch: 'main', private: true, permissions: { pull: true, push: true, admin: id === 1 },
} })
class MemoryStore implements CoopStore {
  instanceId: string
  settings = CoopSettingsSchema.parse({ ownerRepo: 'example/private-collaboration', workspace: process.cwd(), workerSeats: 2 })
  values = new Map<string, unknown>()
  constructor(id = 1) { this.instanceId = 'instance-' + id; this.values.set('connection', connection(id)) }
  async configure(settings: CoopSettings) { this.settings = settings }
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined }
  async put(key: string, value: unknown) { this.values.set(key, JSON.parse(JSON.stringify(value))) }
  async remove(key: string) { this.values.delete(key) }
  entries<T>(prefix: string): Array<[string, T]> { return [...this.values].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]> }
  connection() { return this.get<RepoConnection>('connection') }
  drafts() { return this.entries<PendingDraft>('draft/').map(([, value]) => value) }
  async close() {}
}
class MemoryRepo implements GitRepository {
  head = 'h0'; files = new Map<string, string>(); blobs = new Map<string, string>()
  writes: Array<{ head: string; changes: readonly GitChange[] }> = []
  offline = false; conflictOnce = false; loseReply = false
  async connect() { return connection(1) }
  async snapshot(): Promise<GitSnapshot> {
    if (this.offline) throw new GitHubError(0, 'network unavailable')
    return { head: this.head, tree: this.head, files: new Map(this.files) }
  }
  async read(snapshot: GitSnapshot, path: string) { const sha = snapshot.files.get(path); return sha ? this.blobs.get(sha) : undefined }
  async commit(base: GitSnapshot, changes: readonly GitChange[]) {
    if (this.offline) throw new GitHubError(0, 'network unavailable')
    if (this.conflictOnce) { this.conflictOnce = false; this.head = 'h-conflict'; throw new GitConflictError() }
    if (base.head !== this.head) throw new GitConflictError()
    for (const change of changes) {
      if (change.content === null) this.files.delete(change.path)
      else { const sha = digest(change.content); this.files.set(change.path, sha); this.blobs.set(sha, change.content) }
    }
    this.head = 'h' + (this.writes.length + 1)
    this.writes.push({ head: this.head, changes })
    if (this.loseReply) { this.loseReply = false; throw new GitHubError(0, 'connection lost after commit') }
    return { commit: this.head, replay: false }
  }
  async seed(changes: GitChange[]) { await this.commit(await this.snapshot(), changes) }
}
class Agents implements CoopAgentPort {
  starts: RoleAction[] = []
  states = new Map<string, CoopPhysicalState>()
  async start(action: RoleAction) {
    assert.equal(this.states.has(action.binding.executionId), false, 'execution is only started once')
    this.starts.push(action)
    this.states.set(action.binding.executionId, { busy: true, finished: false, transcript: '', jobs: [] })
  }
  state(id: string) { return this.states.get(id) }
  finish(action: RoleAction, transcript = 'Complete native assistant text') { this.states.set(action.binding.executionId, { busy: false, finished: true, transcript, jobs: [] }) }
  async release(id: string) { this.states.delete(id) }
  async dispose() { this.states.clear() }
  latest(role: string): RoleAction { const value = this.starts.filter(action => action.binding.role === role).at(-1); assert.ok(value, 'started ' + role); return value }
}
function instance(repo: MemoryRepo, id = 1) {
  const cache = new MemoryStore(id), journal = new GitJournal(repo, String(id)), agents = new Agents()
  let wakes = 0
  const consumer = new CoopConsumer({ repo, cache, journal: () => journal, agents, wake: () => { wakes++ } })
  return { cache, journal, agents, consumer, get wakes() { return wakes }, tick: async (count = 1) => { for (let n = 0; n < count; n++) await consumer.consume(await repo.snapshot()) } }
}
type Instance = ReturnType<typeof instance>
async function input(repo: MemoryRepo, target: Instance, id: string, text: string) {
  const source: UserIntent = { id, text, participantId: String(target.cache.connection()!.identity.id), instanceId: target.cache.instanceId, createdAt: new Date().toISOString() }
  await target.cache.put('user-source/' + id, source)
  const path = 'dss-coop/conversations/' + source.participantId + '/2026-10-26/' + id
  await repo.seed([...textChanges(path + '/text', text), { path: 'dss-coop/intents/' + source.participantId + '/' + id + '.json',
    content: json({ ...source, text: undefined, textPath: path + '/text' }) },
    { path: path + '/entry.json', content: json({ ...source, text: undefined, textPath: path + '/text', role: 'user' }) }])
}
async function write(target: Instance, action: RoleAction, command: CoopCommand) {
  const writer = target.consumer.writer, b = action.binding
  if (action.stateProtocol === 1 && command.op === 'outcome' && command.text) {
    const { text, memory, note, kind, resultStatus, ...rest } = command
    const record = await writer.execute(b, { op: 'entry', id: command.id + '-body', kind: b.role === 'planner' ? 'memory' : 'reply',
      text: [text, memory].filter(Boolean).join('\n') })
    const noteRecord = note ? await writer.execute(b, { op: 'entry', id: command.id + '-note', kind: 'note', text: note }) : undefined
    return writer.execute(b, { ...rest, turn_signal: command.turn_signal ?? legacySignal(b.role, command),
      ...(b.role === 'planner' ? { memoryPath: record.textPath } : { replyPath: record.textPath }),
      ...(noteRecord ? { notePath: noteRecord.textPath } : {}) })
  }
  return writer.execute(b, command)
}
const review = { reported: 'Produced the requested artifact', checked: 'Opened the actual artifact and ran the named check', discrepancy: 'None', decision: 'Accepted', next: 'Integrate the shared result' }
async function root(repo: MemoryRepo, target: Instance) {
  await input(repo, target, 'origin-1', 'Build the shared deliverable without changing accepted content.')
  await target.tick()
  assert.equal(target.agents.starts.length, 0, 'a dispatch write does not start an agent')
  await target.tick()
  const foreground = target.agents.latest('foreground')
  await write(target, foreground, { op: 'root', id: 'root', title: 'Shared deliverable', goal: 'Build the deliverable', initialPlan: 'Split, execute, review and integrate' })
  await write(target, foreground, { op: 'outcome', id: 'out', kind: 'handoff_planner', taskId: 'task-origin-1', text: 'I have created the collaboration task.', prerequisitePaths: [] })
  assert.equal(target.agents.starts.length, 1, 'a role outcome write alone does not dispatch the planner')
  target.agents.finish(foreground)
  await target.tick(2)
  return target.agents.latest('planner')
}


import { CoopReadSchema, readCoopRecord } from '../src/experimental/private-git/record-access.js'
import type { ParticipantPlan } from '../src/experimental/private-git/protocol.js'

// No accounts, native host, LLM provider, network or external tools are used.
const fixtureReply = 'SYNTHETIC_BLOCKER: required operator permission unavailable; no artifact was changed.'
async function blockedFixture() {
  const repo = new MemoryRepo(), target = instance(repo)
  const planner = await root(repo, target)
  await write(target, planner, { op: 'root_plan', id: 'rp', expectedRevision: 0, works: [
    { id: 'part', title: 'Part', direction: 'Bounded work', acceptance: 'Check', participantId: '1', instanceId: target.cache.instanceId, version: 1 },
  ] })
  await write(target, planner, { op: 'claim', id: 'claim', workId: 'part', assignmentVersion: 1, scope: 'Same scope' })
  await write(target, planner, { op: 'participant_plan', id: 'plan', expectedRevision: 0, children: ['baseline','media','cache'].map((id, n) => ({
    id, workId: 'part', assignmentVersion: 1, title: id, direction: 'Perform ' + id, acceptance: 'Check', dependencies: n ? ['baseline'] : [],
  })) })
  await write(target, planner, { op: 'outcome', id: 'out', turn_signal: 'done', text: 'Initial three-child plan saved', prerequisitePaths: [] })
  target.agents.finish(planner)
  await target.tick(2)
  const worker = target.agents.latest('worker')
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'worker').length, 1)
  await write(target, worker, { op: 'outcome', id: 'out', turn_signal: 'blocked', text: fixtureReply, prerequisitePaths: [] })
  const published = await readOutcome(repo, await repo.snapshot(), worker.binding)
  assert.equal(published?.kind, 'result'); assert.equal(published?.resultStatus, 'failed')
  const record = await readCoopRecord(repo, target.cache.settings, CoopReadSchema.parse({ path: worker.binding.outputPath }))
  assert.equal(JSON.parse(record.text!).turn_signal, 'blocked')
  const reply = await readCoopRecord(repo, target.cache.settings, CoopReadSchema.parse({ path: published!.textPath }))
  assert.equal(reply.text, fixtureReply)
  target.agents.finish(worker)
  await target.tick(3)
  const reviewer = target.agents.latest('planner')
  assert.notEqual(reviewer.binding.executionId, planner.binding.executionId)
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'planner').length, 2)
  return { repo, target, worker, reviewer, published }
}


import { pendingWorkerResults } from '../src/experimental/private-git/worker-results.js'

test('blocked-result recovery: exact current published result references are supplied to Planner, not result prose', async () => {
 const {repo,target,worker,reviewer}=await blockedFixture()
 const context:any=await target.consumer.context(await repo.snapshot(),reviewer)
 assert.deepEqual(context.pendingWorkerResults,[{childId:'baseline',childRevision:1,assignmentVersion:1,resultExecutionId:worker.binding.executionId,
   outcomePath:worker.binding.outputPath,textPath:(await readOutcome(repo,await repo.snapshot(),worker.binding))!.textPath,turn_signal:'blocked',resultStatus:'failed'}])
 assert.equal(JSON.stringify(context).includes(fixtureReply),false)
 assert.equal((await target.consumer.context(await repo.snapshot(),worker) as any).pendingWorkerResults,undefined)
})

test('blocked-result recovery: premature done/rework is recoverable within same execution by exact review and corrected outcome', async () => {
 for(const signal of ['done','rework'] as const){
  const {repo,target,worker,reviewer}=await blockedFixture()
  await assert.rejects(write(target,reviewer,{op:'outcome',id:'premature',turn_signal:signal,text:'No Worker results',prerequisitePaths:[]}),error=>{
   assert.match(String(error),/Current Worker results still need review/);assert.ok(String(error).includes(worker.binding.outputPath));return true
  })
  assert.equal(await readOutcome(repo,await repo.snapshot(),reviewer.binding),undefined)
  assert.equal((await readJson<RoleAction>(repo,await repo.snapshot(),actionPath(reviewer.binding)))!.state,'active')
  await target.consumer.writer.current(await repo.snapshot(),reviewer.binding)
  await write(target,reviewer,{op:'review',id:'review',childId:'baseline',expectedRevision:1,resultExecutionId:worker.binding.executionId,accepted:false,
    review:{...review,decision:'Revise blocked work'},nextDirection:'Use authorized synthetic fixture'})
  assert.deepEqual(await pendingWorkerResults(repo,await repo.snapshot(),reviewer.binding),[])
  await write(target,reviewer,{op:'outcome',id:'corrected',turn_signal:'rework',text:'Read and reviewed the blocked result; corrected child direction',prerequisitePaths:[]})
  await target.consumer.writer.retryDrafts()
  target.agents.finish(reviewer);await target.tick(4)
  assert.equal(target.agents.latest('worker').binding.childRevision,2)
  assert.equal(target.agents.starts.filter(a=>a.binding.role==='worker').length,2)
  assert.equal(target.cache.drafts().length,0)
 }
})

test('blocked-result recovery: wait/need_user/error remain valid even after diagnosed premature done', async()=>{
 for(const signal of ['wait','need_user','error'] as const){
  const {repo,target,reviewer}=await blockedFixture()
  await assert.rejects(write(target,reviewer,{op:'outcome',id:'premature',turn_signal:'done',text:'No result',prerequisitePaths:[]}),/Current Worker results/)
  await write(target,reviewer,{op:'outcome',id:'dependency',turn_signal:signal,...(signal==='need_user'?{question:'Can I use a substitute?'}:{}),text:'Concrete external dependency remains',prerequisitePaths:[]})
  assert.equal((await readOutcome(repo,await repo.snapshot(),reviewer.binding))!.kind,'wait')
  await target.consumer.writer.retryDrafts();target.agents.finish(reviewer);await target.tick(4)
  const starts=target.agents.starts.length;await target.tick(20)
  assert.equal(target.agents.starts.length,starts)
  assert.equal(target.agents.starts.filter(a=>a.binding.role==='worker').length,1)
  assert.equal(target.agents.starts.filter(a=>a.id.startsWith('question-')).length,signal==='wait'?0:1)
 }
})

test('blocked-result recovery: result body without remote completed status is not surfaced or constrained',async()=>{
 const {repo,target,worker,reviewer}=await blockedFixture()
 await repo.seed([{path:statusPath(worker.binding,'completed'),content:null}])
 assert.deepEqual(await pendingWorkerResults(repo,await repo.snapshot(),reviewer.binding),[])
 await write(target,reviewer,{op:'outcome',id:'out',turn_signal:'done',text:'No published result',prerequisitePaths:[]})
 assert.equal((await readOutcome(repo,await repo.snapshot(),reviewer.binding))!.kind,'plan_ready')
})

test('blocked-result recovery: old epoch, changed revision/assignment, accepted result and other instance are excluded',async()=>{
 for(const variant of ['old-epoch','child-revision','assignment','accepted','other-instance','replaced-execution']){
  const {repo,target,worker,reviewer}=await blockedFixture()
  const path=planPath(reviewer.binding.taskId!,'1',target.cache.instanceId)
  const plan=(await readJson<ParticipantPlan>(repo,await repo.snapshot(),path))!
  if(variant==='old-epoch')reviewer.binding.epoch++
  if(variant==='child-revision')plan.children[0].revision++
  if(variant==='assignment')plan.children[0].assignmentVersion++
  if(variant==='accepted')plan.children[0].state='accepted'
  if(variant==='other-instance'||variant==='replaced-execution'){
   const action=(await readJson<RoleAction>(repo,await repo.snapshot(),actionPath(worker.binding)))!
   if(variant==='other-instance')action.binding.instanceId='other-instance'
   else action.binding.executionId='replaced-execution'
   await repo.seed([{path:actionPath(worker.binding),content:json(action)}])
  }
  await repo.seed([{path,content:json(plan)}])
  assert.deepEqual(await pendingWorkerResults(repo,await repo.snapshot(),reviewer.binding),[],variant)
 }
})

test('blocked-result recovery: repeated diagnosis never publishes final status or blindly dispatches more workers',async()=>{
 const {repo,target,reviewer}=await blockedFixture()
 for(let n=0;n<3;n++){
  await assert.rejects(write(target,reviewer,{op:'outcome',id:'premature-'+n,turn_signal:'done',text:'No result',prerequisitePaths:[]}),/Current Worker results/)
  await target.consumer.writer.retryDrafts();await target.tick(3)
 }
 assert.equal(await readOutcome(repo,await repo.snapshot(),reviewer.binding),undefined)
 assert.equal(target.agents.starts.filter(a=>a.binding.role==='planner').length,2)
 assert.equal(target.agents.starts.filter(a=>a.binding.role==='worker').length,1)
 await write(target,reviewer,{op:'outcome',id:'ask',turn_signal:'need_user',question:'Permission is missing; how should I proceed?',text:'Escalated concrete blocker',prerequisitePaths:[]})
 target.agents.finish(reviewer);await target.tick(3)
 assert.equal(target.agents.starts.filter(a=>a.id.startsWith('question-')).length,1)
})

test('blocked-result recovery: a result published after startup is reconciled at outcome, not only from stale context',async()=>{
 const {repo,target,worker,reviewer}=await blockedFixture()
 const paths=[worker.binding.outputPath,statusPath(worker.binding,'completed')]
 const saved=await Promise.all(paths.map(async path=>({path,content:(await repo.read(await repo.snapshot(),path))!})))
 await repo.seed(paths.map(path=>({path,content:null})))
 assert.deepEqual((await target.consumer.context(await repo.snapshot(),reviewer) as any).pendingWorkerResults,[])
 await repo.seed(saved)
 await assert.rejects(write(target,reviewer,{op:'outcome',id:'out',turn_signal:'done',text:'No result when I began',prerequisitePaths:[]}),/Current Worker results/)
 assert.equal(await readOutcome(repo,await repo.snapshot(),reviewer.binding),undefined)
})

test('blocked-result recovery: native tool stays open after diagnostic and only seals after corrected final write',async()=>{
 const {repo,target,worker,reviewer}=await blockedFixture()
 target.cache.settings.provider='synthetic-dss-qa';target.cache.settings.model='synthetic-no-network'
 const tools=new Map<string,any>(), hooks=new Map<string,any>(), messages:any[]=[]
 const scope={systemPrompt:{section(){}},tools:{schemas:()=>[],register(tool:any){tools.set(tool.name,tool)}},
   on(name:string,run:any){hooks.set(name,run);return ()=>{}},get(){},effect(){}}
 const agent={id:reviewer.binding.sessionId,ctx:scope,status:'running',inbox:{nextTurn:[],nextStep:[]},
   session:{snapshotEvents:()=>[],deriveMessages:()=>[]},followup(message:any){messages.push(message)},cancel(){}}
 const ctx={get(){},sessions:{async flush(){}},agents:{get(){},async create({agentOptions,setup}:any){
   assert.equal(agentOptions.provider,'synthetic-dss-qa');assert.equal(agentOptions.model,'synthetic-no-network')
   await setup(scope,agent);return {agent,async dispose(){}}
 },async resume(){assert.fail('fresh synthetic session expected')}}}
 const native=new CoopNativeAgents(ctx as any,target.cache)
 const call=(operation:any,callId:string)=>tools.get('coop_commit').execute({operation},{agent,callId,signal:new AbortController().signal})
 const allowed=()=>hooks.get('tools/pre-execute')({agent,name:'coop_read'},async()=> 'allowed')
 try{
  await native.start(reviewer,await target.consumer.context(await repo.snapshot(),reviewer),target.consumer.writer,()=>{})
  assert.equal(messages.length,1)
  const memory=await call({op:'entry',kind:'memory',text:'No Worker result yet'},'memory1')
  await assert.rejects(call({op:'outcome',turn_signal:'done',memoryPath:memory.textPath},'out1'),/Current Worker results/)
  assert.equal(await allowed(),'allowed','diagnostic must not seal this execution')
  await call({op:'review',childId:'baseline',expectedRevision:1,resultExecutionId:worker.binding.executionId,accepted:false,
   review:{...review,decision:'Rework blocked direction'},nextDirection:'Use authorized synthetic fixture'},'review1')
  const revised=await call({op:'entry',kind:'memory',text:'Read and reviewed the blocked result'},'memory2')
  await call({op:'outcome',turn_signal:'rework',memoryPath:revised.textPath},'out2')
  assert.equal((await allowed()).kind,'deny','only successful final publication seals this execution')
  assert.equal((await readOutcome(repo,await repo.snapshot(),reviewer.binding))!.kind,'plan_ready')
 }finally{await native.dispose()}
})

test('blocked-result recovery: same unchanged outcome can be retried after its result is reviewed',async()=>{
 const {repo,target,worker,reviewer}=await blockedFixture()
 const memory=await write(target,reviewer,{op:'entry',id:'memory',kind:'memory',text:'Current review will reconcile the blocked result'})
 const final:CoopCommand={op:'outcome',id:'retry-same',turn_signal:'rework',memoryPath:memory.textPath,prerequisitePaths:[]}
 await assert.rejects(write(target,reviewer,final),/Current Worker results/)
 await write(target,reviewer,{op:'review',id:'review',childId:'baseline',expectedRevision:1,resultExecutionId:worker.binding.executionId,
  accepted:false,review:{...review,decision:'Rework'},nextDirection:'Authorized substitute'})
 await write(target,reviewer,final)
 assert.equal((await readOutcome(repo,await repo.snapshot(),reviewer.binding))!.kind,'plan_ready')
 assert.equal(target.cache.drafts().length,0,'diagnosis is not a persistent write prohibition')
})

test('blocked-result recovery: end-to-end through corrected Worker, dependent children, acceptance and user delivery',async()=>{
 const {repo,target,worker,reviewer}=await blockedFixture()
 const taskId=reviewer.binding.taskId!
 await assert.rejects(write(target,reviewer,{op:'outcome',id:'premature',turn_signal:'done',text:'No results; unchanged plan',prerequisitePaths:[]}),/Current Worker results/)
 const context:any=await target.consumer.context(await repo.snapshot(),reviewer)
 const current=context.pendingWorkerResults[0]
 const result=await readCoopRecord(repo,target.cache.settings,CoopReadSchema.parse({path:current.outcomePath}))
 const reply=await readCoopRecord(repo,target.cache.settings,CoopReadSchema.parse({path:current.textPath}))
 assert.equal(JSON.parse(result.text!).resultStatus,'failed');assert.equal(reply.text,fixtureReply)
 await write(target,reviewer,{op:'review',id:'review-blocked',childId:'baseline',expectedRevision:1,resultExecutionId:worker.binding.executionId,
  accepted:false,review:{...review,discrepancy:'Required permission unavailable',decision:'Use authorized substitute'},nextDirection:'Verify isolated synthetic artifact only'})
 await write(target,reviewer,{op:'outcome',id:'recover',turn_signal:'rework',text:'Reviewed blocked reply; corrected within same Planner execution',prerequisitePaths:[]})
 await target.consumer.writer.retryDrafts();target.agents.finish(reviewer);await target.tick(4)
 const retried=target.agents.latest('worker');assert.equal(retried.binding.childRevision,2)
 await write(target,retried,{op:'outcome',id:'complete',turn_signal:'complete',text:'Synthetic baseline artifact verified',prerequisitePaths:[]})
 target.agents.finish(retried);await target.tick(3)
 const acceptBaseline=target.agents.latest('planner')
 await write(target,acceptBaseline,{op:'review',id:'accept-baseline',childId:'baseline',expectedRevision:2,resultExecutionId:retried.binding.executionId,accepted:true,review})
 await write(target,acceptBaseline,{op:'outcome',id:'release-dependencies',turn_signal:'done',text:'Baseline accepted; dispatch the two dependent children',prerequisitePaths:[]})
 target.agents.finish(acceptBaseline);await target.tick(3)
 const dependent=target.agents.starts.filter(a=>a.binding.role==='worker'&&['media','cache'].includes(a.binding.childId!))
 assert.deepEqual(dependent.map(a=>a.binding.childId).sort(),['cache','media'])
 for(const child of dependent){await write(target,child,{op:'outcome',id:'complete',turn_signal:'complete',text:'Verified synthetic '+child.binding.childId+' artifact',prerequisitePaths:[]});target.agents.finish(child)}
 await target.tick(3)
 const finalPlanner=target.agents.latest('planner')
 assert.equal((await target.consumer.context(await repo.snapshot(),finalPlanner) as any).pendingWorkerResults.length,2)
 let revision=3
 for(const child of dependent)await write(target,finalPlanner,{op:'review',id:'accept-'+child.binding.childId,childId:child.binding.childId!,expectedRevision:revision++,resultExecutionId:child.binding.executionId,accepted:true,review})
 await write(target,finalPlanner,{op:'report',id:'report',workId:'part',assignmentVersion:1,review,text:'All synthetic child artifacts independently verified'})
 await write(target,finalPlanner,{op:'accept',id:'accept-root',expectedRevision:1,review,text:'Bounded synthetic deliverable complete'})
 await write(target,finalPlanner,{op:'outcome',id:'complete',turn_signal:'complete',text:'Root accepted after complete review',prerequisitePaths:[]})
 target.agents.finish(finalPlanner);await target.tick(3)
 const delivery=target.agents.latest('foreground');assert.equal(delivery.binding.taskId,taskId)
 await write(target,delivery,{op:'outcome',id:'deliver',turn_signal:'respond',text:'Recovered blocked task; all three artifacts accepted and delivered.',prerequisitePaths:[]})
 target.agents.finish(delivery);await target.tick(3)
 const final=await repo.snapshot()
 assert.ok(final.files.has('dss-coop/records/'+taskId+'/manifest.json'))
 assert.equal([...final.files.keys()].some(path=>path.startsWith(taskPath(taskId)+'/')),false)
 const conversation=await conversationPage(repo,new MemoryStore(),final,'1')
 assert.ok(conversation.messages.some(message=>message.text==='Recovered blocked task; all three artifacts accepted and delivered.'))
 const manifest=(await readJson<{recordsPath:string}>(repo,final,'dss-coop/records/'+taskId+'/manifest.json'))!
 const records=await readText(repo,final,manifest.recordsPath)
 assert.ok(records.includes(fixtureReply));assert.ok(records.includes('Verify isolated synthetic artifact only'))
 assert.equal(target.agents.starts.filter(a=>a.binding.role==='worker').length,4,'one blocked, one revised, two dependent Workers only')
})

test('blocked-result recovery: pause/resume then authorized goal revision does not require a duplicate claim handshake',async()=>{
 for(const reclaim of [false,true]){
  const {repo,target,worker,reviewer}=await blockedFixture(),taskId=reviewer.binding.taskId!
  // Upgrade/recovery fixture: preserve a false-ready outcome already committed by formal v0.3.6.
  const memory=await write(target,reviewer,{op:'entry',id:'legacy-memory',kind:'memory',text:'Saved historical no-review done'})
  const planFile=planPath(taskId,'1',target.cache.instanceId)
  const legacyPlan=(await readJson<ParticipantPlan>(repo,await repo.snapshot(),planFile))!
  const saved:RoleOutcome={binding:reviewer.binding,kind:'plan_ready',turn_signal:'done',textPath:memory.textPath!,memoryPath:memory.textPath,
   prerequisitePaths:[],createdAt:new Date().toISOString(),observedTrigger:await plannerTrigger(repo,await repo.snapshot(),taskId,'1',reviewer.binding)}
  await repo.seed([{path:reviewer.binding.outputPath,content:json(saved)},{path:statusPath(reviewer.binding,'completed'),content:json({version:1,kind:'completed',binding:reviewer.binding,turn_signal:'done',outcomePath:reviewer.binding.outputPath})},
   {path:planFile,content:json({...legacyPlan,revision:2,writer:reviewer.binding})}])
  target.agents.finish(reviewer);await target.tick(3)
  await input(repo,target,'pause-revised','Pause the task');await target.tick(2)
  const pause=target.agents.latest('foreground')
  await write(target,pause,{op:'control',id:'pause',taskId,expectedRevision:1,state:'pause'})
  await write(target,pause,{op:'outcome',id:'out',turn_signal:'respond',text:'Paused',prerequisitePaths:[]})
  target.agents.finish(pause);await target.tick(2)
  await input(repo,target,'resume-revised','Resume with the revised authorized artifact source');await target.tick(2)
  const foreground=target.agents.latest('foreground')
  await write(target,foreground,{op:'control',id:'resume',taskId,expectedRevision:2,state:'resume'})
  await write(target,foreground,{op:'revise',id:'revise',taskId,expectedRevision:1,goal:'Use the explicitly authorized synthetic source; preserve the bounded goal'})
  await write(target,foreground,{op:'outcome',id:'handoff',turn_signal:'handoff_planner',taskId,text:'Continue revised goal',prerequisitePaths:[]})
  target.agents.finish(foreground);await target.tick(3)
  const resumed=target.agents.latest('planner')
  assert.equal(resumed.binding.epoch,4)
  assert.equal(target.agents.starts.filter(a=>a.binding.role==='worker').length,1,'new goal must not dispatch old directions before normal Planner review')
  const join=await readJson<any>(repo,await repo.snapshot(),joinPath(taskId,'1',target.cache.instanceId))
  const claimFile=taskPath(taskId)+'/participants/1/instances/'+target.cache.instanceId+'/claims/part.json'
  const claim=await readJson<any>(repo,await repo.snapshot(),claimFile)
  assert.equal(join.goalRevision,2);assert.equal(join.revision,4);assert.equal(claim.joinRevision,3)
  if(reclaim)await write(target,resumed,{op:'claim',id:'fresh-claim',workId:'part',assignmentVersion:1,scope:'Accept current revised synthetic goal and bounded work'})
  await write(target,resumed,{op:'review',id:'review-old-blocker',childId:'baseline',expectedRevision:2,resultExecutionId:worker.binding.executionId,accepted:false,
   review:{...review,decision:'Rework against revised authorized input'},nextDirection:'Verify explicitly authorized synthetic source'})
  await write(target,resumed,{op:'outcome',id:'rework',turn_signal:'rework',text:'Reviewed old blocker for current child; direction updated',prerequisitePaths:[]})
  target.agents.finish(resumed);await target.tick(6)
  const workers=target.agents.starts.filter(a=>a.binding.role==='worker')
  assert.equal(workers.length,2)
  assert.equal(workers.at(-1)!.binding.epoch,4);assert.equal(workers.at(-1)!.binding.childRevision,2)
  console.log(JSON.stringify({case:'pause-resume-revise',reclaim,joinRevision:join.revision,claimRevisionBefore:claim.joinRevision,epoch:resumed.binding.epoch,workerStarts:workers.length}))
 }
})

test('gate cleanup: bounded participant_plan accepts owned assignment without a separate claim call',async()=>{
 const repo=new MemoryRepo(),target=instance(repo),planner=await root(repo,target)
 await write(target,planner,{op:'root_plan',id:'work',expectedRevision:0,works:[{id:'part',title:'Part',direction:'Bounded',acceptance:'Verify',participantId:'1',instanceId:target.cache.instanceId,version:1}]})
 await write(target,planner,{op:'participant_plan',id:'plan',expectedRevision:0,children:[{id:'child',workId:'part',assignmentVersion:1,title:'Child',direction:'Actual authorized work',acceptance:'Check',dependencies:[]}]})
 const claim=await readJson<any>(repo,await repo.snapshot(),taskPath(planner.binding.taskId!)+'/participants/1/instances/'+target.cache.instanceId+'/claims/part.json')
 assert.equal(claim.joinRevision,1);assert.equal(claim.assignmentVersion,1)
 await write(target,planner,{op:'outcome',id:'ready',turn_signal:'done',text:'Bounded directions ready, no redundant claim handshake',prerequisitePaths:[]})
 target.agents.finish(planner);await target.tick(3)
 assert.equal(target.agents.latest('worker').binding.childId,'child')
})

test('gate cleanup: same-goal foreground continuation is replay-safe without rejoining or cancelling live Worker',async()=>{
 const repo=new MemoryRepo(),target=instance(repo),first=await root(repo,target),taskId=first.binding.taskId!
 await write(target,first,{op:'root_plan',id:'work',expectedRevision:0,works:[{id:'part',title:'Part',direction:'Bounded',acceptance:'Verify',participantId:'1',instanceId:target.cache.instanceId,version:1}]})
 await write(target,first,{op:'participant_plan',id:'plan',expectedRevision:0,children:[{id:'child',workId:'part',assignmentVersion:1,title:'Child',direction:'Actual authorized work',acceptance:'Check',dependencies:[]}]})
 await write(target,first,{op:'outcome',id:'out',turn_signal:'done',text:'Ready',prerequisitePaths:[]});target.agents.finish(first);await target.tick(2)
 const worker=target.agents.latest('worker'),before=await readJson<any>(repo,await repo.snapshot(),joinPath(taskId,'1',target.cache.instanceId))
 await input(repo,target,'continue-same','Continue the same goal; inspect the new supplied evidence without restarting work.');await target.tick(2)
 const foreground=target.agents.latest('foreground')
 const reply=await write(target,foreground,{op:'entry',id:'reply',kind:'reply',text:'Same goal continuation received'})
 const final:CoopCommand={op:'outcome',id:'handoff',turn_signal:'handoff_planner',taskId,replyPath:reply.textPath,prerequisitePaths:[]}
 await write(target,foreground,final);await write(target,foreground,final)
 target.agents.finish(foreground);await target.tick(4)
 const after=await readJson<any>(repo,await repo.snapshot(),joinPath(taskId,'1',target.cache.instanceId))
 assert.deepEqual(after,before,'same-goal request does not mutate participation revision/epoch')
 assert.equal(target.agents.starts.filter(a=>a.binding.role==='worker').length,1)
 assert.equal(target.agents.state(worker.binding.executionId)?.busy,true)
 const planner=target.agents.latest('planner');assert.notEqual(planner.binding.executionId,first.binding.executionId)
 const context:any=await target.consumer.context(await repo.snapshot(),planner)
 const paths=[...repo.files.keys()].filter(p=>p.startsWith(context.requestsPrefix)&&p.endsWith('.json'))
 assert.equal(paths.length,2,'initial handoff plus one idempotent continuation')
 const request=await readJson<any>(repo,await repo.snapshot(),paths.find(path=>path.includes(foreground.binding.executionId))!)
 const original=await readCoopRecord(repo,target.cache.settings,CoopReadSchema.parse({path:request.inputPath}))
 assert.match(original.text!,/Continue the same goal/,'source survives intent cleanup')
 await write(target,planner,{op:'outcome',id:'wait',turn_signal:'wait',text:'Current Worker remains live; no restart needed',prerequisitePaths:[]})
 target.agents.finish(planner);await target.tick(5)
 assert.equal(target.agents.starts.filter(a=>a.binding.role==='planner').length,2)
})

test('gate cleanup: saved false-ready result resumes one generation across cold consumers; explicit wait stops recovery',async()=>{
 const {repo,target,worker,reviewer}=await blockedFixture(),taskId=reviewer.binding.taskId!
 const memory=await write(target,reviewer,{op:'entry',id:'legacy-memory',kind:'memory',text:'Historical formal false-ready'})
 const planFile=planPath(taskId,'1',target.cache.instanceId),plan=(await readJson<ParticipantPlan>(repo,await repo.snapshot(),planFile))!
 const saved:RoleOutcome={binding:reviewer.binding,kind:'plan_ready',turn_signal:'done',textPath:memory.textPath!,memoryPath:memory.textPath,prerequisitePaths:[],createdAt:new Date().toISOString(),observedTrigger:await plannerTrigger(repo,await repo.snapshot(),taskId,'1',reviewer.binding)}
 await repo.seed([{path:reviewer.binding.outputPath,content:json(saved)},{path:statusPath(reviewer.binding,'completed'),content:json({version:1,kind:'completed',binding:reviewer.binding,turn_signal:'done',outcomePath:reviewer.binding.outputPath})},
  {path:actionPath(reviewer.binding),content:json({...reviewer,state:'closed'})},{path:planFile,content:json({...plan,revision:2,writer:reviewer.binding})}])
 await target.agents.dispose()
 const boot1=new Agents(),cold1=new CoopConsumer({repo,cache:target.cache,journal:()=>target.journal,agents:boot1,wake(){}})
 await cold1.consume(await repo.snapshot())
 const replaced=(await readJson<RoleAction>(repo,await repo.snapshot(),actionPath(reviewer.binding)))!
 assert.equal(replaced.binding.generation,2);assert.notEqual(replaced.binding.executionId,reviewer.binding.executionId)
 const boot2=new Agents(),cold2=new CoopConsumer({repo,cache:target.cache,journal:()=>target.journal,agents:boot2,wake(){}})
 for(let n=0;n<5;n++)await cold2.consume(await repo.snapshot())
 assert.equal(boot2.starts.length,1);assert.deepEqual(boot2.starts[0].binding,replaced.binding)
 await write(target,replaced,{op:'outcome',id:'explicit-wait',turn_signal:'wait',text:'Blocked on a genuine external dependency, not falsely ready',prerequisitePaths:[]})
 boot2.finish(replaced);for(let n=0;n<4;n++)await cold2.consume(await repo.snapshot())
 const boot3=new Agents(),cold3=new CoopConsumer({repo,cache:target.cache,journal:()=>target.journal,agents:boot3,wake(){}})
 for(let n=0;n<5;n++)await cold3.consume(await repo.snapshot())
 assert.equal(boot3.starts.length,0);assert.equal((await readJson<RoleAction>(repo,await repo.snapshot(),actionPath(reviewer.binding)))!.binding.generation,2)
 assert.equal((await readOutcome(repo,await repo.snapshot(),worker.binding))!.resultStatus,'failed')
})

test('identity isolation: a same-account different-instance Worker with the same child name cannot satisfy this review',async()=>{
 const {repo,target,worker,reviewer}=await blockedFixture()
 const foreign={...worker.binding,instanceId:'other-instance',actionId:'foreign-action',executionId:'foreign-execution',sessionId:'foreign-session',fence:'foreign-fence',outputPath:''}
 foreign.outputPath=executionPath(foreign)+'/outcome.json'
 const outcome:RoleOutcome={binding:foreign,kind:'result',turn_signal:'complete',resultStatus:'done',textPath:foreign.outputPath+'/text',prerequisitePaths:[],createdAt:new Date().toISOString()}
 await repo.seed([{path:actionPath(foreign),content:json({...worker,id:foreign.actionId,binding:foreign,state:'closed'})},
  {path:foreign.outputPath,content:json(outcome)},{path:statusPath(foreign,'completed'),content:json({version:1,kind:'completed',binding:foreign,turn_signal:'complete',outcomePath:foreign.outputPath})}])
 assert.equal((await readOutcome(repo,await repo.snapshot(),foreign))!.resultStatus,'done','foreign execution is a valid independent result')
 await assert.rejects(write(target,reviewer,{op:'review',id:'wrong-instance',childId:'baseline',expectedRevision:1,resultExecutionId:foreign.executionId,accepted:true,review}),/exact current child result/)
 const current=(await readJson<ParticipantPlan>(repo,await repo.snapshot(),planPath(reviewer.binding.taskId!,'1',target.cache.instanceId)))!
 assert.equal(current.children[0].state,'pending');assert.equal(current.children[0].revision,1)
})

test('goal consistency: upgraded plan without goal stamp gets one normal review; old Worker result cannot overwrite revised directions',async()=>{
 const repo=new MemoryRepo(),target=instance(repo),first=await root(repo,target),taskId=first.binding.taskId!
 await write(target,first,{op:'root_plan',id:'work',expectedRevision:0,works:[{id:'part',title:'Part',direction:'Original direction',acceptance:'Verify',participantId:'1',instanceId:target.cache.instanceId,version:1}]})
 await write(target,first,{op:'participant_plan',id:'plan',expectedRevision:0,children:[{id:'child',workId:'part',assignmentVersion:1,title:'Child',direction:'Original direction',acceptance:'Check',dependencies:[]}]})
 await write(target,first,{op:'outcome',id:'ready',turn_signal:'done',text:'Original directions ready',prerequisitePaths:[]});target.agents.finish(first);await target.tick(3)
 const oldWorker=target.agents.latest('worker'),path=planPath(taskId,'1',target.cache.instanceId)
 const oldPlan=(await readJson<ParticipantPlan>(repo,await repo.snapshot(),path))!;delete oldPlan.goalRevision
 await repo.seed([{path,content:json(oldPlan)}]) // Saved pre-upgrade plan shape; no outcome is fabricated.
 await input(repo,target,'changed-goal','Use the revised authorized artifact instead.');await target.tick(2)
 const foreground=target.agents.latest('foreground')
 await write(target,foreground,{op:'revise',id:'revise',taskId,expectedRevision:1,goal:'Use the revised authorized artifact only'})
 await write(target,foreground,{op:'outcome',id:'handoff',turn_signal:'handoff_planner',taskId,text:'Real goal revision accepted',prerequisitePaths:[]})
 target.agents.finish(foreground);await target.tick(4)
 assert.equal(target.agents.starts.filter(a=>a.binding.role==='worker').length,1,'unknown old goal binding is not dispatched')
 const reviewer=target.agents.latest('planner');assert.equal(reviewer.binding.epoch,2)
 await assert.rejects(write(target,oldWorker,{op:'outcome',id:'late',turn_signal:'complete',text:'Late old-goal result',prerequisitePaths:[]}),/replaced|ended|generation/)
 await target.consumer.writer.retryDrafts()
 assert.equal(await readOutcome(repo,await repo.snapshot(),oldWorker.binding),undefined)
 await write(target,reviewer,{op:'participant_plan',id:'new-direction',expectedRevision:1,children:[{id:'child',workId:'part',assignmentVersion:1,title:'Child',direction:'Revised authorized artifact only',acceptance:'Check revised artifact',dependencies:[]}]})
 await write(target,reviewer,{op:'outcome',id:'ready',turn_signal:'rework',text:'Current-goal directions verified; no extra claim or acknowledgement',prerequisitePaths:[]})
 target.agents.finish(reviewer);await target.tick(4)
 const next=target.agents.latest('worker');assert.equal(next.binding.epoch,2);assert.equal(next.binding.childRevision,2)
 assert.equal((next.input as any).child.direction,'Revised authorized artifact only')
 const current=(await readJson<ParticipantPlan>(repo,await repo.snapshot(),path))!;assert.equal(current.goalRevision,2)
 await target.tick(8);assert.equal(target.agents.starts.filter(a=>a.binding.role==='worker').length,2)
})

test('assignment ownership: removing duplicate claim does not allow another instance assigned work to enter this plan',async()=>{
 const repo=new MemoryRepo(),target=instance(repo),planner=await root(repo,target)
 await write(target,planner,{op:'root_plan',id:'foreign-work',expectedRevision:0,works:[{id:'foreign',title:'Other instance',direction:'Not this instance',acceptance:'Other verifier',participantId:'1',instanceId:'other-instance',version:1}]})
 await assert.rejects(write(target,planner,{op:'participant_plan',id:'bad-plan',expectedRevision:0,children:[{id:'same-name',workId:'foreign',assignmentVersion:1,title:'Same child name',direction:'Must not run here',acceptance:'Check',dependencies:[]}]}),/owned by this participant and instance/)
 assert.equal(await readJson(repo,await repo.snapshot(),planPath(planner.binding.taskId!,'1',target.cache.instanceId)),undefined)
})

import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
async function runningChildFixture(){
 const repo=new MemoryRepo(),target=instance(repo),planner=await root(repo,target),taskId=planner.binding.taskId!
 await write(target,planner,{op:'root_plan',id:'work',expectedRevision:0,works:[{id:'part',title:'Artifact',direction:'Create and verify isolated artifact',acceptance:'Exact bytes',participantId:'1',instanceId:target.cache.instanceId,version:1}]})
 await write(target,planner,{op:'participant_plan',id:'plan',expectedRevision:0,children:[{id:'child',workId:'part',assignmentVersion:1,title:'Artifact',direction:'Create and verify isolated artifact',acceptance:'Exact bytes',dependencies:[]}]})
 await write(target,planner,{op:'outcome',id:'ready',turn_signal:'done',text:'Bounded artifact work ready',prerequisitePaths:[]});target.agents.finish(planner);await target.tick(3)
 return {repo,target,taskId,worker:target.agents.latest('worker')}
}

test('interrupt boundaries: reply-only, prepared outcome and published status survive resume/revise/cancel without duplicate artifact writes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dss-interrupt-ledger-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 for(const point of ['reply','outcome','status'])for(const transition of ['resume','revise','cancel']){
  const {repo,target,taskId,worker}=await runningChildFixture()
  const artifact=join(dir,point+'-'+transition+'.json'),ledger=artifact+'.ledger'
  const bytes=JSON.stringify({point,transition,semanticArtifact:'created-once'})+'\n'
  const createOrReuse=async()=>{const existing=await readFile(artifact,'utf8').catch(()=>undefined);if(existing!==undefined){assert.equal(digest(existing),digest(bytes));return}
   await writeFile(artifact,bytes);await appendFile(ledger,JSON.stringify({effect:'create',sha256:digest(bytes)})+'\n')}
  await createOrReuse()
  await input(repo,target,'control-'+point+'-'+transition,'Apply the requested '+transition+' operation to this task');await target.tick(2)
  const controller=target.agents.latest('foreground')
  const reply=await write(target,worker,{op:'entry',id:'reply',kind:'reply',text:JSON.stringify({artifact,sha256:digest(bytes),remaining:'verify current goal before accepting'})})
  const finish:CoopCommand={op:'outcome',id:'result',turn_signal:'complete',replyPath:reply.textPath,prerequisitePaths:[]}
  if(point==='outcome'){
   const commit=repo.commit.bind(repo)
   repo.commit=async(base,changes)=>{const receipt=await commit(base,changes);if(changes.some(change=>change.path===worker.binding.outputPath))repo.offline=true;return receipt}
   await assert.rejects(write(target,worker,finish),/network unavailable/);repo.offline=false;repo.commit=commit
   assert.ok(await repo.read(await repo.snapshot(),worker.binding.outputPath));assert.equal(await readOutcome(repo,await repo.snapshot(),worker.binding),undefined)
  }else if(point==='status')await write(target,worker,finish)
  await write(target,controller,{op:'control',id:'control',taskId,expectedRevision:1,state:transition==='cancel'?'cancel':'pause'})
  await write(target,controller,{op:'outcome',id:'respond',turn_signal:'respond',text:'Requested control applied',prerequisitePaths:[]});target.agents.finish(controller)
  await target.consumer.writer.retryDrafts();await target.tick(4)
  assert.equal(target.agents.starts.filter(action=>action.binding.role==='worker').length,1)
  assert.equal(!!await readOutcome(repo,await repo.snapshot(),worker.binding),point!=='reply','reply alone is never promoted; committed outcome can finish publication after control')
  await assert.rejects(write(target,worker,{op:'entry',id:'late-write',kind:'reply',text:'Old role must not write new semantic content'}),/replaced|ended|cancelled|generation/)
  await target.consumer.writer.retryDrafts()
  if(transition==='cancel'){
   await target.tick(4);assert.equal(target.agents.starts.filter(action=>action.binding.role==='worker').length,1)
  }else{
   await input(repo,target,'resume-'+point+'-'+transition,'Continue the same bounded artifact task');await target.tick(2)
   const foreground=target.agents.latest('foreground')
   await write(target,foreground,{op:'control',id:'resume',taskId,expectedRevision:2,state:'resume'})
   if(transition==='revise')await write(target,foreground,{op:'revise',id:'revise',taskId,expectedRevision:1,goal:'Verify the existing isolated artifact against the revised criterion; never repeat its creation'})
   await write(target,foreground,{op:'outcome',id:'respond',turn_signal:'respond',text:'Authorized continuation',prerequisitePaths:[]});target.agents.finish(foreground);await target.tick(4)
   let planner=target.agents.latest('planner')
   if(point!=='reply'){
    assert.equal(target.agents.starts.filter(action=>action.binding.role==='worker').length,1,'published evidence is reviewed, not blindly rerun after epoch change')
    const context:any=await target.consumer.context(await repo.snapshot(),planner)
    assert.equal(context.pendingWorkerResults.length,1);assert.equal(context.pendingWorkerResults[0].priorEpoch,true)
    const record=await readCoopRecord(repo,target.cache.settings,CoopReadSchema.parse({path:context.pendingWorkerResults[0].textPath}))
    const evidence=JSON.parse(record.text!);assert.equal(digest(await readFile(evidence.artifact,'utf8')),evidence.sha256)
    await write(target,planner,{op:'review',id:'review-published',childId:'child',expectedRevision:1,resultExecutionId:worker.binding.executionId,accepted:transition==='resume',review,
     ...(transition==='revise'?{nextDirection:'Inspect existing artifact '+artifact+' for the revised criterion; do not recreate it'}:{})})
    await write(target,planner,{op:'outcome',id:'next',turn_signal:transition==='resume'?'wait':'rework',text:'Existing result explicitly reviewed against current goal',prerequisitePaths:[]})
    target.agents.finish(planner);await target.tick(4)
   }else{
    if(transition==='revise'){
     assert.equal(target.agents.starts.filter(action=>action.binding.role==='worker').length,1,'old goal direction stays stopped until normal Planner update')
     await write(target,planner,{op:'participant_plan',id:'revised-direction',expectedRevision:1,children:[{id:'child',workId:'part',assignmentVersion:1,title:'Artifact',direction:'Inspect existing artifact '+artifact+' against revised goal without recreating it',acceptance:'Check revised criterion',dependencies:[]}]})
     await write(target,planner,{op:'outcome',id:'rework',turn_signal:'rework',text:'Current goal direction saved',prerequisitePaths:[]})
    }else await write(target,planner,{op:'outcome',id:'wait',turn_signal:'wait',text:'Interrupted Worker is resuming saved artifact inspection',prerequisitePaths:[]})
    target.agents.finish(planner);await target.tick(4)
   }
   if(point==='reply'||transition==='revise'){
    const resumed=target.agents.latest('worker');assert.notEqual(resumed.binding.executionId,worker.binding.executionId)
    if(transition==='resume'){
     const context:any=await target.consumer.context(await repo.snapshot(),resumed)
     assert.equal(context.priorWorkerExecutions.length,1);assert.equal(context.priorWorkerExecutions[0].outcomePublished,false)
     const directory=await readCoopRecord(repo,target.cache.settings,CoopReadSchema.parse({path:context.priorWorkerExecutions[0].recordsPrefix}))
     assert.ok(directory.paths?.includes(reply.textPath+'/manifest.json'))
     const checkpoint=await readCoopRecord(repo,target.cache.settings,CoopReadSchema.parse({path:reply.textPath!}));assert.equal(JSON.parse(checkpoint.text!).sha256,digest(bytes))
    }
    await createOrReuse()
    await write(target,resumed,{op:'outcome',id:'complete',turn_signal:'complete',text:JSON.stringify({artifact,sha256:digest(bytes),reused:true}),prerequisitePaths:[]})
    target.agents.finish(resumed);await target.tick(4)
    assert.equal((await readOutcome(repo,await repo.snapshot(),resumed.binding))!.resultStatus,'done')
   }
  }
  assert.equal((await readFile(ledger,'utf8')).trim().split('\n').length,1)
  assert.equal(digest(await readFile(artifact,'utf8')),digest(bytes))
  console.log(JSON.stringify({case:'control-boundary',point,transition,actualArtifactWrites:1,sha256:digest(bytes),originalResultPublished:point!=='reply'}))
 }
})

test('native completion race: stale consume snapshots and CAS retries never replace an already saved exact result',async()=>{
 for(const arrival of ['before-consume','during-recovery-cas','prepared-only']){
  const {repo,target,worker}=await runningChildFixture()
  const reply=await write(target,worker,{op:'entry',id:'reply',kind:'reply',text:'Verified artifact remains available'})
  const command:CoopCommand={op:'outcome',id:'completed',turn_signal:'complete',replyPath:reply.textPath,prerequisitePaths:[]}
  const stale=await repo.snapshot(),commit=repo.commit.bind(repo)
  if(arrival==='during-recovery-cas'){
   let injected=false
   repo.commit=async(base,changes)=>{
    if(!injected&&changes.some(change=>change.path===executionPath(worker.binding)+'/incident.json')){
     injected=true
     const concurrent=new RoleWriter(repo,new GitJournal(repo,'1'),target.cache)
     await concurrent.execute(worker.binding,command)
    }
    return commit(base,changes)
   }
  }else if(arrival==='prepared-only'){
   repo.commit=async(base,changes)=>{const receipt=await commit(base,changes);if(changes.some(change=>change.path===worker.binding.outputPath))repo.offline=true;return receipt}
   await assert.rejects(write(target,worker,command),/network unavailable/)
   repo.offline=false;repo.commit=commit
   // Simulate a cold cache after the durable body: recovery must use Git, not a draft.
   for(const [key] of target.cache.entries('draft/'))await target.cache.remove(key)
  }else await write(target,worker,command)
  target.agents.finish(worker)
  await target.consumer.consume(stale)
  repo.commit=commit
  const after=(await readJson<RoleAction>(repo,await repo.snapshot(),actionPath(worker.binding)))!
  assert.deepEqual(after.binding,worker.binding,arrival+': keep the published execution identity')
  assert.equal(await repo.read(await repo.snapshot(),executionPath(worker.binding)+'/incident.json'),undefined)
  assert.equal(target.cache.get('native-error/'+worker.id),undefined,'a successful result is not a native failure')
  assert.equal(target.cache.get('replacement/'+worker.binding.executionId),undefined)
  await target.tick(4)
  assert.equal((await readOutcome(repo,await repo.snapshot(),worker.binding))!.resultStatus,'done')
  assert.equal(target.agents.starts.filter(action=>action.binding.role==='worker').length,1)
  const context:any=await target.consumer.context(await repo.snapshot(),target.agents.latest('planner'))
  assert.equal(context.pendingWorkerResults[0].resultExecutionId,worker.binding.executionId)
 }
})

test('prepared outcome recovery rejects replaced execution, wrong operation, and corrupt body instead of inventing completion',async()=>{
 for(const fault of ['replaced','wrong-operation','corrupt-body']){
  const {repo,target,worker}=await runningChildFixture()
  const reply=await write(target,worker,{op:'entry',id:'reply',kind:'reply',text:'Actual saved evidence'})
  const commit=repo.commit.bind(repo)
  repo.commit=async(base,changes)=>{const receipt=await commit(base,changes);if(changes.some(change=>change.path===worker.binding.outputPath))repo.offline=true;return receipt}
  await assert.rejects(write(target,worker,{op:'outcome',id:'result',turn_signal:'complete',replyPath:reply.textPath,prerequisitePaths:[]}),/network unavailable/)
  repo.offline=false;repo.commit=commit
  if(fault==='replaced'){
   const replacement={...worker.binding,executionId:'replacement',fence:'replacement-fence',generation:2,outputPath:''}
   replacement.outputPath=executionPath(replacement)+'/outcome.json'
   await repo.seed([{path:actionPath(worker.binding),content:json({...worker,binding:replacement})}])
  }else if(fault==='corrupt-body')await repo.seed([{path:reply.textPath+'/parts/000000.txt',content:'Not the committed evidence'}])
  await assert.rejects(target.consumer.writer.completeOutcome(worker.binding,fault==='wrong-operation'?'another-operation':'result'),fault==='corrupt-body'?/integrity mismatch/:/replaced execution|bound remote result/)
  assert.equal(await repo.read(await repo.snapshot(),statusPath(worker.binding,'completed')),undefined)
 }
})
