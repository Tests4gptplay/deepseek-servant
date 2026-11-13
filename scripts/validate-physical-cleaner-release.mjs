import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual physical directory operations, FrameworkCleaner, Host scan and exact
// current runtime release methods. Native Agent stopping is a controlled port;
// the technical StoragePort is physical JSON test storage (not native DSH KV).
// No business delete/release method, archive updater or observation/control
// implementation is replaced. This is not Windows, installed DSH or cutover QA.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const schema = `const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw new Error("Markdown parsing is outside this Cleaner check")}', shortCircuit: true }
    if (specifier === 'zod') return { url: 'data:text/javascript;base64,' + Buffer.from(schema).toString('base64'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', sourceRoot).href) return { url: 'data:text/javascript,export const frameworkSkillIndexPath="skills/index.md";export function isFrameworkSkillDefinitionPath(){throw new Error("Skill definition outside this test")}export function prepareFrameworkSkillIndex(){throw new Error("Skills must not run during Cleaner")}', shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { DshStorageAdapter } = await import('../src/adapters/dsh/storage.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { FrameworkCleaner, observeCleanup } = await import('../src/framework/cleaner.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { ExecutionControls } = await import('../src/framework/execution-control.ts')
const { ExecutionObservations } = await import('../src/framework/execution-observation.ts')
const { DurableObservationStore } = await import('../src/framework/observation-store.ts')
const { GitAuthorityStore } = await import('../src/framework/git-authority.ts')
const { paths, readJson, taskLifecycle, taskLifecycleKey, taskWorkingRoots, encodeJson, isTerminalTask, assertTaskLifecycle } = await import('../src/framework/task-files.ts')
const { withSnapshot, withOperationChannel } = await import('../src/framework/transactions.ts')
const { taskArchiveHostKey, taskArchiveLifecycle, taskArchiveHostFacts, readTaskArchiveState, updateTaskArchiveState } = await import('../src/framework/task-archive.ts')
const { workerTransferPath } = await import('../src/framework/worker-business.ts')
const { retireNativeSession } = await import('../src/adapters/dsh/native-cleaner.ts')
const { localForegroundRoleRecordPath } = await import('../src/framework/conversation.ts')
const hash = value => createHash('sha256').update(value).digest('hex')
const runtimeSource = readFileSync(new URL('framework/role-runtime.ts', sourceRoot), 'utf8')
loaded.set('framework/role-runtime.ts', hash(runtimeSource))
const runtimeJs = stripTypeScriptTypes(runtimeSource, { mode: 'transform' })
function method(name) {
  const match = new RegExp('\\n    (?:async )?' + name + '\\(').exec(runtimeJs)
  assert.ok(match, 'production method exists: ' + name)
  const start = match.index + 1
  const next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(runtimeJs.slice(start + match[0].length))
  assert.ok(next, 'next production method exists: ' + name)
  return runtimeJs.slice(start, start + match[0].length + next.index)
}
const selectedMethods = ['forgetAdmissionWake', 'settleOperations', 'serialWork', 'localTaskRetirementRows', 'roleKey', 'roleRecordPath', 'assertOrganizerBusiness', 'cleanAt', 'releaseLocalTask', 'releaseTask', 'retireTaskRuntime', 'commitTaskSeal',
  'cleanupWorkerTransfers', 'workerBusinessScope', 'taskReleaseWakes', 'deleteRuntimeRecord', 'withRoleWrite',
  'restoreTaskOwner', 'watchKey', 'serialRecoveryWatch', 'withTaskFacts', 'archiveHostKey', 'taskSealAt',
  'taskRuntimeReleased', 'saveRole', 'saveRoleInChannel', 'saveRetiredWorker', 'saveRetiredWorkerInChannel',
  'active', 'stopOwnedRecord', 'continueNativeRetirements']
const dependencies = { DshStorageAdapter, PhysicalLocalFiles, GitAuthorityStore, withSnapshot, withOperationChannel, paths, readJson,
  taskLifecycle, taskLifecycleKey, encodeJson, isTerminalTask, assertTaskLifecycle, hash, updateTaskArchiveState,
  taskArchiveHostKey, taskArchiveLifecycle, taskArchiveHostFacts, readTaskArchiveState, workerTransferPath, retireNativeSession, localForegroundRoleRecordPath,
  SessionId: value => value }
const Runtime = new Function(...Object.keys(dependencies), 'return class {\n' + selectedMethods.map(method).join('\n') + '\n}')(...Object.values(dependencies))
class TechnicalRecords {
  constructor(root) { this.files = new LocalRecordFiles(root) }
  // Scoped role keys exceed one filename when base64-encoded; retain the full
  // key in the envelope and bound this test storage filename, as production does.
  filename(key) { return 'records/' + hash(key) + '.json' }
  async get(key) { const text = await this.files.read(this.filename(key)); return text === undefined ? undefined : JSON.parse(text).value }
  async set(key, value) { await this.files.replace(this.filename(key), JSON.stringify({ key, value })) }
  async delete(key) { await this.files.delete(this.filename(key)) }
  async list(prefix) {
    const rows = []
    for (const entry of await this.files.listMetadata('records', false)) {
      // Another exact Task retirement may remove a row after enumeration.
      // Missing is not malformed JSON; other parse/read errors still surface.
      const text = await this.files.read(entry.path)
      if (text === undefined) continue
      const row = JSON.parse(text)
      if (row.key.startsWith(prefix)) rows.push(row)
    }
    return rows
  }
}
let assertions = 0
const check = (value, expected) => { assert.deepEqual(value, expected); assertions++ }
const rejects = async (work, pattern) => { await assert.rejects(work, pattern); assertions++ }
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-physical-cleaner-'))
const stores = []
async function runtimeFor(files, records, name) {
  const runtime = new Runtime(), stopped = [], failures = new Set()
  Object.assign(runtime, { files, records, prefix: 'framework-runtime/' + hash(name) + '/', config: { scope: name, collaborationId: name, instanceUUID: 'host', member: 'A', mode: 'local' },
    localWakeAdmissions: new Map(), reportedAdmissionDiagnostics: new Set(), pendingControlStops: [], cleanupResidues: new Map(), roleRecords: new Map(), retiredWorkers: new Map(), roleWrites: new Map(), roleWriteOwners: new Map(),
    wakeWrites: new Map(), wakeWriteOwners: new Map(), observationRecordWrites: new Map(), restoreWriteOwners: new Map(), safetyRestoreWrites: new Map(),
    wakeConsumptions: new Map(), safetyEpisodes: new Map(), resolvedSafetyFaultIds: new Set(), stopOperations: new Map(),
    environment: { changed() {}, resolved() {} }, error() {}, ctx: { get(name) { return name === 'nativeSessionCleaner' ? { async retire() {} } : { list() { return [] } } }, agents: { get() {} }, jobs: { list() { return [] } } },
    native: { get() {}, async stop(workId, executionId) { stopped.push(executionId); return failures.has(executionId)
      ? { status: 'unconfirmed', reason: 'controlled native stop interruption', jobs: [] } : { status: 'stopped' } } },
  })
  runtime.controls = new ExecutionControls(records, name, undefined, files, records, 'host')
  // This Cleaner-only fixture has no accepted execution-control commands. The
  // production settle path is covered by the full Runtime/Service checks.
  runtime.applyUserControls = async () => {
    for (const record of runtime.roleRecords.values()) assert.equal(await runtime.controls.execution(record.identity), undefined)
  }
  runtime.observations = new ExecutionObservations(new DurableObservationStore(records, name, (identity, snapshot) => runtime.taskRuntimeReleased(identity, snapshot)), { async arrange() {} }, error => { throw error })
  runtime.transactions = new FrameworkTransactions(files, records, name)
  runtime.cleaner = new FrameworkCleaner(files, runtime.transactions, task => runtime.releaseLocalTask(task.taskId, task.lifecycleId, task))
  for (const row of await records.list(runtime.prefix + 'roles/')) runtime.roleRecords.set(row.value.identity.workId, row.value)
  for (const row of await records.list(runtime.prefix + 'retired-workers/')) runtime.retiredWorkers.set(row.value.identity.executionId, row.value)
  return { runtime, stopped, failures }
}
async function setup(name) {
  const root = path.join(sandbox, name), files = new PhysicalLocalFiles(path.join(root, 'local')), records = new TechnicalRecords(path.join(root, 'technical'))
  stores.push(files)
  const make = (suffix, route, owner, parent) => ({ version: 1, taskId: '00000000-0000-4000-8000-' + hash(name + suffix).slice(0, 12), route, owner, status: 'running',
    sourcePath: 'tasks/' + name + '-' + suffix + '_' + route + '.md', archiveFolder: '00000000-0000-4000-8000-' + hash(name + suffix).slice(0, 12), members: [owner], ...(parent ? { parent } : {}) })
  const total = make('root', 'O', 'A'), child = make('child', 'O', 'B', { taskId: total.taskId, owner: 'A', objectiveId: 'one' })
  const leaf = make('leaf', 'P', 'C', { taskId: child.taskId, owner: 'B', objectiveId: 'two' }), other = make('other', 'P', 'A')
  total.children = [{ taskId: child.taskId, member: 'B', objectiveId: 'one' }]
  child.children = [{ taskId: leaf.taskId, member: 'C', objectiveId: 'two' }]
  child.archiveFolder = total.archiveFolder + '/' + child.taskId; leaf.archiveFolder = child.archiveFolder + '/' + leaf.taskId
  const family = [total, child, leaf]
  for (const task of [...family, other]) {
    await files.replace(paths.task(task.taskId), encodeJson(task))
    await files.replace(task.sourcePath, 'Task ID: ' + task.taskId + '\nExact task source')
    for (const dir of taskWorkingRoots(task)) await files.replace(dir + '/nested/ordinary.md', 'temporary body')
    await files.replace(paths.archive(task) + '/records.md', 'permanent record')
  }
  await files.replace('skills/example/SKILL.md', 'permanent skill'); await files.replace('debug/day.md', 'debug remains')
  await files.replace('state/Foreground_Task_' + total.taskId, ''); await files.replace('conversations/live.md', 'chat remains')
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true }); await fs.writeFile(path.join(root, 'workspace/result.txt'), 'deliverable')
  const { runtime, stopped, failures } = await runtimeFor(files, records, name)
  for (const [i, task] of [...family, other].entries()) {
    const workId = JSON.stringify([task.route === 'O' ? 'Organizer' : 'Planner', task.taskId, null, null])
    const identity = { role: task.route === 'O' ? 'Organizer' : 'Planner', taskId: task.taskId, workId, executionId: name + '-exec-' + i, member: task.owner }
    const record = { identity, sessionId: name + '-session-' + i, generation: 1 }
    await runtime.saveRole(record)
    await records.set(runtime.prefix + 'wakes/' + hash(identity.executionId), { request: { taskId: task.taskId, role: identity.role, id: identity.executionId }, delivered: true })
    await records.set(runtime.watchKey(task.taskId, 'A'), { taskId: task.taskId })
  }
  const cleanerPath = paths.state(total.owner, total.taskId) + '/Cleaner'
  const notice = async () => { await files.replace(cleanerPath, '') }
  const observe = task => withSnapshot(files, snapshot => observeCleanup(files, snapshot, task, performance.now()))
  const run = async (selected = total) => {
    const snapshot = await files.snapshot()
    try { const observation = await observeCleanup(files, snapshot, selected, performance.now()); return await runtime.cleanAt(selected, snapshot, observation) }
    finally { await snapshot.release() }
  }
  const exists = async logical => { try { await fs.lstat(path.join(files.directory, logical)); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
  return { root, files, records, runtime, total, child, leaf, other, family, failures, stopped, cleanerPath, notice, observe, run, exists }
}
async function hostFor(f, name, options = {}) {
  const errors = [], host = new FrameworkHostLoop(f.files, f.runtime.transactions, f.records,
    { scope: name, member: 'A', primary: true, instanceUUID: 'host' }, () => ['A'], {
      async wake() {}, executing() { return false }, error(error) { errors.push(error) },
      async releaseTask(id, lifecycle, selected) { if (options.release) await options.release(selected); return f.runtime.releaseLocalTask(id, lifecycle, selected) },
      clean(task, snapshot, observed) { return f.runtime.cleanAt(task, snapshot, observed) },
    })
  host.record = await f.records.get(host.key) ?? { initial: {}, completed: {} }
  const scan = () => withSnapshot(f.files, snapshot => host.scanTask(f.total, snapshot, performance.now()))
  const drain = async () => { await Promise.allSettled([...host.physicalReleaseOperations.values()]); await host.continuePhysicalCleanup(taskLifecycleKey(f.total)) }
  return { host, errors, scan, drain }
}
async function assertPreserved(f) {
  check(await f.exists(paths.task(f.other.taskId)), true)
  for (const task of f.family) check(await f.exists(paths.archive(task) + '/records.md'), true)
  for (const dir of taskWorkingRoots(f.other)) check(await f.exists(dir + '/nested/ordinary.md'), true)
  for (const logical of ['skills/example/SKILL.md', 'debug/day.md', 'state/Foreground_Task_' + f.total.taskId, 'conversations/live.md']) check(await f.exists(logical), true)
  check(await fs.readFile(path.join(f.root, 'workspace/result.txt'), 'utf8'), 'deliverable')
}
if (process.argv[2] === '--interrupt') {
  const [checkpoint, root, name, taskId] = process.argv.slice(3)
  const files = new PhysicalLocalFiles(path.join(root, 'local')), records = new TechnicalRecords(path.join(root, 'technical'))
  const { runtime } = await runtimeFor(files, records, name)
  const total = await withSnapshot(files, snapshot => readJson(files, snapshot, paths.task(taskId)))
  const h = await hostFor({ files, records, runtime, total }, name)
  if (checkpoint === 'directory' || checkpoint === 'signal-directory') {
    const remove = files.removeDirectory.bind(files)
    files.removeDirectory = async (...args) => { const logical=args[0]; await remove(...args); if (checkpoint === 'directory' || logical === paths.state(total.owner, total.taskId)) process.exit(86) }
  } else if (checkpoint === 'metadata') {
    const update = files.update.bind(files)
    files.update = async (...args) => { const value = await update(...args); if (args[0] === paths.task(total.taskId)) process.exit(86); return value }
  } else throw new Error('Unknown interruption')
  await h.scan()
  await Promise.allSettled([...h.host.physicalReleaseOperations.values()])
  await h.host.continuePhysicalCleanup(taskLifecycleKey(total))
  throw new Error('Expected process interruption did not execute')
}
try {
  const f = await setup('direct')
  check(await f.run(), false)
  await f.files.replace(paths.state(f.child.owner, f.child.taskId) + '/Cleaner', '')
  check(await f.run(f.child), false)
  await f.notice(); await f.files.replace(paths.state(f.total.owner, f.total.taskId) + '/Recorder', '')
  await f.files.replace(f.child.sourcePath, 'Task ID: replacement-task\nDo not delete')
  const reads = [], read = f.files.read.bind(f.files), removed = [], remove = f.files.removeDirectory.bind(f.files)
  f.files.read = async (snapshot, logical) => { reads.push(logical); return read(snapshot, logical) }
  f.files.removeDirectory = async (...args) => { removed.push(args[0]); return remove(...args) }
  let releaseResources
  const held = new Promise(resolve => { releaseResources = resolve })
  const h = await hostFor(f, 'direct', { release: () => held })
  // Existing source initialization, child discovery and independent native
  // release must not hold instructed cleanup.
  h.host.sourceOperations.set(f.child.sourcePath, new Promise(() => {}))
  h.host.taskLanes.set(paths.task(f.child.taskId), { running: new Promise(() => {}) })
  await Promise.race([h.scan(), new Promise((_, reject) => setTimeout(() => reject(new Error('Native/scan blocked Cleaner')), 3000))])
  for (const task of f.family) { for (const dir of taskWorkingRoots(task)) check(await f.exists(dir), false); check(await f.exists(paths.task(task.taskId)), true) }
  check(removed.length, f.family.flatMap(taskWorkingRoots).length)
  check(f.stopped, [])
  check(!!(await f.records.get(h.host.key)).completed[taskLifecycleKey(f.total)].cleanup, true)
  check(await f.exists(f.child.sourcePath), true); check(await f.exists(f.total.sourcePath), false)
  check(reads.some(logical => logical.startsWith('skills/') || logical.endsWith('/records.md') || logical.endsWith('/retention.json')), false)
  // Another scan while native release is held does not repeat this cleanup.
  await h.host.continuePhysicalCleanup(taskLifecycleKey(f.total))
  check(removed.length, f.family.flatMap(taskWorkingRoots).length)
  releaseResources(); await h.drain()
  for (const task of f.family) { for (const dir of taskWorkingRoots(task)) check(await f.exists(dir), false); check(await f.exists(paths.task(task.taskId)), false) }
  check(removed.length, f.family.flatMap(taskWorkingRoots).length)
  check(await f.exists(f.child.sourcePath), true); check(await f.exists(f.total.sourcePath), false)
  check(h.errors.map(error => error.message), [])
  check((await f.records.get(h.host.key)).completed[taskLifecycleKey(f.total)]?.cleanup, undefined)
  check((await f.records.list(f.runtime.prefix + 'roles/')).length, 1)
  check((await f.records.list(f.runtime.prefix + 'wakes/')).length, 1)
  await assertPreserved(f)

  // Native journal acceptance failure preserves exact role/Host ownership but
  // cannot block the requested fixed-directory cleanup.
  const failed = await setup('native-failure'); await failed.notice()
  let rejectJournal = true
  failed.runtime.ctx.get = name => name === 'nativeSessionCleaner' ? { async retire() { if (rejectJournal) throw new Error('journal unavailable') } } : { list() { return [] } }
  const fh = await hostFor(failed, 'native-failure'); await fh.scan(); await fh.drain()
  check(fh.errors.length > 0, true)
  for (const task of failed.family) check(await failed.exists(paths.run(task.taskId)), false)
  check((await failed.records.list(failed.runtime.prefix + 'roles/')).length, 4)
  check(!!(await failed.records.get(fh.host.key)).completed[taskLifecycleKey(failed.total)].cleanup, true)
  rejectJournal = false; await fh.host.continuePhysicalCleanup(taskLifecycleKey(failed.total)); await fh.drain()
  for (const task of failed.family) check(await failed.exists(paths.run(task.taskId)), false)
  check((await failed.records.list(failed.runtime.prefix + 'roles/')).length, 1)

  // A fast native handoff must not retire Host family when exact metadata
  // removal failed after directory removal. This is the actual concurrent seam.
  const metaFailure = await setup('metadata-failure'); await metaFailure.notice()
  const mh = await hostFor(metaFailure, 'metadata-failure'), originalUpdate = metaFailure.files.update.bind(metaFailure.files)
  let metadataFailure = true
  metaFailure.files.update = async (...args) => {
    if (metadataFailure && args[0] === paths.task(metaFailure.total.taskId)) {
      await Promise.allSettled([...mh.host.physicalReleaseOperations.values()])
      throw new Error('controlled metadata retirement failure')
    }
    return originalUpdate(...args)
  }
  await mh.scan()
  const pendingMeta = (await metaFailure.records.get(mh.host.key)).completed[taskLifecycleKey(metaFailure.total)]
  check(!!pendingMeta.cleanup, true); check(pendingMeta.released, undefined)
  check(await metaFailure.exists(paths.task(metaFailure.total.taskId)), true)
  metadataFailure = false
  await mh.host.continuePhysicalCleanup(taskLifecycleKey(metaFailure.total)); await mh.drain()
  check(await metaFailure.exists(paths.task(metaFailure.total.taskId)), false)
  check((await metaFailure.records.get(mh.host.key)).completed[taskLifecycleKey(metaFailure.total)]?.cleanup, undefined)

  // Real process death after the original signal's directory is gone and
  // after metadata retirement. Only persisted Host family names are reused.
  let processInterruptions = 0
  for (const checkpoint of ['directory', 'signal-directory', 'metadata']) {
    const crashed = await setup('crash-' + checkpoint); await crashed.notice()
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', checkpoint, crashed.root, 'crash-' + checkpoint, crashed.total.taskId], { encoding: 'utf8' })
    if (result.status !== 86) throw new Error(result.stderr || result.stdout)
    check(result.status, 86); processInterruptions++
    if (checkpoint !== 'directory') check(await crashed.exists(crashed.cleanerPath), false)
    const files = new PhysicalLocalFiles(crashed.files.directory); stores.push(files)
    const records = new TechnicalRecords(path.join(crashed.root, 'technical'))
    const { runtime } = await runtimeFor(files, records, 'crash-' + checkpoint)
    const cold = await hostFor({ ...crashed, files, records, runtime }, 'crash-' + checkpoint)
    check(!!cold.host.record.completed[taskLifecycleKey(crashed.total)].cleanup, true)
    await cold.host.continuePhysicalCleanup(taskLifecycleKey(crashed.total)); await cold.drain()
    check(cold.errors.map(error => error.message), [])
    for (const task of crashed.family) { for (const dir of taskWorkingRoots(task)) check(await crashed.exists(dir), false); check(await crashed.exists(paths.task(task.taskId)), false) }
    check((await records.list(runtime.prefix + 'roles/')).length, 1)
    await assertPreserved(crashed)
  }
  // Actual saveRole merger keeps only unaccepted completed Foreground sessions
  // across replacement. No stop/idle-only inference creates retirement.
  const fg = await setup('foreground-retirement'), fgWork = JSON.stringify(['Foreground', null, null, null])
  const first = { identity: { workId: fgWork, executionId: 'fg-1', role: 'Foreground' }, sessionId: 'fg-session-1', generation: 1 }
  fg.runtime.ctx.get = name => name === 'nativeSessionCleaner' ? { retire: () => new Promise(() => {}) } : { list() { return [] } }
  await fg.runtime.saveRole(first)
  await fg.runtime.saveRole({ ...first, stopped: true })
  check(fg.runtime.roleRecords.get(fgWork).nativeRetirements, undefined)
  await fg.runtime.saveRole({ ...first, stopped: true, completedRound: true })
  const fgKey = localForegroundRoleRecordPath(fg.runtime.config.scope, fg.runtime.config.collaborationId)
  check((await fg.records.get(fgKey)).nativeRetirements, [{ sessionId: first.sessionId, executionId: 'fg-1' }])
  const next = { identity: { ...first.identity, executionId: 'fg-2' }, sessionId: 'fg-session-2', generation: 2 }
  await fg.runtime.saveRole(next)
  check((await fg.records.get(fgKey)).sessionId, 'fg-session-2')
  check((await fg.records.get(fgKey)).nativeRetirements, [{ sessionId: first.sessionId, executionId: 'fg-1' }])
  const coldFg = await runtimeFor(fg.files, fg.records, 'foreground-retirement'), retired = []
  coldFg.runtime.ctx.get = name => name === 'nativeSessionCleaner' ? { async retire(session) { retired.push(session) } } : { list() { return [] } }
  coldFg.runtime.continueNativeRetirements(coldFg.runtime.roleRecords.get(fgWork))
  await Promise.all(coldFg.runtime.nativeRetirementOperations.values())
  check(retired, ['fg-session-1'])
  check((await fg.records.get(fgKey)).nativeRetirements, undefined)
  check((await fg.records.get(fgKey)).sessionId, 'fg-session-2')
  await coldFg.runtime.saveRole({ ...next, nativeRetirements: [{ sessionId: first.sessionId, executionId: 'fg-1' }] })
  check((await fg.records.get(fgKey)).nativeRetirements, undefined)
  console.log(JSON.stringify({ result: 'PASS', assertions, processInterruptions, node: process.version,
    scope: 'Controlled Linux physical whole-directory Cleaner, actual Host continuation and runtime release; native stop/journal controlled. Windows/DSH/cutover unrun.',
    loadedSourceSha256: Object.fromEntries([...loaded].sort(([a], [b]) => a.localeCompare(b))) }, null, 2))
} finally { for (const store of stores) await store.close(); hooks.deregister(); await fs.rm(sandbox, { recursive: true, force: true }) }
