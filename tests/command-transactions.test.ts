import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import type { StoragePort } from '../src/contracts/ports.js'
import { FilesConflictError, withSnapshot } from '../src/framework/transactions.js'

async function fixture(run: (files: LocalFiles, records: StoragePort) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'dss-command-'))
  const files = await LocalFiles.open(dir), rows = new Map<string, unknown>()
  const records: StoragePort = { get: async key => structuredClone(rows.get(key)) as any,
    set: async (key, value) => { rows.set(key, structuredClone(value)) },
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => ({key,value: structuredClone(value) as any})) }
  try { await run(files, records) } finally { await files.close(); await rm(dir, { recursive: true, force: true }) }
}
test('durable Local business receipt recovers an acknowledged commit after command acknowledgement storage fails', () => fixture(async (files, records) => {
  let fail = true, builds = 0
  const interrupted: StoragePort = { ...records, set: async (key, value) => {
    if (fail && (value as any).receipt) { fail = false; throw new Error('ack storage unavailable') }
    await records.set(key, value)
  } }
  const service = new FrameworkTransactions(files, interrupted, 'local')
  const build = async () => { builds++; return [{ path: 'tasks/a_P.md', content: 'original' }] }
  await assert.rejects(service.run('tool-1', { value: 1 }, {}, build), /ack storage unavailable/)
  const retry = await new FrameworkTransactions(files, records, 'local').run('tool-1', { value: 1 }, {}, build)
  assert.equal(retry.replay, true); assert.equal(builds, 1)
  await withSnapshot(files, async snapshot => assert.equal(await files.read(snapshot, 'tasks/a_P.md'), 'original'))
}))
test('expected revision conflict returns to business evaluation instead of changing its snapshot', () => fixture(async (files, records) => {
  const before = await files.snapshot()
  await files.commit(before, [{ path: 'tasks/other_P.md', content: 'other' }], 'other')
  const service = new FrameworkTransactions(files, records, 'local')
  let built = false
  await assert.rejects(service.run('tool-2', {}, { expectedRevision: before.revision }, async () => { built = true; return [] }), FilesConflictError)
  assert.equal(built, false); await before.release()
}))
test('concurrent duplicate command identities cannot mask different native arguments', () => fixture(async (files, records) => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const service = new FrameworkTransactions(files, records, 'local')
  const first = service.run('tool-3', { value: 1 }, {}, async () => { entered.resolve(); await release.promise; return [{ path: 'tasks/a_P.md', content: 'one' }] })
  await entered.promise
  await assert.rejects(service.run('tool-3', { value: 2 }, {}, async () => []), /different arguments/)
  release.resolve(); await first
}))

test('a proven Local CAS conflict permits explicit fresh business evaluation, never silent reparenting', () => fixture(async (files, records) => {
  const before = await files.snapshot()
  const service = new FrameworkTransactions(files, records, 'local')
  let builds = 0
  const build = async () => { builds++; return [{path:'tasks/a_P.md',content:'new'}] }
  await files.commit(before, [{path:'tasks/other_P.md',content:'other'}], 'other')
  await assert.rejects(service.run('tool-conflict', {}, {snapshot:before,expectedRevision:before.revision}, build), FilesConflictError)
  await before.release()
  await service.run('tool-conflict', {}, {reevaluate:true}, build)
  assert.equal(builds, 2, 'business builder runs again against the newly checked snapshot')
}))
