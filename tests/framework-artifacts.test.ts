import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { StoragePort } from '../src/contracts/ports.js'
import { FrameworkArtifacts } from '../src/framework/artifacts.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'

// Real SQLite transactions and binary storage; filesystem is the documented
// official capability seam, NOT a live Host/permission or remote Git acceptance.
async function fixture(t: test.TestContext, data = Uint8Array.from([0, 255, 254, 128, 10])) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-artifacts-'))
  const files = await LocalFiles.open(directory)
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  const records = new Map<string, unknown>()
  const storage: StoragePort = { get: async <T>(key: string) => records.get(key) as T | undefined,
    set: async (key, value) => { records.set(key, value) }, list: async () => [] }
  const source = { data, version: 'v1', reads: 0, unavailable: false, changeDuringRead: false, cwd: '' }
  const ctx = { fs: {
    resolve: async (_path: string, options: { cwd: string }) => { source.cwd = options.cwd; if (source.unavailable) throw new Error('source unavailable'); return { targetKey: 'opaque', displayPath: 'output.bin' } },
    stat: async () => ({ type: 'file', size: source.data.byteLength, version: source.version }),
    readByteRange: async (_target: unknown, range: { offset: number; length: number }) => {
      source.reads++
      if (source.changeDuringRead) source.version = 'changed'
      return source.data.slice(range.offset, range.offset + range.length)
    },
  } } as unknown as Pick<Context, 'fs'>
  const transactions = new FrameworkTransactions(files, storage, 'artifacts')
  const artifacts = new FrameworkArtifacts(ctx, files, transactions, '/authorized-workspace')
  const input = { taskId: 'T', sourcePath: 'output.bin', destinationPath: 'archives/T/artifacts/output.bin' }
  return { files, source, artifacts, input, records, transactions, ctx }
}

test('binary artifact uses real atomic storage and downloads byte-for-byte with actual byte count', async t => {
  const { files, artifacts, input, source } = await fixture(t)
  const result = await artifacts.preserve('first', input)
  assert.equal(result.bytes, 5)
  assert.match(result.sha256, /^[0-9a-f]{64}$/)
  assert.equal(source.cwd, '/authorized-workspace')
  assert.deepEqual((await artifacts.read(result.path)).data, source.data)
  await withSnapshot(files, async snapshot => {
    assert.equal((await files.list(snapshot, 'archives/T/artifacts'))[0].bytes, 5)
    await assert.rejects(files.read(snapshot, result.path), /encoded data/)
  })
})

test('completed command survives lost local acknowledgment, changed/deleted source and restart', async t => {
  const { files, artifacts, input, source, records, ctx, transactions } = await fixture(t)
  const first = await artifacts.preserve('stable', input)
  records.clear() // Simulates commit succeeded before local acknowledgement persisted.
  source.unavailable = true
  const restarted = new FrameworkArtifacts(ctx, files, transactions, '/authorized-workspace')
  assert.deepEqual(await restarted.preserve('stable', input), first)
  assert.equal(source.reads, 2)
  await assert.rejects(restarted.preserve('stable', { ...input, sourcePath: 'different.bin' }), /arguments/)
})

test('zero-byte and multi-window files are lossless, with no arbitrary total size gate', async t => {
  const { artifacts, input, source } = await fixture(t, new Uint8Array())
  assert.equal((await artifacts.preserve('empty', input)).bytes, 0)
  source.data = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, index) => index % 256)
  source.version = 'v2'
  const result = await artifacts.preserve('large', { ...input, destinationPath: 'archives/T/artifacts/large.bin' }, { cwd: '/agent-cwd' })
  assert.equal(source.cwd, '/agent-cwd')
  assert.deepEqual((await artifacts.read(result.path)).data, source.data)
})

test('source changes, permission failures, cancellation and wrong archive never write a partial artifact', async t => {
  const { artifacts, input, source, files } = await fixture(t)
  source.changeDuringRead = true
  await assert.rejects(artifacts.preserve('changed', input), /changed/)
  source.unavailable = true
  await assert.rejects(artifacts.preserve('denied', input), /unavailable/)
  await assert.rejects(artifacts.preserve('wrong-task', { ...input, destinationPath: 'archives/OTHER/file' }), /task archive/)
  await assert.rejects(artifacts.preserve('traversal', { ...input, destinationPath: 'archives/T/../file' }), /relative file path/)
  await assert.rejects(artifacts.preserve('aborted', input, { signal: AbortSignal.abort() }), /abort/i)
  await withSnapshot(files, async snapshot => assert.deepEqual(await files.list(snapshot, ''), []))
})

test('readback corruption is reported, not silently repaired from a now-different source', async t => {
  const { artifacts, input, files } = await fixture(t)
  const result = await artifacts.preserve('corrupt', input)
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: result.path, bytes: Uint8Array.of(1, 2) }], 'inject corruption'))
  await assert.rejects(artifacts.read(result.path), /integrity/)
  await assert.rejects(artifacts.preserve('corrupt', input), /integrity/)
})

test('an existing archive identity cannot be overwritten by later different bytes', async t => {
  const { artifacts, input, source } = await fixture(t)
  const first = await artifacts.preserve('original', input)
  source.data = Uint8Array.of(9); source.version = 'v2'
  await assert.rejects(artifacts.preserve('overwrite', input), /cannot be overwritten/)
  assert.equal((await artifacts.read(first.path)).artifact.sha256, first.sha256)
})


test('artifact manifest failure rolls back binary and receipt in the real Local transaction', async t => {
  const { artifacts, files, input } = await fixture(t)
  const db = new DatabaseSync(files.databasePath)
  try {
    db.exec("CREATE TRIGGER artifact_failure BEFORE INSERT ON files WHEN NEW.path LIKE 'technical/artifacts/manifests/%' BEGIN SELECT RAISE(ABORT,'artifact manifest failure'); END;")
    await assert.rejects(artifacts.preserve('atomic-failure', input), /artifact manifest failure/)
    await withSnapshot(files, async snapshot => assert.deepEqual(await files.list(snapshot, ''), []))
  } finally { db.close() }
})

test('reserved task records cannot become binary artifacts and stale revisions stay explicit', async t => {
  const { artifacts, files, input } = await fixture(t)
  for (const name of ['records.md', 'retention.json']) await assert.rejects(
    artifacts.preserve(name, { ...input, destinationPath: 'archives/T/' + name }), /reserved/)
  await assert.rejects(artifacts.preserve('stale', input, { expectedRevision: 'not-current' }), /Storage changed/)
  await withSnapshot(files, async snapshot => assert.deepEqual(await files.list(snapshot, ''), []))
})
