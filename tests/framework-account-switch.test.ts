import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { InstanceRegistration, loadOrCreateInstanceUuid } from '../src/framework/instances.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { GitFiles, FilesOutcomeUnknownError, withSnapshot, type GitOperationRecord, type GitOperationStore } from '../src/framework/transactions.js'
import { GitHubRepository } from '../src/experimental/private-git/git-repository.js'
import { GitHubClient } from '../src/experimental/private-git/github.js'
import { openFrameworkConnection } from '../src/framework/connection.js'
import { MemoryStorage } from './support.js'

// Regression of the independently reproduced identity bug. No real account,
// credential lookup or network. Account changes preserve all original records.
const scope = JSON.stringify(['git', 77, 'main', 'Workspace'])
test('explicit account B cannot publish under account A member identity on the same Host UUID', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dss-account-switch-')), files = await LocalFiles.open(directory), storage = new MemoryStorage()
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  const uuid = await loadOrCreateInstanceUuid(storage)
  const create = (login: string, accountId: number | string) => new InstanceRegistration(files, new FrameworkTransactions(files, storage, scope), storage,
    { repositoryId: scope, repositoryOwner: 'alice', login, accountId, instanceUUID: uuid, workerSeats: 2 }, () => 0)
  const a = create('alice', 101), first = await a.register()
  await a.disconnect()
  const before = await withSnapshot(files, snapshot => files.read(snapshot, first.path))
  const priorRecords = structuredClone([...storage.data]), priorWrites = storage.writes.length
  const b = create('bob', 202)
  await assert.rejects(b.register(), /account-changed/)
  await assert.rejects(b.tick(), /account-changed/)
  await assert.rejects(b.disconnect(), /account-changed/)
  const after = await withSnapshot(files, snapshot => files.read(snapshot, first.path))
  assert.equal(await loadOrCreateInstanceUuid(storage), uuid, 'the physical instance UUID remains unchanged')
  assert.equal(JSON.parse(before!).status, 'stopped')
  assert.equal(after, before, 'changed account does not alter original heartbeat')
  assert.equal(storage.writes.length, priorWrites, 'no pending/alias/account rewrite')
  assert.deepEqual([...storage.data], priorRecords)
  const returned = await create('alice', '101').register()
  assert.equal(returned.member, first.member)
  assert.equal(returned.primary, true)
  await withSnapshot(files, async snapshot => {
    const heartbeat = JSON.parse((await files.read(snapshot, first.path))!)
    assert.equal(heartbeat.status, 'running')
    assert.equal(heartbeat.accountId, undefined, 'account identity is local technical metadata only')
  })
})

class IdentityTransport {
  account = { id: 101, login: 'alice' }
  inaccessible = false
  empty = false
  writes = 0
  readonly calls: Array<{ method: string; path: string }> = []
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url), method = init?.method ?? 'GET', path = parsed.pathname
    assert.equal(parsed.origin, 'https://api.github.com')
    this.calls.push({ method, path })
    if (this.inaccessible) throw new Error('synthetic verification outage')
    if (path === '/user') return Response.json(this.account)
    if (path === '/repos/alice/private') return Response.json({ id: 77, full_name: 'alice/private', private: true, default_branch: 'main', permissions: { pull: true, push: true } })
    if (path === '/repos/alice/private/branches') return Response.json(this.empty ? [] : [{ name: 'main' }])
    if (path === '/repos/alice/private/commits/heads/main') {
      assert.equal(new Headers(init?.headers).get('accept'), 'application/vnd.github.sha')
      if (this.empty) return Response.json({ message: 'not found' }, { status: 404 })
      const sha = 'a'.repeat(40)
      return new Headers(init?.headers).get('if-none-match') === `"${sha}"`
        ? new Response(null, { status: 304 }) : new Response(sha + '\n')
    }
    if (this.empty && path === '/repos/alice/private/git/ref/heads/main') return Response.json({ message: 'not found' }, { status: 404 })
    if (path === '/repos/alice/private/git/ref/heads/main') return Response.json({ object: { sha: 'a'.repeat(40) } })
    if (path === '/repos/alice/private/git/commits/' + 'a'.repeat(40)) return Response.json({ sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) }, parents: [], message: 'initial' })
    if (path === '/repos/alice/private/git/trees/' + 'b'.repeat(40)) return Response.json({ tree: [], truncated: false })
    if (method === 'POST' && path === '/graphql') { this.writes++; this.inaccessible = true; throw new Error('synthetic lost mutation response') }
    throw new Error('Unexpected synthetic HTTP request: ' + method + ' ' + path)
  }
}
test('Git operation author guard independently protects an old no-account-ID pending publication', async () => {
  const transport = new IdentityTransport(), storage = new MemoryStorage(), uuid = await loadOrCreateInstanceUuid(storage)
  const operations = new Map<string, GitOperationRecord>()
  const operationStore: GitOperationStore = { save: async value => { operations.set(value.operation.id, structuredClone(value)) },
    get: async id => structuredClone(operations.get(id)), list: async () => [...operations.values()].map(value => structuredClone(value)) }
  const repositories: GitHubRepository[] = []
  const create = async () => {
    const client = new GitHubClient(async () => ({ value: 'synthetic-not-a-secret', source: 'test' }), (url, init) => transport.fetch(url, init))
    let binding: any = { ownerRepo: 'alice/private', repositoryDirectory: 'Workspace' }
    const repository = new GitHubRepository(client, () => binding); repositories.push(repository)
    const connected = await repository.connect()
    binding = { ...binding, repositoryId: 77, participantId: connected.identity.id, branch: 'main' }
    const files = new GitFiles(repository, operationStore)
    return new InstanceRegistration(files, new FrameworkTransactions(files, storage, scope), storage,
      { repositoryId: scope, repositoryOwner: 'alice', login: connected.identity.login, instanceUUID: uuid, workerSeats: 2 }, () => 0)
  }
  try {
    const a = await create()
    await assert.rejects(a.register(), FilesOutcomeUnknownError)
    assert.equal(transport.writes, 1)
    const saved = (await storage.list<any>('framework-instance/'))[0]!
    assert.equal(saved.value.pending.registration.member, 'alice')
    const originalOperation = structuredClone([...operations.values()][0]!.operation)
    assert.equal(originalOperation.authorId, 101)
    transport.account = { id: 202, login: 'bob' }; transport.inaccessible = false
    const b = await create()
    await assert.rejects(b.register(), FilesOutcomeUnknownError)
    assert.equal(transport.writes, 1, 'no second GraphQL mutation under the new identity')
    assert.deepEqual(await storage.get(saved.key), saved.value, 'no reset/delete/rename of A pending publication')
    assert.deepEqual([...operations.values()][0]!.operation, originalOperation)
    const resolution = [...operations.values()][0]!.resolution
    assert.equal(resolution?.status, 'unknown')
    if (resolution?.status === 'unknown') assert.match(resolution.reason!, /account changed/)
    assert.equal(await loadOrCreateInstanceUuid(storage), uuid)
  } finally { for (const repository of repositories) await repository.releaseCache() }
})


test('actual connection rejects a changed account before any empty-branch bootstrap mutation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dss-account-preflight-')), files = await LocalFiles.open(directory), storage = new MemoryStorage()
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  const uuid = await loadOrCreateInstanceUuid(storage)
  const original = new InstanceRegistration(files, new FrameworkTransactions(files, storage, scope), storage,
    { repositoryId: scope, repositoryOwner: 'alice', login: 'alice', accountId: 101, instanceUUID: uuid, workerSeats: 2 })
  await original.register()
  const before = structuredClone(await storage.list('framework-instance/'))
  const transport = new IdentityTransport()
  transport.account = { id: 202, login: 'bob' }; transport.empty = true
  await assert.rejects(openFrameworkConnection({ mode: 'git', ownerRepo: 'alice/private', repositoryDirectory: 'Workspace', workerSeats: 2 }, {
    storage, credentials: { resolve: async () => ({ value: 'synthetic-not-a-secret', source: 'test' }) },
    fetch: (url, init) => transport.fetch(url, init),
  }), /account-changed/)
  assert.ok(transport.calls.length > 0, 'actual authorization/account discovery ran')
  assert.ok(transport.calls.every(call => call.method === 'GET'), 'not even a technical bootstrap write precedes rejection')
  assert.deepEqual(await storage.list('framework-instance/'), before)
  assert.equal(await loadOrCreateInstanceUuid(storage), uuid)
})
