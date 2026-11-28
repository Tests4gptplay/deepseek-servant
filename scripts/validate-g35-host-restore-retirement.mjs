import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import ts from 'typescript'

// Execute unchanged production method bodies, with explicit storage/native
// ports. Host recovery publication uses actual physical files. No model, native
// session, Windows or real GitHub request is claimed by this focused check.
// Deliberate failure, held-I/O and preselected restoration scenarios below are
// controlled contract conditions, not evidence of a naturally occurring fault
// or of a Helper deciding that a healthy Host needs restoration.
const source = process.env.DSS_G35_SOURCE_ROOT
  ? pathToFileURL(path.resolve(process.env.DSS_G35_SOURCE_ROOT) + '/') : new URL('../src/', import.meta.url)
const hash = text => createHash('sha256').update(text).digest('hex'), loaded = new Map()
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(source.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(source.href) && url.endsWith('.ts')) {
      const text = readFileSync(new URL(url), 'utf8'); loaded.set(url.slice(source.href.length), hash(text))
      return { format: 'module', source: stripTypeScriptTypes(text, { mode: 'transform' }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const fromSource = name => import(new URL(name, source).href)
const { FrameworkSafetyNet } = await fromSource('framework/safety-net.ts')
const { GitHubClient, GitHubError } = await fromSource('experimental/private-git/github.ts')
const { requiresUserAction } = await fromSource('framework/client-error.ts')
const { roleErrorOrigin, rememberRoleErrorOrigin } = await fromSource('framework/role-error-origin.ts')
const { failureDetails } = await fromSource('diagnostics/failure-details.ts')
const { FilesConflictError, FilesOutcomeUnknownError, withSnapshot, withOperationChannel } = await fromSource('framework/transactions.ts')
const { paths, readJson, taskLifecycle } = await fromSource('framework/task-files.ts')
const { readTaskHistoryIdentity } = await fromSource('framework/task-history.ts')
const { PhysicalLocalFiles } = await fromSource('framework/physical-local-files.ts')
const { GitAuthorityStore, listAuthorityInRound } = await fromSource('framework/git-authority.ts')
const { gitCommandReceiptPath } = await fromSource('framework/command-transactions.ts')
const dependencies = { hash, randomUUID, GitHubError, roleErrorOrigin, failureDetails, requiresUserAction,
  FilesConflictError, FilesOutcomeUnknownError, withSnapshot, withOperationChannel, paths, readJson, taskLifecycle,
  readTaskHistoryIdentity, PhysicalLocalFiles, GitAuthorityStore, listAuthorityInRound, gitCommandReceiptPath,
  // These branches are deliberately not entered by the selected scenarios.
  DshAgentCreationCancelled: class extends Error {},
  DshSessionReader: class { constructor() { throw Error('Native session inspection is outside this check') } },
}
function methods(file, className, names) {
  const text = readFileSync(new URL(file, source), 'utf8'); loaded.set(file, hash(text))
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  assert(declaration, className)
  return names.map(name => {
    const member = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === name)
    assert(member, className + '.' + name)
    return member.getText(tree)
  }).join('\n')
}
function selectedClass(file, className, names) {
  return new Function(...Object.keys(dependencies), stripTypeScriptTypes('class Selected {\n' + methods(file, className, names) + '\n}', { mode: 'transform' }) + '\nreturn Selected')(...Object.values(dependencies))
}
const { publishPhysicalRecovery, retirePublishedPhysicalRecovery } = await fromSource('framework/physical-recovery.ts')
const { hostRecoveryDebugPath } = await fromSource('framework/recovery-debug-record.ts')
Object.assign(dependencies, { publishPhysicalRecovery, retirePublishedPhysicalRecovery, hostRecoveryDebugPath, SessionId: x => x,
  // Existing persistence barrier is an explicit controlled port, not a model run.
  DshSessionReader: class {
    constructor(ctx) { this.ctx = ctx }
    async events(id) { return structuredClone(this.ctx.evidence.get(id) ?? []) }
    async capture(id) { await this.ctx.sessions.flush(this.ctx.sessions.get(id)); return { finished: true } }
  }, retirePhysicalPublicationsFromEvents: async () => {} })
const runtimeSource = readFileSync(new URL('framework/role-runtime.ts', source), 'utf8')
const Runtime = selectedClass('framework/role-runtime.ts', 'FrameworkRoleRuntime', [
  'services', 'safetyFaultIds', 'helperResponsibilities', 'createSafetyRestoreRow', 'updateSafetyRestoreRow', 'restoreTaskOwner',
  'processHostRestores', 'publishPhysicalHostRestoration', 'recoveryInputPath', 'retirePhysicalRestoreDebug', 'replaySafetyRestore', 'safetyRestoreSettled',
  'recordSafetyAttempt', 'safetyFaultFromWake', 'finishGitAuxiliaryRound', 'retrySettledHelperWakeRetirement', 'retireSettledHelperWakes',
  'startMaintenance', 'deleteRuntimeRecord', 'forgetAdmissionWake', 'dispose', 'disposeOwned',
  ...['scheduleHostRestoreRetirement', 'considerHostRestoreRetirement', 'scheduleCompletedHostRestoreRetirement', 'retireCompletedHostRestore'].filter(name => runtimeSource.includes(' '+name+'(')),
])
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-g35-')), fixtures = [], tests = []
let assertions = 0
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++ }
const latch = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Harness timeout')), 3000) })]) } finally { clearTimeout(timer) } }
const prefix = 'framework-runtime/' + hash('g35-scope') + '/', commandId = 'helper-session:restore-call'
const restoreKey = prefix + 'host-restores/' + hash(commandId)
const input = { facts: 'Original Host failure.', hypotheses: 'Inspect exact original targets.', actionsTaken: 'Requested original Host continuation.', continuation: 'Resume actual unresolved owners.' }
const binding = { role: 'Helper', workId: 'helper-work', executionId: 'helper-execution', owner: 'A' }
const request = { id: 'original-helper-wake', role: 'Helper', reason: 'helper', sources: [], context: { facts: input.facts } }
function successfulEvents({ result = true, unknown = false, wrongSource = false } = {}) {
  return [
    { type: 'tool/call', seq: 7, data: { turn: 1, step: 1, callId: 'restore-call', name: 'dss_restore_host', arguments: input } },
    ...(result ? [{ type: 'tool/result', seq: 8, surfaceOp: 'append', sourceEventSeqs: [wrongSource ? 6 : 7], data: { turn: 1, step: 1,
      message: { toolCallId: 'restore-call', isError: unknown, content: [{ type: 'text', text: JSON.stringify({ arranged: true }) }] },
      ...(unknown ? { error: { code: 'TOOL_OUTCOME_UNKNOWN' } } : {}) } }] : []),
    { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}
async function fixture({ events = successfulEvents(), rows, directory, flush, deletion } = {}) {
  const files = new PhysicalLocalFiles(directory ?? path.join(root, String(fixtures.length))), values = rows ?? new Map(), reads = [], deletes = [], errors = [], continuations = []
  const records = {
    async get(key) { reads.push(['get', key]); return structuredClone(values.get(key)) },
    async set(key, value) { values.set(key, structuredClone(value)) },
    async list(key) { reads.push(['list', key]); return [...values].filter(([k]) => k.startsWith(key)).map(([key, value]) => ({ key, value: structuredClone(value) })) },
    async delete(key) { if (deletion) await deletion(key); values.delete(key); deletes.push(key) },
  }
  const helper = { identity: binding, sessionId: 'helper-session', generation: 1, delivery: { request, confirmed: true, messageId: 'original-input' } }
  const ctx = { evidence: new Map([['helper-session', events]]), sessions: { get: id => ({ id }), flush: async session => { if (flush) await flush(session) } } }
  const runtime = new Runtime()
  Object.assign(runtime, { prefix, files, records, ctx, config: { mode: 'local', scope: 'g35-scope', member: 'A', primary: true }, closed: false,
    conversation: { attachments: {} }, roleRecords: new Map([[binding.workId, helper]]), safetyEpisodes: new Map(), resolvedSafetyFaultIds: new Set(), safetyReplayed: new Set(),
    localWakeAdmissions: new Map(), admissionObservationVersion: 0, reportedAdmissionDiagnostics: new Set(),
    safetyRestoreWrites: new Map(), restoreWriteOwners: new Map(), safetySettlements: new Map(), workOperations: new Map(), wakeWrites: new Map(),
    controls: { execution: async record => record.workId === 'stopped-work' }, taskMetadata: async () => [],
    beforeTaskUse: async () => true, taskRuntimeReleased: async () => false, manuallyCleared: async () => false,
    active: () => false, trackedStop: record => record.stopped === true,
    serialWork: async (_key, action) => action(), publishOwnerRecovery: async () => {},
    arrangeNativeContinuation: async record => { continuations.push(record.identity.workId); return record.identity.workId !== 'no-continuation-work' },
    saveRole: async row => { runtime.roleRecords.set(row.identity.workId, row) },
    updateWake: async (key, action) => { const value = action(structuredClone(values.get(key))); if (value) values.set(key, structuredClone(value)) },
    environment: { safetyReplay() {}, safetyAttempted() {}, safetyAttemptFailed() {}, safetyResolved() {}, restored() {}, resolved() {} },
    error: (error, context) => errors.push({ error, context }),
    wake: async req => { values.set(prefix + 'wakes/' + hash(req.id), { request: req }) },
  })
  values.set(prefix + 'wakes/' + hash(request.id), { request, delivered: true })
  const f = { runtime, files, records, values, helper, ctx, errors, continuations, deletes, reads }
  fixtures.push(f); return f
}
async function accept(f) {
  check(await f.runtime.services().helper.restoreHost(binding, input, commandId), { arranged: true })
  await f.runtime.processHostRestores((error, context) => f.runtime.error(error, context))
}
async function finish(f) { await f.runtime.finishGitAuxiliaryRound(f.runtime.roleRecords.get(binding.workId)); await settle(f) }
async function settle(f) { for (;;) { const work = [...f.runtime.maintenance?.values() ?? []]; if (!work.length) break; await Promise.allSettled(work); await tick() } }
async function run(name, fn) { const start = assertions; try { await fn(); tests.push({ name, status: 'passed', assertions: assertions - start }) } catch (error) { tests.push({ name, status: 'failed', assertions: assertions - start, error: String(error) }) } }
try {
  await run('actual restoreHost and completed Helper entry retire one completed row without writing another Debug report', async () => {
    const f = await fixture(); await accept(f)
    const row = f.values.get(restoreKey), debug = hostRecoveryDebugPath('debug/' + row.createdAt.slice(0, 10) + '.md', 'host-restore-debug:' + commandId)
    const before = await withSnapshot(f.files, snapshot => f.files.read(snapshot, debug))
    check(row.complete, true); await finish(f)
    check(f.values.has(restoreKey), false, 'Completed row must leave the technical store')
    check(await withSnapshot(f.files, snapshot => f.files.read(snapshot, debug)), before, 'No report is added merely for cleanup')
    check(f.values.has(prefix + 'wakes/' + hash(request.id)), true, 'Complex Helper wake is untouched')
    await f.runtime.processHostRestores(); check(f.reads.at(-1), ['list', prefix + 'host-restores/']); check(f.errors.length, 0)
  })
  await run('actual multiple target outcomes remain valid until the original completed command retires', async () => {
    const f = await fixture(), targets = ['arranged-work', 'stopped-work', 'no-continuation-work', 'superseded-work', 'released-work'].map(workId => ({
      identity: { role: 'Worker', workId, executionId: workId + '-execution', taskId: workId + '-task', member: 'A', owner: 'A' }, sessionId: workId + '-session', stopped: true, stopIntent: { phase: 'disposed' } }))
    await f.runtime.services().helper.restoreHost(binding, input, commandId)
    for (const target of targets) if (target.identity.workId !== 'superseded-work') f.runtime.roleRecords.set(target.identity.workId, { ...target, ...(target.identity.workId === 'released-work' ? { released: true } : {}) })
    await f.runtime.updateSafetyRestoreRow(restoreKey, commandId, current => ({ ...current, targets: targets.map(({ identity, sessionId }) => ({ identity, sessionId })) }))
    await f.runtime.processHostRestores((error, context) => f.runtime.error(error, context))
    check(f.values.get(restoreKey).targets.map(target => target.outcome), ['arranged', 'user-stopped', 'no-continuation', 'superseded', 'released'])
    check(f.continuations, ['arranged-work', 'no-continuation-work']); await finish(f); check(f.values.has(restoreKey), false)
  })
  await run('missing, synthetic UNKNOWN, mismatched original result and changed requester do not retire', async () => {
    for (const events of [successfulEvents({ result: false }), successfulEvents({ unknown: true }), successfulEvents({ wrongSource: true })]) {
      const f = await fixture({ events }); await accept(f); await finish(f); check(f.values.has(restoreKey), true)
    }
    const f = await fixture(); await accept(f); f.runtime.roleRecords.set(binding.workId, { ...f.helper, identity: { ...binding, executionId: 'different-execution' } })
    await finish(f); check(f.values.has(restoreKey), true)
  })
  await run('historical row without requester and result with wrong step keep their original rows', async () => {
    const old = await fixture(); await accept(old)
    const row = old.values.get(restoreKey); delete row.requester
    await finish(old); check(old.values.has(restoreKey), true)
    const events = successfulEvents(); events.find(event => event.type === 'tool/result').data.step = 2
    const mismatch = await fixture({ events }); await accept(mismatch); await finish(mismatch); check(mismatch.values.has(restoreKey), true)
  })
  await run('existing flush boundary cannot be replaced by an in-memory result', async () => {
    const hold = latch(), entered = latch(), f = await fixture({ flush: async () => { entered.resolve(); await hold.promise } }); await accept(f)
    const finishing = f.runtime.finishGitAuxiliaryRound(f.helper); await entered.promise
    check(f.values.has(restoreKey), true); await f.records.set('unrelated-task', { accepted: true }); check(f.values.get('unrelated-task'), { accepted: true })
    hold.resolve(); await finishing; await settle(f); check(f.values.has(restoreKey), false)
  })
  await run('background retirement cannot block the completed Helper or another Task', async () => {
    const hold = latch(), entered = latch(), f = await fixture({ deletion: async key => { if (key === restoreKey) { entered.resolve(); await hold.promise } } }); await accept(f)
    const finishing = f.runtime.finishGitAuxiliaryRound(f.helper)
    try { await bounded(entered.promise); await bounded(finishing)
      await f.records.set('other-task-progress', 'written'); check(f.values.get('other-task-progress'), 'written'); check(f.values.has(restoreKey), true)
    } finally { hold.resolve() }
    await settle(f); check(f.values.has(restoreKey), false)
  })
  await run('existing Helper decisions resolve ordinary responsibility but never erase UNKNOWN operation', async () => {
    for (const [outcome, unknown, removed] of [['attempted-not-repaired', false, false], ['repaired', false, true], ['repaired', true, false]]) {
      const f = await fixture(), fault = { id: 'actual-fault', mode: 'local', scope: 'g35-scope', source: 'runtime', message: 'Original failure', occurrence: 1,
        ...(unknown ? { operationId: 'original-operation', code: 'dss/outcome-unknown' } : {}) }
      f.runtime.safetyEpisodes.set(fault.id, { fault, helperWakeId: request.id, commands: new Set() }); await accept(f)
      await f.runtime.recordSafetyAttempt(binding, { faultId: fault.id, outcome, actionsTaken: 'Checked original continuation.', result: 'Reported actual result.' }, 'helper-session:actual-report')
      await finish(f); check(f.values.has(restoreKey), !removed)
      check(f.values.get(prefix + 'wakes/' + hash(request.id)).safetyAttempts[0].outcome, outcome)
    }
  })
  await run('cold completed row is discoverable and failed retirement preserves original responsibility', async () => {
    const f = await fixture({ deletion: async key => { if (key === restoreKey) throw Error('Selected record deletion failed') } }); await accept(f); await finish(f)
    check(f.values.has(restoreKey), true); check(f.errors.length, 1)
    const cold = await fixture({ rows: f.values, directory: f.files.directory }); await cold.runtime.processHostRestores(); await finish(cold); check(cold.values.has(restoreKey), false)
  })
  await run('Helper settles before Host completes without another idle event or flush', async () => {
    let flushes = 0; const f = await fixture({ flush: async () => { flushes++ } })
    await f.runtime.services().helper.restoreHost(binding, input, commandId)
    await finish(f); check(f.values.get(restoreKey).complete, false); check(flushes, 1)
    await f.runtime.processHostRestores(); await settle(f)
    check(f.values.has(restoreKey), false); check(flushes, 1)
  })
  await run('same runtime retries an exact transient delete failure through original discovery', async () => {
    let fail = true, flushes = 0
    const f = await fixture({ flush: async () => { flushes++ }, deletion: async key => { if (key === restoreKey && fail) throw Error('Temporary exact delete failure') } })
    await accept(f); await finish(f); check(f.values.has(restoreKey), true); check(f.errors.length, 1)
    const originalOwner = f.runtime.roleRecords.get(binding.workId); fail = false
    await f.runtime.processHostRestores(); await settle(f)
    check(f.values.has(restoreKey), false); check(f.runtime.roleRecords.get(binding.workId), originalOwner); check(flushes, 1)
  })
  await run('later original repaired report permits retirement without another native round', async () => {
    const f = await fixture(), fault = { id: 'late-repaired-fault', mode: 'local', scope: 'g35-scope', source: 'runtime', message: 'Original failure', occurrence: 1 }
    f.runtime.safetyEpisodes.set(fault.id, { fault, helperWakeId: request.id, commands: new Set() }); await accept(f); await finish(f)
    check(f.values.has(restoreKey), true)
    await f.runtime.recordSafetyAttempt(binding, { faultId: fault.id, outcome: 'repaired', actionsTaken: 'Actual later check.', result: 'Repaired.' }, 'helper-session:later-report')
    await f.runtime.processHostRestores(); await settle(f); check(f.values.has(restoreKey), false)
  })
  await run('temporary Debug publication deletion failure retries without changing the Debug body', async () => {
    const f = await fixture(), remove = f.files.delete.bind(f.files)
    let fail = true; f.files.delete = async name => { if (fail && name.startsWith('debug/.recovery/')) throw Error('Temporary Debug publication removal failure'); return remove(name) }
    await accept(f)
    const row = f.values.get(restoreKey), debug = hostRecoveryDebugPath('debug/' + row.createdAt.slice(0, 10) + '.md', 'host-restore-debug:' + commandId)
    const before = await withSnapshot(f.files, snapshot => f.files.read(snapshot, debug))
    await finish(f); check(f.values.has(restoreKey), true); check(f.errors.length, 2)
    fail = false; await f.runtime.processHostRestores(); await settle(f)
    check(f.values.has(restoreKey), false); check(await withSnapshot(f.files, snapshot => f.files.read(snapshot, debug)), before)
  })
  await run('unconfirmed target remains until actual original continuation is arranged', async () => {
    const f = await fixture(), target = { identity: { role: 'Worker', workId: 'waiting-worker', executionId: 'waiting-execution' }, sessionId: 'waiting-session', stopIntent: { phase: 'stopping' } }
    f.runtime.roleRecords.set(target.identity.workId, target)
    await accept(f); check(f.values.get(restoreKey).complete, false); await finish(f); check(f.values.has(restoreKey), true)
    f.runtime.roleRecords.set(target.identity.workId, { ...target, stopped: true, stopIntent: { phase: 'disposed' } })
    await f.runtime.processHostRestores(); await settle(f)
    check(f.continuations, ['waiting-worker']); check(f.values.has(restoreKey), false)
  })
  await run('a later Helper execution does not erase original proof before old Host completion', async () => {
    const f = await fixture()
    await f.runtime.services().helper.restoreHost(binding, input, commandId); await finish(f)
    const replacement = { ...f.helper, identity: { ...binding, executionId: 'next-helper-execution' }, sessionId: 'next-helper-session',
      delivery: { request: { ...request, id: 'next-helper-wake' }, confirmed: true, messageId: 'next-input' } }
    f.runtime.roleRecords.set(binding.workId, replacement)
    f.ctx.evidence.set(replacement.sessionId, [{ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } }])
    await f.runtime.finishGitAuxiliaryRound(replacement)
    await f.runtime.processHostRestores(); await settle(f)
    check(f.values.has(restoreKey), false)
    check(f.runtime.roleRecords.get(binding.workId).identity.executionId, replacement.identity.executionId)
  })
  await run('successful retirement drops proof and repeated original events cannot resurrect it', async () => {
    const f = await fixture(); await accept(f); await finish(f)
    check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
    await f.runtime.finishGitAuxiliaryRound(f.runtime.roleRecords.get(binding.workId)); await settle(f)
    check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
    check(f.runtime.completedHostRestores?.size ?? 0, 0)
  })
  await run('unproven and UNKNOWN rows stay durable without completed-row copies or unused proof', async () => {
    const missing = await fixture({ events: successfulEvents({ result: false }) }); await accept(missing); await finish(missing)
    check(missing.values.has(restoreKey), true); check(missing.runtime.completedHostRestores?.size ?? 0, 0)
    const unknown = await fixture(), fault = { id: 'retained-unknown', mode: 'local', scope: 'g35-scope', source: 'runtime', message: 'Original unknown', occurrence: 1, operationId: 'unknown-operation' }
    unknown.runtime.safetyEpisodes.set(fault.id, { fault, helperWakeId: request.id, commands: new Set() }); await accept(unknown); await finish(unknown)
    await unknown.runtime.processHostRestores(); await settle(unknown)
    check(unknown.values.has(restoreKey), true); check(unknown.runtime.hostRestoreNativeEvidence?.size ?? 0, 0); check(unknown.runtime.completedHostRestores?.size ?? 0, 0)
  })
  await run('original discovery releases proof after the original row was externally removed', async () => {
    const f = await fixture(); await f.runtime.services().helper.restoreHost(binding, input, commandId); await finish(f)
    check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 1)
    f.values.delete(restoreKey); await f.runtime.processHostRestores(); await settle(f)
    check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
  })
  await run('stale inventory absence is checked at the exact original key before proof is dropped', async () => {
    const f = await fixture(); await f.runtime.services().helper.restoreHost(binding, input, commandId); await finish(f)
    const list = f.records.list; f.records.list = async () => []
    await f.runtime.processHostRestores(); await settle(f); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 1)
    f.records.list = list; await f.runtime.processHostRestores(); await settle(f)
    check(f.values.has(restoreKey), false); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
  })
  await run('an unreadable exact original row is not absence and can recover through normal discovery', async () => {
    const f = await fixture(); await f.runtime.services().helper.restoreHost(binding, input, commandId); await finish(f)
    const list = f.records.list, get = f.records.get; f.records.list = async () => []; f.records.get = async key => { if (key === restoreKey) throw Error('Original record is unreadable'); return get(key) }
    await f.runtime.processHostRestores(); await settle(f); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 1)
    f.records.list = list; f.records.get = get; await f.runtime.processHostRestores(); await settle(f)
    check(f.values.has(restoreKey), false); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
  })
  await run('successive original commands leave no historical evidence and unchanged events add no exact reads', async () => {
    const f = await fixture(), events = successfulEvents(); f.ctx.evidence.set('helper-session', events)
    for (const callId of ['first-new-call', 'second-new-call', 'third-new-call']) {
      const command = 'helper-session:' + callId, key = prefix + 'host-restores/' + hash(command)
      await f.runtime.services().helper.restoreHost(binding, input, command); await f.runtime.processHostRestores()
      const seq = events.at(-1).seq + 1
      events.push({ type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name: 'dss_restore_host', arguments: input } },
        { type: 'tool/result', seq: seq + 1, surfaceOp: 'append', sourceEventSeqs: [seq], data: { turn: 1, step: 1, message: { toolCallId: callId, isError: false, content: [] } } },
        { type: 'turn/end', seq: seq + 2, data: { turn: 1, reason: { kind: 'completed' } } })
      await finish(f); check(f.values.has(key), false); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
      const reads = f.reads.length
      await f.runtime.finishGitAuxiliaryRound(f.runtime.roleRecords.get(binding.workId)); await settle(f)
      check(f.reads.length, reads); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
    }
  })
  await run('visible unresolved fault and missing result add no exact or session-log reads on ordinary discovery', async () => {
    const f = await fixture(), fault = { id: 'managed-unresolved', mode: 'local', scope: 'g35-scope', source: 'runtime', message: 'Original open fault', occurrence: 1 }
    f.runtime.safetyEpisodes.set(fault.id, { fault, helperWakeId: request.id, commands: new Set() }); await accept(f); await finish(f)
    const before = f.reads.length; await f.runtime.processHostRestores(); await f.runtime.processHostRestores(); await settle(f)
    check(f.reads.slice(before), [['list', prefix + 'host-restores/'], ['list', prefix + 'host-restores/']]); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 1)
    await f.runtime.recordSafetyAttempt(binding, { faultId: fault.id, outcome: 'repaired', actionsTaken: 'Original repair completed.', result: 'Repaired.' }, 'helper-session:managed-report')
    await f.runtime.processHostRestores(); await settle(f); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
    const missing = await fixture({ events: successfulEvents({ result: false }) }); await accept(missing); await finish(missing)
    const start = missing.reads.length; await missing.runtime.processHostRestores(); await missing.runtime.processHostRestores(); await settle(missing)
    check(missing.reads.slice(start), [['list', prefix + 'host-restores/'], ['list', prefix + 'host-restores/']]); check(missing.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
  })
  await run('a new original proof arriving after inventory starts is not pruned by that stale inventory', async () => {
    const f = await fixture(); await f.runtime.services().helper.restoreHost(binding, input, commandId)
    const entered = latch(), hold = latch(), list = f.records.list
    f.records.list = async () => { entered.resolve(); await hold.promise; return [] }
    const scanning = f.runtime.processHostRestores(); await entered.promise; await finish(f)
    check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 1); hold.resolve(); await scanning; await settle(f)
    check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 1)
    f.records.list = list; await f.runtime.processHostRestores(); await settle(f)
    check(f.values.has(restoreKey), false); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
  })
  await run('older same-session snapshot cannot move the original evidence cursor backwards', async () => {
    const f = await fixture(); await accept(f); await finish(f)
    const record = f.runtime.roleRecords.get(binding.workId), newest = [...successfulEvents(), { type: 'turn/end', seq: 12, data: { turn: 2, reason: { kind: 'completed' } } }]
    f.runtime.scheduleCompletedHostRestoreRetirement(record, newest); await settle(f)
    const reads = f.reads.length
    f.runtime.scheduleCompletedHostRestoreRetirement(record, successfulEvents())
    check(f.runtime.hostRestoreEvidenceCursor.seq, 12)
    f.runtime.scheduleCompletedHostRestoreRetirement(record, newest); await settle(f)
    check(f.reads.length, reads); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
  })
  await run('late old Helper evidence cannot replace the current Helper cursor or recreate retired proof', async () => {
    const f = await fixture(); await accept(f); await finish(f)
    const old = f.runtime.roleRecords.get(binding.workId), replacement = { ...old, identity: { ...old.identity, executionId: 'current-helper-execution' }, sessionId: 'current-helper-session' }
    f.runtime.roleRecords.set(binding.workId, replacement)
    f.runtime.scheduleCompletedHostRestoreRetirement(replacement, [{ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }])
    const reads = f.reads.length; f.runtime.scheduleCompletedHostRestoreRetirement(old, successfulEvents()); await settle(f)
    check(f.runtime.hostRestoreEvidenceCursor.sessionId, replacement.sessionId)
    check(f.reads.length, reads); check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0)
  })
  await run('runtime close releases remaining volatile proof after existing drains without deleting the original row', async () => {
    const f = await fixture(); await f.runtime.services().helper.restoreHost(binding, input, commandId); await finish(f)
    check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 1)
    Object.assign(f.runtime, { cleaner: { close() {} }, cleanupResidues: new Set(), loop: { stop: async () => {} }, pendingControlStops: [],
      targetedPumps: new Map(), organizerWakeWrites: new Map(), observations: { dispose: async () => {} },
      native: { cancelOpening: async () => ({ status: 'stopped' }) }, settleOperations: async () => {}, roleKey: () => 'Foreground', cancelledByShutdown: () => false })
    await f.runtime.dispose()
    check(f.runtime.hostRestoreNativeEvidence?.size ?? 0, 0); check(f.runtime.hostRestoreEvidenceCursor, undefined)
    check(f.values.get(restoreKey).complete, false)
  })
  const result = { status: tests.every(test => test.status === 'passed') ? 'passed' : 'failed', assertions, tests, sourceHashes: Object.fromEntries(loaded),
    limits: 'Actual source method bodies and physical recovery publication/files. Native session snapshots, flush completion, stop/continuation and technical KV are explicit controlled ports. Faults, UNKNOWN results, held I/O and selected restoration requests are controlled contract inputs, not demonstrated natural fault/recovery decisions. No full DSH, model, Windows, remote Git or user-data validation is claimed.' }
  console.log(JSON.stringify(result, null, 2)); if (result.status !== 'passed') process.exitCode = 1
} finally { await Promise.all(fixtures.map(f => f.files.close())); hooks.deregister(); await fs.rm(root, { recursive: true, force: true }) }
