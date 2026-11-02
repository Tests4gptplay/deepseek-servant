import { FrameworkConversation } from '../src/framework/conversation.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { GitFiles, FilesOutcomeUnknownError, withSnapshot } from '../src/framework/transactions.js'
import { captureGitLegacy, prepareLegacyMigration, applyLegacyMigration } from '../src/framework/legacy-migration.js'
import { MemoryStorage } from './support.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'graphql'
import { createHash } from 'node:crypto'
import { GitHubRepository, GitCommitOutcomeUnknownError } from '../src/experimental/private-git/git-repository.js'
import { GitHubClient, GitConflictError, GitHubError } from '../src/experimental/private-git/github.js'
import type { GitChange, RepoBinding } from '../src/experimental/private-git/contracts.js'

// Controlled GitHub HTTP contract backend, not a real account or public network test.
// Object bodies use actual Git blob hashing; the backend independently enforces the
// documented expectedHeadOid CAS and Base64 FileChanges contract.
const hash = (text: string) => createHash('sha1').update(text).digest('hex')
const blobHash = (value: string | Uint8Array) => createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex')
interface Commit { sha: string; tree: { sha: string }; parents: Array<{ sha: string }>; message: string; files: Map<string, string | Uint8Array> }
class Remote {
  head = ''
  commits = new Map<string, Commit>()
  trees = new Map<string, Array<{ path: string; type: 'tree' | 'blob'; sha: string; size?: number }>>()
  blobs = new Map<string, string | Uint8Array>()
  requests: Array<{ method: string; path: string; body: any; headers: Headers }> = []
  branch = 'main'
  identity = { id: 1, login: 'alice' }
  forbidden = false
  failReads = false
  corruptBlob = false
  mutationMode: 'normal' | 'lost-after-commit' | 'lost-before-commit' | 'partial-after-commit' | 'graphql-rejected' | 'race' | 'lost-after-later-commit' = 'normal'
  constructor(files: Record<string, string> | null = { 'README.md': 'Owner notes: keep me.\n', 'Workspace/state/seed': '' }) {
    if (files) this.append(new Map(Object.entries(files)), 'initial')
  }
  append(files: Map<string, string | Uint8Array>, message: string, parent = this.head): string {
    const build = (prefix: string): string => {
      const names = new Set([...files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]))
      const tree = [...names].sort().map(name => {
        const path = prefix + name, content = files.get(path)
        if (content !== undefined) {
          const sha = blobHash(content); this.blobs.set(sha, content)
          return { path: name, type: 'blob' as const, sha, size: Buffer.byteLength(content) }
        }
        return { path: name, type: 'tree' as const, sha: build(path + '/') }
      })
      const sha = hash(JSON.stringify(tree)); this.trees.set(sha, tree); return sha
    }
    const tree = build(''), sha = hash(JSON.stringify([tree, message, parent, this.commits.size]))
    this.commits.set(sha, { sha, tree: { sha: tree }, parents: parent ? [{ sha: parent }] : [], message, files: new Map(files) })
    return this.head = sha
  }
  change(changes: Record<string, string | null>, message = 'Another participant'): string {
    const files = new Map(this.commits.get(this.head)?.files)
    for (const [path, text] of Object.entries(changes)) text === null ? files.delete(path) : files.set(path, text)
    return this.append(files, message)
  }
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url), path = decodeURIComponent(parsed.pathname), method = init?.method ?? 'GET'
    assert.equal(parsed.origin, 'https://api.github.com')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const headers = new Headers(init?.headers)
    this.requests.push({ method, path: path + parsed.search, body, headers })
    if (this.forbidden) return Response.json({ message: 'Access revoked' }, { status: 403 })
    if (path === '/user') return Response.json(this.identity)
    if (path === '/repos/example/private') return Response.json({ id: 77, full_name: 'example/private', private: true, default_branch: this.branch, permissions: { pull: true, push: true } })
    if (this.failReads && method === 'GET') throw new Error('Synthetic read outage')
    // GitHub's documented commit SHA representation, not a JSON ref response.
    if (path.startsWith('/repos/example/private/commits/heads/')) {
      assert.equal(headers.get('accept'), 'application/vnd.github.sha')
      if (!path.endsWith('/' + this.branch) || !this.head) return Response.json({ message: 'Reference not found' }, { status: 404 })
      if (headers.get('if-none-match') === '"' + this.head + '"') return new Response(null, { status: 304 })
      return new Response(this.head + '\n', { headers: { 'content-type': 'application/vnd.github.sha' } })
    }
    if (path.startsWith('/repos/example/private/git/ref/heads/')) {
      if (path.endsWith('/' + this.branch) && this.head) return Response.json({ object: { sha: this.head } })
      return Response.json({ message: 'Reference not found' }, { status: 404 })
    }
    if (path === '/repos/example/private/branches') return Response.json(this.head ? [{ name: this.branch }] : [])
    if (path.startsWith('/repos/example/private/git/commits/')) {
      const commit = this.commits.get(path.split('/').at(-1)!)
      return commit ? Response.json(commit) : Response.json({ message: 'Commit not found' }, { status: 404 })
    }
    if (path.startsWith('/repos/example/private/git/trees/')) {
      assert.equal(parsed.search, '', 'targeted non-recursive tree requests')
      const tree = this.trees.get(path.split('/').at(-1)!)
      return tree ? Response.json({ tree, truncated: false }) : Response.json({ message: 'Tree not found' }, { status: 404 })
    }
    if (path.startsWith('/repos/example/private/git/blobs/')) {
      const content = this.blobs.get(path.split('/').at(-1)!)
      return content !== undefined ? Response.json({ encoding: 'base64', content: Buffer.from(this.corruptBlob ? 'corrupt' : content).toString('base64') }) : Response.json({ message: 'Blob not found' }, { status: 404 })
    }
    if (method === 'PUT' && path.startsWith('/repos/example/private/contents/')) {
      if (this.head) return Response.json({ message: 'Already initialized' }, { status: 409 })
      const file = path.slice('/repos/example/private/contents/'.length), content = Buffer.from(body.content, 'base64').toString()
      assert.equal(body.branch, this.branch)
      const sha = this.change({ [file]: content }, body.message)
      return Response.json({ commit: { sha } }, { status: 201 })
    }
    if (method === 'POST' && path === '/graphql') {
      const input = body.variables.input
      parse(body.query)
      assert.match(body.query, /createCommitOnBranch/)
      assert.equal(input.branch.repositoryNameWithOwner, 'example/private')
      assert.equal(input.branch.branchName, this.branch)
      assert.deepEqual(Object.keys(input.branch).sort(), ['branchName', 'repositoryNameWithOwner'], 'official CommittableBranch input fields')
      if (this.mutationMode === 'race') { this.mutationMode = 'normal'; this.change({ 'Workspace/state/new-notice': '' }) }
      if (input.expectedHeadOid !== this.head) return Response.json({ data: { createCommitOnBranch: null }, errors: [{ type: 'UNPROCESSABLE', message: 'expectedHeadOid does not match current HEAD' }] })
      if (this.mutationMode === 'graphql-rejected') return Response.json({ data: { createCommitOnBranch: null }, errors: [{ message: 'Branch policy rejected this write' }] })
      if (this.mutationMode === 'lost-before-commit') throw new Error('Synthetic transport lost before application')
      const files = new Map(this.commits.get(this.head)!.files)
      for (const item of input.fileChanges.additions) files.set(item.path, Buffer.from(item.contents, 'base64'))
      for (const item of input.fileChanges.deletions) { assert.ok(files.has(item.path)); files.delete(item.path) }
      const oid = this.append(files, input.message.headline + '\n\n' + input.message.body)
      if (this.mutationMode === 'lost-after-later-commit') {
        this.change({ 'Workspace/instances/another.json': 'heartbeat' })
        throw new Error('Synthetic transport lost after write and subsequent commit')
      }
      if (this.mutationMode === 'lost-after-commit') throw new Error('Synthetic transport lost after application')
      if (this.mutationMode === 'partial-after-commit') return Response.json({ errors: [{ message: 'Response field unavailable' }] })
      const requestedTree = /commit\s*\{[^}]*tree\s*\{/.test(body.query ?? '')
      return Response.json({ data: { createCommitOnBranch: { commit: { oid, ...(requestedTree ? { tree: { oid: this.commits.get(oid)!.tree.sha } } : {}) } } } })
    }
    throw new Error('Unexpected HTTP route ' + method + ' ' + path)
  }
  count(part: string) { return this.requests.filter(request => request.path.includes(part)).length }
}
function fixture(remote = new Remote(), extra: Partial<RepoBinding> = {}) {
  const binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1, ...extra }
  const token = async () => ({ value: 'synthetic-not-a-secret', source: 'fixture' })
  const client = new GitHubClient(token, (url, init) => remote.fetch(url, init))
  return { remote, binding, repo: new GitHubRepository(client, () => binding) }
}
const changes: GitChange[] = [{ path: 'dss-coop/tasks/普通任务_P.md', content: 'Worker details 🚀\n' }, { path: 'dss-coop/state/seed', content: null }]

test('remote: binary FileAddition preserves exact bytes and hashes without text conversion', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot()
  const bytes = new Uint8Array([0, 255, 254, 137, 80, 78, 71, 13, 10, 128])
  const path = 'dss-coop/artifacts/结果.bin', input: GitChange[] = [{ path, bytes }]
  const operation = repo.prepareCommit(base, input, 'Binary artifact')
  assert.equal(operation.writes[0]!.sha256, createHash('sha256').update(bytes).digest('hex'))
  await repo.commitPrepared(base, input, 'Binary artifact', operation)
  const sent = remote.requests.find(request => request.path === '/graphql')!.body.variables.input.fileChanges.additions[0]
  assert.equal(sent.contents, Buffer.from(bytes).toString('base64'))
  const next = await repo.snapshot()
  assert.deepEqual(await repo.readBytes(next, path), Buffer.from(bytes))
  await assert.rejects(repo.read(next, path), /encoded data|encoding|UTF-8/i)
  assert.equal((await repo.resolveCommit(operation)).status, 'confirmed')
  assert.equal(await repo.readBytes(base, path), undefined)
  remote.corruptBlob = true
  await assert.rejects(repo.readBytes(next, path), /integrity mismatch/)
})

test('remote: binary unknown followed by another commit confirms original byte payload', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot()
  const input: GitChange[] = [{ path: 'dss-coop/artifacts/file.zip', bytes: new Uint8Array([80, 75, 3, 4, 0, 255]) }]
  const operation = repo.prepareCommit(base, input, 'Archive')
  remote.mutationMode = 'lost-after-later-commit'
  const result = await repo.commitPrepared(base, input, 'Archive', operation)
  assert.notEqual(result.commit, remote.head)
  const fresh = fixture(remote).repo
  assert.partialDeepStrictEqual(await fresh.resolveCommit(JSON.parse(JSON.stringify(operation))), { status: 'confirmed', commit: result.commit, head: remote.head })
  await assert.rejects(repo.commitPrepared(base, [{ path: input[0]!.path, bytes: new Uint8Array([1]) }], 'Archive', operation), /different input/)
})

test('remote: byte payload is captured before awaiting requests and zero bytes is not deletion', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot()
  const bytes = new Uint8Array([255, 0, 42]), expected = Buffer.from(bytes)
  const input: GitChange[] = [{ path: 'dss-coop/artifacts/capture.bin', bytes }, { path: 'dss-coop/artifacts/empty.bin', bytes: new Uint8Array() }]
  const operation = repo.prepareCommit(base, input, 'Capture bytes')
  const committing = repo.commitPrepared(base, input, 'Capture bytes', operation)
  bytes.fill(1)
  await committing
  const next = await repo.snapshot()
  assert.deepEqual(await repo.readBytes(next, input[0]!.path), expected)
  assert.equal((await repo.readBytes(next, input[1]!.path))!.length, 0)
  assert.equal(remote.requests.find(request => request.path === '/graphql')!.body.variables.input.fileChanges.additions.length, 2)
  assert.throws(() => repo.prepareCommit(next, [{ path: input[0]!.path, content: 'text', bytes } as unknown as GitChange], 'Ambiguous'), /not both/)
})

test('remote: fixed snapshots, metadata-only targeted discovery, UTF-8 integrity and net changes', async () => {
  const { repo, remote } = fixture(), old = await repo.snapshot()
  await repo.list(old, 'dss-coop/state/')
  assert.equal(remote.count('/git/blobs/'), 0)
  assert.deepEqual(await repo.directories(old, 'dss-coop/'), ['dss-coop/state/'])
  const operation = repo.prepareCommit(old, changes, 'Task and signal'), saved = JSON.parse(JSON.stringify(operation))
  assert.equal(JSON.stringify(saved).includes('Worker details'), false, 'durable receipt is metadata only')
  const receipt = await repo.commitPrepared(old, changes, 'Task and signal', saved)
  assert.equal(receipt.commit, remote.head)
  assert.equal(await repo.read(old, 'dss-coop/state/seed'), '', 'old snapshot remains immutable')
  assert.equal(await repo.read(old, changes[0]!.path), undefined)
  const next = await repo.snapshot(), beforeBlobs = remote.count('/git/blobs/')
  const delta = await repo.changes(next, old.head, 'same-instance')
  assert.equal(remote.count('/git/blobs/'), beforeBlobs)
  assert.deepEqual(delta.map(item => [item.path, item.status]), [['dss-coop/state/seed', 'D'], [changes[0]!.path, 'A']])
  assert.equal(await repo.read(next, changes[0]!.path), changes[0]!.content)
  assert.equal(remote.commits.get(remote.head)!.files.get('README.md'), 'Owner notes: keep me.\n')
  remote.corruptBlob = true
  await assert.rejects(repo.read(next, changes[0]!.path), /integrity mismatch/)
})

test('remote: direct directory metadata never descends into other participants or reads bodies', async () => {
  const { repo, remote } = fixture(new Remote({
    'Workspace/state/Foreground': '',
    'Workspace/state/direct': 'notice',
    'Workspace/state/another/Inbox/task.md': 'not for this Host',
  })), snapshot = await repo.snapshot()
  const entries = await repo.listDirectory(snapshot, 'dss-coop/state/')
  assert.deepEqual(entries.map(({ path, type, size }) => ({ path, type, size })), [
    { path: 'dss-coop/state/Foreground', type: 'blob', size: 0 },
    { path: 'dss-coop/state/another', type: 'tree', size: undefined },
    { path: 'dss-coop/state/direct', type: 'blob', size: 6 },
  ])
  assert.equal(entries[0]!.sha, blobHash(''))
  const otherTree = entries.find(entry => entry.type === 'tree')!.sha
  assert.equal(remote.requests.some(request => request.path.endsWith('/git/trees/' + otherTree)), false)
  assert.equal(remote.count('/git/trees/'), 3, 'only repository root, configured root, and state directory')
  assert.equal(remote.count('/git/blobs/'), 0)
  assert.equal(snapshot.files.size, 0, 'direct enumeration is not a recursive file inventory')
  assert.deepEqual(await repo.listDirectory(snapshot, 'dss-coop/state'), entries)
  assert.equal(remote.count('/git/trees/'), 3, 'immutable directory metadata is reused')
})

test('remote: direct directory listing supports configured repository root and absent/non-directory paths', async () => {
  const { repo, remote } = fixture(new Remote({ Foreground: '', 'another/Inbox/task.md': 'private task' }), { repositoryDirectory: '' })
  const snapshot = await repo.snapshot()
  const entries = await repo.listDirectory(snapshot, 'dss-coop/')
  assert.deepEqual(entries.map(entry => entry.path), ['dss-coop/Foreground', 'dss-coop/another'])
  assert.deepEqual(await repo.listDirectory(snapshot, 'dss-coop/missing'), [])
  assert.deepEqual(await repo.listDirectory(snapshot, 'dss-coop/Foreground'), [])
  assert.equal(remote.count('/git/trees/'), 1)
  assert.equal(remote.count('/git/blobs/'), 0)
  await assert.rejects(repo.listDirectory(snapshot, 'dss-coop/../outside'), /configured DSS directory/)
})

test('remote: checked empty directory invalidated by unrelated HEAD; never automatically reparent', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot()
  await repo.list(base, 'dss-coop/state/notices/')
  assert.equal([...base.files.keys()].length, 0)
  remote.change({ 'Workspace/state/notices/Planner': '' })
  await assert.rejects(repo.commit(base, changes, 'Complete task'), GitConflictError)
  assert.equal(remote.count('/graphql'), 0)
})

test('remote: mutation-time race preserves exact expectedHeadOid and returns conflict for business recheck', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot()
  remote.mutationMode = 'race'
  await assert.rejects(repo.commit(base, changes, 'Complete task'), GitConflictError)
  assert.equal(remote.count('/graphql'), 1)
  assert.equal(remote.requests.find(request => request.path === '/graphql')!.body.variables.input.expectedHeadOid, base.head)
  assert.equal(remote.commits.get(remote.head)!.files.has('Workspace/tasks/普通任务_P.md'), false)
})

for (const mode of ['lost-after-commit', 'lost-after-later-commit', 'partial-after-commit'] as const) test('remote: ' + mode + ' confirms precise operation without duplicate write', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Publish')
  remote.mutationMode = mode
  const receipt = await repo.commitPrepared(base, changes, 'Publish', operation)
  const committed = receipt.commit
  assert.ok(remote.commits.get(committed)!.message.includes(operation.id))
  if (mode === 'lost-after-later-commit') assert.notEqual(committed, remote.head)
  const restarted = fixture(remote).repo
  assert.partialDeepStrictEqual(await restarted.resolveCommit(JSON.parse(JSON.stringify(operation))), { status: 'confirmed', commit: committed, head: remote.head })
  const replay = await restarted.commitPrepared(await restarted.at(base.head), changes, 'Publish', operation)
  assert.equal(replay.replay, true)
  assert.equal(replay.commit, committed)
  assert.equal(remote.count('/graphql'), 1)
})

test('remote: unchanged HEAD after a lost request is pending, not proof of no execution; exact prepared retry is safe', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Publish')
  remote.mutationMode = 'lost-before-commit'
  await assert.rejects(repo.commitPrepared(base, changes, 'Publish', operation), (error: unknown) => {
    assert.ok(error instanceof GitCommitOutcomeUnknownError)
    assert.deepEqual(error.operation, operation)
    return true
  })
  assert.deepEqual(await repo.resolveCommit(operation), { status: 'pending', head: base.head })
  remote.mutationMode = 'normal'
  const receipt = await repo.commitPrepared(base, changes, 'Publish', operation)
  assert.equal(remote.commits.get(receipt.commit)!.parents[0]!.sha, base.head)
  assert.equal(remote.count('/graphql'), 2)
  const identities = remote.requests.filter(request => request.path === '/graphql').map(request => request.body.variables.input.clientMutationId)
  assert.deepEqual(identities, [operation.id, operation.id])
})

test('remote: unknown ancestry/read failure never becomes conflict or a new operation', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Publish')
  remote.append(new Map([['README.md', 'rewritten']]), 'force-push replacement', '')
  assert.equal((await repo.resolveCommit(operation)).status, 'unknown')
  await assert.rejects(repo.commitPrepared(base, changes, 'Publish', operation), GitCommitOutcomeUnknownError)
  assert.equal(remote.count('/graphql'), 0)
  remote.failReads = true
  assert.equal((await repo.resolveCommit(operation)).status, 'unknown')
})

test('remote: real rejection is preserved; response errors do not cause automatic retries', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot()
  remote.mutationMode = 'graphql-rejected'
  await assert.rejects(repo.commit(base, changes, 'Publish'), /Branch policy rejected this write/)
  assert.equal(remote.count('/graphql'), 1)
})

test('remote: changed prepared input is rejected before HTTP mutation', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Publish')
  await assert.rejects(repo.commitPrepared(base, [{ path: changes[0]!.path, content: 'different' }], 'Publish', operation), /different input/)
  await assert.rejects(repo.commitPrepared(base, changes, 'different message', operation), /different input/)
  assert.equal(remote.count('/graphql'), 0)
})

test('remote: ordinary HEAD polling reuses connection metadata; writes recheck identity and permission failures invalidate it', async () => {
  const { repo, remote } = fixture()
  await repo.connect()
  const base = await repo.snapshot()
  for (let i = 0; i < 5; i++) await repo.snapshot()
  assert.equal(remote.count('/user'), 1)
  assert.equal(remote.count('/git/commits/'), 1, 'unchanged head reuses immutable tree id')
  await repo.commit(base, changes, 'Publish')
  assert.equal(remote.count('/user'), 2, 'write identity rechecked')
  remote.forbidden = true
  await assert.rejects(repo.snapshot(), /Access revoked/)
  remote.forbidden = false
  await repo.snapshot()
  assert.equal(remote.count('/user'), 3, 'no permanent failure gate after restored permission')
})

test('remote: account changed before write is visible, not treated as a conflict or silently committed', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot()
  remote.identity = { id: 2, login: 'bob' }
  await assert.rejects(repo.commit(base, changes, 'Publish'), /account changed/)
  assert.equal(remote.count('/graphql'), 0)
})

for (const directory of ['Workspace', '']) test('remote: explicit bootstrap for empty ' + (directory || 'root') + ' repository; no business transaction splitting', async () => {
  const { repo, remote } = fixture(new Remote(null), { repositoryDirectory: directory })
  const empty = await repo.snapshot()
  assert.equal(empty.head, '')
  await assert.rejects(repo.commit(empty, changes, 'Publish'), /ensureBranch/)
  assert.equal(remote.requests.some(request => request.method === 'PUT'), false)
  const ready = await repo.ensureBranch()
  assert.ok(ready.head)
  assert.match((await repo.read(ready, 'dss-coop/README.md'))!, /DSS collaboration/)
  assert.equal((await repo.ensureBranch()).head, ready.head)
  assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 1)
  await repo.commit(ready, [changes[0]!], 'Publish')
  assert.equal(remote.count('/graphql'), 1)
})

test('remote: existing repository with wrong branch is not reinterpreted as empty', async () => {
  const { repo, remote } = fixture(undefined, { branch: 'missing' })
  await assert.rejects(repo.ensureBranch(), /Reference not found/)
  assert.equal(remote.requests.some(request => request.method === 'PUT'), false)
})

test('remote: snapshot cancellation does not publish partial listing and fresh lifecycle remains usable', async () => {
  const { repo } = fixture(), base = await repo.snapshot()
  repo.cancel()
  await assert.rejects(repo.list(base, 'dss-coop/'), (error: any) => error.name === 'AbortError')
  const next = await repo.snapshot()
  await repo.list(next, 'dss-coop/')
  assert.ok(next.files.has('dss-coop/state/seed'))
})

for (const kind of ['default', 'owner-abort', 'owner-error'] as const) test(`remote: cancelled snapshot and in-flight HTTP retain the same ${kind} reason across later epochs`, async () => {
  const remote = new Remote(), original = remote.fetch.bind(remote), entered = Promise.withResolvers<void>()
  let observed: AbortSignal | undefined
  remote.fetch = async (url, init) => {
    if (url.includes('/git/blobs/')) {
      observed = init?.signal ?? undefined
      assert.ok(observed)
      entered.resolve()
      return new Promise<Response>((_resolve, reject) => observed!.addEventListener('abort', () => reject(observed!.reason), { once: true }))
    }
    return original(url, init)
  }
  const { repo } = fixture(remote), base = await repo.snapshot()
  await repo.list(base, 'dss-coop/')
  const operation = repo.prepareCommit(base, changes, 'Retained prepared operation')
  const pending = repo.read(base, 'dss-coop/state/seed').then(() => assert.fail('cancelled read succeeded'), error => error)
  await entered.promise
  const reason = kind === 'default' ? undefined : kind === 'owner-abort'
    ? new DOMException('This owner withdrew its snapshot', 'AbortError') : new Error('This owner closed its connection')
  repo.cancel(reason)
  const expected = observed!.reason
  if (kind === 'default') assert.equal(expected.name, 'AbortError')
  else assert.equal(expected, reason)
  assert.equal(await pending, expected, 'the in-flight native signal rejection is preserved')
  const count = remote.requests.length
  const stale = [
    () => repo.read(base, 'dss-coop/state/seed'),
    () => repo.readBytes(base, 'dss-coop/state/seed'),
    () => repo.list(base, 'dss-coop/'), // Includes the already-loaded fast path.
    () => repo.listDirectory(base, 'dss-coop/'),
    () => repo.directories(base, 'dss-coop/'),
    () => repo.changes(base, ''),
    () => repo.changes(base, base.head), // An unchanged HEAD must not bypass ownership.
    () => repo.commitPrepared(base, changes, 'Retained prepared operation', operation),
  ]
  for (const access of stale) await assert.rejects(access(), error => error === expected)
  assert.throws(() => repo.prepareCommit(base, changes, 'New operation'), error => error === expected)
  assert.equal(remote.requests.length, count, 'invalid snapshots cannot start HTTP in the fresh client epoch')
  remote.fetch = original
  const next = await repo.snapshot()
  assert.equal(await repo.read(next, 'dss-coop/state/seed'), '', 'explicit new epoch remains usable')
  const nextReason = new DOMException('The next owner withdrew', 'AbortError')
  repo.cancel(nextReason)
  await assert.rejects(repo.list(next, 'dss-coop/'), error => error === nextReason)
  await assert.rejects(repo.list(base, 'dss-coop/'), error => error === expected, 'a later epoch cannot overwrite the original reason')
  const independent = fixture()
  assert.equal(await independent.repo.read(await independent.repo.snapshot(), 'dss-coop/state/seed'), '', 'other repository owners remain usable')
})

test('remote: same prepared transaction dispatched concurrently commits once under expectedHeadOid', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Concurrent publish')
  const [a, b] = await Promise.all([
    repo.commitPrepared(base, changes, 'Concurrent publish', operation),
    repo.commitPrepared(base, changes, 'Concurrent publish', operation),
  ])
  assert.equal(a.commit, b.commit)
  assert.equal([...remote.commits.values()].filter(commit => commit.message.includes('DSS-Operation: ' + operation.id)).length, 1)
})

test('remote: forged marker with different body hashes does not confirm a pending operation', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Publish')
  remote.change({ 'Workspace/tasks/普通任务_P.md': 'wrong body', 'Workspace/state/seed': null },
    'Not the prepared content\nDSS-Operation: ' + operation.id + '\nDSS-Request-SHA256: ' + operation.requestHash)
  const result = await repo.resolveCommit(operation)
  assert.equal(result.status, 'unknown')
  assert.match((result as any).reason, /content verification/)
})

test('remote: history missing during operation recovery stays unknown', async () => {
  const { repo, remote } = fixture(), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Publish')
  const middle = remote.change({ 'Workspace/state/first': '' })
  remote.change({ 'Workspace/state/second': '' })
  remote.commits.delete(middle)
  assert.equal((await repo.resolveCommit(operation)).status, 'unknown')
})

test('remote: configured root changes invalidate connection scope and cannot redirect a prepared transaction', async () => {
  const { repo, remote, binding } = fixture(), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Publish')
  binding.repositoryDirectory = 'Elsewhere'
  await assert.rejects(repo.commitPrepared(base, changes, 'Publish', operation), GitCommitOutcomeUnknownError)
  assert.equal((await repo.resolveCommit(operation)).status, 'unknown')
  assert.equal(remote.count('/graphql'), 0)
})

test('remote: truncated metadata is not published as an empty or partial directory', async () => {
  const remote = new Remote(), original = remote.fetch.bind(remote)
  let truncated = true
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    if (truncated && url.includes('/git/trees/')) return Response.json({ ...(await response.json()), truncated: true })
    return response
  }
  const { repo } = fixture(remote), base = await repo.snapshot()
  await assert.rejects(repo.list(base, 'dss-coop/'), /truncated directory/)
  assert.equal(base.files.size, 0)
  truncated = false
  await repo.list(base, 'dss-coop/')
  assert.ok(base.files.has('dss-coop/state/seed'))
})

test('remote: read failure after server accepted mutation preserves exact recoverable operation metadata', async () => {
  const remote = new Remote(), original = remote.fetch.bind(remote)
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    if (url.endsWith('/graphql')) { remote.failReads = true; throw new Error('Response and read-back lost') }
    return response
  }
  const { repo } = fixture(remote), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Publish')
  await assert.rejects(repo.commitPrepared(base, changes, 'Publish', operation), (error: unknown) => {
    assert.ok(error instanceof GitCommitOutcomeUnknownError)
    assert.deepEqual(error.operation, operation)
    return true
  })
  remote.failReads = false
  const restarted = fixture(remote).repo
  assert.equal((await restarted.resolveCommit(operation)).status, 'confirmed')
  assert.equal(remote.count('/graphql'), 1)
})

for (const firstPrefix of ['dss-coop/a', 'dss-coop']) test(`remote: overlapping same-H metadata lists started with ${firstPrefix} merge without losses`, async () => {
  const remote = new Remote({ 'Workspace/a/one': '1', 'Workspace/a/deep/two': '2', 'Workspace/b/three': '3' })
  const original = remote.fetch.bind(remote)
  let unblock!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  let hold = true
  remote.fetch = async (url, init) => {
    if (hold && url.includes('/git/trees/')) { hold = false; entered(); await blocked }
    return original(url, init)
  }
  const { repo } = fixture(remote), snapshot = await repo.snapshot(), head = snapshot.head
  const first = repo.list(snapshot, firstPrefix)
  await reached
  const second = repo.list(snapshot, firstPrefix === 'dss-coop' ? 'dss-coop/a' : 'dss-coop')
  remote.change({ 'Workspace/new-after-H': 'not in snapshot' })
  unblock()
  await Promise.all([first, second])
  assert.equal(snapshot.head, head)
  const expected = ['dss-coop/a/deep/two', 'dss-coop/a/one', 'dss-coop/b/three']
  assert.deepEqual([...snapshot.files.keys()].sort(), expected)
  for (const path of expected) assert.equal(snapshot.files.get(path), blobHash(path.endsWith('one') ? '1' : path.endsWith('two') ? '2' : '3'))
  await repo.list(snapshot, 'dss-coop/a')
  assert.deepEqual([...snapshot.files.keys()].sort(), expected)
  assert.equal(remote.count('/git/blobs/'), 0)
})

for (const mode of ['failure', 'cancel'] as const) test(`remote: in-flight tree ${mode} publishes no partial metadata and next request recovers`, async () => {
  const remote = new Remote({ 'Workspace/a/one': '1', 'Workspace/b/two': '2' }), original = remote.fetch.bind(remote)
  let unblock!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  let armed = true
  remote.fetch = async (url, init) => {
    if (armed && url.includes('/git/trees/')) {
      armed = false; entered(); await blocked
      if (mode === 'failure') throw new Error('Controlled tree transport failure')
      init?.signal?.throwIfAborted()
    }
    return original(url, init)
  }
  const { repo } = fixture(remote), snapshot = await repo.snapshot()
  const pending = repo.list(snapshot, 'dss-coop')
  const rejection = assert.rejects(pending, mode === 'failure' ? /Controlled tree transport failure/ : { name: 'AbortError' })
  await reached
  if (mode === 'cancel') repo.cancel()
  unblock(); await rejection
  assert.equal(snapshot.files.size, 0)
  const before = remote.count('/git/trees/')
  const next = mode === 'cancel' ? await repo.snapshot() : snapshot
  await repo.list(next, 'dss-coop')
  assert.ok(remote.count('/git/trees/') > before, 'recovery issues actual HTTP metadata requests')
  assert.deepEqual([...next.files.keys()].sort(), ['dss-coop/a/one', 'dss-coop/b/two'])
  assert.equal(await repo.read(next, 'dss-coop/b/two'), '2')
  await repo.commit(next, [{ path: 'dss-coop/recovered', content: mode }], 'After failed lifecycle')
  assert.equal(await repo.read(await repo.snapshot(), 'dss-coop/recovered'), mode)
})

test('remote: empty technical commit retains a recoverable operation after an unknown response', async () => {
  const remote = new Remote(), original = remote.fetch.bind(remote)
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    if (url.endsWith('/graphql')) { remote.failReads = true; throw new Error('Response and read-back lost') }
    return response
  }
  const { repo } = fixture(remote), base = await repo.snapshot()
  const before = new Map(remote.commits.get(remote.head)!.files)
  const operation = repo.prepareCommit(base, [], 'Technical checkpoint without file changes')
  assert.deepEqual(operation.writes, [])
  const persisted = JSON.parse(JSON.stringify(operation))
  assert.deepEqual(await fixture(remote).repo.resolveCommit(persisted), { status: 'pending', head: base.head })
  await assert.rejects(repo.commitPrepared(base, [], 'Technical checkpoint without file changes', operation), error => {
    assert.ok(error instanceof GitCommitOutcomeUnknownError)
    assert.deepEqual(error.operation, operation)
    return true
  })
  remote.failReads = false
  const restarted = fixture(remote).repo
  assert.partialDeepStrictEqual(await restarted.resolveCommit(persisted), { status: 'confirmed', commit: remote.head, head: remote.head })
  assert.deepEqual(remote.commits.get(remote.head)!.files, before)
  assert.equal(remote.count('/graphql'), 1)
})

test('remote: stalled HTTP transport observes explicit client cancellation without network access', async () => {
  let observed: AbortSignal | undefined, requests = 0
  const entered = Promise.withResolvers<void>()
  const client = new GitHubClient(async () => ({ value: 'synthetic-not-a-secret', source: 'fixture' }), async (_url, init) => {
    requests++; observed = init?.signal ?? undefined; entered.resolve()
    return new Promise<Response>((_resolve, reject) => {
      observed!.addEventListener('abort', () => reject(observed!.reason), { once: true })
    })
  })
  const pending = client.session(session => session.request('GET', '/user'))
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await entered.promise; client.cancel(); await rejected
  assert.equal(observed?.aborted, true)
  assert.equal(requests, 1, 'cancellation does not retry or infer a server outcome')
})


test('remote: unchanged snapshots issue authenticated conditional HEAD and reuse only immutable tree metadata', async () => {
  const { repo, remote } = fixture(), first = await repo.snapshot()
  await repo.list(first, 'dss-coop')
  const trees = remote.count('/git/trees/'), before = remote.requests.length
  const second = await repo.snapshot()
  await repo.list(second, 'dss-coop')
  assert.equal(remote.requests.length - before, 1, 'warm unchanged snapshot plus list needs only a HEAD observation')
  assert.equal(remote.count('/git/trees/'), trees)
  const request = remote.requests.at(-1)!
  assert.equal(request.path, '/repos/example/private/commits/heads/main')
  assert.equal(request.headers.get('if-none-match'), '"' + first.head + '"')
  assert.equal(request.headers.get('accept'), 'application/vnd.github.sha')
  assert.ok(request.headers.get('authorization'))
  assert.notEqual(second.files, first.files)
  assert.notEqual(second.reads, first.reads)
  remote.change({ 'Workspace/state/new': 'new data' })
  const third = await repo.snapshot()
  assert.notEqual(third.head, second.head)
  await repo.list(third, 'dss-coop')
  assert.equal(first.files.has('dss-coop/state/new'), false)
  assert.equal(third.files.has('dss-coop/state/new'), true)
})

for (const [status, responseHeaders] of [
  [429, { 'Retry-After': '120' }],
  [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000120' }],
] as const) test('remote: service-directed ' + status + ' cooldown sends no requests until its actual deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
  const remote = new Remote(), original = remote.fetch.bind(remote), { repo } = fixture(remote)
  const base = await repo.snapshot()
  let limited = true
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    return limited ? Response.json({ message: 'API rate limit exceeded' }, { status, headers: responseHeaders }) : response
  }
  await assert.rejects(repo.snapshot(), (error: unknown) => error instanceof GitHubError && error.status === status && error.retryAfter === 120)
  const before = remote.requests.length
  for (let i = 0; i < 119; i++) {
    t.mock.timers.tick(1000)
    await assert.rejects(repo.snapshot(), (error: unknown) => error instanceof GitHubError && error.status === status)
  }
  assert.equal(remote.requests.length, before, 'not even repo/user handshakes bypass cooldown')
  limited = false
  t.mock.timers.tick(1000)
  assert.equal((await repo.snapshot()).head, base.head)
  assert.equal(remote.requests.length, before + 1, 'rate403 does not invalidate authenticated connection metadata')
})


test('remote: permission rejection cannot be replaced by a cached HEAD or immutable directory', async () => {
  const { repo, remote } = fixture(), first = await repo.snapshot()
  await repo.list(first, 'dss-coop')
  remote.forbidden = true
  await assert.rejects(repo.snapshot(), (error: unknown) => error instanceof GitHubError && error.status === 403 && error.retryAfter === undefined)
  remote.forbidden = false
  const before = remote.requests.length
  const next = await repo.snapshot()
  await repo.list(next, 'dss-coop')
  assert.ok(remote.requests.length > before + 1, 'restored access revalidates identity and discarded scope metadata')
})

test('remote: missing private access is not misdiagnosed as an empty repository after a cached HEAD', async () => {
  const { repo, remote } = fixture(), original = remote.fetch.bind(remote)
  await repo.snapshot()
  remote.fetch = async (url, init) => url.includes('/commits/heads/') || url.includes('/branches?')
    ? Response.json({ message: 'Not Found' }, { status: 404 }) : original(url, init)
  await assert.rejects(repo.snapshot(), (error: unknown) => error instanceof GitHubError && error.status === 404)
})

test('remote: unsolicited 304 and invalid SHA text never establish a HEAD cache', async () => {
  for (const response of [() => new Response(null, { status: 304 }), () => new Response('not-a-sha')]) {
    const remote = new Remote(), original = remote.fetch.bind(remote)
    remote.fetch = async (url, init) => url.includes('/commits/heads/') ? response() : original(url, init)
    const { repo } = fixture(remote)
    await assert.rejects(repo.snapshot(), /without a previously observed HEAD|invalid commit SHA/)
    assert.equal(remote.count('/git/commits/'), 0)
  }
})

test('remote: account credential changes recheck real identity; old pending operations never migrate', async () => {
  const remote = new Remote(), binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1 }
  let credential = 'synthetic-alice'
  const client = new GitHubClient(async () => ({ value: credential, source: 'fixture' }), (url, init) => remote.fetch(url, init))
  const repo = new GitHubRepository(client, () => binding), first = await repo.snapshot()
  await repo.list(first, 'dss-coop')
  const operation = repo.prepareCommit(first, changes, 'Original account')
  credential = 'synthetic-bob'; remote.identity = { id: 2, login: 'bob' }
  await assert.rejects(repo.snapshot(), /account changed/)
  await assert.rejects(repo.read(first, 'dss-coop/state/seed'), /authorization changed/)
  await assert.rejects(repo.commitPrepared(first, changes, 'Original account', operation), /account changed/)
  assert.equal((await repo.resolveCommit(operation)).status, 'unknown')
  assert.equal(remote.count('/graphql'), 0)
  binding.participantId = 2
  const before = remote.count('/git/trees/'), second = await repo.snapshot()
  await repo.list(second, 'dss-coop')
  assert.ok(remote.count('/git/trees/') > before, 'same Git hashes never carry cache authorization across identities')
  assert.equal(remote.requests.filter(request => request.path.includes('/commits/heads/')).at(-1)!.headers.get('if-none-match'), null)
  assert.equal((await repo.resolveCommit(operation)).status, 'unknown')
  assert.equal(remote.count('/graphql'), 0)
})

test('remote: same-account credential rotation revalidates repo/user and drops old metadata scope', async () => {
  const remote = new Remote(), binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1 }
  let credential = 'synthetic-one'
  const client = new GitHubClient(async () => ({ value: credential, source: 'fixture' }), (url, init) => remote.fetch(url, init))
  const repo = new GitHubRepository(client, () => binding)
  await repo.list(await repo.snapshot(), 'dss-coop')
  const users = remote.count('/user'), trees = remote.count('/git/trees/')
  credential = 'synthetic-rotated'
  await repo.list(await repo.snapshot(), 'dss-coop')
  assert.equal(remote.count('/user'), users + 1)
  assert.ok(remote.count('/git/trees/') > trees)
  assert.equal(remote.requests.filter(request => request.path.includes('/commits/heads/')).at(-1)!.headers.get('if-none-match'), null)
})

test('remote: branch and directory changes never borrow HEAD conditions or tree metadata', async () => {
  const { repo, remote, binding } = fixture()
  await repo.list(await repo.snapshot(), 'dss-coop')
  for (const change of [() => { binding.branch = remote.branch = 'feature/scoped' }, () => { binding.repositoryDirectory = '' }]) {
    change()
    const before = remote.count('/git/trees/'), snapshot = await repo.snapshot()
    const request = remote.requests.filter(request => request.path.includes('/commits/heads/')).at(-1)!
    assert.equal(request.headers.get('if-none-match'), null)
    await repo.list(snapshot, 'dss-coop')
    assert.ok(remote.count('/git/trees/') > before)
  }
})

test('remote: write readback starts a fresh HEAD request instead of sharing a suspended pre-write observation', async () => {
  const { repo, remote } = fixture(), original = remote.fetch.bind(remote), base = await repo.snapshot()
  let unblock!: () => void, entered!: () => void, hold = true
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    if (hold && url.includes('/commits/heads/')) { hold = false; entered(); await blocked }
    return response
  }
  const oldRequest = repo.snapshot()
  await reached
  const receipt = await repo.commit(base, changes, 'Read back after write')
  const next = await repo.snapshot(true)
  assert.equal(next.head, receipt.commit)
  assert.equal(await repo.read(next, changes[0]!.path), changes[0]!.content)
  unblock()
  assert.equal((await oldRequest).head, base.head, 'old response remains its own fixed snapshot')
  assert.equal((await repo.snapshot(true)).head, receipt.commit, 'late old response cannot invent a current HEAD')
})

test('remote: secondary cooldown spans repository scopes, preserves cancellation and expires at HTTP-date Retry-After', async t => {
  const now = 1800000000000
  t.mock.timers.enable({ apis: ['Date'], now })
  let calls = 0, limited = true
  const client = new GitHubClient(async () => ({ value: 'synthetic-not-a-secret', source: 'fixture' }), async url => {
    calls++
    return limited && url.endsWith('/limited')
      ? Response.json({ message: 'Secondary limit' }, { status: 429, headers: { 'retry-after': new Date(now + 120000).toUTCString() } })
      : Response.json({ ok: true })
  })
  const limitedRequest = () => client.session(session => session.request('GET', '/limited'))
  await assert.rejects(limitedRequest(), (error: unknown) => error instanceof GitHubError && error.retryAfter === 120)
  client.cancel()
  await assert.rejects(limitedRequest(), GitHubError)
  assert.equal(calls, 1, 'cancel does not bypass service cooldown')
  await assert.rejects(client.session(session => session.request('GET', '/repos/example/other')), GitHubError)
  await assert.rejects(client.session(session => session.request('POST', '/graphql', {})), GitHubError)
  assert.equal(calls, 1, 'secondary limits do not invent repository or GraphQL exemptions')
  limited = false
  t.mock.timers.tick(120000)
  await limitedRequest()
  assert.equal(calls, 2)
})


test('remote: primary core cooldown spans repositories, not GraphQL or changed credentials', async t => {
  const now = 1800000000000
  t.mock.timers.enable({ apis: ['Date'], now })
  let calls = 0, credential = 'synthetic-first'
  const client = new GitHubClient(async () => ({ value: credential, source: 'fixture' }), async url => {
    calls++
    return url.endsWith('/repos/example/limited')
      ? Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: {
        'x-ratelimit-remaining': '0', 'x-ratelimit-resource': 'core', 'x-ratelimit-reset': String(now / 1000 + 120),
      } }) : Response.json({ ok: true })
  })
  let firstError: GitHubError | undefined
  await assert.rejects(client.session(session => session.request('GET', '/repos/example/limited')), error => { firstError = error as GitHubError; return true })
  await assert.rejects(client.session(session => session.request('GET', '/repos/example/other')), error => {
    assert.ok(error instanceof GitHubError)
    assert.equal(error.rateLimit, firstError!.rateLimit, 'same real cooldown is one diagnostic fact')
    return true
  })
  assert.equal(calls, 1)
  await client.session(session => session.request('POST', '/graphql', {}))
  assert.equal(calls, 2, 'GraphQL does not consume the REST core primary bucket')
  credential = 'synthetic-other-account'
  await client.session(session => session.request('GET', '/repos/example/other'))
  assert.equal(calls, 3, 'different authentication scope is not assumed to be the same user')
})

test('remote: a new upstream cooldown after expiry is a new diagnostic fact', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
  const client = new GitHubClient(async () => ({ value: 'synthetic-first', source: 'fixture' }), async () =>
    Response.json({ message: 'Rate limited' }, { status: 429, headers: { 'retry-after': '120' } }))
  const facts: object[] = []
  const attempt = async () => assert.rejects(client.session(session => session.request('GET', '/user')), error => {
    assert.ok(error instanceof GitHubError)
    assert.ok(error.rateLimit)
    facts.push(error.rateLimit)
    return true
  })
  await attempt(); await attempt()
  assert.equal(facts[0], facts[1])
  t.mock.timers.tick(120000)
  await attempt()
  assert.notEqual(facts[0], facts[2])
})

test('remote: different repositories with identical Git objects do not share cached HEAD or trees', async () => {
  const first = new Remote(), second = new Remote()
  assert.equal(first.head, second.head, 'fixture intentionally has identical immutable hashes')
  const binding: RepoBinding = { ownerRepo: 'example/private', participantId: 1, repositoryDirectory: 'Workspace' }
  const client = new GitHubClient(async () => ({ value: 'synthetic-only', source: 'fixture' }), async (url, init) => {
    if (url.includes('/repos/example/other')) {
      if (new URL(url).pathname === '/repos/example/other') return Response.json({ id: 88, full_name: 'example/other', private: true, default_branch: 'main', permissions: { pull: true, push: true } })
      return second.fetch(url.replace('/repos/example/other', '/repos/example/private'), init)
    }
    return first.fetch(url, init)
  })
  const repo = new GitHubRepository(client, () => binding)
  await repo.list(await repo.snapshot(), 'dss-coop')
  const firstTrees = first.count('/git/trees/')
  binding.ownerRepo = 'example/other'
  await repo.list(await repo.snapshot(), 'dss-coop')
  assert.equal(second.count('/git/trees/'), firstTrees)
  assert.equal(second.requests.find(request => request.path.includes('/commits/heads/'))!.headers.get('if-none-match'), null)
  binding.ownerRepo = 'example/private'
  await repo.list(await repo.snapshot(), 'dss-coop')
  assert.equal(first.count('/git/trees/'), 2 * firstTrees, 'old scope has no repository-wide retained cache table')
})

test('remote: new revisions reuse unchanged subtrees without retaining a mutable snapshot inventory', async () => {
  const { repo, remote } = fixture(new Remote({ 'Workspace/unchanged/file': 'stable', 'Workspace/mutable/file': 'one' }))
  const first = await repo.snapshot()
  await repo.list(first, 'dss-coop')
  const stableTree = [...remote.trees.entries()].find(([, tree]) => tree.length === 1 && tree[0]!.type === 'blob' && tree[0]!.sha === blobHash('stable'))![0]
  for (const text of ['two', 'three']) {
    remote.change({ 'Workspace/mutable/file': text })
    const snapshot = await repo.snapshot()
    await repo.list(snapshot, 'dss-coop')
    assert.equal(await repo.read(snapshot, 'dss-coop/mutable/file'), text)
  }
  assert.equal(remote.requests.filter(request => request.path.endsWith('/git/trees/' + stableTree)).length, 1)
  assert.equal(await repo.read(first, 'dss-coop/mutable/file'), 'one')
})

for (const [retrySeconds, resetSeconds] of [[30, 120], [120, 30]] as const) test(`remote: combined Retry-After ${retrySeconds} and core reset ${resetSeconds} retain both actual scopes`, async t => {
  const now = 1800000000000
  t.mock.timers.enable({ apis: ['Date'], now })
  let calls = 0
  const client = new GitHubClient(async () => ({ value: 'synthetic-only', source: 'fixture' }), async url => {
    calls++
    return url.endsWith('/limited') ? Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: {
      'retry-after': String(retrySeconds), 'x-ratelimit-remaining': '0', 'x-ratelimit-resource': 'core', 'x-ratelimit-reset': String(now / 1000 + resetSeconds),
    } }) : Response.json({ ok: true })
  })
  let fact: object | undefined
  await assert.rejects(client.session(session => session.request('GET', '/repos/example/limited')), error => {
    assert.ok(error instanceof GitHubError)
    fact = error.rateLimit
    assert.equal(error.retryAfter, Math.max(retrySeconds, resetSeconds))
    return true
  })
  await assert.rejects(client.session(session => session.request('POST', '/graphql', {})), error => {
    assert.ok(error instanceof GitHubError)
    assert.equal(error.rateLimit, fact)
    assert.equal(error.retryAfter, retrySeconds, 'GraphQL must observe Retry-After, not unrelated core reset')
    return true
  })
  assert.equal(calls, 1)
  t.mock.timers.tick(retrySeconds * 1000)
  await client.session(session => session.request('POST', '/graphql', {}))
  assert.equal(calls, 2)
  if (resetSeconds > retrySeconds) {
    await assert.rejects(client.session(session => session.request('GET', '/repos/example/other')), error => {
      assert.ok(error instanceof GitHubError)
      assert.equal(error.retryAfter, resetSeconds - retrySeconds)
      return true
    })
    t.mock.timers.tick((resetSeconds - retrySeconds) * 1000)
  }
  await client.session(session => session.request('GET', '/repos/example/other'))
  assert.equal(calls, 3)
})

test('remote: an intermediate unexpanded HEAD does not discard still-unchanged subtree metadata', async () => {
  const { repo, remote } = fixture(new Remote({ 'Workspace/tasks/stable/state/seed': '', 'Workspace/instances/member.json': 'one' }))
  await repo.list(await repo.snapshot(), 'dss-coop/tasks')
  const stableTree = [...remote.trees.entries()].find(([, tree]) => tree.length === 1 && tree[0]!.type === 'blob' && tree[0]!.path === 'seed')![0]
  remote.change({ 'Workspace/instances/member.json': 'two' })
  await repo.snapshot() // Real preflight/readback may observe a HEAD without traversing Task trees.
  remote.change({ 'Workspace/instances/member.json': 'three' })
  await repo.list(await repo.snapshot(), 'dss-coop/tasks')
  assert.equal(remote.requests.filter(request => request.path.endsWith('/git/trees/' + stableTree)).length, 1)
})

test('remote: rate limit after an uncertain mutation preserves the same recoverable operation until service expiry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
  const { repo, remote } = fixture(), original = remote.fetch.bind(remote), base = await repo.snapshot()
  const operation = repo.prepareCommit(base, changes, 'Rate-limited readback')
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    return url.endsWith('/graphql') ? Response.json({ message: 'Secondary rate limit' }, { status: 429, headers: { 'retry-after': '120' } }) : response
  }
  await assert.rejects(repo.commitPrepared(base, changes, 'Rate-limited readback', operation), error => {
    assert.ok(error instanceof GitCommitOutcomeUnknownError)
    assert.deepEqual(error.operation, operation)
    return true
  })
  const before = remote.requests.length
  assert.equal((await repo.resolveCommit(operation)).status, 'unknown')
  assert.equal(remote.requests.length, before, 'recovery never bypasses declared cooldown')
  t.mock.timers.tick(120000)
  assert.equal((await repo.resolveCommit(operation)).status, 'confirmed')
  assert.equal(remote.count('/graphql'), 1, 'resolving the original operation does not dispatch another mutation')
})

test('remote: partially expanded changed ancestors preserve shared descendants without a revision chain', async () => {
  const { repo, remote } = fixture(new Remote({ 'Workspace/tasks/stable/state/seed': '', 'Workspace/tasks/changing/file': 'one' }))
  await repo.list(await repo.snapshot(), 'dss-coop/tasks')
  const stableTree = [...remote.trees.entries()].find(([, tree]) => tree.length === 1 && tree[0]!.type === 'blob' && tree[0]!.path === 'seed')![0]
  for (const content of ['two', 'three']) {
    remote.change({ 'Workspace/tasks/changing/file': content })
    await repo.listDirectory(await repo.snapshot(), 'dss-coop') // Root/Workspace only; tasks itself remains unexpanded.
  }
  await repo.list(await repo.snapshot(), 'dss-coop/tasks')
  assert.equal(remote.requests.filter(request => request.path.endsWith('/git/trees/' + stableTree)).length, 1)
})

test('remote: active directory view drops unreachable trees while historical snapshots retain their own view', async () => {
  const { repo, remote } = fixture(new Remote({ 'Workspace/deleted/deep/old': 'old-only', 'Workspace/kept/file': 'keep' }))
  const old = await repo.snapshot()
  await repo.list(old, 'dss-coop')
  const obsolete = [...remote.trees.entries()].find(([, tree]) => tree.length === 1 && tree[0]!.type === 'blob' && tree[0]!.path === 'old')![0]
  type View = { sha: string; children: Map<string, View>; previous?: View }
  const active = () => (repo as unknown as { metadata: { view: View } }).metadata.view
  const oldView = active()
  remote.change({ 'Workspace/deleted/deep/old': null, 'Workspace/new/file': 'new-only' })
  const next = await repo.snapshot()
  assert.equal(active(), oldView, 'HEAD-only observation does not claim directory ownership')
  await repo.list(next, 'dss-coop')
  assert.notEqual(active(), oldView)
  const retained = new Set<string>()
  const visit = (node: View): void => {
    if (retained.has(node.sha)) return
    retained.add(node.sha)
    assert.equal(node.previous, undefined, 'a fully expanded view has no historical fallback graph')
    for (const child of node.children.values()) visit(child)
  }
  visit(active())
  const reachable = new Set<string>()
  const walk = (sha: string): void => {
    if (reachable.has(sha)) return
    reachable.add(sha)
    for (const child of remote.trees.get(sha) ?? []) if (child.type === 'tree') walk(child.sha)
  }
  walk(remote.commits.get(remote.head)!.tree.sha)
  assert.deepEqual([...retained].sort(), [...reachable].sort())
  assert.equal(retained.has(obsolete), false)
  assert.equal(await repo.read(old, 'dss-coop/deleted/deep/old'), 'old-only')
  assert.equal(active().sha, next.tree, 'historical reads do not restore old ownership')
})

test('remote: an unread changed directory never returns entries from its previous view', async () => {
  const { repo, remote } = fixture(new Remote({ 'Workspace/tasks/old': 'old' })), original = remote.fetch.bind(remote)
  const old = await repo.snapshot()
  await repo.list(old, 'dss-coop')
  remote.change({ 'Workspace/tasks/old': null, 'Workspace/tasks/new': 'new' })
  const changedTree = [...remote.trees.entries()].find(([, tree]) => tree.length === 1 && tree[0]!.path === 'new')![0]
  let unblock!: () => void, entered!: () => void, settled = false
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    if (url.endsWith('/git/trees/' + changedTree)) { entered(); await blocked }
    return response
  }
  const next = await repo.snapshot(), pending = repo.listDirectory(next, 'dss-coop/tasks').then(entries => { settled = true; return entries })
  await reached
  assert.equal(settled, false, 'the new SHA awaits its own remote entries, not fallback data')
  assert.equal(old.files.has('dss-coop/tasks/old'), true)
  assert.equal(old.files.has('dss-coop/tasks/new'), false)
  unblock()
  assert.deepEqual((await pending).map(entry => entry.path), ['dss-coop/tasks/new'])
  assert.equal(await repo.read(old, 'dss-coop/tasks/old'), 'old')
})

test('remote: historical at() and a late old directory response cannot replace the current view', async () => {
  const { repo, remote } = fixture(new Remote({ 'Workspace/tasks/old': 'old' })), original = remote.fetch.bind(remote)
  const old = await repo.snapshot()
  let unblock!: () => void, entered!: () => void, hold = true
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    if (hold && url.endsWith('/git/trees/' + old.tree)) { hold = false; entered(); await blocked }
    return response
  }
  const delayed = repo.list(old, 'dss-coop')
  await reached
  remote.change({ 'Workspace/tasks/old': null, 'Workspace/tasks/new': 'new' })
  const next = await repo.snapshot()
  await repo.list(next, 'dss-coop')
  const active = () => (repo as unknown as { metadata: { view: { sha: string } } }).metadata.view
  const current = active()
  unblock(); await delayed
  assert.equal(active(), current)
  assert.equal(old.files.has('dss-coop/tasks/old'), true)
  assert.equal(old.files.has('dss-coop/tasks/new'), false)
  const historical = await repo.at(old.head)
  await repo.list(historical, 'dss-coop')
  assert.equal(active(), current)
  assert.equal(active().sha, next.tree)
  assert.equal(await repo.read(historical, 'dss-coop/tasks/old'), 'old')
})

for (const changeScope of ['branch', 'account'] as const) test('remote: late old directory completion cannot overwrite a changed ' + changeScope + ' scope', async () => {
  const remote = new Remote({ 'Workspace/tasks/old': 'old' }), original = remote.fetch.bind(remote)
  const binding: RepoBinding = { ownerRepo: 'example/private', participantId: 1, repositoryDirectory: 'Workspace', branch: 'main' }
  let credential = 'synthetic-one'
  const repo = new GitHubRepository(new GitHubClient(async () => ({ value: credential, source: 'fixture' }), (url, init) => remote.fetch(url, init)), () => binding)
  const old = await repo.snapshot()
  let unblock!: () => void, entered!: () => void, hold = true
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    if (hold && url.endsWith('/git/trees/' + old.tree)) { hold = false; entered(); await blocked }
    return response
  }
  const delayed = repo.list(old, 'dss-coop')
  await reached
  if (changeScope === 'branch') binding.branch = remote.branch = 'other'
  else { credential = 'synthetic-two'; binding.participantId = 2; remote.identity = { id: 2, login: 'other' } }
  remote.change({ 'Workspace/tasks/old': null, 'Workspace/tasks/new': 'new' })
  const next = await repo.snapshot()
  await repo.list(next, 'dss-coop')
  const active = () => (repo as unknown as { metadata: { view: { sha: string } } }).metadata.view
  const current = active()
  unblock(); await delayed
  assert.equal(active(), current)
  assert.equal(active().sha, next.tree)
  assert.equal(old.files.has('dss-coop/tasks/new'), false)
  assert.equal(next.files.has('dss-coop/tasks/old'), false)
})

for (const status of [403, 429]) test('remote: explicit secondary ' + status + ' without deadline follows documented minimum, not ordinary permission errors', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
  let calls = 0, mode: 'secondary' | 'permission' | 'success' = 'permission'
  const client = new GitHubClient(async () => ({ value: 'synthetic-only', source: 'fixture' }), async () => {
    calls++
    return mode === 'success' ? Response.json({ ok: true }) : Response.json({ message: mode === 'secondary'
      ? 'You have exceeded a secondary rate limit. Please wait before you try again.' : 'Resource not accessible by personal access token' }, { status: mode === 'permission' ? 403 : status })
  })
  const request = () => client.session(session => session.request('GET', '/repos/example/private'))
  await assert.rejects(request(), (error: unknown) => error instanceof GitHubError && error.retryAt === undefined && error.rateLimit === undefined)
  mode = 'secondary'
  await assert.rejects(request(), (error: unknown) => error instanceof GitHubError && error.status === status && error.retryAfter === 60)
  assert.equal(calls, 2, 'ordinary permission403 does not install a time gate')
  t.mock.timers.tick(59000)
  await assert.rejects(request(), (error: unknown) => error instanceof GitHubError && error.retryAfter === 1)
  assert.equal(calls, 2)
  t.mock.timers.tick(1000)
  await assert.rejects(request(), (error: unknown) => error instanceof GitHubError && error.retryAfter === 120)
  assert.equal(calls, 3, 'another actual secondary response increases the advisory wait, not a cached local rejection')
  t.mock.timers.tick(120000)
  mode = 'success'
  await request()
  mode = 'secondary'
  await assert.rejects(request(), (error: unknown) => error instanceof GitHubError && error.retryAfter === 60)
  assert.equal(calls, 5, 'actual recovery resets the consecutive secondary sequence')
})

test('remote: unrelated HEAD304 and GET successes do not reset a continuously secondary-limited mutation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 })
  let limited = true, calls = 0
  const client = new GitHubClient(async () => ({ value: 'synthetic-only', source: 'fixture' }), async url => {
    calls++
    if (url.endsWith('/commits/heads/main')) return new Response(null, { status: 304 })
    if (url.endsWith('/graphql') && limited) return Response.json({ message: 'You have exceeded a secondary rate limit' }, { status: 429 })
    return Response.json({ ok: true })
  })
  const mutation = () => client.session(session => session.request('POST', '/graphql', { query: 'mutation { synthetic }' }))
  await assert.rejects(mutation(), (error: unknown) => error instanceof GitHubError && error.retryAfter === 60)
  t.mock.timers.tick(60000)
  await client.session(session => session.head('/repos/example/private/commits/heads/main', 'a'.repeat(40)))
  await client.session(session => session.request('GET', '/user'))
  await assert.rejects(mutation(), (error: unknown) => error instanceof GitHubError && error.retryAfter === 120)
  t.mock.timers.tick(120000)
  limited = false
  await mutation()
  limited = true
  await assert.rejects(mutation(), (error: unknown) => error instanceof GitHubError && error.retryAfter === 60)
  assert.equal(calls, 6)
})

test('remote: cancellation after accepted mutation stays unknown and resolves the same prepared operation without another write', async () => {
  const remote = new Remote(), original = remote.fetch.bind(remote), accepted = Promise.withResolvers<void>()
  remote.fetch = async (url, init) => {
    const response = await original(url, init)
    if (!url.endsWith('/graphql')) return response
    accepted.resolve()
    return new Promise<Response>((_resolve, reject) => {
      assert.ok(init?.signal)
      init.signal.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  }
  const { repo } = fixture(remote), base = await repo.snapshot(), operation = repo.prepareCommit(base, changes, 'Cancelled response')
  const retained = JSON.parse(JSON.stringify(operation))
  const reason = new DOMException('This repository owner cancelled its request', 'AbortError')
  const pending = repo.commitPrepared(base, changes, 'Cancelled response', operation)
  const rejection = assert.rejects(pending, error => {
    assert.ok(error instanceof GitCommitOutcomeUnknownError)
    assert.deepEqual(error.operation, retained)
    assert.equal(error.cause, reason, 'UNKNOWN retains the initiating cause but is not an AbortError itself')
    assert.notEqual(error.name, 'AbortError')
    return true
  })
  await accepted.promise
  const committed = remote.head
  assert.notEqual(committed, base.head)
  repo.cancel(reason); await rejection
  assert.partialDeepStrictEqual(await repo.resolveCommit(retained), { status: 'confirmed', commit: committed, head: committed })
  const retry = await repo.commitPrepared(await repo.at(base.head), changes, 'Cancelled response', retained)
  assert.partialDeepStrictEqual(retry, { commit: committed, replay: true })
  assert.equal(remote.count('/graphql'), 1, 'no automatic resend, new operation or duplicate mutation after cancellation')
})

// Mutation metadata is optional; authority and original byte verification remain mandatory.
const treeHintPath='dss-coop/instances/self.json', body=JSON.stringify({sequence:2,updatedAt:'2026-11-01T09:00:30Z',status:'running'})
async function prepareTreeHint(mode='normal') {
 const remote=new Remote({'README.md':'synthetic','Workspace/instances/self.json':JSON.stringify({sequence:1,updatedAt:'2026-11-01T09:00:00Z',status:'running'})})
 const {repo}=fixture(remote),base=await repo.snapshot()
 await repo.read(base,treeHintPath)
 const fetch=remote.fetch.bind(remote)
 remote.fetch=async(url,init)=>{
  const response=await fetch(url,init)
  if(init?.method!=='POST'||new URL(url).pathname!=='/graphql')return response
  const data=await response.json(),commit=data.data?.createCommitOnBranch?.commit
  if(commit){
   if(mode==='missing')delete commit.tree
   if(mode==='null')commit.tree=null
   if(mode==='invalid')commit.tree={oid:'not-a-tree-sha'}
   if(mode==='invalid-length')commit.tree={oid:'a'.repeat(41)}
   if(mode==='partial')data.errors=[{message:'synthetic optional field error'}]
   if(mode==='later')remote.change({'Workspace/instances/peer.json':'synthetic peer'})
  }
  return Response.json(data)
 }
 const changes=[{path: treeHintPath,content:body}],operation=repo.prepareCommit(base,changes,'synthetic heartbeat')
 remote.requests.length=0
 return{remote,repo,base,changes,operation}
}
for(const mode of ['normal','missing','null','invalid','invalid-length','partial','later']) test('mutation tree metadata '+mode+' retains fresh HEAD and verified body',async()=>{
 const{remote,repo,base,changes,operation}=await prepareTreeHint(mode)
 const receipt=await repo.commitPrepared(base,changes,'synthetic heartbeat',operation)
 const afterMutation=remote.requests.length,fresh=await repo.snapshot(),text=await repo.read(fresh,treeHintPath)
 assert.equal(text,body);assert.equal(fresh.head,remote.head)
 const reads=remote.requests.slice(afterMutation)as any[]
 assert.equal(reads.filter(r=>r.path.includes('/commits/heads/')).length,1,'fresh authority must not be replaced by mutation receipt')
 assert.equal(reads.filter(r=>r.path.includes('/git/blobs/')).length,1,'actual body readback remains')
 const commitGETs=reads.filter(r=>r.path.includes('/git/commits/'))
 assert.equal(commitGETs.length,mode==='normal'?0:1)
 if(mode==='later'){assert.notEqual(fresh.head,receipt.commit);assert.equal(commitGETs[0]!.path.split('/').at(-1),fresh.head)}
 assert.equal(reads.filter(r=>r.path.includes('/git/trees/')).length,3,'all independently authoritative tree mapping remains')
})
test('revocation after accepted mutation is not hidden by returned tree',async()=>{
 const{remote,repo,base,changes,operation}=await prepareTreeHint()
 await repo.commitPrepared(base,changes,'synthetic heartbeat',operation);remote.forbidden=true
 await assert.rejects(repo.snapshot(),(e:any)=>e instanceof GitHubError&&e.status===403)
})
test('lost accepted mutation resolves the original operation, with no invented hint',async()=>{
 const{remote,repo,base,changes,operation}=await prepareTreeHint();remote.mutationMode='lost-after-commit'
 const receipt=await repo.commitPrepared(base,changes,'synthetic heartbeat',operation)
 assert.equal(receipt.commit,remote.head)
 assert.equal(remote.requests.filter(r=>r.path==='/graphql').length,1)
 assert.ok(remote.commits.get(receipt.commit)!.message.includes('DSS-Operation: '+operation.id))
 assert.ok(remote.requests.some(r=>r.path.includes('/git/commits/')),'uncertain result still resolves real ancestry')
 assert.equal(await repo.read(await repo.snapshot(),treeHintPath),body)
})
test('lost before application remains UNKNOWN and keeps original operation identity',async()=>{
 const{remote,repo,base,changes,operation}=await prepareTreeHint();remote.mutationMode='lost-before-commit'
 await assert.rejects(repo.commitPrepared(base,changes,'synthetic heartbeat',operation),(e:any)=>e instanceof GitCommitOutcomeUnknownError&&e.operation.id===operation.id)
 assert.equal(remote.head,base.head)
 assert.equal(remote.requests.filter(r=>r.path==='/graphql').length,1)
})

test('releaseCache clears mutation hint before new authority session',async()=>{
 const{remote,repo,base,changes,operation}=await prepareTreeHint()
 await repo.commitPrepared(base,changes,'synthetic heartbeat',operation)
 await repo.releaseCache();const start=remote.requests.length
 assert.equal(await repo.read(await repo.snapshot(),treeHintPath),body)
 assert.equal(remote.requests.slice(start).filter(r=>r.path.includes('/git/commits/')).length,1)
})

test('resolved complete bytes expose a same-scope same-commit verification result, including deletions', async () => {
  const remote = new Remote({ 'Workspace/state/a': 'old', 'Workspace/state/deleted': 'remove' }), { repo } = fixture(remote)
  const base = await repo.snapshot(), changes: GitChange[] = [{ path: 'dss-coop/state/a', content: 'new' }, { path: 'dss-coop/state/deleted', content: null }]
  const op = repo.prepareCommit(base, changes, 'Verification handoff')
  await repo.commitPrepared(base, changes, 'Verification handoff', op)
  const resolved = await repo.resolveCommit(op)
  assert.equal(resolved.status, 'confirmed')
  if (resolved.status !== 'confirmed') throw new Error('Expected confirmed resolution')
  assert.ok(resolved.verifiedWrites, 'only completed real byte validation supplies its actual snapshot')
  const fresh = await repo.snapshot(), before = remote.requests.length
  assert.equal(repo.matchesVerifiedWrites(fresh, resolved.verifiedWrites, op.writes), true)
  assert.equal(remote.requests.length, before, 'comparison reuses an already fresh authority, not another body fetch')
  assert.equal(repo.matchesVerifiedWrites(fresh, resolved.verifiedWrites, op.writes.slice(0, 1)), false)
  assert.equal(repo.matchesVerifiedWrites(fresh, resolved.verifiedWrites, [...op.writes, { path: 'dss-coop/extra', sha256: null }]), false)
})

for (const boundary of ['later-head', 'cancel', 'release-cache', 'scope', 'account', 'foreign-snapshot'] as const) test(`verified byte result cannot cross ${boundary}`, async () => {
  const remote = new Remote(), { repo, binding } = fixture(remote), base = await repo.snapshot()
  const op = repo.prepareCommit(base, changes, 'Verification boundary')
  await repo.commitPrepared(base, changes, 'Verification boundary', op)
  const resolved = await repo.resolveCommit(op)
  assert.equal(resolved.status, 'confirmed')
  if (resolved.status !== 'confirmed') throw new Error('Expected successful byte verification')
  assert.ok(resolved.verifiedWrites)
  if (boundary === 'later-head') remote.change({ 'unrelated.txt': 'later authority' })
  if (boundary === 'cancel') repo.cancel()
  if (boundary === 'release-cache') await repo.releaseCache()
  if (boundary === 'scope') binding.repositoryDirectory = 'different-root'
  if (boundary === 'account') { remote.identity = { id: 2, login: 'other' }; await repo.connect() }
  const fresh = boundary === 'foreign-snapshot' ? await fixture(remote).repo.snapshot() : await repo.snapshot()
  assert.equal(repo.matchesVerifiedWrites(fresh, resolved.verifiedWrites, op.writes), false)
})

test('failed partial byte verification never exposes a reusable verified result', async () => {
  const remote = new Remote(), { repo } = fixture(remote), base = await repo.snapshot()
  const payload = [{ path: 'dss-coop/state/first', content: 'first' }, { path: 'dss-coop/state/second', content: 'second' }]
  const op = repo.prepareCommit(base, payload, 'Partial verification')
  await repo.commitPrepared(base, payload, 'Partial verification', op)
  const fetch = remote.fetch.bind(remote); let reads = 0
  remote.fetch = async (url, init) => {
    if (url.includes('/git/blobs/') && ++reads === 2) throw new Error('Synthetic second body unavailable')
    return fetch(url, init)
  }
  const resolved = await repo.resolveCommit(op)
  assert.equal(reads, 2); assert.equal(resolved.status, 'unknown'); assert.equal('verifiedWrites' in resolved, false)
})

for (const boundary of ['same-head', 'advanced-head', 'old-receipt', 'commit-race'] as const) test(`migration readback handoff ${boundary} preserves authority and keeps live verification out of durable receipts`, async () => {
  const remote = new Remote({ 'Workspace/inbox/synthetic.md': 'Synthetic original legacy input' }), { repo } = fixture(remote)
  const records = new MemoryStorage(), operations = new Map<string, any>(), savedReceiptInputs: any[] = []
  const saveRecord = records.set.bind(records)
  records.set = async (key, value) => { if ((value as any)?.receipt) savedReceiptInputs.push((value as any).receipt); await saveRecord(key, value) }
  const files = new GitFiles(repo, { save: async record => { operations.set(record.operation.id, structuredClone(record)) }, get: async id => operations.get(id), list: async () => [...operations.values()] })
  const transactions = new FrameworkTransactions(files, records, 'migration-verification')
  const original = await files.snapshot()
  const source = await captureGitLegacy(files, original)
  const plan = await prepareLegacyMigration(source, files, original, { id: 'verified-cutover', owner: 'alice', members: {} }, transactions)
  await original.release()
  const dispatch = repo.commitPrepared.bind(repo)
  let pendingArgs: Parameters<typeof dispatch> | undefined
  repo.commitPrepared = async (...args) => {
    pendingArgs = args
    if (boundary !== 'commit-race') await dispatch(...args)
    throw new GitCommitOutcomeUnknownError(args[3], { cause: new Error('Synthetic interruption before local acknowledgement') })
  }
  await assert.rejects(applyLegacyMigration(files, transactions, plan), FilesOutcomeUnknownError)
  assert.equal(remote.count('/graphql'), boundary === 'commit-race' ? 0 : 1)
  repo.commitPrepared = dispatch
  const resolve = repo.resolveCommit.bind(repo); let afterResolution = 0
  repo.resolveCommit = async operation => {
    const result = await resolve(operation)
    assert.equal(result.status, boundary === 'commit-race' ? 'pending' : 'confirmed')
    if (boundary === 'commit-race') await dispatch(...pendingArgs!)
    afterResolution = remote.requests.length
    if (boundary === 'advanced-head') remote.change({ 'unrelated.txt': 'New unrelated authority' })
    return result
  }
  const run = transactions.run.bind(transactions)
  let beforeApplyReadback = 0
  transactions.run = async (...args) => {
    const result = await run(...args)
    if (result.verifiedWrites) {
      assert.equal(Object.prototype.propertyIsEnumerable.call(result, 'verifiedWrites'), false, 'live verification is not a model/client field')
      assert.equal('verifiedWrites' in JSON.parse(JSON.stringify({ archive: result })).archive, false)
      assert.equal('verifiedWrites' in structuredClone(result), false)
      assert.equal('verifiedWrites' in { ...result }, false)
    }
    beforeApplyReadback = remote.requests.length
    return result
  }
  assert.equal((await applyLegacyMigration(files, transactions, plan)).verified, true)
  if (boundary === 'commit-race') afterResolution = beforeApplyReadback
  let reads = remote.requests.slice(afterResolution)
  assert.equal(reads.filter(row => row.path.includes('/commits/heads/')).length, 1, 'fresh authority after complete verification is mandatory')
  assert.equal(reads.filter(row => row.path.includes('/git/blobs/')).length, boundary === 'advanced-head' ? plan.changes.length : 0)
  for (const receipt of savedReceiptInputs) assert.equal('verifiedWrites' in receipt, false, 'attaching live result cannot mutate an object already handed to storage')
  for (const value of operations.values()) assert.equal('verifiedWrites' in value.resolution, false, 'native snapshot never enters saved operation resolution')
  for (const { value } of await records.list<any>('framework-commands/')) if (value.receipt) assert.equal('verifiedWrites' in value.receipt, false, 'command receipt is metadata only')
  if (boundary === 'old-receipt') {
    const before = remote.requests.length
    assert.equal((await applyLegacyMigration(files, transactions, plan)).verified, true)
    reads = remote.requests.slice(before)
    assert.equal(reads.filter(row => row.path.includes('/git/blobs/')).length, plan.changes.length, 'durable receipt alone cannot reuse a previous in-memory verification')
  }
  assert.equal(remote.count('/graphql'), 1, 'confirmation never resends the accepted operation')
})

test('ordinary mutation acceptance without byte verification still performs every migration readback', async () => {
  const remote = new Remote({ 'Workspace/inbox/new.md': 'Synthetic input' }), { repo } = fixture(remote)
  const operations = new Map<string, any>(), records = new MemoryStorage()
  const files = new GitFiles(repo, { save: async value => { operations.set(value.operation.id, structuredClone(value)) }, get: async id => operations.get(id), list: async () => [...operations.values()] })
  const transactions = new FrameworkTransactions(files, records, 'ordinary-migration')
  const snapshot = await files.snapshot(), source = await captureGitLegacy(files, snapshot)
  const plan = await prepareLegacyMigration(source, files, snapshot, { id: 'ordinary-cutover', owner: 'alice', members: {} }, transactions)
  await snapshot.release()
  const run = transactions.run.bind(transactions); let beforeReadback = 0
  transactions.run = async (...args) => { const receipt = await run(...args); assert.equal(receipt.verifiedWrites, undefined); beforeReadback = remote.requests.length; return receipt }
  assert.equal((await applyLegacyMigration(files, transactions, plan)).verified, true)
  assert.equal(remote.requests.slice(beforeReadback).filter(row => row.path.includes('/git/blobs/')).length, plan.changes.length)
})

test('owned read operation shares one actual credential resolution across snapshot and body/metadata reads', async () => {
  const remote = new Remote({ 'Workspace/a.txt': 'A', 'Workspace/b.txt': 'B' }); let resolutions = 0
  const binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1 }
  const repo = new GitHubRepository(new GitHubClient(async () => { resolutions++; return { value: 'synthetic-owned-read', source: 'fixture' } }, (url, init) => remote.fetch(url, init)), () => binding)
  const operation = async () => {
    const snapshot = await repo.snapshot()
    assert.equal(await repo.read(snapshot, 'dss-coop/a.txt'), 'A')
    assert.equal(await repo.read(snapshot, 'dss-coop/b.txt'), 'B')
    await repo.listDirectory(snapshot, 'dss-coop/')
  }
  const scoped = repo as GitHubRepository & { withReadOperation?: <T>(operation: () => Promise<T>) => Promise<T> }
  await (scoped.withReadOperation ? scoped.withReadOperation(operation) : operation())
  assert.equal(resolutions, 1)
  assert.equal(remote.count('/git/blobs/'), 2, 'original bytes are still really fetched')
})

function ownedReadsFixture() {
  const remote = new Remote({ 'Workspace/a.txt': 'A', 'Workspace/b.txt': 'B' })
  let resolutions = 0, credential = 'synthetic-owned-first'
  const binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1 }
  const repo = new GitHubRepository(new GitHubClient(async () => { resolutions++; return { value: credential, source: 'fixture' } }, (url, init) => remote.fetch(url, init)), () => binding)
  return { repo, remote, binding, count: () => resolutions, credential: (value: string) => { credential = value } }
}
test('owned reads: common GitFiles withSnapshot supports all callers; next operation and release remain real boundaries', async () => {
  const f = ownedReadsFixture(), operations = new Map<string, any>()
  const files = new GitFiles(f.repo, { save: async record => { operations.set(record.operation.id, record) }, get: async id => operations.get(id), list: async () => [...operations.values()] })
  let held: any
  await withSnapshot(files, async snapshot => {
    held = snapshot
    assert.equal(await files.read(snapshot, 'a.txt'), 'A')
    await files.withReadOperation(async () => assert.equal(await files.read(snapshot, 'b.txt'), 'B'))
  })
  assert.equal(f.count(), 1)
  assert.throws(() => files.read(held, 'a.txt'), /released/)
  await withSnapshot(files, async snapshot => assert.equal(await files.read(snapshot, 'a.txt'), 'A'))
  assert.equal(f.count(), 2)
  assert.equal(f.remote.count('/commits/heads/'), 2, 'new operation still obtains actual HEAD')
  assert.equal(f.remote.count('/git/blobs/'), 3, 'no cross-operation body cache was introduced')
})
test('owned reads: writes and their later readback never borrow the pre-write session', async () => {
  const f = ownedReadsFixture()
  await f.repo.withReadOperation(async () => {
    const base = await f.repo.snapshot()
    await f.repo.read(base, 'dss-coop/a.txt')
    assert.equal(f.count(), 1)
    await f.repo.commit(base, [{ path: 'dss-coop/a.txt', content: 'changed' }], 'actual CAS')
    assert.equal(f.count(), 2, 'publication resolves actual current credentials')
    await f.repo.withReadOperation(async () => {
      const checked = await f.repo.snapshot()
      assert.equal(await f.repo.read(checked, 'dss-coop/a.txt'), 'changed')
    })
    assert.equal(f.count(), 3, 'post-write operation uses new authorization session')
  })
  assert.equal(f.remote.count('/graphql'), 1)
})
test('owned reads: asynchronous escape cannot use the completed owner session', async () => {
  const f = ownedReadsFixture(), gate = Promise.withResolvers<void>(); let escaped!: Promise<unknown>
  await f.repo.withReadOperation(async () => {
    const snapshot = await f.repo.snapshot()
    escaped = gate.promise.then(() => f.repo.read(snapshot, 'dss-coop/a.txt'))
  })
  gate.resolve()
  await assert.rejects(escaped, /ownership has ended/)
  assert.equal(f.count(), 1)
  assert.equal(f.remote.count('/git/blobs/'), 0)
})
test('owned reads: changed root and credentials cannot reuse another authority snapshot', async () => {
  const f = ownedReadsFixture()
  await assert.rejects(f.repo.withReadOperation(async () => {
    const snapshot = await f.repo.snapshot(); f.binding.repositoryDirectory = 'Elsewhere'
    await f.repo.read(snapshot, 'dss-coop/a.txt')
  }), /authority changed/)
  f.binding.repositoryDirectory = 'Workspace'
  const previous = await f.repo.withReadOperation(() => f.repo.snapshot())
  f.credential('synthetic-owned-new')
  await assert.rejects(f.repo.withReadOperation(() => f.repo.read(previous, 'dss-coop/a.txt')), /authorization changed/)
  await f.repo.withReadOperation(async () => assert.equal(await f.repo.read(await f.repo.snapshot(), 'dss-coop/a.txt'), 'A'))
})
test('owned reads: a remote permission failure is not masked and next operation rechecks permission', async () => {
  const f = ownedReadsFixture()
  await assert.rejects(f.repo.withReadOperation(async () => {
    const snapshot = await f.repo.snapshot(); f.remote.forbidden = true
    await f.repo.read(snapshot, 'dss-coop/a.txt')
  }), /Access revoked/)
  const count = f.count()
  await assert.rejects(f.repo.withReadOperation(() => f.repo.snapshot()), /Access revoked/)
  assert.equal(f.count(), count + 1)
  f.remote.forbidden = false
  await f.repo.withReadOperation(async () => assert.equal(await f.repo.read(await f.repo.snapshot(), 'dss-coop/a.txt'), 'A'))
})
test('owned reads: cancellation drains actual in-flight body requests and reports the same cause', async () => {
  const remote = new Remote({ 'Workspace/a.txt': 'A' }), entered = Promise.withResolvers<void>(), cause = new Error('owned cancel')
  let aborted = false
  const binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1 }
  const repo = new GitHubRepository(new GitHubClient(async () => ({ value: 'synthetic-cancel', source: 'fixture' }), async (url, init) => {
    if (url.includes('/git/blobs/')) {
      entered.resolve()
      await new Promise((_resolve, reject) => {
        const abort = () => { aborted = true; reject(init!.signal!.reason) }
        if (init?.signal?.aborted) abort(); else init!.signal!.addEventListener('abort', abort, { once: true })
      })
    }
    return remote.fetch(url, init)
  }), () => binding)
  let body!: Promise<unknown>
  const owned = repo.withReadOperation(async () => {
    const snapshot = await repo.snapshot()
    body = repo.read(snapshot, 'dss-coop/a.txt'); void body.catch(() => {})
    await entered.promise
  })
  await entered.promise; repo.cancel(cause)
  await assert.rejects(owned, error => error === cause)
  await assert.rejects(body, error => error === cause)
  assert.equal(aborted, true)
})

test('owned reads: a callback failure cancels only its owned outstanding transport and drains it', async () => {
  const remote = new Remote({ 'Workspace/held.txt': 'held', 'Workspace/live.txt': 'live' })
  const entered = Promise.withResolvers<void>(), failure = new Error('callback failed'), cancelled = Promise.withResolvers<void>()
  const heldSha = blobHash('held')
  const binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1 }
  const repo = new GitHubRepository(new GitHubClient(async () => ({ value: 'synthetic-own-cancellation', source: 'fixture' }), async (url, init) => {
    if (url.endsWith('/git/blobs/' + heldSha)) {
      entered.resolve()
      await new Promise((_resolve, reject) => {
        const abort = () => { cancelled.resolve(); reject(init!.signal!.reason) }
        if (init?.signal?.aborted) abort(); else init!.signal!.addEventListener('abort', abort, { once: true })
      })
    }
    return remote.fetch(url, init)
  }), () => binding)
  let body!: Promise<unknown>
  const failed = repo.withReadOperation(async () => {
    body = repo.read(await repo.snapshot(), 'dss-coop/held.txt'); void body.catch(() => {})
    await entered.promise; throw failure
  })
  await entered.promise
  const independent = repo.withReadOperation(async () => repo.read(await repo.snapshot(), 'dss-coop/live.txt'))
  await assert.rejects(failed, error => error === failure)
  await cancelled.promise
  await assert.rejects(body, error => error === failure)
  assert.equal(await independent, 'live', 'another owned session is not aborted')
})
test('owned reads: a delayed explicit new operation obtains fresh authority rather than borrowing a dead owner', async () => {
  const f = ownedReadsFixture(), gate = Promise.withResolvers<void>(); let later!: Promise<unknown>
  await f.repo.withReadOperation(async () => {
    await f.repo.snapshot()
    later = gate.promise.then(() => f.repo.withReadOperation(async () => f.repo.read(await f.repo.snapshot(), 'dss-coop/a.txt')))
  })
  gate.resolve()
  assert.equal(await later, 'A'); assert.equal(f.count(), 2)
})
test('owned reads: failed callbacks preserve even an undefined thrown reason', async () => {
  const f = ownedReadsFixture(); let caught = false
  try { await f.repo.withReadOperation(async () => { throw undefined }) } catch (error) { caught = true; assert.equal(error, undefined) }
  assert.equal(caught, true)
})

test('owned reads: real Git conversation page and recent keep full bytes while each resolves credentials once', async () => {
  const f = ownedReadsFixture(), operations = new Map<string, any>(), records = new Map<string, unknown>()
  const files = new GitFiles(f.repo, { save: async record => { operations.set(record.operation.id, structuredClone(record)) }, get: async id => operations.get(id), list: async () => [...operations.values()] })
  const storage = { async get<T>(key: string) { return records.get(key) as T | undefined }, async set(key: string, value: unknown) { records.set(key, value) }, async list<T>(prefix: string) { return [...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: value as T })) } }
  const conversation = new FrameworkConversation(files, new FrameworkTransactions(files, storage, 'actual-HTTP-conversation'), { mode: 'git', collaborationId: 'shared' })
  for (let i = 0; i < 3; i++) for (const role of ['user', 'assistant'] as const) await conversation.send(role + i, {
    id: role + i, role, participantId: 'A', createdAt: '2026-11-01T00:00:00.000Z', text: 'Full unchanged 😀 original ' + role + i,
    ...(role === 'user' ? { recipient: 'ai' as const } : { replyTo: 'user' + i }),
  })
  let before = f.count(), blobs = f.remote.count('/git/blobs/')
  const page = await conversation.page(20)
  assert.equal(f.count() - before, 1)
  assert.equal(f.remote.count('/git/blobs/') - blobs, 19)
  assert.equal(page.messages.length, 6)
  before = f.count(); blobs = f.remote.count('/git/blobs/')
  const recent = await conversation.recentExchanges()
  assert.equal(f.count() - before, 1)
  assert.equal(f.remote.count('/git/blobs/') - blobs, 19)
  assert.deepEqual(recent.map(item => item.human.text), [0,1,2].map(i => 'Full unchanged 😀 original user' + i))
})

test('owned reads: a caller-handled item failure does not turn an otherwise completed scoped read into global failure', async () => {
  const remote = new Remote({ 'Workspace/bad.txt': 'bad', 'Workspace/good.txt': 'good' }), badSha = blobHash('bad')
  const failure = new Error('isolated item read failed'), reported: unknown[] = []
  const binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1 }
  const repo = new GitHubRepository(new GitHubClient(async () => ({ value: 'synthetic-item-isolation', source: 'fixture' }), (url, init) => {
    if (url.endsWith('/git/blobs/' + badSha)) throw failure
    return remote.fetch(url, init)
  }), () => binding)
  const result = await repo.withReadOperation(async () => {
    const snapshot = await repo.snapshot()
    try { await repo.read(snapshot, 'dss-coop/bad.txt') } catch (error) { reported.push(error) }
    return repo.read(snapshot, 'dss-coop/good.txt')
  })
  assert.equal(result, 'good'); assert.equal(reported.length, 1)
  assert.ok(reported[0] instanceof GitHubError); assert.equal(reported[0].status, 0); assert.equal(reported[0].message, failure.message)
})

test('owned reads: cancelling one owner does not cancel another reading the same unexpanded tree', async () => {
  const remote = new Remote({ 'Workspace/nested/a.txt': 'A' })
  const binding: RepoBinding = { ownerRepo: 'example/private', repositoryDirectory: 'Workspace', participantId: 1 }
  const entered = Promise.withResolvers<void>(), fail = Promise.withResolvers<void>(), cause = new Error('owner A only')
  let hold = false
  const subtree = [...remote.trees].find(([, entries]) => entries.some(entry => entry.path === 'a.txt'))![0]
  const repo = new GitHubRepository(new GitHubClient(async () => ({ value: 'synthetic-shared-tree', source: 'fixture' }), async (url, init) => {
    if (hold && url.endsWith('/git/trees/' + subtree)) {
      hold = false; entered.resolve()
      await new Promise<void>((_resolve, reject) => {
        if (init!.signal!.aborted) reject(init!.signal!.reason)
        else init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })
    }
    return remote.fetch(url, init)
  }), () => binding)
  await repo.withReadOperation(async () => repo.listDirectory(await repo.snapshot(), 'dss-coop/'))
  hold = true
  let body!: Promise<string | undefined>
  const a = repo.withReadOperation(async () => {
    body = repo.read(await repo.snapshot(), 'dss-coop/nested/a.txt'); void body.catch(() => {})
    await entered.promise; await fail.promise; throw cause
  }); void a.catch(() => {})
  await entered.promise
  const b = repo.withReadOperation(async () => repo.read(await repo.snapshot(), 'dss-coop/nested/a.txt')); void b.catch(() => {})
  await new Promise(resolve => setImmediate(resolve)); fail.resolve()
  await assert.rejects(a); await assert.rejects(body)
  assert.equal(await b, 'A')
})
