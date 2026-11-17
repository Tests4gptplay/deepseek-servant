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

// Error objects supplied to error()/replay are routing contract inputs, not
// evidence that those failures occurred. Impossible Worker owner-recovery
// injections are excluded: that production method returns before any I/O.
// Execute unchanged production method bodies, with explicit storage/native
// ports. Missing-task lookup uses actual physical files. No model, native
// session, Windows or real GitHub request is claimed by this focused check.
const source = process.env.DSS_G07_SOURCE_ROOT
  ? pathToFileURL(path.resolve(process.env.DSS_G07_SOURCE_ROOT) + '/') : new URL('../src/', import.meta.url)
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
const { LegacyLocalControlReadError } = await fromSource('framework/execution-control.ts')
const { LegacyLocalConfigurationReadError } = await fromSource('adapters/dsh/record-files.ts')
const { GitAuthorityStore, listAuthorityInRound } = await fromSource('framework/git-authority.ts')
const dependencies = { hash, randomUUID, GitHubError, roleErrorOrigin, failureDetails, requiresUserAction,
  FilesConflictError, FilesOutcomeUnknownError, withSnapshot, withOperationChannel, paths, readJson, taskLifecycle,
  readTaskHistoryIdentity, PhysicalLocalFiles, LegacyLocalControlReadError, LegacyLocalConfigurationReadError, GitAuthorityStore, listAuthorityInRound,
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
const Runtime = selectedClass('framework/role-runtime.ts', 'FrameworkRoleRuntime', [
  'cancelledByShutdown', 'error', 'requestSafetyRepair', 'arrangeSafetyRepair', 'diagnoseMissingTask',
  'reportRoleContentFault', 'roleTaskGroups', 'safetyFaultFromWake', 'replaySafetyWakes', 'replaySafetyWake',
  'replaySafetyRestore', 'recordSafetyAttempt', 'helperResponsibilities', 'safetyRestoreSettled', 'dispose', 'disposeOwned',
])
const Service = selectedClass('framework/service.ts', 'FrameworkService', [
  'refreshErrors', 'report', 'captureSafety', 'deliverSafetyFaults', 'changed', 'diagnosticScope',
  'safetyCallbacks', 'resolveSafetyFault',
])
// Generate legacy data with the retained installed Host implementation rather
// than making an old schema from the candidate's expectations.
const historicalPath = new URL('./test-support/historical-55fe/installed-host.js', import.meta.url)
const historicalText = readFileSync(historicalPath, 'utf8'), historicalTree = ts.createSourceFile('installed-host.js', historicalText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
loaded.set('historical-55fe/installed-host.js', hash(historicalText))
function historicalClass(name) {
  for (const statement of historicalTree.statements) if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations.find(node => node.name.getText(historicalTree) === name)
    if (declaration) return declaration.initializer
  }
  throw Error('Historical class not found: ' + name)
}
const LegacySafetyNet = new Function('createHash7', 'randomUUID4', 'return ' + historicalClass('FrameworkSafetyNet').getText(historicalTree))(createHash, randomUUID)
const legacyRuntimeMethods = historicalClass('FrameworkRoleRuntime').members.filter(node => ts.isMethodDeclaration(node)
  && ['error', 'cancelledByShutdown', 'arrangeSafetyRepair'].includes(node.name.getText(historicalTree))).map(node => node.getText(historicalTree)).join('\n')
const legacyDependencies = { ...dependencies, hash14: hash, randomUUID10: randomUUID }
const LegacyRuntime = new Function(...Object.keys(legacyDependencies), 'return class {\n' + legacyRuntimeMethods + '\n}')(...Object.values(legacyDependencies))
const tick = () => new Promise(resolve => setImmediate(resolve))
const latch = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function waitFor(condition, label) {
  const started = Date.now()
  while (!condition()) { if (Date.now() - started > 3000) throw Error('Test harness timeout: ' + label); await tick() }
}
const fixtureFiles = []
const prefix = 'runtime/', scope = 'g07-actual-scope', tests = [], temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-g07-'))
let checks = 0
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++ }
const identity = n => ({ role: 'Worker', taskId: 'task-' + n, workId: 'work-' + n, executionId: 'execution-' + n, member: 'member', owner: 'member' })
function fixture({ active = true } = {}) {
  const rows = new Map(), wakeCalls = [], logs = [], reads = [], reports = [], rt = new Runtime(), service = new Service()
  Object.assign(service, {
    safetyNet: new FrameworkSafetyNet('g07-host'), safetyOperations: new AsyncLocalStorage(), safetyErrors: new WeakMap(),
    safetyDeliveries: new Set(), running: new Map(), saved: new Map(), reportedErrors: new Map(), errors: new Map(),
    userErrors: new Map(), resolvedRoleFacts: new Set(), resolvedSafetyFaultIds: new Set(), listeners: new Set(),
    ctx: { logger: () => ({ error: error => logs.push(error) }) }, closed: false, displayOwner: 'g07-host', safetyChanged() {},
  })
  const files = new PhysicalLocalFiles(path.join(temp, 'fixture-' + fixtureFiles.length)); fixtureFiles.push(files)
  Object.assign(rt, {
    files, localWakeAdmissions: new Map(), reportedAdmissionDiagnostics: new Set(), admissionObservationVersion: 0,
    prefix, config: { mode: 'local', scope, member: 'member' }, ctx: service.ctx, closed: false,
    safetyContext: new AsyncLocalStorage(), safetyErrorOccurrences: new WeakMap(), safetyRequests: new Map(),
    safetyEpisodes: new Map(), roleRecords: new Map(), safetyReplayed: new Set(), resolvedSafetyFaultIds: new Set(),
    environment: { ...service.safetyCallbacks('local'), heartbeat: async () => {},
      error(error, origin, occurrence) { reports.push({ error, origin, occurrence }); service.report('local', error, scope, undefined, origin, occurrence); } },
    records: {
      async list(key) { reads.push(key); return [...rows].filter(([name]) => name.startsWith(key)).map(([key, value]) => ({ key, value: structuredClone(value) })) },
      async get(key) { return structuredClone(rows.get(key)) },
      async set(key, value) { rows.set(key, structuredClone(value)) },
    },
    async wake(request, recovery, safetyFaults) {
      wakeCalls.push(structuredClone(request)); rows.set(prefix + 'wakes/' + hash(request.id), structuredClone({ request, ...(safetyFaults ? { safetyFaults } : {}) }))
    },
    async updateWake(key, update) { const next = update(structuredClone(rows.get(key))); if (next) rows.set(key, structuredClone(next)) },
    async updateSafetyRestoreRow(key, _command, update) { const next = update(structuredClone(rows.get(key))); rows.set(key, structuredClone(next)); return next },
    startRestoration() {}, active: row => !row.stopped, beforeTaskUse: async () => true, currentTask: async row => row.identity.taskId,
  })
  if (active) service.running.set('local', { connection: { scope }, runtime: rt })
  return { rt, service, rows, wakeCalls, reads, reports, logs }
}
async function idle(f) {
  await waitFor(() => !f.rt.safetyRequests.size && !f.service.safetyDeliveries.size, 'diagnostic settlement')
}
async function legacyDiagnostic(message, context) {
  const f = fixture({ active: false }); Object.setPrototypeOf(f.rt, LegacyRuntime.prototype)
  f.service.safetyNet = new LegacySafetyNet('historical-host'); f.rt.errorTail = Promise.resolve()
  f.rt.error(message instanceof Error ? message : new Error(message), context); await f.rt.errorTail
  const fault = f.service.safetyNet.pending('local', scope)[0]
  assert(fault && !fault.diagnosticContext && !fault.errorSignature)
  await f.rt.arrangeSafetyRepair(fault)
  const row = [...f.rows.values()].find(row => row.request?.context?.errorSignature)
  assert(row?.safetyFaults?.some(item => item.id === fault.id))
  return { row: structuredClone(row), fault: structuredClone(fault) }
}
async function run(name, action) {
  const before = checks
  try { await action(); tests.push({ name, status: 'passed', assertions: checks - before }) }
  catch (error) { tests.push({ name, status: 'failed', error: String(error), assertions: checks - before }) }
}
try {
  await run('real missing-task lookup retains facts through one service-owned dispatch', async () => {
    const f = fixture(), files = new PhysicalLocalFiles(path.join(temp, 'missing'))
    f.rt.files = files
    const record = { identity: identity('missing'), sessionId: 'retained-session', lastWake: { id: 'original', role: 'Worker', sources: [], reason: 'notification', context: { retained: 'input' } } }
    check(await f.rt.diagnoseMissingTask(record), true)
    await idle(f)
    check(f.wakeCalls.length, 1)
    check(f.wakeCalls[0].id.startsWith('safety-helper:'), true, 'No parallel host-error wake')
    const context = f.wakeCalls[0].context
    check(context.missingTaskMetadataPath, paths.task(record.identity.taskId))
    check(context.recordLocations, [{ taskId: record.identity.taskId, taskMetadataPath: paths.task(record.identity.taskId), cachePath: paths.cache(record.identity.taskId) }])
    check(context.originalWake, record.lastWake)
    check(context.sessionId, record.sessionId)
    check(context.instructions.includes('Preserve original files'), true)
    check(context.safetyFault.diagnosticContext, f.reports[0].origin.diagnosticContext)
    check(context.failureDetails, failureDetails(f.reports[0].error))
    check(f.reads.filter(key => key === prefix + 'wakes/').length, 1, 'Only existing Safety Net wake lookup remains')
    await files.close()
  })
  await run('same ordinary failure deduplicates; distinct Task retains its own facts', async () => {
    const f = fixture()
    f.rt.error(new Error('native input failed'), { identity: identity('A'), stage: 'startup-input-inspection' })
    f.rt.error(new Error('native input failed'), { identity: identity('A'), stage: 'startup-session-inspection' })
    f.rt.error(new Error('native input failed'), { identity: identity('B'), stage: 'startup-input-inspection' })
    await idle(f)
    check(f.wakeCalls.length, 2)
    check(f.wakeCalls.every(wake => wake.id.startsWith('safety-helper:')), true)
    check(f.wakeCalls.map(wake => wake.context.safetyFault.taskId).sort(), ['task-A', 'task-B'])
    check(f.wakeCalls.find(wake => wake.context.safetyFault.taskId === 'task-A').context.stage, 'startup-input-inspection')
  })
  await run('task-only context and original tool ownership survive routing', async () => {
    const f = fixture(), error = new Error('actual tool failure')
    rememberRoleErrorOrigin(error, { identity: identity('tool'), taskId: 'selected-task' })
    f.rt.error(error, { identity: identity('outer'), stage: 'tool' })
    f.rt.error(new Error('recorder refresh failed'), { taskId: 'task-context', recorderCommand: 'recorder-command' })
    await idle(f)
    const faults = [...f.rt.safetyEpisodes.values()].map(row => row.fault)
    check(faults.find(row => row.message === error.message).taskId, 'selected-task')
    check(faults.find(row => row.message === error.message).diagnosticContext.identity, identity('tool'))
    check(faults.find(row => row.message === 'recorder refresh failed').taskId, 'task-context')
  })
  await run('unchanged malformed authority reuses delivered legacy wake; changed content remains distinct', async () => {
    const f = fixture(), input = { path: 'technical/role.json', key: 'role-key', reason: 'malformed', contentVersion: 'content-A', value: { sessionId: 'original-session' } }
    const capture = fixture({ active: false }); capture.rt.reportRoleContentFault(input)
    await idle(capture)
    const context = { stage: 'role-discovery', path: input.path, key: input.key, roleAuthorityContent: input.contentVersion, taskGroups: [], nativeReferences: { sessionId: input.value.sessionId } }
    const signature = hash(JSON.stringify([capture.reports[0].error.message, context]))
    // A real pre-upgrade legacy wake contains these original diagnostic facts.
    const legacy = { request: { id: 'host-error:legacy', role: 'Helper', reason: 'helper', sources: [], context: { ...context, errorSignature: signature, facts: capture.reports[0].error.message } }, delivered: true }
    f.rows.set(prefix + 'wakes/' + hash(legacy.request.id), legacy)
    f.rt.reportRoleContentFault(input); await idle(f)
    check(f.wakeCalls.length, 0)
    check(f.rows.get(prefix + 'wakes/' + hash(legacy.request.id)).safetyFaults[0].diagnosticContext.roleAuthorityContent, 'content-A')
    f.rt.reportRoleContentFault({ ...input, contentVersion: 'content-B' }); await idle(f)
    check(f.wakeCalls.length, 1)
    check(f.wakeCalls[0].context.roleAuthorityContent, 'content-B')
  })
  await run('Host restore signature ignores unrelated targets but retains original full diagnostic payload', async () => {
    const f = fixture(), a = { identity: identity('active') }, b = { identity: identity('other') }
    const context = { hostRestorationCommandId: 'restore-host', phase: 'targets', activeTarget: a.identity.executionId, targets: [a, b] }
    f.rt.error(new Error('native stop failed'), context)
    f.rt.error(new Error('native stop failed'), { ...context, targets: [a, { identity: identity('changed-other') }] })
    await idle(f)
    check(f.wakeCalls.length, 1)
    check(f.wakeCalls[0].context.targets, [a, b])
    check(f.wakeCalls[0].context.safetyFault.diagnosticContext.hostRestorationCommandId, 'restore-host')
    check(f.wakeCalls[0].context.errorSignature, hash(JSON.stringify(['native stop failed', { ...context, targets: [a] }])))
    f.rt.error(new Error('native stop failed'), { ...context, activeTarget: b.identity.executionId }); await idle(f)
    check(f.wakeCalls.length, 2)
    check(f.wakeCalls[1].context.activeTarget, b.identity.executionId)
  })
  await run('controlled GitHub cooldown response keeps first fault per existing target', async () => {
    let requests = 0
    const client = new GitHubClient(async () => ({ value: 'test-only-noncredential', source: 'controlled test' }), async () => {
      requests++; return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 429, headers: { 'retry-after': '60' } })
    })
    const f = fixture(), errors = []
    for (const target of ['A', 'A', 'B']) try { await client.session(session => session.request('GET', '/user')) }
    catch (error) { errors.push(error); f.rt.error(error, { identity: identity(target), stage: 'member-query' }) }
    await idle(f)
    check(requests, 1); check(errors[0] !== errors[1], true); check(errors[0].rateLimit === errors[1].rateLimit, true)
    check(f.wakeCalls.length, 2)
    check(f.wakeCalls[0].context.safetyFault.identity, identity('A'))
    check(f.service.safetyErrors.get(errors[0]).faultId, f.service.safetyErrors.get(errors[1]).faultId)
    check(f.wakeCalls[1].context.safetyFault.identity, identity('B'))
    check(f.service.safetyErrors.get(errors[0]).faultId !== f.service.safetyErrors.get(errors[2]).faultId, true)
  })
  await run('delivered legacy Host restore diagnostic keeps its deterministic responsibility', async () => {
    const f = fixture(), context = { hostRestorationCommandId: 'legacy-command', phase: 'continuations', activeTarget: 'old-execution', targets: [{ identity: { workId: 'old-work', executionId: 'old-execution' } }] }
    const message = 'original native continuation failed', signature = hash(JSON.stringify([message, context]))
    const request = { id: 'host-restore-error:' + signature, role: 'Helper', reason: 'helper', sources: [], context: { ...context, errorSignature: signature, facts: message } }
    f.rows.set(prefix + 'wakes/' + hash(request.id), { request, delivered: true })
    f.rt.error(new Error(message), context); await idle(f)
    check(f.wakeCalls.length, 0)
    check(f.rows.get(prefix + 'wakes/' + hash(request.id)).safetyFaults[0].diagnosticContext, context)
  })
  await run('Helper self-failure attaches to its existing responsibility rather than creating another Helper', async () => {
    const f = fixture(), owner = { ...identity('helper'), role: 'Helper' }, request = { id: 'existing-helper-wake', role: 'Helper', reason: 'helper', sources: [], context: { facts: 'original responsibility' } }
    f.rt.roleRecords.set(owner.workId, { identity: owner, sessionId: 'helper-session', lastWake: request })
    f.rows.set(prefix + 'wakes/' + hash(request.id), { request, delivered: true })
    f.rt.error(new Error('Helper native input failed'), { identity: owner, stage: 'startup-input-inspection' }); await idle(f)
    check(f.wakeCalls.length, 0)
    check(f.rows.get(prefix + 'wakes/' + hash(request.id)).safetyFaults[0].diagnosticContext.identity, owner)
    const unavailable = fixture(); unavailable.rt.error(new Error('Helper native input failed'), { identity: owner }); await idle(unavailable)
    check(unavailable.wakeCalls.length, 0)
    check(unavailable.service.safetyNet.pending('local', scope).length, 1)
  })
  await run('native interaction contract stays actionable; ordinary 403 is still a fault', async () => {
    const f = fixture(), interaction = Object.assign(new Error('Native confirmation needed'), { interaction: { kind: 'authorization', requiresConfirmation: true } })
    // Contract branch input only: no claim that the installed SDK emitted it.
    f.rt.error(interaction, { identity: identity('confirmation') }); await idle(f)
    check(f.service.userErrors.get('local'), interaction.message); check(f.wakeCalls.length, 0)
    check(f.service.safetyNet.pending('local', scope).length, 0)
    f.rt.error(new GitHubError(403, 'repository access denied'), { identity: identity('denied') }); await idle(f)
    check(f.wakeCalls.length, 1); check(f.wakeCalls[0].context.failureDetails.status, 403)
  })
  await run('not-yet-running service keeps complete pending responsibility until activation', async () => {
    const f = fixture({ active: false }), context = { taskId: 'task-pending', stage: 'startup-missing-task', recordLocations: [{ taskId: 'task-pending', cachePath: 'cache/original' }], originalWake: { id: 'original-pending' } }
    f.rt.error(new Error('pending startup fault'), context); await idle(f)
    check(f.wakeCalls.length, 0)
    check(f.service.safetyNet.pending('local', scope)[0].diagnosticContext, context)
    f.service.running.set('local', { connection: { scope }, runtime: f.rt }); f.service.deliverSafetyFaults(); await idle(f)
    check(f.wakeCalls.length, 1); check(f.wakeCalls[0].context.originalWake, context.originalWake)
  })
  await run('shutdown waits for its already-started safety request', async () => {
    const f = fixture({ active: false }), entered = latch(), held = latch()
    const list = f.rt.records.list.bind(f.rt.records)
    f.rt.records.list = async key => { if (key === prefix + 'restores/') { entered.resolve(); await held.promise } return list(key) }
    const request = f.rt.requestSafetyRepair({ id: 'closing-fault', mode: 'local', scope, source: 'service', message: 'accepted before close', occurrence: 1 })
    await entered.promise
    Object.assign(f.rt, { cleaner: { close() {} }, cleanupResidues: new Map(), native: { cancelOpening: async () => ({ status: 'stopped' }) }, loop: { stop: async () => {} }, pendingControlStops: [], targetedPumps: new Map(), organizerWakeWrites: new Map(), observations: { dispose: async () => {} }, roleKey: () => 'Foreground', settleOperations: async () => {} })
    let closed = false; const closing = f.rt.dispose().then(() => { closed = true })
    try { await tick(); check(closed, false, 'Storage owner must not close while its accepted safety request can still write') }
    finally { held.resolve(); await Promise.all([request, closing]) }
    check(closed, true); check(f.wakeCalls.length, 1)
  })
  await run('cold replay preserves complete original context and UNKNOWN operation remains unresolved', async () => {
    const f = fixture(), error = new FilesOutcomeUnknownError('original-operation', new Error('transport outcome unavailable'))
    f.rt.error(error, { identity: identity('unknown'), stage: 'publication', originalWake: { id: 'original-wake' } }); await idle(f)
    const cold = fixture(), rows = [...f.rows.values()]
    cold.rt.replaySafetyWakes(rows)
    const originalFault = rows[0].safetyFaults[0], restored = cold.service.safetyNet.fault(originalFault.id)
    check(restored.diagnosticContext?.originalWake, { id: 'original-wake' })
    check(restored.diagnosticContext, originalFault.diagnosticContext)
    check(restored.operationId, 'original-operation')
    check(cold.service.safetyNet.presentation(originalFault.id).state, 'repairing')
    check(cold.wakeCalls.length, 0)
  })
  await run('actual old Host wake/fault bytes replay into the same exact diagnostic identity', async () => {
    const contexts = [
      { stage: 'role-discovery', path: 'technical/role.json', roleAuthorityContent: 'legacy-content', taskGroups: [], nativeReferences: {} },
      { hostRestorationCommandId: 'legacy-host-command', phase: 'continuations', errorName: 'Error', activeTarget: 'legacy-target', targets: [{ identity: { workId: 'legacy-work', executionId: 'legacy-target' } }] },
    ]
    for (const context of contexts) {
      const message = 'persisted original diagnostic', { row, fault } = await legacyDiagnostic(message, context), f = fixture()
      f.rows.set(prefix + 'wakes/' + hash(row.request.id), row)
      f.rt.replaySafetyWakes([row]); f.rt.error(new Error(message), context); await idle(f)
      check(f.service.safetyNet.records.size, 1, 'Original fault must not split into coarse and signed records')
      check(f.service.safetyNet.fault(fault.id).diagnosticContext, context)
      check(f.rt.safetyEpisodes.size, 1); check(f.wakeCalls.length, 0)
    }
  })
  await run('restore-row replay before or after the original old wake keeps one fault and its existing attempt', async () => {
    const context = { hostRestorationCommandId: 'original-host-command', phase: 'continuations', errorName: 'Error', activeTarget: 'original-target', targets: [{ identity: { workId: 'original-work', executionId: 'original-target' } }] }
    const { row, fault } = await legacyDiagnostic('original restore failure', context)
    for (const restoreFirst of [true, false]) {
      const f = fixture(), restore = { commandId: 'helper-repair-command', complete: false, safetyKind: 'host', safetyFaults: [fault], safetyAttempt: { failure: 'actual repair remains unresolved', terminal: false } }
      f.rows.set(prefix + 'wakes/' + hash(row.request.id), row)
      if (restoreFirst) f.rt.replaySafetyRestore(restore)
      f.rt.replaySafetyWakes([row])
      if (!restoreFirst) f.rt.replaySafetyRestore(restore)
      f.rt.error(new Error(fault.message), context); await idle(f)
      check(f.service.safetyNet.fault(fault.id).diagnosticContext, context)
      check(f.service.safetyNet.records.size, 1)
      check(f.rt.safetyEpisodes.size, 1); check(f.wakeCalls.length, 0)
      check(f.service.safetyNet.byId.get(fault.id).attempted.id, restore.commandId)
    }
  })
  await run('resolved original content cannot suppress a different signature in the same runtime occurrence', async () => {
    const f = fixture(); f.rt.safetyBaseOccurrence = f.service.safetyNet.begin()
    const original = { path: 'technical/same-role.json', reason: 'malformed', contentVersion: 'first-content', value: {} }
    f.rt.reportRoleContentFault(original); await idle(f)
    const first = [...f.rt.safetyEpisodes.values()][0].fault
    f.rt.environment.safetyResolved(first.id)
    f.rt.reportRoleContentFault({ ...original, contentVersion: 'changed-content' }); await idle(f)
    check(f.wakeCalls.length, 2, 'A different actual authority content is not the settled fact')
    check([...f.service.safetyNet.byId.values()].some(record => record.fault.diagnosticContext?.roleAuthorityContent === 'changed-content'), true)
  })
  await run('actual old same-message different-target faults sharing one wake do not inherit each other diagnostic target', async () => {
    const old = fixture({ active: false }); Object.setPrototypeOf(old.rt, LegacyRuntime.prototype)
    old.service.safetyNet = new LegacySafetyNet('historical-shared-host'); old.rt.errorTail = Promise.resolve()
    const base = { hostRestorationCommandId: 'shared-restore', phase: 'continuations', targets: [
      { identity: { workId: 'work-A', executionId: 'target-A' } }, { identity: { workId: 'work-B', executionId: 'target-B' } }] }
    const firstContext = { ...base, errorName: 'Error', activeTarget: 'target-A' }
    old.rt.error(new Error('same native failure message'), firstContext)
    old.rt.error(new TypeError('same native failure message'), { ...base, errorName: 'TypeError', activeTarget: 'target-B' })
    await old.rt.errorTail
    const faults = old.service.safetyNet.pending('local', scope)
    for (const fault of faults) await old.rt.arrangeSafetyRepair(fault)
    const shared = [...old.rows.values()].find(row => row.safetyFaults?.length === 2)
    check(!!shared, true, 'Historical production methods really place these distinct faults on one wake')
    check(shared.request.context.activeTarget, 'target-A')
    const current = fixture(); current.rt.replaySafetyWakes([shared])
    const first = current.service.safetyNet.fault(faults[0].id), second = current.service.safetyNet.fault(faults[1].id)
    check(first.diagnosticContext, firstContext)
    check(second.diagnosticContext, undefined, 'The TypeError has no proven target context on this wake')
    check(second.errorSignature, undefined)
    check(current.rt.safetyEpisodes.get(faults[1].id).fault.diagnosticContext, undefined)
    check(current.wakeCalls.length, 0)
  })
  await run('cold accepted Helper report restores original diagnostic identity before scheduler replay', async () => {
    const context = { hostRestorationCommandId: 'cold-report-restore', phase: 'continuations', errorName: 'Error', activeTarget: 'cold-report-target', targets: [{ identity: { workId: 'original-work', executionId: 'cold-report-target' } }] }
    const { row, fault } = await legacyDiagnostic('original cold report failure', context), f = fixture()
    const binding = { role: 'Helper', workId: 'existing-helper', executionId: 'accepted-helper' }
    f.rows.set(prefix + 'wakes/' + hash(row.request.id), row)
    f.rt.roleRecords.set(binding.workId, { identity: binding, lastWake: row.request })
    await f.rt.recordSafetyAttempt(binding, { faultId: fault.id, actionsTaken: 'Inspected the original target.', outcome: 'attempted-not-repaired', result: 'Original failure remains.' }, 'original-report')
    check(f.service.safetyNet.fault(fault.id).diagnosticContext, context)
    f.rt.error(new Error(fault.message), context); await idle(f)
    check(f.service.safetyNet.records.size, 1)
    check(f.rt.safetyEpisodes.size, 1); check(f.wakeCalls.length, 0)
    check(f.rows.get(prefix + 'wakes/' + hash(row.request.id)).safetyAttempts[0].fault.diagnosticContext, context)
  })
  await run('typed legacy diagnostic records retain identity and UNKNOWN on current replay', async () => {
    // These are explicit historical-record compatibility inputs, not claims
    // that the current Worker owner-recovery path can throw these errors.
    for (const error of [new FilesOutcomeUnknownError('original-unknown-operation'), new FilesConflictError('original-revision')]) {
      const context = { hostRestorationCommandId: 'historical-' + error.name, phase: 'continuations', errorName: error.name,
        ...(error instanceof FilesOutcomeUnknownError ? { operationId: error.operationId } : {}),
        activeTarget: identity('historical-target').executionId, targets: [{ identity: identity('historical-target'), sessionId: 'original-session' }] }
      const { row, fault } = await legacyDiagnostic(error, context), current = fixture()
      check(fault.failureDetails, undefined, 'Historical implementation did not persist the newer failureDetails field')
      current.rows.set(prefix + 'wakes/' + hash(row.request.id), row)
      current.rt.replaySafetyWakes([row]); current.rt.error(error, context); await idle(current)
      check(current.service.safetyNet.fault(fault.id).diagnosticContext, context)
      check(current.service.safetyNet.records.size, 1); check(current.wakeCalls.length, 0)
      if (error instanceof FilesOutcomeUnknownError) {
        check(current.service.safetyNet.fault(fault.id).operationId, error.operationId)
        current.rt.environment.safetyResolved(fault.id)
        check(current.service.safetyNet.presentation(fault.id).state, 'awaiting-outcome')
      }
    }
  })

  const result = { status: tests.every(row => row.status === 'passed') ? 'passed' : 'failed', assertions: checks, tests,
    limits: 'Production method bodies and actual SafetyNet/GitHub cooldown/physical missing-task file reads. Storage/wake/native boundaries are explicit controlled ports. Test timeouts only bound the harness; no latency, real network, model, full DSH host, Windows or published package acceptance is claimed.',
    sourceHashes: Object.fromEntries([...loaded].sort()) }
  console.log(JSON.stringify(result, null, 2)); if (result.status !== 'passed') process.exitCode = 1
} finally { await Promise.all(fixtureFiles.map(files => files.close())); hooks.deregister(); await fs.rm(temp, { recursive: true, force: true }) }
