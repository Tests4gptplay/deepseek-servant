import assert from 'node:assert/strict'
import { sourceRoot } from './test-support/dsh-sdk-runtime.mjs'

const { FrameworkRoleRuntime } = await import(new URL('framework/role-runtime.ts', sourceRoot))
const identity = { workId: 'old-helper', executionId: 'previous-execution', role: 'Helper' }
const row = { identity, sessionId: 'session-old-helper', stopUnknown: { reason: 'old stop receipt', jobs: [] } }
function runtime({ live = false, jobs = [], events = [], readError, reappears = false, role = row } = {}) {
  let agentReads = 0
  const writes = []
  const value = Object.assign(Object.create(FrameworkRoleRuntime.prototype), {
    prefix: 'test/', roleRecords: new Map(), roleBases: new Map(), dispose: async () => {},
    records: { list: async () => [{ value: role }] },
    native: { stop: async () => ({ status: 'superseded' }) },
    ctx: {
      agents: { get: () => ++agentReads && (live || (reappears && agentReads > 1)) ? {} : undefined },
      jobs: { list: () => jobs },
      sessions: { get: () => ({ snapshotEvents: () => { if (readError) throw readError; return events } }) },
    },
    saveRole: async x => { writes.push(x); },
  })
  return { value, writes }
}

const stale = runtime()
await stale.value.settleForStorageMove()
assert.deepEqual(stale.writes, [], 'A move must never mark a historical, unresolved stop as confirmed.')
assert.equal(row.stopUnknown.reason, 'old stop receipt')
await assert.rejects(runtime({ live: true }).value.settleForStorageMove(), /survives without its owned stop handle/)
await assert.rejects(runtime({ reappears: true }).value.settleForStorageMove(), /no producer identity/)
await assert.rejects(runtime({ jobs: [{ id: 'job-live', owner: row.sessionId, status: 'running' }] }).value.settleForStorageMove(), /unconfirmed native producer/)
await assert.rejects(runtime({ events: [{ type: 'job/registered', data: { owner: row.sessionId, jobId: 'job-persisted' } }] }).value.settleForStorageMove(), /unconfirmed native producer/)
await assert.rejects(runtime({ readError: new Error('fixture read failed') }).value.settleForStorageMove(), /history is unavailable/)
const ordinaryStop = runtime()
ordinaryStop.value.roleRecords.set(identity.workId, row)
const ordinaryResult = await ordinaryStop.value.stopOwnedRecord(row)
assert.equal(ordinaryResult.status, 'unconfirmed')
assert.equal(Object.hasOwn(ordinaryResult, 'historicalOnly'), false)
const stopped = runtime({ role: { identity, sessionId: row.sessionId } })
await stopped.value.settleForStorageMove()
assert.equal(stopped.writes.at(-1)?.stopped, true)
console.log(JSON.stringify({ assertions: 10, staleReceiptDoesNotBlock: true, liveProducerProtection: true }))
