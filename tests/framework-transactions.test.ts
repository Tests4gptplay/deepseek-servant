import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalFiles } from '../src/framework/local-files.js'
import { FilesConflictError, withSnapshot, filePath } from '../src/framework/transactions.js'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dss-files-'))
  const store = await LocalFiles.open(root)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  return { root, store }
}
test('real WAL snapshot preserves old read and directory emptiness across another writer', async t => {
  const { root, store } = await fixture(t)
  const second = await LocalFiles.open(root); t.after(() => second.close())
  const a = await store.snapshot(), b = await second.snapshot()
  assert.deepEqual(await store.list(a, 'state/'), [])
  await second.commit(b, [{ path: 'state/B/T/Planner_Worker', content: '' }], 'notify')
  assert.deepEqual(await store.list(a, 'state/'), [])
  await assert.rejects(store.commit(a, [{ path: 'tasks/T.json', content: 'complete' }], 'seal'), FilesConflictError)
  assert.equal(await store.read(a, 'state/B/T/Planner_Worker'), undefined)
  await a.release(); await b.release()
  await withSnapshot(store, async snapshot => assert.equal(await store.read(snapshot, 'state/B/T/Planner_Worker'), ''))
})
test('multi-file fault rolls back the actual LocalFiles commit and survives reopen', async t => {
  const { root, store } = await fixture(t)
  const observer = new DatabaseSync(store.databasePath)
  observer.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON files WHEN NEW.path='state/B/T/Planner_Worker' BEGIN SELECT RAISE(ABORT,'injected write failure'); END;")
  await withSnapshot(store, async snapshot => {
    await assert.rejects(store.commit(snapshot, [
      { path: 'task-runs/T/B/Reply.md', content: 'durable work' },
      { path: 'state/B/T/Planner_Worker', content: '' },
    ], 'handoff'), /injected write failure/)
  })
  observer.exec('DROP TRIGGER injected_failure'); observer.close()
  await store.close()
  const reopened = await LocalFiles.open(root)
  try { await withSnapshot(reopened, async snapshot => assert.deepEqual(await reopened.list(snapshot, ''), [])) }
  finally { await reopened.close() }
})
test('successful handoff survives close and reopen with UTF-8 size and zero-byte note', async t => {
  const { root, store } = await fixture(t)
  await withSnapshot(store, snapshot => store.commit(snapshot, [
    { path: 'task-runs/T/B/Reply.md', content: '结果😀' },
    { path: 'task-runs/T/B/Notes.md', content: '' },
    { path: 'state/B/T/Planner_Worker', content: '' },
  ], 'handoff'))
  await store.close()
  const reopened = await LocalFiles.open(root)
  try { await withSnapshot(reopened, async snapshot => {
    const entries = await reopened.list(snapshot, 'task-runs/T/B')
    assert.equal(entries.find(x => x.path.endsWith('Reply.md'))?.bytes, Buffer.byteLength('结果😀'))
    assert.equal(entries.find(x => x.path.endsWith('Notes.md'))?.empty, true)
    assert.equal(await reopened.read(snapshot, 'state/B/T/Planner_Worker'), '')
  }) } finally { await reopened.close() }
})
test('released snapshots cannot pin or access the store and finally release runs on failure', async t => {
  const { store } = await fixture(t)
  let retained: Awaited<ReturnType<typeof store.snapshot>> | undefined
  await assert.rejects(withSnapshot(store, async snapshot => { retained = snapshot; throw new Error('reader failed') }), /reader failed/)
  await assert.rejects(store.read(retained!, 'tasks/a_P.md'), /released/)
  await retained!.release()
  await store.close()
  await assert.rejects(store.snapshot(), /closed/)
})
test('explicit SQL writer contention is visible, without an invented retry timeout', async t => {
  const { store } = await fixture(t)
  const blocker = new DatabaseSync(store.databasePath)
  blocker.exec('BEGIN IMMEDIATE')
  try { await withSnapshot(store, async snapshot => {
    await assert.rejects(store.commit(snapshot, [{ path: 'tasks/a_P.md', content: 'a' }], 'new'), /locked/)
  }) } finally { blocker.exec('ROLLBACK'); blocker.close() }
  await withSnapshot(store, snapshot => store.commit(snapshot, [{ path: 'tasks/a_P.md', content: 'a' }], 'new'))
})
test('directory predicates are literal and do not interpret SQL wildcard paths', async t => {
  const { store } = await fixture(t)
  await withSnapshot(store, snapshot => store.commit(snapshot, [
    { path: 'state/A_1/T/Planner', content: '' }, { path: 'state/AA1/T/Planner', content: '' },
    { path: 'state/A%/T/Planner', content: '' },
  ], 'names'))
  await withSnapshot(store, async snapshot => {
    assert.equal((await store.list(snapshot, 'state/A_1')).length, 1)
    assert.equal((await store.list(snapshot, 'state/A%')).length, 1)
  })
})
test('technical Git operation metadata survives reopening without changing business revision', async t => {
  const { root, store } = await fixture(t)
  const before = await store.snapshot()
  const operation = { version: 1 as const, id: 'operation-1', expectedHead: 'a'.repeat(40), repositoryId: 1,
    repository: 'owner/repo', branch: 'main', directory: '', authorId: 2, requestHash: 'b'.repeat(64),
    writes: [{ path: 'dss-coop/state/A/T/Planner', sha256: 'c'.repeat(64) }] }
  await store.operations.save({ operation })
  const after = await store.snapshot()
  assert.equal(after.revision, before.revision)
  await before.release(); await after.release(); await store.close()
  const reopened = await LocalFiles.open(root)
  try { assert.deepEqual(await reopened.operations.get(operation.id), { operation }) }
  finally { await reopened.close() }
})
test('path traversal and duplicate transaction paths fail without writing', async t => {
  const { store } = await fixture(t)
  for (const path of ['../x', '/x', 'x//y', 'x/../y', 'x\\y']) assert.throws(() => filePath(path))
  await withSnapshot(store, async snapshot => {
    await assert.rejects(store.commit(snapshot, [{ path: 'x', content: '1' }, { path: 'x', content: '2' }], 'duplicate'), /same path/)
    assert.deepEqual(await store.list(snapshot, ''), [])
  })
})

// Adapter seam tests: they check orchestration, not remote GitHub behavior.
import { GitFiles, FilesOutcomeUnknownError, type GitOperationRecord, type GitOperationStore } from '../src/framework/transactions.js'
import { GitCommitOutcomeUnknownError, type GitCommitOperation, type GitHubRepository } from '../src/experimental/private-git/git-repository.js'
import { GitConflictError } from '../src/experimental/private-git/github.js'
function gitFixture() {
  const records = new Map<string, GitOperationRecord>()
  const operation: GitCommitOperation = { version: 1, id: 'same-op', expectedHead: 'h', repositoryId: 1,
    repository: 'a/b', branch: 'main', directory: '', authorId: 2, requestHash: 'hash', writes: [] }
  const snapshot = { head: 'h', tree: 'tree', files: new Map() }
  let prepareCount = 0, dispatchCount = 0, failure: unknown, saveFailure = false
  const operations: GitOperationStore = {
    save: async record => { if (saveFailure) throw new Error('metadata persistence failed'); records.set(record.operation.id, structuredClone(record)) },
    get: async id => records.get(id), list: async () => [...records.values()],
  }
  const repository = {
    snapshot: async () => snapshot,
    prepareCommit: () => { prepareCount++; return operation },
    at: async (revision: string) => { assert.equal(revision, operation.expectedHead); return snapshot },
    commitPrepared: async (_base: unknown, _changes: unknown, _message: string, supplied: GitCommitOperation) => {
      dispatchCount++; assert.deepEqual(supplied, operation); assert.ok(records.has(operation.id), 'persist before dispatch')
      if (failure) throw failure
      return { commit: 'confirmed', replay: false }
    },
    resolveCommit: async () => ({ status: 'pending', head: 'h' }),
  } as unknown as GitHubRepository
  return { files: new GitFiles(repository, operations), operation, records,
    fail: (error: unknown) => { failure = error }, failSave: () => { saveFailure = true },
    counts: () => ({ prepareCount, dispatchCount }) }
}
test('Git adapter preserves the original operation identity across unknown and explicit retry', async () => {
  const f = gitFixture(), snapshot = await f.files.snapshot()
  f.fail(new GitCommitOutcomeUnknownError(f.operation))
  await assert.rejects(f.files.commit(snapshot, [{ path: 'tasks/a_P.md', content: 'a' }], 'submit'),
    error => error instanceof FilesOutcomeUnknownError && error.operationId === 'same-op')
  assert.deepEqual(await f.files.resolve('same-op'), { status: 'pending', head: 'h' })
  f.fail(undefined)
  const result = await f.files.retryPrepared('same-op', [{ path: 'tasks/a_P.md', content: 'a' }], 'submit')
  assert.equal(result.operationId, 'same-op')
  assert.deepEqual(f.counts(), { prepareCount: 1, dispatchCount: 2 })
  await snapshot.release()
})
test('Git adapter never dispatches after operation metadata persistence fails', async () => {
  const f = gitFixture(), snapshot = await f.files.snapshot()
  f.failSave()
  await assert.rejects(f.files.commit(snapshot, [{ path: 'tasks/a_P.md', content: 'a' }], 'submit'), /metadata persistence failed/)
  assert.equal(f.counts().dispatchCount, 0)
  await snapshot.release()
})
test('Git adapter passes conflicts back without automatically preparing a new operation', async () => {
  const f = gitFixture(), snapshot = await f.files.snapshot()
  f.fail(new GitConflictError())
  await assert.rejects(f.files.commit(snapshot, [{ path: 'tasks/a_P.md', content: 'a' }], 'submit'), FilesConflictError)
  assert.deepEqual(f.counts(), { prepareCount: 1, dispatchCount: 1 })
  await snapshot.release()
})
test('confirmed Git commit with receipt persistence failure exposes known confirmation', async () => {
  const f = gitFixture(), snapshot = await f.files.snapshot()
  const save = f.files.operations.save
  f.files.operations.save = async record => { if (record.resolution) throw new Error('receipt save failed'); await save(record) }
  await assert.rejects(f.files.commit(snapshot, [{ path: 'tasks/a_P.md', content: 'a' }], 'submit'), error =>
    error instanceof FilesOutcomeUnknownError && error.operationId === 'same-op' && error.confirmed?.revision === 'confirmed')
  assert.ok(f.records.has('same-op'))
  await snapshot.release()
})

test('file/directory collisions roll back but explicit file-to-directory replacement is atomic', async t => {
  const { store } = await fixture(t)
  await withSnapshot(store, snapshot => store.commit(snapshot, [{ path: 'task-runs/T', content: 'file' }], 'file'))
  await withSnapshot(store, async snapshot => {
    await assert.rejects(store.commit(snapshot, [{ path: 'task-runs/T/Memory.md', content: 'child' }], 'invalid'), /parent directory/)
    await store.commit(snapshot, [{ path: 'task-runs/T', content: null }, { path: 'task-runs/T/Memory.md', content: 'child' }], 'replace')
  })
  await withSnapshot(store, async snapshot => {
    assert.equal(await store.read(snapshot, 'task-runs/T'), undefined)
    assert.equal(await store.read(snapshot, 'task-runs/T/Memory.md'), 'child')
    await assert.rejects(store.commit(snapshot, [{ path: 'task-runs/T', content: 'file again' }], 'invalid'), /contains files/)
  })
})

import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
for (const crashAt of ['inside-transaction', 'after-commit'] as const) test(`actual LocalFiles process interruption ${crashAt} reopens atomically`, async t => {
  const { root, store } = await fixture(t)
  await store.close()
  const runner = join(root, 'crash-runner.mjs')
  const sourceFile = join(process.cwd(), 'src/framework/local-files.ts')
  await build({ stdin: { contents: `
    import { LocalFiles } from ${JSON.stringify(sourceFile)};
    const store = await LocalFiles.open(${JSON.stringify(root)});
    const snapshot = await store.snapshot();
    if (${JSON.stringify(crashAt)} === 'inside-transaction') {
      store.writer.function('interrupt_process', () => process.exit(73));
      store.writer.exec("CREATE TRIGGER crash_point BEFORE INSERT ON files WHEN NEW.path='state/A/T/Planner_Worker' BEGIN SELECT interrupt_process(); END;");
    }
    await store.commit(snapshot, [
      { path: 'task-runs/T/A/Reply.md', content: 'completed work' },
      { path: 'state/A/T/Planner_Worker', content: '' }
    ], 'handoff');
    process.exit(74);
  `, resolveDir: process.cwd(), sourcefile: 'crash-fixture.ts', loader: 'ts' }, outfile: runner,
    bundle: true, platform: 'node', format: 'esm', target: 'node22' })
  const child = spawnSync(process.execPath, [runner], { encoding: 'utf8' })
  assert.equal(child.status, crashAt === 'inside-transaction' ? 73 : 74, child.stderr)
  const reopened = await LocalFiles.open(root)
  try { await withSnapshot(reopened, async snapshot => {
    const expected = crashAt === 'after-commit'
    assert.equal(await reopened.read(snapshot, 'task-runs/T/A/Reply.md'), expected ? 'completed work' : undefined)
    assert.equal(await reopened.read(snapshot, 'state/A/T/Planner_Worker'), expected ? '' : undefined)
  }) } finally { await reopened.close() }
})

test('both adapters accept an explicitly requested empty technical commit', async t => {
  const { store } = await fixture(t)
  await withSnapshot(store, async snapshot => {
    const receipt = await store.commit(snapshot, [], 'empty')
    assert.notEqual(receipt.revision,snapshot.revision)
    const after = await store.snapshot()
    assert.deepEqual(await store.list(after,''),[])
    await after.release()
  })
  const f = gitFixture(), snapshot = await f.files.snapshot()
  await f.files.commit(snapshot, [], 'empty')
  assert.deepEqual(f.counts(), { prepareCount: 1, dispatchCount: 1 })
  await snapshot.release()
})
test('Local direct directory listing excludes other member/task subtrees', async t => {
  const { store } = await fixture(t)
  await withSnapshot(store, snapshot => store.commit(snapshot, [
    { path: 'state/Foreground_A-Time', content: '' },
    { path: 'state/Direct-Worker', content: '' },
    { path: 'state/B/T/Planner_Worker', content: '' },
    { path: 'state/A_1/T/Planner_Worker', content: '' },
    { path: 'root.md', content: 'root' },
  ], 'signals'))
  await withSnapshot(store, async snapshot => {
    assert.deepEqual((await store.listDirectory(snapshot, 'state')).map(entry => entry.path), [
      'state/Direct-Worker', 'state/Foreground_A-Time',
    ])
    assert.deepEqual((await store.listDirectory(snapshot, '')).map(entry => entry.path), ['root.md'])
    assert.deepEqual((await store.listDirectory(snapshot, 'state/A_1/T')).map(entry => entry.path), ['state/A_1/T/Planner_Worker'])
    assert.deepEqual(await store.listDirectory(snapshot, 'absent'), [])
  })
})
test('Git direct directory adapter uses only the nonrecursive repository endpoint and returns blobs', async () => {
  const calls: string[] = []
  const repository = {
    snapshot: async () => ({ head: 'h', tree: 't', files: new Map() }),
    listDirectory: async (_snapshot: unknown, prefix: string) => {
      calls.push(prefix)
      return [
        { path: 'dss-coop/state/Foreground_A', sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', type: 'blob', size: 0 },
        { path: 'dss-coop/state/B', sha: 'tree', type: 'tree' },
        { path: 'dss-coop/state/link', sha: 'commit', type: 'commit' },
      ]
    },
    list: async () => { throw new Error('recursive listing must not be used') },
    read: async () => { throw new Error('business bodies must not be read') },
  } as unknown as GitHubRepository
  const operations: GitOperationStore = { save: async () => {}, get: async () => undefined, list: async () => [] }
  const files = new GitFiles(repository, operations), snapshot = await files.snapshot()
  assert.deepEqual(await files.listDirectory(snapshot, 'state/'), [
    { path: 'state/Foreground_A', version: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', bytes: 0, empty: true },
  ])
  assert.deepEqual(calls, ['dss-coop/state/'])
  await snapshot.release()
})

test('binary deliverables round-trip byte-for-byte with metadata and atomic notification after reopen', async t => {
  const { root, store } = await fixture(t)
  const bytes = Uint8Array.from([0,255,137,80,78,71,13,10,0,128,254])
  await withSnapshot(store, snapshot => store.commit(snapshot, [
    {path:'archives/T/result.png',bytes}, {path:'state/A/T/Planner_Worker-G2',content:''},
  ], 'binary result'))
  await store.close()
  const reopened = await LocalFiles.open(root)
  try { await withSnapshot(reopened, async snapshot => {
    assert.deepEqual(await reopened.readBytes(snapshot,'archives/T/result.png'),bytes)
    assert.equal((await reopened.listDirectory(snapshot,'archives/T'))[0]?.bytes,bytes.length)
    assert.equal(await reopened.read(snapshot,'state/A/T/Planner_Worker-G2'),'')
    await assert.rejects(reopened.read(snapshot,'archives/T/result.png'), /encoded data|encoding/i)
    await reopened.commit(snapshot,[{path:'archives/T/result.png',content:'now text'}],'replace representation')
  }); await withSnapshot(reopened,async snapshot => assert.equal(await reopened.read(snapshot,'archives/T/result.png'),'now text')) }
  finally { await reopened.close() }
})
test('binary column migration preserves the actual earlier Local schema and text versions', async t => {
  const root = await mkdtemp(join(tmpdir(),'dss-files-old-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  const old = new DatabaseSync(join(root,'dss-files.sqlite'))
  old.exec("CREATE TABLE files(path TEXT PRIMARY KEY, content TEXT NOT NULL, version TEXT NOT NULL, bytes INTEGER NOT NULL) STRICT; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;")
  old.prepare('INSERT INTO files VALUES (?,?,?,?)').run('tasks/existing_P.md','旧正文','preserved-version',9)
  old.prepare('INSERT INTO metadata VALUES (?,?)').run('head','previous-head'); old.close()
  const migrated = await LocalFiles.open(root)
  try { await withSnapshot(migrated,async snapshot => {
    assert.equal(snapshot.revision,'previous-head')
    assert.equal(await migrated.read(snapshot,'tasks/existing_P.md'),'旧正文')
    assert.equal((await migrated.listDirectory(snapshot,'tasks'))[0]?.version,'preserved-version')
    await migrated.commit(snapshot,[{path:'archives/T/archive.zip',bytes:Uint8Array.from([80,75,255])}],'new binary')
  }) } finally { await migrated.close() }
})
