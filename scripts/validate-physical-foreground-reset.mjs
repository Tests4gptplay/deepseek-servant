import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Current design: clearing Conversation preserves an unfinished root Task
// delivery. Use actual reset/wake/Host/cleanup methods and Linux physical files.
// Native stopping, technical StoragePort and the Git repository transport are
// explicit controlled ports, not installed DSH, Windows or full-typecheck QA.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){const children=[];for(const m of text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g))children.push({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}});return {type:'root',children}}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', root).href) return { url: data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skills outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8'); loaded.set(url.slice(root.href.length), hash(source))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { TaskWorkspaces } = await import('../src/framework/task-workspace.ts')
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { FrameworkCleaner } = await import('../src/framework/cleaner.ts')
const { FrameworkHostLoop, helperSignalWakeHash } = await import('../src/framework/host-loop.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { withSnapshot, withOperationChannel, GitFiles } = await import('../src/framework/transactions.ts')
const { GitAuthorityStore, SessionGitOperations, listAuthorityInRound } = await import('../src/framework/git-authority.ts')
const { paths, readJson, encodeJson, foregroundTaskSignal, taskLifecycle, taskLifecycleKey, taskWorkingRoots, assertTaskLifecycle } = await import('../src/framework/task-files.ts')
const { readTaskHistoryIdentity, readTaskReferenceIdentity, taskHistoryPath } = await import('../src/framework/task-history.ts')
const { taskArchiveHostKey, taskArchiveHostFacts, readTaskArchiveState } = await import('../src/framework/task-archive.ts')
const { prepareRecorderRetention, readArchivedReference } = await import('../src/framework/recorder-retention.ts')
const { parseDirectSignal } = await import('../src/framework/role-tools.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')

const source = readFileSync(new URL('framework/role-runtime.ts', root), 'utf8')
loaded.set('framework/role-runtime.ts', hash(source))
const js = stripTypeScriptTypes(source, { mode: 'transform' })
function method(name) {
  const found = new RegExp('\\n    (?:async )?' + name + '\\(').exec(js)
  assert.ok(found, 'production method: ' + name)
  const start = found.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start + found[0].length))
  assert.ok(next, 'next production method: ' + name)
  return js.slice(start, start + found[0].length + next.index)
}
const methods = ['roleKey', 'requestKey', 'serialWork', 'start', 'startInChannel', 'continueInitialization', 'discoverRoles', 'roleRecordProblem',
  'isForegroundResetComplete', 'withForegroundReset', 'recoverForegroundResetRows', 'wake', 'storeWake', 'updateWake', 'rememberAdmissionWake', 'forgetAdmissionWake', 'wakeAdmission', 'taskRuntimeReleased',
  'taskSealAt', 'archiveHostKey', 'taskCommandOwner', 'notifyForeground', 'foregroundNoticeState', 'forgetForegroundNotices',
  'admissionWakes', 'runQueueInChannel', 'settleOperations', 'transferredWorkerWake', 'beforeTaskUse', 'addressedSignals', 'consumeWakeSignals', 'taskNoticeConsumption']
const deps = { DshStorageAdapter: class ControlledNonDshStorageAdapter {}, hash, randomUUID, withSnapshot, withOperationChannel, PhysicalLocalFiles, GitAuthorityStore, listAuthorityInRound,
  paths, readJson, readTaskHistoryIdentity, readTaskReferenceIdentity, taskLifecycle, taskLifecycleKey, foregroundTaskSignal,
  assertTaskLifecycle, taskArchiveHostKey, taskArchiveHostFacts, readTaskArchiveState, helperSignalWakeHash, parseDirectSignal }
const Runtime = new Function(...Object.keys(deps), 'return class {\n' + methods.map(method).join('\n') + '\n}')(...Object.values(deps))
class Records {
  constructor(directory) { this.files = new LocalRecordFiles(directory); this.plannedResets = new Map() }
  name(key) { return Buffer.from(key).toString('base64url') + '.json' }
  async get(key) { const value = await this.files.read(this.name(key)); return value === undefined ? undefined : JSON.parse(value).value }
  async set(key, value) {
    await this.files.replace(this.name(key), JSON.stringify({ key, value }))
    if (key.includes('/foreground-resets/') && value.phase === 'planned') this.plannedResets.set(key, structuredClone(value))
  }
  async delete(key) { return this.files.delete(this.name(key)) }
  async list(prefix) { return (await Promise.all((await this.files.listMetadata('', false)).map(async row => JSON.parse(await this.files.read(row.path))))).filter(row => row.key.startsWith(prefix)) }
}
const read = (files, logical) => withSnapshot(files, snapshot => files.read(snapshot, logical))
async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Host cleanup did not settle')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const names = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const rejects = async (name, action, expression) => { await assert.rejects(action, expression); names.push(name) }
const command = 'clear-with-pending-result', resetKey = 'runtime/foreground-resets/' + hash(command)
const instanceUUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const request = (task, id = 'original-result', role = 'Foreground') => ({ id, role, taskId: task.taskId,
  ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}), reason: 'notification', sources: [] })
const transactionCalls = []
const physicalTransactions = { run(...args) { transactionCalls.push(args); throw new Error('Physical reset reached SQL/Git transaction') } }
async function runtimeFor(directory) {
  const files = new PhysicalLocalFiles(path.join(directory, 'local')), records = new Records(path.join(directory, 'technical'))
  const conversation = new FrameworkConversation(files, physicalTransactions, { mode: 'local', collaborationId: 'reset' })
  const runtime = Object.assign(new Runtime(), { files, records, conversation, transactions: physicalTransactions,
    prefix: 'runtime/', config: { mode: 'local', primary: true, member: 'A', scope: 'reset', instanceUUID, workerSeats: 1, workspace: path.join(directory, 'workspace') }, environment: {},
    closed: false, roleRecords: new Map(), wakeWrites: new Map(), wakeWriteOwners: new Map(), wakeConsumptions: new Map(),
    localWakeAdmissions: new Map(), reportedAdmissionDiagnostics: new Set(), admissionObservationVersion: 0,
    organizerWakeWrites: new Map(), helperWakeWrites: new Map(), nativeEvents: [],
    native: { get() { throw new Error('Native notification must remain held during reset') }, open() { throw new Error('Native admission must remain held during reset') } },
    loop: { async start() {} }, reconcileWorkerTransfers: async () => {}, continueNativeRetirements: () => {},
    replaySafetyWakes: () => {}, waitingSafetyResolution: () => false, active: () => false,
    assertOrganizerBusiness: () => {}, error(error) { throw error },
    finishForegroundRound: async () => { runtime.nativeEvents.push('finish') },
    stopOwnedRecord: async record => { runtime.nativeEvents.push('stop'); await runtime.saveRole({ ...record, stopped: true }); return { status: 'stopped' } },
    saveRole: async record => { await records.set('runtime/roles/' + hash(record.identity.workId), record); runtime.roleRecords.set(record.identity.workId, structuredClone(record)) },
    flushForegroundProcessWrites: async () => {},
  })
  // The extracted Runtime methods do not execute the production constructor.
  // Supply its real workspace dependency, including the exact Host archive key.
  runtime.workspaces = new TaskWorkspaces(files, runtime.config.workspace, runtime.config.member, runtime.config.instanceUUID, runtime.archiveHostKey())
  await runtime.start()
  return { directory, files, records, conversation, runtime, cleanup: new FrameworkManualCleanup(files, physicalTransactions, conversation, runtime) }
}
async function prepare(directory, { active = false, archived = false, lifecycleId } = {}) {
  const f = await runtimeFor(directory)
  const task = { version: 1, taskId: '10000000-0000-4000-8000-000000000001', route: 'P', owner: 'A', members: ['A'],
    status: 'complete', ...(lifecycleId ? { lifecycleId } : {}), sourcePath: 'tasks/Original_P.md', archiveFolder: 'Original_10000000-0000-4000-8000-000000000001', resultPaths: ['task-runs/10000000-0000-4000-8000-000000000001/result.md'] }
  await f.files.replace(paths.task(task.taskId), encodeJson(task))
  await f.files.replace(task.sourcePath, 'Task ID: ' + task.taskId + '\nOriginal requirement')
  await f.files.replace(task.resultPaths[0], 'Original delivered result')
  await f.conversation.send('old', { id: 'old', participantId: 'user', role: 'user', recipient: 'ai', text: 'Old conversation', createdAt: '2026-11-08T00:00:00.000Z' })
  await f.files.createIfAbsent(foregroundTaskSignal(task.taskId), '')
  const original = (await discover(f, task.taskId))[0]
  assert.ok(original, 'real Host discovers the original Task result')
  // Normal cases retain the actual Host shape. One separate field-preservation
  // case explicitly supplies an optional lifecycle already in a saved wake.
  const prior = { ...original.value.request, ...(lifecycleId ? { lifecycleId } : {}) }, key = original.key
  await f.records.set(key, { ...original.value, request: prior, delivered: active })
  if (active) {
    const record = { identity: { role: 'Foreground', workId: f.runtime.roleKey('Foreground'), executionId: 'original-execution', ...(lifecycleId ? { lifecycleId } : {}) }, sessionId: 'native-session', generation: 1,
      delivery: { request: prior, messageId: 'accepted-original-input', confirmed: true }, foregroundOutputIds: [] }
    await f.runtime.saveRole(record)
    await f.runtime.consumeWakeSignals(record.identity)
  }
  if (archived) {
    const retention = await withSnapshot(f.files, snapshot => prepareRecorderRetention(f.files, snapshot, task,
      { lifecycleId: task.lifecycleId, outputs: [paths.archive(task) + '/records.md'], retainedPaths: [] }, [{ path: paths.archive(task) + '/records.md', content: 'Recorder summary' }]))
    for (const change of [...retention.changes, ...retention.ancestorChanges]) await f.files.replace(change.path, change.bytes ?? change.content)
    await f.files.replace(paths.archive(task) + '/retention.json', encodeJson(retention.retention))
    await f.files.replace(paths.state('A', task.taskId) + '/Cleaner', '')
    const cleaner = new FrameworkCleaner(f.files, physicalTransactions), errors = [], cleanupOrder = []
    const host = new FrameworkHostLoop(f.files, physicalTransactions, f.records, { scope: 'cleaner', member: 'A', primary: true, instanceUUID }, () => ['A'], {
      async wake() {}, executing() { return false }, async releaseTask() { cleanupOrder.push('release') }, error(error) { errors.push(error) }, async observe() {},
      async clean(selected, snapshot, observation) { cleanupOrder.push('clean'); return (await cleaner.clean(selected, observation)).status === 'released' },
    })
    assert.notEqual(await read(f.files, paths.task(task.taskId)), undefined, 'Cleaner starts with real Task metadata')
    await withSnapshot(f.files, snapshot => host.scanTask(task, snapshot, performance.now()))
    const hostKey = 'framework-host/' + hash('cleaner')
    assert.ok(await f.records.get(hostKey), 'actual Host saved its cleanup responsibility')
    await until(async () => {
      const pending = (await f.records.get(hostKey))?.completed?.[taskLifecycleKey(task)]
      return errors.length > 0 || (await read(f.files, paths.task(task.taskId))) === undefined && !pending
    })
    if (errors.length) throw new AggregateError(errors)
    assert.deepEqual(cleanupOrder, ['release', 'clean'], 'real Host releases native Task ownership before Cleaner deletion')
    assert.equal(await read(f.files, paths.task(task.taskId)), undefined, 'real Cleaner/Host retired Task runtime metadata')
  }
  await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify(task))
  await fs.writeFile(path.join(directory, 'prior.json'), JSON.stringify(prior))
  return { ...f, task, prior, marker: foregroundTaskSignal(task.taskId) }
}
async function discover(f, taskId) {
  const errors = [], host = new FrameworkHostLoop(f.files, physicalTransactions, f.records, { scope: 'signals', member: 'A', primary: true, instanceUUID }, () => ['A'], {
    executing: () => false, wake: wake => f.runtime.wake(wake), error: error => errors.push(error),
  })
  await Promise.all(await host.runSignalPoll())
  if (errors.length) throw new AggregateError(errors)
  return (await f.records.list('runtime/wakes/')).filter(row => !row.value.delivered && row.value.request.taskId === taskId)
}
async function consume(f, wake) {
  // Native input acceptance is controlled; actual runtime consumption owns the
  // exact Host-discovered source version and deletes the actual physical file.
  const identity = { role: 'Foreground', workId: f.runtime.roleKey('Foreground'), executionId: 'new-execution' }
  const record = { identity, sessionId: 'new-session', generation: 1, lastWake: wake.request, completedRound: true }
  f.runtime.roleRecords.set(identity.workId, record)
  await f.records.set('runtime/roles/' + hash(identity.workId), record)
  await f.runtime.updateWake('runtime/wakes/' + hash(wake.request.id), current => ({ ...current, delivered: true }))
  await f.runtime.consumeWakeSignals(identity)
}
if (process.argv[2] === '--interrupt') {
  const [point, directory] = process.argv.slice(3), f = await runtimeFor(directory)
  const task = JSON.parse(await fs.readFile(path.join(directory, 'task.json'), 'utf8')), marker = foregroundTaskSignal(task.taskId)
  const prior = JSON.parse(await fs.readFile(path.join(directory, 'prior.json'), 'utf8'))
  const set = f.records.set.bind(f.records), create = f.files.createIfAbsent.bind(f.files), replace = f.files.replace.bind(f.files)
  f.records.set = async (key, value) => {
    await set(key, value)
    if (point === 'planned' && key === resetKey && value.phase === 'planned'
      || point === 'old-wake-retired' && key === 'runtime/wakes/' + hash(prior.id) && value.delivered
      || point === 'retired' && key === resetKey && value.phase === 'retired'
      || point === 'complete' && key === resetKey && value.phase === 'complete') process.exit(86)
  }
  f.files.createIfAbsent = async (logical, content) => {
    if (point === 'before-signal' && logical === marker) process.exit(86)
    const value = await create(logical, content)
    if (point === 'after-signal' && logical === marker) process.exit(86)
    return value
  }
  f.files.replace = async (logical, content) => {
    await replace(logical, content)
    if (point === 'cleared' && logical.startsWith('technical/manual-cleanup/commands/') && JSON.parse(content).completed) process.exit(86)
  }
  await f.cleanup.clearConversation(command, 'clear-foreground-conversation')
  throw new Error('Requested physical reset interruption was not reached: ' + point)
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-foreground-reset-')), opened = []
try {
  const active = await prepare(path.join(scratch, 'active'), { active: true }); opened.push(active.files)
  check('Foreground result wake does not bind a Task workspace', active.runtime.workspaces.knownTasks(), [])
  check('Foreground result wake does not write Host workspace metadata', (await withSnapshot(active.files, snapshot => readJson(active.files, snapshot, paths.task(active.task.taskId)))).hostWorkspaces, undefined)
  check('Original real Host wake owns its result signal before the unfinished native round', active.prior.sources.map(source => source.path), [active.marker])
  check('Original native round already consumed its marker before Conversation reset', await read(active.files, active.marker), undefined)
  await active.cleanup.clearConversation(command, 'clear-foreground-conversation')
  check('Active original native owner is finished and stopped before replacement notice', active.runtime.nativeEvents, ['finish', 'stop'])
  check('Normal Host Task notification keeps its original lifecycle shape', active.records.plannedResets.get(resetKey).pendingTasks[0].lifecycleId, undefined)
  check('Original result is pending in the new physical conversation', await read(active.files, active.marker), '')
  check('Successful clear removes only the original conversation', (await active.conversation.page(10)).messages.length, 0)
  check('Active reset reaches the existing complete phase', await active.runtime.isForegroundResetComplete(command), true)
  const existing = await active.files.fileInfo(active.marker)
  await active.cleanup.clearConversation(command, 'clear-foreground-conversation')
  check('Completed retry preserves the original signal file identity', await active.files.fileInfo(active.marker), existing)

  for (const point of ['planned', 'old-wake-retired', 'before-signal', 'after-signal', 'retired', 'cleared', 'complete']) {
    const directory = path.join(scratch, point), original = await prepare(directory, { active: true, archived: true })
    await original.files.close()
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', point, directory], { encoding: 'utf8' })
    check('Actual process interruption reaches ' + point, child.status, 86)
    const f = await runtimeFor(directory); opened.push(f.files)
    const marker = original.marker, before = await f.files.fileInfo(marker)
    check('Cold reset restores its existing admission hold at ' + point, !!f.runtime.pendingForegroundResets.size, point !== 'complete')
    check('Cleaner-retired Task stays absent at ' + point, await read(f.files, paths.task(original.task.taskId)), undefined)
    check('Actual Recorder history still resolves original result at ' + point,
      Buffer.from(await withSnapshot(f.files, snapshot => readArchivedReference(f.files, snapshot, original.task.taskId, original.task.resultPaths[0]))).toString(), 'Original delivered result')
    if (before && point !== 'complete') {
      await discover(f, original.task.taskId)
      await f.runtime.runQueueInChannel()
      const workId = f.runtime.roleKey('Foreground')
      f.runtime.roleRecords.set(workId, { identity: { workId, role: 'Foreground', executionId: 'held-notice-owner' }, sessionId: 'held-notice-session' })
      f.runtime.active = () => true
      await f.runtime.notifyForeground([{ path: marker, version: before.version }])
      f.runtime.roleRecords.delete(workId)
      f.runtime.active = () => false
      check('Cold pending reset admits or injects no native input at ' + point, f.runtime.nativeEvents, [])
    }
    await f.conversation.send('later', { id: 'later', participantId: 'user', role: 'user', recipient: 'ai', text: 'Later conversation', createdAt: '2026-11-08T00:01:00.000Z' })
    await f.cleanup.clearConversation(command, 'clear-foreground-conversation')
    check('Cold continuation completes the same reset at ' + point, await f.runtime.isForegroundResetComplete(command), true)
    check('Cold continuation preserves later conversation at ' + point, (await f.conversation.page(10)).messages.map(message => message.id), ['later'])
    check('Cold continuation retains its pending root Task notice at ' + point, await read(f.files, marker), '')
    if (before) check('Retry never replaces the already-published marker at ' + point, await f.files.fileInfo(marker), before)
    const wakes = await discover(f, original.task.taskId)
    check('Real Host discovers one pending root result at ' + point, wakes.length, 1)
    await consume(f, wakes[0].value)
    check('Actual Foreground consumption removes its observed marker at ' + point, await read(f.files, marker), undefined)
    await f.cleanup.clearConversation(command, 'clear-foreground-conversation')
    check('Same completed clear never re-emits a consumed result at ' + point, await read(f.files, marker), undefined)
    check('History lookup did not recreate runtime Task metadata at ' + point, await read(f.files, paths.task(original.task.taskId)), undefined)
    check('No transaction journal was created at ' + point, (await withSnapshot(f.files, snapshot => f.files.list(snapshot, 'technical/'))).filter(row => row.path.includes('command-transactions')).length, 0)
  }

  for (const point of ['before-signal', 'after-signal', 'retired', 'complete']) {
    const directory = path.join(scratch, 'error-' + point), f = await prepare(directory, { active: true, archived: true })
    const create = f.files.createIfAbsent.bind(f.files), set = f.records.set.bind(f.records)
    let fail = true
    f.files.createIfAbsent = async (logical, content) => {
      if (fail && point === 'before-signal' && logical === f.marker) { fail = false; throw new Error('Known reset write failure') }
      const result = await create(logical, content)
      if (fail && point === 'after-signal' && logical === f.marker) { fail = false; throw new Error('Known reset write failure') }
      return result
    }
    f.records.set = async (key, value) => {
      if (fail && key === resetKey && value.phase === point) { fail = false; throw new Error('Known reset write failure') }
      await set(key, value)
    }
    await rejects('Known reset failure propagates at ' + point, () => f.cleanup.clearConversation(command, 'clear-foreground-conversation'), /Known reset write failure/)
    check('Known failure keeps the last saved reset phase at ' + point, (await f.records.get(resetKey)).phase, point === 'complete' ? 'retired' : 'planned')
    check('Known failure keeps Foreground held at ' + point, f.runtime.pendingForegroundResets.has(command), true)
    const before = await f.files.fileInfo(f.marker)
    await f.files.close()
    const cold = await runtimeFor(directory); opened.push(cold.files)
    await cold.cleanup.clearConversation(command, 'clear-foreground-conversation')
    check('Cold retry finishes the original failed reset at ' + point, await cold.runtime.isForegroundResetComplete(command), true)
    check('Cold retry publishes the still-pending original result at ' + point, await read(cold.files, f.marker), '')
    if (before) check('Cold retry preserves the original publication after known ' + point + ' error', await cold.files.fileInfo(f.marker), before)
  }

  const optional = await prepare(path.join(scratch, 'saved-lifecycle'), { active: true, archived: true, lifecycleId: 'saved-round' }); opened.push(optional.files)
  await optional.cleanup.clearConversation(command, 'clear-foreground-conversation')
  check('Separately supplied saved lifecycle survives the reset replacement request', optional.records.plannedResets.get(resetKey).pendingTasks[0].lifecycleId, 'saved-round')
  check('Reset publication accepts that matching historical lifecycle', await read(optional.files, optional.marker), '')

  const isolated = await prepare(path.join(scratch, 'identity')); opened.push(isolated.files)
  // A real child has a reciprocal O → P relationship; a P parent without a
  // children link was never a valid workspace family. Keep the root-only
  // publication assertions while constructing that actual supported family.
  const childId = '10000000-0000-4000-8000-000000000002'
  const rootTask = { ...isolated.task, route: 'O', sourcePath: 'tasks/Original_O.md', children: [{ taskId: childId, objectiveId: 'child', member: 'A' }] }
  const childTask = { ...isolated.task, taskId: childId, sourcePath: 'tasks/Child_P.md', archiveFolder: rootTask.archiveFolder + '/Child_' + childId, parent: { taskId: rootTask.taskId, owner: 'A', objectiveId: 'child' } }
  await isolated.files.replace(paths.task(rootTask.taskId), encodeJson(rootTask))
  await isolated.files.replace(rootTask.sourcePath, 'Task ID: ' + rootTask.taskId + '\nRoot O requirement')
  await isolated.files.replace(childTask.sourcePath, 'Task ID: ' + childTask.taskId + '\nChild P requirement')
  await isolated.files.delete(isolated.task.sourcePath)
  await isolated.files.replace(paths.task(childTask.taskId), encodeJson(childTask))
  await isolated.files.delete(foregroundTaskSignal(rootTask.taskId))
  for (const role of ['Foreground', 'Recorder']) {
    await isolated.runtime.wake({ ...request(childTask, 'child-' + role, role), reason: 'business-complete' })
    check('Child Task never receives root-only ' + role + ' signal', await read(isolated.files, role === 'Foreground' ? foregroundTaskSignal(childTask.taskId) : paths.state('A', childTask.taskId) + '/Recorder'), undefined)
  }
  check('Child Recorder wake binds the actual root Task to this Host workspace', (await withSnapshot(isolated.files, snapshot => readJson(isolated.files, snapshot, paths.task(rootTask.taskId)))).hostWorkspaces, { [instanceUUID]: isolated.runtime.config.workspace })
  check('Child Recorder resolves the same root workspace', isolated.runtime.workspaces.rootFor(childTask.taskId), isolated.runtime.config.workspace)
  check('Wake binding alone does not create a native workspace directory', existsSync(isolated.runtime.config.workspace), false)
  await rejects('An actual missing Task reference is not treated as successful publication', () => isolated.runtime.wake({ ...request({ taskId: 'missing' }), reason: 'business-complete' }), /missing or different/)
  await rejects('Different Task lifecycle never receives a stale reset notice', () => isolated.runtime.wake({ ...request(rootTask), lifecycleId: 'old-round', reason: 'business-complete' }), /missing or different/)
  check('Invalid identities leave the root notice absent', await read(isolated.files, foregroundTaskSignal(rootTask.taskId)), undefined)
  await isolated.runtime.wake({ ...request(rootTask, 'recorder', 'Recorder'), reason: 'business-complete' })
  check('Current root Recorder retains its existing signal contract', await read(isolated.files, paths.state('A', rootTask.taskId) + '/Recorder'), '')
  check('All Physical cases avoid generic SQL/Git transactions', transactionCalls.length, 0)

  const repository = new Repository(), gitFiles = new GitFiles(repository, new SessionGitOperations()), gitRecords = new GitAuthorityStore(gitFiles, 'reset')
  const git = (await runtimeFor(path.join(scratch, 'git-ports'))).runtime; opened.push(git.files)
  Object.assign(git, { files: gitFiles, records: gitRecords, config: { ...git.config, mode: 'git' }, transactions: new FrameworkTransactions(gitFiles, gitRecords, 'reset') })
  git.workspaces = new TaskWorkspaces(gitFiles, git.config.workspace, git.config.member, git.config.instanceUUID, git.archiveHostKey())
  put(repository, paths.task(rootTask.taskId), rootTask); put(repository, paths.task(childTask.taskId), childTask); head(repository)
  for (const role of ['Foreground', 'Recorder']) {
    await git.wake({ ...request(rootTask, 'git-' + role, role), reason: 'business-complete' })
    check('Actual GitFiles still publishes root ' + role + ' through its transaction route', await read(gitFiles, role === 'Foreground' ? foregroundTaskSignal(rootTask.taskId) : paths.state('A', rootTask.taskId) + '/Recorder'), '')
    await git.wake({ ...request(childTask, 'git-child-' + role, role), reason: 'business-complete' })
    check('Git child still omits ' + role + ' publication', await read(gitFiles, role === 'Foreground' ? foregroundTaskSignal(childTask.taskId) : paths.state('A', childTask.taskId) + '/Recorder'), undefined)
  }
  check('Git Recorder binding uses actual Git Task metadata', (await withSnapshot(gitFiles, snapshot => readJson(gitFiles, snapshot, paths.task(rootTask.taskId)))).hostWorkspaces, { [instanceUUID]: git.config.workspace })
  check('Git binding did not write the former Local store', await read(opened.at(-1), paths.task(rootTask.taskId)), undefined)
  check('Git validation executed its repository commit port', repository.calls.length > 0, true)
  console.log(JSON.stringify({ status: 'passed', assertions: names.length, cases: names,
    scope: 'Actual TaskWorkspaces with valid reciprocal O-to-P metadata, production reset/wake, cold startup reset hold, manual Conversation cleanup, Host signal discovery, consumption, Recorder retention and Cleaner/Host metadata retirement; Linux physical files. Native stop/admission, technical StoragePort, schema/Markdown and Git transport are controlled ports. No installed DSH/Windows/full-typecheck acceptance.', sourceHashes: Object.fromEntries(loaded) }, null, 2))
} finally {
  await Promise.all(opened.map(files => files.close()))
  hooks.deregister()
  await fs.rm(scratch, { recursive: true, force: true })
}
