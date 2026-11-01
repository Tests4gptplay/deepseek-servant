import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { createRecorderCapacity } from '../src/framework/capacity.js'
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dss-capacity-')), files = await LocalFiles.open(root)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }) })
  await withSnapshot(files, s => files.commit(s, [{ path: 'text.md', content: '中文 real progress' }, { path: 'image.bin', bytes: new Uint8Array([0, 255, 254]) }], 'fixture'))
  return files
}
function agent(meter?: unknown, projections?: unknown, window?: number): Agent {
  return { ctx: { get: (name: string) => name === 'tokenMeter' ? meter : name === 'sessionProjections' ? projections : undefined },
    session: { requestContext: () => window === undefined ? undefined : { contextWindow: window } } } as unknown as Agent
}
test('capacity delegates estimates to native service and separates current pressure from cumulative usage', async t => {
  const files = await fixture(t), seen: Message[] = []
  const usage = { uncachedInputTokens: 5000, outputTokens: 4000, cacheReadTokens: 3000, cacheWriteTokens: 2000 }
  const meter = { measure: () => ({ totalTokens: 90, baseline: { kind: 'usage' } }), estimateMessage: (message: Message) => { seen.push(message); return 17 } }
  const projections = { snapshot: (_session: unknown, keys: string[]) => {
    assert.deepEqual(keys, ['contextPressure', 'tokenUsage'])
    return { values: { contextPressure: { pressureTokens: 75, projectedTokens: 85 }, tokenUsage: usage } }
  } }
  const before = await withSnapshot(files, async s => s.revision)
  const result = await createRecorderCapacity(files)(agent(meter, projections, 1000), { taskId: 'T', paths: ['text.md', 'text.md', 'image.bin', 'missing'] })
  assert.equal(result.materials.length, 3); assert.equal(seen.length, 1)
  assert.equal(seen[0]!.content[0]!.type, 'text')
  assert.equal(result.textEstimateTotal, 17); assert.equal(result.containsUnestimatedMaterials, true)
  assert.equal(result.materials[1]!.estimatedTokens, null); assert.equal(result.materials[2]!.status, 'missing')
  assert.deepEqual(result.session, { measuredTokens: 90, measurementBasis: 'usage', pressureTokens: 75, projectedTokens: 85, contextWindow: 1000, cumulativeUsage: usage })
  assert.equal(await withSnapshot(files, async s => s.revision), before)
})
test('unknown estimator and context window remain unknown without blocking reads or inventing limits', async t => {
  const files = await fixture(t)
  const result = await createRecorderCapacity(files)(agent(), { taskId: 'T', paths: ['text.md'] })
  assert.equal(result.materials[0]!.status, 'text')
  assert.equal(result.materials[0]!.estimatedTokens, null)
  assert.equal(result.session.contextWindow, null)
  assert.equal(result.textEstimateTotal, null)
  assert.equal(result.estimateBasis, 'unavailable')
})
test('native measurement failure stays a real error and never becomes a made-up estimate', async t => {
  const files = await fixture(t)
  await assert.rejects(createRecorderCapacity(files)(agent({ measure: () => { throw Error('native measurement failed') } }), { taskId: 'T', paths: [] }), /native measurement failed/)
})
test('a native meter without material estimator still reports available session facts', async t => {
  const files = await fixture(t)
  const result = await createRecorderCapacity(files)(agent({ measure: () => ({ totalTokens: 13, baseline: { kind: 'estimated' } }) }, undefined, 100), { taskId: 'T', paths: ['text.md'] })
  assert.equal(result.session.measuredTokens, 13)
  assert.equal(result.session.contextWindow, 100)
  assert.equal(result.textEstimateTotal, null)
  assert.equal(result.materials[0]!.estimatedTokens, null)
})
