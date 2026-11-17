import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

// Entire production Service, one-time Agent/tool, ClientController, status UI
// component and download transport run. Native SDK/model and React DOM are
// explicit controlled ports. This is not native DSH/Windows/UI acceptance.
const root = new URL('../src/', import.meta.url), loaded = new Map(), baseline = process.argv.includes('--baseline'), asyncBaseline = process.argv.includes('--async-view-baseline'), probes = process.argv.includes('--pending-probes'), probeBaseline = process.argv.includes('--pending-probes-baseline')
let taskPrefixScans = 0, sourceReadTransactions = 0
const exactTaskReads = new Map()
const originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql)
  if (sql.includes('WHERE path >= ? COLLATE BINARY')) {
    const iterate = statement.iterate.bind(statement)
    statement.iterate = (...args) => { if (args[0] === 'tasks/') taskPrefixScans++; return iterate(...args) }
  }
  if (sql.includes('WHERE path = ? COLLATE BINARY LIMIT 2')) {
    const all = statement.all.bind(statement)
    statement.all = (...args) => { const task = /^tasks\/([^/]+)\.json$/.exec(args[0]); if (task) exactTaskReads.set(task[1], (exactTaskReads.get(task[1]) ?? 0) + 1); return all(...args) }
  }
  return statement
}
DatabaseSync.prototype.exec = function (sql) { if (/\bBEGIN\b/.test(sql)) sourceReadTransactions++; return originalExec.call(this, sql) }

const hash = value => createHash('sha256').update(value).digest('hex'), data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const hooks = registerHooks({
  resolve(s, c, next) {
    if (s === 'zod') return { url: data(`const z=new Proxy(function(){},{get(t,k){if(k==='parse')return v=>v;return z},apply(){return z}});export {z}`), shortCircuit: true }
    if (s === 'mdast-util-from-markdown') return { url: data('export function fromMarkdown(){return {type:"root",children:[]}}'), shortCircuit: true }
    if (s === 'yaml') return { url: data('export function parse(){throw Error("YAML outside this check")};export function stringify(){throw Error("YAML outside this check")}'), shortCircuit: true }
    if (baseline && s === './local-files.js') return { url: data('export class LocalFiles {}'), shortCircuit: true }
    if (s === 'react') return { url: data('export function createElement(type,props,...children){return {type,props:{...props,children}}}'), shortCircuit: true }
    if (s === 'koffi') return { url: new URL('./helpers/fixture-no-replace-koffi.mjs', import.meta.url).href, shortCircuit: true }
    if (s.startsWith('@deepseek-ai/')) {
      const source = stripTypeScriptTypes(readFileSync(new URL(c.parentURL), 'utf8'), { mode: 'transform' })
      const names = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].filter(m => m[2] === s).flatMap(m => m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]))
      return { url: data(names.map(name => `export const ${name}=${/Error$/.test(name) ? 'class extends Error {}' : '(...args)=>args[0]'};`).join('\n')), shortCircuit: true }
    }
    if (s.startsWith('.') && c.parentURL?.startsWith(root.href) && s.endsWith('.js')) {
      const url = new URL(s.slice(0, -3) + '.ts', c.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(s, c)
  },
  load(url, c, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      const frozen = new URL('../review/task-upgrade-visibility/before/service.ts', new URL('../', root))
      const sourceFile = probeBaseline && url.endsWith('/framework/service.ts') ? new URL('../review/task-upgrade-pending-probes/before/service.ts', new URL('../', root)) : (baseline || asyncBaseline) && url.endsWith('/framework/service.ts') ? asyncBaseline ? new URL('../review/task-upgrade-async-view/before/service.ts', new URL('../', root)) : frozen : new URL(url)
      let source = readFileSync(sourceFile, 'utf8')
      loaded.set(url.slice(root.href.length), hash(source))
      if (url.endsWith('/adapters/dsh/agents.ts')) source = 'export class DshAgentGateway {constructor(){return globalThis.__dssUpgradeGateway}}\n' + source.slice(source.indexOf('export function installExecutionGuard'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, c)
  },
})
const { FrameworkService } = await import('../src/framework/service.ts')
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { FrameworkClientController } = await import('../src/framework/client-contracts.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { ExecutionControls } = await import('../src/framework/execution-control.ts')
const { LocalUpgradeStatus, OriginalTaskReadStatus } = await import('../src/framework/client-upgrade-status.ts')
const { installFrameworkTransport } = await import('../src/framework/transport.ts')
const { taskArchiveHostKey } = await import('../src/framework/task-archive.ts')
const { paths, preparePhysicalTask } = await import('../src/framework/task-files.ts')
const { localTaskUpgradeKey } = await import('../src/framework/local-upgrade-task.ts')
const { localUpgradeResultKey } = await import('../src/framework/local-upgrade-completion.ts')
const { localUpgradeAgentKey } = await import('../src/framework/local-startup-upgrade-agent.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const id = 'old-task', other = '91000000-0000-4000-8000-000000000003', scope = 'actual-scope', instance = 'actual-instance', hostKey = taskArchiveHostKey(undefined, scope, instance)
const json = value => JSON.stringify(value, null, 2) + '\n', names = [], check = (name, a, b) => { assert.deepEqual(a, b, name); names.push(name) }
const rejects = async (name, operation, pattern) => { await assert.rejects(operation, pattern); names.push(name) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms)), until = async test => { for (let i = 0; i < 200; i++) { if (test()) return; await wait(5) }; throw Error('Controlled condition did not settle') }
class Records {
  constructor(root) { this.files = new LocalRecordFiles(path.join(root, 'host-records')); this.writes = 0 }
  async get(key) { const bytes = await this.files.read(hash(key) + '.json'); await this.afterRead?.(key); return bytes === undefined ? undefined : JSON.parse(bytes) }
  async set(key, value) { this.writes++; await this.files.replace(hash(key) + '.json', json(value)); await this.afterSave?.(key, value) }
  async delete(key) { await this.files.delete(hash(key) + '.json') }
  async list() { throw Error('No global metadata scan is part of the task/status view') }
}
class Gateway {
  creates = 0
  live = new Set()
  async exists() { return false }
  hasLiveOwner(id) { return this.live.has(id) }
  async create(request) {
    this.creates++; this.live.add(request.sessionId)
    const agent = {}, registrations = [], effects = [], scope = { systemPrompt: { section() {} }, tools: { register: value => registrations.push(value) }, effect: fn => effects.push(fn()), on: () => () => {} }
    await request.setup(scope, agent)
    const signal = new AbortController().signal
    this.call = (action, values = {}) => registrations[0].execute({ action, ...values }, { agent, signal })
    let release; const idle = new Promise(resolve => { release = resolve }); this.finish = release
    return { send: async () => {}, whenIdle: () => idle, observe: () => ({ state: 'idle', jobs: [] }), cancel: async () => release(), dispose: async () => { this.live.delete(request.sessionId); for (const effect of effects) await effect?.() } }
  }
}
async function seed(root, terminal = false) {
  const directory = path.join(root, 'files'); await fs.mkdir(directory, { recursive: true })
  const task = { version: 1, taskId: id, route: 'P', sourcePath: 'tasks/original_P.md', owner: 'owner', members: ['owner'], status: terminal ? 'complete' : 'running', lifecycleId: 'original-life', resultPaths: ['archives/old-task/report.md', 'archives/old-task/raw.bin'], custom: 'keep exact user content' }
  const db = new DatabaseSync(path.join(directory, 'dss-files.sqlite'))
  db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE future_table(value TEXT)')
  const put = (p, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : json(value)); db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p, '', 'actual-fixture-version', bytes.length, bytes) }
  put(paths.task(id), task); put(task.sourcePath, 'Original requirement'); put('task-runs/old-task/owner/Planner_Memory.md', 'original working notes')
  put(paths.memberStatus(id, 'owner'), { state: 'running' }); put('state/owner/old-task/Planner_Inbox', '')
  put(task.resultPaths[0], '\uFEFFOriginal result\r\n'); put(task.resultPaths[1], Buffer.from([0xff, 0, 1, 128]))
  put('unknown/source-only.txt', 'unknown content must remain unchanged')
  if (terminal) put('archives/old-task/state.json', { version: 1, taskId: id, lifecycles: { 'original-life': { hosts: { [hostKey]: { released: true } }, cleanup: { phase: 'released' } } } })
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('unresolved-host-original', 'preserve'); db.close()
  return { directory, task }
}
async function harness(root, { native = true } = {}) {
  const files = new PhysicalLocalFiles(path.join(root, 'files')), records = new Records(root), gateway = new Gateway()
  globalThis.__dssUpgradeGateway = gateway
  const settings = { name: 'DSS', userName: 'owner', localDirectory: files.directory, ownerRepo: '', repositoryDirectory: '', collaborationId: 'chat', workerSeats: 1, workspace: root }
  const ctx = { logger: () => ({ error() {}, warn() {} }) }, service = new FrameworkService(ctx, records, settings)
  service.saved.set('local', { revision: 'settings-v1', settings })
  const connection = { files, scope, identity: { instanceUUID: instance, login: 'owner', owner: 'owner', repositoryId: 'local' }, records, sharedRecords: records, transactions: { run() { throw Error('Physical controls must not use SQL/Git transactions') } }, cancelPending() {}, close: () => files.close(), registration: { member: 'owner', instanceUUID: instance, workerSeats: 1, primary: true } }
  const access = { connection, conversation: { indexPath: 'conversation-index/local/chat/index.json', scope: { mode: 'local' } }, commandHostKey: hostKey }
  service.accesses.set('local', Promise.resolve(access))
  const controls = new ExecutionControls(records, scope, undefined, files, records, instance)
  service.running.set('local', { connection, resources: [], runtime: { controls, localWakeAdmissions: new Map(),
    taskControlPublished: FrameworkRoleRuntime.prototype.taskControlPublished, executionViews: () => [],
    resumeImportedTask() {}, async requestSafetyRepair() {}, taskStateViewBoundary: () => ({ owner: 'runtime', generation: 1 }) } })
  // The independent current Task uses the real Host preparation entry, not metadata-only seeding.
  await files.createIfAbsent('tasks/independent_P.md', 'Independent requirement')
  await withSnapshot(files, snapshot => preparePhysicalTask(files, snapshot, 'tasks/independent_P.md', { taskId: other, owner: 'owner', members: ['owner'] }))
  if (native) { service.startLocalUpgrade(connection, root, settings); await until(() => gateway.call) }
  // Existing content assertions await the owned read explicitly. Nonblocking
  // first-paint assertions below call production Service.view directly.
  const view = async (input = {}) => {
    const result = await service.view({ mode: 'local', panelsOnly: true, ...input })
    if (result.originalTaskRead !== 'loading') return result
    await access.originalTasks.viewRead?.catch(() => {})
    return service.view({ mode: 'local', panelsOnly: true, ...input, refreshOriginalTasks: false })
  }
  const control = (taskId, commandId = taskId + '-pause') => service.taskControl({ mode: 'local', storageScope: scope, taskId, commandId, ...(taskId === id ? { lifecycleId: 'original-life' } : {}), intent: 'paused' })
  return { service, records, files, gateway, connection, access, controls, view, control, async close() { if (gateway.finish) { gateway.finish(); await service.localUpgrades.get(files.directory)?.work }; await access.originalTasks?.close(); await files.close() } }
}
const scratch = process.argv[2] === '--interrupt' ? process.argv[3] : await fs.mkdtemp(path.join(os.tmpdir(), 'dss-task-visible-'))
if (process.argv[2] === '--interrupt') {
  const h = await harness(scratch), phase = process.argv[4]
  h.records.afterSave = async (_key, value) => {
    if (value.kind === 'dss-once-task-layout' && !value.materialsRestored && value.files.some(file => file.path === (phase === 'metadata' ? paths.task(id) : 'task-runs/old-task/owner/Planner_Memory.md') && file.status === 'published')) process.exit(79)
  }
  await h.control(id); throw Error('Cold exit boundary not reached')
}
try {
  if (probes || probeBaseline) {
    const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
    const root = path.join(scratch, 'host-probes'), original = await seed(root), h = await harness(root)
    // Reproduce the partially published Task boundary before its material
    // restoration is complete. Other physical Tasks stay usable.
    await h.files.createIfAbsent(paths.task(id), json({ ...original.task, archiveFolder: id }))
    await h.files.replace('tasks/independent_P.md', 'Task ID: ' + other + '\nIndependent requirement')
    const discoveries = [], errors = []
    const loop = new FrameworkHostLoop(h.files, h.connection.transactions, h.records, { scope, member: 'owner', primary: true, instanceUUID: instance }, () => ['owner'], {
      startup: async () => {}, observe: async () => {}, executing: () => false, error: error => errors.push(error), clean: async () => false, releaseTask: async () => {}, sealBusiness: async () => {},
      discoverTask: async task => { if (!await h.service.beforeLocalTaskDiscovery(h.connection, task)) return false; discoveries.push(task.taskId) },
      initializeWorkspace: async () => {}, wake: async () => true,
    })
    const start = exactTaskReads.get(id) ?? 0
    for (let i = 0; i < 4; i++) await loop.poll()
    check(probeBaseline ? 'Frozen Service reopens old Task SQL on every actual Host discovery round' : 'Four actual Host discovery rounds share one old Task source check', (exactTaskReads.get(id) ?? 0) - start, probeBaseline ? 4 : 1)
    check('Pending original Task stays excluded while unrelated physical Task is discovered', [discoveries.includes(id), discoveries.includes(other), errors.map(e => e.message)], [false, true, []])
    await loop.stop()
    if (probeBaseline) { await h.close(); console.log(JSON.stringify({ status: 'reproduced', assertions: names.length, names, sourceHashes: Object.fromEntries(loaded) }, null, 2)); process.exit(0) }
    const owner = h.service.localUpgrades.get(h.files.directory), retained = owner.taskChecks.get(id)
    check('The existing upgrade owner retains the actual pending result', await retained, false)
    await h.service.view({ mode: 'local', panelsOnly: true, refreshOriginalTasks: true }); await h.access.originalTasks.viewRead
    check('Explicit Refresh invalidates only pending readiness probes', [owner.taskChecks.has(id), owner.independentTasks.has(other)], [false, true])
    const refreshed = exactTaskReads.get(id) ?? 0
    check('Explicit refresh permits a new exact original check', await h.service.beforeLocalTaskUse(h.connection, id), false)
    check('Refreshed pending answer is reused without another SQL open', await h.service.beforeLocalTaskUse(h.connection, id), false)
    check('Exactly one source check follows explicit Refresh', (exactTaskReads.get(id) ?? 0) - refreshed, 1)
    h.gateway.finish(); await owner.work
    check('Actual source assessment result releases previously cached pending answers', owner.taskChecks.has(id), false)
    await h.service.beforeLocalTaskUse(h.connection, id)
    check('An unchanged pending source assessment does not mark the Task independent', owner.independentTasks.has(id), false)
    await h.close()

    const concurrentRoot = path.join(scratch, 'concurrent-probes'), concurrentSeed = await seed(concurrentRoot), c = await harness(concurrentRoot)
    const sourceBefore = hash(await fs.readFile(path.join(concurrentSeed.directory, 'dss-files.sqlite'))), co = c.service.localUpgrades.get(c.files.directory)
    let held = false, release; const pause = new Promise(resolve => { release = resolve })
    c.records.afterRead = async key => { if (!held && key === localTaskUpgradeKey(c.files.directory, id)) { held = true; await pause } }
    const before = exactTaskReads.get(id) ?? 0, requests = Promise.all(Array.from({ length: 8 }, () => c.service.beforeLocalTaskUse(c.connection, id)))
    await until(() => held)
    await c.control(other, 'unrelated-during-probe')
    check('Unrelated control completes while the original Task readiness read is held', co.independentTasks.has(other), true)
    release(); check('Eight concurrent exact checks share the same pending outcome', await requests, Array(8).fill(false))
    check('Concurrent checks open original Task SQL once', (exactTaskReads.get(id) ?? 0) - before, 1)
    c.records.afterRead = undefined
    let restoreHeld = false, releaseRestore; const restorePause = new Promise(resolve => { releaseRestore = resolve })
    c.records.afterSave = async (_key, value) => { if (!restoreHeld && value.kind === 'dss-once-task-layout') { restoreHeld = true; await restorePause } }
    const restoration = co.agent.restoreTask(id, co.controller.signal)
    await until(() => restoreHeld)
    check('Actual restoration start invalidates its Task pending answer', co.taskChecks.has(id), false)
    const liveReads = exactTaskReads.get(id) ?? 0
    check('Runtime non-wait probes reuse actual Task restoration without waiting', await Promise.all(Array.from({ length: 8 }, () => c.service.beforeLocalTaskUse(c.connection, id, false))), Array(8).fill(false))
    check('Live restoration probes do not reopen original SQL', exactTaskReads.get(id) ?? 0, liveReads)
    let selectedDone = false
    const selected = c.control(id, 'selected-during-restoration').then(result => { selectedDone = true; return result })
    await c.control(other, 'independent-during-restoration')
    check('Only the selected Task waits for its own shared restoration', selectedDone, false)
    releaseRestore(); check('Actual one-time Task restoration completes', (await restoration).status, 'complete'); await selected
    check('Shared restoration releases live owner and pending answer', [co.tasks.has(id), co.taskChecks.has(id), co.independentTasks.has(id)], [false, false, true])
    const doneReads = exactTaskReads.get(id) ?? 0
    check('Completed Task bypasses source checks on both runtime paths', await Promise.all([c.service.beforeLocalTaskUse(c.connection, id), c.service.beforeLocalTaskUse(c.connection, id, false)]), [true, true])
    check('Completed Task never opens retained original SQL', exactTaskReads.get(id) ?? 0, doneReads)
    check('Per-Task probes never start another native upgrade Agent', c.gateway.creates, 1)
    check('Probe, control and restoration preserve original SQLite bytes', hash(await fs.readFile(path.join(concurrentSeed.directory, 'dss-files.sqlite'))), sourceBefore)
    await c.close()

    const retryRoot = path.join(scratch, 'pending-retry'), retrySeed = await seed(retryRoot), r = await harness(retryRoot), ro = r.service.localUpgrades.get(r.files.directory)
    let failed = false
    r.records.afterRead = async key => { if (!failed && key === localTaskUpgradeKey(r.files.directory, id)) { failed = true; throw Error('controlled original readiness read failure') } }
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => r.service.beforeLocalTaskUse(r.connection, id)))
    check('Concurrent actual readiness failure reaches all callers', outcomes.every(item => item.status === 'rejected' && /controlled original/.test(item.reason.message)), true)
    check('Read failure is neither cached as completion nor a permanent rejected check', [ro.taskChecks.has(id), ro.independentTasks.has(id)], [false, false])
    check('A failed check can retry exact original SQL', await r.service.beforeLocalTaskUse(r.connection, id), false)
    let interrupted = false
    r.records.afterSave = async (_key, value) => { if (!interrupted && value.kind === 'dss-once-task-layout') { interrupted = true; throw Error('controlled restoration interruption') } }
    await rejects('Actual restoration interruption is surfaced', () => ro.agent.restoreTask(id, ro.controller.signal), /controlled restoration interruption/)
    check('Interrupted restoration releases cached pending state without marking complete', [ro.taskChecks.has(id), ro.independentTasks.has(id)], [false, false])
    check('After interruption exact pending status can be re-read', await r.service.beforeLocalTaskUse(r.connection, id), false)
    r.records.afterSave = undefined
    await r.files.createIfAbsent(retrySeed.task.resultPaths[0], 'user physical result wins')
    check('Actual physical conflict keeps restoration incomplete', (await ro.agent.restoreTask(id, ro.controller.signal)).status, 'incomplete')
    check('Incomplete restoration invalidates only its own pending check', [ro.taskChecks.has(id), ro.independentTasks.has(id)], [false, false])
    const incompleteReads = exactTaskReads.get(id) ?? 0
    check('Incomplete restoration remains pending on repeated checks', await Promise.all(Array.from({ length: 4 }, () => r.service.beforeLocalTaskUse(r.connection, id))), Array(4).fill(false))
    check('Incomplete result is read once, then reused', (exactTaskReads.get(id) ?? 0) - incompleteReads, 1)
    // Remove only this test-created conflicting physical output, not any source.
    await fs.unlink(path.join(r.files.directory, retrySeed.task.resultPaths[0]))
    check('Explicit retry resumes and completes the same original Task', (await ro.agent.restoreTask(id, ro.controller.signal)).status, 'complete')
    check('Successful retry retires the pending check', [await r.service.beforeLocalTaskUse(r.connection, id, false), ro.taskChecks.has(id)], [true, false])
    await r.close()
    const damagedRoot = path.join(scratch, 'probe-sql-retry'), damagedSeed = await seed(damagedRoot), d = await harness(damagedRoot), originalSql = await fs.readFile(path.join(damagedSeed.directory, 'dss-files.sqlite')), dOwner = d.service.localUpgrades.get(d.files.directory)
    // Deliberately damage only this disposable source fixture, then put its exact
    // bytes back to verify a failed actual SQLite read is not permanent readiness.
    await fs.writeFile(path.join(damagedSeed.directory, 'dss-files.sqlite'), 'controlled invalid SQLite fixture')
    await rejects('An actual SQLite readiness failure is surfaced', () => d.service.beforeLocalTaskUse(d.connection, id), /SQLite could not read/)
    check('Actual SQLite read failure grants no independent Task or stale failed check', [dOwner.independentTasks.has(id), dOwner.taskChecks.has(id)], [false, false])
    await fs.writeFile(path.join(damagedSeed.directory, 'dss-files.sqlite'), originalSql)
    check('A recovered actual source is checked again and remains pending', await d.service.beforeLocalTaskUse(d.connection, id), false)
    await d.close()
    console.log(JSON.stringify({ status: 'passed', assertions: names.length, names, limits: 'Whole production Service, actual Host.poll and native-upgrade tool owner with real SQLite/physical IO. Model/native SDK/Koffi are controlled ports; no native DSH, Windows, browser DOM or full tsc claim.', sourceHashes: Object.fromEntries([...loaded].sort()), scriptHash: hash(readFileSync(fileURLToPath(import.meta.url))) }, null, 2)); process.exit(0)
  }
  if (asyncBaseline) {
    await seed(scratch); const selected = await harness(scratch, { native: false })
    let release, held = false; const pause = new Promise(resolve => { release = resolve })
    selected.records.afterRead = async key => { if (!held && key === localTaskUpgradeKey(selected.files.directory, id)) { held = true; await pause } }
    const oldView = selected.service.view({ mode: 'local', panelsOnly: true })
    await until(() => held)
    const returned = await Promise.race([oldView.then(() => true), wait(100).then(() => false)])
    check('Frozen 484-check Service keeps physical Task panels waiting on original SQL enumeration', returned, false)
    release(); await oldView
    const page = readFileSync(new URL('../review/task-upgrade-async-view/before/client-page.tsx', new URL('../', root)), 'utf8')
    check('Frozen page has both unconditional Local upgrade status surfaces', (page.match(/view\?\.activeMode === 'local' && <LocalUpgradeStatus/g) ?? []).length, 2)
    await selected.close(); console.log(JSON.stringify({ status: 'reproduced', assertions: names.length, names, sourceHashes: Object.fromEntries(loaded) }, null, 2)); process.exit(0)
  }
  if (!baseline) {
    const cacheRoot = path.join(scratch, 'cache'), cacheSeed = await seed(cacheRoot), c = await harness(cacheRoot, { native: false })
    let release, held = false; const pause = new Promise(resolve => { release = resolve })
    c.records.afterRead = async key => { if (key === localTaskUpgradeKey(c.files.directory, id) && !held) { held = true; await pause } }
    let notifications = 0
    const off = c.service.subscribeChanged(() => { notifications++ })
    const scans = taskPrefixScans, readers = Promise.all(Array.from({ length: 6 }, () => c.service.view({ mode: 'local', panelsOnly: true })))
    await until(() => held)
    check('Concurrent view readers share the same real SQL Task-prefix enumeration', taskPrefixScans - scans, 1)
    await c.control(other, 'during-original-view')
    check('Independent control completes while original read remains in flight', c.access.originalTasks.pending !== undefined, true)
    const views = await Promise.race([readers, wait(1000).then(() => { throw Error('Physical Task panels waited for the held original SQL read') })])
    check('Six real first views return converted tasks while original SQL remains held', views.every(view => view.tasks.some(task => task.taskId === other) && view.originalTaskRead === 'loading'), true)
    check('First views explicitly report old records loading without claiming an empty task list', views.every(view => !view.tasks.some(task => task.taskId === id)), true)
    const liveClient = new FrameworkClientController({ view: (input, signal) => c.service.view({ ...input, panelsOnly: true }, signal), history: async () => ({ messages: [], revision: 'empty', order: [], storageScope: scope }), subscribeChanged: listener => c.service.subscribeChanged(listener) })
    const disconnectClient = liveClient.retainConnection()
    await liveClient.refresh()
    check('Actual ClientController first paint keeps physical tasks and loading status', liveClient.snapshot().value.tasks.some(task => task.taskId === other) && liveClient.snapshot().value.originalTaskRead === 'loading', true)
    release()
    await until(() => liveClient.snapshot().value?.tasks.some(task => task.taskId === id))
    check('Existing changed event refreshes client when source rows become available', liveClient.snapshot().value.originalTaskRead, undefined)
    check('One shared original read emits one readiness invalidation', notifications, 1)
    disconnectClient(); off()
    for (let i = 0; i < 6; i++) await c.view()
    check('Routine panel refreshes reuse original source projection without rescanning', taskPrefixScans - scans, 1)
    const sourceDb = new DatabaseSync(path.join(cacheSeed.directory, 'dss-files.sqlite'))
    const changedTask = Buffer.from(json({ ...cacheSeed.task, sourcePath: 'tasks/changed_by_user_P.md' }))
    sourceDb.prepare('UPDATE files SET binary=?,bytes=? WHERE path=?').run(changedTask, changedTask.length, paths.task(id)); sourceDb.close()
    check('Routine notifications do not repeatedly reread unchanged source ownership', (await c.view()).tasks.find(task => task.taskId === id).title, 'original_P.md')
    const explicit = await c.view({ refreshOriginalTasks: true })
    check('Explicit original refresh reads the actual updated source identity', explicit.tasks.find(task => task.taskId === id).title, 'changed_by_user_P.md')
    check('One explicit refresh adds exactly one source enumeration', taskPrefixScans - scans, 2)
    // Restore this controlled fixture's original source identity before conversion.
    const restoreDb = new DatabaseSync(path.join(cacheSeed.directory, 'dss-files.sqlite')), oldTask = Buffer.from(json(cacheSeed.task))
    restoreDb.prepare('UPDATE files SET binary=?,bytes=? WHERE path=?').run(oldTask, oldTask.length, paths.task(id)); restoreDb.close()
    c.service.startLocalUpgrade(c.connection, cacheRoot, explicit.settings); await until(() => c.gateway.call)
    const beforeRestore = taskPrefixScans; await c.control(id, 'cache-control'); await wait(0)
    const beforeCompletedView = sourceReadTransactions
    check('Actual task completion invalidates only its exact source row', (await c.view()).tasks.find(task => task.taskId === id).originalSource, undefined)
    check('Task conversion completion does not rescan unrelated original Tasks', taskPrefixScans, beforeRestore)
    check('A restored Task view retires without even reopening its SQL source', sourceReadTransactions, beforeCompletedView)
    c.gateway.finish(); await c.service.localUpgrades.get(c.files.directory).work; await wait(0)
    await c.view(); await c.view()
    check('Existing whole-upgrade result change invalidates the source view once', taskPrefixScans, beforeRestore + 1)
    const apiRequests = [], cc = new FrameworkClientController({ view: (input, signal) => { apiRequests.push(input); return c.service.view({ ...input, panelsOnly: true }, signal) }, history: async () => ({ messages: [], revision: 'empty', order: [], storageScope: scope }) })
    await cc.refresh(); await cc.refresh(false, false, true)
    check('Actual client explicit-refresh input reaches the real Service once', apiRequests.filter(input => input.refreshOriginalTasks).length, 1)
    await c.access.originalTasks.close()
    await rejects('Closing storage releases its original-read lifetime', () => c.access.originalTasks.read(), /closed/)
    await c.close()
  }
  if (!baseline) for (const action of ['abort-view', 'abort-failed-view', 'close-access', 'replace-access']) {
    const root = path.join(scratch, action); await seed(root); const selected = await harness(root, { native: false })
    let release, held = false; const pause = new Promise(resolve => { release = resolve }), controller = new AbortController()
    selected.records.afterRead = async key => { if (!held && key === localTaskUpgradeKey(selected.files.directory, id)) { held = true; await pause; if (action === 'abort-failed-view') throw Error('Original read failed after its viewer cancelled') } }
    let changes = 0; const unsubscribe = selected.service.subscribeChanged(() => { changes++ })
    const firstRead = selected.service.view({ mode: 'local', panelsOnly: true }, controller.signal)
    await until(() => held); const firstView = await firstRead
    check(action + ': physical first paint never waits for source completion', firstView.tasks.some(task => task.taskId === other) && firstView.originalTaskRead === 'loading', true)
    let closing
    if (action.startsWith('abort-')) controller.abort()
    if (action === 'close-access') closing = selected.service.closeAccess(selected.access)
    if (action === 'replace-access') selected.service.accesses.set('local', Promise.resolve({ replacement: true }))
    release(); await selected.access.originalTasks.viewRead?.catch(() => {}); await closing
    check(action + ': completed old source read emits no late change', changes, 0)
    if (action === 'abort-view') check('A cancelled view cannot discard successfully read original data', (await selected.view()).tasks.some(task => task.taskId === id), true)
    unsubscribe(); await selected.close()
  }
  const original = await seed(scratch), before = hash(await fs.readFile(path.join(original.directory, 'dss-files.sqlite')))
  const h = await harness(scratch, { native: false })
  const first = await h.view()
  if (baseline) {
    check('Frozen pre-fix entire Service hides SQL-only original Task', first.tasks.some(t => t.taskId === id), false)
    await rejects('Frozen pre-fix control rejects its original Task as absent', () => h.control(id), /absent/)
    console.log(JSON.stringify({ status: 'reproduced', names, sourceHashes: Object.fromEntries(loaded) }, null, 2)); await h.close(); process.exit(0)
  }
  check('Entire Service exposes original Task before native upgrade starts', first.tasks.find(t => t.taskId === id)?.originalSource, 'local-sql')
  check('Task view keeps original lifecycle, status, member and result references', first.tasks.find(t => t.taskId === id), { taskId: id, lifecycleId: 'original-life', title: 'original_P.md', route: 'P', owner: 'owner', status: 'running', originalSource: 'local-sql', members: [{ name: 'owner', status: 'running' }], control: undefined, executions: [], resultPaths: original.task.resultPaths })
  check('Read-only view starts no Agent and writes no migration records', [h.gateway.creates, h.records.writes], [0, 0])
  await rejects('Control never starts upgrade before Host activation', () => h.control(id), /after DSS Host activation/)
  const text = await h.service.readFile({ mode: 'local', storageScope: scope, path: original.task.resultPaths[0], originalTaskId: id })
  check('Exact old result button reads original UTF-8 body', text.text, 'Original result\r\n')
  check('Exact download preserves original bytes including BOM', Buffer.from(await h.service.download('local', original.task.resultPaths[0], scope, undefined, id)).toString(), '\uFEFFOriginal result\r\n')
  await rejects('General plain-path read does not fall back to SQL', () => h.service.readFile({ mode: 'local', path: original.task.resultPaths[0] }), /does not exist/)
  h.service.accesses.set('git', Promise.resolve(h.access))
  await rejects('Git download ignores Local original Task routing', () => h.service.download('git', original.task.resultPaths[0], scope, undefined, id), /does not exist/)
  h.service.accesses.delete('git')
  await rejects('Old Task read cannot reach unrelated source path', () => h.service.readFile({ mode: 'local', path: 'unknown/source-only.txt', originalTaskId: id }), /not a recorded result/)
  const binary = await h.service.readFile({ mode: 'local', storageScope: scope, path: original.task.resultPaths[1], originalTaskId: id })
  check('Binary old result download carries exact Task identity', new URL(binary.binary.downloadUrl, 'https://native.test').searchParams.get('originalTaskId'), id)
  const routes = new Map(), effects = [], transportCtx = { inject(_names, fn) { fn({ connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return () => {} } } }, effect(fn) { effects.push(fn()) } }); return { dispose: async () => { for (const effect of effects) await effect?.() } } } }
  const disposeTransport = installFrameworkTransport(transportCtx, h.service)
  const downloaded = await routes.get('/api/deepseek-servant-framework/download')(new Request(new URL(binary.binary.downloadUrl, 'https://native.test')))
  check('Actual native download transport forwards original Task parameter', [downloaded.status, [...new Uint8Array(await downloaded.arrayBuffer())]], [200, [255, 0, 1, 128]])
  await disposeTransport()
  await h.files.createIfAbsent(original.task.resultPaths[0], 'user-edited physical result')
  check('Physical current result wins over original source', (await h.service.readFile({ mode: 'local', path: original.task.resultPaths[0], originalTaskId: id })).text, 'user-edited physical result')
  // Remove only the controlled conflict fixture before exercising restoration.
  await h.files.update(original.task.resultPaths[0], () => ({ value: undefined, content: null }))
  h.service.startLocalUpgrade(h.connection, scratch, first.settings); await until(() => h.gateway.call)
  check('Actual owner is visible during native work', (await h.view()).localUpgrade.status, 'running')
  let release, held = false, once = false; const hold = new Promise(resolve => { release = resolve })
  h.records.afterSave = async (_key, value) => { if (!once && value.kind === 'dss-once-task-layout' && value.files.some(file => file.path === paths.task(id) && file.status === 'published')) { once = true; held = true; await hold } }
  let selectedDone = false; const selected = h.control(id).then(value => { selectedDone = true; return value }); await until(() => held)
  const owner = h.service.localUpgrades.get(h.files.directory), tool = h.gateway.call('restore_task', { taskId: id })
  const unrelated = await h.control(other)
  check('Unrelated control completes while selected original waits', unrelated.submitted && !selectedDone, true)
  check('Partially published task stays visible with old result identity', (await h.view()).tasks.find(t => t.taskId === id)?.originalSource, 'local-sql')
  check('UI and native restore_task share one per-task in-flight work', owner.agent.taskRestorations.size, 1)
  release(); await selected; await tool
  check('Selected actual control writes the original lifecycle intent', (await h.controls.taskStates([original.task])).get(id).intent, 'paused')
  check('Task restore does not await global native completion', owner.result, undefined)
  check('Transient per-task operation is released', owner.agent.taskRestorations.size, 0)
  const current = (await h.view()).tasks.filter(t => t.taskId === id)
  check('One current row replaces the original source view', [current.length, current[0].originalSource, current[0].status], [1, undefined, 'running'])
  check('User custom Task properties are preserved', JSON.parse(await fs.readFile(path.join(original.directory, paths.task(id)), 'utf8')).custom, original.task.custom)
  await h.files.update(original.task.resultPaths[0], () => ({ value: undefined, content: null }))
  await rejects('Completed Task conversion never resurrects deleted physical results', () => h.service.readFile({ mode: 'local', path: original.task.resultPaths[0], originalTaskId: id }), /does not exist/)
  await h.files.update(paths.task(id), () => ({ value: undefined, content: null }))
  check('Completed Task conversion never resurrects removed identity', (await h.view()).tasks.some(t => t.taskId === id), false)
  const audit = await h.gateway.call('audit_source')
  h.gateway.finish(); const pending = await owner.work; await wait(0)
  check('Unfinished Agent result retains its actual source audit', pending.sourceAudit, audit)
  const pendingView = await h.view()
  check('Pending completion is distinct from SQL disposal', [pendingView.localUpgrade.status, pendingView.localUpgrade.sourceDisposition], ['pending', 'retained-pending-retirement-review'])
  const textTree = value => value == null ? '' : Array.isArray(value) ? value.map(textTree).join(' ') : typeof value === 'object' ? textTree(value.props.children) : String(value)
  const rendered = textTree(LocalUpgradeStatus({ value: pendingView.localUpgrade, tr: (_cn, en) => en }))
  check('Real status component exposes source bytes, metadata and other-table obligations', ['has pending work', 'has not been cleaned up', 'unresolved-host-original', 'future_table', 'unknown/source-only.txt'].every(part => rendered.includes(part)), true)
  const report = { status: 'complete', directory: original.directory, sourcePath: path.join(original.directory, 'dss-files.sqlite'), published: 1, alreadyPresent: 0, issues: [], retainedStages: [] }
  await h.records.set(localUpgradeResultKey(h.files.directory), { kind: 'dss-local-upgrade-result', directory: h.files.directory, operationId: 'verified-result-fixture', completedAt: new Date().toISOString(), report, sourceAudit: audit, sourceDisposition: 'retained-pending-retirement-review' })
  h.service.localUpgrades.clear()
  await fs.rename(path.join(original.directory, 'dss-files.sqlite'), path.join(original.directory, 'source.retained'))
  const coldView = await h.view()
  check('Cold completed view reads existing durable result without SQL', [coldView.localUpgrade.status, coldView.tasks.some(t => t.taskId === id)], ['complete', false])
  check('Completed UI still reports pending original disposal', textTree(LocalUpgradeStatus({ value: coldView.localUpgrade, tr: (_cn, en) => en })).includes('completed') && textTree(LocalUpgradeStatus({ value: coldView.localUpgrade, tr: (_cn, en) => en })).includes('has not been cleaned up'), true)
  const client = new FrameworkClientController({ view: (input, signal) => h.service.view({ ...input, panelsOnly: true }, signal), history: async () => ({ messages: [], revision: 'empty', order: [], storageScope: scope }), taskControl: input => h.service.taskControl(input) })
  await client.refresh()
  check('Actual ClientController publishes source audit/status without loss', client.snapshot().value.localUpgrade, coldView.localUpgrade)
  const pageSource = readFileSync(new URL('framework/client-page.tsx', root), 'utf8')
  check('Upgrade status has settings entry and a mutually exclusive main-page surface', (pageSource.match(/<LocalUpgradeStatus value=\{view.localUpgrade\}/g) ?? []).length === 2 && pageSource.includes("view?.activeMode === 'local' && !settingsOpen && <LocalUpgradeStatus"), true)
  check('Loading and failed originals suppress misleading empty-task text', pageSource.includes('empty && !view?.originalTaskRead'), true)
  check('Actual original-read loading component describes physical tasks remaining usable', textTree(OriginalTaskReadStatus({ status: 'loading', tr: (_cn, en) => en })).includes('Converted tasks remain available'), true)
  check('Actual original-read failure component offers the existing refresh action', textTree(OriginalTaskReadStatus({ status: 'failed', tr: (_cn, en) => en })).includes('Refresh to retry'), true)
  check('Only the original Task result button adds exact source Task identity', pageSource.includes("open(path, undefined, task.originalSource === 'local-sql' ? task.taskId : undefined)"), true)
  check('Old Task selection still uses the existing Task controls', pageSource.includes('<TaskControls key={scope + task.taskId}'), true)
  check('Original SQL bytes remain unchanged through all reads and writes', hash(await fs.readFile(path.join(original.directory, 'source.retained'))), before)
  await h.close()
  for (const phase of ['materials', 'metadata']) {
    const directory = path.join(scratch, 'cold-' + phase), original = await seed(directory)
    const sourceHash = hash(await fs.readFile(path.join(original.directory, 'dss-files.sqlite')))
    const exit = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', directory, phase], { encoding: 'utf8' })
    assert.equal(exit.status, 79, exit.stderr)
    const cold = await harness(directory)
    check('Cold ' + phase + ' retains visible original Task', (await cold.view()).tasks.some(t => t.taskId === id), true)
    await cold.control(other, 'unrelated-after-cold'); await cold.control(id, 'selected-after-cold')
    check('Cold ' + phase + ' restores original task and accepts only its control', (await cold.controls.taskStates([original.task])).get(id).intent, 'paused')
    check('Cold ' + phase + ' preserves original SQL', hash(await fs.readFile(path.join(original.directory, 'dss-files.sqlite'))), sourceHash)
    await cold.close()
  }
  const terminalRoot = path.join(scratch, 'terminal'), terminal = await seed(terminalRoot, true), t = await harness(terminalRoot)
  check('Terminal original stays completed before restoration', (await t.view()).tasks.find(task => task.taskId === id)?.status, 'complete')
  await rejects('Actual control never reopens completed original', () => t.control(id), /completed/)
  check('Proven released original projects only historical identity', (await t.view()).tasks.find(task => task.taskId === id)?.archived, true)
  check('Released Task control cannot recreate runtime metadata', existsSync(path.join(terminal.directory, paths.task(id))), false)
  await t.close()
  const clearedRoot = path.join(scratch, 'history-cleared'), clearedSeed = await seed(clearedRoot, true)
  const clearedDb = new DatabaseSync(path.join(clearedSeed.directory, 'dss-files.sqlite'))
  const clearedState = Buffer.from(json({ version: 1, taskId: id, lifecycles: { 'original-life': { hosts: { [hostKey]: { released: true } }, cleanup: { phase: 'released', historyCleared: true } } } }))
  clearedDb.prepare('UPDATE files SET binary=?,bytes=? WHERE path=?').run(clearedState, clearedState.length, 'archives/old-task/state.json'); clearedDb.close()
  const cleared = await harness(clearedRoot, { native: false }), clearedView = await cleared.view({ includeArchives: true })
  check('Explicitly cleared old Task history remains hidden', clearedView.tasks.some(task => task.taskId === id), false)
  const originalArchive = clearedView.archives.find(item => item.taskId === id)
  check('Cleared history keeps actual result membership and original Task identity', [originalArchive.originalTaskId, originalArchive.files], [id, clearedSeed.task.resultPaths])
  check('Cleared history result button still opens original result', (await cleared.service.readFile({ mode: 'local', path: originalArchive.path, originalTaskId: originalArchive.originalTaskId })).text, 'Original result\r\n')
  check('Archive result buttons pass only their exact original Task identity', pageSource.includes('open(item.path, undefined, item.originalTaskId)') && pageSource.includes('open(path, undefined, item.originalTaskId)'), true)
  await cleared.close()
  const retryRoot = path.join(scratch, 'retry-original'), retrySeed = await seed(retryRoot), retry = await harness(retryRoot)
  let injectFailure = true
  retry.records.afterSave = async (_key, value) => { if (injectFailure && value.kind === 'dss-once-task-layout') { injectFailure = false; throw Error('controlled interrupted task record write') } }
  await rejects('An actual restoration write failure rejects the selected control', () => retry.control(id, 'retry-control'), /controlled interrupted/)
  await wait(0)
  check('Failed in-flight Task owner is released for an explicit retry', retry.service.localUpgrades.get(retry.files.directory).tasks.has(id), false)
  await retry.control(id, 'retry-control')
  check('Retry resumes same original responsibility without a stale rejected Promise', (await retry.controls.taskStates([retrySeed.task])).get(id).intent, 'paused')
  await retry.close()
  const damagedRoot = path.join(scratch, 'unreadable-original'), damagedSeed = await seed(damagedRoot)
  await fs.writeFile(path.join(damagedSeed.directory, 'dss-files.sqlite'), 'controlled damaged SQL source')
  const d = await harness(damagedRoot, { native: false }), damagedView = await d.view()
  check('Unreadable original SQL cannot hide valid current physical Tasks', damagedView.tasks.some(task => task.taskId === other), true)
  check('Actual original-read failure is retained in service diagnostics', [...d.service.reportedErrors.get('local').values()].some(row => row.message.includes('SQLite could not read')), true)
  check('Unreadable original bytes are not repaired or replaced', await fs.readFile(path.join(damagedSeed.directory, 'dss-files.sqlite'), 'utf8'), 'controlled damaged SQL source')
  const failedReads = sourceReadTransactions
  await d.view(); await d.view()
  check('Ordinary failed-source refresh reuses failure instead of reopening SQL', sourceReadTransactions, failedReads)
  await d.view({ refreshOriginalTasks: true })
  check('Explicit refresh retries the actual original-source read once', sourceReadTransactions, failedReads + 1)
  await d.close()
  console.log(JSON.stringify({ status: 'passed', assertions: names.length, names, limits: 'Full production Service/Agent/ClientController/status-component/transport with real temporary SQLite and Linux physical files, two real process exits. Native SDK/model, React DOM rendering and Koffi no-replace boundary are controlled ports; no Windows/native DSH/full typecheck acceptance.', sourceHashes: Object.fromEntries([...loaded].sort()), scriptHash: hash(readFileSync(fileURLToPath(import.meta.url))) }, null, 2))
} finally { DatabaseSync.prototype.prepare = originalPrepare; DatabaseSync.prototype.exec = originalExec; hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
