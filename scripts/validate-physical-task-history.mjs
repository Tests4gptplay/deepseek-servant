import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Real Linux files, production Recorder/history/Host/Cleaner/workspace/manual
// methods. Native release is a controlled port here (covered separately by the
// actual-method Cleaner suite). Schema/Markdown imports are explicit stubs.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){const children=[];for(const m of text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g))children.push({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}});return {type:'root',children}}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', root).href) return { url: data('export const frameworkSkillIndexPath="skills/index.md";export function isFrameworkSkillDefinitionPath(){throw new Error("Skill definition outside this test")}export function prepareFrameworkSkillIndex(){throw new Error("Skill publication is outside this test")}'), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8'); loaded.set(url.slice(root.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { PendingLocalTaskViewCache, pendingLocalTaskResult } = await import('../src/framework/legacy-local-task-view.ts')
const { localUpgradeView } = await import('../src/framework/local-upgrade-view.ts')
const { frameworkArchiveSkillPublication } = await import('../src/framework/client-presentation.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { FrameworkCleaner, readTaskCleanupRecord } = await import('../src/framework/cleaner.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { FrameworkTaskIndex } = await import('../src/framework/task-index.ts')
const { TaskWorkspaces } = await import('../src/framework/task-workspace.ts')
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { installFrameworkRoleTools, workerPaths } = await import('../src/framework/role-tools.ts')
const { prepareRecorderRetention, readTaskRequirementReference, resolveTaskRequirementReference, readArchivedReference, taskRequirementChain } = await import('../src/framework/recorder-retention.ts')
const { readTaskArchiveIdentity, taskArchiveStatePath, taskArchiveReadPath, updateTaskArchiveState } = await import('../src/framework/task-archive.ts')
const { parseTaskReference, referenceTaskId, readPublishedReference, taskReference } = await import('../src/framework/published-references.ts')
const { taskHistoryPath, readTaskReferenceIdentity, listTaskHistory, FrameworkTaskHistoryCache } = await import('../src/framework/task-history.ts')
const { paths, readJson, taskLifecycleKey, taskLifecycle, taskWorkingRoots, encodeJson, readMemberStatus, isTerminalTask } = await import('../src/framework/task-files.ts')
const { withSnapshot, withOperationChannel } = await import('../src/framework/transactions.ts')
const hash = value => createHash('sha256').update(value).digest('hex')
const names = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const rejects = async (name, action, match) => { await assert.rejects(action, match); names.push(name) }
const serviceSource = readFileSync(new URL('framework/service.ts', root), 'utf8'), serviceJs = stripTypeScriptTypes(serviceSource, { mode: 'transform' })
loaded.set('framework/service.ts', hash(serviceSource))
const serviceMethod = name => {
  const match = new RegExp('\\n    (?:async )?' + name + '\\(').exec(serviceJs)
  assert.ok(match, name)
  const start = match.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(serviceJs.slice(start + match[0].length))
  assert.ok(next, name)
  return serviceJs.slice(start, start + match[0].length + next.index)
}
const serviceDependencies = { frameworkArchiveSkillPublication, PhysicalLocalFiles, PendingLocalTaskViewCache, pendingLocalTaskResult, localUpgradeView, withSnapshot, withOperationChannel, FrameworkTaskIndex, FrameworkTaskHistoryCache, listTaskHistory, readTaskReferenceIdentity,
  taskArchiveReadPath, paths, readJson, readMemberStatus, isTerminalTask, taskLifecycle, readTaskCleanupRecord,
  parseTaskReference, referenceTaskId, readPublishedReference, readArchivedReference, resolveTaskRequirementReference }
const Service = new Function(...Object.keys(serviceDependencies), 'return class {\n' + ['settingsView', 'view', 'readFileBytes'].map(serviceMethod).join('\n') + '\n}')(...Object.values(serviceDependencies))
class TechnicalRecords {
  constructor(directory) { this.files = new LocalRecordFiles(directory) }
  filename(key) { return 'records/' + Buffer.from(key).toString('base64url') + '.json' }
  async get(key) { const value = await this.files.read(this.filename(key)); return value === undefined ? undefined : JSON.parse(value).value }
  async set(key, value) { await this.files.replace(this.filename(key), JSON.stringify({ key, value })) }
  async delete(key) { await this.files.delete(this.filename(key)) }
}
const transactions = { run() { throw new Error('Physical history must not call SQL/Git transaction publication') } }
const read = (files, logical) => withSnapshot(files, snapshot => files.read(snapshot, logical))
async function hostFor(directory) {
  const files = new PhysicalLocalFiles(path.join(directory, 'local')), records = new TechnicalRecords(path.join(directory, 'technical')), errors = []
  const cleaner = new FrameworkCleaner(files, transactions)
  const host = new FrameworkHostLoop(files, transactions, records, { scope: directory, member: 'A', primary: true, instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, () => ['A'], {
    async wake() {}, executing() { return false }, async releaseTask() {}, error(error) { errors.push(error) },
    async observe() {},
    async clean(task, snapshot, observation) { return (await cleaner.clean(task, observation)).status === 'released' },
  })
  host.record = await records.get(host.key) ?? { initial: {}, completed: {} }
  return { files, records, host, cleaner, errors }
}
async function prepare(directory) {
  const fixture = await hostFor(directory), { files } = fixture
  const id = suffix => '00000000-0000-4000-8000-' + hash(directory + suffix).slice(0, 12)
  const total = { version: 1, taskId: id('root'), route: 'O', sourcePath: 'tasks/Original Root_O.md', owner: 'A', status: 'complete', lifecycleId: 'original-round', members: ['A', 'B'],
    archiveFolder: 'Original Root_' + id('root'), workspaceFolder: 'Original Workspace_' + id('root'), workspaceRootTaskId: id('root') }
  const child = { version: 1, taskId: id('child'), route: 'P', sourcePath: 'tasks/' + id('child') + '_P.md', owner: 'B', status: 'complete', lifecycleId: 'child-round', members: ['B'],
    archiveFolder: total.archiveFolder + '/Original Child_' + id('child'), parent: { taskId: total.taskId, owner: 'A', objectiveId: 'one' } }
  total.children = [{ taskId: child.taskId, member: 'B', objectiveId: 'one' }]
  total.resultPaths = [paths.run(total.taskId) + '/answer.txt']
  child.resultPaths = [paths.run(child.taskId) + '/child-answer.txt']
  child.workspaceResults = [{ path: path.join(directory, 'workspace', total.workspaceFolder, 'original.bin'), taskId: child.taskId, owner: 'B', instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]
  for (const task of [total, child]) {
    await files.replace(paths.task(task.taskId), encodeJson(task))
    await files.replace(task.sourcePath, 'Task ID: ' + task.taskId + '\nOriginal requirement: ' + task.owner)
    for (const working of taskWorkingRoots(task)) await files.replace(working + '/temporary.txt', 'temporary')
    await files.replace(task.resultPaths[0], 'Actual delivered result: ' + task.owner)
  }
  await files.replace('skills/example/SKILL.md', 'independent skill')
  await files.replace('state/Foreground_Task_' + total.taskId, '')
  const plan = await withSnapshot(files, snapshot => prepareRecorderRetention(files, snapshot, total,
    { lifecycleId: total.lifecycleId, outputs: [paths.archive(total) + '/records.md'], retainedPaths: [total.sourcePath, child.sourcePath] },
    [{ path: paths.archive(total) + '/records.md', content: 'Actual Recorder report' }]))
  for (const change of [...plan.changes, ...plan.ancestorChanges]) await files.replace(change.path, change.bytes ?? change.content)
  await files.replace(paths.archive(total) + '/retention.json', encodeJson(plan.retention))
  await files.replace(paths.state(total.owner, total.taskId) + '/Cleaner', '')
  return { ...fixture, total, child, plan, directory }
}
async function finish(fixture) {
  const { host, files, total } = fixture
  const pending = Object.keys(host.record.completed).filter(key => host.record.completed[key].cleanup)
  if (pending.length) await Promise.all(await host.runPoll([], undefined, {}, performance.now()))
  else if (await read(files, paths.task(total.taskId))) await withSnapshot(files, snapshot => host.scanTask(total, snapshot, performance.now()))
  // A scan starts native release and continues physical cleanup asynchronously.
  // Assertions below require that existing responsibility to finish.
  while (host.physicalReleaseOperations.size || host.physicalCleanupOperations.size || host.taskOperations.size) {
    await Promise.allSettled([...host.physicalReleaseOperations.values(), ...host.physicalCleanupOperations.values(), ...host.taskOperations])
    await new Promise(resolve => setImmediate(resolve))
    if (fixture.errors.length) throw new AggregateError(fixture.errors)
  }
  if (fixture.errors.length) throw new AggregateError(fixture.errors)
}
if (process.argv[2] === '--interrupt') {
  const [checkpoint, directory] = process.argv.slice(3), fixture = await hostFor(directory)
  const descriptors = JSON.parse(await fs.readFile(path.join(directory, 'fixture.json'), 'utf8'))
  Object.assign(fixture, descriptors)
  const { files, records, host, total, child } = fixture
  if (checkpoint === 'scope') {
    const set = records.set.bind(records)
    records.set = async (key, value) => { await set(key, value); if (key === host.key && value.completed[taskLifecycleKey(total)]?.cleanup) process.exit(86) }
  } else if (checkpoint === 'root-state-directory') {
    // Recorder's signal is inside this whole Task directory. Interrupt after
    // the actual directory removal, not a retired per-file signal deletion.
    const remove = files.removeDirectory.bind(files)
    files.removeDirectory = async logical => { const value = await remove(logical); if (logical === paths.state(total.owner, total.taskId)) process.exit(86); return value }
  } else if (checkpoint === 'working-directories-finished') {
    // Cleaner is a fixed directory operation, with no role/retiring phase.
    // The Host already holds the family while native release runs separately.
    const clean = fixture.cleaner.clean.bind(fixture.cleaner)
    fixture.cleaner.clean = async (...args) => { await clean(...args); process.exit(86) }
  } else if (checkpoint === 'child-metadata' || checkpoint === 'root-metadata') {
    const update = files.update.bind(files), target = paths.task((checkpoint === 'child-metadata' ? child : total).taskId)
    files.update = async (logical, decide) => { const value = await update(logical, decide); if (logical === target) process.exit(86); return value }
  } else if (checkpoint === 'host-finished') {
    const set = records.set.bind(records)
    records.set = async (key, value) => { await set(key, value); if (key === host.key && !value.completed[taskLifecycleKey(total)]?.cleanup && !await read(files, paths.task(total.taskId))) process.exit(86) }
  }
  await finish(fixture)
  throw new Error('The selected real interruption was not reached')
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-task-history-')), opened = []
try {
  const fixture = await prepare(path.join(scratch, 'history')); opened.push(fixture.files)
  const { files, total, child, host, plan } = fixture
  const priorTools = []
  for (const [role, task, recordPath] of [
    ['Organizer', total, paths.run(total.taskId) + '/Organizer_Note.md'],
    ['Recorder', total, paths.run(total.taskId) + '/Recorder_Note.md'],
    ['Planner', child, paths.member(child.taskId, child.owner) + '/Planner_Memory.md'],
    ['Worker', child, workerPaths(child.taskId, child.owner, 'history-worker').notes],
  ]) {
    const tools = new Map(), agent = { id: 'prior-' + role, session: {} }
    const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
    installFrameworkRoleTools(ctx, agent, { role, owner: task.owner, member: task.owner, taskId: task.taskId,
      lifecycleId: task.lifecycleId, workId: role, executionId: 'execution-' + role, ...(role === 'Worker' ? { workerId: 'history-worker' } : {}) }, {
      files, transact: transactions.run, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError() {},
      workerBusiness: { assertLive() {}, async assert() {} },
    })
    let serial = 0
    const call = (name, input) => tools.get(name).execute(input, { agent, callId: String(++serial), signal: new AbortController().signal, concludeTurn() {} })
    const selected = await call('dss_snapshot', {})
    // The actual role's current Task, not an archive cleanup phase, controls
    // these normal record writes. No synthetic Cleaner state is inserted.
    const originalRead = files.read.bind(files)
    files.read = (snapshot, logical) => {
      if (logical === taskArchiveStatePath(task)) throw new Error('An ordinary Local role record must not read an archive cleanup phase')
      return originalRead(snapshot, logical)
    }
    try { await call('dss_record', { snapshotId: selected.snapshotId, path: recordPath, text: 'Real role record before cleanup', append: true }) }
    finally { files.read = originalRead }
    check(role + ' writes its own record without reading archive cleanup', await read(files, recordPath), 'Real role record before cleanup')
    priorTools.push({ role, task, recordPath, call, snapshotId: selected.snapshotId })
  }
  const before = await withSnapshot(files, snapshot => listTaskHistory(files, snapshot, error => { throw error }))
  check('Recorder preserved both original Task identities', before.map(task => task.taskId).sort(), [total.taskId, child.taskId].sort())
  for (const history of before) for (const name of ['members', 'control', 'roles', 'wakes', 'cleanup', 'runtimeReleased'])
    check('History omits transient ' + name + ' for ' + history.taskId, name in history, false)
  check('Recorder includes child result verification in root catalog', Object.keys(plan.retention.verifiedReferences).includes(before.find(task => task.taskId === child.taskId).resultPaths[0]), true)
  await finish(fixture)
  for (const { role, task, recordPath, call, snapshotId } of priorTools) {
    await rejects(role + ' late write after actual Host/Cleaner cannot recreate runtime',
      () => call('dss_record', { snapshotId, path: recordPath, text: 'Late write', append: true }), /Task lifecycle changed/)
    check(role + ' late write leaves deleted Task directory absent', existsSync(path.join(files.directory, paths.run(task.taskId))), false)
  }
  for (const task of [total, child]) {
    check('Full current metadata is deleted ' + task.taskId, await read(files, paths.task(task.taskId)), undefined)
    check('Mechanical archive state is deleted ' + task.taskId, await read(files, taskArchiveStatePath(task)), undefined)
    for (const dir of taskWorkingRoots(task)) check('Known runtime directory is removed ' + dir, existsSync(path.join(files.directory, dir)), false)
    const identity = await withSnapshot(files, snapshot => readTaskArchiveIdentity(files, snapshot, task.taskId))
    check('Exact original nested archive location remains', paths.archive(identity), paths.archive(task))
    const requirement = await withSnapshot(files, snapshot => readTaskRequirementReference(files, snapshot, identity, task.sourcePath))
    check('Original requirement bytes survive ' + task.taskId, requirement.text, 'Task ID: ' + task.taskId + '\nOriginal requirement: ' + task.owner)
    const delivered = await withSnapshot(files, snapshot => readArchivedReference(files, snapshot, task.taskId, task.resultPaths[0]))
    check('Original delivered result resolves ' + task.taskId, Buffer.from(delivered).toString('utf8'), 'Actual delivered result: ' + task.owner)
  }
  const taskIndex = new FrameworkTaskIndex(files, error => { throw error })
  check('Runtime discovery never revives archived Tasks', await withSnapshot(files, snapshot => taskIndex.list(snapshot)), [])
  const childHistory = await withSnapshot(files, snapshot => readTaskReferenceIdentity(files, snapshot, child.taskId))
  check('Historical requirement chain retains reciprocal original tree', (await withSnapshot(files, snapshot => taskRequirementChain(files, snapshot, childHistory))).map(task => task.taskId), [child.taskId, total.taskId])
  const workspaces = new TaskWorkspaces(files, path.join(fixture.directory, 'workspace'), 'A', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  check('Historical folder identity alone does not invent a native workspace', await workspaces.locate(child.taskId, undefined, true), undefined)
  await rejects('Historical workspace cannot initialize execution', () => workspaces.ensure(child.taskId), /metadata is unavailable/)
  check('No persistent completed cleanup scope remains', await fixture.records.get(host.key), { initial: {}, completed: {} })
  check('Independent global Foreground notice survives', await read(files, 'state/Foreground_Task_' + total.taskId), '')
  check('Independent skills survive', await read(files, 'skills/example/SKILL.md'), 'independent skill')
  await rejects('Runtime state writes cannot revive history by Task ID', () => updateTaskArchiveState(files, total.taskId, (_s, _t, state) => ({ write: true, state, result: undefined })), /Current Task metadata is unavailable/)
  const service = new Service(), viewErrors = []
  const access = { connection: { files, scope: 'history', identity: { instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } } }
  Object.assign(service, { storage: fixture.records, localUpgrades: new Map(), running: new Map(), userErrors: new Map(), archiveViews: new Map(), activeMode: 'local', startupState: new Map(), accesses: new Map(), accessOpening: new Map(),
    config: () => ({ revision: 1, settings: { collaborationId: 'chat' } }), access: async () => access, observe: async () => [],
    report: (_mode, error) => viewErrors.push(error), controls() { throw new Error('Archived Tasks must not request live controls') } })
  const view = await service.view({ mode: 'local', panelsOnly: true, includeArchives: true })
  check('Actual service UI lists original history identities', view.tasks.map(task => task.taskId).sort(), [total.taskId, child.taskId].sort())
  check('Actual service UI has no live members/controls/executions for history', view.tasks.every(task => task.archived && task.members.length === 0 && task.executions.length === 0 && task.control === undefined), true)
  check('Actual service archive UI resolves original title and nested location', view.archives.find(row => row.taskId === total.taskId).path, paths.archive(total) + '/records.md')
  for (const task of [total, child]) check('Actual service Task reference opens original source', Buffer.from(await withSnapshot(files, snapshot => service.readFileBytes(files, snapshot, taskReference(task.taskId, task.sourcePath)))).toString('utf8'),
    'Task ID: ' + task.taskId + '\nOriginal requirement: ' + task.owner)
  check('Actual service history read reports no faults', viewErrors, [])
  for (const role of ['Foreground', 'Helper']) {
    const tools = new Map(), agent = { id: 'history-reader-' + role, session: {} }
    const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
    installFrameworkRoleTools(ctx, agent, { role, owner: 'A', member: 'A', workId: role, executionId: 'execution-' + role }, {
      files, transact: transactions.run, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError() {},
    })
    let serial = 0
    const call = (name, input) => tools.get(name).execute(input, { agent, callId: String(++serial), signal: new AbortController().signal, concludeTurn() {} })
    const selected = await call('dss_snapshot', { taskId: child.taskId })
    check('Actual ' + role + ' selected archive view retains pinned child identity', selected.archiveDirectory, paths.archive(child))
    check('Actual ' + role + ' selected historical dss_read opens original requirement',
      (await call('dss_read', { snapshotId: selected.snapshotId, path: taskReference(child.taskId, child.sourcePath) })).text,
      'Task ID: ' + child.taskId + '\nOriginal requirement: B')
    const unselected = await call('dss_snapshot', {})
    check('Actual ' + role + ' unselected explicit historical dss_read works',
      (await call('dss_read', { snapshotId: unselected.snapshotId, path: taskReference(total.taskId, total.sourcePath) })).text,
      'Task ID: ' + total.taskId + '\nOriginal requirement: A')
  }
  // Exact Task reference source filename reuse must resolve the old archive.
  await files.replace(total.sourcePath, 'Task ID: 00000000-0000-4000-8000-999999999999\nNew unrelated source')
  check('Reused source path still resolves original archived bytes', (await withSnapshot(files, snapshot => readTaskRequirementReference(files, snapshot, before.find(task => task.taskId === total.taskId), total.sourcePath))).text,
    'Task ID: ' + total.taskId + '\nOriginal requirement: A')
  const conversation = new FrameworkConversation(files, transactions, { mode: 'local', collaborationId: 'chat' })
  const manual = new FrameworkManualCleanup(files, transactions, conversation, {
    async prepareTaskCleanup(id) { if (!await host.taskReleased(id, before.find(task => task.taskId === id).lifecycleId)) throw new Error('Not released') },
    taskCleanupComplete: (id, lifecycleId) => host.taskReleased(id, lifecycleId),
  })
  const preview = await manual.previewTasks()
  check('Manual preview retains both ended historical identities', preview.tasks.map(task => task.taskId).sort(), [total.taskId, child.taskId].sort())
  await manual.clearTasks('clear-original-history', preview, 'clear-ended-task-records')
  check('Explicit history removal hides records without losing delivered result identity', (await withSnapshot(files, snapshot => readTaskReferenceIdentity(files, snapshot, child.taskId))).historyCleared, true)
  for (const history of before) for (const result of history.resultPaths) check('Delivered artifacts survive manual history removal', await read(files, result), 'Actual delivered result: ' + history.owner)
  check('Completed manual cleanup commands retire', await withSnapshot(files, snapshot => files.list(snapshot, 'technical/manual-cleanup/')), [])
  check('Manually cleared identities no longer repeat in cleanup preview', (await manual.previewTasks()).tasks, [])
  const clearedView = await service.view({ mode: 'local', panelsOnly: true, includeArchives: true })
  check('Actual service hides user-cleared history rows', clearedView.tasks, [])
  check('Actual service keeps delivered-result cards after explicit history clear', clearedView.archives.map(row => row.taskId).sort(), [total.taskId, child.taskId].sort())
  for (const checkpoint of ['scope', 'root-state-directory', 'working-directories-finished', 'child-metadata', 'root-metadata', 'host-finished']) {
    const directory = path.join(scratch, checkpoint), selected = await prepare(directory); opened.push(selected.files)
    await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ total: selected.total, child: selected.child }))
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', checkpoint, directory], { encoding: 'utf8' })
    check('Real process exit at ' + checkpoint + (run.stderr || ''), run.status, 86)
    const resumed = await hostFor(directory); opened.push(resumed.files); Object.assign(resumed, { total: selected.total, child: selected.child })
    await finish(resumed)
    for (const task of [selected.total, selected.child]) {
      check('Cold completion retires exact metadata after ' + checkpoint, await read(resumed.files, paths.task(task.taskId)), undefined)
      check('Cold completion retires exact mechanical state after ' + checkpoint, await read(resumed.files, taskArchiveStatePath(task)), undefined)
      check('Cold completion retains archive identity after ' + checkpoint, (await withSnapshot(resumed.files, snapshot => readTaskReferenceIdentity(resumed.files, snapshot, task.taskId))).taskId, task.taskId)
    }
    check('Cold completion retires original Host scope after ' + checkpoint, await resumed.records.get(resumed.host.key), { initial: {}, completed: {} })
  }
  console.log(JSON.stringify({ status: 'passed', assertions: names.length, processInterruptions: 6, node: process.version,
    scope: 'Production physical Recorder/history/Host/Cleaner/workspace/manual paths on Linux; schema/Markdown/native release ports controlled; native DSH/Windows/typecheck/build not run', names,
    loadedSourceSha256: Object.fromEntries([...loaded].sort(([a], [b]) => a.localeCompare(b))) }, null, 2))
} finally { await Promise.all(opened.map(files => files.close())); await fs.rm(scratch, { recursive: true, force: true }); hooks.deregister() }
