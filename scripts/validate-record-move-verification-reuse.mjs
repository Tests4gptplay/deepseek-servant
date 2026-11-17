import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module'
import { sourceRoot, evidence, hash, loaded, hooks } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'

// Observe the actual function without replacing its filesystem implementation.
// The optional frozen source runs the exact same integration against pre-change code.
const observation = Symbol.for('dss.test.record-move-fingerprint'), lane = new AsyncLocalStorage()
const measurements = [], checks = [], results = [], opened = []
const originalSource = process.env.DSS_RECORD_MOVE_SOURCE
const expectedExtra = Number(process.env.DSS_EXPECT_EXTRA_TARGET_VERIFY ?? '0')
const observer = registerHooks({ load(url, context, next) {
  if (url === new URL('framework/record-move.ts', sourceRoot).href && originalSource) {
    const source = readFileSync(originalSource, 'utf8'); loaded.set('frozen/record-move.ts', hash(source))
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  const result = next(url, context)
  if (url !== new URL('framework/maintenance.ts', sourceRoot).href) return result
  assert.equal(typeof result.source, 'string')
  assert(result.source.includes('export async function localRecordFingerprint('))
  return { ...result, source: result.source.replace('export async function localRecordFingerprint(', 'async function measuredLocalRecordFingerprint(')
    + '\nexport async function localRecordFingerprint(...args) { return globalThis[Symbol.for("dss.test.record-move-fingerprint")](args, () => measuredLocalRecordFingerprint(...args)) }\n' }
} })
globalThis[observation] = async (args, run) => {
  const context = lane.getStore(), row = { case: context?.name, attempt: context?.attempt, phase: context?.callback ? 'callback' : 'advance',
    ...(context?.callbackAttempt ? { callbackAttempt: context.callbackAttempt } : {}), directory: args[0], backend: args[1], status: 'started' }
  measurements.push(row)
  try { const result = await lane.run({ ...context, fingerprint: args[0] }, run); row.status = 'passed'; row.fingerprint = result; return result }
  catch (error) { row.status = 'failed'; throw error }
}
const { FrameworkService } = await import('../src/framework/service.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { recordMoveKey } = await import('../src/framework/record-move.ts')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-move-verify-'))
const put = async (file, body) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body) }
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const rejects = async (name, run, pattern) => { await assert.rejects(run, pattern, name); checks.push(name) }
const events = (f, attempt = f.attempt) => measurements.filter(row => row.case === f.name && row.attempt === attempt && row.directory === f.targetLocal)
function counts(f, callback, advance, attempt = f.attempt) {
  const rows = events(f, attempt)
  check(f.name + ': callback target fingerprints', rows.filter(row => row.phase === 'callback').length, callback)
  check(f.name + ': advance target fingerprints', rows.filter(row => row.phase === 'advance').length, advance)
  return rows
}
async function fixture(name, kind = 'owned', seed = true) {
  const root = path.join(scratch, name), sourceRecords = path.join(root, 'records'), targetRecords = path.join(root, 'target')
  const sourceLocal = kind === 'owned' ? path.join(sourceRecords, 'deepseek_servant/framework') : path.join(root, 'custom-local')
  const scope = JSON.stringify(['local', sourceLocal]), targetLocal = kind === 'owned' ? path.join(targetRecords, 'deepseek_servant/framework') : path.join(targetRecords, 'framework-local-' + hash(scope))
  const sdk = await openDshStorageFixture(sourceRecords, path.join(root, 'locator')), store = sdk.adapter
  if (seed) {
    await put(path.join(sourceLocal, 'archives/example/records.md'), 'An ordinary preserved archive.\r\n')
    await put(path.join(sourceLocal, 'knowledge/user.txt'), 'User knowledge stays byte-exact.\n')
    await store.set('framework-settings/local', { revision: 'before', settings: { localDirectory: sourceLocal } })
  }
  const saved = await store.get('framework-settings/local'), files = new PhysicalLocalFiles(sourceLocal)
  const f = { name, root, sourceRecords, sourceLocal, targetRecords, targetLocal, scope, sdk, store, attempt: 0, stopped: 0, reopened: 0, callbackCalls: 0 }
  const access = { conversation: { scope: { mode: 'local' } }, connection: { files, records: store, scope,
    identity: { login: 'owner', instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, cancelPending() {}, close: () => files.close() } }
  // Real service methods own sequencing, quiesce, settings and mover creation.
  // This fixture has no native Agents. Its runtime stop/connection reopen/view
  // are explicit Host ports, not claims of full native Host or UI coverage.
  const service = Object.assign(Object.create(FrameworkService.prototype), {
    storage: store, closed: false, modeConfiguration: new Map(), settingsCommands: new Map(), modeSending: new Map(), conversationBarriers: new Map(),
    saved: new Map([['local', saved]]), localUpgrades: new Map(), accessOpening: new Map(), backgroundOpening: new Map(), opening: new Map(), relocationOwners: new Map(),
    accesses: new Map([['local', Promise.resolve(access)]]), archiveViews: new Map(),
    running: new Map([['local', { connection: access.connection, runtime: { async settleForStorageMove() { f.stopped++ } } }],
      ['git', { runtime: { settleForStorageMove() { throw new Error('Unrelated Git must not stop') } } }]]),
    access: async () => access, clearResolvedErrors() {}, changed() {}, report() {},
    view: async () => ({ observed: true }),
    connect: async () => { f.reopened++; check(name + ': reopening is durable before writers', (await store.get(recordMoveKey)).receipts.at(-1).phase, 'reopening') },
  })
  const nativeMove = store.moveRecords.bind(store)
  store.moveRecords = (directory, expected, signal, verify, commandId) => {
    const callbackAttempt = f.attempt
    return nativeMove(directory, expected, signal, verify && (async destination => {
      f.callbackCalls++
      return lane.run({ ...lane.getStore(), name, attempt: f.attempt, callback: true, callbackAttempt }, () => verify(destination))
    }), commandId)
  }
  Object.assign(f, { service,
    input: { mode: 'local', storageScope: scope, expectedRevision: 'before', commandId: name, directory: targetRecords },
    run() { f.attempt++; return lane.run({ name, attempt: f.attempt }, () => service.moveRecords(f.input)) },
    async close() { await files.close(); await sdk.close() },
  })
  opened.push(f); return f
}
// These are actual SDK native unit methods. Failure cases wrap one native I/O
// boundary; every successful call still executes the unchanged SDK implementation.
function locatorFault(f, timing, unknown = false) {
  const unit = f.sdk.locator.open.get('deepseek_servant_location'), putRecord = unit.putRecord.bind(unit)
  const open = f.sdk.locator.kv.open.bind(f.sdk.locator.kv)
  let hit = false, blockReadback = false
  unit.putRecord = async (table, key, value) => {
    if (!hit && key === 'active' && value.directory === f.targetRecords) {
      hit = true
      if (timing === 'after') await putRecord(table, key, value)
      blockReadback = unknown
      throw new Error('controlled locator ' + timing)
    }
    return putRecord(table, key, value)
  }
  f.sdk.locator.kv.open = async descriptor => {
    if (blockReadback) throw new Error('controlled locator readback unavailable')
    return open(descriptor)
  }
  return { get hit() { return hit }, release() { blockReadback = false } }
}
try {
  for (const kind of ['owned', 'custom']) {
    const f = await fixture('normal-' + kind, kind), result = await f.run()
    check(f.name + ': actual service applied', result.recordMoveOutcome.status, 'applied')
    const rows = counts(f, 1, expectedExtra)
    check(f.name + ': all target fingerprints passed', rows.every(row => row.status === 'passed'), true)
    check(f.name + ': source and target same fingerprint', measurements.find(row => row.case === f.name && row.directory === f.sourceLocal).fingerprint, rows[0].fingerprint)
    check(f.name + ': own Local stop and reopen only once', [f.stopped, f.reopened], [1, 1])
    check(f.name + ': Git remains active', f.service.running.has('git'), true)
    check(f.name + ': archive preserved', await fs.readFile(path.join(f.targetLocal, 'archives/example/records.md'), 'utf8'), 'An ordinary preserved archive.\r\n')
    await put(path.join(f.targetLocal, 'after-reopen.txt'), 'A legitimate later write')
    await f.run(); counts(f, 0, 0)
    check(f.name + ': applied retry preserves later write', await fs.readFile(path.join(f.targetLocal, 'after-reopen.txt'), 'utf8'), 'A legitimate later write')
    results.push({ case: f.name, targetVerificationCalls: rows.length, scope: 'actual service/mover/adapter/SDK/files; controlled native-free Host ports' })
  }
  {
    const f = await fixture('same-directory'), before = f.callbackCalls
    await f.store.moveRecords(f.sourceRecords, f.sourceRecords, new AbortController().signal, async () => { f.callbackCalls++ }, 'same')
    check('real adapter same directory does not call callback', f.callbackCalls, before)
    await rejects('service rejects new same-directory move', () => f.service.moveRecords({ ...f.input, directory: f.sourceRecords }), /explicit record move/)
    check('same directory never stopped Local', f.stopped, 0)
  }
  {
    const f = await fixture('callback-read-failure'), open = fs.open
    let hit = false
    fs.open = async (...args) => {
      if (!hit && lane.getStore()?.callback && String(args[0]) === path.join(f.targetLocal, 'archives/example/records.md')) {
        hit = true; throw Object.assign(new Error('controlled Local fingerprint read EIO'), { code: 'EIO' })
      }
      return open(...args)
    }
    syncBuiltinESMExports()
    try { await rejects('actual callback read failure stops move', () => f.run(), /fingerprint read EIO/) }
    finally { fs.open = open; syncBuiltinESMExports() }
    check('callback read fault reached', hit, true); counts(f, 1, 0)
    check('callback failure left source selected', f.store.storageView().directory, f.sourceRecords)
    await f.run(); counts(f, 1, expectedExtra)
    check('callback failure retries same command once', f.reopened, 1)
  }
  for (const timing of ['before', 'after']) {
    const f = await fixture('locator-known-' + timing), fault = locatorFault(f, timing)
    if (timing === 'before') {
      await rejects('uncommitted locator write fails original call', () => f.run(), /controlled locator before/)
      counts(f, 1, 0); check('source remains selected', f.store.storageView().directory, f.sourceRecords)
      await f.run()
    } else await f.run()
    check('native locator fault was exercised', fault.hit, true); counts(f, 1, expectedExtra)
    check('native readback path completes with target', f.store.storageView().directory, f.targetRecords)
  }
  for (const timing of ['before', 'after']) {
    const f = await fixture('locator-unknown-' + timing), fault = locatorFault(f, timing, true)
    await rejects('unknown locator remains an error', () => f.run(), /location could not be confirmed/)
    check('unknown locator fault reached', fault.hit, true); counts(f, 1, 0)
    check('unknown does not reopen', f.reopened, 0)
    fault.release(); await f.run()
    if (timing === 'after') {
      const rows = counts(f, 1, 1)
      check('retained old callback is not this advance verification', rows.find(row => row.phase === 'callback').callbackAttempt, 1)
    } else counts(f, 1, expectedExtra)
    check('unknown retry applied once', f.reopened, 1)
  }
  {
    const f = await fixture('published-cold', 'custom'), set = f.store.set.bind(f.store)
    f.store.set = async (key, value) => {
      if (key === 'framework-settings/local' && value.settings.localDirectory === f.targetLocal) throw new Error('controlled settings write failure')
      return set(key, value)
    }
    await rejects('published move remains recoverable before settings', () => f.run(), /settings write failure/)
    counts(f, 1, expectedExtra)
    check('actual receipt persisted published', (await f.store.get(recordMoveKey)).receipts[0].phase, 'published')
    await f.close()
    const resumed = await fixture('published-cold', 'custom', false); resumed.attempt = 1
    await resumed.run(); counts(resumed, 0, 1)
    check('fresh SDK reopening does not requiesce old source', resumed.stopped, 0)
  }
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, results, expectedExtra, measurements, ...evidence(),
    limits: 'Actual production service methods, FrameworkRecordMove, DshStorageAdapter and real rc.5 SDK Context/Storage/locator Domain/Json, real cloud Linux files. Native-free runtime stop/reopen and UI view are explicit ports. Function observation forwards all fingerprint I/O; controlled failures wrap real native read/put/open/close boundaries. Fresh SDK reopen is not process-kill coverage; existing lifecycle regression supplies SIGKILL cases. No Windows, complete native Host, model or latency benchmark claim.' }, null, 2))
} finally {
  await Promise.allSettled(opened.map(f => f.close()))
  delete globalThis[observation]; observer.deregister(); hooks.deregister()
  await fs.rm(scratch, { recursive: true, force: true })
}
