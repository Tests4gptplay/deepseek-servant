import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { baselineFixture as fixture, baselineChildSpec as childSpec } from './legacy-baseline.js'
import { MemoryStorage } from './support.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { migrateFrameworkStorage } from '../src/framework/migration-lifecycle.js'
import { captureLocalLegacy, type MigrationManifest } from '../src/framework/legacy-migration.js'
import { GitFiles, FilesOutcomeUnknownError, withSnapshot } from '../src/framework/transactions.js'

// Real legacy production writers and SQLite target; no GitHub/credential/network adapter.
async function target(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-cutover-'))
  let files = await LocalFiles.open(directory)
  const records = new MemoryStorage()
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  const input = (source = records) => ({ mode: 'local' as const, scope: 'local-cutover', files,
    transactions: new FrameworkTransactions(files, records, 'local-cutover'), records, localSource: source,
    options: (_capture: unknown, id: string) => ({ id, owner: 'alice', members: { assistant: 'alice' } }) })
  return { get files() { return files }, records, input,
    reopen: async () => { await files.close(); files = await LocalFiles.open(directory) } }
}
async function manifest(files: LocalFiles, path: string): Promise<MigrationManifest> {
  return withSnapshot(files, async snapshot => JSON.parse((await files.read(snapshot, path))!))
}
test('fresh storage marks no-op migration without creating artificial tasks or plans', async t => {
  const f = await target(t)
  await f.records.set('framework-observations/current', { stage: 1 })
  const result = await migrateFrameworkStorage(f.input())
  assert.deepEqual(result, { verified: true, complete: true })
  await withSnapshot(f.files, async snapshot => assert.deepEqual(await f.files.list(snapshot, ''), []))
  const saved = (await f.records.list<any>('framework-cutovers/'))[0]!.value
  assert.equal(saved.localPlan, undefined)
})
test('actual legacy paused task remains readable and does not become a new runnable task', async t => {
  const old = await fixture('Keep the exact original paused requirement')
  assert.equal((await old.execute({ type: 'task.control', intent: 'pause' }, { kind: 'user', id: 'user' })).status, 'applied')
  const original = await old.get(), before = JSON.stringify([...old.storage.data]), f = await target(t)
  const result = await migrateFrameworkStorage(f.input(old.storage)), saved = await manifest(f.files, result.manifestPath!)
  assert.equal(result.verified, true); assert.equal(result.complete, false)
  assert.equal(saved.tasks[0]!.continuation, 'paused')
  await withSnapshot(f.files, async snapshot => {
    assert.deepEqual(JSON.parse((await f.files.read(snapshot, saved.tasks[0]!.recordPath))!), original)
    assert.deepEqual(await f.files.listDirectory(snapshot, 'tasks/'), [])
    assert.deepEqual(await f.files.list(snapshot, 'state/'), [])
  })
  assert.equal(JSON.stringify([...old.storage.data]), before)
})
test('real SQLite COMMIT then lost acknowledgement resumes the same durable migration after reopening', async t => {
  const old = await fixture('Original source and deliverable references survive replay')
  const planner = await old.bind('plan')
  assert.equal((await old.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Preserve existing output', children: [childSpec()] }, planner.source)).status, 'applied')
  const worker = await old.bind('dispatch'), bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 255])
  const sourcePath = '/authorized-fixture/existing.png'
  assert.equal((await old.execute({ type: 'execution.report', report: { resultId: 'existing-result', assignmentVersion: 1, outcome: 'handoff', summary: 'Existing actual report',
    artifacts: [{ id: 'existing-artifact', path: sourcePath, description: 'Preserved original bytes', sha256: createHash('sha256').update(bytes).digest('hex') }], evidence: ['Existing evidence'], frontier: 'Continue remaining part', checkpoint: { completed: ['First part'], failedApproaches: [], remaining: ['Next part'], nextAction: 'Read original output', nextReads: ['existing-artifact'] } } }, worker.source)).status, 'applied')
  const before = JSON.stringify([...old.storage.data]), f = await target(t), commit = f.files.commit.bind(f.files)
  const input = () => ({ ...f.input(old.storage), options: (_capture: unknown, id: string) => ({ id, owner: 'alice', members: { assistant: 'alice' }, artifacts: [{ sourcePath, bytes }] }) })
  let lose = true
  f.files.commit = async (...args) => { const receipt = await commit(...args); if (lose) { lose = false; throw new FilesOutcomeUnknownError('lost-cutover-ack', undefined, receipt) } return receipt }
  await assert.rejects(migrateFrameworkStorage(input()), FilesOutcomeUnknownError)
  const pending = (await f.records.list<any>('framework-cutovers/'))[0]!.value
  assert.ok(pending.localPlan)
  assert.equal(pending.options.artifacts, undefined)
  assert.deepEqual(pending.artifacts, [{ sourcePath, sha256: createHash('sha256').update(bytes).digest('hex') }])
  assert.ok(pending.localPlan.changes.some((change: any) => change.base64 === Buffer.from(bytes).toString('base64')), 'only the Local plan may retain captured Local bytes')
  const commandBefore = (await f.records.list<any>('framework-commands/')).map(row => ({ key: row.key, id: row.value.id, requestHash: row.value.requestHash }))
  const originalId = pending.id, firstManifest = await manifest(f.files, pending.localPlan.manifestPath)
  const firstPaths = await withSnapshot(f.files, snapshot => f.files.list(snapshot, ''))
  await f.reopen()
  const result = await migrateFrameworkStorage(input()), recovered = await manifest(f.files, result.manifestPath!)
  assert.equal(recovered.id, originalId)
  assert.deepEqual((await f.records.list<any>('framework-commands/')).map(row => ({ key: row.key, id: row.value.id, requestHash: row.value.requestHash })), commandBefore)
  assert.deepEqual(recovered.tasks, firstManifest.tasks)
  assert.equal(recovered.references[sourcePath], firstManifest.references[sourcePath])
  await withSnapshot(f.files, async snapshot => assert.deepEqual(await f.files.readBytes(snapshot, recovered.references[sourcePath]!), bytes))
  assert.deepEqual((await withSnapshot(f.files, snapshot => f.files.list(snapshot, ''))).map(entry => entry.path), firstPaths.map(entry => entry.path))
  assert.equal((await f.records.list<any>('framework-cutovers/'))[0]!.value.localPlan, undefined)
  assert.equal(JSON.stringify([...old.storage.data]), before)
  assert.deepEqual(await migrateFrameworkStorage(input()), result)
})
test('new framework technical writes in the shared StoragePort do not alter captured legacy revision', async t => {
  const old = await fixture('Capture only fixed legacy record families'), f = await target(t)
  const before = await captureLocalLegacy(old.storage)
  await old.storage.set('framework-cutovers/technical', { expectedRevision: 'technical-only' })
  await old.storage.set('framework-observations/execution', { lastProgressAt: 123 })
  assert.equal((await captureLocalLegacy(old.storage)).revision, before.revision)
  const result = await migrateFrameworkStorage({ ...f.input(old.storage), records: old.storage,
    transactions: new FrameworkTransactions(f.files, old.storage, 'same-record-port') })
  assert.equal(result.verified, true)
  assert.equal((await captureLocalLegacy(old.storage)).revision, before.revision)
})
test('failed migration publication leaves actual source and target business files untouched', async t => {
  const old = await fixture('Never mutate old data after failed cutover'), before = JSON.stringify([...old.storage.data]), f = await target(t)
  f.files.commit = async () => { throw new Error('Controlled durable storage failure') }
  await assert.rejects(migrateFrameworkStorage(f.input(old.storage)), /Controlled durable storage failure/)
  assert.equal(JSON.stringify([...old.storage.data]), before)
  await withSnapshot(f.files, async snapshot => assert.deepEqual(await f.files.list(snapshot, ''), []))
  assert.ok((await f.records.list<any>('framework-cutovers/'))[0]!.value.localPlan, 'retain original planned identity instead of recreating a migration')
})

test('migration awaits asynchronous authorized options before preparing or publishing a plan', async t => {
  const old = await fixture('Await the actual options capability'), f = await target(t)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const operation = migrateFrameworkStorage({ ...f.input(old.storage), options: async (_capture, id) => {
    entered.resolve(); await release.promise; return { id, owner: 'alice', members: { assistant: 'alice' } }
  } })
  await entered.promise
  assert.deepEqual(await f.records.list('framework-cutovers/'), [])
  await withSnapshot(f.files, async snapshot => assert.deepEqual(await f.files.list(snapshot, ''), []))
  release.resolve()
  assert.equal((await operation).verified, true)
})
test('Git cutover stores only artifact hashes and reconstructs the original H before retrying the same plan', async () => {
  // Deliberately isolated coordinator seam: real GitFiles snapshot mapping, controlled
  // repository read port and interrupted transaction port. This is NOT HTTP/public Git validation.
  const body = 'REMOTE_BUSINESS_BODY_NOT_FOR_LOCAL_METADATA', bytes = Uint8Array.from([137, 80, 0, 255]), sourcePath = '/authorized/artifact.png'
  const records = new MemoryStorage(), revisions: string[] = [], dispatches: any[] = []
  let head = 'original-H'
  const content = new Map([['dss-coop/inbox/legacy.md', body]])
  const nativeSnapshot = (revision: string) => ({ head: revision, files: new Map([...content].map(([path, text]) => [path, createHash('sha1').update(text).digest('hex')])) })
  const repository = {
    snapshot: async () => nativeSnapshot(head), at: async (revision: string) => { revisions.push(revision); return nativeSnapshot(revision) },
    list: async () => {}, listDirectory: async () => [],
    read: async (_snapshot: unknown, path: string) => content.get(path),
    readBytes: async (_snapshot: unknown, path: string) => content.has(path) ? Buffer.from(content.get(path)!) : undefined,
  }
  const files = new GitFiles(repository as any, { save: async () => {}, get: async () => undefined, list: async () => [] })
  const transactions = { run: async (id: string, request: unknown, options: unknown) => {
    dispatches.push({ id, request, options }); throw new FilesOutcomeUnknownError('original-operation')
  } } as unknown as FrameworkTransactions
  let supplied: typeof bytes | undefined = bytes
  const input = { mode: 'git' as const, scope: 'git-scope', files, transactions, records,
    options: async (_capture: unknown, id: string) => ({ id, owner: 'alice', members: {}, ...(supplied ? { artifacts: [{ sourcePath, bytes: supplied }] } : {}) }) }
  await assert.rejects(migrateFrameworkStorage(input), FilesOutcomeUnknownError)
  const pending = (await records.list<any>('framework-cutovers/'))[0]!.value
  assert.equal(pending.localPlan, undefined)
  assert.equal(pending.options.artifacts, undefined)
  assert.deepEqual(pending.artifacts, [{ sourcePath, sha256: createHash('sha256').update(bytes).digest('hex') }])
  assert.ok(!JSON.stringify([...records.data]).includes(body))
  assert.ok(!JSON.stringify([...records.data]).includes(Buffer.from(bytes).toString('base64')))
  head = 'later-H'; supplied = undefined
  await assert.rejects(migrateFrameworkStorage(input), /artifact bytes are unavailable or changed/)
  assert.equal(dispatches.length, 1, 'missing original authorized bytes must not dispatch a replacement plan')
  supplied = Uint8Array.from([1, 2, 3])
  await assert.rejects(migrateFrameworkStorage(input), /artifact bytes are unavailable or changed/)
  assert.equal(dispatches.length, 1)
  supplied = bytes
  await assert.rejects(migrateFrameworkStorage(input), FilesOutcomeUnknownError)
  assert.deepEqual(dispatches[1], dispatches[0], 'reconstructed command and request remain identical')
  assert.ok(revisions.length >= 3 && revisions.every(revision => revision === 'original-H'))
  assert.equal((await records.list<any>('framework-cutovers/'))[0]!.value.id, pending.id)
})
