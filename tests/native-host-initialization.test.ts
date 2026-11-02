import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as DSS from '../src/host.js'
import { DshStorageAdapter } from '../src/adapters/dsh/storage.js'
import { CoopCredentials } from '../src/experimental/private-git/credentials.js'

// Actual official services and DSS apply. The three-route HTTP seam only holds
// initial remote authority; bulk 3953-write migration QA is a separate scenario.
// No Agent/Inbox substitute, network, CLI credentials or model request is used.
// The official abstract FS service supplies the injection contract only; this
// scenario performs no ctx.fs content/path operation (no concrete FS claim).
test('official Context publishes DSS while Git authority is held, keeps Local usable and cancels/drains on disposal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dss-native-initialize-')), ctx = new Context()
  const originalFetch = globalThis.fetch, originalCredentials = CoopCredentials.prototype.resolve
  const entered = Promise.withResolvers<void>()
  const requests: string[] = []
  let requestAborted = false, closed = false, storage: DshStorageAdapter | undefined
  let initialization: Promise<unknown> | undefined
  t.after(async () => {
    const errors: unknown[] = []
    try { await storage?.close() } catch (error) { errors.push(error) }
    try { if (!closed) await ctx.fiber.dispose() } catch (error) { errors.push(error) }
    try { await initialization } catch (error) { errors.push(error) }
    globalThis.fetch = originalFetch; CoopCredentials.prototype.resolve = originalCredentials
    if (errors.length) throw new AggregateError(errors, 'Official initialization teardown failed')
    await rm(directory, { recursive: true, force: true })
  })
  CoopCredentials.prototype.resolve = async signal => {
    signal?.throwIfAborted()
    return { value: 'synthetic-native-initialization-only', source: 'fixture' }
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init?.method, 'GET', 'this fixture permits no remote write')
    requests.push(url.pathname)
    if (url.pathname === '/user') return Response.json({ id: 1, login: 'example' })
    if (url.pathname === '/repos/example/private') return Response.json({ id: 77, full_name: 'example/private', private: true, default_branch: 'main', permissions: { pull: true, push: true } })
    assert.equal(url.pathname, '/repos/example/private/commits/heads/main', 'no unlisted route can reach a real network')
    assert.ok(init?.signal, 'held transport must have its actual owner cancellation signal')
    entered.resolve()
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => { requestAborted = true; reject(init.signal!.reason) }
      if (init.signal!.aborted) abort()
      else init.signal!.addEventListener('abort', abort, { once: true })
    })
  }
  const mount = async (name: string, config?: unknown) => {
    const plugin = await import(name)
    await ctx.plugin(plugin.default ?? plugin, config)
  }
  for (const name of ['@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-fs']) await mount(name)
  await mount('@deepseek-ai/dsh-working-directory', { defaultDirectory: directory })
  await mount('@deepseek-ai/dsh-storage')
  await mount('@deepseek-ai/dsh-storage-json', { root: join(directory, 'storage') })
  await mount('@deepseek-ai/dsh-storage-domain', { backend: 'json' })
  await mount('@deepseek-ai/dsh-session-persistence-jsonl', { root: join(directory, 'sessions'), compression: 'none' })
  await mount('@deepseek-ai/dsh-workspace'); await mount('@deepseek-ai/dsh-jobs-local')
  await mount('@deepseek-ai/dsh-agent-default-model', { provider: 'synthetic-not-registered', model: 'not-called' })
  await mount('@deepseek-ai/dsh-agent-preset-registry', { default: 'qa-dss' })
  await ctx.agentPresets.register({ id: 'qa-dss', plugins: [] })
  await mount('@deepseek-ai/dsh-skill'); await mount('@deepseek-ai/dsh-agent-loop', { agents: [] })
  storage = await DshStorageAdapter.open(ctx)
  const settings = { name: 'Synthetic initialization', userName: '', localDirectory: join(storage.storageView().directory, 'deepseek_servant', 'framework'),
    ownerRepo: 'example/private', repositoryDirectory: 'Workspace', collaborationId: 'default', workerSeats: 2, workspace: directory, presetId: 'qa-dss' }
  for (const mode of ['local', 'git']) {
    await storage.set('framework-settings/' + mode, { revision: 'synthetic-' + mode, settings })
    await storage.set('framework-participation/' + mode, true)
  }
  await storage.close(); storage = undefined
  let pluginReady = false, failure: unknown
  initialization = ctx.plugin(DSS, DSS.Config.parse({ presetId: 'qa-dss' })).then(() => { pluginReady = true }, error => { failure = error })
  await entered.promise
  // One event-loop checkpoint flushes the actual ready notification. There is no
  // timeout or fabricated release of the still-pending network request.
  await new Promise<void>(resolve => setImmediate(resolve))
  if (failure) throw failure
  assert.equal(pluginReady, true, 'DSS plugin readiness cannot await a remote authority response')
  assert.ok(ctx.get('deepseekServant'))
  const service = ctx.deepseekServant.service
  const requestsAtBarrier = requests.length
  assert.equal(new Set(requests).size, 3, 'only the three explicit metadata/HEAD routes are used')
  assert.equal((await service.view({ mode: 'git' })).connection.status, 'starting')
  const localReady = Promise.withResolvers<Awaited<ReturnType<typeof service.view>>>()
  const inspectLocal = async () => {
    try {
      const view = await service.view({ mode: 'local' })
      if (view.connection.status === 'connected') localReady.resolve(view)
      else if (view.connection.status === 'failed') localReady.reject(new Error('Actual Local initialization failed'))
    } catch (error) { localReady.reject(error) }
  }
  const unsubscribe = service.subscribeChanged(() => { void inspectLocal() })
  let local: Awaited<ReturnType<typeof service.view>>
  try { await inspectLocal(); local = await localReady.promise } finally { unsubscribe() }
  await service.send({ mode: 'local', collaborationId: local.collaborationId, storageScope: local.storageScope,
    id: 'local-during-git-init', createdAt: new Date().toISOString(), text: 'Actual Local write while Git authority is held', recipient: 'human', device: 'native-test', timezoneOffsetMinutes: 0 })
  const history = await service.history({ mode: 'local', collaborationId: local.collaborationId, storageScope: local.storageScope, limit: 20 })
  assert.ok(history.messages.some(message => message.id === 'local-during-git-init'))
  assert.equal(requests.length, requestsAtBarrier, 'Local actions and pure Git status do not introduce extra remote requests')
  await ctx.fiber.dispose(); closed = true
  assert.equal(requestAborted, true, 'real owner disposal must abort and drain the held request')
})
