// Focused control-flow tests extracted from the current production methods.
// This is NOT an end-to-end SDK, Git transport, or real concurrent-Host test.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = path.resolve(process.env.DSS_AUDIT_SOURCE_ROOT || fileURLToPath(new URL('..', import.meta.url)))
const file = path.join(sourceRoot, 'src/framework/role-runtime.ts')
const source = await fs.readFile(file, 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const method = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, 'Expected unique production method delimiters: ' + start)
  assert.equal(source.indexOf(start, a + 1), -1, 'Method start must be unique')
  return source.slice(a, b)
}
const methods = [
  method('  private helperResponsibilities(', '  private binding('),
  method('  private consumeWakeSignals(', '  private claimCurrentNotifications('),
  method('  private claimCurrentNotifications(', '  private withRoleWrite'),
  method('  private withRoleWrite', '  private async settleNotificationClaim('),
].join('\n')
assert.match(methods, /const settledClaims = new Map<string, string>\(\)/, 'Exercise the requested candidate, not an old baseline')
const compiled = stripTypeScriptTypes('class Probe {\n' + methods + '\n}', { mode: 'transform' })
class ControlledAuthority {
  constructor(record, afterPublish) { this.record = structuredClone(record); this.afterPublish = afterPublish; this.gets = 0; this.publishes = 0 }
  async get() {
    this.gets++
    if (this.awaitingReread) {
      this.awaitingReread = false
      if (this.afterPublish) this.record = this.afterPublish(structuredClone(this.record))
    }
    return structuredClone(this.record)
  }
  async getAt() { return structuredClone(this.record) }
  async updateOwned(key, id, build, ...options) {
    const before = options.at(-1)
    if (typeof before === 'function') before()
    const selected = build(structuredClone(this.record))
    if (selected.write) { this.record = structuredClone(selected.value); this.publishes++ }
    this.awaitingReread = true
    return selected.result
  }
}
class PhysicalLocalFiles {}
const newSource = { path: 'state/Helper_A_later', version: 'new-source-v1' }
const Probe = new Function('GitAuthorityStore', 'PhysicalLocalFiles', 'withSnapshot', 'hash', 'helperSignalWakeHash', 'assertTaskLifecycle',
  compiled + '\nreturn Probe')(ControlledAuthority, PhysicalLocalFiles, async (files, run) => run({ revision: 'controlled' }), hash,
    p => p === newSource.path ? 'later-hash' : undefined, async () => {})
const binding = { role: 'Helper', workId: 'Helper:A', executionId: 'exec-current' }
const wake = { id: 'help:main', role: 'Helper', reason: 'help', sources: [] }
const oldWake = { id: 'help:old', role: 'Helper', reason: 'help', sources: [{ path: 'state/Helper_A_old', version: 'old-source-v1' }] }
const claim = (id, extra = {}) => ({ commandId: 'consume-later/' + hash(id), executionId: binding.executionId,
  wakeId: wake.id, initialSignals: ['state/initial'], sources: [{ path: 'state/Helper_A_old', version: 'old-source-v1' }],
  helperWakes: [structuredClone(oldWake)], ...extra })
const old = claim('old')
const initialRecord = () => ({ identity: { ...binding }, sessionId: 'session-current', generation: 1,
  delivery: { request: structuredClone(wake), messageId: 'native-main', confirmed: true }, notificationClaims: { 'native:old': structuredClone(old) } })
const checks = [], scenarios = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
function fixture({ afterPublish, fail, cached = true, role = 'Helper', mode = 'git' } = {}) {
  const ownBinding = { ...binding, role, ...(role !== 'Helper' && role !== 'Foreground' ? { taskId: 'controlled-task' } : {}) }
  const rt = new Probe(), record = initialRecord()
  record.identity = { ...ownBinding }
  record.delivery.request.role = role
  if (ownBinding.taskId) record.delivery.request.taskId = ownBinding.taskId
  const authority = new ControlledAuthority(record, afterPublish)
  const recordPort = mode === 'git' ? authority : { get: authority.get.bind(authority), getAt: authority.getAt.bind(authority) }
  Object.assign(rt, { records: recordPort, config: { member: 'A', primary: true, mode }, closed: false,
    roleRecords: new Map([[binding.workId, record]]), notificationClaimWrites: new Map(),
    notificationContextRetries: new Map(), wakeConsumptions: new Map(),
    files: { listDirectory: async () => [structuredClone(newSource)] },
    roleRecordPath: () => 'role/current', assertOrganizerBusiness: () => {},
    addressedSignals: () => [], notifications: async () => [newSource.path],
    conversation: { routeForegroundSignals: async sources => sources },
    wakeAdmission: () => undefined, replaySafetyWake: () => {}, forgetForegroundNotices: () => {},
    wake: async (request, recovery, safety, parent, selected) => selected({ request: {
      id: 'help:later', role: 'Helper', reason: 'help', sources: [structuredClone(newSource)] } }),
  })
  if (cached) rt.wakeConsumptions.set(binding.executionId, { wakeId: wake.id, promise: Promise.resolve({ signals: [] }), completed: true })
  const calls = []
  rt.settleNotificationClaim = async (value, assertOwner, beforeAttempt, currentBinding) => {
    beforeAttempt()
    await assertOwner({ revision: 'controlled' })
    calls.push({ claim: structuredClone(value), binding: { ...currentBinding } })
    if (fail) await fail(value, calls)
  }
  const run = commandId => rt.claimCurrentNotifications(ownBinding, commandId)
  return { rt, authority, calls, run, oldCalls: () => calls.filter(x => x.claim.commandId === old.commandId) }
}

// Cached consumeWakeSignals represents dss_snapshot having consumed the initial
// wake before this ordinary later dss_claim. The real cached method is exercised.
{
  const f = fixture(), result = await f.run('native:new')
  check('same exact old claim settles once in this cached-consume call', f.oldCalls().length, 1)
  check('new selection settles once', f.calls.length, 2)
  check('original accepted old claim remains byte-for-byte in authority', f.authority.record.notificationClaims['native:old'], old)
  check('actual Helper selection is still returned', result.helperNotifications.some(w => w.id === 'help:later'), true)
  check('old accepted Helper context is not hidden', result.helperNotifications.some(w => w.id === 'help:old'), true)
  check('existing context save and original reread are unchanged', [f.authority.publishes, f.authority.gets], [1, 2])
  check('cache is invalidated at the original post-save point', f.rt.wakeConsumptions.has(binding.executionId), false)
  scenarios.push({ name: 'same claim + new selection', settlementCalls: f.calls.length, publishes: f.authority.publishes })
}
{
  const extra = claim('reread-extra', { sources: [{ path: 'state/extra', version: 'extra-v1' }] })
  const f = fixture({ afterPublish: record => ({ ...record, notificationClaims: { ...record.notificationClaims, 'native:extra': extra } }) })
  await f.run('native:new')
  check('reread-added claim still settles', f.calls.filter(x => x.claim.commandId === extra.commandId).length, 1)
  check('reread-added case still skips unchanged old second settlement', f.oldCalls().length, 1)
  check('reread-added case settles all three distinct claims', f.calls.length, 3)
  scenarios.push({ name: 'controlled authoritative reread addition', settlementCalls: f.calls.length })
}
for (const [label, change] of [
  ['source version', c => ({ ...c, sources: [{ ...c.sources[0], version: 'old-source-v2' }] })],
  ['helper diagnostic content', c => ({ ...c, helperWakes: c.helperWakes.map(w => ({ ...w, context: { diagnostic: 'changed-content' } })) })],
  ['initial accepted context', c => ({ ...c, initialSignals: [...c.initialSignals, 'state/changed-context'] })],
]) {
  const changed = change(structuredClone(old))
  const f = fixture({ afterPublish: record => ({ ...record, notificationClaims: { ...record.notificationClaims, 'native:old': changed } }) })
  await f.run('native:new')
  check('same-key changed ' + label + ' is not skipped', f.oldCalls().map(x => x.claim), [old, changed])
  check('same-key changed ' + label + ' still settles the newly selected claim', f.calls.length, 3)
  scenarios.push({ name: 'controlled authoritative reread changed ' + label, settlementCalls: f.calls.length })
}
{
  const failure = new Error('controlled prior settlement failure'); let reject = true
  const f = fixture({ fail: value => { if (reject && value.commandId === old.commandId) { reject = false; throw failure } } })
  await assert.rejects(f.run('native:new'), error => error === failure); checks.push('prior failure propagates unchanged')
  check('prior failure does not publish new context', f.authority.publishes, 0)
  await f.run('native:new')
  check('failed prior is not memoized across same-ID retry', f.oldCalls().length, 2)
  check('successful retry publishes only once', f.authority.publishes, 1)
  check('same-ID retry uses unchanged prior claim content', f.oldCalls().map(x => x.claim), [old, old])
  scenarios.push({ name: 'prior failure and identical requested-ID retry', settlementCalls: f.calls.length })
}
{
  const failure = new Error('controlled selected settlement failure'); let reject = true
  const newCommand = 'consume-later/' + hash('native:new')
  const f = fixture({ fail: value => { if (reject && value.commandId === newCommand) { reject = false; throw failure } } })
  await assert.rejects(f.run('native:new'), error => error === failure); checks.push('new claim failure propagates unchanged')
  const saved = structuredClone(f.authority.record.notificationClaims['native:new'])
  check('failed settlement preserves accepted context', !!saved, true)
  const callsBefore = f.calls.length
  await f.run('native:new')
  check('same-ID replay still takes saved-claim path without republishing', f.authority.publishes, 1)
  check('same-ID replay retries only its saved claim as before', f.calls.slice(callsBefore).map(x => x.claim), [saved])
  check('same-ID replay arguments remain byte-for-byte', f.calls.filter(x => x.claim.commandId === newCommand).map(x => x.claim), [saved, saved])
  check('saved claim remains unchanged after successful retry', f.authority.record.notificationClaims['native:new'], saved)
  scenarios.push({ name: 'post-save failure and original saved-claim retry', settlementCalls: f.calls.length })
}
{
  const f = fixture({ cached: false })
  await f.run('native:new')
  check('uncached Git Helper old claim settles once through current Map', f.oldCalls().length, 1)
  check('uncached Git Helper new selection still settles', f.calls.length, 2)
  scenarios.push({ name: 'uncached real consume boundary', settlementCalls: f.calls.length })
}
{
  const f = fixture(); await f.run('native:new')
  const saved = structuredClone(f.authority.record.notificationClaims['native:new'])
  const before = f.calls.length
  await f.run('native:new')
  check('successful same-ID replay is not memoized away by per-call Map', f.calls.slice(before).map(x => x.claim), [saved])
  check('successful same-ID replay does not create another publication', f.authority.publishes, 1)
  scenarios.push({ name: 'successful saved same-ID replay unchanged', settlementCalls: f.calls.length })
}
{
  const failure = new Error('controlled context reread failure')
  const f = fixture(), get = f.authority.get.bind(f.authority)
  let reject = true
  f.authority.get = async (...args) => {
    if (f.authority.awaitingReread && reject) { reject = false; throw failure }
    return get(...args)
  }
  await assert.rejects(f.run('native:accepted-before-reread'), error => error === failure)
  checks.push('post-publication context reread failure propagates unchanged')
  const accepted = structuredClone(f.authority.record.notificationClaims['native:accepted-before-reread'])
  check('reread failure leaves accepted durable claim in place', !!accepted, true)
  check('reread failure retains original retry continuation', f.rt.notificationContextRetries.has(binding.workId), true)
  check('reread failure can leave original consumed-wake cache in place', f.rt.wakeConsumptions.has(binding.executionId), true)
  // A distinct next tool call resolves the original pending context before
  // querying notifications. Isolate that recovery without selecting new work.
  f.rt.notifications = async () => []
  const before = f.calls.length
  await f.run('native:next-after-reread-failure')
  check('cached consume does not hide newly recovered accepted claim', f.calls.slice(before).some(x => x.claim.commandId === accepted.commandId), true)
  check('recovered claim settles with its exact original arguments', f.calls.filter(x => x.claim.commandId === accepted.commandId).map(x => x.claim), [accepted])
  check('resolved context retry is retired only after success', f.rt.notificationContextRetries.has(binding.workId), false)
  check('recovery does not publish a duplicate or an empty new claim', f.authority.publishes, 1)
  scenarios.push({ name: 'failed context reread plus cached-consume recovery', settlementCalls: f.calls.length })
}
{
  // A real in-flight consume started by another caller has no reference to
  // this claim's Map. Joining its promise must not manufacture a local hit.
  let release, entered
  const held = new Promise(resolve => { release = resolve })
  const entry = new Promise(resolve => { entered = resolve })
  let first = true
  const f = fixture({ cached: false, fail: async value => {
    if (first && value.commandId === old.commandId) { first = false; entered(); await held }
  } })
  const priorConsume = f.rt.consumeWakeSignals(binding)
  await entry
  const claiming = f.run('native:concurrent-with-existing-consume')
  // Let the claiming call enter the already-held original promise naturally.
  await new Promise(setImmediate)
  release()
  await Promise.all([priorConsume, claiming])
  check('existing in-flight consume cannot populate another call Map', f.oldCalls().length, 2)
  check('existing in-flight consume and claim retain the new settlement', f.calls.length, 3)
  scenarios.push({ name: 'existing in-flight consume promise is not a Map hit', settlementCalls: f.calls.length })
}
{
  const failure = new Error('controlled uncached consume settlement failure'); let reject = true
  const f = fixture({ cached: false, fail: value => {
    if (reject && value.commandId === old.commandId) { reject = false; throw failure }
  } })
  await assert.rejects(f.run('native:uncached-retry'), error => error === failure)
  checks.push('uncached consume settlement failure propagates unchanged')
  check('failed uncached consume publishes no new context', f.authority.publishes, 0)
  check('failed uncached consume is not left as a successful promise', f.rt.wakeConsumptions.has(binding.executionId), false)
  await f.run('native:uncached-retry')
  check('failed uncached claim is not memoized across same-ID retry', f.oldCalls().length, 2)
  check('uncached retry uses exact accepted old bytes', f.oldCalls().map(x => x.claim), [old, old])
  check('successful uncached retry publishes exactly once', f.authority.publishes, 1)
  scenarios.push({ name: 'uncached settlement failure and same-ID retry', settlementCalls: f.calls.length })
}
for (const [mode, role] of [['local', 'Helper'], ['git', 'Foreground'], ['git', 'Planner'], ['git', 'Worker'], ['git', 'Organizer']]) {
  let f, transitioned = false
  f = fixture({ cached: false, mode, role, fail: value => {
    if (!transitioned && value.commandId === old.commandId) {
      transitioned = true
      // Native stop is a real supported concurrent action. This is a controlled
      // boundary probe, not a claim that a user observed this timing.
      const current = f.rt.roleRecords.get(binding.workId)
      f.rt.roleRecords.set(binding.workId, { ...current, stopIntent: { phase: 'requested' } })
    }
  } })
  // No new selection: a mistakenly skipped strict pre-loop guard could return
  // successfully here, rather than happen to fail at a later context save.
  f.rt.notifications = async () => []
  await assert.rejects(f.run('native:stop-during-consume'), /Signal claim belongs to an ended, stopping, or replaced execution/)
  checks.push(mode + ' ' + role + ' preserves strict prior-loop stopIntent validation')
  check(mode + ' ' + role + ' completed initial consumption before the strict rejection', transitioned, true)
  check(mode + ' ' + role + ' does not publish after strict rejection', f.authority.publishes, 0)
  scenarios.push({ name: mode + ' ' + role + ' strict pre-loop owner guard preserved', settlementCalls: f.calls.length })
}
console.log(JSON.stringify({ status: 'passed', checks: checks.length, scenarios,
  source: { roleRuntimeSha256: hash(source), extractedMethodsSha256: hash(methods), scriptSha256: hash(await fs.readFile(new URL(import.meta.url))) },
  execution: { node: process.version, sourceRoot },
  scope: 'Actual current production claimCurrentNotifications, consumeWakeSignals, withRoleWrite and helperResponsibilities extracted and TypeScript-transformed. Controlled authority/files/wake/settlement ports. No SDK/native model, real Git OID/CAS, failure-origin proof, concurrent-Host proof, performance measurement or full-runtime integration claim. Reread modifications and exceptions are boundary probes, not claimed user incidents.' }, null, 2))
