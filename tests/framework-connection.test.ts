import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoragePort } from '../src/contracts/ports.js'
import { openFrameworkConnection, openFrameworkStorage } from '../src/framework/connection.js'
import { withSnapshot } from '../src/framework/transactions.js'

// Controlled HTTP backend exercises the real GitHubRepository/GitFiles/registration
// composition. No real GitHub account, CLI credential lookup or network mutation.
const hash = (text: string) => createHash('sha1').update(text).digest('hex')
const blobHash = (text: string) => hash('blob ' + Buffer.byteLength(text) + '\0' + text)
interface Commit { sha: string; tree: { sha: string }; parents: Array<{ sha: string }>; message: string; files: Map<string, string> }
class Remote {
  head = ''
  commits = new Map<string, Commit>()
  trees = new Map<string, Array<{ path: string; type: 'tree' | 'blob'; sha: string; size?: number }>>()
  blobs = new Map<string, string>()
  requests: Array<{ method: string; path: string; body: any }> = []
  branch = 'main'
  repositoryId = 77
  inviteStatus: 201 | 204 | 403 = 201
  memberCount = 0
  memberDeleteStatus: 204 | 403 = 204
  identity = { id: 1, login: 'alice' }
  forbidden = false
  failReads = false
  corruptBlob = false
  mutationMode: 'normal' | 'lost-after-commit' | 'lost-before-commit' | 'partial-after-commit' | 'graphql-rejected' | 'race' | 'lost-after-later-commit' = 'normal'
  constructor(files: Record<string, string> | null = { 'README.md': 'Owner notes: keep me.\n', 'Workspace/state/seed': '' }) {
    if (files) this.append(new Map(Object.entries(files)), 'initial')
  }
  append(files: Map<string, string>, message: string, parent = this.head): string {
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
    if (path === '/repos/example/private') return Response.json({ id: this.repositoryId, full_name: 'example/private', private: true, default_branch: this.branch, permissions: { pull: true, push: true, admin: false } })
    if (method === 'GET' && ['/repos/example/private/invitations', '/repos/example/private/collaborators'].includes(path)) {
      assert.equal(parsed.searchParams.get('per_page'), '100')
      const page = Number(parsed.searchParams.get('page'))
      assert.ok(Number.isSafeInteger(page) && page > 0)
      const rows = Array.from({ length: this.memberCount }, (_, i) => path.endsWith('/invitations')
        ? { id: i + 1, invitee: { login: 'pending-' + i }, html_url: 'https://github.com/example/private/invitations/' + (i + 1) }
        : { id: i + 1, login: 'member-' + i, permissions: { pull: true, push: true, admin: false } })
      return Response.json(rows.slice((page - 1) * 100, page * 100))
    }
    if (method === 'DELETE' && (path.startsWith('/repos/example/private/invitations/') || path.startsWith('/repos/example/private/collaborators/'))) {
      assert.equal(body, undefined)
      return this.memberDeleteStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ message: 'Member action denied' }, { status: 403 })
    }
    if (method === 'PUT' && path.startsWith('/repos/example/private/collaborators/')) {
      assert.deepEqual(body, { permission: 'push' })
      if (this.inviteStatus === 403) return Response.json({ message: 'Only authorized repository managers may invite.' }, { status: 403 })
      return this.inviteStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ id: 901 }, { status: 201 })
    }
    if (this.failReads && method === 'GET') throw new Error('Synthetic read outage')
    if (path.startsWith('/repos/example/private/commits/heads/')) {
      assert.equal(new Headers(init?.headers).get('accept'), 'application/vnd.github.sha')
      const branch = path.slice('/repos/example/private/commits/heads/'.length).split('/').map(decodeURIComponent).join('/')
      if (branch !== this.branch || !this.head) return Response.json({ message: 'Reference not found' }, { status: 404 })
      return new Headers(init?.headers).get('if-none-match') === `"${this.head}"`
        ? new Response(null, { status: 304 }) : new Response(this.head + '\n')
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
      assert.match(body.query, /createCommitOnBranch/)
      assert.equal(input.branch.repositoryNameWithOwner, 'example/private')
      assert.equal(input.branch.branchName, this.branch)
      assert.deepEqual(Object.keys(input.branch).sort(), ['branchName', 'repositoryNameWithOwner'], 'official CommittableBranch input fields')
      if (this.mutationMode === 'race') { this.mutationMode = 'normal'; this.change({ 'Workspace/state/new-notice': '' }) }
      if (input.expectedHeadOid !== this.head) return Response.json({ data: { createCommitOnBranch: null }, errors: [{ type: 'UNPROCESSABLE', message: 'expectedHeadOid does not match current HEAD' }] })
      if (this.mutationMode === 'graphql-rejected') return Response.json({ data: { createCommitOnBranch: null }, errors: [{ message: 'Branch policy rejected this write' }] })
      if (this.mutationMode === 'lost-before-commit') throw new Error('Synthetic transport lost before application')
      const files = new Map(this.commits.get(this.head)!.files)
      for (const item of input.fileChanges.additions) files.set(item.path, Buffer.from(item.contents, 'base64').toString('utf8'))
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
function memory(): StoragePort {
  const rows = new Map<string, unknown>()
  return {
    get: async key => structuredClone(rows.get(key)) as never,
    set: async (key, value) => { rows.set(key, structuredClone(value)) },
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never,
  }
}
async function directory(t: any): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dss-connection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const gitSettings = { mode: 'git' as const, ownerRepo: 'example/private', repositoryDirectory: 'Workspace', workerSeats: 2 }
function dependencies(remote: Remote, storage = memory(), now = () => 0) {
  return { storage, now, credentials: { resolve: async () => ({ value: 'synthetic-not-a-secret', source: 'fixture' }) },
    fetch: (url: string, init?: RequestInit) => remote.fetch(url, init) }
}

test('connection: Local save registers/readbacks, UUID identity and scope persist, tick/close use the same store', async t => {
  const root = await directory(t), storage = memory()
  let now = 0
  const settings = { mode: 'local' as const, directory: root, workerSeats: 2 }
  const first = await openFrameworkConnection(settings, { storage, now: () => now })
  assert.match(first.registration.member, /^local-[0-9a-f-]{36}$/)
  assert.equal(first.registration.primary, true)
  assert.equal((await first.members())[0]!.heartbeat!.sequence, 1)
  now = 29_999; await first.tick()
  assert.equal((await first.members())[0]!.heartbeat!.sequence, 1)
  now = 30_000; await first.tick()
  assert.equal((await first.members())[0]!.heartbeat!.sequence, 2)
  const identity = first.registration.member, scope = first.scope
  await first.close(); await first.close()
  await assert.rejects(first.tick(), /closed/)
  const next = await openFrameworkConnection({ ...settings, directory: join(root, '.') }, { storage, now: () => now })
  assert.equal(next.scope, scope)
  assert.equal(next.registration.member, identity)
  assert.equal((await next.members())[0]!.heartbeat!.sequence, 4)
  await next.close()
})

test('connection: Local all registered resources stay visible when offline, stopped, or unknown', async t => {
  const root = await directory(t)
  let now = 0
  const settings = { mode: 'local' as const, directory: root, login: 'local-owner', workerSeats: 2 }
  const a = await openFrameworkConnection(settings, { storage: memory(), now: () => now })
  const b = await openFrameworkConnection({ ...settings, workerSeats: 4 }, { storage: memory(), now: () => now })
  assert.equal(b.registration.member, 'local-owner1')
  assert.equal(b.registration.primary, true, 'Local participation is primary for its own persisted instance, not Git owner allocation')
  const aRoster = await a.members(), bRoster = await b.members()
  assert.equal(aRoster.length, 2)
  assert.deepEqual(aRoster.filter(row => row.primary).map(row => row.instanceUUID), [a.registration.instanceUUID])
  assert.deepEqual(bRoster.filter(row => row.primary).map(row => row.instanceUUID), [b.registration.instanceUUID])
  now = 180_000
  assert.ok((await a.members()).every(row => row.availability === 'offline'))
  await b.close()
  const roster = await a.members()
  assert.equal(roster.length, 2)
  assert.equal(roster.find(row => row.member === 'local-owner1')!.availability, 'stopped')
  assert.equal(roster.find(row => row.member === 'local-owner1')!.workerSeats, 4)
  await a.close()
})

test('connection: a Local display name containing path separators does not require a new identity setting', async t => {
  const root = await directory(t), storage = memory()
  const connection = await openFrameworkConnection({ mode: 'local', directory: root, login: 'User / 用户\nDisplay', workerSeats: 2 }, { storage })
  assert.match(connection.registration.member, /^local-[0-9a-f-]{36}$/)
  assert.equal(connection.registration.primary, true)
  assert.equal((await storage.list<any>('framework-connection-settings/'))[0]!.value.login, 'User / 用户\nDisplay')
  await connection.close()
})

test('connection: Git uses authoritative identity, real remote CAS/readback and targeted member discovery', async () => {
  const remote = new Remote(), deps = dependencies(remote)
  const connection = await openFrameworkConnection(gitSettings, deps)
  assert.equal(connection.registration.member, 'alice')
  assert.equal(connection.registration.primary, false, 'repository owner is example, not authenticated alice')
  assert.equal(connection.repository!.identity.id, 1)
  assert.equal(remote.count('/graphql'), 1)
  assert.ok(remote.count('/git/blobs/') > 0, 'registration was actually read back')
  assert.equal((await connection.members()).length, 1)
  const saved = await deps.storage.list<any>('framework-git-operations/')
  assert.equal(saved.length, 1)
  assert.equal(JSON.stringify(saved).includes('synthetic-not-a-secret'), false)
  assert.equal(saved[0]!.value.operation.authorId, 1)
  assert.ok(remote.requests.every(request => !request.path.includes('recursive')))
  await connection.close()
  const body = remote.commits.get(remote.head)!.files.get('Workspace/' + connection.registration.path)!
  assert.equal(JSON.parse(body).status, 'stopped')
})

test('connection: empty Git repository bootstraps once then registers atomically inside exact Unicode root', async () => {
  const remote = new Remote(null), deps = dependencies(remote)
  const connection = await openFrameworkConnection({ ...gitSettings, repositoryDirectory: 'Maid space/中国' }, deps)
  assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 1)
  assert.equal(remote.count('/graphql'), 1)
  const files = remote.commits.get(remote.head)!.files
  assert.ok(files.has('Maid space/中国/README.md'))
  assert.ok(files.has('Maid space/中国/' + connection.registration.path))
  await connection.close()
})

test('connection: denied access never returns successful connection and never dispatches writes', async () => {
  const remote = new Remote(); remote.forbidden = true
  await assert.rejects(openFrameworkConnection(gitSettings, dependencies(remote)), /403/)
  assert.equal(remote.count('/graphql'), 0)
  assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 0)
})

test('connection: unknown remote registration survives reopening without new payload or duplicate commit', async () => {
  const remote = new Remote(), deps = dependencies(remote)
  remote.mutationMode = 'lost-after-commit'
  const fetch = deps.fetch
  deps.fetch = async (url, init) => {
    try { return await fetch(url, init) }
    catch (error) { if (new URL(url).pathname === '/graphql') remote.failReads = true; throw error }
  }
  await assert.rejects(openFrameworkConnection(gitSettings, deps), /uncertain/)
  const pending = (await deps.storage.list<any>('framework-instance/'))[0]!.value.pending
  assert.equal(pending.heartbeat.sequence, 1)
  assert.equal(remote.count('/graphql'), 1)
  remote.failReads = false; remote.mutationMode = 'normal'; deps.fetch = fetch
  const connection = await openFrameworkConnection(gitSettings, deps)
  assert.equal(remote.count('/graphql'), 1, 'confirmed original commit rather than minting a new operation')
  const body = await withSnapshot(connection.files, s => connection.files.read(s, connection.registration.path))
  assert.deepEqual(JSON.parse(body!), pending.heartbeat)
  await connection.close()
})

test('connection: revoked access during close stops locally and exposes remote error', async () => {
  const remote = new Remote(), connection = await openFrameworkConnection(gitSettings, dependencies(remote))
  remote.forbidden = true
  await assert.rejects(connection.close(), /403/)
  await assert.rejects(connection.tick(), /closed/)
  await assert.rejects(connection.members(), /closed/)
})

test('connection: switching working roots never reuses or clears another roots unresolved publication', async () => {
  const remote = new Remote(), deps = dependencies(remote)
  remote.mutationMode = 'lost-after-commit'
  const fetch = deps.fetch
  deps.fetch = async (url, init) => {
    try { return await fetch(url, init) }
    catch (error) { if (new URL(url).pathname === '/graphql') remote.failReads = true; throw error }
  }
  await assert.rejects(openFrameworkConnection(gitSettings, deps), /uncertain/)
  const original = (await deps.storage.list<any>('framework-instance/'))[0]!
  remote.failReads = false; remote.mutationMode = 'normal'; deps.fetch = fetch
  const other = await openFrameworkConnection({ ...gitSettings, repositoryDirectory: 'Other' }, deps)
  assert.deepEqual(await deps.storage.get(original.key), original.value, 'old working root keeps its exact pending recovery metadata')
  await other.close()
  const count = remote.count('/graphql')
  const resumed = await openFrameworkConnection(gitSettings, deps)
  assert.equal(remote.count('/graphql'), count, 'old root confirms its original operation despite later commits in the other root')
  assert.deepEqual((await resumed.members())[0]!.heartbeat, original.value.pending.heartbeat)
  await resumed.close()
})

test('connection: changed default branch isolates pending registration and returning confirms original branch', async () => {
  const main = new Remote(), other = new Remote(), storage = memory()
  other.branch = 'other'
  let selected = main
  const deps = dependencies(main, storage)
  deps.fetch = async (url, init) => {
    try { return await selected.fetch(url, init) }
    catch (error) { if (new URL(url).pathname === '/graphql') selected.failReads = true; throw error }
  }
  main.mutationMode = 'lost-after-commit'
  await assert.rejects(openFrameworkConnection(gitSettings, deps), /uncertain/)
  const original = (await storage.list<any>('framework-instance/'))[0]!
  selected = other
  const second = await openFrameworkConnection(gitSettings, deps)
  assert.equal(second.repository!.repository.branch, 'other')
  assert.deepEqual(await storage.get(original.key), original.value)
  await second.close()
  main.failReads = false; main.mutationMode = 'normal'; selected = main
  const resumed = await openFrameworkConnection(gitSettings, deps)
  assert.equal(main.count('/graphql'), 1)
  assert.equal(resumed.repository!.repository.branch, 'main')
  assert.deepEqual((await resumed.members())[0]!.heartbeat, original.value.pending.heartbeat)
  await resumed.close()
})


test('storage: Local frontend read/write and release never register background participation', async t => {
  const root = await directory(t), storage = memory()
  const settings = { mode: 'local' as const, directory: root, workerSeats: 2 }
  const access = await openFrameworkStorage(settings, { storage })
  const uuid = access.identity.instanceUUID
  await withSnapshot(access.files, async snapshot => {
    assert.deepEqual(await access.files.list(snapshot, 'instances'), [])
    assert.equal(await access.files.read(snapshot, 'conversation/history.json'), undefined)
  })
  await access.prepareWrite()
  await access.transactions.run('frontend-message', { message: 'hello' }, {}, async () => [
    { path: 'conversation/history.json', content: '["hello"]' },
  ])
  await access.close(); await access.close()
  await assert.rejects(access.prepareWrite(), /closed/)
  const reopened = await openFrameworkStorage(settings, { storage })
  assert.equal(reopened.identity.instanceUUID, uuid)
  await withSnapshot(reopened.files, async snapshot => {
    assert.deepEqual(await reopened.files.list(snapshot, 'instances'), [])
    assert.equal(await reopened.files.read(snapshot, 'conversation/history.json'), '["hello"]')
  })
  assert.deepEqual(await storage.list('framework-instance/'), [])
  await reopened.close()
})

test('storage: authorized Git frontend reads and close perform GETs only, no instance writes', async () => {
  const remote = new Remote(), deps = dependencies(remote), initialHead = remote.head
  const access = await openFrameworkStorage(gitSettings, deps)
  assert.equal(access.identity.login, 'alice')
  assert.equal(access.identity.owner, 'example')
  await withSnapshot(access.files, async snapshot => {
    assert.deepEqual(await access.files.list(snapshot, 'instances'), [])
    assert.equal(await access.files.read(snapshot, 'state/seed'), '')
    assert.equal(await access.files.readBytes(snapshot, 'missing-attachment'), undefined)
  })
  await access.close()
  assert.equal(remote.head, initialHead)
  assert.ok(remote.requests.every(request => request.method === 'GET'))
  assert.deepEqual(await deps.storage.list('framework-instance/'), [])
})

test('storage: empty Git frontend reads do not bootstrap; explicit message write can initialize without joining', async () => {
  const remote = new Remote(null), deps = dependencies(remote)
  const access = await openFrameworkStorage(gitSettings, deps)
  await withSnapshot(access.files, async snapshot => {
    assert.equal(snapshot.revision, '')
    assert.deepEqual(await access.files.list(snapshot, ''), [])
    assert.equal(await access.files.read(snapshot, 'conversation/history.json'), undefined)
  })
  assert.equal(remote.head, '')
  assert.ok(remote.requests.every(request => request.method === 'GET'))
  await access.prepareWrite(); await access.prepareWrite()
  assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 1)
  await access.transactions.run('frontend-message', { text: 'hello' }, {}, async () => [
    { path: 'conversation/history.json', content: '["hello"]' },
  ])
  await access.close()
  assert.equal(remote.count('/graphql'), 1)
  const files = remote.commits.get(remote.head)!.files
  assert.equal(files.get('Workspace/conversation/history.json'), '["hello"]')
  assert.ok([...files.keys()].every(path => !path.startsWith('Workspace/instances/')))
  assert.deepEqual(await deps.storage.list('framework-instance/'), [])
})

test('storage: closing a frontend handle cannot stop an already participating instance', async () => {
  const remote = new Remote(), deps = dependencies(remote)
  const participant = await openFrameworkConnection(gitSettings, deps)
  const head = remote.head
  const heartbeat = remote.commits.get(head)!.files.get('Workspace/' + participant.registration.path)
  const access = await openFrameworkStorage(gitSettings, deps)
  await access.close()
  assert.equal(remote.head, head)
  assert.equal(remote.commits.get(remote.head)!.files.get('Workspace/' + participant.registration.path), heartbeat)
  assert.equal((await participant.members())[0]!.heartbeat!.status, 'running')
  await participant.close()
})


test('storage invitation uses the authenticated collaborator PUT and reports pending/accepted without joining a backend', async () => {
  const remote = new Remote(), deps = dependencies(remote), head = remote.head
  const access = await openFrameworkStorage(gitSettings, deps)
  try {
    assert.equal(access.repository?.repository.permissions.admin, false)
    assert.deepEqual(await access.invite!('invited-user'), { status: 'pending', id: 901, login: 'invited-user' })
    remote.inviteStatus = 204
    assert.deepEqual(await access.invite!('existing-user'), { status: 'accepted', id: undefined, login: 'existing-user' })
    assert.deepEqual(remote.requests.filter(request => request.method === 'PUT'), [
      { method: 'PUT', path: '/repos/example/private/collaborators/invited-user', body: { permission: 'push' } },
      { method: 'PUT', path: '/repos/example/private/collaborators/existing-user', body: { permission: 'push' } },
    ])
    assert.equal(remote.head, head)
    assert.equal(remote.count('/graphql'), 0)
    assert.ok([...remote.commits.get(remote.head)!.files.keys()].every(path => !path.startsWith('Workspace/instances/')))
    assert.deepEqual(await deps.storage.list('framework-instance/'), [])
  } finally { await access.close() }
})
test('invitation authorization comes from the actual API response, not cached admin=false', async () => {
  const remote = new Remote(), access = await openFrameworkStorage(gitSettings, dependencies(remote))
  try {
    remote.inviteStatus = 403
    await assert.rejects(access.invite!('invited-user'), (error: any) => error.status === 403 && /authorized repository managers/.test(error.message))
    assert.equal(remote.requests.filter(request => request.method === 'PUT' && request.path.includes('/collaborators/')).length, 1)
    assert.equal(remote.count('/graphql'), 0)
  } finally { await access.close() }
})
test('invitation rejects changed authenticated account or repository identity before collaborator mutation', async () => {
  for (const changed of ['account', 'repository'] as const) {
    const remote = new Remote(), access = await openFrameworkStorage(gitSettings, dependencies(remote))
    try {
      if (changed === 'account') remote.identity = { id: 2, login: 'another-user' }
      else remote.repositoryId = 88
      await assert.rejects(access.invite!('invited-user'), (error: any) => error.status === 409 && /account changed|different GitHub repository/.test(error.message))
      assert.equal(remote.requests.filter(request => request.method !== 'GET').length, 0, changed)
    } finally { await access.close() }
  }
})

test('member lists follow authenticated paginated GitHub endpoints and remain separate from active instances', async () => {
  const remote = new Remote(), deps = dependencies(remote), head = remote.head
  remote.memberCount = 101
  const access = await openFrameworkStorage(gitSettings, deps)
  try {
    const result = await access.gitMembers!()
    assert.equal(result.invitations.length, 101)
    assert.equal(result.collaborators.length, 101)
    assert.equal(result.invitations[100]!.status, 'pending')
    assert.equal(result.collaborators[100]!.status, 'accepted')
    assert.equal(result.collaborators[100]!.login, 'member-100')
    for (const endpoint of ['invitations', 'collaborators']) assert.deepEqual(remote.requests.filter(request => request.path.includes('/' + endpoint + '?')).map(request => request.path), [
      '/repos/example/private/' + endpoint + '?per_page=100&page=1', '/repos/example/private/' + endpoint + '?per_page=100&page=2',
    ])
    assert.deepEqual(await deps.storage.list('framework-instance/'), [])
    assert.equal(remote.head, head)
    assert.equal(remote.requests.filter(request => request.method !== 'GET').length, 0)
  } finally { await access.close() }
})
test('explicit cancel/remove use authenticated DELETE and preserve actual permission errors', async () => {
  const remote = new Remote(), access = await openFrameworkStorage(gitSettings, dependencies(remote))
  try {
    await access.gitMemberAction!({ action: 'cancelInvitation', invitationId: 901 })
    await access.gitMemberAction!({ action: 'remove', username: 'existing-user' })
    assert.deepEqual(remote.requests.filter(request => request.method === 'DELETE').map(request => request.path), [
      '/repos/example/private/invitations/901', '/repos/example/private/collaborators/existing-user',
    ])
    remote.memberDeleteStatus = 403
    await assert.rejects(access.gitMemberAction!({ action: 'remove', username: 'denied-user' }), (error: any) => error.status === 403 && /Member action denied/.test(error.message))
    assert.equal(remote.count('/graphql'), 0)
  } finally { await access.close() }
})
test('member deletion and list refresh reject changed account/repository scope before touching authorization lists', async () => {
  for (const changed of ['account', 'repository'] as const) {
    const remote = new Remote(), access = await openFrameworkStorage(gitSettings, dependencies(remote))
    try {
      if (changed === 'account') remote.identity = { id: 99, login: 'different' }; else remote.repositoryId = 99
      await assert.rejects(access.gitMembers!(), (error: any) => error.status === 409)
      await assert.rejects(access.gitMemberAction!({ action: 'cancelInvitation', invitationId: 901 }), (error: any) => error.status === 409)
      assert.equal(remote.requests.filter(request => request.path.includes('/invitations') || request.path.includes('/collaborators')).length, 0)
    } finally { await access.close() }
  }
})

for (const empty of [true, false]) for (const root of ['', '团队 space/嵌套']) {
  test(`connection matrix: ${empty ? 'empty' : 'existing'} repository × ${root || 'root'} preserves unrelated data and reopens`, async () => {
    const remote = new Remote(empty ? null : { 'owner.txt': 'untouched' }), deps = dependencies(remote)
    const settings = { ...gitSettings, repositoryDirectory: root }
    const first = await openFrameworkConnection(settings, deps)
    const physical = (root ? root + '/' : '') + first.registration.path
    assert.ok(remote.commits.get(remote.head)!.files.has(physical))
    assert.equal(remote.requests.filter(r => r.method === 'PUT').length, empty ? 1 : 0)
    if (!empty) assert.equal(remote.commits.get(remote.head)!.files.get('owner.txt'), 'untouched')
    const scope = first.scope
    await first.close()
    const next = await openFrameworkConnection(settings, deps)
    assert.equal(next.scope, scope)
    assert.equal(next.registration.path, first.registration.path)
    assert.equal((await next.members()).length, 1)
    assert.equal(remote.requests.filter(r => r.method === 'PUT').length, empty ? 1 : 0)
    await next.close()
  })
}

test('connection: NFC and NFD directory scopes remain byte-distinct through registration, readback and close', async () => {
  const nfc = '团队/café', nfd = nfc.normalize('NFD')
  assert.notEqual(nfc, nfd)
  const remote = new Remote({ [nfc + '/sentinel']: 'NFC', [nfd + '/sentinel']: 'NFD' }), deps = dependencies(remote)
  const a = await openFrameworkConnection({ ...gitSettings, repositoryDirectory: nfc }, deps)
  const b = await openFrameworkConnection({ ...gitSettings, repositoryDirectory: nfd }, deps)
  assert.notEqual(a.scope, b.scope)
  for (const [connection, expected] of [[a, 'NFC'], [b, 'NFD']] as const) {
    await withSnapshot(connection.files, async snapshot => assert.equal(await connection.files.read(snapshot, 'sentinel'), expected))
    assert.equal((await connection.members()).length, 1)
  }
  await a.close()
  assert.equal(JSON.parse(remote.commits.get(remote.head)!.files.get(nfc + '/' + a.registration.path)!).status, 'stopped')
  assert.notEqual(JSON.parse(remote.commits.get(remote.head)!.files.get(nfd + '/' + b.registration.path)!).status, 'stopped')
  await b.close()
})

test('connection: changing Local display login keeps the registered alias and primary ownership on reconnect', async t => {
  const root = await directory(t), storage = memory()
  const first = await openFrameworkConnection({ mode: 'local', directory: root, login: 'Alice', workerSeats: 4 }, { storage })
  const original = first.registration
  await first.close()
  const next = await openFrameworkConnection({ mode: 'local', directory: root, login: 'Bob', workerSeats: 4 }, { storage })
  try {
    assert.equal(next.registration.member, original.member)
    assert.equal(next.registration.instanceUUID, original.instanceUUID)
    assert.equal(next.registration.primary, true, 'a Local display change cannot demote the same persisted local instance')
    assert.equal((await next.members()).find(row => row.instanceUUID === original.instanceUUID)!.primary, true)
    const updated = await next.updateWorkerSeats(1)
    assert.equal(updated.primary, true)
    assert.equal(updated.member, original.member)
  } finally { await next.close() }
})

for (const mode of ['local', 'git'] as const) test('connection: ' + mode + ' hot worker seats 4 to 1 atomically preserve the live registration identity', async t => {
  const remote = new Remote(), storage = memory()
  const connection = mode === 'local'
    ? await openFrameworkConnection({ mode: 'local', directory: await directory(t), login: 'local-owner', workerSeats: 4 }, { storage })
    : await openFrameworkConnection({ ...gitSettings, workerSeats: 4 }, dependencies(remote, storage))
  try {
    const before = connection.registration, account = connection.repository?.identity
    const next = await connection.updateWorkerSeats(1)
    assert.equal(next.member, before.member)
    assert.equal(next.instanceUUID, before.instanceUUID)
    assert.equal(next.primary, before.primary)
    assert.equal(next.workerSeats, 1)
    assert.deepEqual(connection.registration, next, 'public registration reflects confirmed current capacity')
    assert.deepEqual(connection.repository?.identity, account)
    await withSnapshot(connection.files, async snapshot => {
      assert.equal(await connection.files.read(snapshot, before.path), undefined)
      assert.equal(JSON.parse((await connection.files.read(snapshot, next.path))!).sequence, 2)
      assert.equal((await connection.files.listDirectory(snapshot, 'instances')).filter(entry => entry.path.endsWith(before.instanceUUID + '.json')).length, 1)
    })
    assert.equal((await connection.members()).find(member => member.instanceUUID === before.instanceUUID)!.workerSeats, 1)
  } finally { await connection.close() }
})

test('connection: unknown hot seat change does not report success and retries the same prepared remote operation', async () => {
  const remote = new Remote(), deps = dependencies(remote)
  const originalFetch = deps.fetch
  let loseReadback = false
  deps.fetch = async (url, init) => {
    try { return await originalFetch(url, init) }
    catch (error) { if (loseReadback && new URL(url).pathname === '/graphql') remote.failReads = true; throw error }
  }
  const connection = await openFrameworkConnection({ ...gitSettings, workerSeats: 4 }, deps)
  try {
    const before = connection.registration, initialWrites = remote.count('/graphql')
    loseReadback = true; remote.mutationMode = 'lost-after-commit'
    await assert.rejects(connection.updateWorkerSeats(1), /uncertain/)
    assert.deepEqual(connection.registration, before, 'unknown remote result is not a confirmed registration')
    const pending = (await deps.storage.list<any>('framework-instance/'))[0]!.value.pending
    assert.equal(pending.heartbeat.sequence, 2)
    assert.equal(remote.count('/graphql'), initialWrites + 1)
    const operations = await deps.storage.list<any>('framework-git-operations/')
    loseReadback = false; remote.failReads = false; remote.mutationMode = 'normal'
    const resolved = await connection.updateWorkerSeats(1)
    assert.equal(resolved.workerSeats, 1)
    assert.equal(resolved.member, before.member)
    assert.equal(resolved.instanceUUID, before.instanceUUID)
    assert.equal(remote.count('/graphql'), initialWrites + 1, 'readback confirms the original write without resubmitting a fresh operation')
    assert.deepEqual((await deps.storage.list<any>('framework-git-operations/')).map(row => row.key), operations.map(row => row.key))
    await withSnapshot(connection.files, async snapshot => {
      assert.equal(await connection.files.read(snapshot, before.path), undefined)
      assert.deepEqual(JSON.parse((await connection.files.read(snapshot, resolved.path))!), pending.heartbeat)
    })
  } finally { remote.failReads = false; remote.mutationMode = 'normal'; await connection.close() }
})

test('connection lends its own snapshot to members but rejects other scopes and disconnected access', async t => {
  const a = await openFrameworkConnection({mode:'local',directory:await directory(t),workerSeats:2}, {storage:memory()})
  const b = await openFrameworkConnection({mode:'local',directory:await directory(t),workerSeats:2}, {storage:memory()})
  try {
    await withSnapshot(a.files, async snapshot => {
      assert.equal((await a.members(snapshot)).length, 1)
      assert.notEqual(await a.files.read(snapshot, a.registration.path), undefined)
      await assert.rejects(b.members(snapshot), /snapshot/i)
    })
    await b.close()
    await assert.rejects(b.members(), /closed/)
  } finally { await a.close(); await b.close() }
})

test('connection cancellation aborts only its pending HTTP and preserves separate frontend and peer handles', async () => {
  const remote=new Remote(), base=dependencies(remote), started=Promise.withResolvers<void>()
  let hold=false, aborted=0
  const connection=await openFrameworkConnection(gitSettings,{...base,fetch:async(url,init)=>{
    if(hold && url.includes('/commits/heads/')) { started.resolve();return new Promise<Response>((_resolve,reject)=>{
      init!.signal!.addEventListener('abort',()=>{aborted++;reject(init!.signal!.reason)},{once:true})
    }) }
    return remote.fetch(url,init)
  }})
  const front=await openFrameworkStorage(gitSettings,dependencies(remote))
  const peer=await openFrameworkConnection(gitSettings,dependencies(remote))
  try {
    hold=true
    const pending=connection.files.snapshot().then(()=>({cancelled:false}),error=>({cancelled:error.name==='AbortError'}))
    await started.promise;connection.cancelPending()
    assert.deepEqual(await pending,{cancelled:true});assert.equal(aborted,1)
    await withSnapshot(front.files,async snapshot=>assert.ok(snapshot.revision))
    await withSnapshot(front.files,snapshot=>front.files.commit(snapshot,[{path:'foreground/owned-chat.txt',content:'front remains writable'}],'independent frontend write'))
    assert.equal((await peer.members()).length,2)
    hold=false;await connection.close()
    const observed=await peer.members()
    assert.equal(observed.find(row=>row.instanceUUID===connection.registration.instanceUUID)!.availability,'stopped')
    assert.notEqual(observed.find(row=>row.instanceUUID===peer.registration.instanceUUID)!.availability,'stopped')
  } finally {hold=false;connection.cancelPending();await connection.close();await front.close();await peer.close()}
})

test('cancelled opening propagates ownership into token acquisition before any remote mutation', async () => {
  const remote=new Remote(), controller=new AbortController(), entered=Promise.withResolvers<void>()
  let aborted=0
  const pending=openFrameworkConnection(gitSettings,{...dependencies(remote),signal:controller.signal,
    credentials:{resolve:async signal=>{assert.ok(signal);entered.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(signal.reason)},{once:true}));throw new Error('unreachable')}}})
    .then(()=>({cancelled:false}),error=>({cancelled:error.name==='AbortError'}))
  await entered.promise;controller.abort()
  assert.deepEqual(await pending,{cancelled:true});assert.equal(aborted,1)
  assert.equal(remote.requests.length,0)
  await assert.rejects(openFrameworkConnection(gitSettings,{...dependencies(remote),signal:controller.signal}),{name:'AbortError'})
  assert.equal(remote.requests.length,0)
})
