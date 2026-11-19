import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { evidence, hash } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
import { Repository, head } from './test-support/controlled-git/repository.mjs'
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { FrameworkService } = await import('../src/framework/service.ts')
const { FrameworkClientController } = await import('../src/framework/client-contracts.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const { GitAuthorityStore, SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { GitConflictError } = await import('../src/experimental/private-git/github.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { Context } = await import('@deepseek-ai/cordis')
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { SessionStore } = await import('@deepseek-ai/dsh-session')
const { LlmRuntime } = await import('@deepseek-ai/dsh-llm')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { AgentRegistry } = await import('@deepseek-ai/dsh-agent')
const { AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'foreground-wake-retirement-'))
const results = [], checks = [], opened = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const tick = () => new Promise(setImmediate)
let sequence = 0
async function fixture(mode, name) {
  const dir = path.join(scratch, mode + '-' + name), sdk = await openDshStorageFixture(path.join(dir, 'technical'), path.join(dir, 'locator'))
  const repo = mode === 'git' ? new Repository() : undefined
  if (repo) {
    head(repo); const commit = repo.commitPrepared.bind(repo)
    repo.commitPrepared = async (s, c, m, o) => { if (repo.head !== o.expectedHead && !repo.accepted.has(o.id)) throw new GitConflictError(); return commit(s, c, m, o) }
  }
  const files = repo ? new GitFiles(repo, new SessionGitOperations()) : new PhysicalLocalFiles(path.join(dir, 'files'))
  const records = repo ? new GitAuthorityStore(files, name) : sdk.adapter, tx = new FrameworkTransactions(files, records, name)
  const conversation = new FrameworkConversation(files, tx, { mode, collaborationId: name })
  const rt = Object.create(FrameworkRoleRuntime.prototype), errors = [], retirements = [], sessions = new Map(), handles = new Map()
  const projection = new Context(); new SessionProjectionRegistry(projection)
  new SessionStore(projection); new LlmRuntime(projection); new SystemPrompt(projection, {}); new ToolRuntime(projection)
  await projection.plugin(AgentRegistry).await()
  await projection.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await()
  const add = (owned, type, data, extra = {}) => { const event = { type, data, seq: owned.events.length, time: Date.now(), ...extra }; owned.events.push(event); return event }
  const native = {
    get(workId) { return handles.get(workId) },
    async open(identity, options) {
      let owned = handles.get(identity.workId)
      if (owned?.sessionId === options.sessionId) return owned
      const events = [], session = { id: options.sessionId, header: {}, get seq() { return events.length }, inheritedEventCount: 0, snapshotEvents: () => structuredClone(events), requestContext: () => ({}) }
      const actual = { id: options.sessionId, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
      owned = { identity, events, sessionId: options.sessionId, actualAgent: actual, observe: () => ({ state: actual.status }),
        hasMessage: id => events.some(event => event.type === 'user/message' && event.data.id === id),
        async send(text, id, delivery) {
          await native.beforeSend?.(owned, id)
          if (!owned.hasMessage(id)) {
            if (delivery !== 'inject') { add(owned, 'turn/start', { turn: 1 }); actual.status = 'running' }
            add(owned, 'user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'deepseek-servant' } }, { surfaceOp: 'append' })
          }
        } }
      sessions.set(options.sessionId, session); handles.set(identity.workId, owned); return owned
    },
    async stop(workId) { const owned = handles.get(workId); if (owned) owned.actualAgent.status = 'idle'; handles.delete(workId); return { status: 'stopped' } },
  }
  const config = { scope: name, mode, member: 'A', primary: true, instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', collaborationId: name, workerSeats: 1, workspace: dir }
  const ctx = { agents: { get: () => undefined }, sessions: { get: id => sessions.get(id), flush: async () => {} }, jobs: { list: () => [] },
    get: key => key === 'sessionProjections' ? projection.sessionProjections : key === 'sessionPersistence' ? { stat: async id => sessions.has(id) ? { sizeBytes: 1 } : undefined }
      : key === 'nativeSessionCleaner' ? { async retire(id) { retirements.push(id) } } : key === 'jobs' ? { list: () => [] } : undefined }
  Object.assign(rt, { files, records, transactions: tx, conversation, config, ctx, native, prefix: 'framework-runtime/' + hash(name) + '/',
    gateway: { exists: async id => sessions.has(id) }, workspaces: { hasBinding: () => false },
    environment: { members: () => ['A'], resources: () => [], changed() {} }, error: error => errors.push(error), ownedAsyncContext: AsyncLocalStorage.snapshot(),
    roleRecords: new Map(), roleBases: new Map(), roleWrites: new Map(), roleWriteOwners: new Map(), wakeWrites: new Map(), wakeWriteOwners: new Map(), wakeConsumptions: new Map(),
    safetyEpisodes: new Map(), safetyReplayed: new Set(), safetySettlements: new Map(), resolvedSafetyFaultIds: new Set(), gitPriorExecutions: new Set(),
    admissions: new Map(), admissionCancellations: new Map(), localWakeAdmissions: new Map(), admissionObservationVersion: 0, admissionNow: () => Date.now(), workOperations: new Map(), observationRecordWrites: new Map(), stopOperations: new Map(),
    restoreWriteOwners: new Map(), safetyRestoreWrites: new Map(), publishedHelperSignals: new Set(), conversationSendSources: new Map(),
    foregroundProcesses: new Map(), taskNotices: new WeakMap(), taskNoticeObservations: new WeakMap(), taskNoticeClock: 0,
    controls: { execution: async () => undefined }, observations: { unbind: async () => {} }, pendingControlStops: [], closed: false,
  })
  const service = Object.assign(Object.create(FrameworkService.prototype), { modeSending: new Map(), conversationBarriers: new Map(), initializing: Promise.resolve(),
    assertOpen() {}, checkScope() {}, config: () => ({ settings: { collaborationId: name, userName: 'A' } }),
    access: async () => ({ conversation, connection: { files, scope: name, prepareWrite: async () => {}, identity: { login: 'A' }, ...(mode === 'git' ? { repository: { identity: { id: 'account-a', login: 'A' } } } : {}) } }),
    prepareConversationWrite: async () => {}, changed() {} })
  const client = new FrameworkClientController({ send: input => service.send(input) })
  const host = new FrameworkHostLoop(files, tx, records, config, () => ['A'], { startup: async () => {}, observe: async () => {}, executing: role => rt.executing(role),
    wake: request => rt.wake(request), notifyForeground: sources => rt.notifyForeground(sources), error: error => errors.push(error) })
  const own = () => rt.roleRecords.get(rt.roleKey('Foreground'))
  const input = async text => {
    const id = name + '-input-' + ++sequence
    await client.send({ mode, collaborationId: name, id, createdAt: new Date(1800000000000 + sequence * 1000).toISOString(), text, recipient: 'ai', device: 'controlled-client', timezoneOffsetMinutes: 0 })
    await Promise.all(await host.runSignalPoll())
    return id
  }
  const drain = async () => { for (;;) { const work = [...rt.nativeRetirementOperations?.values() ?? [], ...rt.roleWrites.values(), ...rt.wakeWrites.values(), ...rt.stopOperations.values()].map(value => value?.promise ?? value); if (!work.length) break; await Promise.allSettled(work); for (const [key, value] of rt.stopOperations) if (value.settled) rt.stopOperations.delete(key); await tick() } }
  const call = async (name, args) => {
    const owner = own(), owned = native.get(owner.identity.workId), tools = new Map(), toolContext = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
    installFrameworkRoleTools(toolContext, owned.actualAgent, rt.binding(owner, owner.delivery.request), rt.services())
    const callId = 'call-' + ++sequence
    add(owned, 'tool/call', { callId, name, arguments: JSON.stringify(args), turn: 1, step: 0 })
    const result = await tools.get(name).execute(args, { agent: owned.actualAgent, callId, signal: new AbortController().signal, concludeTurn() {} })
    add(owned, 'tool/result', { message: { id: 'result-' + callId, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }] }, turn: 1, step: 0 }, { surfaceOp: 'append' })
    return result
  }
  const finish = async (reason = 'completed', retained = false, wait = true) => {
    const owner = own(), owned = native.get(owner.identity.workId)
    add(owned, 'turn/end', { turn: 1, reason: reason === 'completed' ? { kind: 'completed' } : { kind: 'aborted', reason: { kind: 'user' } } }); owned.actualAgent.status = 'idle'
    if (retained) await rt.retainClosedRound(owner, owned); else await rt.finishForegroundRound(owner)
    if (wait) await drain()
  }
  const f = { rt, repo, records, files, tx, sdk, native, host, input, call, own, finish, drain, errors, retirements, sessions, handles,
    wakeKey: () => rt.prefix + 'wakes/' + hash(own().delivery.request.id), read: p => withSnapshot(files, s => files.read(s, p)),
    async close() { await drain(); await host.stop(); await tx.closeGitSession(new Error('Test complete')); await files.close?.(); await sdk.close() } }
  opened.push(f); return f
}

// Test-only trace around unchanged production methods. No product edits.
const attribution=new AsyncLocalStorage(),trace=[]
try {
 const f=await fixture('git','consecutive-clock-baseline')
 f.rt.reportedAdmissionDiagnostics=new Set();f.rt.environment.error=error=>f.errors.push(error)
 const persist=f.rt.persistLocalAdmission.bind(f.rt)
 f.rt.persistLocalAdmission=(key,state)=>attribution.run({kind:'admission-clock',wake:state.wake.request.id},()=>persist(key,state))
 for(const method of ['snapshot','read','commitPrepared']){
   const original=f.repo[method].bind(f.repo)
   f.repo[method]=async(...args)=>{
     const tag=attribution.getStore(),entry={method,tag,round:globalThis.testRound,path:method==='read'?args[1]:undefined}
     if(method==='commitPrepared')entry.changes=args[1].map(c=>({path:c.path,before:f.repo.views.get(args[0])?.get(c.path),after:c.content}))
     trace.push(entry);const result=await original(...args);entry.success=true;return result
   }
 }
 const drainAll=async()=>{await f.drain();while(f.rt.maintenance?.size)await Promise.all([...f.rt.maintenance.values()]);await f.drain()}
 for(let round=1;round<=3;round++){
   globalThis.testRound=round
   const id=await f.input('Consecutive ordinary Foreground round '+round)
   await f.rt.observeWakeAdmissions();await drainAll();
   await f.rt.runQueue();await drainAll()
   await f.call('dss_conversation_read',{mode:'context'})
   await f.call('dss_conversation_send',{id:'reply-'+id,text:'Complete '+round,intent:'human',responsePhase:'final'})
   await f.finish();await drainAll()
   check('round '+round+' completes normally',f.own().completedRound,true)
   check('round '+round+' wake retired',await f.records.get(f.wakeKey()),undefined)
 }
 check('clock observation reports no errors',f.errors.map(String),[]);
 const summary=[1,2,3].map(round=>({round,clockReads:trace.filter(e=>e.round===round&&e.tag?.kind==='admission-clock'&&e.method==='read').length,clockSnapshots:trace.filter(e=>e.round===round&&e.tag?.kind==='admission-clock'&&e.method==='snapshot').length,clockCommits:trace.filter(e=>e.round===round&&e.tag?.kind==='admission-clock'&&e.method==='commitPrepared').length}))
 const clockWrites=trace.filter(e=>e.tag?.kind==='admission-clock'&&e.method==='commitPrepared')
 for(const entry of clockWrites)for(const change of entry.changes){
   const before=JSON.parse(change.before),after=JSON.parse(change.after)
   const admission=after.value.admission;delete after.value.admission
   check('clock commit preserves every non-admission field',after,before)
   check('clock commit has queued timer only',Object.keys(admission).sort(),['eligibleSince','phase'])
 }
 check('first round no clock commit',summary[0].clockCommits,0)
 if(process.argv.includes('--expect-no-recurring-clock'))check('later rounds no clock commit',summary.slice(1).map(x=>x.clockCommits),[0,0])
 else check('baseline later rounds each commit one queue clock',summary.slice(1).map(x=>x.clockCommits),[1,1])
 globalThis.testRound=4
 const legacyInput=await f.input('Explicit legacy admission-marker regression fixture')
 const pending=(await f.records.list(f.rt.prefix+'wakes/')).find(row=>!row.value.delivered)
 check('legacy fixture has actual pending input',!!pending,true)
 await f.rt.updateWake(pending.key,current=>({...current,admission:{eligibleSince:1,phase:'queued'}}))
 await f.rt.observeWakeAdmissions();await drainAll()
 check('retained legacy marker is refreshed not suppressed',(await f.records.get(pending.key)).admission.eligibleSince>1,true)
 await f.rt.runQueue();await drainAll();console.error('ROUND',globalThis.testRound,'queue-done')
 check('native admission clears legacy clock',(await f.records.get(pending.key)).admission,undefined)
 await f.call('dss_conversation_read',{mode:'context'})
 await f.call('dss_conversation_send',{id:'reply-'+legacyInput,text:'Complete legacy regression',intent:'human',responsePhase:'final'})
 await f.finish();await drainAll();console.error('ROUND',globalThis.testRound,'finished')
 check('legacy wake completes and retires',await f.records.get(pending.key),undefined)
 console.log(JSON.stringify({status:'passed',summary,checks,trace,evidence:evidence(),limits:'Unchanged production lifecycle methods, real SDK storage; controlled exact-HEAD Git repository and native ports. Trace measures actual fixture transport calls/commits, NOT real HTTP requests, natural latency or live DSH/model.'},null,2))
}finally{await Promise.allSettled(opened.map(f=>f.close()));await fs.rm(scratch,{recursive:true,force:true})}
