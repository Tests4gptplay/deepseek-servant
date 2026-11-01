import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { GitHubRepository, GitCommitOutcomeUnknownError } from '../src/experimental/private-git/git-repository.js'
import { GitHubClient, GitConflictError } from '../src/experimental/private-git/github.js'
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
  requests: Array<{ method: string; path: string; body: any }> = []
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
    this.requests.push({ method, path: path + parsed.search, body })
    if (this.forbidden) return Response.json({ message: 'Access revoked' }, { status: 403 })
    if (path === '/user') return Response.json(this.identity)
    if (path === '/repos/example/private') return Response.json({ id: 77, full_name: 'example/private', private: true, default_branch: this.branch, permissions: { pull: true, push: true } })
    if (this.failReads && method === 'GET') throw new Error('Synthetic read outage')
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
      return Response.json({ data: { createCommitOnBranch: { commit: { oid } } } })
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
  assert.deepEqual(await fresh.resolveCommit(JSON.parse(JSON.stringify(operation))), { status: 'confirmed', commit: result.commit, head: remote.head })
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
  assert.deepEqual(await restarted.resolveCommit(JSON.parse(JSON.stringify(operation))), { status: 'confirmed', commit: committed, head: remote.head })
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
  await assert.rejects(repo.commitPrepared(base, [{ ...changes[0]!, content: 'different' }], 'Publish', operation), /different input/)
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
