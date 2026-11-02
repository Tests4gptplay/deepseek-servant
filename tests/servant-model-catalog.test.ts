import test from 'node:test'
import assert from 'node:assert/strict'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { createServantModels, subscribeServantModelUpdates } from '../src/client/models.js'

const catalog = (model: string) => ({ default: { provider: 'fixture', model }, groups: [], failures: [] }) as unknown as ModelCatalog
test('DSS Auto reads the official deployment default and shares concurrent catalog requests', async () => {
  let calls = 0, resolve!: (value: ModelCatalog) => void
  const models = createServantModels(() => { calls++; return new Promise(done => { resolve = done }) })
  const off = models.source.subscribe(() => {})
  const one = models.refresh(), two = models.refresh()
  assert.equal(one, two); assert.equal(calls, 1)
  resolve(catalog('host-default')); await one
  assert.equal(models.source.getSnapshot().current?.model, 'host-default')
  off()
})
test('a late catalog from the old connection cannot replace the new Host default', async () => {
  const resolvers: Array<(value: ModelCatalog) => void> = []
  const models = createServantModels(() => new Promise(done => resolvers.push(done)))
  const off = models.source.subscribe(() => {})
  const old = models.refresh(); models.reset(); const fresh = models.refresh()
  assert.equal(resolvers.length, 2)
  resolvers[1]!(catalog('new-host')); await fresh
  resolvers[0]!(catalog('old-host')); await old
  assert.equal(models.source.getSnapshot().current?.model, 'new-host')
  off()
})
test('an actual catalog failure clears the claimed Auto default and remains an error until retry', async () => {
  let failed = false, calls = 0
  const models = createServantModels(async () => { calls++; if (failed) throw Error('catalog unavailable'); return catalog('default') })
  const off = models.source.subscribe(() => {}); await models.refresh()
  failed = true; await models.refresh()
  assert.equal(models.source.getSnapshot().current, null)
  assert.equal(models.source.getSnapshot().status, 'error')
  assert.equal(models.source.getSnapshot().error, 'catalog unavailable')
  assert.equal(calls, 2); off()
})

test('mounted Auto follows Host default changes and adapter events without opening a menu or reconnecting', async () => {
  let current = 'A', calls = 0
  const handlers = new Map<string, () => void>()
  const models = createServantModels(async () => { calls++; return catalog(current) })
  const off = models.source.subscribe(() => {})
  const release = subscribeServantModelUpdates((event, listener) => { handlers.set(event, listener); return () => { handlers.delete(event) } }, models.invalidate)
  await models.refresh(); assert.equal(models.source.getSnapshot().current?.model, 'A')
  current = 'B'; handlers.get('settings/document-updated')!(); await models.refresh()
  assert.equal(models.source.getSnapshot().current?.model, 'B'); assert.equal(calls, 2)
  current = 'C'; handlers.get('llm/adapters-updated')!(); await models.refresh()
  assert.equal(models.source.getSnapshot().current?.model, 'C'); assert.equal(calls, 3)
  release(); assert.equal(handlers.size, 0); off()
})

test('catalog invalidation during an old load coalesces and cannot republish the old default', async () => {
  const resolvers: Array<(value: ModelCatalog) => void> = [], seen: Array<string | undefined> = []
  const models = createServantModels(() => new Promise(resolve => resolvers.push(resolve)))
  const off = models.source.subscribe(() => seen.push(models.source.getSnapshot().current?.model))
  const old = models.refresh()
  for (let i = 0; i < 20; i++) models.invalidate()
  assert.equal(resolvers.length, 1)
  resolvers[0]!(catalog('old')); await old
  assert.equal(resolvers.length, 2)
  const fresh = models.refresh(); resolvers[1]!(catalog('new')); await fresh
  assert.equal(models.source.getSnapshot().current?.model, 'new'); assert.equal(seen.includes('old'), false)
  off()
})
