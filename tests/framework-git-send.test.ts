import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { StoragePort } from '../src/contracts/ports.js'
import { openFrameworkStorage } from '../src/framework/connection.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { readPlanResponse } from './git-read-plan-fixture.js'

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
  credentialResolutions = 0
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
    if (path === '/graphql' && body?.query?.startsWith('query DSSReadPlan')) return readPlanResponse(this, body)
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
      ;(await import('graphql')).parse(body.query)
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
const gitSettings = { mode: 'git' as const, ownerRepo: 'example/private', repositoryDirectory: 'Workspace', workerSeats: 2 }
function dependencies(remote: Remote, storage = memory(), now = () => 0) {
  return { storage, now, credentials: { resolve: async () => { remote.credentialResolutions++; return { value: 'synthetic-not-a-secret', source: 'fixture' } } },
    fetch: (url: string, init?: RequestInit) => remote.fetch(url, init) }
}


import { FrameworkService } from '../src/framework/service.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { FrameworkClientController, type FrameworkClientApi, type FrameworkSendInput } from '../src/framework/client-contracts.js'
async function serviceFixture(t: test.TestContext) {
  const remote = new Remote(), storage = memory()
  const settings = { name: 'Test', userName: '', localDirectory: '', ownerRepo: 'example/private', repositoryDirectory: 'Workspace', collaborationId: 'same-team', workerSeats: 0, workspace: '' }
  const service = new FrameworkService({} as any, storage, settings), internal = service as any
  const connections: Awaited<ReturnType<typeof openFrameworkStorage>>[] = []
  const install = async (repositoryDirectory = 'Workspace') => {
    const connection = await openFrameworkStorage({ ...gitSettings, repositoryDirectory }, dependencies(remote, storage))
    connections.push(connection)
    const conversation = new FrameworkConversation(connection.files, connection.transactions, { mode: 'git', collaborationId: 'same-team' })
    internal.saved.set('git', { revision: repositoryDirectory, settings: { ...settings, repositoryDirectory } })
    internal.accesses.set('git', Promise.resolve({ connection, conversation }))
    return { connection, conversation }
  }
  const first = await install()
  const access = internal.access.bind(internal)
  internal.access = (mode: string) => { assert.equal(mode, 'git'); assert.ok(internal.accesses.has(mode), 'native credential path forbidden'); return access(mode) }
  t.after(async () => { for (const connection of connections) await connection.close() })
  const input = (id: string): FrameworkSendInput => ({ mode: 'git', storageScope: first.connection.scope, collaborationId: 'same-team', id, text: 'Original '+id, recipient: 'ai', device: 'test', createdAt: '2026-10-31T00:00:00Z', timezoneOffsetMinutes: 0 })
  return { remote, storage, service, install, input, ...first }
}

test('Git send: lost mutation response resolves same original message without duplicate commit or notice', async t => {
  const f = await serviceFixture(t)
  f.remote.mutationMode = 'lost-after-commit'
  await f.service.send(f.input('lost'))
  const commits = f.remote.commits.size
  await f.service.send(f.input('lost'))
  assert.equal(f.remote.commits.size, commits)
  assert.deepEqual((await f.conversation.page(20)).messages.map(message => message.id), ['lost'])
  await withSnapshot(f.connection.files, async snapshot => assert.equal((await f.conversation.notificationPaths(snapshot)).length, 1))
})
test('Git send: unknown before mutation preserves operation and retries original ID after connectivity returns', async t => {
  const f = await serviceFixture(t)
  f.remote.mutationMode = 'lost-before-commit'
  await assert.rejects(f.service.send(f.input('uncertain')))
  f.remote.mutationMode = 'normal'
  await f.service.send(f.input('uncertain'))
  assert.deepEqual((await f.conversation.page(20)).messages.map(message => message.id), ['uncertain'])
})
test('Git send: changed account and revoked repository permission fail before publication', async t => {
  const f = await serviceFixture(t), before = f.remote.count('/graphql')
  f.remote.identity = { id: 2, login: 'other' }
  await assert.rejects(f.service.send(f.input('account')))
  assert.equal(f.remote.count('/graphql'), before)
  f.remote.identity = { id: 1, login: 'alice' }; f.remote.forbidden = true
  await assert.rejects(f.service.send(f.input('revoked')))
  assert.equal(f.remote.count('/graphql'), before)
})
test('Git send: retained unknown message cannot follow same conversation into another repository directory', async t => {
  const f = await serviceFixture(t)
  f.remote.mutationMode = 'lost-before-commit'
  const original = f.input('bound')
  await assert.rejects(f.service.send(original))
  f.remote.mutationMode = 'normal'
  const other = await f.install('OtherRoot')
  await assert.rejects(f.service.send(original), /destination|scope/i)
  await assert.rejects(f.service.send({ ...original, storageScope: other.connection.scope }), /destination|content/i)
  assert.equal((await other.conversation.page(20)).messages.length, 0)
})
test('Git send: pending Foreground consumption does not block second durable acknowledgement', async t => {
  const f = await serviceFixture(t)
  await f.service.send(f.input('one')); await f.service.send(f.input('two'))
  assert.equal((await f.conversation.pendingForeground()).messages.length, 2)
  assert.equal((await f.conversation.page(20)).messages.length, 2)
})
test('Git send: competing CAS preserves captured six complete exchanges and accepts original input', async t => {
  const f = await serviceFixture(t)
  for (let i = 0; i < 6; i++) {
    await f.service.send({ ...f.input('u'+i), recipient: 'ai' })
    await f.conversation.send('assistant-'+i, { id: 'a'+i, participantId: '1', role: 'assistant', replyTo: 'u'+i, text: 'Reply '+i, createdAt: '2026-10-31T00:01:00Z' })
  }
  const captured = await f.conversation.recentExchanges(), original = JSON.stringify(captured)
  f.remote.mutationMode = 'race'
  await assert.rejects(f.service.send(f.input('racing')))
  await f.service.send(f.input('racing'))
  assert.equal(JSON.stringify(captured), original)
  assert.equal((await f.conversation.recentExchanges()).length, 6)
  assert.equal((await f.conversation.page(50)).messages.filter(message => message.id === 'racing').length, 1)
})

import { Context } from '@deepseek-ai/cordis'
import { installFrameworkTransport } from '../src/framework/transport.js'
import { createRequestLifecycle } from '../src/client/request-lifecycle.js'
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
test('Git send: actual transport lifecycle reset cancels UI wait, not durable Host send; explicit retry is one message', async t => {
  const f = await serviceFixture(t), entered = deferred<void>(), release = deferred<void>()
  const originalFetch = f.remote.fetch.bind(f.remote)
  f.remote.fetch = async (url, init) => {
    const response = await originalFetch(url, init)
    if (new URL(url).pathname === '/graphql') { entered.resolve(); await release.promise }
    return response
  }
  const ctx = new Context(), routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
  const unprovide = ctx.provide('connection', { fetch: { register: (route: any) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } as any)
  const stop = installFrameworkTransport(ctx, f.service), lifecycle = createRequestLifecycle()
  await new Promise(resolve => setImmediate(resolve))
  t.after(async () => { release.resolve(); lifecycle.dispose(); await stop(); unprovide() })
  let hostResult!: Promise<Response>
  const input = f.input('reset')
  const waiting = lifecycle.request(undefined, signal => {
    hostResult = routes.get('/api/deepseek-servant-framework/send')!.fetch(new Request('http://host/api/deepseek-servant-framework/send', { method: 'POST', signal, body: JSON.stringify({ type: 'client-request', rpcId: 'reset', method: 'deepseek-servant-framework/send', payload: input }) }))
    return hostResult
  })
  await entered.promise
  lifecycle.reset(); await assert.rejects(waiting, /lifecycle ended/)
  release.resolve(); assert.equal((await (await hostResult).json()).result.ok, true)
  const commits = f.remote.commits.size
  await f.service.send(input)
  assert.equal(f.remote.commits.size, commits)
  assert.deepEqual((await f.conversation.page(20)).messages.map(message => message.id), ['reset'])
})

test('Git send: response-read outage keeps original recoverable operation and confirms without duplicate when restored', async t => {
  const f = await serviceFixture(t), originalFetch = f.remote.fetch.bind(f.remote)
  f.remote.fetch = async (url, init) => {
    const response = await originalFetch(url, init)
    if (new URL(url).pathname === '/graphql' && JSON.parse(String(init?.body)).query.startsWith('mutation DSSCommit')) { f.remote.failReads = true; throw new Error('controlled response and readback outage') }
    return response
  }
  await assert.rejects(f.service.send(f.input('readback')), (error: any) => { assert.equal(typeof error.operationId, 'string'); assert.ok(error.operationId); return true })
  const commits = f.remote.commits.size
  f.remote.fetch = originalFetch; f.remote.failReads = false
  await f.service.send(f.input('readback'))
  assert.equal(f.remote.commits.size, commits)
  assert.deepEqual((await f.conversation.page(20)).messages.map(message => message.id), ['readback'])
})

test('Git send: account switched during actual HTTP preflight cannot take over an already bound message', async t => {
  const f = await serviceFixture(t), entered = deferred<void>(), release = deferred<void>(), originalFetch = f.remote.fetch.bind(f.remote)
  let paused = false
  f.remote.fetch = async (url, init) => {
    if (!paused && new URL(url).pathname === '/user') { paused = true; entered.resolve(); await release.promise }
    return originalFetch(url, init)
  }
  const sending = f.service.send(f.input('account-barrier'))
  await entered.promise; f.remote.identity = { id: 9, login: 'switched' }; release.resolve()
  await assert.rejects(sending)
  assert.equal(f.remote.count('/graphql'), 0)
})

import { FrameworkClientController, type FrameworkClientApi } from '../src/framework/client-contracts.js'
test('Git view: one resolved Commit keeps messages, instances, tasks and archives on the same revision', async t => {
  const f = await serviceFixture(t)
  await f.service.send(f.input('same-snapshot'))
  const peer = 'Workspace/instances/peer_Workers1_00000000-0000-4000-8000-000000000099.json'
  const task = (id: string) => JSON.stringify({ version: 1, taskId: id, route: 'P', owner: 'alice', status: 'running', sourcePath: 'tasks/' + id + '_P.md' })
  f.remote.change({ [peer]: JSON.stringify({ sequence: 1, updatedAt: '2026-10-31T00:00:00Z', status: 'stopped' }),
    'Workspace/tasks/before.json': task('before'), 'Workspace/archives/before/records.md': 'old archive' })
  const files = f.connection.files, snapshot = files.snapshot.bind(files)
  let acquired = 0, released = 0
  files.snapshot = async (...args) => { acquired++; const s = await snapshot(...args), release = s.release.bind(s); s.release = async () => { released++; await release() }; return s }
  const page = f.conversation.page.bind(f.conversation)
  let change = true
  f.conversation.page = async (...args) => {
    const value = await page(...args)
    if (change) { change = false; f.remote.change({ [peer]: JSON.stringify({ sequence: 2, updatedAt: '2026-10-31T00:00:01Z', status: 'running' }),
      'Workspace/tasks/after.json': task('after'), 'Workspace/archives/after/records.md': 'new archive' }) }
    return value
  }
  f.remote.requests.length = 0
  const first = await f.service.view({ mode: 'git', includeArchives: true })
  assert.equal(f.remote.count('/commits/heads/'), 0)
  assert.equal(f.remote.requests.filter(row => row.body?.query?.startsWith('query DSSReadPlan') && row.body.variables.ref === 'refs/heads/main').length, 1)
  assert.equal(acquired, 1); assert.equal(released, 1)
  assert.equal(first.messages[0].text, f.input('same-snapshot').text)
  assert.equal(first.resources[0].status, 'stopped')
  assert.deepEqual(first.tasks.map(row => row.taskId), ['before'])
  assert.deepEqual(first.archives.map(row => row.taskId), ['before'])
  const second = await f.service.view({ mode: 'git', includeArchives: true })
  assert.equal(f.remote.requests.filter(row => row.body?.query?.startsWith('query DSSReadPlan') && row.body.variables.ref === 'refs/heads/main').length, 2, 'a new view still resolves the remote branch')
  assert.equal(acquired, 2); assert.equal(released, 2)
  assert.equal(second.resources[0].status, 'online')
  assert.deepEqual(second.tasks.map(row => row.taskId), ['after', 'before'])
  assert.deepEqual(second.archives.map(row => row.taskId), ['after', 'before'])
  assert.equal(second.connection.participating, false)
  assert.equal(f.remote.requests.filter(row => row.body?.query?.startsWith('mutation')).length, 0, 'passive views never restart registration or heartbeat')
})

test('Git view: cancellation settles the borrowed page before releasing once and skips later branches', async t => {
  const f = await serviceFixture(t), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController()
  await f.service.send(f.input('cancel-view'))
  const page = f.conversation.page.bind(f.conversation), files = f.connection.files, snapshot = files.snapshot.bind(files)
  let releases = 0, observed = 0
  files.snapshot = async (...args) => { const s = await snapshot(...args), close = s.release.bind(s); s.release = async () => { releases++; await close() }; return s }
  f.conversation.page = async (...args) => { const value = await page(...args); entered.resolve(); await release.promise; return value }
  const observe = (f.service as any).observe.bind(f.service)
  ;(f.service as any).observe = (...args: any[]) => { observed++; return observe(...args) }
  const reason = new Error('owned UI read cancelled'), reading = f.service.view({ mode: 'git' }, abort.signal)
  const rejected = assert.rejects(reading, error => error === reason)
  await entered.promise; abort.abort(reason)
  const releasesWhileBorrowed = releases
  release.resolve(); await rejected
  assert.equal(releasesWhileBorrowed, 0, 'outer owner must retain the snapshot while its borrowed reader is pending')
  assert.equal(releases, 1); assert.equal(observed, 0)
  f.conversation.page = page
  assert.equal((await f.service.view({ mode: 'git' })).messages[0].id, 'cancel-view')
})

test('Git view: changing the authorized scope invalidates an old borrowed read without exposing it in the new scope', async t => {
  const f = await serviceFixture(t), entered = deferred<void>(), release = deferred<void>()
  await f.service.send(f.input('old-scope'))
  const page = f.conversation.page.bind(f.conversation)
  f.conversation.page = async (...args) => { const value = await page(...args); entered.resolve(); await release.promise; return value }
  const reading = f.service.view({ mode: 'git' }), reason = new Error('original scope closed')
  const rejected = assert.rejects(reading, error => error === reason)
  await entered.promise; f.connection.cancelPending(reason)
  const next = await f.install('Other')
  release.resolve(); await rejected
  const current = await f.service.view({ mode: 'git' })
  assert.equal(current.storageScope, next.connection.scope); assert.deepEqual(current.messages, [])
  f.remote.forbidden = true
  await assert.rejects(f.service.view({ mode: 'git' }), /Access revoked/)
})

test('Git view: active backend resources are reused without adding a frontend instance scan', async t => {
  const f = await serviceFixture(t)
  await f.service.send(f.input('active-view'))
  ;(f.service as any).running.set('git', { connection: { scope: f.connection.scope, registration: { member: 'alice', workerSeats: 0 } },
    resources: [{ member: 'peer', primary: false, instanceUUID: '00000000-0000-4000-8000-000000000099', workerSeats: 1, availability: 'offline' }], runtime: {} })
  const list = f.connection.files.listDirectory.bind(f.connection.files)
  f.connection.files.listDirectory = async (snapshot, prefix) => { assert.notEqual(prefix, 'instances/', 'active resources already own this observation'); return list(snapshot, prefix) }
  f.remote.requests.length = 0
  const view = await f.service.view({ mode: 'git' })
  assert.equal(view.resources[0].status, 'offline'); assert.equal(view.hasOtherInstanceRecords, true)
  assert.equal(f.remote.count('/commits/heads/'), 0)
  assert.equal(f.remote.requests.filter(row => row.body?.query?.startsWith('query DSSReadPlan') && row.body.variables.ref === 'refs/heads/main').length, 1)
})

test('Git send: late old read and old send ACK cannot replace newer same-scope authoritative history', async t => {
  const f = await serviceFixture(t), oldReadEntered = deferred<void>(), oldReadRelease = deferred<void>(), ackEntered = deferred<void>(), ackRelease = deferred<void>()
  let holdRead = false
  const api = {
    view: async () => { const result = await f.service.view({ mode: 'git' }); if (holdRead) { holdRead = false; oldReadEntered.resolve(); await oldReadRelease.promise } return result },
    send: async (input: FrameworkSendInput) => { const result = await f.service.send(input); ackEntered.resolve(); await ackRelease.promise; return result },
  } as FrameworkClientApi
  const controller = new FrameworkClientController(api)
  await controller.refresh()
  holdRead = true
  const staleRead = controller.refresh(); await oldReadEntered.promise
  const original = f.input('old-ack'), sending = controller.send(original); await ackEntered.promise
  await f.service.send(f.input('new-head'))
  // A changed read joins the owned flight and requests one fresh follow-up.
  // Release that first read before awaiting the follow-up; the send ACK stays held.
  const freshRead = controller.refresh()
  oldReadRelease.resolve(); await Promise.all([staleRead, freshRead])
  assert.deepEqual(controller.snapshot().value?.messages.map(message => message.id), ['old-ack', 'new-head'])
  ackRelease.resolve(); await sending
  assert.deepEqual(controller.snapshot().value?.messages.map(message => message.id), ['old-ack', 'new-head'])
  assert.equal(controller.snapshot().drafts[0].state, 'confirmed')
})

test('Git send readback fetches only the saved message in one Commit query while optional panels remain held', async t => {
  const f = await serviceFixture(t), input = f.input('authoritative-readback')
  await f.service.send(input)
  const entered = deferred<void>(), release = deferred<void>()
  const observe = (f.service as any).observe.bind(f.service)
  ;(f.service as any).observe = async (...args: unknown[]) => { entered.resolve(); await release.promise; return observe(...args) }
  const reading = f.service.view({ mode: 'git' })
  await entered.promise
  f.remote.requests.length = 0
  try {
    const result = await f.service.sentMessage(input)
    assert.equal(result.message?.text, input.text); assert.equal(result.message?.participantId, '1')
    assert.deepEqual(result.order, [input.id]); assert.equal(result.revision, f.remote.head)
    assert.equal(f.remote.requests.length, 1)
    assert.match(f.remote.requests[0].body.query, /^query DSSReadPlan/)
    assert.ok(Object.values(f.remote.requests[0].body.variables).every(value => typeof value !== 'string' || !/\/(tasks|instances|archives)(\/|$)/.test(value)))
  } finally { release.resolve(); await reading }
})

test('Git send plans known predicates together and skips Local-only business receipts while preserving write authority', async t => {
  const f = await serviceFixture(t), input = { ...f.input('planned-send'), storageScope: undefined }
  await f.connection.prepareWrite(); f.remote.requests.length = 0; f.remote.credentialResolutions = 0
  const read = f.connection.files.read.bind(f.connection.files)
  f.connection.files.read = async (snapshot, path) => { assert.ok(!path.startsWith('technical/transaction-receipts/')); return read(snapshot, path) }
  const receipt = await f.service.send(input)
  assert.equal(receipt.storageScope, f.connection.scope)
  assert.equal(f.remote.credentialResolutions, 2, 'one predicate read session and one fresh write session')
  const queries = f.remote.requests.filter(row => row.body?.query?.startsWith('query DSSReadPlan'))
  assert.equal(queries.length, 1); assert.equal(queries[0].body.variables.ref, 'refs/heads/main')
  assert.equal(Object.keys(queries[0].body.variables).filter(key => /^p\d+$/.test(key)).length, 3)
  assert.equal(f.remote.count('/git/trees/'), 0); assert.equal(f.remote.count('/git/blobs/'), 0)
  assert.equal(f.remote.count('/user'), 1); assert.equal(f.remote.count('/commits/heads/'), 1)
  const mutations = f.remote.requests.filter(row => row.body?.query?.startsWith('mutation DSSCommit'))
  assert.equal(mutations.length, 1); assert.equal(mutations[0].body.variables.input.expectedHeadOid.length, 40)
  const count = f.remote.credentialResolutions, requests = f.remote.requests.length
  assert.equal((await f.service.send(input)).replay, true)
  assert.equal(f.remote.credentialResolutions, count); assert.equal(f.remote.requests.length, requests)
  assert.equal((await f.conversation.read(input.id))?.text, input.text)
})

test('Git readback never substitutes submitted text for corrupted remote bytes and does not retry denied fields', async t => {
  const f = await serviceFixture(t), input = f.input('corrupt-readback')
  await f.service.send(input)
  const path = [...f.remote.commits.get(f.remote.head)!.files.keys()].find(path => path.endsWith('/parts/000000.txt'))!
  f.remote.change({ [path]: 'Different remote body' })
  await assert.rejects(f.service.sentMessage(input), /integrity|hash/)
  f.remote.forbidden = true; f.remote.requests.length = 0
  await assert.rejects(f.service.sentMessage(input), /Access revoked/)
  assert.equal(f.remote.requests.length, 1)
})

test('Git readback respects a newer cleared index and original storage scope', async t => {
  const f = await serviceFixture(t), input = f.input('cleared-readback')
  await f.service.send(input)
  f.remote.change({ ['Workspace/' + f.conversation.indexPath]: JSON.stringify({ version: 1, messages: [] }) })
  const result = await f.service.sentMessage(input)
  assert.equal(result.message, undefined); assert.deepEqual(result.order, [])
  await assert.rejects(f.service.sentMessage({ ...input, storageScope: 'another-scope' }), /scope|storage|destination/i)
})

test('real GitFiles commit-index removal and later service readback cannot be undone by an old client readback', async t => {
  const f = await serviceFixture(t), entered = deferred<void>(), release = deferred<void>(), first = f.input('before-index-cleanup'), second = f.input('after-index-cleanup')
  const controller = new FrameworkClientController({
    view: input => f.service.view({ ...input, mode: 'git' }), send: input => f.service.send(input),
    sentMessage: async input => { const result = await f.service.sentMessage(input); if (input.id === first.id) { entered.resolve(); await release.promise } return result },
  } as FrameworkClientApi)
  await controller.refresh()
  const sending = controller.send(first);await entered.promise
  try {
    await f.connection.transactions.run('shared-index-cleanup', {}, {}, async () => [{ path: f.conversation.indexPath, content: JSON.stringify({ version: 1, messages: [] }) }])
    assert.equal((await f.service.sentMessage(first)).message, undefined)
    await controller.send(second)
    release.resolve();await sending
    assert.deepEqual(controller.snapshot().value?.messages.map(message => message.id), [second.id])
    assert.equal(controller.pendingDrafts().length, 0)
    assert.deepEqual((await f.service.history({ mode: 'git', collaborationId: second.collaborationId, storageScope: second.storageScope, limit: 20 })).messages.map(message => message.id), [second.id])
  } finally { release.resolve();await sending }
})

for (const failure of ['member-status', 'task-metadata', 'tasks-directory', 'instances-directory'] as const) test('Git view: a failed batch '+failure+' retains its original consumer error boundary', async t => {
  const f = await serviceFixture(t)
  await f.service.send(f.input('retained-conversation'))
  const task = (id:string) => JSON.stringify({version:1,taskId:id,route:'P',owner:'alice',status:'running',sourcePath:'tasks/'+id+'_P.md',members:['alice','bob']})
  f.remote.change({
    'Workspace/tasks/healthy.json':task('healthy'),'Workspace/tasks/failing.json':task('failing'),
    'Workspace/task-runs/healthy/alice/alice_Inbox/status.json':JSON.stringify({state:'running',deliveryId:'healthy-alice'}),
    'Workspace/task-runs/healthy/bob/bob_Inbox/status.json':JSON.stringify({state:'complete',deliveryId:'healthy-bob'}),
    'Workspace/task-runs/failing/alice/alice_Inbox/status.json':JSON.stringify({state:'running',deliveryId:'failing-alice'}),
    'Workspace/task-runs/failing/bob/bob_Inbox/status.json':JSON.stringify({state:'complete',deliveryId:'failing-bob'}),
    'Workspace/archives/retained/records.md':'Complete retained archive',
  })
  const path = failure==='member-status' ? 'Workspace/task-runs/failing/alice/alice_Inbox/status.json' : failure==='task-metadata' ? 'Workspace/tasks/failing.json' : failure==='tasks-directory' ? 'Workspace/tasks' : 'Workspace/instances'
  const original=f.remote.fetch.bind(f.remote);let fails=true
  f.remote.fetch=async(url,init)=>{
    const response=await original(url,init),request=init?.body?JSON.parse(String(init.body)):undefined
    if(!fails||!request?.query?.startsWith('query DSSReadPlan'))return response
    const alias=Object.keys(request.variables).find(key=>key.startsWith('p')&&request.variables[key]===path)
    if(!alias)return response
    const body=await response.json(),node=body.data.repository.ref?.target??body.data.repository.object
    node[alias]=null
    body.errors=[...(body.errors??[]),{type:'INTERNAL',message:'Synthetic isolated '+failure,path:['repository',...(body.data.repository.ref?['ref','target']:['object']),alias]}]
    return Response.json(body)
  }
  const files=f.connection.files,snapshot=files.snapshot.bind(files);let releases=0
  files.snapshot=async(...args)=>{const s=await snapshot(...args),close=s.release.bind(s);s.release=async()=>{releases++;await close()};return s}
  const v=await f.service.view({mode:'git',includeArchives:true})
  assert.equal(v.messages[0].text,f.input('retained-conversation').text)
  assert.equal(v.archives[0].taskId,'retained');assert.equal(releases,1)
  assert.ok(v.connection.detail, 'the original read failure stays visible')
  if(failure==='tasks-directory')assert.deepEqual(v.tasks,[])
  else {
    assert.ok(v.tasks.some(task=>task.taskId==='healthy'))
    if(failure==='task-metadata')assert.ok(!v.tasks.some(task=>task.taskId==='failing'))
    else {assert.equal(v.tasks.length,2);if(failure==='member-status')assert.deepEqual(v.tasks.find(task=>task.taskId==='failing')!.members.map(m=>[m.name,m.status]),[['alice','unknown'],['bob','complete']])}
  }
  assert.equal(f.remote.requests.filter(r=>r.path.includes('/git/blobs/')&&r.path.endsWith(blobHash(f.remote.commits.get(f.remote.head)!.files.get(path)??''))).length,0,'failed planned fields never retry through REST')
  fails=false
  const next=await f.service.view({mode:'git'});assert.equal(next.tasks.length,2);assert.equal(releases,2)
  assert.equal(next.tasks.find(task=>task.taskId==='failing')!.members[0].status,'running','next owned view can read recovered data')
})

test('Git send joins read-only preparation started by opening Git and keeps one preparation request', async t => {
  const f = await serviceFixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), fetch = f.remote.fetch.bind(f.remote)
  let held = false
  f.remote.fetch = async (url, init) => { if (!held && new URL(url).pathname.includes('/commits/heads/')) { held = true; entered.resolve(); await release.promise } return fetch(url, init) }
  const header = await f.service.selectMode({ mode: 'git', headerOnly: true }); await entered.promise
  assert.equal(header.connection.participating, false)
  let sent = false
  const sending = f.service.send(f.input('early-prewarm')).then(() => { sent = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, false)
  release.resolve(); await sending
  assert.equal(f.remote.count('/commits/heads/'), 2, 'one preparation plus unchanged commit preflight; no duplicate send preparation')
  assert.equal((await f.service.sentMessage(f.input('early-prewarm'))).message?.text, f.input('early-prewarm').text)
  assert.equal((await f.storage.list('framework-instance/')).length, 0)
})
