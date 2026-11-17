import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
// Actual installed Zod, Markdown, YAML and SDK modules. Initialization,
// completion, Recorder, Worker delivery and release use production code;
// native ports and remote Git transport are controlled. No external writes.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
    const source = readFileSync(url === new URL('framework/role-runtime.ts', sourceRoot).href && process.env.DSS_RELEASE_RUNTIME_SOURCE ? process.env.DSS_RELEASE_RUNTIME_SOURCE : new URL(url), 'utf8'); loaded.set(url.slice(sourceRoot.href.length), hash(source))
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
} })
const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const { SessionGitOperations, GitAuthorityStore } = await import('../src/framework/git-authority.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { FrameworkCleaner } = await import('../src/framework/cleaner.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { initializeTask, paths, readJson, taskLifecycle } = await import('../src/framework/task-files.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
const { readTaskArchiveState, taskArchiveHostFacts } = await import('../src/framework/task-archive.ts')
const { GitConflictError } = await import('../src/experimental/private-git/github.ts')
const checks = [], transactions = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
let sequence = 0
function toolsFor(f, task, role = 'Recorder') {
  const tools = new Map(), agent = { id: role + '-' + ++sequence, session: {} }
  const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
  installFrameworkRoleTools(ctx, agent, { role, owner: task?.owner ?? 'A', ...(task ? { taskId: task.taskId, lifecycleId: task.lifecycleId, ...(role === 'Planner' ? { member: task.owner } : {}) } : {}), workId: 'work-' + sequence, executionId: 'execution-' + sequence },
    { files: f.files, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => { throw error },
      transact: (...args) => f.tx.run(...args) })
  return { call: (name, input, callId = 'call-' + ++sequence) => tools.get(name).execute(input, { agent, callId, signal: new AbortController().signal, concludeTurn() {} }) }
}
async function fixture(name) {
  const repo = new Repository()
  // The controlled remote implements the production deleteTree contract.
  const commit = repo.commitPrepared.bind(repo)
  repo.commitPrepared = async (snapshot, changes, message, operation) => {
    if (snapshot.head !== repo.head && !repo.accepted.has(operation.id)) throw new GitConflictError()
    const result = await commit(snapshot, changes, message, operation)
    if (!result.replay) {
      for (const change of changes) if (change.deleteTree) for (const target of repo.bodies.keys())
        if (target.startsWith(change.path + '/')) repo.bodies.delete(target)
      repo.history.set(repo.head, new Map(repo.bodies))
    }
    return result
  }
  const files = new GitFiles(repo, new SessionGitOperations())
  const rows = new Map(), records = { get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)), delete: async key => rows.delete(key), list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }
  const tx = new FrameworkTransactions(files, records, name); transactions.push(tx)
  const set = async (target, value) => { put(repo, target, value); head(repo) }
  const apply = changes => withSnapshot(files, snapshot => files.commit(snapshot, changes, 'Controlled initial Task publication'))
  const f = { name, repo, files, tx, records, set, apply }
  const id = '10000000-0000-4000-8000-' + hash(name).slice(0, 12), source = 'tasks/' + name + '_P.md'
  await set(source, 'Original requirement for ' + name + '\n')
  await apply((await withSnapshot(files, s => initializeTask(files, s, source, 'A', ['A', 'B'], id))).changes)
  f.task = await withSnapshot(files, s => readJson(files, s, paths.task(id)))
  await set(paths.run(id) + '/evidence.txt', 'Selected evidence\r\n')
  return f
}
async function complete(f, task, resultPaths) {
  const role = toolsFor(f, task, task.route === 'O' ? 'Organizer' : 'Planner'), view = await role.call('dss_snapshot', {})
  await role.call('dss_complete', { snapshotId: view.snapshotId, acceptance: 'Controlled fixture completed actual acceptance entry.', resultPaths })
  check('actual completion ' + task.taskId, (await withSnapshot(f.files, s => readJson(f.files, s, paths.task(task.taskId)))).status, 'complete')
}
const read = (f, target) => withSnapshot(f.files, s => f.files.read(s, target))
async function save(f, input) {
  await complete(f, await withSnapshot(f.files, s => readJson(f.files, s, paths.task(f.task.taskId))), [])
  f.task = await withSnapshot(f.files, s => readJson(f.files, s, paths.task(f.task.taskId)))
  const role = toolsFor(f, f.task), view = await role.call('dss_snapshot', {})
  const result = await role.call('dss_recorder_save', { snapshotId: view.snapshotId, ...input })
  f.retention = JSON.parse(await read(f, paths.archive(f.task) + '/retention.json'))
  check(f.name + ' save publishes original command', typeof f.retention.recorderCommand, 'string')
  check(f.name + ' save successful Git tool result', result, null)
}

// The production runtime is imported intact. Object.create supplies only its
// constructor-owned state, so no native Agent/model or timers are launched.
// Native stop and journal acceptance are explicit controlled ports; Host.poll,
// Cleaner, role persistence, Worker transfer, seal and retirement stay original.
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { ExecutionControls } = await import('../src/framework/execution-control.ts')
const { ExecutionObservations } = await import('../src/framework/execution-observation.ts')
const { DurableObservationStore } = await import('../src/framework/observation-store.ts')
const { workerTransferPath } = await import('../src/framework/worker-business.ts')
const hosts = []
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const state = f => withSnapshot(f.files, snapshot => readTaskArchiveState(f.files, snapshot, f.task))
const archived = f => ({ outputs: [{ path: paths.archive(f.task) + '/records.md', text: 'Actual Recorder entry publishes this lasting result.' }], retainedPaths: [] })
function hostFor(f, member) {
  const files = new GitFiles(f.repo, new SessionGitOperations()), records = new GitAuthorityStore(files, f.name + '-host-' + member)
  const runtime = Object.create(FrameworkRoleRuntime.prototype), errors = [], stopped = [], retired = [], failures = new Set()
  const config = { scope: f.name, member, primary: member === 'A', instanceUUID: member === 'A' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', mode: 'git' }
  const native = { get() {}, detach() {}, async stop(workId, executionId) {
    stopped.push(executionId)
    await native.beforeStop?.(workId, executionId)
    return failures.has(executionId) ? { status: 'unconfirmed', reason: 'Controlled native producer is still draining.', jobs: ['owned-producer'] } : { status: 'stopped' }
  } }
  Object.assign(runtime, { files, records, config, native, prefix: 'framework-runtime/' + hash(f.name) + '/',
    cleanupResidues: new Map(), roleRecords: new Map(), roleBases: new Map(), retiredWorkers: new Map(), roleWrites: new Map(), roleWriteOwners: new Map(),
    wakeWrites: new Map(), wakeWriteOwners: new Map(), observationRecordWrites: new Map(), restoreWriteOwners: new Map(), safetyRestoreWrites: new Map(),
    wakeConsumptions: new Map(), localWakeAdmissions: new Map(), admissionObservationVersion: 0, admissionNow: () => Date.now(), safetyEpisodes: new Map(), resolvedSafetyFaultIds: new Set(), stopOperations: new Map(),
    environment: { changed() {}, resolved() {} }, error(error) { errors.push(error) }, conversation: {},
    ctx: { get(name) { return name === 'nativeSessionCleaner' ? { async retire(id) { retired.push(id) } } : { list() { return [] } } }, agents: { get() {} }, jobs: { list() { return [] } } },
  })
  runtime.controls = new ExecutionControls(records, f.name, undefined, files, records, config.instanceUUID)
  runtime.observations = new ExecutionObservations(new DurableObservationStore(records, f.name, (identity, snapshot) => runtime.taskRuntimeReleased(identity, snapshot)), { async arrange() {} }, error => errors.push(error))
  runtime.transactions = new FrameworkTransactions(files, records, f.name); transactions.push(runtime.transactions)
  runtime.cleaner = new FrameworkCleaner(files, runtime.transactions)
  const roleAudits = [], validate = runtime.roleRecordProblem.bind(runtime)
  runtime.roleRecordProblem = (key, value) => { roleAudits.push(key); return validate(key, value) }
  const releases = []
  const host = new FrameworkHostLoop(files, runtime.transactions, records, config, () => ['A', 'B'], {
    observe: async () => {}, sealBusiness: task => runtime.sealBusiness(task.taskId, task.lifecycleId), executing: () => false, wake: async () => false, error: error => errors.push(error),
    clean: (...args) => runtime.clean(...args), releaseTask: async (...args) => { releases.push(args[0]); await runtime.releaseLocalTask(...args) },
  })
  hosts.push(host)
  return { runtime, host, files, records, errors, releases, stopped, retired, failures, roleAudits, key: host.archiveHostKey }
}
async function roleFor(h, task, role = 'Planner', workerId) {
  const r = h.runtime, workId = r.roleKey(role, task?.taskId, workerId)
  const identity = { role, workId, executionId: r.config.member + '-exec-' + ++sequence, member: r.config.member,
    ...(task ? { taskId: task.taskId, ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}) } : {}), ...(workerId ? { workerId } : {}) }
  const record = { identity, sessionId: 'session-' + identity.executionId, generation: 1 }
  await r.saveRole(record)
  return record
}
async function deliver(h, task, record) {
  const tools = new Map(), agent = { id: 'agent-' + record.identity.executionId, session: {} }
  const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
  const services = h.runtime.services()
  installFrameworkRoleTools(ctx, agent, { ...record.identity, owner: task.owner, generation: record.generation }, {
    files: h.files, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => { throw error },
    transact: services.transact, workerBusiness: services.workerBusiness,
  })
  const call = (name, input) => tools.get(name).execute(input, { agent, callId: 'call-' + ++sequence, signal: new AbortController().signal, concludeTurn() {} })
  const view = await call('dss_snapshot', {})
  await call('dss_worker_deliver', { snapshotId: view.snapshotId, reply: 'Actual meaningful Worker checkpoint.', records: [] })
  await Promise.all([...h.runtime.workerDrains?.values() ?? []])
}
try {
  const f = await fixture('actual-two-host-role-release'), a = hostFor(f, 'A'), b = hostFor(f, 'B')
  const pa = await roleFor(a, f.task), pb = await roleFor(b, f.task)
  const foreground = await roleFor(a, undefined, 'Foreground')
  const otherId = '10000000-0000-4000-8000-' + hash('independent-role-task').slice(0, 12), otherSource = 'tasks/independent-role-task_P.md'
  await f.set(otherSource, 'Independent actual task requirement.\n')
  await f.apply((await withSnapshot(f.files, s => initializeTask(f.files, s, otherSource, 'A', ['A'], otherId))).changes)
  const otherTask = await withSnapshot(f.files, s => readJson(f.files, s, paths.task(otherId)))
  const independent = await roleFor(a, otherTask)
  await save(f, archived(f))
  const entered = defer(), resume = defer()
  a.runtime.native.beforeStop = async (_workId, id) => { if (id === pa.identity.executionId) { entered.resolve(); await resume.promise } }
  const first = a.host.poll(); await entered.promise
  check('Recorder Cleaner signal removed before native stop finishes', await read(f, paths.state('A', f.task.taskId) + '/Cleaner'), undefined)
  check('original Cleaner deletion has one common files-cleaned fact', (await state(f)).lifecycles[taskLifecycle(f.task)].cleanup, { phase: 'files-cleaned' })
  check('pending own native producer does not claim runtimeReleased', taskArchiveHostFacts(await state(f), f.task, a.key)?.runtimeReleased, undefined)
  await b.host.poll()
  check('peer Host uses deletion fact and performs actual own release', taskArchiveHostFacts(await state(f), f.task, b.key)?.released, true)
  check('peer exact native session retired', b.retired, [pb.sessionId])
  check('peer current authority body retired', await b.records.get(b.runtime.prefix + 'roles/' + hash(pb.identity.workId)), undefined)
  resume.resolve(); await first
  check('original Host completes after its own stop', taskArchiveHostFacts(await state(f), f.task, a.key)?.released, true)
  check('original exact native session retired', a.retired, [pa.sessionId])
  check('Foreground runtime and independent Task remain', [a.runtime.roleRecords.has(foreground.identity.workId), a.runtime.roleRecords.has(independent.identity.workId)], [true, true])
  const prior = [a.releases.length, b.releases.length]
  await a.host.poll(); await b.host.poll()
  check('repeated ordinary polls do not repeat completed releases', [a.releases.length, b.releases.length], prior)
  check('two Host real chain has no errors', [...a.errors, ...b.errors], [])
  check('two Host release no longer invokes role format audit', a.roleAudits.length + b.roleAudits.length, 0)

  const w = await fixture('actual-worker-transfer-release'), wh = hostFor(w, 'A')
  const worker = await roleFor(wh, w.task, 'Worker', 'worker-one')
  wh.failures.add(worker.identity.executionId)
  await deliver(wh, w.task, worker)
  const transferPath = workerTransferPath(wh.runtime.workerBusinessScope(), worker.identity.executionId)
  check('registered Worker delivery publishes original transfer identity', JSON.parse(await read(w, transferPath)).record.identity, worker.identity)
  check('committed callback retains exact native drain responsibility', wh.runtime.retiredWorkers.has(worker.identity.executionId), true)
  await save(w, archived(w)); await wh.host.poll()
  check('unfinished native drain does not block Recorder directory deletion', (await state(w)).lifecycles[taskLifecycle(w.task)].cleanup, { phase: 'files-cleaned' })
  check('unfinished native drain leaves own release unconfirmed', taskArchiveHostFacts(await state(w), w.task, wh.key)?.runtimeReleased, undefined)
  check('unfinished native drain retains transfer authority', !!await read(w, transferPath), true)
  check('native unfinished result is surfaced', wh.errors.some(error => error.message.includes('still draining')), true)
  wh.errors.length = 0; wh.failures.delete(worker.identity.executionId)
  wh.runtime.retryRetiredWorkers(); await Promise.all([...wh.runtime.workerDrains.values()])
  await wh.host.poll()
  check('confirmed original native producer allows own release', taskArchiveHostFacts(await state(w), w.task, wh.key)?.released, true)
  check('Worker transfer and retired authority removed together', [await read(w, transferPath), await wh.records.get(wh.runtime.prefix + 'retired-workers/' + worker.identity.executionId)], [undefined, undefined])
  check('Worker native retirement uses original exact session', new Set(wh.retired), new Set([worker.sessionId]))
  check('Worker release has no residual error', wh.errors, [])
  check('Worker release no longer invokes role format audit', wh.roleAudits.length, 0)
  check('obsolete role-format assertion is absent', typeof FrameworkRoleRuntime.prototype.assertTaskRoleContent, 'undefined')
  console.log(JSON.stringify({ passed: checks.length, checks, runtime: process.version, sourceHashes: Object.fromEntries(loaded), limits: [
    'Actual registered completion, Recorder save and Worker delivery use installed Zod/Markdown/YAML/SDK. Public Host.poll calls unchanged production runtime methods, not a substituted release callback.',
    'Runtime constructor state and native stop/journal ports are controlled. No live Agent, model, real remote Git or Windows/native-host validation is claimed.',
    'All business records come through current real entries. No malformed state fixture or additional product gate is introduced. The role-audit counter observes a removed redundant mechanism, not a claimed user incident.',
  ] }, null, 2))
} finally {
  await Promise.allSettled(hosts.map(host => host.stop()))
  await Promise.allSettled(transactions.map(tx => tx.closeGitSession(new Error('Controlled test end'))))
  hooks.deregister()
}

