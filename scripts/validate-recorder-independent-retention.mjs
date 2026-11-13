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
const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const { SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { FrameworkCleaner, observeCleanup } = await import('../src/framework/cleaner.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { initializeTask, dispatchPlannerObjective, paths, encodeJson, readJson } = await import('../src/framework/task-files.ts')
const { taskFamily } = await import('../src/framework/task-relations.ts')
const { readTaskReferenceIdentity } = await import('../src/framework/task-history.ts')
const { readArchivedReference } = await import('../src/framework/recorder-retention.ts')
const { taskReference } = await import('../src/framework/published-references.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-independent-retention-'))
const checks = [], cases = [], opened = [], transactions = [], familyReadObservations = []
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
  const apply = async changes => { for (const change of changes) await set(change.path, change.content === null ? undefined : change.bytes ?? change.content) }
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
  const role = toolsFor(f, f.task), view = await role.call('dss_snapshot', {})
  const reads = [], familyReads = [], familyPaths = new Set(f.family.map(task => paths.task(task.taskId))), oldRead = f.files.read.bind(f.files), oldBytes = f.files.readBytes.bind(f.files), oldPrefix = f.files.readPrefix?.bind(f.files)
  const observe = (target, fn) => { if (target === f.task.sourcePath) { reads.push(target); if (forbidUnselectedSource) throw new Error('Unselected original must not be read') }; return fn() }
  // Count actual Task metadata text reads once. Physical read calls readBytes
  // internally, so recording both would double-count one body operation.
  f.files.read = (s, p) => {
    if (familyPaths.has(p)) {
      const stack = new Error().stack ?? ''
      familyReads.push({ path: p, revision: s.revision, taskFamily: /at (?:async )?taskFamily /.test(stack),
        outputReferenceFamily: /at (?:async )?prepareRecorderOutputReferences /.test(stack),
        prepareArchive: /at (?:async )?prepareArchive /.test(stack), validate: /at (?:async )?validate /.test(stack) })
    }
    return observe(p, () => oldRead(s, p))
  }; f.files.readBytes = (s, p) => observe(p, () => oldBytes(s, p))
  if (oldPrefix) f.files.readPrefix = (p, n) => observe(p, () => oldPrefix(p, n))
  let result
  try { result = await role.call('dss_recorder_save', { snapshotId: view.snapshotId, ...input }) }
  finally { f.files.read = oldRead; f.files.readBytes = oldBytes; if (oldPrefix) f.files.readPrefix = oldPrefix }
  familyReadObservations.push({ mode: f.mode, name: f.name, familyPaths: [...familyPaths], reads: familyReads })
  f.retention = JSON.parse(await read(f, paths.archive(f.task) + '/retention.json'))
  check(f.mode + ' ' + f.name + ' save publishes original command', typeof f.retention.recorderCommand, 'string')
  check(f.mode + ' ' + f.name + ' save successful tool result', result === null && f.mode === 'git' || result?.saved === true, true)
  return { result, sourceReads: reads.length }
}
async function clean(f) {
  const cleaner = new FrameworkCleaner(f.files, f.tx)
  if (f.mode === 'local') {
    const errors = []
    const host = new FrameworkHostLoop(f.files, f.tx, f.records, { scope: f.name, member: 'A', primary: true, instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, () => ['A'], {
      async wake() {}, executing() { return false }, async releaseTask() {}, error(error) { errors.push(error) }, async observe() {},
      async clean(task, snapshot, observation) { return (await cleaner.clean(task, observation)).status === 'released' },
    })
    host.record = { initial: {}, completed: {} }
    await withSnapshot(f.files, snapshot => host.scanTask(f.task, snapshot, performance.now()))
    // Test waits for the Host-owned native-release/cleanup continuation after
    // scanTask, rather than assuming a scheduled responsibility has finished.
    for (;;) {
      const owned = [...host.physicalCleanupOperations.values(), ...host.physicalReleaseOperations.values()]
      if (!owned.length) break
      await Promise.allSettled(owned)
    }
    if (errors.length) throw new AggregateError(errors)
    check(f.mode + ' actual Host/Cleaner retires metadata ' + f.name, await read(f, paths.task(f.task.taskId)), undefined)
  } else await withSnapshot(f.files, async snapshot => { const observed = await observeCleanup(f.files, snapshot, f.task, performance.now()); if (observed.error) throw observed.error; const result = await cleaner.clean(f.task, observed); check(f.mode + ' actual Cleaner ' + f.name, result.status, 'deleted') })
  check(f.mode + ' Cleaner removes unselected working bytes ' + f.name, await read(f, f.unselected), undefined)
}
async function readRequirement(f, task = f.task) {
  const foreground = toolsFor(f, undefined, 'Foreground'), view = await foreground.call('dss_snapshot', {})
  return foreground.call('dss_read', { snapshotId: view.snapshotId, path: taskReference(task.taskId, task.sourcePath) })
}
try {
  for (const mode of ['local', 'git']) {
    const none = await fixture(mode, 'no-original')
    const noSave = await save(none, { outputs: [{ path: paths.archive(none.task) + '/records.md', text: 'The useful requirement and outcome are fully recorded here.' }], retainedPaths: [] }, true)
    check(mode + ' unselected source has no read dependency', noSave.sourceReads, 0)
    check(mode + ' no automatic original mapping', none.retention.relocatedReferences, undefined)
    await clean(none); check(mode + ' unselected original genuinely absent after cleanup', (await readRequirement(none)).exists, false)

    const direct = await fixture(mode, 'explicit-original')
    await save(direct, { outputs: [{ path: paths.archive(direct.task) + '/records.md', text: 'Original wording has independent evidentiary value.' }], retainedPaths: [taskReference(direct.task.taskId, direct.task.sourcePath)] })
    check(mode + ' explicit original selected once', Object.keys(direct.retention.relocatedReferences), [direct.task.sourcePath])
    await clean(direct); check(mode + ' exact explicitly selected original survives', (await readRequirement(direct)).text, direct.original)

    const links = await fixture(mode, 'linked-original', true)
    const childOriginal = await read(links, links.child.sourcePath)
    const external = 'task-references/99999999-0000-4000-8000-000000000001/' + encodeURIComponent('tasks/unrelated_P.md')
    const skillPath = 'skills/retention-' + mode + '/SKILL.md'
    const skillText = '---\nname: retention-' + mode + '\ndescription: Validated controlled retention fixture\n---\n[Original](' + links.task.sourcePath + ')\n'
    const records = '[Evidence](' + links.material + ')\n[Child](' + taskReference(links.child.taskId, links.child.sourcePath) + ')\n[External](' + external + ')\n[Native](/user/result.pdf)\n'
    await save(links, { outputs: [{ path: paths.archive(links.task) + '/records.md', text: records }, { path: skillPath, text: skillText }], retainedPaths: [] })
    check(mode + ' skill link normalized before first publication', await read(links, skillPath), skillText.replace(links.task.sourcePath, taskReference(links.task.taskId, links.task.sourcePath)))
    check(mode + ' unrelated reference preserved without copying', (await read(links, paths.archive(links.task) + '/records.md')).includes(external), true)
    check(mode + ' no unrelated/task-temporary expansion', Object.keys(links.retention.relocatedReferences).sort(), [links.task.sourcePath, links.child.sourcePath, links.material, links.childResult].sort())
    check(mode + ' root need not repeat child result', links.task.resultPaths, [])
    const duplicate = toolsFor(links, undefined, 'Foreground'), duplicateView = await duplicate.call('dss_snapshot', {})
    await assert.rejects(() => duplicate.call('dss_submit_task', { snapshotId: duplicateView.snapshotId,
      name: links.name, route: links.task.route, text: 'A new request must not overwrite the existing submission.' }), /task filename already exists/)
    checks.push(mode + ' actual submission refuses the occupied filename before Cleaner')
    check(mode + ' refused submission preserves the existing source', await read(links, links.task.sourcePath), links.original)
    await clean(links)
    check(mode + ' skill-only selection original readable via actual dss_read after Cleaner', (await readRequirement(links)).text, links.original)
    check(mode + ' child stable requirement readable via actual dss_read after Cleaner', (await readRequirement(links, links.child)).text, childOriginal)
    check(mode + ' linked evidence reads through existing relocation', Buffer.from(await withSnapshot(links.files, s => readArchivedReference(links.files, s, links.task.taskId, links.material))).toString(), 'Selected evidence\r\n')
    const history = await withSnapshot(links.files, s => readTaskReferenceIdentity(links.files, s, links.child.taskId))
    check(mode + ' actual child result remains available from its existing identity', await read(links, history.resultPaths[0]), 'Child deliverable independently selected at completion')
    // Cleaner removed the old source. The actual Foreground submission tool
    // may now create that filename; it never overwrites an existing source.
    check(mode + ' Cleaner removed source before same-name submission', await read(links, links.task.sourcePath), undefined)
    const foreground = toolsFor(links, undefined, 'Foreground'), submission = await foreground.call('dss_snapshot', {})
    const subsequent = 'A subsequent task reuses the same user submission filename.\n'
    await foreground.call('dss_submit_task', { snapshotId: submission.snapshotId, name: links.name, route: links.task.route, text: subsequent })
    check(mode + ' actual submission creates same-name source without Task ID', await read(links, links.task.sourcePath), subsequent)
    const laterId = '20000000-0000-4000-8000-' + hash(mode).slice(0, 12)
    await links.apply((await withSnapshot(links.files, s => initializeTask(links.files, s, links.task.sourcePath, 'A', ['A'], laterId))).changes)
    check(mode + ' retained requirement cannot resolve to subsequent same-name task', (await readRequirement(links)).text, links.original)

    const unselectedLinks = await fixture(mode, 'no-recursive-copy')
    await unselectedLinks.set(unselectedLinks.material, '[Not selected](' + unselectedLinks.unselected + ')')
    await save(unselectedLinks, { outputs: [{ path: paths.archive(unselectedLinks.task) + '/records.md', text: '[Exact evidence](' + unselectedLinks.material + ')' }], retainedPaths: [] }, true)
    check(mode + ' originals bodies are not traversed for more choices', Object.keys(unselectedLinks.retention.relocatedReferences), [unselectedLinks.material])
    await clean(unselectedLinks)
    cases.push({ mode, actualEntryPoints: ['dss_submit_task', 'initializeTask', 'dispatchPlannerObjective', 'dss_complete', 'dss_recorder_save', 'dss_read', 'observeCleanup', 'FrameworkCleaner.clean'], noSelection: true, explicitSelection: true, skillAndArchiveLinkSelection: true, childResults: true, sourceReuseAfterCleanup: true, noRecursiveCopy: true })
  }
  console.log(JSON.stringify({ passed: checks.length, checks, cases, familyReadObservations, runtime: process.version, sourceHashes: Object.fromEntries(loaded), limitations: ['Controlled Agent registration and in-memory remote Git transport, no credentials or external writes.', 'Actual pinned installed Zod/Markdown/YAML/SDK packages; no live native model execution, Windows or GUI click exercised.', 'Exact linked working-file fallback read through production readArchivedReference; service dispatch source reviewed separately.'] }, null, 2))
} finally { await Promise.allSettled(opened.map(files => files.close())); await Promise.allSettled(transactions.map(tx => tx.closeGitSession(new Error('Controlled test end')))); hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
