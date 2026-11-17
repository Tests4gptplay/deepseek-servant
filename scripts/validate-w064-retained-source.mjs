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
    const input = f.input, result = await f.service.moveRecords(input)
    check(kind + ': applied through actual service and mover', result.recordMoveOutcome.status, 'applied')
    check(kind + ': cleanup succeeded', result.recordMoveOutcome.sourceCleanup, { retained: [] })
    check(kind + ': removed sources are not called retained', Object.hasOwn(result.recordMoveOutcome, 'retainedSource'), false)
    check(kind + ': copied source tree removed', await fs.lstat(f.sourceLocal).then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false}), false)
    check(kind + ': unrelated parent file retained', await fs.readFile(path.join(f.sourceRecords, 'unrelated.txt'), 'utf8'), 'outside the DSS copy')
    const local = f.service.config('local').settings.localDirectory
    check(kind + ': target archive retained', await fs.readFile(path.join(local, 'archives/example/records.md'), 'utf8'), 'Original user archive.\r\n')
    await f.store.set('framework-git-enabled', true)
    check(kind + ': target writes proceed', await f.store.get('framework-git-enabled'), true)
    const before = (await f.store.get(recordMoveKey)).receipts
    const repeat = await f.service.moveRecords(input)
    check(kind + ': same command keeps cleanup result', repeat.recordMoveOutcome.sourceCleanup, { retained: [] })
    check(kind + ': repeated result did not move again', (await f.store.get(recordMoveKey)).receipts, before)
    check(kind + ': one quiesce', f.stops, 1)
    // Close/reopen the actual SDK and service: memory-only retainedSource is gone.
    await f.close()
    const cold = await fixture(root, kind, true)
    check(kind + ': adapter memory source is absent after restart', cold.store.storageView().retainedSource, undefined)
    const retry = await cold.service.moveRecords(input)
    check(kind + ': durable original command keeps cleanup after restart', retry.recordMoveOutcome.sourceCleanup, { retained: [] })
    check(kind + ': completed retry does not stop execution', cold.stops, 0)
    const secondInput = { ...input, commandId: 'second-' + kind, directory: path.join(root, 'second-target'), expectedRevision: cold.service.config('local').revision }
    const second = await cold.service.moveRecords(secondInput)
    check(kind + ': second cleanup succeeded', second.recordMoveOutcome.sourceCleanup, { retained: [] })
    check(kind + ': first target is no longer a duplicate tree', await fs.lstat(path.join(input.directory, 'deepseek_servant')).then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false}), false)
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
  for (const kind of ['owned', 'custom']) {
    const root = path.join(scratch, 'readonly-' + kind), f = await fixture(root, kind)
    const locked = path.join(f.sourceLocal, 'archives/example')
    await fs.chmod(locked, 0o500)
    try {
      const result = await f.service.moveRecords(f.input), outcome = result.recordMoveOutcome
      check(kind + ': actual EACCES still applied', outcome.status, 'applied')
      check(kind + ': actual failed directory is reported', outcome.sourceCleanup.retained[0].directory,
        kind === 'owned' ? path.join(f.sourceRecords, 'deepseek_servant') : f.sourceLocal)
      check(kind + ': real filesystem reason reported', outcome.sourceCleanup.retained[0].reason.includes('EACCES'), true)
      check(kind + ': failed source original retained', await fs.readFile(path.join(locked, 'records.md'), 'utf8'), 'Original user archive.\r\n')
      check(kind + ': new archive is readable after cleanup failure', await fs.readFile(path.join(f.service.config('local').settings.localDirectory, 'archives/example/records.md'), 'utf8'), 'Original user archive.\r\n')
      await f.store.set('framework-git-enabled', true)
      check(kind + ': new address accepts writes after cleanup failure', await f.store.get('framework-git-enabled'), true)
      check(kind + ': cleanup did not become pending move', (await f.store.get(recordMoveKey)).receipts[0].phase, 'applied')
      await fs.chmod(locked, 0o700)
      await f.close()
      const cold = await fixture(root, kind, true), retry = await cold.service.moveRecords(f.input)
      check(kind + ': cold retry keeps exact failure result', retry.recordMoveOutcome.sourceCleanup, outcome.sourceCleanup)
      check(kind + ': retry does not silently delete a former residual', await fs.readFile(path.join(locked, 'records.md'), 'utf8'), 'Original user archive.\r\n')
      await cold.close()
      console.log(JSON.stringify({ realCleanupFailure: outcome }))
    } finally { await fs.chmod(locked, 0o700).catch(()=>{}) }
  }
  check('native close saw no outstanding opens', closes.every(x => x.opening === 0), true)
  check('native close saw no outstanding writes', closes.every(x => x.inFlight === 0), true)
  check('every observed close completed', closes.every(x => x.status === 'closed'), true)
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, closes, ...evidence(),
    limits: 'Actual full FrameworkService class, sequencing, mover, configuration publication, physical files and current DSH SDK. Native-free runtime stop, access acquisition and page view are explicit ports. Actual same-directory refusal, normal cleanup/restart/repeat and real read-only-directory EACCES; no injected error or delay. Linux temporary files, not DSH UI/Windows/model.' }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', checks, closes, error: String(error), ...evidence() }, null, 2)); throw error
} finally {
  await Promise.allSettled(open.map(f => f.close())); RecordFilesBackend.prototype.close = close; hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true })
}
