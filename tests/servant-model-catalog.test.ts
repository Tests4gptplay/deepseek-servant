import test from 'node:test'
import assert from 'node:assert/strict'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { createServantModels } from '../src/client/models.js'

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
