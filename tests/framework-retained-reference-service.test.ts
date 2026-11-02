import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameworkService } from '../src/framework/service.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { MemoryStorage } from './support.js'

const taskId = '00000000-0000-4000-8000-000000000001'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture(t: test.TestContext, bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-retained-service-'))
  const files = await LocalFiles.open(directory), storage = new MemoryStorage()
  const settings = { name: 'DSS', userName: 'alice', localDirectory: directory, ownerRepo: '', repositoryDirectory: '', collaborationId: 'test', workerSeats: 0, workspace: directory }
  const service = new FrameworkService({} as any, storage, settings), internal = service as any
  const transactions = new FrameworkTransactions(files, storage, 'retained-test')
  const connection = { files, transactions, scope: 'test-scope', identity: { login: 'alice', owner: 'alice', instanceUUID: taskId, repositoryId: 'test' }, cancelPending() {}, close: async () => {} }
  internal.saved.set('local', { revision: 'settings-1', settings })
  internal.accesses.set('local', Promise.resolve({ connection, conversation: new FrameworkConversation(files, transactions, { mode: 'local', collaborationId: 'test' }) }))
  const original = `task-runs/${taskId}/alice/result.bin`, archived = `archives/${taskId}/retained/example/result.bin`
  const manifest = { outputs: [`archives/${taskId}/records.md`], retainedPaths: [archived], verifiedReferences: { [archived]: sha(bytes) }, relocatedReferences: { [original]: archived }, relocatedSources: { [archived]: { sourcePath: original, sourceRevision: "original-revision", sha256: sha(bytes) } } }
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: archived, bytes }, { path: `archives/${taskId}/retention.json`, content: JSON.stringify(manifest) }], 'synthetic archived reference'))
  t.after(async () => { await service.dispose(); await files.close(); await rm(directory, { recursive: true, force: true }) })
  return { service, files, original, archived, manifest }
}

test('service preserves readable/downloadable old task references after original work path is removed', async t => {
  const bytes = Buffer.from('完整 retained original\n'), f = await fixture(t, bytes)
  const result = await f.service.readFile({ mode: 'local', path: f.original, storageScope: 'test-scope' })
  assert.equal(result.text, bytes.toString()); assert.equal(result.path, f.original)
  assert.deepEqual(Buffer.from(await f.service.download('local', f.original, 'test-scope')), bytes)
  await assert.rejects(f.service.readFile({ mode: 'local', path: f.original, storageScope: 'wrong' }), /destination changed/)
})

test('binary mapped references use current snapshot integrity, not a previously readable target', async t => {
  const bytes = Uint8Array.of(0xff, 0xfe, 0x80), f = await fixture(t, bytes)
  const result = await f.service.readFile({ mode: 'local', path: f.original })
  assert.equal(result.binary?.sha256, sha(bytes))
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: f.archived, bytes: Uint8Array.of(1, 2) }], 'synthetic corruption'))
  await assert.rejects(f.service.download('local', f.original), /integrity|differ|hash|changed/i)
})

test('a missing unrelated path does not scan archive roots or resolve another task mapping', async t => {
  const f = await fixture(t, Buffer.from('body')), listed: string[] = []
  const list = f.files.list.bind(f.files)
  f.files.list = async (snapshot, path) => { listed.push(path); return list(snapshot, path) }
  await assert.rejects(f.service.readFile({ mode: 'local', path: 'tasks/unknown_P.md' }), /does not exist/)
  assert.deepEqual(listed, [])
})

test('a current source path is not redirected to an older archived version', async t => {
  const f = await fixture(t, Buffer.from('old retained'))
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: f.original, content: 'current source' }], 'synthetic current file'))
  const result = await f.service.readFile({ mode: 'local', path: f.original })
  assert.equal(result.text, 'current source')
})
