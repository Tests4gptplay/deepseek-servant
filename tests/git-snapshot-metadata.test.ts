import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubRepository } from '../src/experimental/private-git/git-repository.js'
import { GitHubClient } from '../src/experimental/private-git/github.js'
import { GitJournal, json } from '../src/experimental/private-git/journal.js'
import { RoleWriter } from '../src/experimental/private-git/role-writer.js'
import { actionPath, type RoleAction } from '../src/experimental/private-git/protocol.js'
import { runGit } from '../src/experimental/private-git/vendor/git-runner.js'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { resolve, promise } }
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dss-snapshot-metadata-')); t.after(() => rm(root, { recursive: true, force: true }))
  const remote = join(root, 'remote.git'), caches = join(root, 'cache')
  await mkdir(remote)
  const git = async (cwd: string, args: string[]) => (await runGit('git', args, { cwd })).stdout.trim()
  await git(remote, ['init', '--bare', '--initial-branch=main', '.'])
  const cwd = join(caches, createHash('sha256').update('synthetic/snapshot-race/Coop/fixture').digest('hex').slice(0, 24))
  await mkdir(cwd, { recursive: true }); await git(cwd, ['init', '--bare', '.']); await git(cwd, ['remote', 'add', 'origin', remote])
  const tokens = async () => ({ value: 'synthetic-not-a-credential', source: 'fixture' })
  const client = new GitHubClient(tokens, async url => {
    const path = new URL(url).pathname
    if (path === '/user') return Response.json({ id: 1, login: 'fixture' })
    if (path === '/repos/synthetic/snapshot-race') return Response.json({ id: 77, full_name: 'synthetic/snapshot-race', private: true, default_branch: 'main', permissions: { pull: true, push: true, admin: true } })
    throw new Error('No external network permitted: ' + path)
  })
  const repo = new GitHubRepository(client, () => ({ ownerRepo: 'synthetic/snapshot-race', repositoryDirectory: 'Coop', instanceId: 'fixture' }), tokens, caches)
  const binding = { participantId: '1', instanceId: 'fixture', role: 'planner' as const, taskId: 'task', actionId: 'plan', executionId: 'exec-current', sessionId: 'session-current', generation: 1, epoch: 1, fence: 'exact-fence', outputPath: 'dss-coop/tasks/task/executions/1/exec-current/outcome.json' }
  const action: RoleAction = { id: 'plan', binding, state: 'active', trigger: 'fixture', input: {}, createdAt: '2026-10-29T00:00:00Z' }
  const path = actionPath(binding), narrow = 'dss-coop/tasks/task/actions/1/fixture/', broad = 'dss-coop/tasks/task/'
  await repo.commit(await repo.snapshot(), [{ path, content: json(action) }, { path: broad + 'contract.json', content: json({ id: 'task', status: 'active', goalRevision: 1 }) },
    { path: broad + 'participants/1/instances/fixture/join.json', content: json({ state: 'active', epoch: 1 }) }], 'Prepare exact active fixture')
  const values = new Map<string, unknown>()
  const store = { get: (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value) }, remove: async (key: string) => { values.delete(key) }, entries: (prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)) }
  const writer = new RoleWriter(repo, new GitJournal(repo, '1'), store as never)
  const hold = (prefix: string, failure = false) => {
    const entered = deferred(), release = deferred(), raw = (repo as any).git.bind(repo)
    let once = true
    ;(repo as any).git = async (e: any, args: string[], env: any) => {
      if (once && args[0] === 'ls-tree' && args.includes('-r') && args.includes('Coop/' + prefix.slice('dss-coop/'.length))) {
        once = false; entered.resolve(); await release.promise
        if (failure) return raw(e, ['ls-tree', 'not-a-real-fixture-revision'], env)
      }
      return raw(e, args, env)
    }
    return { entered: entered.promise, release: release.resolve }
  }
  return { repo, writer, values, binding, path, narrow, broad, hold, remote, git }
}

for (const direction of ['narrow-to-broad', 'broad-to-narrow'] as const) test('snapshot metadata: ' + direction + ' listing never temporarily removes an active binding from concurrent readers', async t => {
  const f = await fixture(t), first = await f.repo.snapshot()
  const known = direction === 'narrow-to-broad' ? f.narrow : f.broad, pending = direction === 'narrow-to-broad' ? f.broad : f.narrow
  await f.repo.list(first, known)
  const second = await f.repo.snapshot(), before = new Map(second.files), hold = f.hold(pending)
  const listing = f.repo.list(first, pending); await hold.entered
  try {
    assert.deepEqual(second.files, before, 'slow list has not published a partial metadata set')
    assert.equal((await f.writer.current(second, f.binding)).state, 'active')
    assert.equal(JSON.parse((await f.repo.read(second, f.path))!).state, 'active')
    assert.equal(JSON.parse(await f.git(f.remote, ['show', first.head + ':Coop/tasks/task/actions/1/fixture/plan.json'])).state, 'active')
    await f.writer.execute(f.binding, { op: 'entry', id: 'legitimate-operation', kind: 'memory', text: 'A valid ongoing Planner write' })
    assert.equal([...f.values.values()].some(value => (value as any).stale), false)
  } finally { hold.release(); await listing }
  assert.equal((await f.writer.current(await f.repo.snapshot(), f.binding)).state, 'active')
  // Genuine remote replacement remains rejected: this repair changes metadata,
  // not the exact execution binding or ownership fence.
  const current = await f.repo.snapshot(), action = JSON.parse((await f.repo.read(current, f.path))!)
  await f.repo.commit(current, [{ path: f.path, content: json({ ...action, binding: { ...f.binding, executionId: 'replacement', generation: 2 } }) }], 'Actual replacement fixture')
  await assert.rejects(f.writer.current(await f.repo.snapshot(), f.binding), /replaced or ended/)
})

test('snapshot metadata: failed broader listing preserves prior valid cache and next real list can succeed', async t => {
  const f = await fixture(t), snapshot = await f.repo.snapshot(); await f.repo.list(snapshot, f.narrow)
  const previous = new Map(snapshot.files), hold = f.hold(f.broad, true), listing = f.repo.list(snapshot, f.broad)
  const rejected = assert.rejects(listing, /not-a-real-fixture-revision/)
  await hold.entered; hold.release(); await rejected
  assert.deepEqual(snapshot.files, previous)
  assert.equal((await f.writer.current(snapshot, f.binding)).state, 'active')
  await f.repo.list(snapshot, f.broad)
  assert.ok(snapshot.files.has(f.broad + 'contract.json'))
})

test('snapshot metadata: aborted broader listing preserves prior cache and a fresh lifecycle can read and list', async t => {
  const f = await fixture(t), snapshot = await f.repo.snapshot(); await f.repo.list(snapshot, f.narrow)
  const previous = new Map(snapshot.files), hold = f.hold(f.broad), listing = f.repo.list(snapshot, f.broad)
  const rejected = assert.rejects(listing, error => (error as Error).name === 'AbortError')
  await hold.entered; f.repo.cancel(); hold.release(); await rejected
  assert.deepEqual(snapshot.files, previous)
  const fresh = await f.repo.snapshot(); await f.repo.list(fresh, f.broad)
  assert.equal((await f.writer.current(fresh, f.binding)).state, 'active')
})
