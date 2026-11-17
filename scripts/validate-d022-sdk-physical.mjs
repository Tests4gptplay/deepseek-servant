import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
import { evidence } from './test-support/dsh-sdk-runtime.mjs'
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { foregroundTaskSignal, paths } = await import('../src/framework/task-files.ts')
const hash = value => createHash('sha256').update(value).digest('hex')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'd022-sdk-physical-'))
const transaction = { run() { throw new Error('Local physical conversation unexpectedly used generic transaction') } }
const message = id => ({ id, participantId: 'user', createdAt: '2026-11-12T00:00:00Z', role: 'user', recipient: 'ai', text: id })
async function open(name) {
  const directory = path.join(root, name)
  const sdk = await openDshStorageFixture(path.join(directory, 'technical'), path.join(directory, 'locator'))
  const files = new PhysicalLocalFiles(path.join(directory, 'local'))
  const conversation = new FrameworkConversation(files, transaction, { mode: 'local', collaborationId: name })
  const runtime = Object.assign(Object.create(FrameworkRoleRuntime.prototype), { files, records: sdk.adapter, conversation,
    prefix: 'framework-runtime/' + hash(name) + '/', config: { mode: 'local', member: 'A', primary: true },
    roleRecords: new Map(), workOperations: new Map(), error(error) { throw error } })
  const cleanup = new FrameworkManualCleanup(files, transaction, conversation, runtime)
  return { sdk, files, conversation, runtime, cleanup, close: async () => { await files.close(); await sdk.close() } }
}
const checks = []
try {
  const normal = await open('normal')
  try {
    for (let n = 1; n <= 3; n++) {
      await normal.conversation.send('send-' + n, message('old-' + n))
      const preview = await normal.cleanup.previewConversation()
      assert.deepEqual(preview.messageIds.map(row => row.id), ['old-' + n])
      await normal.cleanup.clearConversation('clear-' + n, 'clear-foreground-conversation', preview)
      const rows = await normal.sdk.adapter.list(normal.runtime.prefix + 'foreground-resets/')
      assert.equal(rows.length, 0)
      await normal.conversation.send('later-' + n, message('later-' + n))
      await normal.cleanup.clearConversation('clear-' + n, 'clear-foreground-conversation', preview)
      assert.deepEqual((await normal.conversation.page(10)).messages.map(row => row.id), ['later-' + n])
      checks.push({ case: 'repeated-clear-' + n, completedRows: 0, oldRetryPreservedLater: true })
      if (n < 3) await normal.cleanup.clearConversation('next-' + n, 'clear-foreground-conversation', await normal.cleanup.previewConversation())
    }
  } finally { await normal.close() }
  const claimed = await open('claimed-task')
  try {
    const taskId = '11111111-1111-4111-8111-111111111111', lifecycleId = 'life-one'
    await claimed.files.replace(paths.task(taskId), JSON.stringify({ taskId, lifecycleId, status: 'complete', route: 'P', owner: 'A', sourcePath: 'requirements/original.md' }))
    await claimed.conversation.send('send-A', message('A'))
    const workId = claimed.runtime.roleKey('Foreground')
    const owner = { identity: { role: 'Foreground', workId, executionId: 'original-execution' },
      sessionId: 'original-session', generation: 1, foregroundOutputIds: [], lastWake: { id: 'original-A', role: 'Foreground', reason: 'notification', sources: [] } }
    claimed.runtime.roleRecords.set(workId, owner)
    await claimed.sdk.adapter.set(claimed.runtime.prefix + 'roles/' + hash(workId), owner)
    const preview = await claimed.cleanup.previewConversation()
    const signal = foregroundTaskSignal(taskId)
    await claimed.files.createIfAbsent(signal, '')
    const info = await claimed.files.fileInfo(signal)
    const withClaim = { ...owner, notificationClaims: { 'claim-one': { commandId: 'claim-one', executionId: owner.identity.executionId,
      wakeId: owner.lastWake.id, initialSignals: [], sources: [{ path: signal, version: info.version }] } } }
    claimed.runtime.roleRecords.set(workId, withClaim)
    await claimed.sdk.adapter.set(claimed.runtime.prefix + 'roles/' + hash(workId), withClaim)
    assert.equal(await claimed.files.deleteObserved(signal, info.version), true)
    const wakes = []
    claimed.runtime.finishForegroundRound = async () => {}
    claimed.runtime.stopOwnedRecord = async record => { claimed.runtime.roleRecords.set(workId, { ...record, stopped: true }); return { status: 'stopped' } }
    claimed.runtime.saveRole = async record => { await claimed.sdk.adapter.set(claimed.runtime.prefix + 'roles/' + hash(workId), record); claimed.runtime.roleRecords.set(workId, record) }
    claimed.runtime.flushForegroundProcessWrites = async () => {}
    claimed.runtime.wake = async request => { wakes.push(request); await claimed.files.createIfAbsent(foregroundTaskSignal(request.taskId), ''); return true }
    await claimed.cleanup.clearConversation('clear-original', 'clear-foreground-conversation', preview)
    assert.equal(wakes.length, 1)
    assert.equal(wakes[0].taskId, taskId)
    assert.equal(wakes[0].lifecycleId, lifecycleId)
    assert(await claimed.files.fileInfo(signal))
    assert.deepEqual((await claimed.conversation.page(10)).messages.map(row => row.id), [])
    assert.equal((await claimed.sdk.adapter.list(claimed.runtime.prefix + 'foreground-resets/')).length, 0)
    checks.push({ case: 'claimed-task-handoff', taskId, lifecycleId, exactSingleWake: true, signalRestored: true, completedRows: 0,
      boundary: 'actual SDK storage and PhysicalLocalFiles; native stop, claimed RoleRecord and wake port controlled' })
  } finally { await claimed.close() }
  console.log(JSON.stringify({ status: 'passed', checks, sdk: evidence() }, null, 2))
} finally { await fs.rm(root, { recursive: true, force: true }) }
