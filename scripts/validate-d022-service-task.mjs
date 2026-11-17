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
const { taskCompletionSignals, paths, foregroundTaskSignal } = await import('../src/framework/task-files.ts')
const { taskHistoryChange, taskHistoryPath } = await import('../src/framework/task-history.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const { GitAuthorityStore, SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { GitConflictError } = await import('../src/experimental/private-git/github.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { Context } = await import('@deepseek-ai/cordis')
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
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
  projection.provide('agents', { setFactory: () => () => {} }); projection.provide('systemPrompt', { variable() {} })
  new AgentLoop(projection, { agents: [], maxParallelToolCalls: 1 })
  const add = (owned, type, data, extra = {}) => { const event = { type, data, seq: owned.events.length, time: Date.now(), ...extra }; owned.events.push(event); return event }
  const native = {
    get(workId) { return handles.get(workId) },
    async open(identity, options) {
      let owned = handles.get(identity.workId)
      if (owned?.sessionId === options.sessionId) return owned
      const events = [], session = { id: options.sessionId, header: {}, inheritedEventCount: 0, snapshotEvents: () => structuredClone(events), requestContext: () => ({}) }
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
  const service = Object.assign(Object.create(FrameworkService.prototype), { modeSending: new Map(), modeConfiguration: new Map(), conversationBarriers: new Map(), archiveViews: new Map(), saved: new Map(), initializing: Promise.resolve(), running: new Map([['local', { runtime: rt }]]),
    assertOpen() {}, checkScope() {}, config: () => ({ settings: { collaborationId: name, userName: 'A' } }),
    access: async () => ({ conversation, connection: { files, records, transactions: tx, scope: name, identity: { login: 'A', instanceUUID: config.instanceUUID }, prepareWrite: async () => {}, ...(mode === 'git' ? { repository: { identity: { id: 'account-a', login: 'A' } } } : {}) } }),
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
  const f = { rt, repo, records, files, tx, sdk, native, host, service, input, call, own, finish, drain, errors, retirements, sessions, handles,
    wakeKey: () => rt.prefix + 'wakes/' + hash(own().delivery.request.id), read: p => withSnapshot(files, s => files.read(s, p)),
    async close() { await drain(); await host.stop(); await tx.closeGitSession(new Error('Test complete')); await files.close?.(); await sdk.close() } }
  opened.push(f); return f
}
try {
  const f = await fixture('local', 'd022-task-chain')
  const first = await f.input('Original user request.'); await f.rt.runQueue()
  check('original foreground admitted', !!f.own(), true)
  await f.call('dss_conversation_read', { mode: 'context' })
  const preview = await f.service.cleanupPreview({ mode: 'local', storageScope: 'd022-task-chain', action: 'conversation' })
  check('preview pins original message', preview.messageIds.some(row => row.id === first), true)
  const second = await f.input('Later user request.');
  check('later request remains in same native execution', !!f.native.get(f.own().identity.workId), true)
  const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaab022'
  const task = { version: 1, taskId, route: 'P', owner: 'A', status: 'complete', sourcePath: `tasks/${taskId}_P.md`, archiveFolder: taskId, members: ['A'], lifecycleId: 'lifecycle-d022' }
  await f.files.replace(paths.task(taskId), JSON.stringify(task))
  for (const change of taskCompletionSignals(task)) await f.files.replace(change.path, change.content)
  check('actual root terminal producer signal', await f.read(foregroundTaskSignal(taskId)), '')
  await Promise.all(await f.host.runSignalPoll())
  check('active Host poll does not create another native wake', (await f.records.list(f.rt.prefix + 'wakes/')).length, 1)
  await f.call('dss_claim', {})
  check('registered claim consumes task source', await f.read(foregroundTaskSignal(taskId)), undefined)
  const owner = f.own()
  check('registered claim saves exact Task source', Object.values(owner.notificationClaims ?? {}).some(claim => claim.sources.some(source => source.path === foregroundTaskSignal(taskId))), true)
  await f.service.cleanupRecords({ mode: 'local', storageScope: 'd022-task-chain', action: 'conversation', commandId: 'd022-confirm-task', preview, confirmation: 'clear-foreground-conversation' })
  check('later user request preserved', (await f.rt.conversation.read(second)).text, 'Later user request.')
  check('original user request cleared', await f.rt.conversation.read(first), undefined)
  check('claimed Task signal republished', await f.read(foregroundTaskSignal(taskId)), '')
  check('original Foreground released', f.own(), undefined)
  await Promise.all(await f.host.runSignalPoll()); await f.rt.runQueue()
  check('Host admits later work', !!f.own(), true)
  await f.call('dss_claim', {})
  const claimed = await f.call('dss_claim', {})
  check('same Task signal carried to claim', claimed.signals.includes(foregroundTaskSignal(taskId)), true)
  check('new claim consumes exact Task signal', await f.read(foregroundTaskSignal(taskId)), undefined)
  const wakesBefore = (await f.records.list(f.rt.prefix + 'wakes/')).length
  await Promise.all(await f.host.runSignalPoll())
  check('same Task signal not duplicated by Host', (await f.records.list(f.rt.prefix + 'wakes/')).length, wakesBefore)
  check('no runtime errors', f.errors, [])
  results.push({ name: 'real-service-host-claim-undelivered', checks: checks.length })
  const g = await fixture('local', 'd022-task-delivered')
  const originalUser = await g.input('Original request awaiting root Task.'); await g.rt.runQueue()
  await g.call('dss_conversation_read', { mode: 'context' })
  const deliveredPreview = await g.service.cleanupPreview({ mode: 'local', storageScope: 'd022-task-delivered', action: 'conversation' })
  const laterUser = await g.input('Later request after preview.')
  await g.files.replace(paths.task(taskId), JSON.stringify(task))
  for (const change of taskCompletionSignals(task)) await g.files.replace(change.path, change.content)
  await Promise.all(await g.host.runSignalPoll())
  await g.call('dss_claim', {})
  check('delivered scenario task claimed', await g.read(foregroundTaskSignal(taskId)), undefined)
  await g.call('dss_conversation_send', { id: 'd022-task-result-answer', replyTo: originalUser, text: 'Root Task result delivered to the user.', intent: 'human', responsePhase: 'final' })
  check('actual final reply delivered', (await g.rt.conversation.read('d022-task-result-answer')).text, 'Root Task result delivered to the user.')
  await g.service.cleanupRecords({ mode: 'local', storageScope: 'd022-task-delivered', action: 'conversation', commandId: 'd022-confirm-delivered', preview: deliveredPreview, confirmation: 'clear-foreground-conversation' })
  check('later user preserved after delivered cleanup', (await g.rt.conversation.read(laterUser)).text, 'Later request after preview.')
  check('already delivered task signal after cleanup', await g.read(foregroundTaskSignal(taskId)), '')
  results.push({ name: 'real-service-host-claim-delivered-observation', checks: checks.length })
  const h = await fixture('local', 'd022-task-uncertain-write')
  const hA = await h.input('Original request.'); await h.rt.runQueue()
  await h.call('dss_conversation_read', { mode: 'context' })
  const hPreview = await h.service.cleanupPreview({ mode: 'local', storageScope: 'd022-task-uncertain-write', action: 'conversation' })
  const hB = await h.input('Later request.');
  await h.files.replace(paths.task(taskId), JSON.stringify(task))
  for (const change of taskCompletionSignals(task)) await h.files.replace(change.path, change.content)
  await Promise.all(await h.host.runSignalPoll())
  await h.call('dss_claim', {})
  const create = h.files.createIfAbsent.bind(h.files)
  let uncertain = true
  h.files.createIfAbsent = async (path, content) => {
    const result = await create(path, content)
    if (path === foregroundTaskSignal(taskId) && uncertain) {
      uncertain = false
      throw new Error('Controlled result-unknown after exact Task signal creation')
    }
    return result
  }
  const clear = () => h.service.cleanupRecords({ mode: 'local', storageScope: 'd022-task-uncertain-write', action: 'conversation', commandId: 'd022-task-uncertain-clear', preview: hPreview, confirmation: 'clear-foreground-conversation' })
  await assert.rejects(clear, /Controlled result-unknown/)
  check('uncertain first call already created exact Task signal', await h.read(foregroundTaskSignal(taskId)), '')
  check('uncertain first call retains planned reset', (await h.records.list(h.rt.prefix + 'foreground-resets/'))[0]?.value.phase, 'planned')
  h.files.createIfAbsent = create
  await clear()
  check('retry keeps exactly one fixed Task signal path', (await withSnapshot(h.files, snapshot => h.files.listDirectory(snapshot, 'state/', { paths: [foregroundTaskSignal(taskId)] }))).length, 1)
  check('retry preserves later B', (await h.rt.conversation.read(hB)).text, 'Later request.')
  check('retry deletes selected A', await h.rt.conversation.read(hA), undefined)
  check('retry retires completed reset row', (await h.records.list(h.rt.prefix + 'foreground-resets/')).length, 0)
  results.push({ name: 'controlled-result-unknown-retry', checks: checks.length })
  const j = await fixture('local', 'd022-later-b-final')
  const jA = await j.input('Original A.'); await j.rt.runQueue()
  await j.call('dss_conversation_read', { mode: 'context' })
  const jPreview = await j.service.cleanupPreview({ mode: 'local', storageScope: 'd022-later-b-final', action: 'conversation' })
  const jB = await j.input('Later B.'); await Promise.all(await j.host.runSignalPoll())
  const jClaim = await j.call('dss_claim', {})
  const jIndex = JSON.parse(await withSnapshot(j.files, snapshot => j.files.read(snapshot, j.rt.conversation.indexPath)))
  const jBSignal = jIndex.messages.find(row => row.id === jB).notification
  check('same old FG claimed later B exact signal', jClaim.signals.includes(jBSignal), true)
  await j.call('dss_conversation_send', { id: 'd022-later-b-answer', replyTo: jB, text: 'Final answer to later B.', intent: 'human', responsePhase: 'final' })
  await j.service.cleanupRecords({ mode: 'local', storageScope: 'd022-later-b-final', action: 'conversation', commandId: 'd022-clear-old-a-after-b-final', preview: jPreview, confirmation: 'clear-foreground-conversation' })
  check('old A cleared after later B final', await j.rt.conversation.read(jA), undefined)
  check('later B retained after old A clear', (await j.rt.conversation.read(jB)).text, 'Later B.')
  check('later B final retained after old A clear', (await j.rt.conversation.read('d022-later-b-answer')).text, 'Final answer to later B.')
  check('finally answered later B not re-notified', await j.read(jBSignal), undefined)
  results.push({ name: 'later-B-final-boundary', checks: checks.length })
  const k = await fixture('local', 'd022-archived-task-identity')
  const kA = await k.input('Original request.'); await k.rt.runQueue()
  await k.call('dss_conversation_read', { mode: 'context' })
  const kPreview = await k.service.cleanupPreview({ mode: 'local', storageScope: 'd022-archived-task-identity', action: 'conversation' })
  const kB = await k.input('Later B.')
  await k.files.replace(paths.task(taskId), JSON.stringify(task))
  const archived = taskHistoryChange(task)
  check('actual archived identity path', archived.path, taskHistoryPath(taskId))
  await k.files.replace(archived.path, archived.content)
  for (const change of taskCompletionSignals(task)) await k.files.replace(change.path, change.content)
  await Promise.all(await k.host.runSignalPoll()); await k.call('dss_claim', {})
  await k.files.delete(paths.task(taskId))
  check('current Task metadata retired before user cleanup', await k.read(paths.task(taskId)), undefined)
  await k.service.cleanupRecords({ mode: 'local', storageScope: 'd022-archived-task-identity', action: 'conversation', commandId: 'd022-clear-after-task-retirement', preview: kPreview, confirmation: 'clear-foreground-conversation' })
  check('archived Task identity survived cleanup', JSON.parse(await k.read(taskHistoryPath(taskId))).lifecycleId, task.lifecycleId)
  check('archived Task signal with same ID republished', await k.read(foregroundTaskSignal(taskId)), '')
  check('later B survived archive-only Task cleanup', (await k.rt.conversation.read(kB)).text, 'Later B.')
  check('selected A cleared in archive-only Task cleanup', await k.rt.conversation.read(kA), undefined)
  await Promise.all(await k.host.runSignalPoll()); await k.rt.runQueue()
  await k.call('dss_claim', {})
  const kTaskClaim = await k.call('dss_claim', {})
  check('new FG claims archived-only original Task ID', kTaskClaim.signals.includes(foregroundTaskSignal(taskId)), true)
  check('archived-only Task signal consumed by new FG', await k.read(foregroundTaskSignal(taskId)), undefined)
  results.push({ name: 'archived-task-identity-after-current-retirement', checks: checks.length })
} finally {
  for (const f of opened.reverse()) await f.close()
  await fs.rm(scratch, { recursive: true, force: true })
}
console.log(JSON.stringify({ results, checks }, null, 2))
