import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
// Actual installed Zod, Markdown, YAML and SDK modules; only the native Agent
// registration surface and remote Git transport are controlled. No publication
// leaves this process. Initialization, completion, save, reads and Cleaner use
// production implementations. Local files are disposable Linux fixtures.
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
    const source = readFileSync(new URL(url), 'utf8'); loaded.set(url.slice(sourceRoot.href.length), hash(source))
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
} })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles, withSnapshot, FilesOutcomeUnknownError, FilesConflictError } = await import('../src/framework/transactions.ts')
const { SessionGitOperations, GitAuthorityStore } = await import('../src/framework/git-authority.ts')
const { FrameworkTransactions, TaskCommandRetiredError } = await import('../src/framework/command-transactions.ts')
const { FrameworkCleaner, observeCleanup } = await import('../src/framework/cleaner.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { initializeTask, dispatchPlannerObjective, paths, encodeJson, readJson, taskLifecycle } = await import('../src/framework/task-files.ts')
const { taskFamily } = await import('../src/framework/task-relations.ts')
const { readTaskReferenceIdentity } = await import('../src/framework/task-history.ts')
const { readArchivedReference } = await import('../src/framework/recorder-retention.ts')
const { taskReference } = await import('../src/framework/published-references.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
const { updateTaskArchiveState, planTaskArchiveHostFacts, readTaskArchiveState, taskArchiveHostFacts, taskArchiveStatePath } = await import('../src/framework/task-archive.ts')
const { GitCommitOutcomeUnknownError } = await import('../src/experimental/private-git/contracts.ts')
const { GitConflictError } = await import('../src/experimental/private-git/github.ts')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-git-cleanup-facts-'))
const checks = [], cases = [], opened = [], transactions = []
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
async function fixture(mode, name, child = false) {
  const repo = mode === 'git' ? new Repository() : undefined
  if (repo) {
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
  }
  const files = repo ? new GitFiles(repo, new SessionGitOperations()) : new PhysicalLocalFiles(path.join(scratch, mode + '-' + name))
  if (!repo) opened.push(files)
  const rows = new Map(), records = { get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)), delete: async key => rows.delete(key), list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }
  const tx = new FrameworkTransactions(files, records, mode + '-' + name); if (repo) transactions.push(tx)
  const set = async (target, value) => { if (repo) { put(repo, target, value); head(repo) } else if (value === undefined) await files.delete(target); else await files.replace(target, value) }
  const apply = async changes => { if (repo) return withSnapshot(files, snapshot => files.commit(snapshot, changes, 'Controlled initial Task publication')); for (const change of changes) await set(change.path, change.content === null ? undefined : change.bytes ?? change.content) }
  const f = { mode, name, repo, files, tx, records, set, apply }
  const id = '10000000-0000-4000-8000-' + hash(mode + name).slice(0, 12), source = 'tasks/' + name + (child ? '_O.md' : '_P.md')
  await set(source, 'Original requirement for ' + name + '\n')
  await apply((await withSnapshot(files, s => initializeTask(files, s, source, 'A', child ? ['A', 'B'] : ['A'], id))).changes)
  f.task = await withSnapshot(files, s => readJson(files, s, paths.task(id)))
  if (child) {
    await apply(await withSnapshot(files, s => dispatchPlannerObjective(files, s, f.task, 'child-result', 'B', 'Child independent requirement', [], 'P')))
    f.family = await withSnapshot(files, s => taskFamily(files, s, id)); f.task = f.family[0]; f.child = f.family[1]
    f.childResult = paths.run(f.child.taskId) + '/child-result.txt'; await set(f.childResult, 'Child deliverable independently selected at completion')
    await complete(f, f.child, [f.childResult])
  } else f.family = [f.task]
  f.original = await withSnapshot(files, s => files.read(s, source))
  f.material = paths.run(id) + '/evidence.txt'; f.unselected = paths.run(id) + '/unselected.txt'
  await set(f.material, 'Selected evidence\r\n'); await set(f.unselected, 'Do not keep this unselected temporary text')
  return f
}
async function complete(f, task, resultPaths) {
  const role = toolsFor(f, task, task.route === 'O' ? 'Organizer' : 'Planner'), view = await role.call('dss_snapshot', {})
  await role.call('dss_complete', { snapshotId: view.snapshotId, acceptance: 'Controlled fixture completed actual acceptance entry.', resultPaths })
  check(f.mode + ' actual completion ' + task.taskId, (await withSnapshot(f.files, s => readJson(f.files, s, paths.task(task.taskId)))).status, 'complete')
}
const read = (f, target) => withSnapshot(f.files, s => f.files.read(s, target))
async function save(f, input, forbidUnselectedSource = false) {
  await complete(f, await withSnapshot(f.files, s => readJson(f.files, s, paths.task(f.task.taskId))), [])
  f.task = await withSnapshot(f.files, s => readJson(f.files, s, paths.task(f.task.taskId)))
  await f.beforeSave?.()
  const role = toolsFor(f, f.task), view = await role.call('dss_snapshot', {})
  const reads = [], oldRead = f.files.read.bind(f.files), oldBytes = f.files.readBytes.bind(f.files), oldPrefix = f.files.readPrefix?.bind(f.files)
  const observe = (target, fn) => { if (target === f.task.sourcePath) { reads.push(target); if (forbidUnselectedSource) throw new Error('Unselected original must not be read') }; return fn() }
  f.files.read = (s, p) => observe(p, () => oldRead(s, p)); f.files.readBytes = (s, p) => observe(p, () => oldBytes(s, p))
  if (oldPrefix) f.files.readPrefix = (p, n) => observe(p, () => oldPrefix(p, n))
  let result
  try { result = await role.call('dss_recorder_save', { snapshotId: view.snapshotId, ...input }) }
  finally { f.files.read = oldRead; f.files.readBytes = oldBytes; if (oldPrefix) f.files.readPrefix = oldPrefix }
  f.retention = JSON.parse(await read(f, paths.archive(f.task) + '/retention.json'))
  check(f.mode + ' ' + f.name + ' save publishes original command', typeof f.retention.recorderCommand, 'string')
  check(f.mode + ' ' + f.name + ' save successful tool result', result === null && f.mode === 'git' || result?.saved === true, true)
  return { result, sourceReads: reads.length }
}

// This check drives public Host.poll (including task discovery/startTask/scanTask),
// real Git authority, command release, and Cleaner. The native-role release
// boundary is controlled: no native model is launched or shutdown claimed.
const hosts = []
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const state = f => withSnapshot(f.files, snapshot => readTaskArchiveState(f.files, snapshot, f.task))
const cleanupFact = (value, task) => value?.lifecycles[taskLifecycle(task)]?.cleanup
function hostFor(f, member, releaseBoundary = async () => {}) {
  const files = new GitFiles(f.repo, new SessionGitOperations()), records = new GitAuthorityStore(files, f.name + '-host-' + member)
  const tx = new FrameworkTransactions(files, records, f.name + '-host-' + member); transactions.push(tx)
  const errors = [], releases = [], cleaner = new FrameworkCleaner(files, tx)
  const host = new FrameworkHostLoop(files, tx, records, { scope: f.name, member, primary: member === 'A', instanceUUID: member === 'A' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, () => ['A', 'B'], {
    observe: async () => {}, sealBusiness: async () => {}, executing: () => false, wake: async () => false, error: error => errors.push(error),
    clean: async (task, snapshot, observation) => (await cleaner.clean(task, observation)).status === 'deleted',
    releaseTask: async (taskId, lifecycleId, task) => {
      releases.push(taskId); await releaseBoundary(task)
      // Production runtime writes this own-Host fact before command retirement.
      // Native role shutdown itself is the stated controlled boundary above.
      await updateTaskArchiveState(files, task, (_snapshot, _identity, current) => {
        const key = taskLifecycle(task), lifecycle = current.lifecycles[key] ?? {}, own = lifecycle.hosts?.[host.archiveHostKey] ?? {}
        return { state: { ...current, lifecycles: { ...current.lifecycles, [key]: { ...lifecycle, hosts: { ...lifecycle.hosts, [host.archiveHostKey]: { ...own, runtimeReleased: true } } } } }, result: undefined, write: !own.runtimeReleased }
      })
      await tx.releaseTaskCommands({ taskId, lifecycleId, hostKey: host.archiveHostKey })
    }
  })
  hosts.push(host)
  return { host, files, records, tx, errors, releases, key: host.archiveHostKey }
}
const archived = f => ({ outputs: [{ path: paths.archive(f.task) + '/records.md', text: 'Independent lasting result; original temporary text was not selected.' }], retainedPaths: [] })
try {
  const f = await fixture('git', 'two-host-poll')
  await save(f, archived(f))
  const entered = defer(), resume = defer(), a = hostFor(f, 'A', async () => { entered.resolve(); await resume.promise }), b = hostFor(f, 'B')
  const aPoll = a.host.poll(); await entered.promise
  check('actual Recorder signal and runtime tree deleted before native release boundary', await read(f, paths.state('A', f.task.taskId) + '/Cleaner'), undefined)
  check('same Git deletion retains one files-cleaned fact', cleanupFact(await state(f), f.task), { phase: 'files-cleaned' })
  const removal = f.repo.calls.find(call => call.changes.some(change => change.deleteTree))
  check('actual deleteTree publication includes same Task runtime fact', removal.changes.some(change => change.path === 'dss-coop/' + paths.task(f.task.taskId) && JSON.parse(change.content).runtimeState.lifecycles[taskLifecycle(f.task)].cleanup.phase === 'files-cleaned'), true)
  await b.host.poll()
  let s = await state(f)
  check('peer ordinary poll releases without a surviving Cleaner signal', b.releases, [f.task.taskId])
  check('first released Host does not advance shared phase', cleanupFact(s, f.task), { phase: 'files-cleaned' })
  check('B records only B completion while A native boundary remains pending', [taskArchiveHostFacts(s, f.task, b.key)?.released, taskArchiveHostFacts(s, f.task, a.key)?.released], [true, undefined])
  resume.resolve(); await aPoll
  s = await state(f)
  check('both actual Host polls finish their own completion', [taskArchiveHostFacts(s, f.task, a.key)?.released, taskArchiveHostFacts(s, f.task, b.key)?.released], [true, true])
  check('both completed Hosts keep only the same shared deletion fact', cleanupFact(s, f.task), { phase: 'files-cleaned' })
  check('Host polls report no errors', [...a.errors, ...b.errors], [])
  const priorReleases = [...a.releases, ...b.releases]
  await a.host.poll(); await b.host.poll()
  check('ordinary repeat polls do not release a completed Host twice', [...a.releases, ...b.releases], priorReleases)
  await assert.rejects(() => a.tx.run('late-old-task-write', {}, { taskOwner: { taskId: f.task.taskId, lifecycleId: f.task.lifecycleId, hostKey: a.key } }, async () => [{ path: paths.run(f.task.taskId) + '/late.txt', content: 'not recreated' }]), error => error instanceof TaskCommandRetiredError)
  checks.push('actual old Task command admission still rejects namespace recreation')

  // Explicit old-format state input, not an asserted user incident. Metadata,
  // completion, Recorder and deletion are produced through current real entries.
  const legacy = await fixture('git', 'legacy-format-poll')
  await save(legacy, archived(legacy)); await hostFor(legacy, 'A').host.poll()
  const peer = hostFor(legacy, 'B'), original = await state(legacy), key = taskLifecycle(legacy.task)
  const other = { hosts: { untouched: { sealed: true } }, cleanup: { phase: 'released', deletedPaths: ['old-other-lifecycle.txt'], historyCleared: true } }
  original.lifecycles[key].cleanup = { phase: 'released', deletedPaths: ['task-runs/old/deleted.txt'], historyCleared: true }
  original.lifecycles['controlled-historical-lifecycle'] = other
  const firstHost = structuredClone(original.lifecycles[key].hosts)
  const oldArchiveBytes = encodeJson(original)
  await legacy.set(taskArchiveStatePath(legacy.task), oldArchiveBytes)
  check('old archive state does not replace current Task runtime facts', cleanupFact(await state(legacy), legacy.task), { phase: 'files-cleaned' })
  // Explicit prior state SHAPE at the current location, not automatic archive migration.
  const currentMetadata = JSON.parse(await read(legacy, paths.task(legacy.task.taskId)))
  await legacy.set(paths.task(legacy.task.taskId), encodeJson({ ...currentMetadata, runtimeState: { lifecycles: original.lifecycles } }))
  const callsBefore = legacy.repo.calls.length
  check('old released state remains readable before an existing write', cleanupFact(await state(legacy), legacy.task).phase, 'released')
  await updateTaskArchiveState(peer.files, legacy.task, (_s, _i, current) => ({ state: current, write: false, result: 'no-op' }))
  await updateTaskArchiveState(peer.files, legacy.task, (_s, _i, current) => ({ state: current, write: true, result: 'same bytes' }))
  check('read and both no-op update forms add no publication', legacy.repo.calls.length, callsBefore)
  check('no-op did not turn legacy compaction into a separate operation', cleanupFact(await state(legacy), legacy.task).deletedPaths, ['task-runs/old/deleted.txt'])
  await peer.host.poll()
  const compacted = await state(legacy)
  check('existing peer Host update discards old inventory and preserves history disposition', cleanupFact(compacted, legacy.task), { phase: 'files-cleaned', historyCleared: true })
  check('existing write preserves another lifecycle byte values', compacted.lifecycles['controlled-historical-lifecycle'], other)
  for (const [hostKey, facts] of Object.entries(firstHost)) check('existing write preserves first Host facts ' + hostKey, compacted.lifecycles[key].hosts[hostKey], facts)
  check('old format allows peer own release', taskArchiveHostFacts(compacted, legacy.task, peer.key)?.released, true)
  check('legacy peer poll produces no extra compaction-only commit', legacy.repo.calls.slice(callsBefore).every(call => call.changes.some(change => change.path === 'dss-coop/' + paths.task(legacy.task.taskId) && JSON.parse(change.content).runtimeState.lifecycles[key].hosts[peer.key])), true)
  check('existing peer release leaves old archive state untouched', await read(legacy, taskArchiveStatePath(legacy.task)), oldArchiveBytes)

  const family = await fixture('git', 'family-poll', true)
  await save(family, archived(family)); const familyHost = hostFor(family, 'A')
  await familyHost.host.poll()
  // A completed child's ordinary seal can win the exact-HEAD race with root deletion.
  // This is an existing proven conflict, not a new cleanup gate; poll resumes it.
  if (familyHost.errors.length) {
    check('family first poll surfaces only a proven current-state CAS conflict', familyHost.errors.every(error => error instanceof FilesConflictError), true)
    familyHost.errors.length = 0; await familyHost.host.poll()
  }
  check('normal root discovery releases its real completed child and root', new Set(familyHost.releases), new Set(family.family.map(task => task.taskId)))
  for (const task of family.family) {
    const row = await withSnapshot(family.files, snapshot => readTaskArchiveState(family.files, snapshot, task))
    check('family shared fact remains files-cleaned ' + task.taskId, cleanupFact(row, task), { phase: 'files-cleaned' })
    check('family own release confirmed ' + task.taskId, taskArchiveHostFacts(row, task, familyHost.key)?.released, true)
  }
  check('family poll CAS retries preserve both members without errors', familyHost.errors, [])

  const unknown = await fixture('git', 'original-unknown'), u = hostFor(unknown, 'A')
  const owner = { taskId: unknown.task.taskId, lifecycleId: unknown.task.lifecycleId, hostKey: u.key }
  const send = unknown.repo.commitPrepared.bind(unknown.repo); let originalOperation
  unknown.repo.commitPrepared = async (snapshot, changes, message, operation) => { if (!originalOperation) { originalOperation = structuredClone(operation); throw new GitCommitOutcomeUnknownError(operation) }; return send(snapshot, changes, message, operation) }
  let builds = 0
  await assert.rejects(() => u.tx.run('original-task-write-unknown', { text: 'original body' }, { taskOwner: owner }, async () => { builds++; return [{ path: paths.run(owner.taskId) + '/original-write.txt', content: 'original body' }] }), error => error instanceof FilesOutcomeUnknownError && error.operationId === originalOperation.id)
  checks.push('actual Git prepare/dispatch retains the native original UNKNOWN identity')
  await save(unknown, archived(unknown)); await u.host.poll()
  check('real release does not replace an UNKNOWN Task operation', u.errors.some(error => error instanceof FilesOutcomeUnknownError && error.operationId === originalOperation.id), true)
  check('UNKNOWN retains own release unfinished after real deletion', taskArchiveHostFacts(await state(unknown), unknown.task, u.key)?.released, undefined)
  check('UNKNOWN does not grow a deletion inventory', cleanupFact(await state(unknown), unknown.task), { phase: 'files-cleaned' })
  check('release did not rerun original builder', builds, 1)
  unknown.repo.resolution = { status: 'conflict', head: unknown.repo.head }
  await u.host.poll()
  check('proven original conflict allows existing Host release to finish', taskArchiveHostFacts(await state(unknown), unknown.task, u.key)?.released, true)
  check('settled original operation is retired without replacement', [builds, u.tx.ownsGitAttempt('original-task-write-unknown')], [1, false])
  console.log(JSON.stringify({ passed: checks.length, checks, runtime: process.version, sourceHashes: Object.fromEntries(loaded), limits: [
    'Actual initializeTask/dispatchPlannerObjective changes are published through GitFiles; registered dss_complete and dss_recorder_save use installed Zod/Markdown/YAML/SDK.',
    'Public Host.poll, real Git authority, original FrameworkTransactions release and Cleaner are exercised. Native role stop is an explicitly controlled empty boundary; no live model shutdown claimed.',
    'Remote Git is an in-process exact-HEAD controlled transport; UNKNOWN is thrown at actual original dispatch and later proven conflict. No live remote/credentials/external writes.',
    'Old released/deletedPaths shape and historical sibling lifecycle are explicit inputs at the current Task metadata location, not automatic old-archive migration or reported user incidents. The separately seeded old archive is unchanged and ignored by current runtime state reads.'
  ] }, null, 2))
} finally {
  await Promise.allSettled(hosts.map(host => host.stop()))
  await Promise.allSettled(transactions.map(tx => tx.closeGitSession(new Error('Controlled test end'))))
  await Promise.allSettled(opened.map(files => files.close())); hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true })
}
