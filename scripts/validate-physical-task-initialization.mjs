import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Real Host.start/poll/source lane, accepted task initialization, physical
// adapter, filesystem and fresh-process interruption/reopen. The Host record
// uses a controlled on-disk StoragePort harness, not native DSH. Unrelated Zod,
// Markdown and skill publication imports are stubbed because dependencies are
// absent. Current Task metadata parsing runs unchanged in FrameworkTaskIndex.
// This is Linux process-stop coverage, not Windows, power-loss durability,
// arbitrary cross-process writer exclusion, full typecheck or production cutover.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: data(`const schema = new Proxy(function () {}, { get(_t,k) { if(k==='parse') return v=>v; if(k==='toJSONSchema') return ()=>({}); return schema }, apply(){ return schema } }); export const z=schema;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(){throw new Error('Markdown is outside this focused test')}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', sourceRoot).href) return { url: data(`export const frameworkSkillIndexPath='skills/index.md'; export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skill publication is outside this focused test')}`), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { paths, taskIdentity, taskInitializationFiles, preparePhysicalTask } = await import('../src/framework/task-files.ts')
const body = '# Preserve my task\r\n\r\n原文 requirement with spaces.\r\n'
const scope = 'physical-init-focused', key = 'framework-host/' + createHash('sha256').update(scope).digest('hex')
const id = '10000000-0000-4000-8000-000000000001'
let assertions = 0
const healthyPollChecks = [], interruptedInitializations = []
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (work, expected) => { await assert.rejects(work, expected); assertions++ }
const read = async (root, logical) => fs.readFile(path.join(root, 'files', ...logical.split('/')), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
const record = async root => JSON.parse(await fs.readFile(path.join(root, 'host', 'record.json'), 'utf8'))
const checkpoint = phase => { if (process.argv[2] === '--child' && process.argv[4] === phase) process.exit(72) }
class DiskHostRecords {
  constructor(root) { this.records = new LocalRecordFiles(path.join(root, 'host')) }
  async get(selected) { assert.equal(selected, key); const text = await this.records.read('record.json'); return text === undefined ? undefined : JSON.parse(text) }
  async set(selected, value) {
    assert.equal(selected, key, 'Initialization must not create a command journal')
    await this.records.replace('record.json', JSON.stringify(value))
    const assignment = Object.values(value.initial)[0]
    if (assignment?.initialSignal?.prepared) checkpoint('after-prepared-save')
    else if (assignment?.initialSignal) checkpoint('after-reservation')
    else if (assignment) checkpoint('after-retirement')
  }
  async list() { throw new Error('Host initialization must not scan its record store') }
}
async function harness(root, fault = false) {
  const files = new PhysicalLocalFiles(path.join(root, 'files')), storage = new DiskHostRecords(root)
  const events = [], errors = [], observed = []
  const actions = { startup: async () => {}, observe: async () => {}, executing: () => false,
    wake: async wake => { events.push(wake); return true }, sealBusiness: async () => {},
    clean: async () => false, releaseTask: async () => {}, error: error => errors.push(error),
    taskStateObserved: async task => observed.push(task), initializeWorkspace: async () => {} }
  const loop = new FrameworkHostLoop(files, new FrameworkTransactions(files, storage, scope), storage,
    { member: 'owner', primary: true, scope, instanceUUID: '20000000-0000-4000-8000-000000000002' }, () => ['owner', 'other'], actions)
  files.list = async () => { throw new Error('No recursive business-file scan belongs to initialization') }
  if (fault) {
    const update = files.update.bind(files), create = files.createIfAbsent.bind(files), rename = files.rename.bind(files)
    files.update = async (logical, decide) => { const result = await update(logical, decide); if (logical.startsWith('tasks/') && logical.endsWith('.md')) checkpoint('after-source'); return result }
    files.createIfAbsent = async (logical, content) => {
      const result = await create(logical, content)
      if (logical.endsWith('_Inbox/' + 'owner_' + taskIdentity(await read(root, 'tasks/example_P.md') ?? '') + '.md')) checkpoint('after-inbox')
      if (logical.startsWith('tasks/') && logical.endsWith('.json')) checkpoint('after-metadata')
      if (logical.includes('/.initial-signal-')) checkpoint('after-temporary')
      return result
    }
    files.rename = async (from, to) => {
      const result = await rename(from, to)
      if (process.argv[4] === 'after-consumption') { await files.delete(to); checkpoint('after-consumption') }
      checkpoint('after-publication'); return result
    }
  }
  return { files, storage, loop, events, errors, observed,
    async start() { await loop.start(); await loop.firstPoll },
    async close() { await loop.stop(); await files.close() } }
}
if (process.argv[2] === '--child') {
  const h = await harness(process.argv[3], true)
  await h.start(); await h.loop.poll()
  if (h.errors.length) throw new AggregateError(h.errors, 'Child Host reported errors')
  await h.close(); hooks.deregister(); process.exit(0)
}
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-physical-task-init-'))
async function seed(root, route, text = body) {
  const files = new PhysicalLocalFiles(path.join(root, 'files'))
  await files.replace('tasks/example_' + route + '.md', text); await files.close()
}
function child(root, phase) {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), '--child', root, phase], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, phase === 'resume' ? 0 : 72, result.error?.stack ?? result.stderr)
  assertions++
}
try {
  for (const route of ['P', 'O']) {
    const root = path.join(sandbox, route); await seed(root, route)
    const h = await harness(root)
    try {
      await h.start()
      const source = await read(root, 'tasks/example_' + route + '.md'), taskId = taskIdentity(source)
      check(source, 'Task ID: ' + taskId + '\n' + body)
      const task = JSON.parse(await read(root, paths.task(taskId)))
      check({ route: task.route, owner: task.owner, members: task.members, parent: task.parent, status: task.status }, { route, owner: 'owner', members: ['owner', 'other'], parent: undefined, status: 'running' })
      check(task.workspaceFolder.endsWith('_' + taskId), true)
      for (const change of taskInitializationFiles(task)) check(await read(root, change.path), route === 'P' && change.path === paths.inbox(taskId, 'owner') ? body : change.content)
      const target = paths.state('owner', taskId) + (route === 'P' ? '/Planner_Inbox' : '/Organizer_Task')
      check(await read(root, target), '')
      const saved = await record(root), assignment = Object.values(saved.initial)[0]
      check(Object.keys(saved.initial).length, 1)
      check({ taskId: assignment.taskId, source: assignment.physicalSourcePath, signal: assignment.initialSignal }, { taskId, source: task.sourcePath, signal: undefined })
      // Healthy normal discovery must not enumerate default directories or
      // try template writes. These are the real FilesStore entry points.
      const defaults = new Set(taskInitializationFiles(task).map(change => change.path.slice(0, change.path.lastIndexOf('/'))))
      const directory = h.files.listDirectory.bind(h.files), create = h.files.createIfAbsent.bind(h.files)
      let defaultQueries = 0, defaultCreates = 0
      h.files.listDirectory = async (snapshot, prefix, selection) => {
        if (defaults.has(prefix.replace(/\/$/, ''))) defaultQueries++
        return directory(snapshot, prefix, selection)
      }
      h.files.createIfAbsent = async (logical, content) => { defaultCreates++; return create(logical, content) }
      for (let poll = 0; poll < 3; poll++) {
        await h.loop.poll()
        check({ defaultQueries, defaultCreates }, { defaultQueries: 0, defaultCreates: 0 })
        healthyPollChecks.push({ route, poll, defaultQueries, defaultCreates })
      }
      check(h.observed.some(value => value.taskId === taskId && value.route === route), true)
      check(h.events.some(wake => wake.role === (route === 'P' ? 'Planner' : 'Organizer') && wake.taskId === taskId), true)
      const authored = route === 'P' ? paths.member(taskId, 'owner') + '/Plan.md' : paths.run(taskId) + '/Organizer_Note.md'
      const removed = route === 'P' ? paths.member(taskId, 'owner') + '/Reply.md' : paths.run(taskId) + '/Dispatch.md'
      await h.files.replace(authored, 'Keep authored text'); await h.files.delete(removed)
      await h.files.delete(target); h.events.length = 0
      await h.loop.poll()
      check(await read(root, authored), 'Keep authored text')
      // An intentional external deletion stays absent; ordinary discovery is
      // not a request to synthesize empty replacement business records.
      check(await read(root, removed), undefined)
      check({ defaultQueries, defaultCreates }, { defaultQueries: 0, defaultCreates: 0 })
      check(await read(root, target), undefined)
      check(h.events.length, 0)
      check(h.errors.map(error => error.message), [])
    } finally { await h.close() }
    child(root, 'resume')
    check(Object.keys((await record(root)).initial).length, 1)
    const taskId = taskIdentity(await read(root, 'tasks/example_' + route + '.md'))
    check(await read(root, route === 'P' ? paths.member(taskId, 'owner') + '/Reply.md' : paths.run(taskId) + '/Dispatch.md'), undefined)
  }
  // An upper-level supplied UUID and already-authored files are retained.
  {
    const root = path.join(sandbox, 'existing-content'); await seed(root, 'P', 'Task ID: ' + id + '\n' + body)
    const h = await harness(root)
    try {
      await h.files.replace(paths.inbox(id, 'owner'), 'Authored Inbox')
      await h.files.replace(paths.memberStatus(id, 'owner'), '{"state":"complete","custom":true}')
      await h.files.replace(paths.member(id, 'owner') + '/Planner_Memory.md', 'memory')
      await h.start()
      check(await read(root, paths.inbox(id, 'owner')), 'Authored Inbox')
      check(await read(root, paths.memberStatus(id, 'owner')), '{"state":"complete","custom":true}')
      check(await read(root, paths.member(id, 'owner') + '/Planner_Memory.md'), 'memory')
      check(Object.values((await record(root)).initial)[0].taskId, id)
      check(h.errors.length, 0)
    } finally { await h.close() }
  }
  // Real process stops at each durable seam, then reopen through Host.start.
  const phases = ['after-reservation', 'after-source', 'after-inbox', 'after-metadata', 'after-temporary', 'after-prepared-save', 'after-publication', 'after-consumption', 'after-retirement']
  for (const route of ['P', 'O']) for (const phase of phases.filter(phase => route === 'P' || phase !== 'after-inbox')) {
    interruptedInitializations.push({ route, phase })
    const root = path.join(sandbox, route + '-' + phase); await seed(root, route)
    child(root, phase)
    const savedBefore = await record(root), before = Object.values(savedBefore.initial)[0], taskId = before.taskId
    const target = paths.state('owner', taskId) + (route === 'P' ? '/Planner_Inbox' : '/Organizer_Task')
    if (phase === 'after-metadata' || phase === 'after-temporary') check(await read(root, target), undefined)
    if (phase === 'after-consumption') check(await read(root, target), undefined)
    child(root, 'resume')
    const saved = await record(root), assignments = Object.values(saved.initial)
    check(assignments.length, 1)
    check(assignments[0].taskId, taskId)
    check(assignments[0].initialSignal, undefined)
    check(taskIdentity(await read(root, 'tasks/example_' + route + '.md')), taskId)
    const task = JSON.parse(await read(root, paths.task(taskId)))
    for (const change of taskInitializationFiles(task))
      check(await read(root, change.path), route === 'P' && change.path === paths.inbox(taskId, 'owner') ? body : change.content)
    check(await read(root, target), phase === 'after-consumption' ? undefined : '')
    check((await fs.readdir(path.join(root, 'files', 'tasks'))).filter(name => name.endsWith('.json')), [taskId + '.json'])
    check((await fs.readdir(path.join(root, 'files', 'state', 'owner', taskId))).some(name => name.startsWith('.initial-signal-')), false)
  }
  // Existing metadata without an accepted pending initial assignment cannot
  // justify empty template reconstruction or a repeated initial signal.
  {
    const root = path.join(sandbox, 'known-metadata'); await seed(root, 'P', 'Task ID: ' + id + '\n' + body)
    const h = await harness(root)
    try {
      const task = { version: 1, taskId: id, route: 'P', sourcePath: 'tasks/example_P.md', owner: 'owner', status: 'running', archiveFolder: id, members: ['owner'] }
      await h.files.replace(paths.task(id), JSON.stringify(task))
      await h.start(); await h.loop.poll()
      check(await read(root, paths.state('owner', id) + '/Planner_Inbox'), undefined)
      for (const change of taskInitializationFiles(task)) check(await read(root, change.path), undefined)
      check(h.events.length, 0)
      check(h.errors.length, 0)
    } finally { await h.close() }
  }
  // Do not infer absence means published before the prepared fact was saved.
  {
    const root = path.join(sandbox, 'unprepared-missing-temp'); await seed(root, 'P'); child(root, 'after-temporary')
    const assignment = Object.values((await record(root)).initial)[0]
    check(assignment.initialSignal.prepared, undefined)
    await fs.unlink(path.join(root, 'files', assignment.initialSignal.temporary))
    child(root, 'resume')
    check(await read(root, paths.state('owner', assignment.taskId) + '/Planner_Inbox'), '')
  }
  // One blocked Task cannot hold another source's physical preparation.
  {
    const root = path.join(sandbox, 'independent'); await seed(root, 'P')
    const h = await harness(root); await h.files.replace('tasks/other_O.md', 'Other independent task')
    const create = h.files.createIfAbsent.bind(h.files)
    let release, entered; const gate = new Promise(resolve => { release = resolve }), blocked = new Promise(resolve => { entered = resolve })
    h.files.createIfAbsent = async (logical, content) => { if (logical.endsWith('/Plan.md')) { entered(); await gate }; return create(logical, content) }
    try {
      await h.loop.start(); await blocked
      let otherId
      for (let count = 0; count < 100; count++) {
        otherId = taskIdentity(await read(root, 'tasks/other_O.md') ?? '')
        if (otherId && await read(root, paths.state('owner', otherId) + '/Organizer_Task') === '') break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      check(await read(root, paths.state('owner', otherId) + '/Organizer_Task'), '')
      release(); await h.loop.firstPoll
      check(h.errors.length, 0)
    } finally { release(); await h.close() }
  }
  // Failed acknowledgements in the SAME process retain the same assignment,
  // including an already-renamed and consumed signal. Only the failed action
  // is retried; a source content edit is never rejected by a version lock.
  for (const seam of ['reserve-save', 'prepared-save', 'rename-after-consumption', 'retirement-save']) {
    const root = path.join(sandbox, 'failure-' + seam); await seed(root, 'P')
    const h = await harness(root), save = h.storage.set.bind(h.storage), rename = h.files.rename.bind(h.files)
    let failed = false
    h.storage.set = async (selected, value) => {
      const assignment = Object.values(value.initial)[0]
      const match = seam === 'reserve-save' && assignment?.initialSignal && !assignment.initialSignal.prepared
        || seam === 'prepared-save' && assignment?.initialSignal?.prepared
        || seam === 'retirement-save' && assignment && !assignment.initialSignal
      if (!failed && match) { failed = true; throw new Error('Injected ' + seam) }
      return save(selected, value)
    }
    h.files.rename = async (from, to) => {
      const result = await rename(from, to)
      if (!failed && seam === 'rename-after-consumption') { failed = true; await h.files.delete(to); throw new Error('Injected ' + seam) }
      return result
    }
    try {
      await rejects(() => h.start(), /Injected/)
      const assignment = Object.values(h.loop.record.initial)[0], taskId = assignment.taskId
      const target = paths.state('owner', taskId) + '/Planner_Inbox'
      if (seam === 'retirement-save') await h.files.delete(target)
      if (seam === 'reserve-save' || seam === 'prepared-save') check(await read(root, target), undefined)
      await h.loop.poll()
      check(Object.values((await record(root)).initial).map(value => value.taskId), [taskId])
      check(taskIdentity(await read(root, 'tasks/example_P.md')), taskId)
      check(await read(root, target), seam === 'rename-after-consumption' || seam === 'retirement-save' ? undefined : '')
      check(Object.values((await record(root)).initial)[0].initialSignal, undefined)
    } finally { await h.close() }
  }
  {
    const root = path.join(sandbox, 'latest-source'); await seed(root, 'P')
    const h = await harness(root), save = h.storage.set.bind(h.storage)
    let edited = false
    h.storage.set = async (selected, value) => {
      await save(selected, value)
      if (!edited) { edited = true; await h.files.replace('tasks/example_P.md', 'Latest authored requirement\n') }
    }
    try {
      await h.start()
      const taskId = Object.values((await record(root)).initial)[0].taskId
      check(await read(root, 'tasks/example_P.md'), 'Task ID: ' + taskId + '\nLatest authored requirement\n')
      check(await read(root, paths.inbox(taskId, 'owner')), 'Latest authored requirement\n')
      check(h.errors.length, 0)
    } finally { await h.close() }
  }
  // The top-level initializer does not turn independent children into entries.
  {
    const root = path.join(sandbox, 'invalid-source'), h = await harness(root), view = await h.files.snapshot()
    try { await rejects(() => preparePhysicalTask(h.files, view, 'task-runs/parent/child_P.md', { taskId: id, owner: 'owner', members: [] }), /New tasks use/) }
    finally { await view.release(); await h.close() }
  }
  console.log(JSON.stringify({ ok: true, assertions, processInterruptionSeams: interruptedInitializations, healthyPollChecks, scope: 'Real physical Host first initialization, accepted interruption continuation and normal discovery without template reconstruction; independent source preparation; Linux controlled StoragePort with unrelated imports stubbed', sourceHashes: Object.fromEntries([...loaded].filter(([name]) => ['framework/task-files.ts', 'framework/host-loop.ts', 'framework/physical-local-files.ts', 'framework/local-record-files.ts'].includes(name))) }, null, 2))
} finally {
  hooks.deregister()
  await fs.rm(sandbox, { recursive: true, force: true })
}
