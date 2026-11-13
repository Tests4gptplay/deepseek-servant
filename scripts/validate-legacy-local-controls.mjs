import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import './test-support/dsh-sdk-runtime.mjs'

const { openDshStorageFixture } = await import('./test-support/dsh-sdk-storage.mjs')
const { Context } = await import('@deepseek-ai/cordis')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { ExecutionControls, LegacyLocalControlReadError } = await import('../src/framework/execution-control.ts')
const { FrameworkService } = await import('../src/framework/service.ts')
const { paths } = await import('../src/framework/task-files.ts')
const hash = text => createHash('sha256').update(text).digest('hex')
// Frozen native JSON emitted by d19 RecordFilesBackend + ExecutionControls.setTask,
// not by this test or the current writer. d19 source archive SHA256:
// 5f0091d220fda7817c9c0c034e0f9c8b652d0b09731663780962c73bed8d6816
// Only the two scoped storage-address keys are replaced for this test's real
// canonical directories. Task/command value, signature and unit stay frozen.
const fixtureBytes = readFileSync(new URL('./fixtures/d19-local-control-native-004.json', import.meta.url))
assert.equal(hash(fixtureBytes), '055e072a51c4b3d8e1b0b050d92739e5aab9f04aa5ebdb05f19147b886f33fec')
const native = JSON.parse(fixtureBytes), captured = Object.values(native.tables.records)[0]
const taskId = '60000000-0000-4000-8000-000000000022'
assert.equal(captured.value.tasks[hash(taskId)].intent, 'cancelled')
const parentId = '70000000-0000-4000-8000-000000000022'
const otherId = '80000000-0000-4000-8000-000000000022'
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-legacy-local-control-'))
const recordRoot = path.join(scratch, 'records'), files = [], checks = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
let storage
try {
  const local = async name => {
    const directory = path.join(scratch, name)
    await fs.mkdir(directory, { recursive: true })
    const store = new PhysicalLocalFiles(directory); files.push(store)
    return { store, scope: JSON.stringify(['local', await fs.realpath(directory)]) }
  }
  const held = await local('held-local'), missing = await local('missing-local'), unmatched = await local('unmatched-local'), damaged = await local('damaged-local'), badTask = await local('bad-task-local')
  const writeOld = async scope => {
    const digest = hash(scope), key = 'framework-user-controls/' + digest
    const folder = path.join(recordRoot, 'deepseek_servant', 'other', digest.slice(0, 32) + '--' + hash(key))
    const record = { ...native, tables: { records: { [key]: { ...captured, key } } } }
    await fs.mkdir(folder, { recursive: true })
    const file = path.join(folder, 'record.json'), bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n')
    await fs.writeFile(file, bytes)
    return { file, bytes }
  }
  const oldHeld = await writeOld(held.scope), oldUnmatched = await writeOld(unmatched.scope), oldDamaged = await writeOld(damaged.scope), oldBadTask = await writeOld(badTask.scope)
  await fs.writeFile(oldDamaged.file, '{damaged native record')
  const brokenTask = JSON.parse(oldBadTask.bytes)
  Object.values(brokenTask.tables.records)[0].value.commands[hash('old-ui-cancel')].signature = 'damaged command signature'
  await fs.writeFile(oldBadTask.file, JSON.stringify(brokenTask, null, 2) + '\n')
  storage = await openDshStorageFixture(recordRoot, path.join(scratch, 'locator'))
  const controls = (entry, port = storage.adapter) => new ExecutionControls(port, entry.scope, undefined, entry.store, storage.adapter, 'test-instance')
  const heldTask = { version: 1, taskId, route: 'P', owner: 'A', members: ['A'], status: 'running', sourcePath: 'tasks/original_P.md' }
  await held.store.replace(paths.task(taskId), JSON.stringify(heldTask))
  await fs.mkdir(path.join(held.store.directory, paths.run(taskId)), { recursive: true })
  let unneededRecovery = 0
  const healthyControl = new ExecutionControls(storage.adapter, held.scope, undefined, held.store, storage.adapter, 'test-instance', () => {}, () => { unneededRecovery++ })
  check('healthy old row does not invoke Service recovery callback', await healthyControl.taskHeld(taskId), true)
  check('no prior old warning means no recovery callback', unneededRecovery, 0)
  check('frozen d19 cancelled becomes Host-local paused', (await controls(held).task(taskId)).intent, 'paused')
  await controls(held).setTask('current-resume', taskId, 'running')
  check('current physical running overrides old cancelled', await controls(held).taskHeld(taskId), false)
  check('old held record bytes unchanged after current control', await fs.readFile(oldHeld.file), oldHeld.bytes)

  const parent = { version: 1, taskId: parentId, route: 'O', owner: 'A', members: ['A'], status: 'running', sourcePath: 'tasks/parent_O.md', children: [{ taskId: otherId, member: 'B', objectiveId: 'child' }] }
  const child = { ...parent, taskId: otherId, route: 'P', owner: 'B', members: ['B'], sourcePath: 'tasks/child_P.md', children: undefined, parent: { taskId: parentId, owner: 'A', objectiveId: 'child' } }
  for (const entry of [missing, unmatched]) {
    await entry.store.replace(paths.task(parentId), JSON.stringify(parent))
    await entry.store.replace(paths.task(otherId), JSON.stringify(child))
    const baselinePort = new Proxy(storage.adapter, { get(object, property) {
      if (property === 'readLegacyLocalControls') return undefined
      const value = Reflect.get(object, property, object)
      return typeof value === 'function' ? value.bind(object) : value
    } })
    const observed = async port => {
      const reads = [], original = entry.store.readBytes.bind(entry.store)
      entry.store.readBytes = (snapshot, file) => {
        if (file === paths.task(otherId) || file === paths.task(parentId)) reads.push(file)
        return original(snapshot, file)
      }
      try { return { held: await controls(entry, port).taskHeld(otherId), reads } }
      finally { entry.store.readBytes = original }
    }
    const base = await observed(baselinePort), current = await observed(storage.adapter)
    check(entry === missing ? 'no-old-row parent-chain metadata baseline' : 'unmatched-old-row parent-chain metadata baseline', base,
      { held: false, reads: [paths.task(otherId), paths.task(parentId)] })
    check(entry === missing ? 'no-old-row adds no per-Task metadata read' : 'unmatched-old-row adds no per-Task metadata read', current, base)
  }
  check('old unmatched record bytes unchanged', await fs.readFile(oldUnmatched.file), oldUnmatched.bytes)
  await damaged.store.replace(paths.task(taskId), JSON.stringify(heldTask))
  await badTask.store.replace(paths.task(taskId), JSON.stringify(heldTask))
  await badTask.store.replace(paths.task(otherId), JSON.stringify({ ...heldTask, taskId: otherId }))
  const defaults = { name: 'test', userName: 'test', localDirectory: damaged.store.directory, ownerRepo: '', repositoryDirectory: '', collaborationId: 'test', workerSeats: 0, workspace: damaged.store.directory }
  const service = new FrameworkService(new Context(), storage.adapter, defaults)
  service.saved.set('local', { revision: 'test', settings: defaults })
  const repairs = []
  const connection = { scope: damaged.scope, files: damaged.store, sharedRecords: storage.adapter, records: storage.adapter,
    identity: { instanceUUID: 'test-instance' }, registration: { member: 'A', workerSeats: 0 } }
  const taskConnection = { ...connection, scope: badTask.scope, files: badTask.store }
  service.running.set('local', { connection, runtime: { requestSafetyRepair: fault => { repairs.push(fault); return Promise.resolve() }, executionViews: () => [] } })
  const legacyReports = () => [...service.reportedErrors.get('local')?.values() ?? []].filter(row => row.error instanceof LegacyLocalControlReadError)
  check('actual Service on damaged old row cannot infer hold', await service.controls({ connection }).taskHeld(taskId), false)
  check('actual Service detects addressed Task row damage', await service.controls({ connection: taskConnection }).taskHeld(taskId), false)
  await new Promise(resolve => setImmediate(resolve)) // drain Service's queued delivery microtask
  check('damaged original does not request Safety Helper', repairs.length, 0)
  check('damaged original not captured as Safety fault', service.safetyNet.pending('local', damaged.scope).length, 0)
  check('scope and Task errors retain distinct owners', legacyReports().map(row => [row.scope, row.origin?.taskId]), [[damaged.scope, undefined], [badTask.scope, taskId]])
  check('another Task without addressed row is not held', await service.controls({ connection: taskConnection }).taskHeld(otherId), false)
  check('another Task read does not clear broken Task diagnostic', legacyReports().map(row => [row.scope, row.origin?.taskId]), [[damaged.scope, undefined], [badTask.scope, taskId]])
  check('Service header exposes existing repair notice', (await service.view({ mode: 'local', headerOnly: true })).connection.detail?.includes('restart the DSS Host to retry'), true)
  check('page uses existing connection detail notice', readFileSync(new URL('../src/framework/client-page.tsx', import.meta.url), 'utf8').includes('view?.connection.detail'), true)
  service.report('local', new Error('Original Host-local Task control could not be read for the selected Local scope; the retained original was not changed. Correct that retained record and restart the DSS Host to retry: Unexpected token'), damaged.scope)
  await new Promise(resolve => setImmediate(resolve))
  check('plain Error prior path still requests Safety repair', repairs.length, 1)
  const nonLegacy = [...service.reportedErrors.get('local').values()].find(row => !(row.error instanceof LegacyLocalControlReadError))
  check('other Safety report exists before legacy recovery', !!nonLegacy, true)
  check('damaged original retained byte-identically', await fs.readFile(oldDamaged.file, 'utf8'), '{damaged native record')
  await fs.writeFile(oldDamaged.file, oldDamaged.bytes)
  await fs.writeFile(oldBadTask.file, oldBadTask.bytes)
  const moved = await storage.adapter.moveRecords(path.join(scratch, 'moved-records'), recordRoot, new AbortController().signal, undefined, 'repair-then-move')
  check('actual adapter selected repaired record tree', moved.directory, path.join(scratch, 'moved-records'))
  check('scope-level warning retires only after same scope valid reread', await service.controls({ connection }).taskHeld(taskId), true)
  check('other Task warning survives scope-level repair', legacyReports().map(row => [row.scope, row.origin?.taskId]), [[badTask.scope, taskId]])
  check('Task-level warning retires only after same Task valid reread', await service.controls({ connection: taskConnection }).taskHeld(taskId), true)
  check('all repaired legacy warnings retired', legacyReports().length, 0)
  check('other Safety report not removed by legacy recovery', [...service.reportedErrors.get('local').values()].includes(nonLegacy), true)
  check('no extra Helper requested by legacy recovery', repairs.length, 1)
  check('connection warning clears after precise legacy recovery', (await service.view({ mode: 'local', headerOnly: true })).connection.detail, undefined)
  const selectedOldFile = path.join(moved.directory, path.relative(recordRoot, oldDamaged.file))
  await fs.writeFile(selectedOldFile, '{damaged again')
  await storage.adapter.moveRecords(path.join(scratch, 'moved-again'), moved.directory, new AbortController().signal, undefined, 'changed-again')
  check('same storage rereads newly damaged original after another move', await service.controls({ connection }).taskHeld(taskId), false)
  check('retired dedupe key allows precise warning to return', legacyReports().map(row => [row.scope, row.origin?.taskId]), [[damaged.scope, undefined]])
  check('repeated old warning still does not request Helper', repairs.length, 1)
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks,
    limits: 'Frozen actual d19 native JSON value and current SDK adapter/PhysicalLocalFiles/FrameworkService. Test substitutes only temporary canonical scope storage keys; baseline comparison omits optional legacy port. Service active runtime is an observation port for requestSafetyRepair, not a native Helper agent. Metadata read count is at production readBytes boundary, not OS syscalls. No old writer code, full UI/Host or Windows.' }, null, 2))
} finally {
  await Promise.allSettled([storage?.close(), ...files.map(store => store.close())])
  await fs.rm(scratch, { recursive: true, force: true })
}
