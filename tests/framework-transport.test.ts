import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFrameworkTransport } from '../src/framework/transport.js'
import { FrameworkService } from '../src/framework/service.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { ExecutionControls } from '../src/framework/execution-control.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot, FilesOutcomeUnknownError } from '../src/framework/transactions.js'
import { clientRequestSchema, serverResponseSchema } from '@deepseek-ai/dsh-client-connection'
import type { StoragePort } from '../src/contracts/ports.js'

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-transport-')), files = await LocalFiles.open(directory)
  const data = new Map<string, unknown>(), storage: StoragePort = { async get<T>(key: string) { return data.get(key) as T | undefined }, async set(key, value) { data.set(key, value) }, async list<T>() { return [] as { key: string; value: T }[] } }
  const service = new FrameworkService({} as any, storage, {} as any), internal = service as any
  const settings = { name: 'Test', userName: 'Account', localDirectory: directory, ownerRepo: '', repositoryDirectory: '', collaborationId: 'shared', workerSeats: 0, workspace: directory }
  internal.saved.set('local', { revision: 'config1', settings })
  const transactions = new FrameworkTransactions(files, storage, 'transport-test')
  internal.running.set('local', { connection: { files, registration: { member: 'Account-1' }, close: async () => {} }, runtime: { invalidateSkills: () => {}, conversation: new FrameworkConversation(files, transactions, { mode: 'local', collaborationId: 'shared' }), executionViews: () => [], dispose: async () => {} }, resources: [] })
  internal.accesses.set('local', Promise.resolve({ connection: { files, transactions, scope: 'transport-test', identity: { login: 'Account', owner: 'Account', repositoryId: 'transport-test', instanceUUID: '00000000-0000-4000-8000-000000000005' }, prepareWrite: async () => {}, close: async () => {} }, conversation: internal.running.get('local').runtime.conversation }))
  const realAccess = internal.access.bind(internal)
  internal.access = (mode: string) => { assert.ok(internal.accesses.has(mode), 'test must not access native credentials'); return realAccess(mode) }
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
  // Actual Cordis dependency injection/effect disposal and native envelope schemas;
  // only the connection's fetch registration carrier is an isolated seam.
  const ctx = new Context()
  const unprovide = ctx.provide('connection', { fetch: { register: (route: any) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } } as any)
  const stop = installFrameworkTransport(ctx, service)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(routes.has('/api/deepseek-servant-framework/send'), 'real Cordis inject installed route effects')
  t.after(async () => { await stop(); unprovide(); assert.equal(routes.size, 0); await files.close(); await rm(directory, { recursive: true, force: true }) })
  const call = async (method: string, payload: unknown) => {
    const envelope = { type: 'client-request', rpcId: 'test-rpc', method: 'deepseek-servant-framework/' + method, payload }
    assert.equal(clientRequestSchema.safeParse(envelope).success, true)
    const response = await routes.get('/api/deepseek-servant-framework/' + method)!.fetch(new Request('http://host/api/deepseek-servant-framework/' + method, { method: 'POST', body: JSON.stringify(envelope) }))
    const body = await response.json(); assert.equal(serverResponseSchema.safeParse(body).success, true)
    assert.equal(body.rpcId, envelope.rpcId)
    return body.result
  }
  return { routes, files, service, call, internal, storage }
}
test('production native-envelope route sends through actual service and reads durable history', async t => {
  const { call, files } = await fixture(t)
  const sent = await call('send', { mode: 'local', collaborationId: 'shared', storageScope: 'transport-test', id: 'message', createdAt: '2026-10-31T00:00:00.000Z', text: 'Via native RPC envelope', recipient: 'ai', device: 'web', timezoneOffsetMinutes: 540 })
  assert.equal(sent.ok, true)
  const history = await call('history', { mode: 'local', collaborationId: 'shared', limit: 50 })
  assert.equal(history.value.messages[0].text, 'Via native RPC envelope')
  await withSnapshot(files, async snapshot => assert.equal((await files.listDirectory(snapshot, 'state/')).length, 1))
})
test('download handler returns actual binary bytes and no-store attachment metadata', async t => {
  const { files, call, routes } = await fixture(t), bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x01])
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'archives/task/result.bin', bytes }], 'binary artifact fixture'))
  const result = await call('readFile', { mode: 'local', path: 'archives/task/result.bin' })
  assert.equal(result.ok, true)
  const response = await routes.get('/api/deepseek-servant-framework/download')!.fetch(new Request('http://host' + result.value.binary.downloadUrl))
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-disposition')!, /attachment/)
})
test('transport rejects malformed envelopes and method mismatch without invoking writes', async t => {
  const { routes, files } = await fixture(t), route = routes.get('/api/deepseek-servant-framework/send')!
  const malformed = await route.fetch(new Request('http://host/api/deepseek-servant-framework/send', { method: 'POST', body: '{}' }))
  assert.equal(malformed.status, 400)
  const mismatch = await route.fetch(new Request('http://host/api/deepseek-servant-framework/send', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'mismatch', method: 'deepseek-servant-framework/configure', payload: {} }) }))
  assert.equal((await mismatch.json()).result.ok, false)
  await withSnapshot(files, async snapshot => assert.equal((await files.list(snapshot, '')).length, 0))
})
test('unknown commit error carries persisted operation identity through transport, not just a string', async t => {
  const { files, call } = await fixture(t)
  files.commit = async () => { throw new FilesOutcomeUnknownError('durable-operation-id') }
  const result = await call('send', { mode: 'local', collaborationId: 'shared', storageScope: 'transport-test', id: 'unknown', createdAt: '2026-10-31T00:00:00.000Z', text: 'preserved', recipient: 'ai', device: 'web', timezoneOffsetMinutes: 540 })
  assert.equal(result.ok, false)
  assert.equal(result.error.details.operationId, 'durable-operation-id')
})

test('native participation endpoint stops background, while ordinary chat does not start it again', async t => {
  const { call } = await fixture(t)
  const left = await call('participation', { mode: 'local', enabled: false })
  assert.equal(left.ok, true)
  assert.equal(left.value.connection.participating, false)
  assert.equal((await call('send', { mode: 'local', collaborationId: 'shared', storageScope: 'transport-test', id: 'after-exit', createdAt: '2026-10-31T00:00:00.000Z', timezoneOffsetMinutes: 330, text: 'independent chat', recipient: 'human', device: 'web' })).ok, true)
  assert.equal((await call('view', { mode: 'local' })).value.connection.participating, false)
})

test('an attachment URL and read reference cannot silently follow a mode to a different storage root', async t => {
  const { files, call, routes, internal, storage } = await fixture(t)
  const a = Uint8Array.from([255, 1]), b = Uint8Array.from([255, 2])
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'archives/T/same.bin', bytes: a }], 'root A attachment'))
  const original = await call('readFile', { mode: 'local', storageScope: 'transport-test', path: 'archives/T/same.bin' })
  assert.equal(original.ok, true)
  const root = await mkdtemp(join(tmpdir(), 'dss-transport-other-')), other = await LocalFiles.open(root)
  t.after(async () => { await other.close(); await rm(root, { recursive: true, force: true }) })
  await withSnapshot(other, snapshot => other.commit(snapshot, [{ path: 'archives/T/same.bin', bytes: b }], 'root B different bytes'))
  internal.accesses.set('local', Promise.resolve({ connection: { files: other, scope: 'other-root', identity: { login: 'Account', owner: 'Account', repositoryId: 'transport-test', instanceUUID: '00000000-0000-4000-8000-000000000005' }, prepareWrite: async () => {} }, conversation: new FrameworkConversation(other, new FrameworkTransactions(other, storage, 'other-root'), { mode: 'local', collaborationId: 'shared' }) }))
  const read = await call('readFile', { mode: 'local', storageScope: 'transport-test', path: 'archives/T/same.bin' })
  assert.equal(read.ok, false)
  const response = await routes.get('/api/deepseek-servant-framework/download')!.fetch(new Request('http://host' + original.value.binary.downloadUrl))
  assert.equal(response.status, 400)
  assert.notDeepEqual(new Uint8Array(await response.arrayBuffer()), b)
})

test('records export downloads original stored bytes including BOM and CRLF without generating content', async t => {
  const { files, call, routes } = await fixture(t)
  const bytes = new TextEncoder().encode('\uFEFF# Original Recorder output\r\n\r\nExact evidence 😀\r\n')
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'archives/task/records.md', bytes }], 'original records'))
  const result = await call('readFile', { mode: 'local', storageScope: 'transport-test', path: 'archives/task/records.md' })
  assert.equal(result.ok, true); assert.equal(typeof result.value.downloadUrl, 'string')
  const response = await routes.get('/api/deepseek-servant-framework/download')!.fetch(new Request('http://host' + result.value.downloadUrl))
  assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
})

test('four knowledge native RPC routes persist candidate/status and retain background-independent operation', async t => {
  const { files, call, routes } = await fixture(t)
  const path = 'skills/rpc/SKILL.md', text = '---\nname: rpc-method\ndescription: RPC method\n---\nOriginal body'
  const { prepareFrameworkSkillIndex } = await import('../src/framework/skills.js')
  await withSnapshot(files, async snapshot => {
    const changes = [{ path, content: text }]
    await files.commit(snapshot, [...changes, ...(await prepareFrameworkSkillIndex(files, snapshot, changes)).changes], 'knowledge fixture')
  })
  for (const method of ['knowledgeList', 'knowledgeRead', 'knowledgeEdit', 'knowledgeStatus']) assert.ok(routes.has('/api/deepseek-servant-framework/' + method))
  assert.equal((await call('participation', { mode: 'local', enabled: false })).ok, true)
  const scope = { mode: 'local', storageScope: 'transport-test' }
  const listed = await call('knowledgeList', scope)
  assert.equal(listed.ok, true); assert.equal(listed.value.items[0].status, 'active')
  assert.equal((await call('knowledgeRead', { ...scope, path })).value.text, text)
  const edit = { ...scope, commandId: 'rpc-edit', path, expectedRevision: listed.value.revision, body: 'candidate body', createdAt: '2026-10-31T18:00:00Z' }
  const changed = await call('knowledgeEdit', edit)
  assert.equal(changed.ok, true); assert.deepEqual(await call('knowledgeEdit', edit), { ...changed, value: { ...changed.value, replay: true } })
  const after = await call('knowledgeList', scope)
  assert.equal(after.value.items[0].candidates.length, 1)
  assert.equal((await call('knowledgeRead', { ...scope, path })).value.text, text)
  const status = { ...scope, commandId: 'rpc-status', path, expectedRevision: after.value.revision, status: 'retired' }
  const retired = await call('knowledgeStatus', status)
  assert.equal(retired.ok, true); assert.deepEqual(await call('knowledgeStatus', status), { ...retired, value: { ...retired.value, replay: true } })
  assert.equal((await call('knowledgeList', scope)).value.items[0].status, 'retired')
  assert.equal((await call('knowledgeRead', { ...scope, storageScope: 'stale-root', path })).ok, false)
  assert.equal((await call('view', { mode: 'local' })).value.connection.participating, false)
  await withSnapshot(files, async snapshot => assert.deepEqual(await files.list(snapshot, 'instances/'), []))
})

test('cancelled view withdraws only its read after shared access; another reader and commands remain owned', async t => {
  const { routes, internal, call } = await fixture(t)
  const access = await internal.accesses.get('local'), gate = Promise.withResolvers<void>()
  internal.accesses.set('local', gate.promise.then(() => access))
  let pages = 0
  const originalPage = access.conversation.page.bind(access.conversation)
  access.conversation.page = (...args: any[]) => { pages++; return originalPage(...args) }
  const abort = new AbortController(), reason = new Error('obsolete client view')
  const body = JSON.stringify({ type: 'client-request', rpcId: 'old-view', method: 'deepseek-servant-framework/view', payload: { mode: 'local' } })
  const old = routes.get('/api/deepseek-servant-framework/view')!.fetch(new Request('http://host/api/deepseek-servant-framework/view', { method: 'POST', body, signal: abort.signal }))
  await new Promise(resolve => setImmediate(resolve))
  abort.abort(reason)
  const current = call('view', { mode: 'local' })
  gate.resolve()
  const [oldResponse, next] = await Promise.all([old, current])
  assert.equal((await oldResponse.json()).result.ok, false)
  assert.equal(next.ok, true)
  assert.equal(pages, 1, 'withdrawn request must not start a page after shared access opens')
  assert.equal(internal.accesses.has('local'), true, 'shared storage owner remains available')
})

test('view cancellation after page read prevents observation and preserves original error ownership', async t => {
  const { service, internal } = await fixture(t), access = await internal.accesses.get('local')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const page = access.conversation.page.bind(access.conversation)
  access.conversation.page = async (...args: any[]) => { const result = await page(...args); entered.resolve(); await release.promise; return result }
  internal.running.delete('local')
  let observed = 0
  internal.observe = async () => { observed++; return [] }
  const abort = new AbortController(), reason = new Error('page consumer left')
  const pending = service.view({ mode: 'local' }, abort.signal)
  await entered.promise; abort.abort(reason); release.resolve()
  await assert.rejects(pending, error => error === reason)
  assert.equal(observed, 0)
  assert.equal(internal.errors.size, 0)
  assert.equal((await service.view({ mode: 'local' })).connection.status, 'connected')
  assert.equal(observed, 1)
})

test('disconnecting the selectMode response does not cancel its admitted settings write', async t => {
  const { routes, storage } = await fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const set = storage.set.bind(storage)
  storage.set = async (key, value) => { if (key === 'framework-active-mode') { entered.resolve(); await release.promise }; return set(key, value) }
  const abort = new AbortController()
  const body = JSON.stringify({ type: 'client-request', rpcId: 'mode-write', method: 'deepseek-servant-framework/selectMode', payload: { mode: 'local', headerOnly: true } })
  const pending = routes.get('/api/deepseek-servant-framework/selectMode')!.fetch(new Request('http://host/api/deepseek-servant-framework/selectMode', { method: 'POST', body, signal: abort.signal }))
  await entered.promise; abort.abort(); release.resolve()
  assert.equal((await (await pending).json()).result.ok, true)
  assert.equal(await storage.get('framework-active-mode'), 'local')
})

test('cancelled view drains an acquired snapshot exactly once without starting task inspection', async t => {
  const { service, internal, files } = await fixture(t), access = await internal.accesses.get('local')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const page = access.conversation.page.bind(access.conversation), snapshot = files.snapshot.bind(files)
  let pages = 0, releases = 0, inspected = 0
  access.conversation.page = (...args: any[]) => { pages++; return page(...args) }
  access.taskIndex = { list: async () => { inspected++; return [] } }
  files.snapshot = async () => {
    const owned = await snapshot()
    // The view now owns one snapshot for page/instances/tasks. Hold that actual
    // acquisition rather than waiting for the removed second task snapshot.
    const finish = owned.release.bind(owned)
    owned.release = async () => { releases++; await finish() }
    entered.resolve(); await release.promise
    return owned
  }
  const abort = new AbortController(), reason = new Error('snapshot consumer left')
  const pending = service.view({ mode: 'local' }, abort.signal)
  await entered.promise; abort.abort(reason); release.resolve()
  await assert.rejects(pending, error => error === reason)
  assert.equal(releases, 1); assert.equal(pages, 0); assert.equal(inspected, 0); assert.equal(internal.errors.size, 0)
})


test('cancellation during last Task control read does not admit legacy index IO', async t => {
  const { service, internal, files, storage } = await fixture(t)
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'tasks/cancel-boundary.json', content: JSON.stringify({ version: 1, taskId: 'cancel-boundary', route: 'P', status: 'running', owner: 'Account-1', members: [], sourcePath: 'task.md' }) }], 'actual Task metadata fixture'))
  internal.running.get('local').runtime.controls = new ExecutionControls(storage, 'transport-test')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), get = storage.get.bind(storage), read = files.read.bind(files)
  let legacyReads = 0
  storage.get = async key => { if (key.startsWith('framework-user-controls/')) { entered.resolve(); await release.promise }; return get(key) }
  files.read = async (snapshot, path) => { if (path === 'technical/legacy-migrations/index.json') legacyReads++; return read(snapshot, path) }
  const abort = new AbortController(), reason = new Error('left during final Task control')
  const pending = service.view({ mode: 'local' }, abort.signal)
  await entered.promise; abort.abort(reason); release.resolve()
  await assert.rejects(pending, error => error === reason)
  assert.equal(legacyReads, 0)
  assert.equal(internal.errors.size, 0)
})

test('cancelled history page does not start after a shared access wait', async t => {
  const { routes, internal } = await fixture(t), access = await internal.accesses.get('local')
  const release = Promise.withResolvers<void>(); internal.accesses.set('local', release.promise.then(() => access))
  let pages = 0; const page = access.conversation.page.bind(access.conversation)
  access.conversation.page = (...args: any[]) => { pages++; return page(...args) }
  const abort = new AbortController()
  const body = JSON.stringify({ type: 'client-request', rpcId: 'history-read', method: 'deepseek-servant-framework/history', payload: { mode: 'local', collaborationId: 'shared', limit: 20 } })
  const pending = routes.get('/api/deepseek-servant-framework/history')!.fetch(new Request('http://host/api/deepseek-servant-framework/history', { method: 'POST', body, signal: abort.signal }))
  await new Promise(resolve => setImmediate(resolve)); abort.abort(); release.resolve()
  assert.equal((await (await pending).json()).result.ok, false)
  assert.equal(pages, 0); assert.equal(internal.accesses.has('local'), true)
})
