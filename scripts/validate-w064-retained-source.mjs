import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { sourceRoot, evidence, hooks } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const { FrameworkService } = await import(new URL('framework/service.ts', sourceRoot))
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts', sourceRoot))
const { RecordFilesBackend } = await import(new URL('adapters/dsh/record-files.ts', sourceRoot))
const { recordMoveKey } = await import(new URL('framework/record-move.ts', sourceRoot))
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-w064-'))
const checks = [], closes = [], open = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const put = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
// Observe unchanged native close calls. No forced failure, delay, or extra write.
const close = RecordFilesBackend.prototype.close
RecordFilesBackend.prototype.close = function(...args) {
  const started = performance.now()
  const row = { directory: this.directory, nativeBackends: this.files.size,
    opening: [...this.files.values()].reduce((n, f) => n + f.backend.opening.size, 0),
    inFlight: [...this.files.values()].reduce((n, f) => n + [...f.backend.open.values()].reduce((m, u) => m + u.inFlight.size, 0), 0) }
  closes.push(row)
  const result = close.apply(this, args)
  void result.then(() => { row.elapsedMs = performance.now() - started; row.status = 'closed' }, error => { row.status = 'failed'; row.error = String(error) })
  return result
}
async function fixture(root, kind, existing) {
  const sourceRecords = path.join(root, 'records'), sourceLocal = kind === 'owned' ? path.join(sourceRecords, 'deepseek_servant', 'framework') : path.join(root, 'custom-local')
  const sdk = await openDshStorageFixture(sourceRecords, path.join(root, 'locator')), store = sdk.adapter
  if (!existing) {
    await put(path.join(sourceLocal, 'archives/example/records.md'), 'Original user archive.\r\n')
    await store.set('framework-settings/local', { revision: 'before', settings: { localDirectory: sourceLocal } })
    await store.set('framework-participation/local', false)
    await put(path.join(sourceRecords, 'unrelated.txt'), 'outside the DSS copy')
  }
  const saved = await store.get('framework-settings/local'), scope = JSON.stringify(['local', sourceLocal])
  const f = { sdk, store, sourceRecords, sourceLocal, scope, stops: 0, reports: [], physical: [] }
  const service = new FrameworkService(sdk.ctx, store, saved.settings)
  service.saved.set('local', saved)
  service.changed = () => {}
  service.view = async () => ({ observed: true })
  service.report = (_mode, error) => { f.reports.push(String(error)); return 'observed-report' }
  const access = () => {
    const files = new PhysicalLocalFiles(service.config('local').settings.localDirectory); f.physical.push(files)
    return { connection: { files, records: store, scope, identity: { login: 'owner', instanceUUID: '10000000-0000-4000-8000-000000000001' }, cancelPending() {}, close: () => files.close() } }
  }
  service.access = async () => access()
  service.closeAccess = async value => value.connection.close()
  service.quiesceRecords = async receipt => {
    // Real quiesce method with an already-owned native-free runtime port.
    const a = access()
    service.running.set('local', { connection: a.connection, runtime: { async settleForStorageMove() { f.stops++ } } })
    return FrameworkService.prototype.quiesceRecords.call(service, receipt, new AbortController().signal)
  }
  f.service = service
  f.input = { mode: 'local', storageScope: scope, expectedRevision: saved.revision, commandId: 'move-' + kind, directory: path.join(root, 'target') }
  f.close = async () => { await Promise.all(f.physical.map(files => files.close())); await sdk.close() }
  open.push(f); return f
}
try {
  for (const kind of ['owned', 'custom']) {
    const root = path.join(scratch, kind), f = await fixture(root, kind)
    const input = f.input
    const get = f.store.get.bind(f.store)
    f.store.get = async key => {
      if (/^framework-(?:physical-upgrade|startup-upgrade-agent|local-upgrade-result|upgrade-)/.test(key))
        throw new Error('Unrelated historical upgrade lookup must not be part of a move')
      return get(key)
    }
    const result = await f.service.moveRecords(input)
    check(kind + ': applied through actual service and mover', result.recordMoveOutcome.status, 'applied')
    check(kind + ': source reported retained', result.recordMoveOutcome.retainedSource, f.sourceRecords)
    check(kind + ': original archive unchanged', await fs.readFile(path.join(f.sourceLocal, 'archives/example/records.md'), 'utf8'), 'Original user archive.\r\n')
    check(kind + ': unrelated parent file retained', await fs.readFile(path.join(f.sourceRecords, 'unrelated.txt'), 'utf8'), 'outside the DSS copy')
    const local = f.service.config('local').settings.localDirectory
    check(kind + ': target archive retained', await fs.readFile(path.join(local, 'archives/example/records.md'), 'utf8'), 'Original user archive.\r\n')
    await f.store.set('framework-git-enabled', true)
    check(kind + ': target writes proceed', await f.store.get('framework-git-enabled'), true)
    const before = (await f.store.get(recordMoveKey)).receipts
    const repeat = await f.service.moveRecords(input)
    check(kind + ': same command still reports original', repeat.recordMoveOutcome.retainedSource, f.sourceRecords)
    check(kind + ': repeated result did not move again', (await f.store.get(recordMoveKey)).receipts, before)
    check(kind + ': one quiesce', f.stops, 1)
    // Close/reopen the actual SDK and service: memory-only retainedSource is gone.
    await f.close()
    const cold = await fixture(root, kind, true)
    check(kind + ': adapter memory source is absent after restart', cold.store.storageView().retainedSource, undefined)
    const retry = await cold.service.moveRecords(input)
    check(kind + ': durable original command retains source after restart', retry.recordMoveOutcome.retainedSource, f.sourceRecords)
    check(kind + ': completed retry does not stop execution', cold.stops, 0)
    const secondInput = { ...input, commandId: 'second-' + kind, directory: path.join(root, 'second-target'), expectedRevision: cold.service.config('local').revision }
    const set = cold.store.set.bind(cold.store)
    let interrupted = false
    cold.store.set = async (key, value) => {
      await set(key, value)
      if (!interrupted && key === recordMoveKey && value.receipts.some(x => x.commandId === secondInput.commandId && x.phase === 'prepared')) {
        interrupted = true
        throw new Error('controlled acknowledgement loss after prepared receipt')
      }
    }
    await assert.rejects(() => cold.service.moveRecords(secondInput), /not confirmed/)
    check(kind + ': interruption left the exact prepared receipt', interrupted, true)
    check(kind + ': prepared move leaves old root active', cold.store.storageView().directory, input.directory)
    cold.store.set = set
    const second = await cold.service.moveRecords(secondInput)
    check(kind + ': second move retains its own source', second.recordMoveOutcome.retainedSource, input.directory)
    check(kind + ': first target remains on disk', (await fs.stat(path.join(input.directory, 'deepseek_servant'))).isDirectory(), true)
    const retired = await cold.service.moveRecords(input)
    check(kind + ': retired command only reports current location', retired.recordMoveOutcome.status, 'current-location')
    check(kind + ': retired command does not borrow latest retained source', Object.hasOwn(retired.recordMoveOutcome, 'retainedSource'), false)
    const same = { ...secondInput, commandId: 'same-' + kind, expectedRevision: cold.service.config('local').revision }
    await assert.rejects(() => cold.service.moveRecords(same), /explicit record move/)
    checks.push(kind + ': actual same-directory input rejects')
    check(kind + ': actual rejected input remains reported', cold.reports.some(x => x.includes('explicit record move')), true)
    check(kind + ': no extra quiesce on rejected input', cold.stops, 1)
    await cold.close()
  }
  check('native close saw no outstanding opens', closes.every(x => x.opening === 0), true)
  check('native close saw no outstanding writes', closes.every(x => x.inFlight === 0), true)
  check('every observed close completed', closes.every(x => x.status === 'closed'), true)
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, closes, ...evidence(),
    limits: 'Actual full FrameworkService class, sequencing, mover, configuration publication, physical files and current DSH SDK. Native-free runtime stop, access acquisition and page view are explicit ports. Actual same-directory refusal, source retention, restart/repeat, and observation of legacy upgrade key reads. Linux temporary files, not DSH UI/Windows/model.' }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', checks, closes, error: String(error), ...evidence() }, null, 2)); throw error
} finally {
  await Promise.allSettled(open.map(f => f.close())); RecordFilesBackend.prototype.close = close; hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true })
}
