import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoopSettingsSchema, type CoopSettings, type PendingDraft, type RepoConnection, type UserIntent } from '../src/experimental/private-git/contracts.js'
import type { CoopStore } from '../src/experimental/private-git/cache.js'
import { GitHubClient } from '../src/experimental/private-git/github.js'
import { GitHubRepository } from '../src/experimental/private-git/git-repository.js'
import { CoopService } from '../src/experimental/private-git/service.js'
import { SharedForeground } from '../src/mode-router/shared-foreground.js'
import { createServantSource, type ServantClientApi } from '../src/client/source.js'
import { ServantApi } from '../src/application/api.js'
import { readIntent } from '../src/experimental/private-git/intake.js'
import { runGit } from '../src/experimental/private-git/vendor/git-runner.js'
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve } }
const git = async (cwd: string, args: string[]) => (await runGit('git', args, { cwd })).stdout.trim()
class Store implements CoopStore {
  readonly instanceId = 'send-fixture'; values = new Map<string, unknown>()
  settings = CoopSettingsSchema.parse({ ownerRepo: 'synthetic/send-admission', repositoryDirectory: 'Coop', provider: 'synthetic', model: 'no-model-calls' })
  async configure(v: CoopSettings) { this.settings = v }
  get<T>(k: string) { return this.values.get(k) as T | undefined }
  async put(k: string, v: unknown) { this.values.set(k, structuredClone(v)) }
  async remove(k: string) { this.values.delete(k) }
  entries<T>(prefix: string) { return [...this.values].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]> }
  connection() { return this.get<RepoConnection>('connection') }
  drafts() { return this.entries<PendingDraft>('draft/').map(([, v]) => v) }
  async close() {}
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dss-send-admission-')), remote = join(root, 'remote.git'), caches = join(root, 'cache')
  await mkdir(remote); await git(remote, ['init', '--bare', '--initial-branch=main', '.'])
  const store = new Store(), scope = store.settings.ownerRepo + '/' + store.settings.repositoryDirectory + '/' + store.instanceId
  const cwd = join(caches, createHash('sha256').update(scope).digest('hex').slice(0, 24))
  await mkdir(cwd, { recursive: true }); await git(cwd, ['init', '--bare', '.']); await git(cwd, ['remote', 'add', 'origin', remote])
  const identity = { id: 1, revoked: false }, tokens = async () => ({ value: 'synthetic-fixture-no-secret', source: 'synthetic' })
  const client = new GitHubClient(tokens, async url => {
    if (identity.revoked) return Response.json({ message: 'Fixture access revoked' }, { status: 403 })
    const path = new URL(url).pathname
    if (path === '/user') return Response.json({ id: identity.id, login: 'synthetic' })
    assert.equal(path, '/repos/synthetic/send-admission')
    return Response.json({ id: 77, full_name: store.settings.ownerRepo, private: true, default_branch: 'main', permissions: { pull: true, push: true, admin: true } })
  })
  const repo = new GitHubRepository(client, () => ({ ownerRepo: store.settings.ownerRepo, repositoryDirectory: store.settings.repositoryDirectory, instanceId: store.instanceId, repositoryId: 77, participantId: store.connection()?.identity.id }), tokens, caches)
  const service = new CoopService(store, { resolve: tokens } as any, client)
  Object.defineProperty(service, 'repository', { value: repo })
  let wakes = 0; service.setWake(() => { wakes++ }, () => {})
  await service.connect()
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }) })
  const input = async (id: string) => readIntent(repo, await repo.snapshot(), '1', id)
  const introductions = async (id: string) => Number(await git(remote, ['rev-list', '--count', '--all', '--', 'Coop/intents/1/' + id + '.json']))
  return { root, remote, repo, store, service, identity, input, introductions, wakes: () => wakes }
}
const profile = { settings: { presetId: 'standard', foreground: { provider: 'synthetic', model: 'no-model-calls' } }, workspace: { id: 'test', directory: '/synthetic-workspace' } }

test('Git send uses only assistant profile and confirmed conversation, never Local/task display', { timeout: 30_000 }, async t => {
  const f = await fixture(t), calls: string[] = []
  const local = new ServantApi({ assistants: { foregroundProfile: async (id: string) => { assert.equal(id, 'default'); return profile } }, query: { view: async () => { throw Error('Local display stalled') } } } as any)
  const shared = new SharedForeground({ call: async (method, params, signal) => { calls.push(method); return local.call(method, params, signal ?? new AbortController().signal) } }, async () => f.service, () => 'PRIVATE_GIT_EXPERIMENTAL', () => true)
  const directories = f.repo.directories.bind(f.repo)
  f.repo.directories = async (snapshot, prefix) => { assert.notEqual(prefix, 'dss-coop/tasks/', 'task display is not an admission dependency'); return directories(snapshot, prefix) }
  const receipt = await shared.call('send', { messageId: 'one', text: '弄好了么？' }) as any
  assert.equal(receipt.state, 'CONFIRMED'); assert.deepEqual(calls, ['foregroundProfile'])
  assert.equal((await f.input('one'))?.text, '弄好了么？'); assert.equal(await f.introductions('one'), 1)
  f.repo.directories = directories
  assert.equal((await f.service.view()).messages.at(-1)?.text, '弄好了么？', 'existing view reads confirmed Git, not an optimistic echo')
})

test('commit ACK and confirmed own message do not await an already-running consumer', { timeout: 30_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let consumers = 0
  f.service.attach({ consume: async () => { consumers++; entered.resolve(); await release.promise }, hasWork: () => true, dispose: async () => {} })
  const background = f.service.sync(); await entered.promise
  const receipt = await f.service.send({ id: 'during-consumer', text: 'New ordinary input' }) as any
  assert.equal(receipt.state, 'CONFIRMED'); assert.equal(consumers, 1, 'send does not directly invoke another consumer')
  assert.equal((await f.service.view()).messages.at(-1)?.text, 'New ordinary input')
  assert.ok(f.wakes() > 1); release.resolve(); await background
  assert.equal(await f.introductions('during-consumer'), 1)
})

test('read-back drains a pre-push in-flight snapshot, then fetches and checks committed input', { timeout: 30_000 }, async t => {
  const f = await fixture(t), oldReady = deferred(), release = deferred(), pushed = deferred()
  const rawRefresh = (f.repo as any).refresh.bind(f.repo), rawGit = (f.repo as any).git.bind(f.repo)
  let hold = false, once = true, oldHead = '', old: Promise<unknown> | undefined
  ;(f.repo as any).refresh = async () => { const snapshot = await rawRefresh(); if (hold) { hold = false; oldHead = snapshot.head; oldReady.resolve(); await release.promise } return snapshot }
  ;(f.repo as any).git = async (e: any, args: string[], env: any) => {
    if (args[0] === 'commit-tree' && once) { once = false; hold = true; old = f.repo.snapshot(); await oldReady.promise }
    const value = await rawGit(e, args, env); if (args[0] === 'push') pushed.resolve(); return value
  }
  const pending = f.service.send({ id: 'after-push', text: 'Read exact committed input' })
  await pushed.promise
  assert.notEqual(await git(f.remote, ['rev-parse', 'main']), oldHead)
  release.resolve(); await old
  const receipt = await pending as any
  assert.equal(receipt.state, 'CONFIRMED'); assert.notEqual(f.service.displaySnapshot()?.head, oldHead)
  assert.equal((await f.input('after-push'))?.text, 'Read exact committed input')
})

for (const ambiguous of [false, true]) test('failed ' + (ambiguous ? 'push receipt' : 'push') + ' preserves input identity and retry commits once', { timeout: 30_000 }, async t => {
  const f = await fixture(t), commit = f.repo.commit.bind(f.repo); let once = true
  f.repo.commit = async (...args) => { if (once) { once = false; if (ambiguous) await commit(...args); throw Error(ambiguous ? 'Lost push receipt' : 'Transport unavailable') } return commit(...args) }
  const receipt = await f.service.send({ id: 'retry', text: 'Exact original' }) as any
  assert.equal(receipt.state, 'PENDING_UNCOMMITTED'); assert.ok(f.store.get('draft/retry'))
  assert.equal(await f.introductions('retry'), ambiguous ? 1 : 0)
  const retry = await f.service.send({ id: 'retry', text: 'Exact original' }) as any
  assert.equal(retry.state, 'CONFIRMED'); assert.equal(await f.introductions('retry'), 1); assert.equal(f.store.get('draft/retry'), undefined)
  await assert.rejects(f.service.send({ id: 'retry', text: 'Changed body' }), /identity was reused/)
})

test('failed read-back never claims confirmed; same ID retry reads the existing commit', { timeout: 30_000 }, async t => {
  const f = await fixture(t), snapshot = f.repo.snapshot.bind(f.repo); let once = true
  f.repo.snapshot = async afterWrite => { if (afterWrite && once) { once = false; throw Error('Read-back transport failed') } return snapshot(afterWrite) }
  const first = await f.service.send({ id: 'read-retry', text: 'Already in Git' }) as any
  assert.equal(first.state, 'COMMITTED_PENDING_READ'); assert.match(first.error, /Read-back/)
  assert.equal(await f.introductions('read-retry'), 1)
  const retry = await f.service.send({ id: 'read-retry', text: 'Already in Git' }) as any
  assert.equal(retry.state, 'CONFIRMED'); assert.equal(await f.introductions('read-retry'), 1)
})

for (const changed of ['account', 'revoked']) test('send retains current ' + changed + ' checks at actual write', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  if (changed === 'account') f.identity.id = 2; else f.identity.revoked = true
  const rejected = await f.service.send({ id: changed, text: 'Ordinary input' }) as any
  assert.equal(rejected.state, 'PENDING_UNCOMMITTED'); assert.match(rejected.error, changed === 'account' ? /account changed/ : /revoked/)
  assert.equal(await f.introductions(changed), 0)
  f.identity.id = 1; f.identity.revoked = false
  assert.equal((await f.service.send({ id: changed, text: 'Ordinary input' }) as any).state, 'CONFIRMED')
  assert.equal(await f.introductions(changed), 1)
})

test('scope change while preflight is suspended cannot publish old input into the new directory', { timeout: 30_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), raw = f.repo.snapshot.bind(f.repo)
  let once = true
  f.repo.snapshot = async (...args) => { const snapshot = await raw(...args); if (once) { once = false; entered.resolve(); await release.promise } return snapshot }
  const pending = f.service.send({ id: 'old-scope', text: 'Do not move this input' })
  await entered.promise; await f.service.configure({ repositoryDirectory: 'Changed' }); release.resolve()
  await assert.rejects(pending, /context changed/)
  assert.equal(await f.introductions('old-scope'), 0); assert.equal(f.store.get('user-source/old-scope'), undefined)
})

test('recent-six context is captured from the send snapshot and records its head rather than stale UI projection', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  for (let n = 0; n < 8; n++) await f.service.send({ id: 'prior-' + n, text: 'User ' + n })
  // Do not call view: there is deliberately no freshly materialized display projection.
  const before = await git(f.remote, ['rev-parse', 'main'])
  const result = await f.service.send({ id: 'context', text: 'Continue', conversationContext: true }) as any
  assert.equal(result.state, 'CONFIRMED')
  const intent = f.store.get<UserIntent>('user-source/context')!
  assert.equal(intent.contextHead, before); assert.deepEqual(intent.context?.map(m => m.text), ['User 2', 'User 3', 'User 4', 'User 5', 'User 6', 'User 7'])
  assert.equal((await f.input('context'))?.contextHead, before)
})

test('late old read-back ACK cannot regress a newer sync snapshot or confirmed head', { timeout: 30_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), read = f.repo.read.bind(f.repo)
  let once = true
  f.repo.read = async (snapshot, path) => {
    const text = await read(snapshot, path)
    if (once && text && path === 'dss-coop/intents/1/old.json') { once = false; entered.resolve(); await release.promise }
    return text
  }
  const old = f.service.send({ id: 'old', text: 'Earlier own message' })
  await entered.promise
  assert.equal((await f.service.send({ id: 'new', text: 'Newer message' }) as any).state, 'CONFIRMED')
  await f.service.sync()
  const newest = f.service.displaySnapshot()!.head
  release.resolve(); assert.equal((await old as any).state, 'CONFIRMED')
  assert.equal(f.service.displaySnapshot()!.head, newest)
  assert.equal(f.store.get('confirmed-head'), newest)
  assert.deepEqual((await f.service.view()).messages.map(m => m.text), ['Earlier own message', 'Newer message'])
})

test('concurrent input does not silently change a captured context; the next send observes both committed messages', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  for (let n = 0; n < 7; n++) await f.service.send({ id: 'before-' + n, text: 'Before ' + n })
  const capturedHead = await git(f.remote, ['rev-parse', 'main'])
  const entered = deferred(), release = deferred(), put = f.store.put.bind(f.store)
  f.store.put = async (key, value) => { await put(key, value); if (key === 'user-source/captured') { entered.resolve(); await release.promise } }
  const first = f.service.send({ id: 'captured', text: 'Captured request', conversationContext: true })
  await entered.promise
  assert.equal((await f.service.send({ id: 'concurrent', text: 'Concurrent input' }) as any).state, 'CONFIRMED')
  release.resolve(); assert.equal((await first as any).state, 'CONFIRMED')
  const saved = f.store.get<UserIntent>('user-source/captured')!
  assert.equal(saved.contextHead, capturedHead)
  assert.deepEqual(saved.context?.map(m => m.text), ['Before 1', 'Before 2', 'Before 3', 'Before 4', 'Before 5', 'Before 6'])
  await f.service.send({ id: 'next', text: 'Next request', conversationContext: true })
  const next = f.store.get<UserIntent>('user-source/next')!
  assert.notEqual(next.contextHead, capturedHead)
  assert.ok(next.context?.some(m => m.text === 'Captured request'))
  assert.ok(next.context?.some(m => m.text === 'Concurrent input'))
})

test('a real competing branch commit is retried without duplicated user input', { timeout: 30_000 }, async t => {
  const f = await fixture(t), raw = (f.repo as any).git.bind(f.repo); let once = true
  ;(f.repo as any).git = async (e: any, args: string[], env: any) => {
    if (once && args[0] === 'push') {
      once = false
      const head = await git(f.remote, ['rev-parse', 'main']), tree = await git(f.remote, ['rev-parse', head + '^{tree}'])
      const concurrent = await git(f.remote, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit-tree', tree, '-p', head, '-m', 'Actual isolated competitor'])
      await git(f.remote, ['update-ref', 'refs/heads/main', concurrent, head])
    }
    return raw(e, args, env)
  }
  const receipt = await f.service.send({ id: 'cas', text: 'Input survives conflict' }) as any
  assert.equal(receipt.state, 'CONFIRMED'); assert.equal(await f.introductions('cas'), 1)
  assert.equal((await f.input('cas'))?.text, 'Input survives conflict')
})

test('connecting another account invalidates a suspended preflight rather than moving its input', { timeout: 30_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), snapshot = f.repo.snapshot.bind(f.repo)
  let once = true
  f.repo.snapshot = async (...args) => { const value = await snapshot(...args); if (once) { once = false; entered.resolve(); await release.promise } return value }
  const old = f.service.send({ id: 'previous-account', text: 'Belongs to original account' })
  await entered.promise; f.identity.id = 2
  await f.service.connect(); release.resolve()
  await assert.rejects(old, /context changed/)
  assert.equal(f.store.connection()?.identity.id, 2)
  assert.equal(await f.introductions('previous-account'), 0)
  await assert.rejects(git(f.remote, ['show', 'main:Coop/intents/2/previous-account.json']))
})

test('frontend reset cancels only waiting, not the durable Host send; explicit same-ID retry creates no duplicate', { timeout: 30_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), commit = f.repo.commit.bind(f.repo)
  let once = true, reset = () => {}, backend: Promise<unknown> | undefined, calls = 0
  f.repo.commit = async (...args) => { if (once) { once = false; entered.resolve(); await release.promise } return commit(...args) }
  const notices: string[] = []
  const source = createServantSource({
    view: async () => ({ assistant: { id: 'default' }, tasks: [], messages: (await f.service.view()).messages }),
    retention: async () => ({ totalBytes: 0 }), subscribeChanged: () => () => {}, subscribeReset: listener => { reset = listener; return () => {} },
    send: input => { calls++; return backend = f.service.send({ id: input.messageId, text: input.text }) },
  } as ServantClientApi, notice => notices.push(notice.key))
  source.source.subscribe(() => {}); await source.refresh()
  const old = source.send('stable-reset', 'Original retained draft')
  await entered.promise; reset(); assert.equal(await old, false)
  assert.equal(calls, 1); assert.equal(await f.introductions('stable-reset'), 0)
  release.resolve(); assert.equal((await backend as any).state, 'CONFIRMED')
  assert.equal(await f.introductions('stable-reset'), 1)
  assert.equal(notices.includes('sent'), false, 'late old receipt is not applied to the reset client')
  assert.equal(await source.send('stable-reset', 'Original retained draft'), true)
  assert.equal(calls, 2); assert.equal(await f.introductions('stable-reset'), 1)
  assert.deepEqual(source.source.getSnapshot().pending, []); source.dispose()
})
