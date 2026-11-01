import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { DshStorageAdapter } from '../src/adapters/dsh/storage.js'

test('real native domain storage omits optional object fields but rejects non-JSON values without persisting them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-native-storage-json-'))
  const ctx = new Context()
  let storage: DshStorageAdapter | undefined
  t.after(async () => {
    const failures: unknown[] = []
    try { await storage?.close() } catch (error) { failures.push(error) }
    try { await ctx.fiber.dispose() } catch (error) { failures.push(error) }
    // Preserve the synthetic evidence if native close failed, and report every failure.
    if (failures.length) throw new AggregateError(failures, 'Native storage teardown failed')
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  storage = await DshStorageAdapter.open(ctx)
  await storage.set('native-json/valid', {
    omitted: undefined,
    nested: { omitted: undefined, null: null, false: false, zero: 0 },
    array: [null, false, 0, { omitted: undefined }],
  })
  assert.deepEqual(await storage.get('native-json/valid'), {
    nested: { null: null, false: false, zero: 0 }, array: [null, false, 0, {}],
  })
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  const invalid: Array<[string, unknown]> = [
    ['root-undefined', undefined], ['array-undefined', [undefined]], ['NaN', NaN], ['Infinity', Infinity],
    ['Date', new Date(0)], ['Map', new Map()], ['function', () => undefined], ['cycle', cycle],
  ]
  for (const [name, value] of invalid) {
    await assert.rejects(async () => storage!.set('native-json/' + name, value), undefined, name)
    assert.equal(await storage.get('native-json/' + name), undefined, 'Rejected value must not be persisted: ' + name)
  }
  // Read the same native persisted domain after a real adapter close/reopen.
  await storage.close()
  storage = await DshStorageAdapter.open(ctx)
  assert.deepEqual(await storage.get('native-json/valid'), {
    nested: { null: null, false: false, zero: 0 }, array: [null, false, 0, {}],
  })
})
