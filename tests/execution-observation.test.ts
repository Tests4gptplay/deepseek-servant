import assert from 'node:assert/strict'
import test from 'node:test'
import type { OwnedDshAgent } from '../src/adapters/dsh/host-types.js'
import { observeDshProgress } from '../src/adapters/dsh/progress.js'
import {
  ExecutionObservations,
  type ExecutionObservationStore,
  type StoredExecutionObservation,
} from '../src/framework/execution-observation.js'
import type { WorkIdentity } from '../src/framework/recovery.js'

test('compatibility acknowledgement tool results are not counted as progress', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const agent = {
    id: 'agent-1',
    ctx: {
      get: () => undefined,
      on: (name: string, handler: (...args: any[]) => unknown) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    },
  } as any
  const events: unknown[] = []
  const stop = observeDshProgress(agent, event => events.push(event), () => 123)
  const tool = handlers.get('tools/result')!

  tool({ agent, name: 'dss_reset_observation' }, { isError: false })
  tool({ agent, name: 'dss_record' }, { isError: true })
  tool({ agent: {}, name: 'dss_record' }, { isError: false })
  assert.deepEqual(events, [])

  tool({ agent, name: 'dss_record' }, { isError: false })
  assert.deepEqual(events, [{ kind: 'tool-progress', source: 'tools/result', observedAt: 123 }])
  stop()
  assert.equal(handlers.size, 0)
})

test('legacy observation reset only acknowledges without changing inactivity state', async () => {
  const identity: WorkIdentity = {
    workId: 'worker-observation', executionId: 'execution-1', role: 'Worker',
    taskId: 'task-1', lifecycleId: 'lifecycle-1', member: 'member-1', workerId: 'worker-1',
  }
  const pending = {
    id: 'pending-probe',
    action: { kind: 'probe-role' as const, identity: { ...identity }, stage: 1 as const, elapsedMs: 300_000, silentMs: 300_000 },
    cycleStartedAt: 1_000,
    checkedAt: 301_000,
    progressAt: 11_000,
  }
  let stored: StoredExecutionObservation | undefined = {
    observation: {
      identity: { ...identity }, cycleStartedAt: 1_000, stageStartedAt: 301_000,
      lastProgressAt: 11_000, stage: 1,
    },
    executing: true,
    pending,
  }
  const store: ExecutionObservationStore = {
    async get(workId) { return workId === identity.workId ? stored : undefined },
    async set(workId, value, expected) {
      assert.equal(workId, identity.workId)
      assert.equal(stored, expected)
      stored = structuredClone(value)
    },
    async list() { return stored ? [stored] : [] },
  }
  const agent = {
    sessionId: 'session-1', actualAgent: {},
    observe: () => ({ state: 'running' as const, jobs: [] }),
    subscribe: () => () => {},
    subscribeProgress: () => () => {},
    getMessages: () => [], hasMessage: () => false,
    send: async () => {}, cancel: async () => {}, whenIdle: async () => {}, dispose: async () => {},
  } as unknown as OwnedDshAgent
  const observations = new ExecutionObservations(store, { arrange: async () => {} }, error => { throw error }, () => 999_000)

  await observations.bind(identity, agent)
  const before = structuredClone(stored!)
  const acknowledged = await observations.reset(identity, 'probe-input-1', before.observation.cycleStartedAt)
  assert.deepEqual(acknowledged, { reset: false, status: 'acknowledged' })
  assert.deepEqual(stored?.observation, before.observation)
  assert.deepEqual(stored?.pending, before.pending)
  assert.equal(stored?.executing, before.executing)
  assert.deepEqual(stored?.resetInputs, ['probe-input-1'])
  assert.deepEqual(stored?.resetCycles, [before.observation.cycleStartedAt])

  const duplicate = await observations.reset(identity, 'probe-input-1', before.observation.cycleStartedAt)
  assert.deepEqual(duplicate, { reset: false, status: 'already-handled' })
  assert.deepEqual(stored?.observation, before.observation)
  assert.deepEqual(stored?.pending, before.pending)

  const sibling = await observations.reset(identity, 'probe-input-2', before.observation.cycleStartedAt)
  assert.deepEqual(sibling, { reset: false, status: 'superseded' })
  assert.deepEqual(stored?.observation, before.observation)
  assert.deepEqual(stored?.pending, before.pending)
  assert.deepEqual(stored?.resetInputs, ['probe-input-1', 'probe-input-2'])
  assert.deepEqual(stored?.resetCycles, [before.observation.cycleStartedAt])
  await observations.dispose()
})
