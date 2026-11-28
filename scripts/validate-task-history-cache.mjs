import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual production view method and file adapters, controlled unrelated service
// ports. The Git repository is an explicitly controlled immutable fixture, not
// live GitHub/Dulwich or an SDK replacement. Any package import must resolve
// through the explicitly selected actual Host dependency tree; no fake fallback.
const root = process.env.DSS_HISTORY_SOURCE ? pathToFileURL(path.resolve(process.env.DSS_HISTORY_SOURCE) + '/') : new URL('../src/', import.meta.url)
const sdkHost = process.env.DSS_SDK_HOST_ROOT
if (!sdkHost || !path.isAbsolute(sdkHost)) throw new Error('Set DSS_SDK_HOST_ROOT to the absolute actual DSH Host directory; no mock fallback is provided.')
const sdkParent = pathToFileURL(path.join(sdkHost, '__dss_history_fixture__.mjs')).href
const loadedPackages = new Map()
const loaded = new Map(), hash = value => createHash('sha256').update(value).digest('hex')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('.') && !path.isAbsolute(specifier) && !specifier.includes(':')) {
      const result = next(specifier, context.parentURL?.startsWith(root.href) ? { ...context, parentURL: sdkParent } : context)
      if (!result.url.startsWith(pathToFileURL(path.join(sdkHost, 'node_modules') + '/').href)) throw new Error('Package escaped explicit SDK Host dependency tree: ' + specifier)
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      const manifestPath = path.join(sdkHost, 'node_modules', name, 'package.json'), manifest = readFileSync(manifestPath)
      loadedPackages.set(specifier, { url: result.url, version: JSON.parse(manifest).version, manifestSha256: hash(manifest) }); return result
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
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
const module = name => import(new URL('framework/' + name + '.ts', root))
const { PhysicalLocalFiles } = await module('physical-local-files')
const { withSnapshot, withOperationChannel, GitFiles } = await module('transactions')
const { FrameworkTaskIndex } = await module('task-index')
const { FrameworkTaskHistoryCache, listTaskHistory, taskHistoryPath, taskHistoryChange } = await module('task-history')
const { paths, readJson, readMemberStatus, isTerminalTask, taskLifecycle } = await module('task-files')
const { taskArchiveReadPath } = await module('task-archive')
const { readTaskCleanupRecord } = await module('cleaner')
const { frameworkArchiveSkillPublication } = await module('client-presentation')
const serviceSource = readFileSync(new URL('framework/service.ts', root), 'utf8')
loaded.set('framework/service.ts', hash(serviceSource))
const serviceJs = stripTypeScriptTypes(serviceSource, { mode: 'transform' })
function serviceMethod(name) {
  const match = new RegExp('\\n    (?:async )?' + name + '\\(').exec(serviceJs); assert.ok(match, name)
  const start = match.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(serviceJs.slice(start + match[0].length))
  assert.ok(next, name); return serviceJs.slice(start, start + match[0].length + next.index)
}
const unexpected = name => () => { throw new Error('Unrelated controlled port unexpectedly reached: ' + name) }
const dependencies = { PhysicalLocalFiles, withSnapshot, withOperationChannel, FrameworkTaskIndex, FrameworkTaskHistoryCache,
  listTaskHistory, paths, readJson, readMemberStatus, isTerminalTask, taskLifecycle, taskArchiveReadPath, readTaskCleanupRecord,
  frameworkArchiveSkillPublication,
  // Fixture has no pending source conversion, legacy rows or conversation reads.
  localUpgradeView: async () => undefined, pendingLocalTaskResult: unexpected('pendingLocalTaskResult'),
  PendingLocalTaskViewCache: class { constructor() { throw new Error('Fixture supplies its empty legacy task view') } },
}
const Service = new Function(...Object.keys(dependencies), 'return class {\n' + ['settingsView', 'view'].map(serviceMethod).join('\n') + '\n}')(...Object.values(dependencies))
const names = [], measures = {}, versions = {}
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const rejects = async (name, action, pattern) => { await assert.rejects(action, pattern); names.push(name) }
const task = (id, title = 'Original') => ({ version: 1, taskId: id, route: 'P', sourcePath: `tasks/${title}_${id}_P.md`, owner: 'A', status: 'complete', archiveFolder: `Root_${id}`, resultPaths: [`archives/Root_${id}/answer.txt`] })
const history = (id, title) => taskHistoryChange(task(id, title)).content
const ids = Array.from({ length: 12 }, (_, index) => 'history-' + String(index).padStart(2, '0'))
const opened = []
const scratch = await fs.mkdtemp(path.join(process.env.DSS_HISTORY_SCRATCH ?? os.tmpdir(), 'history-cache-'))
function measured(files) {
  const calls = { historyLists: 0, historyReads: 0, directories: [], recursive: [], bodyPaths: [] }
  const original = { read: files.read.bind(files), list: files.list.bind(files), listDirectory: files.listDirectory.bind(files) }
  files.read = async (snapshot, logical) => {
    if (logical.startsWith('archives/task-identities/')) { calls.historyReads++; calls.bodyPaths.push(logical) }
    return original.read(snapshot, logical)
  }
  files.listDirectory = async (snapshot, logical, selection) => {
    calls.directories.push(logical); if (logical === 'archives/task-identities/') calls.historyLists++
    return original.listDirectory(snapshot, logical, selection)
  }
  files.list = async (...args) => { calls.recursive.push(args[1]); return original.list(...args) }
  return { files, calls, reset() { Object.assign(calls, { historyLists: 0, historyReads: 0, directories: [], recursive: [], bodyPaths: [] }) } }
}
function serviceFixture(files, scope = 'local', mode = 'local') {
  const service = new Service(), errors = []
  const access = { connection: { files, scope, identity: { instanceUUID: 'fixture-instance' } }, originalTasks: { view: () => ({ status: undefined, rows: [] }) } }
  Object.assign(service, { running: new Map(), userErrors: new Map(), archiveViews: new Map(), activeMode: mode, startupState: new Map(), accesses: new Map([[mode, Promise.resolve(access)]]), accessOpening: new Map(),
    localUpgrades: new Map(), storage: {}, fixtureAccess: access,
    config: () => ({ revision: 'settings-1', settings: { collaborationId: 'chat', ownerRepo: 'fixture/repository' } }), access: async () => service.fixtureAccess, observe: async () => [],
    report: (_mode, error) => errors.push(error), controls: () => ({ taskStates: async () => new Map() }),
  })
  return { service, access, errors, view: options => service.view({ mode, panelsOnly: true, includeArchives: false, ...options }) }
}
function counts(probe) { return { historyLists: probe.calls.historyLists, historyReads: probe.calls.historyReads } }
async function physical(name) { const files = new PhysicalLocalFiles(path.join(scratch, name)); opened.push(files); return files }
const readHistory = (cache, files, errors = [], signal) => withSnapshot(files, snapshot => cache.list(snapshot, error => errors.push(error), signal))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

// This is a controlled repository port. All path prefix mapping, snapshot
// ownership, reads and list selections continue through production GitFiles.
class ImmutableRepository {
  revisions = new Map(); selected = ''; gate; calls = { lists: 0, reads: 0 }
  set(head, records) { this.revisions.set(head, new Map(Object.entries(records).map(([name, body]) => ['dss-coop/' + name, body]))); this.selected = head }
  withReadOperation(operation) { return operation() }
  async snapshot() { return this.at(this.selected) }
  async at(head) { assert.ok(this.revisions.has(head)); return { head, rootTree: head, files: new Map([...this.revisions.get(head)].map(([name, body]) => [name, hash(body)])) } }
  async prefetch() {}
  async read(snapshot, logical) {
    this.calls.reads++
    if (this.gate?.head === snapshot.head && this.gate.logical === logical) { const gate = this.gate; this.gate = undefined; gate.entered.resolve(); await gate.release.promise }
    return this.revisions.get(snapshot.head).get(logical)
  }
  async readBytes(snapshot, logical) { const body = await this.read(snapshot, logical); return body === undefined ? undefined : Buffer.from(body) }
  async listDirectory(snapshot, prefix) {
    this.calls.lists++
    return [...this.revisions.get(snapshot.head)].filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
      .map(([name, body]) => ({ path: name, sha: hash(body), type: 'blob', size: Buffer.byteLength(body) }))
  }
  async list() {}
  releaseSnapshot() {}
}
try {
  const files = await physical('service'), probe = measured(files), fixture = serviceFixture(files)
  for (const id of ids) await files.replace(taskHistoryPath(id), history(id))
  // Out-of-category/nested data is not silently traversed or rewritten.
  await files.replace('archives/task-identities/nested/untouched.json', 'do not parse')
  await files.replace('archives/task-identities/untouched.txt', 'do not parse')
  probe.reset()
  const cold = await fixture.view(); measures.localCold = counts(probe)
  check('Actual service.view exposes all existing history rows', cold.tasks.map(row => row.taskId).sort(), ids)
  check('Cold service view lists once and reads twelve history bodies', counts(probe), { historyLists: 1, historyReads: 12 })
  probe.reset()
  for (let i = 0; i < 6; i++) check('Repeated panels-only view retains rows ' + i, (await fixture.view()).tasks.map(row => row.taskId).sort(), ids)
  measures.localSixWarmViews = counts(probe)
  check('Repeated panels-only view keeps discovery and only caches bodies', counts(probe), { historyLists: 6, historyReads: FrameworkTaskHistoryCache ? 0 : 72 })
  check('No recursive history scan is introduced', probe.calls.recursive, [])
  check('Only existing tasks/history directories are listed', [...new Set(probe.calls.directories)].sort(), ['archives/task-identities/', 'tasks/'])
  if (!FrameworkTaskHistoryCache) {
    check('Baseline view has no history body cache', !!fixture.access.taskHistoryCache, false)
    console.log(JSON.stringify({ status: 'passed', variant: 'baseline-service-only', assertions: names.length, measures, names, actualPackageImports: Object.fromEntries(loadedPackages), loadedSourceSha256: Object.fromEntries(loaded) }, null, 2))
  } else {
    // Real physical version behavior, including direct ordinary file edits.
    const filename = path.join(files.directory, taskHistoryPath(ids[0]))
    const version = async () => (await withSnapshot(files, snapshot => files.listDirectory(snapshot, 'archives/task-identities/'))).find(row => row.path === taskHistoryPath(ids[0]))?.version
    versions.original = await version(); check('Untouched physical metadata stays stable', await version(), versions.original)
    const beforeStat = await fs.stat(filename), original = await fs.readFile(filename, 'utf8')
    await fs.writeFile(filename, original.replace('Original', 'Modified')) // same-size ordinary user edit
    await fs.utimes(filename, beforeStat.atime, beforeStat.mtime)
    versions.userEdited = await version(); check('Same-size external edit with restored mtime changes FileEntry.version', versions.userEdited !== versions.original, true)
    probe.reset(); const edited = await fixture.view(); measures.localOneEdit = counts(probe)
    check('One external edit reads only that history body', counts(probe), { historyLists: 1, historyReads: 1 })
    check('Actual service reflects edited title', edited.tasks.find(row => row.taskId === ids[0]).title, `Modified_${ids[0]}_P.md`)
    edited.tasks.find(row => row.taskId === ids[0]).resultPaths.push('caller-mutation')
    check('Caller output mutation cannot poison later cache values', (await fixture.view()).tasks.find(row => row.taskId === ids[0]).resultPaths, task(ids[0]).resultPaths)
    await fs.rename(filename, filename + '.parked'); probe.reset()
    check('External rename out of selected suffix removes exact row', (await fixture.view()).tasks.length, 11)
    check('Deletion listing does not reread unaffected bodies', counts(probe), { historyLists: 1, historyReads: 0 })
    check('Successfully enumerated deletion evicts exact cached path', fixture.access.taskHistoryCache.cache.has(taskHistoryPath(ids[0])), false)
    await fs.rename(filename + '.parked', filename); versions.renamed = await version()
    check('Rename-back changes physical metadata version', versions.renamed !== versions.userEdited, true)
    probe.reset(); await fixture.view(); check('Rename-back rereads only the restored row', counts(probe), { historyLists: 1, historyReads: 1 })
    const recreatedText = await fs.readFile(filename, 'utf8'); await fs.unlink(filename); await fs.writeFile(filename, recreatedText)
    versions.recreated = await version(); check('Delete/recreate with identical content changes physical metadata version', versions.recreated !== versions.renamed, true)
    probe.reset(); await fixture.view(); check('Delete/recreate rereads only the recreated row', counts(probe), { historyLists: 1, historyReads: 1 })
    await files.replace(taskHistoryPath('added'), history('added')); probe.reset()
    check('New history row is discovered', (await fixture.view()).tasks.some(row => row.taskId === 'added'), true)
    check('New history reads only one body', counts(probe), { historyLists: 1, historyReads: 1 })
    // Recorder projection keeps current metadata separate; manual history clear
    // is an ordinary changed body, not a special invalidation API.
    await files.update(taskHistoryPath(ids[1]), bytes => ({ value: undefined, content: JSON.stringify({ ...JSON.parse(Buffer.from(bytes).toString()), historyCleared: true }) }))
    probe.reset(); const cleared = await fixture.view({ includeArchives: true })
    check('History-cleared changed body is read once', counts(probe), { historyLists: 1, historyReads: 1 })
    check('historyCleared hides task without losing results', [cleared.tasks.some(row => row.taskId === ids[1]), cleared.archives.find(row => row.taskId === ids[1]).files], [false, task(ids[1]).resultPaths])
    // A real malformed body must not retain the previous valid identity.
    await files.replace(taskHistoryPath(ids[2]), '{'); probe.reset(); const errorsBefore = fixture.errors.length
    check('Malformed body hides only affected history', (await fixture.view()).tasks.some(row => row.taskId === ids[2]), false)
    check('Unchanged malformed body is retried, not negatively cached', (await fixture.view()).tasks.some(row => row.taskId === ids[2]), false)
    check('Each malformed read reports its failure', fixture.errors.length - errorsBefore, 2)
    check('Malformed same-version retries read only failed body', counts(probe), { historyLists: 2, historyReads: 2 })
    await files.replace(taskHistoryPath(ids[2]), history(ids[2], 'Repaired')); probe.reset()
    check('Repaired ordinary JSON becomes visible', (await fixture.view()).tasks.find(row => row.taskId === ids[2]).title, `Repaired_${ids[2]}_P.md`)
    check('Repair reads only repaired body', counts(probe), { historyLists: 1, historyReads: 1 })
    // Transient I/O, listed-but-missing and enumeration failures are explicit
    // fault injection around the real adapter, never successful fake data.
    const actualRead = files.read.bind(files), target = taskHistoryPath(ids[3]); let failRead = true
    await files.replace(target, history(ids[3], 'IOChanged'))
    files.read = async (snapshot, logical) => { if (logical === target && failRead) { probe.calls.historyReads++; failRead = false; throw new Error('controlled I/O failure') } return actualRead(snapshot, logical) }
    probe.reset(); check('I/O failure does not fall back to old body', (await fixture.view()).tasks.some(row => row.taskId === ids[3]), false)
    check('Same-version I/O retry returns current body', (await fixture.view()).tasks.find(row => row.taskId === ids[3]).title, `IOChanged_${ids[3]}_P.md`)
    check('Only failing I/O path is retried', counts(probe), { historyLists: 2, historyReads: 2 }); files.read = actualRead
    const missing = taskHistoryPath(ids[4]); let missingOnce = true
    await files.replace(missing, history(ids[4], 'Reappeared'))
    files.read = async (snapshot, logical) => { if (logical === missing && missingOnce) { probe.calls.historyReads++; missingOnce = false; return undefined } return actualRead(snapshot, logical) }
    probe.reset(); check('Listed-but-missing body has no stale fallback', (await fixture.view()).tasks.some(row => row.taskId === ids[4]), false)
    check('Listed-but-missing path is retried at identical version', (await fixture.view()).tasks.find(row => row.taskId === ids[4]).title, `Reappeared_${ids[4]}_P.md`)
    check('Missing retry reads only affected body', counts(probe), { historyLists: 2, historyReads: 2 }); files.read = actualRead
    const actualList = files.listDirectory.bind(files), cachedBefore = fixture.access.taskHistoryCache.cache
    files.listDirectory = async (snapshot, logical, selection) => { if (logical === 'archives/task-identities/') throw new Error('controlled enumeration failure'); return actualList(snapshot, logical, selection) }
    check('Enumeration failure does not fabricate old visible rows', (await fixture.view()).tasks, [])
    check('Enumeration failure does not evict previously known cache', fixture.access.taskHistoryCache.cache, cachedBefore)
    files.listDirectory = actualList; probe.reset(); await fixture.view()
    check('Recovered enumeration reuses unchanged versions', counts(probe), { historyLists: 1, historyReads: 0 })
    // Exact identity validation is retained even when a user renames a JSON.
    const renamed = path.join(files.directory, taskHistoryPath('renamed'))
    await fs.rename(path.join(files.directory, taskHistoryPath('added')), renamed); probe.reset()
    const invalidRename = await fixture.view()
    check('Filename/Task mismatch is not accepted after rename', invalidRename.tasks.some(row => ['added', 'renamed'].includes(row.taskId)), false)
    check('Rename retries only the mismatched body', counts(probe), { historyLists: 1, historyReads: 1 })
    await fs.writeFile(renamed, history('renamed')); check('Matching user-edited renamed identity appears', (await fixture.view()).tasks.some(row => row.taskId === 'renamed'), true)
    // Current runnable task metadata still wins over a history row with same ID.
    const live = task(ids[5], 'Current'); await files.replace(paths.task(live.taskId), JSON.stringify(live))
    const precedence = await fixture.view(); check('Current Task takes precedence over cached history', precedence.tasks.filter(row => row.taskId === live.taskId).map(row => [row.title, !!row.archived]), [[`Current_${ids[5]}_P.md`, false]])
    await files.delete(paths.task(live.taskId)); check('Removing current Task exposes retained original history', (await fixture.view()).tasks.find(row => row.taskId === live.taskId).archived, true)
    check('No unanticipated service errors', fixture.errors.map(error => error.message).filter(message => !/Cannot read archived Task|controlled enumeration failure/.test(message)), [])
    const headerProbe = counts(probe); await fixture.view({ headerOnly: true }); check('Header-only stays outside history discovery', counts(probe), headerProbe)

    // Root/mode lifecycle: caches live only on their specific Access object.
    const other = await physical('other-root'); await other.replace(taskHistoryPath(ids[0]), history(ids[0], 'OtherRoot'))
    const otherProbe = measured(other), otherFixture = serviceFixture(other, 'other-root')
    fixture.service.fixtureAccess = otherFixture.access; otherProbe.reset()
    check('Replacement Access never reuses earlier root body', (await fixture.view()).tasks[0].title, `OtherRoot_${ids[0]}_P.md`)
    check('Replacement Access starts with one cold body', counts(otherProbe), { historyLists: 1, historyReads: 1 })
    check('Old root cache is not transferred', fixture.access.taskHistoryCache !== otherFixture.access.taskHistoryCache, true)
    await files.close(); check('New root remains usable after old physical store closes', (await fixture.view()).tasks[0].title, `OtherRoot_${ids[0]}_P.md`)

    // Physical views are live observations, not immutable snapshots. Delay an
    // already completed real read, edit the file, then complete a newer view.
    const racing = await physical('overlapping-local'), racePath = taskHistoryPath('race')
    await racing.replace(racePath, history('race', 'Before'))
    const racingProbe = measured(racing), racingFixture = serviceFixture(racing, 'racing-local')
    const raceEntered = deferred(), raceRelease = deferred(), raceRead = racing.read.bind(racing); let hold = true
    racing.read = async (snapshot, logical) => {
      const value = await raceRead(snapshot, logical)
      if (logical === racePath && hold) { hold = false; raceEntered.resolve(); await raceRelease.promise }
      return value
    }
    const earlierPhysical = racingFixture.view(); await raceEntered.promise
    await racing.replace(racePath, history('race', 'After'))
    check('Newer overlapping physical view observes actual edit', (await racingFixture.view()).tasks[0].title, 'After_race_P.md')
    raceRelease.resolve(); check('Earlier physical view returns the bytes it actually read', (await earlierPhysical).tasks[0].title, 'Before_race_P.md')
    racingProbe.reset(); check('Late physical completion cannot poison latest body', (await racingFixture.view()).tasks[0].title, 'After_race_P.md')
    check('Late physical completion leaves latest version reusable', counts(racingProbe), { historyLists: 1, historyReads: 0 })
    check('Physical overlap reports no errors', racingFixture.errors, [])

    // Production GitFiles, controlled immutable repository, real existing rows.
    const repository = new ImmutableRepository(), p = taskHistoryPath('git'), q = taskHistoryPath('git-second')
    repository.set('old', { [p]: history('git', 'Old'), [q]: history('git-second', 'Old') })
    const git = new GitFiles(repository, {}), gitProbe = measured(git), gitFixture = serviceFixture(git, 'git-scope', 'git')
    gitProbe.reset(); check('Git mode reads existing history rows', (await gitFixture.view()).tasks.map(row => row.taskId).sort(), ['git', 'git-second'])
    measures.controlledGitCold = counts(gitProbe); check('Git cold reads actual directory bodies', counts(gitProbe), { historyLists: 1, historyReads: 2 })
    gitProbe.reset(); await gitFixture.view(); measures.controlledGitWarm = counts(gitProbe)
    check('Git warm view still lists but reads no unchanged bodies', counts(gitProbe), { historyLists: 1, historyReads: 0 })
    repository.set('new', { [p]: history('git', 'New'), [q]: history('git-second', 'Old') }); gitProbe.reset()
    check('New Git blob changes the actual view', (await gitFixture.view()).tasks.find(row => row.taskId === 'git').title, 'New_git_P.md')
    check('Git reads only changed blob body', counts(gitProbe), { historyLists: 1, historyReads: 1 })
    repository.set('deleted', { [p]: history('git', 'New') }); gitProbe.reset(); await gitFixture.view()
    check('Git deletion requires no unaffected body reads', counts(gitProbe), { historyLists: 1, historyReads: 0 })
    check('Successful Git deletion evicts exact path', gitFixture.access.taskHistoryCache.cache.has(q), false)
    // Two actual service views overlap at different immutable snapshots. Older
    // first read finishes last; it must return old content without poisoning new.
    const concurrentFixture = serviceFixture(git, 'git-overlap', 'git')
    repository.selected = 'old'; const entered = deferred(), release = deferred()
    repository.gate = { head: 'old', logical: 'dss-coop/' + p, entered, release }
    const oldView = concurrentFixture.view(); await entered.promise
    repository.selected = 'deleted'; const newView = await concurrentFixture.view()
    check('Newer overlapping view uses its own immutable snapshot and membership', newView.tasks.map(row => [row.taskId, row.title]), [['git', 'New_git_P.md']])
    release.resolve(); const completedOld = await oldView
    check('Older overlapping view retains its own snapshot and deleted-row membership', completedOld.tasks.map(row => [row.taskId, row.title]).sort(), [['git', 'Old_git_P.md'], ['git-second', 'Old_git-second_P.md']])
    gitProbe.reset(); check('Old completion cannot poison new view', (await concurrentFixture.view()).tasks.find(row => row.taskId === 'git').title, 'New_git_P.md')
    check('Old completion cannot replace newer cache with old versions', counts(gitProbe), { historyLists: 1, historyReads: 0 })
    check('Old completion cannot reintroduce a deleted cached row', concurrentFixture.access.taskHistoryCache.cache.has(q), false)
    // Direct immutable historical read after newer view remains correct as well.
    const oldSnapshot = await git.at('old')
    try { check('Explicit old snapshot never reuses mismatching new body', (await concurrentFixture.access.taskHistoryCache.list(oldSnapshot, error => { throw error })).find(row => row.taskId === 'git').sourcePath, 'tasks/Old_git_P.md') } finally { await oldSnapshot.release() }
    check('Mode caches are separate Access-owned instances', concurrentFixture.access.taskHistoryCache !== otherFixture.access.taskHistoryCache, true)

    const sameServiceAccesses = new Map([['local', otherFixture.access], ['git', gitFixture.access]])
    otherFixture.service.access = async mode => sameServiceAccesses.get(mode)
    repository.selected = 'deleted'
    check('Same service preserves Local mode cache', (await otherFixture.service.view({ mode: 'local', panelsOnly: true })).tasks.map(row => row.title), [`OtherRoot_${ids[0]}_P.md`])
    check('Same service selects independent Git Access cache', (await otherFixture.service.view({ mode: 'git', panelsOnly: true })).tasks.map(row => row.title), ['New_git_P.md'])
    check('Switching back never crosses mode or root identities', (await otherFixture.service.view({ mode: 'local', panelsOnly: true })).tasks.map(row => row.title), [`OtherRoot_${ids[0]}_P.md`])

    // Cancellation neither delivers rows nor publishes a partial cache. The
    // next successful view may reuse only the preexisting matching values.
    const cancellable = new FrameworkTaskHistoryCache(git), controller = new AbortController(), cancelEntered = deferred(), cancelRelease = deferred()
    repository.selected = 'new'; repository.gate = { head: 'new', logical: 'dss-coop/' + p, entered: cancelEntered, release: cancelRelease }
    const aborted = readHistory(cancellable, git, [], controller.signal); await cancelEntered.promise; controller.abort(new Error('controlled abort')); cancelRelease.resolve()
    await rejects('Aborted read propagates cancellation', () => aborted, /controlled abort/)
    check('Aborted read cannot publish partial cache', cancellable.cache.size, 0)
    gitProbe.reset(); check('Next uncancelled read loads both rows', (await readHistory(cancellable, git)).length, 2)
    check('Cancellation retry reads both uncached bodies', counts(gitProbe), { historyLists: 1, historyReads: 2 })
    check('Controlled Git service has no faults', gitFixture.errors.concat(concurrentFixture.errors), [])
    // Plain callers retain original nonpersistent list behavior.
    gitProbe.reset(); await withSnapshot(git, snapshot => listTaskHistory(git, snapshot, error => { throw error })); await withSnapshot(git, snapshot => listTaskHistory(git, snapshot, error => { throw error }))
    check('Non-Access listTaskHistory callers remain uncached', counts(gitProbe), { historyLists: 2, historyReads: 4 })
    // No unrelated content was rewritten by cache or service reads.
    check('Nested unrelated file remains unchanged', await fs.readFile(path.join(files.directory, 'archives/task-identities/nested/untouched.json'), 'utf8'), 'do not parse')
    console.log(JSON.stringify({ status: 'passed', variant: 'candidate', assertions: names.length, node: process.version, platform: process.platform,
      scope: 'Actual service settingsView/view method, PhysicalLocalFiles and GitFiles. Local uses real Linux scratch files. Git repository and unrelated service ports are controlled. No live network, SDK activation, Windows, build or typecheck claim.',
      measures, versions, names, actualPackageImports: Object.fromEntries(loadedPackages), loadedSourceSha256: Object.fromEntries([...loaded].sort()) }, null, 2))
  }
} finally { await Promise.all(opened.map(files => files.close())); await fs.rm(scratch, { recursive: true, force: true }); hooks.deregister() }
