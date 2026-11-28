import assert from 'node:assert/strict'
import { evidence, hooks } from './test-support/dsh-sdk-runtime.mjs'
const { ExecutionObservations } = await import('../src/framework/execution-observation.ts')
const checks = [], errors = [], rows = new Map(), arranged = []
let now = 0
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const store = { get: async key => rows.get(key), set: async (key, value) => { rows.set(key, value) }, list: async () => [...rows.values()] }
const obs = new ExecutionObservations(store, { arrange: async pending => { arranged.push(pending) } }, error => errors.push(error), () => now)
function owned(id) {
  let waiting = false, running = true
  const statuses = new Set(), progress = new Set()
  return { sessionId: id, observe: () => ({ state: running ? 'running' : 'idle', jobs: [], waitingForUser: waiting }),
    subscribe: fn => { statuses.add(fn); return () => statuses.delete(fn) }, subscribeProgress: fn => { progress.add(fn); return () => progress.delete(fn) },
    waiting(value) { waiting = value; for (const fn of statuses) fn() },
    running(value) { running = value; for (const fn of statuses) fn() },
    progress() { for (const fn of progress) fn({ kind: 'tool-progress', observedAt: now }) } }
}
const identity = (workId, role = 'Worker', executionId = workId) => ({ workId, executionId, role })
try {
  const a = owned('a'), b = owned('b')
  await obs.bind(identity('a'), a); await obs.bind(identity('b'), b)
  now = 299999; a.waiting(true); await obs.tick()
  now = 3600000; await obs.tick()
  check('exact A blocking wait does not arrange a probe', arranged.filter(row => row.action.identity.workId === 'a').length, 0)
  check('independent B still observes', arranged.filter(row => row.action.identity.workId === 'b').length, 1)
  a.waiting(false); await obs.tick()
  now += 299999; await obs.tick()
  check('A resumes original five-minute period, no immediate stale escalation', arranged.filter(row => row.action.identity.workId === 'a').length, 0)
  now++; await obs.tick()
  const first = arranged.find(row => row.action.identity.workId === 'a')
  check('A original stage one after resumed interval', first.action.stage, 1)
  check('original stage one applicable before wait', await obs.mayApply(first), true)
  a.waiting(true); await obs.tick()
  check('already-arranged action fenced during exact wait', await obs.mayApply(first), false)
  await obs.deferUnperformed(first)
  check('proved unperformed stage is not skipped', rows.get('a').observation.stage, 0)
  now += 3600000; a.waiting(false); await obs.tick()
  check('old action remains inapplicable after reply', await obs.mayApply(first), false)
  const count = arranged.filter(row => row.action.identity.workId === 'a').length
  now += 299999; await obs.tick()
  check('deferred stage retains original five-minute cadence', arranged.filter(row => row.action.identity.workId === 'a').length, count)
  now++; await obs.tick()
  check('same stage retried rather than stage two', arranged.filter(row => row.action.identity.workId === 'a').at(-1).action.stage, 1)
  const queued = arranged.filter(row => row.action.identity.workId === 'a').at(-1)
  a.waiting(true); await obs.tick(); now += 1000000; a.waiting(false); await obs.tick()
  check('old action checked only after wait still invalid', await obs.mayApply(queued), false)
  await obs.deferUnperformed(queued)
  check('post-wait deferral also preserves stage', rows.get('a').observation.stage, 0)
  const c = owned('c'); await obs.bind(identity('a', 'Worker', 'replacement'), c)
  await obs.deferUnperformed(queued)
  check('old action cannot touch replacement execution', rows.get('a').observation.identity.executionId, 'replacement')
  check('replacement starts original stage zero', rows.get('a').observation.stage, 0)
  now += 300000; await obs.tick()
  check('continued work without actual blocking remains observable', arranged.some(row => row.action.identity.executionId === 'replacement'), true)
  const fg = owned('foreground'); fg.waiting(true); await obs.bind(identity('foreground', 'Foreground'), fg); now += 9999999; await obs.tick()
  check('Foreground remains outside inactivity policy', arranged.some(row => row.action.identity.role === 'Foreground'), false)
  check('no background error', errors.length, 0)
  console.log(JSON.stringify({ status: 'passed', checks, ...evidence(), limits: 'Actual production ExecutionObservations with controlled clock, store and owned-agent facts. Actual SDK waterfall/producer/answer tested independently; no model, browser or full Host lifecycle claimed here.' }, null, 2))
} finally { await obs.dispose(); hooks.deregister() }
