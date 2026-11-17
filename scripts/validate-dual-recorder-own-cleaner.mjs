import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
// Actual installed Zod, Markdown, YAML and SDK modules; only the native Agent
// registration surface is controlled. No publication
// leaves this process. Initialization, completion, save, reads and Cleaner use
// production implementations. Local files are disposable Linux fixtures.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
    const source = readFileSync(new URL(url), 'utf8'); loaded.set(url.slice(sourceRoot.href.length), hash(source))
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
} })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { FrameworkCleaner } = await import('../src/framework/cleaner.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { initializeTask, paths, encodeJson, readJson, taskLifecycleKey, taskWorkingRoots } = await import('../src/framework/task-files.ts')
const { taskReference } = await import('../src/framework/published-references.ts')
const { physicalRecorderPendingPath } = await import('../src/framework/physical-recorder-publication.ts')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-dual-recorder-cleaner-'))
const checks = [], opened = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
let sequence = 0
function toolsFor(f, task, role = 'Recorder') {
  const tools = new Map(), agent = { id: role + '-' + ++sequence, session: {} }
  const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
  installFrameworkRoleTools(ctx, agent, { role, owner: task?.owner ?? 'A', ...(task ? { taskId: task.taskId, lifecycleId: task.lifecycleId, ...(role === 'Planner' ? { member: task.owner } : {}) } : {}), workId: 'work-' + sequence, executionId: 'execution-' + sequence },
    { files: f.files, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => { throw error },
      transact: (...args) => f.tx.run(...args) })
  return { call: (name, input, callId = 'call-' + ++sequence) => tools.get(name).execute(input, { agent, callId, signal: new AbortController().signal, concludeTurn() {} }) }
}
async function fixture(name) {
  const files = new PhysicalLocalFiles(path.join(scratch, name)); opened.push(files)
  const rows = new Map(), records = { get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)), delete: async key => rows.delete(key), list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }
  const tx = new FrameworkTransactions(files, records, 'local-' + name)
  const set = async (target, value) => { if (value === undefined) await files.delete(target); else await files.replace(target, value) }
  const apply = async changes => { for (const change of changes) await set(change.path, change.content === null ? undefined : change.bytes ?? change.content) }
  const f = { mode: 'local', name, files, tx, records, set, apply }
  const id = '10000000-0000-4000-8000-' + hash('local' + name).slice(0, 12), source = 'tasks/' + name + '_P.md'
  await set(source, 'Original requirement for ' + name + '\n')
  await apply((await withSnapshot(files, s => initializeTask(files, s, source, 'A', ['A'], id))).changes)
  f.task = await withSnapshot(files, s => readJson(files, s, paths.task(id)))
  f.original = await withSnapshot(files, s => files.read(s, source))
  f.material = paths.run(id) + '/evidence.txt'; f.unselected = paths.run(id) + '/unselected.txt'
  await set(f.material, 'Selected evidence\r\n'); await set(f.unselected, 'Do not keep this unselected temporary text')
  return f
}
async function complete(f, task, resultPaths) {
  const role = toolsFor(f, task, task.route === 'O' ? 'Organizer' : 'Planner'), view = await role.call('dss_snapshot', {})
  await role.call('dss_complete', { snapshotId: view.snapshotId, acceptance: 'Controlled fixture completed actual acceptance entry.', resultPaths })
  check(f.mode + ' actual completion ' + task.taskId, (await withSnapshot(f.files, s => readJson(f.files, s, paths.task(task.taskId)))).status, 'complete')
}
const read = (f, target) => withSnapshot(f.files, s => f.files.read(s, target))

// Both total Tasks share one real Local store and the existing same-file skill
// mutation queue. Only already-issued skill renames are paused; the production
// scheduler/publication/cleanup code has no added gate or global barrier.
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const firstRename = defer(), secondQueued = defer(), secondRename = defer(), releaseFirst = defer(), releaseSecond = defer()
const events = [], pendingSaves = []
const nativeRename = fs.rename
let originalUpdate, files, host
async function bounded(promise, name, ms = 5000) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Test observation deadline: ' + name)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function secondTask(first) {
  const name = 'second-total-task', id = '30000000-0000-4000-8000-' + hash(name).slice(0, 12), source = 'tasks/' + name + '_P.md'
  await first.set(source, 'Independent second total Task original requirement\n')
  await first.apply((await withSnapshot(first.files, snapshot => initializeTask(first.files, snapshot, source, 'A', ['A'], id))).changes)
  const task = await withSnapshot(first.files, snapshot => readJson(first.files, snapshot, paths.task(id)))
  const f = { ...first, name, task, original: await read(first, source), material: paths.run(id) + '/evidence.txt', unselected: paths.run(id) + '/unselected.txt' }
  await f.set(f.material, 'Second Task working evidence'); await f.set(f.unselected, 'Second Task temporary material')
  return f
}
const readOwnRequirement = async f => {
  const foreground = toolsFor(f, undefined, 'Foreground'), view = await foreground.call('dss_snapshot', {})
  return foreground.call('dss_read', { snapshotId: view.snapshotId, path: taskReference(f.task.taskId, f.task.sourcePath) })
}
try {
  const one = await fixture('first-total-task'), two = await secondTask(one); files = one.files
  check('Two initialized Tasks are separate total roots', [one.task.parent, two.task.parent, one.task.taskId === two.task.taskId], [undefined, undefined, false])
  const skill = 'skills/dual-recorder/SKILL.md'
  const baseSkill = '---\nname: dual-recorder\ndescription: Controlled independent Recorder contributions\n---\n# Shared skill\n\nFirst contribution: original.\n\nStable common instruction.\nKeep the original source facts.\nUse the task-specific result.\n\nSecond contribution: original.\n'
  const proposalOne = baseSkill.replace('First contribution: original.', 'First contribution: R1 verified.'), proposalTwo = baseSkill.replace('Second contribution: original.', 'Second contribution: R2 verified.')
  await one.set(skill, baseSkill)
  for (const f of [one, two]) { await complete(f, f.task, []); f.task = await withSnapshot(files, snapshot => readJson(files, snapshot, paths.task(f.task.taskId))) }
  const r1 = toolsFor(one, one.task), r2 = toolsFor(two, two.task), v1 = await r1.call('dss_snapshot', {}), v2 = await r2.call('dss_snapshot', {})
  const b1 = await r1.call('dss_read', { snapshotId: v1.snapshotId, path: skill }), b2 = await r2.call('dss_read', { snapshotId: v2.snapshotId, path: skill })
  check('Both actual Recorder tools read the same original skill text', [b1.text, b2.text], [baseSkill, baseSkill])
  check('Each Recorder holds its own full-read base identity', [typeof b1.baseReadId, typeof b2.baseReadId], ['string', 'string'])
  const input = (f, view, text, baseReadId) => ({ snapshotId: view.snapshotId, outputs: [
    { path: paths.archive(f.task) + '/records.md', text: 'Independent long-term result. [Selected own requirement](' + f.task.sourcePath + ')' },
    { path: skill, text, baseReadId }
  ], retainedPaths: [] })
  let updateCalls = 0, renameCalls = 0, r2Finished = false
  originalUpdate = files.update.bind(files)
  files.update = (target, ...args) => { if (target === skill && ++updateCalls === 2) { events.push('R2 entered existing skill queue'); secondQueued.resolve() }; return originalUpdate(target, ...args) }
  fs.rename = async (from, to) => {
    if (String(to) === path.join(files.directory, skill)) {
      renameCalls++
      if (renameCalls === 1) { events.push('R1 issued first skill rename'); firstRename.resolve(); await releaseFirst.promise }
      else if (renameCalls === 2) { events.push('R2 issued second skill rename'); secondRename.resolve(); await releaseSecond.promise }
    }
    return nativeRename(from, to)
  }
  const savingOne = r1.call('dss_recorder_save', input(one, v1, proposalOne, b1.baseReadId)).then(result => { events.push('R1 saved'); return result }); pendingSaves.push(savingOne)
  await bounded(firstRename.promise, 'R1 actual skill rename')
  const savingTwo = r2.call('dss_recorder_save', input(two, v2, proposalTwo, b2.baseReadId)).then(result => { r2Finished = true; events.push('R2 saved'); return result }); pendingSaves.push(savingTwo)
  await bounded(secondQueued.promise, 'R2 entered original same-file queue')
  check('Neither Recorder sends Cleaner before its own skill finishes', [await read(one, paths.state('A', one.task.taskId) + '/Cleaner'), await read(two, paths.state('A', two.task.taskId) + '/Cleaner')], [undefined, undefined])
  releaseFirst.resolve(); await bounded(secondRename.promise, 'R2 actual skill rename')
  const resultOne = await bounded(savingOne, 'R1 finishes while R2 original rename is pending')
  check('R1 final handoff finishes independently', resultOne.saved, true)
  check('R2 remains in its original unfinished save', r2Finished, false)
  check('Only R1 has its own actual Cleaner signal', [await read(one, paths.state('A', one.task.taskId) + '/Cleaner'), await read(two, paths.state('A', two.task.taskId) + '/Cleaner')], ['', undefined])
  const pendingPath = physicalRecorderPendingPath(two.task.taskId), pending = JSON.parse(await read(two, pendingPath))
  const output = pending.outputs.find(value => value.path === skill), outputId = output.commandId ?? pending.commandId
  const stage = paths.run(two.task.taskId) + '/.recorder-handoff/' + hash(outputId), originalInput = stage + '/inputs/' + hash(skill) + '.json', originalAttempt = stage + '/skill-results/' + hash(skill) + '.json'
  const protectedPaths = [pendingPath, originalInput, originalAttempt, paths.task(two.task.taskId), two.task.sourcePath, two.material, two.unselected, paths.cache(two.task.taskId), paths.state('A', two.task.taskId) + '/Recorder']
  const before = new Map()
  for (const target of protectedPaths) { const text = await read(two, target); check('R2 actual generated input exists before C1: ' + target, typeof text, 'string'); before.set(target, text) }
  check('R2 accepted original attempt is not falsely complete', JSON.parse(before.get(originalAttempt)).result, undefined)
  const skillBeforeC1 = await read(one, skill)
  const errors = [], cleaner = new FrameworkCleaner(files, one.tx)
  host = new FrameworkHostLoop(files, one.tx, one.records, { scope: 'shared-two-total-tasks', member: 'A', primary: true, instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, () => ['A'], {
    observe: async () => {}, executing: () => false, wake: async () => false, sealBusiness: async () => {}, releaseTask: async () => {}, error: error => errors.push(error),
    clean: async (task, _snapshot, observation) => { const result = await cleaner.clean(task, observation); events.push('Cleaner finished ' + task.taskId); return result.status === 'released' }
  })
  const cleanOwn = async f => {
    await withSnapshot(files, snapshot => host.scanTask(f.task, snapshot, performance.now()))
    // The scan records C's exact responsibility; Host resumes Cleaner only
    // after its separate native-release operation settles.
    const key = taskLifecycleKey(f.task), deadline = performance.now() + 5000
    while (true) {
      if (errors.length) throw new AggregateError(errors)
      if (await host.taskReleased(f.task.taskId, f.task.lifecycleId)) return
      if (performance.now() >= deadline) throw new Error('Own Host/Cleaner did not finish: ' + key)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  await bounded(cleanOwn(one), 'C1 uses actual Host and Cleaner while R2 rename remains pending', 8000); events.push('C1 done')
  for (const root of taskWorkingRoots(one.task)) check('C1 removes only R1 fixed root: ' + root, await files.entryInfo(root), undefined)
  check('C1 removes R1 runtime metadata and source', [await read(one, paths.task(one.task.taskId)), await read(one, one.task.sourcePath)], [undefined, undefined])
  for (const [target, text] of before) check('C1 preserves R2 exact pending/working bytes: ' + target, await read(two, target), text)
  check('C1 neither completes R2 nor creates C2', [r2Finished, await read(two, paths.state('A', two.task.taskId) + '/Cleaner')], [false, undefined])
  check('C1 preserves shared live skill exactly', await read(one, skill), skillBeforeC1)
  check('R1 explicitly linked source remains readable after C1', (await readOwnRequirement(one)).text, one.original)
  check('R1 archive remains visible while R2 is unfinished', typeof await read(one, paths.archive(one.task) + '/records.md'), 'string')
  releaseSecond.resolve(); const resultTwo = await bounded(savingTwo, 'R2 resumes its original accepted save')
  check('R2 completes its own final handoff', resultTwo.saved, true)
  check('R2 emits its own Cleaner only after its skill completes', await read(two, paths.state('A', two.task.taskId) + '/Cleaner'), '')
  check('Actual same-file merge preserves both nonoverlapping contributions', await read(one, skill), baseSkill.replace('First contribution: original.', 'First contribution: R1 verified.').replace('Second contribution: original.', 'Second contribution: R2 verified.'))
  await bounded(cleanOwn(two), 'C2 uses its own actual Host and Cleaner', 8000); events.push('C2 done')
  for (const root of taskWorkingRoots(two.task)) check('C2 removes R2 fixed root: ' + root, await files.entryInfo(root), undefined)
  check('C2 removes R2 runtime metadata and source', [await read(two, paths.task(two.task.taskId)), await read(two, two.task.sourcePath)], [undefined, undefined])
  for (const f of [one, two]) {
    check('Each linked original is usable after both Cleaners: ' + f.name, (await readOwnRequirement(f)).text, f.original)
    const retained = JSON.parse(await read(f, paths.archive(f.task) + '/retention.json'))
    check('Each Recorder retains only its own selected original: ' + f.name, Object.keys(retained.relocatedReferences), [f.task.sourcePath])
    check('Each archive remains after both Cleaners: ' + f.name, typeof await read(f, paths.archive(f.task) + '/records.md'), 'string')
  }
  check('C2 leaves the shared merged skill available', (await read(one, skill)).includes('R1 verified.') && (await read(one, skill)).includes('R2 verified.'), true)
  check('R1/C1 finish before R2/C2 without a shared completion barrier', events.indexOf('R1 saved') < events.indexOf('C1 done') && events.indexOf('C1 done') < events.indexOf('R2 saved') && events.indexOf('R2 saved') < events.indexOf('C2 done'), true)
  check('Host/Cleaner report no errors', errors, [])
  console.log(JSON.stringify({ passed: checks.length, checks, events, actualEntryPoints: ['initializeTask', 'registered dss_complete', 'independent Recorder dss_snapshot/dss_read/baseReadId', 'registered concurrent dss_recorder_save', 'existing same-skill update queue and fs.rename', 'FrameworkHostLoop.scanTask', 'FrameworkCleaner.clean', 'independent Foreground dss_read(taskReference)'], sourceHashes: Object.fromEntries(loaded), limits: [
    'Two real total Task metadata/terminal publications in one Linux PhysicalLocalFiles root, actual installed Zod/Markdown/YAML/SDK. Native Agent registration and empty native resource-release callbacks are explicit controlled ports; no model execution or native shutdown claimed.',
    'Pause points are the first and second actually issued rename of the existing shared skill. R2 enters the production same-file update queue; no synthetic global wait, extra signal or production change.',
    'This checks Local same-process concurrency only, not Git/multi-machine/Windows behavior. Earlier core Local/Git retention checks are separate.',
    'Five-/eight-second timers bound failed test observations only and are not product timeouts. Old successful Recorder snapshots are not reused after handoff; independent Foreground tools verify retained references.'
  ] }, null, 2))
} finally {
  releaseFirst.resolve(); releaseSecond.resolve(); await Promise.allSettled(pendingSaves)
  fs.rename = nativeRename; if (files && originalUpdate) files.update = originalUpdate
  if (host) await host.stop(); await Promise.allSettled(opened.map(value => value.close())); hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true })
}
