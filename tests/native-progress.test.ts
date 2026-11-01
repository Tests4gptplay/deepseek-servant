import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { JobEvent, JobView } from '@deepseek-ai/dsh-jobs'
import { observeDshProgress, streamProgress, JobProgressTracker, type DshProgress } from '../src/adapters/dsh/progress.js'

// Protocol classifier tests, not a substitute for native Host execution tests.
const frame = (chunk: unknown) => ({ type: 'chunk', chunk } as AssistantStreamFrame)
const job = (patch: Partial<JobView> = {}) => ({ id: 'job-1', owner: 'owner', status: 'running',
  output: { total: 0, earliest: 0 }, ...patch } as JobView)
const output = (total: number, owner: string | undefined = 'owner') => ({ type: 'output', id: 'job-1', owner, total } as JobEvent)

test('only nonempty model content fragments count, not stream lifecycle or usage', () => {
  for (const type of ['start', 'end']) assert.equal(streamProgress({ type } as AssistantStreamFrame), undefined)
  for (const chunk of [{ type: 'usage' }, { type: 'text-delta', text: '' },
    { type: 'reasoning-delta', text: '' }, { type: 'tool-call-delta', argumentsDelta: '' }]) {
    assert.equal(streamProgress(frame(chunk)), undefined)
  }
  assert.equal(streamProgress(frame({ type: 'text-delta', text: 'a' })), 'model-text')
  assert.equal(streamProgress(frame({ type: 'reasoning-delta', text: 'a' })), 'reasoning')
  assert.equal(streamProgress(frame({ type: 'tool-call-delta', name: 'read', argumentsDelta: '' })), 'tool-progress')
  assert.equal(streamProgress(frame({ type: 'tool-call-delta', argumentsDelta: '{' })), 'tool-progress')
})
test('job progress uses new output totals, excluding shared and foreign ownership', () => {
  const tracker = new JobProgressTracker('owner', [job({ output: { total: 10, earliest: 0 } })])
  assert.equal(tracker.accept(output(10)), undefined)
  assert.equal(tracker.accept(output(9)), undefined)
  assert.equal(tracker.accept({ ...output(100), owner: undefined }), undefined)
  assert.equal(tracker.accept(output(100, 'other')), undefined)
  assert.deepEqual(tracker.accept(output(11)), { source: 'jobs/output', jobId: 'job-1' })
  assert.equal(tracker.accept(output(11)), undefined)
})
test('job lifecycle and unchanged or cleared progress are not work progress', () => {
  const tracker = new JobProgressTracker('owner')
  const event = (type: 'registered' | 'progress' | 'stopping' | 'removed', progress?: string): JobEvent => ({ type, job: job({ progress }) })
  assert.equal(tracker.accept(event('registered', 'initial')), undefined)
  assert.equal(tracker.accept(event('progress', 'initial')), undefined)
  assert.deepEqual(tracker.accept(event('progress', 'next')), { source: 'jobs/progress', jobId: 'job-1' })
  assert.equal(tracker.accept(event('stopping', 'next')), undefined)
  assert.equal(tracker.accept(event('progress')), undefined)
  assert.equal(tracker.accept(event('removed')), undefined)
})

// This checks subscription wiring against event-shaped inputs, not a simulated native lifecycle.
test('observer routes exact agents/owners and unregisters every event source', () => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>()
  const jobHandlers = new Set<(event: JobEvent) => void>()
  const registry = { list: () => [job()], events: { subscribe: (filter: unknown, listener: (event: JobEvent) => void) => {
    assert.deepEqual(filter, { owner: 'owner' })
    jobHandlers.add(listener)
    return () => { jobHandlers.delete(listener) }
  } } }
  const context = {
    get: (key: string) => { assert.equal(key, 'jobs'); return registry },
    on: (name: string, listener: (...args: any[]) => void) => {
      const group = handlers.get(name) ?? new Set()
      group.add(listener); handlers.set(name, group)
      return () => { group.delete(listener) }
    },
  }
  const agent = { id: 'owner', ctx: context } as unknown as Agent
  const outsider = { id: 'other' } as Agent
  const events: DshProgress[] = []
  let time = 10
  const stop = observeDshProgress(agent, event => events.push(event), () => ++time)
  const emit = (name: string, ...args: unknown[]) => { for (const listener of handlers.get(name) ?? []) listener(...args) }
  const emitJob = (event: JobEvent) => { for (const listener of jobHandlers) listener(event) }
  const text = frame({ type: 'text-delta', text: 'new output' })
  emit('agent/assistant-stream', { agent: outsider, frame: text })
  emit('tools/result', { agent: outsider }, {})
  emitJob(output(1, 'other'))
  emitJob({ ...output(1), owner: undefined })
  emit('agent/status', { agent, status: 'running' })
  emit('session/event', {}, { type: 'projection/update' })
  assert.deepEqual(events, [])
  emit('agent/assistant-stream', { agent, frame: text })
  emit('tools/result', { agent }, {})
  emitJob(output(1))
  emitJob(output(1))
  assert.deepEqual(events, [
    { kind: 'model-text', source: 'assistant-stream', observedAt: 11 },
    { kind: 'tool-progress', source: 'tools/result', observedAt: 12 },
    { kind: 'tool-progress', source: 'jobs/output', jobId: 'job-1', observedAt: 13 },
  ])
  stop(); stop()
  assert.equal([...handlers.values()].reduce((total, group) => total + group.size, 0), 0)
  assert.equal(jobHandlers.size, 0)
  emit('agent/assistant-stream', { agent, frame: text })
  emit('tools/result', { agent }, {})
  emitJob(output(2))
  assert.equal(events.length, 3)
})
