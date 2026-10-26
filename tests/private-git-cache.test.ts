import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CoopCache, CONVERSATION_CACHE_LIMIT } from '../src/experimental/private-git/cache.js'
import { CoopSettingsSchema, type RepoConnection } from '../src/experimental/private-git/contracts.js'
import { releaseArchivedTaskCaches, releaseScopeCaches } from '../src/experimental/private-git/cache-cleanup.js'
import { CoopService } from '../src/experimental/private-git/service.js'
import { GitHubClient } from '../src/experimental/private-git/github.js'
import type { CoopCredentials } from '../src/experimental/private-git/credentials.js'

function storage() {
  const records = new Map<string, unknown>()
  let global = { instanceId: 'cache-test', settings: CoopSettingsSchema.parse({ ownerRepo: 'example/private' }) }
  let enumerations = 0, denyDelete = false
  const table = {
    get: (key: string) => records.get(key),
    put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)) },
    delete: async (key: string) => { if (denyDelete) throw new Error('cache cleanup temporarily unavailable'); return records.delete(key) },
    entries: () => { enumerations++; return records.entries() },
  }
  const context = { storageDomain: { open: async () => ({
    global: { get: () => global, set: async (value: typeof global) => { global = value } },
    table: () => table, close: async () => {},
  }) } } as unknown as Context
  const connection: RepoConnection = { identity: { id: 1, login: 'test' }, repository: { id: 77, fullName: 'example/private', branch: 'main', private: true, permissions: { pull: true, push: true, admin: true } } }
  records.set('connection', connection)
  return { context, records, get enumerations() { return enumerations }, set denyDelete(value: boolean) { denyDelete = value } }
}

async function message(cache: CoopCache, id: string) {
  await cache.put('message-header/' + id, { id })
  await cache.put('message-view/' + id, { text: 'Complete message ' + id })
}

test('conversation cache evicts oldest pairs, retains recent reads and leaves pending work intact', async () => {
  const store = storage(), cache = await CoopCache.open(store.context)
  await cache.put('user-source/pending', { text: 'Unsubmitted original request' })
  await cache.put('draft/pending', { text: 'Unsubmitted original request' })
  for (let n = 0; n < CONVERSATION_CACHE_LIMIT + 20; n++) await message(cache, String(n))
  assert.equal(cache.entries('message-header/').length, CONVERSATION_CACHE_LIMIT)
  assert.equal(cache.entries('message-view/').length, CONVERSATION_CACHE_LIMIT)
  assert.equal(cache.get('message-view/0'), undefined)
  assert.ok(cache.get('message-view/20'))
  await message(cache, 'new')
  assert.ok(cache.get('message-view/20'), 'reading a cached message refreshes its local retention')
  assert.equal(cache.get('message-view/21'), undefined)
  assert.ok(cache.get('user-source/pending'))
  assert.ok(cache.get('draft/pending'))
  assert.equal(store.enumerations, 1, 'prefix reads use the current scope index, not the full cache table')
  await cache.close()
})

test('cache scopes remain separate and legacy excess conversation copies are trimmed on open', async () => {
  const store = storage()
  const seed = (scope: string, key: string, value: unknown) => store.records.set(createHash('sha256').update(scope + key).digest('hex'), { key: scope + key, value })
  for (let n = 0; n < CONVERSATION_CACHE_LIMIT + 7; n++) {
    seed('77/1/', 'message-header/' + n, { id: n })
    seed('77/1/', 'message-view/' + n, { text: 'Git-backed content ' + n })
  }
  seed('77/1/', 'draft/keep', { text: 'Pending' })
  seed('77/1/directory/other/', 'message-view/other', { text: 'Other scope' })
  const cache = await CoopCache.open(store.context)
  assert.equal(cache.entries('message-view/').length, CONVERSATION_CACHE_LIMIT)
  assert.ok(cache.get('draft/keep'))
  await cache.configure({ ...cache.settings, repositoryDirectory: 'other' })
  assert.deepEqual(cache.entries('message-view/').map(([key]) => key), ['message-view/other'])
  assert.equal(cache.get('draft/keep'), undefined)
  await cache.configure({ ...cache.settings, repositoryDirectory: 'dss-coop' })
  assert.ok(cache.get('draft/keep'))
  await cache.close()
})

test('scope change cleans the previous directory rather than the new directory', async () => {
  const store = storage(), cache = await CoopCache.open(store.context)
  await cache.put('projection', { messages: ['Old directory'] })
  await message(cache, 'old')
  await cache.put('consumed-input/keep', { textHash: 'compact-progress' })
  await cache.configure({ ...cache.settings, repositoryDirectory: 'next' })
  await cache.put('projection', { messages: ['New directory'] })
  await message(cache, 'new')
  await cache.configure({ ...cache.settings, repositoryDirectory: 'dss-coop' })
  const connection = cache.connection()!
  const service = new CoopService(cache, { describe: async () => ({ configured: true }) } as unknown as CoopCredentials, new GitHubClient(async () => undefined))
  await service.configure({ repositoryDirectory: 'next' })
  await cache.put('connection', connection)
  assert.deepEqual(cache.get('projection'), { messages: ['New directory'] })
  assert.ok(cache.get('message-view/new'))
  await cache.configure({ ...cache.settings, repositoryDirectory: 'dss-coop' })
  assert.equal(cache.get('projection'), undefined)
  assert.equal(cache.get('message-view/old'), undefined)
  assert.ok(cache.get('consumed-input/keep'))
  await cache.close()
})

test('cleanup preserves drafts and keeps a task pointer when exact deletion fails', async () => {
  const store = storage(), cache = await CoopCache.open(store.context)
  await cache.put('grant/one', { taskId: 'one', sourceIntentId: 'input-one' })
  await cache.put('proof/dss-coop/tasks/one/result.json', 'one')
  await cache.put('proof/dss-coop/tasks/two/result.json', 'two')
  await cache.put('draft/pending', { payload: 'Must remain' })
  await message(cache, 'derived')
  store.denyDelete = true
  const failed = await releaseArchivedTaskCaches(cache, 'one')
  assert.ok(failed.failed.length)
  assert.ok(cache.get('grant/one'), 'the next normal consume can retry this exact task')
  store.denyDelete = false
  const completed = await releaseArchivedTaskCaches(cache, 'one')
  assert.equal(completed.failed.length, 0)
  assert.equal(cache.get('grant/one'), undefined)
  assert.equal(cache.get('proof/dss-coop/tasks/one/result.json'), undefined)
  assert.ok(cache.get('proof/dss-coop/tasks/two/result.json'))
  await releaseScopeCaches(cache)
  assert.equal(cache.get('message-view/derived'), undefined)
  assert.ok(cache.get('draft/pending'))
  await cache.close()
})

test('a failed cache eviction does not reject a valid read or new message', async () => {
  const store = storage(), cache = await CoopCache.open(store.context)
  for (let n = 0; n < CONVERSATION_CACHE_LIMIT; n++) await message(cache, String(n))
  store.denyDelete = true
  const previous = console.error, reports: unknown[][] = []
  console.error = (...args: unknown[]) => { reports.push(args) }
  try {
    await message(cache, 'retry-1')
    await message(cache, 'retry-2')
    assert.ok(cache.get('message-view/retry-2'))
    assert.equal(reports.length, 1, 'unchanged cleanup errors are not logged on every message')
    store.denyDelete = false
    await message(cache, 'recovered')
    assert.equal(cache.entries('message-view/').length, CONVERSATION_CACHE_LIMIT)
  } finally { console.error = previous; await cache.close() }
})
