import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFrameworkTransport } from '../src/framework/transport.js'
import { FrameworkService } from '../src/framework/service.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
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
