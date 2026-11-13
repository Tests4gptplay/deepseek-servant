import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { randomUUID } from 'node:crypto'
import { sourceRoot, hooks, evidence, hash, loaded } from './test-support/dsh-sdk-runtime.mjs'

// Explicit, frozen pre-change production files generate the legacy state.
// Do not reinterpret a hand-written v1 fixture as proof of migration coverage.
const baseline = process.env.DSS_RECORD_MOVE_BASELINE_DIR
const baselineHashes = {
  'record-move.ts': '1d1883ea4064e61d7ad184cb64687a6465b890b21ff0b522df3008c0c362ae00',
  'local-location.ts': 'a7f0222d273f127e476487492a7f5227756faec06fa4bfc8f3cf05e21a43b3f8',
}
const legacyMode = process.argv[2] === '--legacy' || process.argv[2] === '--legacy-mixed'
let baselineHooks
if (legacyMode || process.env.DSS_TEST_USE_BASELINE === '1') {
  assert(baseline && path.isAbsolute(baseline), 'Provide the explicit frozen baseline directory')
  const originals = new Map(Object.entries(baselineHashes).map(([name, expected]) => {
    const source = readFileSync(path.join(baseline, name), 'utf8')
    assert.equal(hash(source), expected, 'Frozen baseline changed: ' + name)
    return [new URL('framework/' + name, sourceRoot).href, source]
  }))
  baselineHooks = registerHooks({ load(url, context, next) {
    if (!originals.has(url)) return next(url, context)
    const source = originals.get(url)
    loaded.set('baseline/' + path.basename(fileURLToPath(url)), hash(source))
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  } })
}
const { openDshStorageFixture } = await import('./test-support/dsh-sdk-storage.mjs')
const { FrameworkRecordMove, recordMoveKey } = await import('../src/framework/record-move.ts')
const { LocalLocationRegistry, localLocationRecordKey, LocalLocationMovedError } = await import('../src/framework/local-location.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const put = async (file, body) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body) }
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const signal = () => new AbortController().signal
let assertions = 0, processInterruptions = 0
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++ }
const rejects = async (operation, pattern) => { await assert.rejects(operation, pattern); assertions++ }
const fixtures = []
async function open(root) {
  const fixture = await openDshStorageFixture(path.join(root, 'A'), path.join(root, 'locator'))
  fixtures.push(fixture)
  return fixture.adapter
}
async function seed(root) {
  const sourceRecords = path.join(root, 'A'), sourceLocal = path.join(root, 'original-local')
  const store = await open(root)
  await put(path.join(sourceLocal, 'archives/task/records.md'), 'original controlled archive\n')
  const before = { revision: 'original-revision', settings: { localDirectory: sourceLocal } }
  await store.set('framework-settings/local', before)
  const request = { sourceRecords, targetRecords: path.join(root, 'B'), sourceLocal, localBackend: 'physical',
    scope: JSON.stringify(['local', sourceLocal]), settingsBefore: before, nextSettingsRevision: 'moved-revision' }
  await put(path.join(root, 'request.json'), JSON.stringify(request))
  return { store, request }
}
function lifecycle(store, counts = { quiesce: 0, reopen: 0 }) {
  return { quiesce: async () => { counts.quiesce++ }, applySettings: async receipt => {
    await store.set('framework-settings/local', receipt.settingsAfter)
  }, reopen: async receipt => {
    counts.reopen++
    await put(path.join(receipt.targetLocal, 'after-reopen.txt'), 'legitimate new write after publication')
  } }
}
async function movedError(registry, source, destination) {
  await rejects(async () => {
    try { await registry.resolve(source) } catch (error) {
      assert(error instanceof LocalLocationMovedError)
      assert.equal(error.destination, destination)
      throw error
    }
  }, /has moved/)
}

if (process.argv[2] === '--interrupt') {
  const root = process.argv[3], phase = process.argv[4], request = await json(path.join(root, 'request.json')), store = await open(root)
  const nativeSet = store.set.bind(store)
  store.set = async (key, value) => {
    await nativeSet(key, value)
    const receipt = key === recordMoveKey ? value.receipts.find(row => row.commandId === 'cold-move') : undefined
    if (phase === 'prepared' && receipt?.phase === 'prepared' && !receipt.fingerprint
      || phase === 'copy-owned' && receipt?.localCopy?.owned && Object.keys(receipt.localCopy.owned).length > 1
      || phase === 'published' && receipt?.phase === 'published'
      || phase === 'reopening' && receipt?.phase === 'reopening'
      || phase === 'location-retired' && key === localLocationRecordKey && value.version === 2 && value.moves.length === 0
      || phase === 'applied' && receipt?.phase === 'applied') process.kill(process.pid, 'SIGKILL')
  }
  await new FrameworkRecordMove(store, store, lifecycle(store)).run('cold-move', request, signal())
  throw new Error('Process interruption not reached: ' + phase)
}
if (legacyMode) {
  const root = process.argv[3], { store, request } = await seed(root)
  const mover = new FrameworkRecordMove(store, store, lifecycle(store))
  const first = await mover.run('legacy-first', request, signal())
  const secondRequest = { ...request, sourceRecords: first.targetRecords, targetRecords: path.join(root, 'C'),
    sourceLocal: first.targetLocal, settingsBefore: first.settingsAfter, nextSettingsRevision: 'legacy-second-revision' }
  if (process.argv[2] === '--legacy-mixed') {
    await put(path.join(root, 'legacy-result.json'), JSON.stringify({ first, secondRequest, baselineHashes }))
    const set = store.set.bind(store), phase = process.argv[4]
    store.set = async (key, value) => {
      await set(key, value)
      if (key === localLocationRecordKey && value.moves.some(move => move.commandId === 'legacy-second' && move.phase === phase))
        process.kill(process.pid, 'SIGKILL')
    }
  }
  const second = await mover.run('legacy-second', secondRequest, signal())
  check((await store.get(recordMoveKey)).receipts.length, 2)
  check((await store.get(localLocationRecordKey)).version, 1)
  check((await store.get(localLocationRecordKey)).moves.length, 2)
  await put(path.join(root, 'legacy-result.json'), JSON.stringify({ first, second, baselineHashes }))
  await Promise.all(fixtures.map(f => f.close()))
  console.log(JSON.stringify({ status: 'legacy-produced', ...evidence() }))
  baselineHooks.deregister(); hooks.deregister()
  process.exit(0)
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-move-lifecycle-'))
try {
  // Replay the actual service moveRecords method with the same input retained
  // by RecordMovePanel. Unrelated Host/UI ports remain explicit test ports.
  const proposedService = process.env.DSS_RECORD_MOVE_SERVICE_SOURCE
  const serviceSource = readFileSync(proposedService ?? new URL('framework/service.ts', sourceRoot), 'utf8')
  loaded.set(proposedService ? 'proposal/service.ts' : 'framework/service.ts', hash(serviceSource))
  const js = stripTypeScriptTypes(serviceSource, { mode: 'transform' })
  const begin = js.indexOf('    moveRecords(input)'), end = js.indexOf('    async maintenanceView(', begin)
  assert(begin >= 0 && end > begin)
  const Service = new Function('PhysicalLocalFiles', 'randomUUID', 'return class {\n' + js.slice(begin, end) + '\n}')(PhysicalLocalFiles, randomUUID)
  const root = path.join(base, 'service'), { store, request } = await seed(root), counts = { quiesce: 0, reopen: 0 }
  let current = request.settingsBefore, failView = true
  const owner = lifecycle(store, counts), moveOwner = { ...owner, applySettings: async receipt => { await owner.applySettings(receipt); current = receipt.settingsAfter } }
  const service = Object.assign(new Service(), { storage: store, serialMode: (_mode, operation) => operation(), assertOpen() {},
    mover: () => new FrameworkRecordMove(store, store, moveOwner), config: () => current,
    access: async () => ({ connection: { scope: request.scope, files: new PhysicalLocalFiles(current.settings.localDirectory) } }),
    checkScope: (access, scope) => assert.equal(access.connection.scope, scope), changed() {}, clearResolvedErrors() {}, report() {},
    view: async () => { if (failView) { failView = false; throw new Error('controlled response loss after applied') } return { applied: current.settings.localDirectory } },
  })
  const firstInput = { mode: 'local', commandId: 'ui-first', directory: request.targetRecords, storageScope: request.scope, expectedRevision: current.revision }
  await rejects(() => service.moveRecords(firstInput), /response loss/)
  let receipts = (await store.get(recordMoveKey)).receipts
  check(receipts.length, 1); check(receipts[0].phase, 'applied'); check(receipts[0].localCopy, undefined)
  const first = structuredClone(receipts[0])
  const after = path.join(first.targetLocal, 'after-reopen.txt')
  await fs.writeFile(after, 'user changed after response loss')
  const retriedFirst = await service.moveRecords(firstInput)
  check(retriedFirst.applied, first.targetLocal)
  check(retriedFirst.recordMoveOutcome, { status: 'applied', commandId: firstInput.commandId, requestedDirectory: firstInput.directory, directory: first.targetRecords, sourceCleanup: { retained: [] } })
  check(counts, { quiesce: 1, reopen: 1 }); check(await fs.readFile(after, 'utf8'), 'user changed after response loss')
  const secondInput = { ...firstInput, commandId: 'ui-second', directory: path.join(root, 'C'), expectedRevision: current.revision }
  await service.moveRecords(secondInput)
  receipts = (await store.get(recordMoveKey)).receipts
  check(receipts.length, 1); check(receipts[0].commandId, 'ui-second'); check(receipts[0].localCopy, undefined)
  const second = receipts[0], registry = new LocalLocationRegistry(store), locations = await store.get(localLocationRecordKey)
  check(locations.version, 2); check(locations.moves, [])
  check(await registry.resolve(second.targetLocal), request.scope)
  await movedError(registry, request.sourceLocal, first.targetLocal)
  await movedError(registry, first.targetLocal, second.targetLocal)
  check(existsSync(path.join(request.sourceLocal, 'archives/task/records.md')), false)
  const retriedSecond = await service.moveRecords(secondInput)
  check(retriedSecond.applied, second.targetLocal)
  check(retriedSecond.recordMoveOutcome, { status: 'applied', commandId: secondInput.commandId, requestedDirectory: secondInput.directory, directory: second.targetRecords, sourceCleanup: { retained: [] } })
  check(counts, { quiesce: 2, reopen: 2 })
  {
    const writes = store.set.bind(store); let actualWrites = 0
    store.set = async (...args) => { actualWrites++; return writes(...args) }
    try {
      const late = await service.moveRecords(firstInput)
      check(late.recordMoveOutcome, { status: 'current-location', commandId: firstInput.commandId, requestedDirectory: firstInput.directory, directory: path.join(root, 'C') })
      // Settings changed without this command ever being admitted is a current
      // observation too, even if its requested target happens to match today.
      const neverAdmitted = await service.moveRecords({ ...firstInput, commandId: 'never-admitted', directory: path.join(root, 'C') })
      check(neverAdmitted.recordMoveOutcome.status, 'current-location')
      check(neverAdmitted.recordMoveOutcome.directory, path.join(root, 'C'))
      check(neverAdmitted.recordMoveOutcome.commandId, 'never-admitted')
      check(counts, { quiesce: 2, reopen: 2 }); check(actualWrites, 0)
      const nativeView = store.storageView.bind(store)
      store.storageView = () => { throw new Error('controlled current-directory read failure') }
      try { await rejects(() => service.moveRecords(firstInput), /current-directory read failure/) }
      finally { store.storageView = nativeView }
      const hostView = service.view
      service.view = async () => { throw new Error('controlled current-view read failure') }
      try { await rejects(() => service.moveRecords(firstInput), /current-view read failure/) }
      finally { service.view = hostView }
      check(actualWrites, 0)
    } finally { store.set = writes }
  }
  check(store.storageView().directory, path.join(root, 'C'))

  // Real process termination at existing durable transition boundaries. No
  // exception/finally stand-in and no in-memory fixture pretends to be durable.
  const coldCases = [
    ...['prepared', 'copy-owned', 'published', 'reopening', 'location-retired', 'applied'].map(phase => ({ phase, legacy: false })),
    ...['prepared', 'published', 'reopening'].map(phase => ({ phase, legacy: true })),
  ]
  for (const { phase, legacy } of coldCases) {
    const root = path.join(base, (legacy ? 'legacy-cold-' : 'cold-') + phase), fixture = await seed(root)
    await fixtures.at(-1).close()
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', root, phase], { encoding: 'utf8',
      env: { ...process.env, DSS_TEST_USE_BASELINE: legacy ? '1' : '0' } })
    check(child.signal, 'SIGKILL', child.stderr || child.stdout); processInterruptions++
    const store = await open(root), before = (await store.get(recordMoveKey)).receipts[0]
    check(before.commandId, 'cold-move')
    if (phase === 'copy-owned') check(Object.keys(before.localCopy.owned).length > 1, true)
    const mover = new FrameworkRecordMove(store, store, lifecycle(store))
    await mover.resumePending(signal())
    const receipt = await mover.receipt('cold-move')
    check(receipt.phase, 'applied'); check(receipt.localCopy, undefined)
    check((await store.get(localLocationRecordKey)).moves, [])
    check(await new LocalLocationRegistry(store).resolve(receipt.targetLocal), fixture.request.scope)
    await movedError(new LocalLocationRegistry(store), fixture.request.sourceLocal, receipt.targetLocal)
    check(await fs.readFile(path.join(receipt.targetLocal, 'archives/task/records.md'), 'utf8'), 'original controlled archive\n')
    check(await fs.readFile(path.join(receipt.targetLocal, 'after-reopen.txt'), 'utf8'), 'legitimate new write after publication')
  }

  // UNKNOWN means either a rejected write or a committed write whose caller
  // did not receive acknowledgement. Close/reopen reads actual durable state.
  for (const phase of ['reopening', 'location-retired']) for (const timing of ['before', 'after']) {
    const root = path.join(base, 'unknown-' + phase + '-' + timing), fixture = await seed(root)
    const set = fixture.store.set.bind(fixture.store)
    let hit = false
    fixture.store.set = async (key, value) => {
      const matches = phase === 'reopening'
        ? key === recordMoveKey && value.receipts.some(receipt => receipt.commandId === 'uncertain-move' && receipt.phase === 'reopening')
        : key === localLocationRecordKey && value.version === 2 && value.moves.length === 0
      if (matches && !hit) {
        hit = true
        if (timing === 'after') await set(key, value)
        throw new Error('controlled uncertain ' + phase + '-' + timing)
      }
      return set(key, value)
    }
    await rejects(() => new FrameworkRecordMove(fixture.store, fixture.store, lifecycle(fixture.store)).run('uncertain-move', fixture.request, signal()), /not confirmed|outcome is unknown/)
    check(hit, true)
    fixture.store.set = set
    await fixtures.at(-1).close()
    const store = await open(root), retained = (await store.get(recordMoveKey)).receipts[0]
    check(retained.phase, phase === 'reopening' && timing === 'before' ? 'published' : 'reopening')
    if (phase === 'reopening' && timing === 'before') check(Object.keys(retained.localCopy.owned).length > 1, true)
    if (phase === 'location-retired') check((await store.get(localLocationRecordKey)).moves.length, timing === 'before' ? 1 : 0)
    const mover = new FrameworkRecordMove(store, store, lifecycle(store))
    await mover.resumePending(signal())
    const result = await mover.receipt('uncertain-move')
    check(result.phase, 'applied'); check(result.localCopy, undefined)
    check((await store.get(localLocationRecordKey)).moves, [])
    check(await new LocalLocationRegistry(store).resolve(result.targetLocal), fixture.request.scope)
  }

  // Old producer: the exact v1 value contains both an earlier applied move
  // and the next prepared/published move. Current continuation must keep both
  // the old path bindings and the unfinished command's copy responsibility.
  for (const phase of ['prepared', 'published']) {
    const root = path.join(base, 'legacy-mixed-' + phase)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--legacy-mixed', root, phase], { encoding: 'utf8' })
    check(child.signal, 'SIGKILL', child.stderr || child.stdout); processInterruptions++
    const store = await open(root), old = await store.get(localLocationRecordKey), info = await json(path.join(root, 'legacy-result.json'))
    check(old.version, 1); check(old.moves.map(move => move.phase), ['applied', phase])
    const mover = new FrameworkRecordMove(store, store, lifecycle(store))
    await mover.resumePending(signal())
    const current = await mover.receipt('legacy-second'), registry = new LocalLocationRegistry(store)
    check(current.phase, 'applied'); check((await store.get(localLocationRecordKey)).moves, [])
    check(await registry.resolve(current.targetLocal), info.first.scope)
    await movedError(registry, info.first.sourceLocal, info.first.targetLocal)
    await movedError(registry, info.first.targetLocal, current.targetLocal)
  }

  // Existing historical data is emitted by both exact pre-change producers.
  assert(baseline && path.isAbsolute(baseline), 'DSS_RECORD_MOVE_BASELINE_DIR is required for verified legacy coverage')
  const legacyRoot = path.join(base, 'legacy')
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--legacy', legacyRoot], { encoding: 'utf8' })
  check(child.status, 0, child.stderr || child.stdout)
  const legacy = await open(legacyRoot), history = await json(path.join(legacyRoot, 'legacy-result.json'))
  const beforeLocations = await legacy.get(localLocationRecordKey)
  check(beforeLocations.version, 1); check(beforeLocations.moves.length, 2)
  check((await legacy.get(recordMoveKey)).receipts.length, 2)
  await new FrameworkRecordMove(legacy, legacy, lifecycle(legacy)).resumePending(signal())
  const compacted = await legacy.get(localLocationRecordKey)
  check(compacted.version, 2); check(compacted.moves, []); check(compacted.bindings, beforeLocations.bindings)
  check((await legacy.get(recordMoveKey)).receipts.map(row => row.commandId), ['legacy-second'])
  check((await legacy.get(recordMoveKey)).receipts[0].localCopy, undefined)
  const selected = new LocalLocationRegistry(legacy)
  check(await selected.resolve(history.second.targetLocal), history.first.scope)
  await movedError(selected, history.first.sourceLocal, history.first.targetLocal)
  await movedError(selected, history.second.sourceLocal, history.second.targetLocal)
  // Unknown unrelated legacy rows are preserved. They do not become a new
  // startup/read condition for independently valid current or fresh locations.
  const malformed = structuredClone(beforeLocations)
  malformed.moves.push(null); malformed.bindings[path.join(base, 'unrelated-malformed')] = { state: 'invalid' }
  await legacy.set(localLocationRecordKey, malformed)
  await new FrameworkRecordMove(legacy, legacy, lifecycle(legacy)).resumePending(signal())
  check(await legacy.get(localLocationRecordKey), malformed)
  check(await selected.resolve(history.second.targetLocal), history.first.scope)
  const independent = path.join(base, 'independent')
  check(await selected.resolve(independent), JSON.stringify(['local', independent]))

  // Known completed housekeeping may lose a write acknowledgement. It cannot
  // gate normal admission or touch any unfinished operation's copy evidence.
  await legacy.set(localLocationRecordKey, beforeLocations)
  const nativeSet = legacy.set.bind(legacy), nativeError = console.error, errors = []
  legacy.set = async (key, value) => { if (key === localLocationRecordKey) throw new Error('controlled completed-config write failure'); return nativeSet(key, value) }
  console.error = (...args) => errors.push(args)
  try { await new FrameworkRecordMove(legacy, legacy, lifecycle(legacy)).resumePending(signal()) }
  finally { legacy.set = nativeSet; console.error = nativeError }
  check(errors.some(args => args[1]?.cause?.message === 'controlled completed-config write failure'), true)
  check(await legacy.get(localLocationRecordKey), beforeLocations)
  console.log(JSON.stringify({ status: 'passed', assertions, processInterruptions, proposedService: proposedService ?? null, baselineHashes, ...evidence(),
    limits: 'Actual current adapter/record move/location registry and recovered rc.5 SDK, real cloud Linux files and SIGKILL. Actual service moveRecords body with explicit unrelated Host/view ports; retained UI input replay is covered, not browser rendering or full native Host. No Windows, user data, deployment or real power-loss claim.' }, null, 2))
} finally {
  await Promise.allSettled(fixtures.map(fixture => fixture.close()))
  hooks.deregister()
  await fs.rm(base, { recursive: true, force: true })
}
