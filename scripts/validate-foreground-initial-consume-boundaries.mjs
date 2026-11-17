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
function initialReceiptPath(f, record = f.own()) {
  const request = record.delivery?.request ?? record.lastWake
  const signals = [...new Set(request.sources.filter(source => source.path.startsWith('state/') && source.path.split('/').at(-1) !== 'recovery').map(source => source.path))].sort()
  const originalWake = typeof request.context?.originalWake === 'string' ? request.context.originalWake : request.id
  const id = 'conversation/git/' + f.rt.config.collaborationId + '/consume-wake/' + hash(JSON.stringify([f.rt.config.member, originalWake, signals]))
  return 'technical/command-receipts/' + hash(id) + '.json'
}
async function scenario(mode, name, run) {
  const before = checks.length, f = await fixture(mode, name)
  await run(f); results.push({ mode, name, checks: checks.length - before })
}
try {
  for (const mode of ['local', 'git']) {
    await scenario(mode, 'normal-ui-consume-complete', async f => {
      const inputId = await f.input('Ordinary original UI message.'); await f.rt.runQueue()
      check('actual admission has no error', f.errors, [])
      const key = f.wakeKey(), original = f.own()
      check('delivered wake remains before completion', (await f.records.get(key)).delivered, true)
      await f.input('Active follow-up UI message.')
      check('active UI notification keeps the same execution', f.own().identity.executionId, original.identity.executionId)
      check('active UI notification creates no extra technical wake', (await f.records.list(f.rt.prefix + 'wakes/')).map(row => row.key), [key])
      const content = await f.call('dss_conversation_read', { mode: 'context' })
      check('registered read returned original UI text', JSON.stringify(content).includes('Ordinary original UI message.'), true)
      check('registered read returned active follow-up text', JSON.stringify(content).includes('Active follow-up UI message.'), true)
      for (const source of original.delivery.request.sources) check('actual conversation claim consumes original signal', await f.read(source.path), undefined)
      check('signal consumption alone retains wake', !!await f.records.get(key), true)
      const receiptsBefore = mode === 'git' ? [...f.repo.bodies.keys()].filter(p => p.includes('/command-receipts/')).sort() : []
      await f.call('dss_conversation_send', { id: 'answer-' + inputId, text: 'Finished original work.', intent: 'human', responsePhase: 'final' })
      if (mode === 'git') check('Foreground actual send adds no global command receipt', [...f.repo.bodies.keys()].filter(p => p.includes('/command-receipts/')).sort(), receiptsBefore)
      await f.finish()
      check('normal completed round persisted', f.own().completedRound, true)
      check('ordinary completed wake retired', await f.records.get(key), undefined)
      if (mode === 'git') check('ordinary completed initial receipt retired', await f.read(initialReceiptPath(f, original)), undefined)
      check('existing native journal accepted exact session', new Set(f.retirements), new Set([original.sessionId]))
      check('existing pending native retirement cleared', f.own().nativeRetirements, undefined)
      check('long-term reply remains', (await f.rt.conversation.read('answer-' + inputId)).text, 'Finished original work.')
      const reads = [], get = f.records.get.bind(f.records); f.records.get = async key => { reads.push(key); return get(key) }
      f.rt.continueNativeRetirements(f.own()); await f.drain(); check('already retired state adds no lookup', reads, []); f.records.get = get
      await f.rt.updateWake(key, current => current ? { ...current, delivered: true } : undefined)
      check('late original delivered write does not recreate wake', await f.records.get(key), undefined)
      check('normal chain reports no error', f.errors, [])
    })
    await scenario(mode, 'aborted-native-turn', async f => {
      await f.input('This original remains unfinished.'); await f.rt.runQueue(); const key = f.wakeKey()
      await f.call('dss_conversation_read', { mode: 'context' }); await f.finish('aborted')
      check('aborted turn does not create completedRound', f.own().completedRound, undefined)
      check('aborted turn retains original wake', !!await f.records.get(key), true)
      if (mode === 'git') check('aborted turn retains original receipt', !!await f.read(initialReceiptPath(f)), true)
    })
    await scenario(mode, 'failed-retirement-and-next-real-input', async f => {
      await f.input('First original.'); await f.rt.runQueue(); const key = f.wakeKey(), first = f.own()
      await f.call('dss_conversation_read', { mode: 'context' })
      const method = mode === 'git' ? 'compareAndDelete' : 'delete', originalDelete = f.records[method].bind(f.records)
      let fail = true
      f.records[method] = async (target, ...args) => { if (target === key && fail) throw new Error('Controlled exact wake deletion failure'); return originalDelete(target, ...args) }
      await f.finish()
      if (mode === 'git') check('failed existing wake CAS retains initial receipt', !!await f.read(initialReceiptPath(f, first)), true)
      check('failed exact deletion retains existing retirement owner', f.own().nativeRetirements[0].wakeId, first.delivery.request.id)
      check('failed exact deletion reports original I/O error', f.errors.some(error => error.message.includes('wake deletion failure')), true)
      await f.input('Second independent UI input.'); await f.rt.runQueue(); await f.drain()
      check('old cleanup failure does not block actual next admission', f.own().identity.executionId !== first.identity.executionId, true)
      check('replacement preserves original pending cleanup identity', f.own().nativeRetirements[0].wakeId, first.delivery.request.id)
      const nextKey = f.wakeKey(); fail = false; f.errors.length = 0
      // This is the original cold-start continuation, using the persisted role.
      const saved = await f.records.get(f.rt.roleRecordPath(f.own().identity.workId))
      f.rt.continueNativeRetirements(saved); await f.drain()
      check('original retry retires only prior wake', await f.records.get(key), undefined)
      if (mode === 'git') check('original retry retires only prior initial receipt', await f.read(initialReceiptPath(f, first)), undefined)
      check('new input still has its own pending wake', !!await f.records.get(nextKey), true)
      check('replacement native session is not retired by old cleanup', f.retirements.includes(f.own().sessionId), false)
    })
    await scenario(mode, 'native-send-unconfirmed', async f => {
      await f.input('Unconfirmed original input.')
      f.native.beforeSend = async () => { throw new Error('Controlled native send result unknown') }
      await f.rt.runQueue(); const key = f.wakeKey()
      check('unknown native send keeps original wake pending', (await f.records.get(key)).delivered, undefined)
      check('unknown native send has no completed fact', f.own().completedRound, undefined)
      check('unknown native send retires no session', f.retirements, [])
      f.native.beforeSend = undefined; await f.rt.runQueue(); await f.call('dss_conversation_read', { mode: 'context' }); await f.finish('completed', true)
      // The fixture invokes retainClosedRound directly, outside NativeExecutions’ disposed callback. Follow it with the production stop path.
      f.rt.trackedStop(f.own()); await f.drain()
      check('original send resumes and closed-round path retires exact wake', await f.records.get(key), undefined)
    })
    await scenario(mode, 'slow-background-retirement-does-not-hold-next-input', async f => {
      await f.input('Completed original before a slow deletion.'); await f.rt.runQueue(); const key = f.wakeKey(), first = f.own()
      await f.call('dss_conversation_read', { mode: 'context' })
      const method = mode === 'git' ? 'compareAndDelete' : 'delete', originalDelete = f.records[method].bind(f.records)
      let release, entered; const waiting = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
      f.records[method] = async (target, ...args) => { if (target === key) { entered(); await waiting }; return originalDelete(target, ...args) }
      try {
        await f.finish('completed', false, false); await started
        await Promise.all([...f.rt.stopOperations.values()].map(operation => operation.promise))
        await f.input('Next UI input while the prior deletion is in progress.'); await f.rt.runQueue()
        check('next execution admits before old deletion resolves', f.own().identity.executionId !== first.identity.executionId, true)
        check('in-progress cleanup remains with the original existing retirement', f.own().nativeRetirements[0].wakeId, first.delivery.request.id)
        check('new native session is not submitted to old retirement', f.retirements.includes(f.own().sessionId), false)
      } finally { release(); await f.drain() }
      check('delayed original wake eventually retires', await f.records.get(key), undefined)
      check('delayed cleanup leaves current wake intact', !!await f.records.get(f.wakeKey()), true)
      check('delayed cleanup reports no error', f.errors, [])
    })
    await scenario(mode, 'existing-native-continuation-remains-separate', async f => {
      await f.input('Interrupted original UI work.'); await f.rt.runQueue(); const originalKey = f.wakeKey()
      await f.call('dss_conversation_read', { mode: 'context' }); await f.finish('aborted')
      f.rt.trackedStop(f.own()); await f.drain()
      check('existing stop records the interrupted native owner', f.own().stopped, true)
      const request = await f.rt.arrangeNativeContinuation(f.own(), { facts: 'Continue the actual interrupted input.' })
      check('existing continuation produced Foreground recovery', request.role, 'Foreground')
      const key = f.rt.prefix + 'wakes/' + hash(request.id)
      check('existing continuation preserves original recovery identity', (await f.records.get(key)).recovery.original.request.id, (await f.records.get(originalKey)).request.id)
      await f.rt.runQueue(); await f.call('dss_conversation_read', { mode: 'context' }); await f.finish()
      check('completed recovery does not enter ordinary wake deletion', !!await f.records.get(key), true)
      check('interrupted original is not falsely ordinary-completed', !!await f.records.get(originalKey), true)
      if (mode === 'git') check('targeted recovery preserves original initial receipt', !!await f.read(initialReceiptPath(f)), true)
      check('recovery does not prevent native journal handoff', f.own().nativeRetirements, undefined)
      check('continuation branch reports no error', f.errors, [])
    })
    if (mode === 'git') await scenario(mode, 'existing-git-cold-continuation-remains-separate', async f => {
      await f.input('Interrupted Git responsibility.'); await f.rt.runQueue(); const originalKey = f.wakeKey()
      await f.call('dss_conversation_read', { mode: 'context' }); await f.finish('aborted')
      f.rt.trackedStop(f.own()); await f.drain()
      check('actual Git stopped responsibility is resumed', await f.rt.recoverGitResponsibility(f.own()), true)
      await f.rt.runQueue(); const key = f.wakeKey(), wake = await f.records.get(key)
      check('Git continuation uses existing startup-recovery reason', wake.request.reason, 'startup-recovery')
      check('Git cold continuation has no WakeRecovery payload', wake.recovery, undefined)
      await f.call('dss_conversation_read', { mode: 'context' }); await f.finish()
      check('Git recovery input remains outside ordinary retirement', !!await f.records.get(key), true)
      check('Git interrupted original remains outside ordinary completion', !!await f.records.get(originalKey), true)
      check('Git cold continuation preserves initial receipt', !!await f.read(initialReceiptPath(f)), true)
      check('Git cold continuation reports no error', f.errors, [])
    })
  }
  await scenario('git', 'initial-and-later-claim-separated-with-no-extra-reads', async f => {
    await f.input('First ordinary original.'); await f.rt.runQueue()
    const original = f.own(), initialPath = initialReceiptPath(f, original)
    await f.call('dss_conversation_read', { mode: 'context' })
    check('first registered read produces initial receipt', !!await f.read(initialPath), true)
    await f.input('Later actual notification in the same execution.')
    await f.call('dss_claim', {})
    const laterPaths = [...f.repo.bodies.keys()].map(path => path.replace(/^dss-coop\//, '')).filter(path => path.includes('/command-receipts/') && path !== initialPath)
    check('registered later claim produces its distinct receipt', laterPaths.length, 1)
    const before = await f.read(laterPaths[0]), reads = [], read = f.files.read.bind(f.files)
    f.files.read = async (snapshot, path) => { reads.push(path); return read(snapshot, path) }
    await f.finish(); f.files.read = read
    check('retirement adds no command-receipt read', reads.filter(path => path.includes('/command-receipts/')), [])
    check('initial receipt retires with its normal wake', await f.read(initialPath), undefined)
    check('later claim remains byte-identical with its existing owner', await f.read(laterPaths[0]), before)
    check('later claim context remains in original RoleRecord', Object.keys(f.own().notificationClaims).length, 1)
    check('normal separate-claim chain has no errors', f.errors, [])
  })
  console.log(JSON.stringify({ passed: checks.length, checks, results, evidence: evidence(), limits: [
    'Actual client controller, Service send, Conversation, Host signal poll, runtime wake/admission, registered conversation tools, SDK projections and role completion/retirement are exercised.',
    'Local technical records use real SDK storage and physical files. Git authority uses exact-HEAD controlled transport. Native open/send/events/flush/stop/journal are controlled boundaries, not a live model or Windows host.',
    'Deletion failure and unconfirmed native send are injected at the original actual I/O ports. No malformed RoleRecord, synthetic completion flag, new product admission gate or external write is introduced.',
  ] }, null, 2))
} finally { await Promise.allSettled(opened.map(f => f.close())); await fs.rm(scratch, { recursive: true, force: true }) }
