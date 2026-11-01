import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { LocalLocationRegistry, LocalLocationMovedError } from '../src/framework/local-location.js'
import { FrameworkRecordMove, recordMoveKey, type RecordMoveReceipt, type RecordMoveRequest } from '../src/framework/record-move.js'
import type { FrameworkClientSettings } from '../src/framework/client-contracts.js'
import { MemoryStorage } from './support.js'

// Real SQLite/filesystem copying with an explicit physical-store lifecycle seam.
// This does not claim the real DshStorageAdapter or native producers were exercised.
async function fixture(t: test.TestContext, custom = false, noLocal = false) {
  const root = await mkdtemp(join(tmpdir(), 'dss-record-move-')), sourceRecords = join(root, 'source'), targetRecords = join(root, 'target')
  await mkdir(join(sourceRecords, 'deepseek_servant'), { recursive: true })
  const sourceLocal = custom ? join(root, 'custom-local') : join(sourceRecords, 'deepseek_servant', 'framework')
  let files = noLocal ? undefined : await LocalFiles.open(sourceLocal), active = sourceRecords, closed = false, settings: RecordMoveReceipt['settingsAfter'] | undefined
  const text = JSON.stringify({ operationId: 'same-op', UUID: 'same-instance', nativeSession: 'same-session', body: 'Original body 🚀' })
  if (files) await withSnapshot(files, s => files!.commit(s, [{ path: 'task-runs/kept/notes.md', content: text }], 'fixture'))
  else await mkdir(join(sourceRecords, 'deepseek_servant'), { recursive: true })
  const storage = new MemoryStorage(), counts = { quiesce: 0, copy: 0, settings: 0, reopen: 0 }
  let lostPhysical = false, failReopen = false
  const request: RecordMoveRequest = { sourceRecords, targetRecords, ...(noLocal ? {} : { sourceLocal, scope: JSON.stringify(['local', sourceLocal]) }),
    settingsBefore: { revision: 'settings-original', settings: { localDirectory: sourceLocal, userName: 'same-user', workerSeats: 4 } as FrameworkClientSettings }, nextSettingsRevision: 'settings-stable-next' }
  const physical = {
    storageView: () => ({ directory: active }),
    async moveRecords(target: string, expected: string, signal: AbortSignal, verify?: (directory: string) => Promise<void>) {
      signal.throwIfAborted(); assert.equal(expected, active); counts.copy++
      await mkdir(target, { recursive: true }); await cp(join(active, 'deepseek_servant'), join(target, 'deepseek_servant'), { recursive: true, errorOnExist: true, force: false })
      await verify?.(target); active = target
      if (lostPhysical) { lostPhysical = false; throw new Error('injected physical commit acknowledgement loss') }
      return { directory: active }
    },
  }
  const lifecycle = {
    async quiesce(receipt: Readonly<RecordMoveReceipt>) {
      counts.quiesce++
      const persisted = await storage.get<{ receipts: RecordMoveReceipt[] }>(recordMoveKey)
      assert.equal(persisted!.receipts[0]!.phase, 'prepared', 'intent is durable before stopping writers')
      assert.equal(receipt.settingsBefore.revision, 'settings-original')
      if (files && !closed) { await files.close(); closed = true }
    },
    async applySettings(receipt: Readonly<RecordMoveReceipt>) {
      assert.equal(active, targetRecords); counts.settings++
      settings = structuredClone(receipt.settingsAfter)
    },
    async reopen(receipt: Readonly<RecordMoveReceipt>) {
      counts.reopen++
      if (failReopen) { failReopen = false; throw new Error('injected reopen failure') }
      if (receipt.targetLocal) {
        const check = await LocalFiles.open(receipt.targetLocal)
        try { assert.equal(await withSnapshot(check, s => check.read(s, 'task-runs/kept/notes.md')), text) } finally { await check.close() }
      }
    },
  }
  t.after(async () => { if (files && !closed) await files.close(); await rm(root, { recursive: true, force: true }) })
  return { root, storage, request, counts, physical, lifecycle, text, settings: () => settings,
    coordinator: () => new FrameworkRecordMove(storage, physical, lifecycle),
    losePhysical: () => { lostPhysical = true }, failReopen: () => { failReopen = true } }
}
const signal = () => new AbortController().signal

for (const custom of [false, true]) test(`verified ${custom ? 'custom' : 'owned default'} Local move keeps scope and exact payload while updating only directory settings`, async t => {
  const f = await fixture(t, custom), receipt = await f.coordinator().run('move', f.request, signal())
  assert.equal(receipt.phase, 'applied'); assert.equal(receipt.localKind, custom ? 'custom' : 'owned')
  assert.ok(receipt.fingerprint)
  const locations = new LocalLocationRegistry(f.storage)
  assert.equal(await locations.resolve(receipt.targetLocal!), f.request.scope)
  await assert.rejects(locations.resolve(f.request.sourceLocal!), LocalLocationMovedError)
  assert.equal(f.settings()!.settings.localDirectory, receipt.targetLocal)
  assert.equal(f.settings()!.settings.userName, 'same-user'); assert.equal(f.settings()!.settings.workerSeats, 4)
  assert.equal(f.settings()!.revision, 'settings-stable-next')
  if (custom) assert.ok(receipt.targetLocal!.startsWith(join(f.request.targetRecords, 'framework-local-')))
  const count = { ...f.counts }
  await f.coordinator().run('move', f.request, signal())
  assert.deepEqual(f.counts, count, 'same applied command does not kill or reopen a new execution')
  const source = await LocalFiles.open(f.request.sourceLocal!)
  try { assert.equal(await withSnapshot(source, s => source.read(s, 'task-runs/kept/notes.md')), f.text) } finally { await source.close() }
})

test('physical commit acknowledgement loss is resumed from actual target without copying or quiescing again', async t => {
  const f = await fixture(t); f.losePhysical()
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /acknowledgement/)
  assert.equal((await f.coordinator().receipt('move'))!.phase, 'prepared')
  const receipt = await f.coordinator().resumePending(signal())
  assert.equal(receipt!.phase, 'applied'); assert.equal(f.counts.copy, 1); assert.equal(f.counts.quiesce, 1)
  assert.equal(f.settings()!.revision, 'settings-stable-next')
})

test('published settings/reopen failure retains original receipt and restart does not stop the new generation', async t => {
  const f = await fixture(t); f.failReopen()
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /reopen/)
  assert.equal((await f.coordinator().receipt('move'))!.phase, 'reopening')
  await f.coordinator().resumePending(signal())
  assert.equal(f.counts.copy, 1); assert.equal(f.counts.quiesce, 1)
  await assert.rejects(f.coordinator().run('move', { ...f.request, targetRecords: join(f.root, 'another') }, signal()), /reused/)
})

test('no Local payload does not create a database or a scope alias', async t => {
  const f = await fixture(t, false, true), receipt = await f.coordinator().run('move', f.request, signal())
  assert.equal(receipt.localKind, 'none'); assert.equal(receipt.fingerprint, undefined); assert.equal(receipt.targetLocal, undefined)
  assert.equal(f.settings()!.settings.localDirectory, join(f.request.targetRecords, 'deepseek_servant', 'framework'))
  assert.equal(await f.storage.get('framework/local-locations'), undefined)
})

test('pre-existing destination database is not adopted as an authorized move', async t => {
  const f = await fixture(t), target = await LocalFiles.open(join(f.request.targetRecords, 'deepseek_servant', 'framework'))
  await target.close()
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /already has Local records/)
  assert.equal(f.counts.quiesce, 0); assert.equal(await f.coordinator().receipt('move'), undefined)
})

test('unknown actual root never switches settings or guesses that either copy is authoritative', async t => {
  const f = await fixture(t), original = f.physical.moveRecords.bind(f.physical)
  f.physical.moveRecords = async (...args) => {
    const result = await original(...args)
    f.physical.storageView = () => ({ directory: join(f.root, 'unknown-root') })
    return result
  }
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /not confirmed/)
  assert.equal(f.settings(), undefined); assert.equal(f.counts.reopen, 0)
  await assert.rejects(f.coordinator().resumePending(signal()), /not confirmed/)
  assert.equal(f.counts.quiesce, 1); assert.equal(f.counts.copy, 1)
})

test('changed published Local payload is retained for diagnosis and cannot authorize settings or scope publication', async t => {
  const f = await fixture(t), original = f.physical.moveRecords.bind(f.physical)
  f.physical.moveRecords = (target, expected, signal, verify) => original(target, expected, signal, async directory => {
    const changed = await LocalFiles.open(join(directory, 'deepseek_servant', 'framework'))
    try { await withSnapshot(changed, s => changed.commit(s, [{ path: 'task-runs/kept/notes.md', content: 'changed after copy' }], 'fault injection')) } finally { await changed.close() }
    await verify?.(directory)
  })
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /differ from the frozen/)
  assert.equal(f.settings(), undefined); assert.equal(f.counts.reopen, 0)
  assert.equal(await new LocalLocationRegistry(f.storage).resolve(f.request.sourceLocal!), f.request.scope)
  await assert.rejects(new LocalLocationRegistry(f.storage).resolve(join(f.request.targetRecords, 'deepseek_servant', 'framework')), /pending explicit move/)
})

test('lost applied-receipt acknowledgement replays without stopping or copying successfully reopened work', async t => {
  const f = await fixture(t), set = f.storage.set.bind(f.storage)
  let lost = false
  f.storage.set = async (key, value) => {
    await set(key, value)
    if (!lost && key === recordMoveKey && (value as { receipts: RecordMoveReceipt[] }).receipts[0]?.phase === 'applied') {
      lost = true; throw new Error('lost applied receipt acknowledgement')
    }
  }
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /not confirmed/)
  assert.equal((await f.coordinator().receipt('move'))!.phase, 'applied')
  const counts = { ...f.counts }
  assert.equal(await f.coordinator().resumePending(signal()), undefined)
  assert.equal((await f.coordinator().run('move', f.request, signal())).phase, 'applied')
  assert.deepEqual(f.counts, counts)
})


test('failed final receipt before persistence permits legitimate new-generation writes on resume', async t => {
  const f = await fixture(t), set = f.storage.set.bind(f.storage)
  let failed = false
  f.storage.set = async (key, value) => {
    if (!failed && key === recordMoveKey && (value as { receipts: RecordMoveReceipt[] }).receipts[0]?.phase === 'applied') {
      failed = true; throw new Error('failed before final receipt write')
    }
    await set(key, value)
  }
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /not confirmed/)
  const receipt = (await f.coordinator().receipt('move'))!
  assert.equal(receipt.phase, 'reopening')
  const target = await LocalFiles.open(receipt.targetLocal!)
  try { await withSnapshot(target, s => target.commit(s, [{ path: 'task-runs/new/notes.md', content: 'Legitimate new-generation progress' }], 'new work')) } finally { await target.close() }
  await f.coordinator().resumePending(signal())
  assert.equal(f.counts.copy, 1); assert.equal(f.counts.quiesce, 1)
  const check = await LocalFiles.open(receipt.targetLocal!)
  try { assert.equal(await withSnapshot(check, s => check.read(s, 'task-runs/new/notes.md')), 'Legitimate new-generation progress') } finally { await check.close() }
})

test('prepared intent acknowledgement loss occurs before quiesce and resumes the same retained settings', async t => {
  const f = await fixture(t), set = f.storage.set.bind(f.storage)
  let lost = false
  f.storage.set = async (key, value) => {
    await set(key, value)
    if (!lost && key === recordMoveKey) { lost = true; throw new Error('prepared acknowledgement lost') }
  }
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /not confirmed/)
  assert.equal(f.counts.quiesce, 0); assert.equal(f.counts.copy, 0)
  await f.coordinator().resumePending(signal())
  assert.equal(f.counts.quiesce, 1); assert.equal(f.settings()!.revision, f.request.nextSettingsRevision)
})

test('custom Local copy published before a root-switch failure is verified and reused only under its retained intent', async t => {
  const f = await fixture(t, true), original = f.physical.moveRecords.bind(f.physical)
  let interrupted = false
  f.physical.moveRecords = async (...args) => {
    if (!interrupted) { interrupted = true; throw new Error('interrupted before owned-tree copy') }
    return original(...args)
  }
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /interrupted/)
  const pending = (await f.coordinator().receipt('move'))!
  assert.equal(pending.phase, 'prepared'); assert.ok(pending.fingerprint)
  const alreadyCopied = await LocalFiles.open(pending.targetLocal!)
  try { assert.equal(await withSnapshot(alreadyCopied, s => alreadyCopied.read(s, 'task-runs/kept/notes.md')), f.text) } finally { await alreadyCopied.close() }
  await f.coordinator().resumePending(signal())
  assert.equal(f.counts.copy, 1); assert.equal((await f.coordinator().receipt('move'))!.phase, 'applied')
})


test('pendingReceipt is a read-only restart discovery and rejects ambiguous unfinished moves', async t => {
  const f = await fixture(t); f.losePhysical()
  await assert.rejects(f.coordinator().run('move', f.request, signal()), /acknowledgement/)
  const counts = { ...f.counts }, pending = (await f.coordinator().pendingReceipt())!
  assert.equal(pending.commandId, 'move'); assert.equal(pending.targetRecords, f.request.targetRecords)
  assert.deepEqual(f.counts, counts)
  pending.targetRecords = '/outside-mutation'
  assert.equal((await f.coordinator().pendingReceipt())!.targetRecords, f.request.targetRecords)
  const original = (await f.coordinator().receipt('move'))!
  await f.storage.set(recordMoveKey, { version: 1, receipts: [original, { ...original, commandId: 'another' }] })
  await assert.rejects(f.coordinator().pendingReceipt(), /Multiple unresolved/)
  assert.deepEqual(f.counts, counts)
})
