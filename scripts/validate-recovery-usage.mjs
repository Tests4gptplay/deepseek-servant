// Actual SDK technical storage and production Local recovery publication/accounting.
// Temporary Linux files; controlled Host access. No model, UI or Windows claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { evidence } from './test-support/dsh-sdk-runtime.mjs'
import { localFixture } from './helper-retirement-local-fixture.mjs'
const { FrameworkService } = await import('../src/framework/service.ts')
const { FrameworkTaskIndex } = await import('../src/framework/task-index.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { paths, taskWorkingRoots } = await import('../src/framework/task-files.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-recovery-usage-'))
let f, checks = 0
const check = (a, b) => { assert.deepEqual(a, b); checks++ }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function inventory(directory) {
  const result = {}
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    result[path.relative(directory, file)] = digest(await fs.readFile(file))
  }
  return Object.fromEntries(Object.entries(result).sort())
}
try {
  f = await localFixture(root)
  const task = { version: 1, taskId: '11111111-1111-4111-8111-111111111111', lifecycleId: 'original-life', route: 'P', sourcePath: 'tasks/11111111-1111-4111-8111-111111111111_P.md', owner: 'A', members: ['A'], status: 'running' }
  await f.files.replace('tasks/11111111-1111-4111-8111-111111111111.json', JSON.stringify(task))
  await f.files.replace(paths.inbox(task.taskId, 'A'), 'Accepted work remains in this actual member inbox.')
  await f.files.replace('debug/kept.md', '已保留的调试记录')
  await f.files.replace('archives/kept/records.md', 'Permanent result')
  const taskIndex = new FrameworkTaskIndex(f.files, error => { throw error })
  // Use production Task parsing/discovery; ordinary native task execution is not started.
  f.rt.taskMetadata = snapshot => taskIndex.list(snapshot)
  const accepted = await f.rt.services().helper.restoreHost({ ...f.record.identity, owner: 'A' }, {
    facts: 'Host recovery fixture', hypotheses: 'Resume unfinished work', actionsTaken: 'Read current task', continuation: 'Notify its Planner'
  }, 'usage-host-restore')
  check(accepted, { arranged: true })
  const key = f.key('host-restores', 'usage-host-restore')
  const row = { key, value: await f.sdk.adapter.get(key) }
  check(row.value.complete, false)
  await f.rt.publishPhysicalHostRestoration(row)
  const recoveryPath = 'technical/recovery-inputs/11111111-1111-4111-8111-111111111111/A/Planner.json'
  const recovery = await fs.readFile(path.join(f.files.directory, recoveryPath))
  check(JSON.parse(recovery).facts, 'Host recovery fixture')
  check(taskWorkingRoots(task).includes('technical/recovery-inputs/11111111-1111-4111-8111-111111111111'), true)
  const entries = await withSnapshot(f.files, snapshot => f.files.list(snapshot, ''))
  const total = entries.reduce((sum, e) => sum + e.bytes, 0)
  const stateBytes = entries.filter(e => e.path.startsWith('state/')).reduce((sum, e) => sum + e.bytes, 0)
  const taskBytes = entries.filter(e => e.path.startsWith('tasks/') || e.path.startsWith('task-runs/')).reduce((sum, e) => sum + e.bytes, 0)
  const debugBytes = entries.filter(e => e.path.startsWith('debug/')).reduce((sum, e) => sum + e.bytes, 0)
  const archiveBytes = entries.filter(e => e.path.startsWith('archives/')).reduce((sum, e) => sum + e.bytes, 0)
  const before = await inventory(f.files.directory)
  let lists = 0, bodyReads = 0
  const list = f.files.list.bind(f.files), read = f.files.readBytes.bind(f.files)
  f.files.list = (...args) => { lists++; return list(...args) }
  f.files.readBytes = (...args) => { bodyReads++; return read(...args) }
  const service = Object.create(FrameworkService.prototype)
  service.access = async () => ({ connection: { files: f.files, scope: 'test' } })
  service.storage = { storageView: () => ({ directory: path.join(root, 'records') }) }
  const result = await service.maintenanceView({ mode: 'local', storageScope: 'test' })
  check(lists, 1); check(bodyReads, 0)
  check(result.usage.temporary.recoveryBytes, stateBytes + recovery.byteLength)
  check(result.usage.temporaryBytes, taskBytes + stateBytes + recovery.byteLength)
  check(result.usage.totalBytes, total)
  check(result.usage.permanent.debugBytes, debugBytes)
  check(result.usage.permanent.archiveBytes, archiveBytes)
  check(result.usage.permanentBytes, total - result.usage.temporaryBytes)
  check(await inventory(f.files.directory), before)
  const again = await service.maintenanceView({ mode: 'local', storageScope: 'test' })
  check({ ...again.usage, recordedAt: '' }, { ...result.usage, recordedAt: '' })
  check(lists, 2); check(bodyReads, 0)
  await assert.rejects(service.maintenanceView({ mode: 'git', storageScope: 'test' }), /Local records management/); checks++
  check(lists, 2)
  await assert.rejects(service.maintenanceView({ mode: 'local', storageScope: 'other' }), /Storage destination changed/); checks++
  check(lists, 2)
  console.log(JSON.stringify({ status: 'passed', assertions: checks, recoveryPath, recoveryBytes: recovery.byteLength, usage: result.usage, evidence: evidence(), limits: 'Actual SDK storage; actual Helper restore acceptance, Local recovery publisher, Task index and service maintenanceView. Host access is controlled; no UI/model/Windows/Git remote run. One existing on-demand list per query; no body reads added.' }, null, 2))
} finally { await f?.close(); await fs.rm(root, { recursive: true, force: true }) }
