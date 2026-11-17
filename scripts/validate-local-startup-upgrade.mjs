import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

// Execute real source and disposable SQLite/physical files. Fixture creation
// uses the original v44 Local worker. No actual DSH, model, Windows, power loss,
// production switch, package build, user records or Git operations are involved.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const schema = `const schema = new Proxy(function () {}, { get(_t,k){if(k==='parse')return v=>v;return schema},apply(){return schema} }); export const z=schema;`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'koffi') return { url: new URL('./helpers/fixture-no-replace-koffi.mjs', import.meta.url).href, shortCircuit: true }
    if (specifier === 'zod') return { url: 'data:text/javascript;base64,' + Buffer.from(schema).toString('base64'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), hash(source))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { materializeLegacyLocalFiles, localStartupUpgradeKey, inspectLocalStartupUpgrade, inspectLegacyLocalInventory, readLegacyLocalOriginal } = await import('../src/framework/local-startup-upgrade.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { localFilesWorkerSource, historicalProducer } = await import('./test-support/historical-v44/load-sql-producer.mjs')
class DiskRecords {
  constructor(root) { this.records = new LocalRecordFiles(path.join(root, 'startup-records')); this.key = localStartupUpgradeKey(path.join(root, 'files')); this.writes = 0 }
  async get(key) { if(key !== this.key) return undefined; const bytes = await this.records.read('operation.json'); return bytes === undefined ? undefined : JSON.parse(bytes) }
  async set(key, value) { assert.equal(key, this.key); this.writes++; await this.records.replace('operation.json', JSON.stringify(value)) }
  async list() { throw new Error('Startup must not scan unrelated host records') }
}
if (process.argv[2] === '--crash' || process.argv[2] === '--resume') {
  const root = process.argv[3], phase = process.argv[4]
  const result = await materializeLegacyLocalFiles(path.join(root, 'files'), new DiskRecords(root), {
    onProgress: progress => { if (process.argv[2] === '--crash' && progress.step === phase) process.exit(73) },
  })
  console.log(JSON.stringify(result)); process.exit(0)
}
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-startup-upgrade-'))
const heldSources = []
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (work, expected) => { await assert.rejects(work, expected); assertions++ }
const run = root => materializeLegacyLocalFiles(path.join(root, 'files'), new DiskRecords(root))
const read = (root, logical) => fs.readFile(path.join(root, 'files', ...logical.split('/')))
const dbPath = root => path.join(root, 'files', 'dss-files.sqlite')
const child = (command, root, phase) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), command, root, ...(phase ? [phase] : [])], { encoding: 'utf8' })
async function seed(name, entries) {
  const root = path.join(sandbox, name); await fs.mkdir(path.join(root, 'files'), { recursive: true })
  const worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath: dbPath(root), writer: true } })
  const requests = new Map(); let sequence = 0, ready, failed
  const startup = new Promise((resolve, reject) => { ready = resolve; failed = reject })
  worker.on('error', failed)
  worker.on('message', message => {
    if (message.startupError) return failed(Error(message.startupError.message))
    if (message.ready) return ready()
    const request = requests.get(message.id)
    if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result)
    requests.delete(message.id)
  })
  try {
    await startup
    await new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject }); worker.postMessage({ id, method: 'commit', args: { changes: entries, dependencies: [], revision: 'fixture' } }) })
  } finally { await worker.terminate() }
  // Keep a fixture connection alive so SQLite retains committed WAL frames
  // while the actual readonly extractor materializes them asynchronously.
  const held = new DatabaseSync(dbPath(root)); held.exec('BEGIN; UPDATE files SET bytes=bytes; COMMIT'); heldSources.push(held)
  return root
}
try {
  const values = [
    { path: 'tasks/active.json', content: '{ "taskId": "active", "status": "waiting" }\r\n' },
    { path: 'task-runs/active/member/Worker/Note.md', content: '\uFEFF原笔记\r\n\u0000keep' },
    { path: 'state/member/active/Planner', content: '' },
    { path: 'conversation/default/2026-11-07/messages.jsonl', content: '{"id":"old-identity","text":"old chat"}\n' },
    { path: 'skills/custom/SKILL.md', content: '# my custom skill\r\nDo not rewrite.\r\n' },
    { path: 'roles/Foreground.md', content: '# Entirely custom guide\r\n' },
    { path: 'archives/old/attachment.bin', bytes: new Uint8Array([0, 0xff, 0xfe, 0, 9]) },
    { path: 'archives/old/empty.bin', bytes: new Uint8Array() },
    { path: 'future-category/unknown.dat', content: 'Unclassified retains its exact logical address.' },
  ]
  const root = await seed('ordinary', values), records = new DiskRecords(root)
  const hashes = [hash(await fs.readFile(dbPath(root))), hash(await fs.readFile(dbPath(root) + '-wal'))]
  const realLink = fs.link; fs.link = async () => { throw new Error('No hardlink-capable filesystem requirement') }
  let result
  check((await inspectLocalStartupUpgrade(path.join(root, 'files'), records)).status, 'incomplete')
  check(records.writes, 0)
  const inventory = await inspectLegacyLocalInventory(path.join(root, 'files'))
  check(inventory.files.length, values.length)
  check(records.writes, 0)
  const pendingFiles = await PhysicalLocalFiles.open(path.join(root, 'files'), { requireExisting: true })
  check(records.writes, 0)
  await pendingFiles.replace('unrelated-while-upgrading.md', 'independent work')
  check(await fs.readFile(path.join(root, 'files', 'unrelated-while-upgrading.md'), 'utf8'), 'independent work')
  await pendingFiles.close()
  check(existsSync(path.join(root, 'files', values[0].path)), false)
  try { result = await materializeLegacyLocalFiles(path.join(root, 'files'), records) } finally { fs.link = realLink }
  check(result.status, 'complete'); check(result.published, values.length); check(result.issues, [])
  for (const value of values) check([...await read(root, value.path)], [...(value.bytes ?? Buffer.from(value.content))])
  check([hash(await fs.readFile(dbPath(root))), hash(await fs.readFile(dbPath(root) + '-wal'))], hashes)
  // Normal physical acquisition does not open or modify the retained SQL.
  // Its source conversion is separately owned by the activated Host's AI.
  const acquired = await PhysicalLocalFiles.open(path.join(root, 'files'), { requireExisting: true })
  await acquired.close()
  const files = await PhysicalLocalFiles.open(path.join(root, 'files'), { requireExisting: true })
  const view = await files.snapshot()
  check(await files.read(view, values[0].path), values[0].content)
  check((await files.listDirectory(view, 'skills/custom')).map(file => file.path), ['skills/custom/SKILL.md'])
  await files.replace(values[0].path, 'physical edit after cutover')
  await files.delete(values[2].path)
  await view.release(); await files.close()
  const savedWrites = records.writes
  result = await materializeLegacyLocalFiles(path.join(root, 'files'), records)
  check(result.status, 'complete'); check(records.writes, savedWrites)
  check(String(await read(root, values[0].path)), 'physical edit after cutover')
  await rejects(() => read(root, values[2].path), { code: 'ENOENT' })

  // The frozen v44 task-files producer initializes Organizer_Note.md for O
  // Tasks. The production AI calls materialize with deferActivation=true, so
  // Task/source/state wait while this actual Note category has been exported.
  // The user can open the physical records folder and edit or delete it there.
  for (const disposition of ['published', 'already-present']) for (const action of ['edit', 'delete']) {
    const taskId = '01234567-89ab-cdef-0123-456789abcdef'
    const note = `task-runs/${taskId}/Organizer_Note.md`
    const taskPath = `tasks/${taskId}.json`
    const state = `state/member/${taskId}/Organizer_Task`
    const oldJson = value => JSON.stringify(value, null, 2) + '\n'
    const partial = await seed('partial-' + disposition + '-' + action, [
      { path: 'tasks/sample_O.md', content: 'Task ID: ' + taskId + '\nOriginal requirement' },
      { path: taskPath, content: oldJson({ version: 1, taskId, route: 'O', sourcePath: 'tasks/sample_O.md', owner: 'member', status: 'running', archiveFolder: 'sample_' + taskId, workspaceFolder: 'sample_' + taskId, members: ['member'] }) },
      { path: note, content: '' },
      { path: `task-runs/${taskId}/Dispatch.md`, content: '' },
      { path: `Recorder Cache/${taskId}/links.json`, content: oldJson({ version: 1, links: [{ kind: 'file', path: 'tasks/sample_O.md' }, { kind: 'file', path: taskPath }, { kind: 'directory', path: `task-runs/${taskId}/` }] }) },
      { path: state, content: '' },
    ])
    const target = path.join(partial, 'files', ...note.split('/'))
    if (disposition === 'already-present') {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, '')
    }
    const partialRecords = new DiskRecords(partial)
    const first = await materializeLegacyLocalFiles(path.join(partial, 'files'), partialRecords, { deferActivation: true })
    check(first.status, 'incomplete')
    const persisted = await partialRecords.get(localStartupUpgradeKey(path.join(partial, 'files')))
    check(persisted.status, 'publishing')
    check(persisted.files.find(file => file.path === note)?.status, disposition)
    if (action === 'edit') {
      await fs.writeFile(target, 'user edit')
    } else await fs.rm(path.dirname(target), { recursive: true })
    const second = await materializeLegacyLocalFiles(path.join(partial, 'files'), partialRecords, { deferActivation: true })
    check(second.status, 'incomplete')
    check(second.operationId, first.operationId)
    check(second.issues.map(issue => [issue.code, issue.path]), [
      ['source-row', state],
      ['source-row', taskPath],
      ['source-row', 'tasks/sample_O.md'],
    ])
    if (action === 'edit') check(await fs.readFile(target, 'utf8'), 'user edit')
    else { check(existsSync(target), false); check(existsSync(path.dirname(target)), false) }
  }

  for (const phase of ['prepared', 'created', 'owned', 'written', 'ready', 'moved', 'published']) {
    const bytes = Buffer.alloc(200_000, 0x5a), root = await seed('crash-' + phase, [{ path: 'tasks/a.bin', bytes }])
    const crashed = child('--crash', root, phase)
    check(crashed.status, 73)
    const stateBefore = await new DiskRecords(root).get(localStartupUpgradeKey(path.join(root, 'files')))
    const resumed = child('--resume', root)
    check(resumed.status, 0)
    const report = JSON.parse(resumed.stdout)
    check(report.operationId, stateBefore.operationId)
    check(report.status, 'complete'); check([...await read(root, 'tasks/a.bin')], [...bytes])
    if (phase === 'created') {
      check(report.retainedStages.length, 1)
      check(stateBefore.files[0].owned, undefined)
      check((await read(root, report.retainedStages[0].path)).length, 0)
    }
    if (phase === 'written') check(stateBefore.files[0].status, 'owned')
    if (phase === 'moved') check(stateBefore.files[0].ready, true)
  }
  // Existing customization and unknown objects never become overwritten defaults.
  const conflictRoot = await seed('custom-conflict', values.slice(0, 2))
  await fs.mkdir(path.join(conflictRoot, 'files', 'tasks'), { recursive: true })
  await fs.writeFile(path.join(conflictRoot, 'files', values[0].path), 'my custom physical data')
  result = await run(conflictRoot)
  check(result.status, 'incomplete'); check(result.published, 1)
  check(result.issues.map(issue => issue.path), [values[0].path])
  check(String(await read(conflictRoot, values[0].path)), 'my custom physical data')
  check(String((await readLegacyLocalOriginal(path.join(conflictRoot, 'files'), values[0].path)).bytes), String(Uint8Array.from(Buffer.from(values[0].content))))
  check(String(await read(conflictRoot, values[1].path)), values[1].content)
  const conflictFiles = await PhysicalLocalFiles.open(path.join(conflictRoot, 'files'), { requireExisting: true })
  await conflictFiles.replace('independent.md', 'independent despite exact conflict')
  check(await fs.readFile(path.join(conflictRoot, 'files', 'independent.md'), 'utf8'), 'independent despite exact conflict')
  await conflictFiles.close()
  const raceRoot = await seed('no-overwrite-race', [{ path: 'existing.md', content: 'SQL original' }])
  result = await materializeLegacyLocalFiles(path.join(raceRoot, 'files'), new DiskRecords(raceRoot), {
    onProgress: async progress => { if (progress.step === 'prepared') await fs.writeFile(path.join(raceRoot, 'files', 'existing.md'), 'concurrent physical custom data') },
  })
  check(result.status, 'incomplete'); check(result.issues[0].code, 'target-conflict')
  check(String(await read(raceRoot, 'existing.md')), 'concurrent physical custom data')

  const identicalRoot = await seed('identical', [{ path: 'existing.md', content: '' }])
  await fs.writeFile(path.join(identicalRoot, 'files', 'existing.md'), '')
  result = await run(identicalRoot); check(result.status, 'complete'); check(result.alreadyPresent, 1)

  const changedRoot = await seed('changed-incomplete', [{ path: 'a.bin', bytes: Buffer.alloc(200_000, 0x6a) }])
  check(child('--crash', changedRoot, 'written').status, 73)
  const changedState = await new DiskRecords(changedRoot).get(localStartupUpgradeKey(path.join(changedRoot, 'files')))
  const changedStage = changedState.files[0].stagePath
  await fs.writeFile(path.join(changedRoot, 'files', changedStage), 'user changed owned partial contents')
  result = await run(changedRoot); check(result.status, 'complete'); check(result.retainedStages.length, 1)
  check(String(await read(changedRoot, changedStage)), 'user changed owned partial contents')
  check((await read(changedRoot, 'a.bin')).length, 200_000)
  const replacedRoot = await seed('replaced-owned', [{ path: 'a.bin', bytes: Buffer.alloc(200_000, 0x6a) }])
  check(child('--crash', replacedRoot, 'owned').status, 73)
  const replacedState = await new DiskRecords(replacedRoot).get(localStartupUpgradeKey(path.join(replacedRoot, 'files')))
  await fs.rename(path.join(replacedRoot, 'files', replacedState.files[0].stagePath), path.join(replacedRoot, 'files', 'preserved-partial.bin'))
  await fs.writeFile(path.join(replacedRoot, 'files', 'a.bin'), 'replacement')
  result = await run(replacedRoot); check(result.status, 'incomplete'); check(result.issues[0].code, 'target-conflict')
  check(String(await read(replacedRoot, 'a.bin')), 'replacement')

  const unsafeRoot = await seed('unsafe', [{ path: 'linked/secret.txt', content: 'must not escape' }, { path: 'safe.txt', content: 'safe independent row' }])
  const elsewhere = path.join(sandbox, 'unrelated'); await fs.mkdir(elsewhere)
  await fs.symlink(elsewhere, path.join(unsafeRoot, 'files', 'linked'))
  result = await run(unsafeRoot); check(result.status, 'incomplete'); check(result.issues[0].code, 'unsafe-target')
  check(await fs.readdir(elsewhere), []); check(String(await read(unsafeRoot, 'safe.txt')), 'safe independent row')
  const badRoot = await seed('invalid-row', [{ path: 'good.txt', content: 'keep' }])
  const badDb = new DatabaseSync(dbPath(badRoot))
  badDb.prepare('INSERT INTO files(path,content,version,bytes,binary) VALUES(?,?,?,?,?)').run('../escape', 'not safe', 'v', 8, null)
  badDb.close()
  result = await run(badRoot); check(result.status, 'incomplete'); check(result.issues[0].code, 'source-row')
  check(String(await read(badRoot, 'good.txt')), 'keep'); check(existsSync(path.join(badRoot, 'escape')), false)

  // Early schema without BLOB is opened read-only and never ALTERed.
  const oldRoot = path.join(sandbox, 'legacy-no-binary'); await fs.mkdir(path.join(oldRoot, 'files'), { recursive: true })
  const old = new DatabaseSync(dbPath(oldRoot)); old.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL) STRICT')
  old.prepare('INSERT INTO files VALUES(?,?,?,?)').run('conversation/original.txt', '\uFEFFlegacy\r\n', 'v', Buffer.byteLength('\uFEFFlegacy\r\n')); old.close()
  const oldHash = hash(await fs.readFile(dbPath(oldRoot)))
  result = await run(oldRoot); check(result.status, 'complete'); check(String(await read(oldRoot, 'conversation/original.txt')), '\uFEFFlegacy\r\n')
  check(hash(await fs.readFile(dbPath(oldRoot))), oldHash)
  const noRoot = path.join(sandbox, 'never-created')
  const emptyRecords = { get: async () => undefined, set: async () => { throw new Error('No migration state for a fresh physical root') }, list: async () => [] }
  result = await materializeLegacyLocalFiles(noRoot, emptyRecords); check(result.status, 'not-needed'); check(existsSync(noRoot), false)
  await rejects(() => materializeLegacyLocalFiles(noRoot, emptyRecords, { requireExisting: true }), /existing Local directory/)
  const orphanRoot = path.join(sandbox, 'orphan'); await fs.mkdir(orphanRoot); await fs.writeFile(path.join(orphanRoot, 'dss-files.sqlite-wal'), 'unclaimed')
  result = await materializeLegacyLocalFiles(orphanRoot, emptyRecords); check(result.status, 'incomplete'); check(result.issues[0].code, 'source-missing')
  const cancelled = new AbortController(); cancelled.abort(Error('test cancellation'))
  await rejects(() => materializeLegacyLocalFiles(noRoot, emptyRecords, { signal: cancelled.signal }), /test cancellation/)

  const mutatingRoot = await seed('source-commit-during-export', [{ path: 'original.txt', content: 'original' }])
  const mutator = new DatabaseSync(dbPath(mutatingRoot)); let changed = false
  try {
    result = await materializeLegacyLocalFiles(path.join(mutatingRoot, 'files'), new DiskRecords(mutatingRoot), { onProgress: progress => {
      if (progress.step === 'written' && !changed) { changed = true; mutator.prepare('INSERT INTO files(path,content,version,bytes,binary) VALUES(?,?,?,?,?)').run('late.txt', 'late', 'fixture', 4, null) }
    } })
  } finally { mutator.close() }
  check(result.status, 'incomplete'); check(result.issues[0].code, 'source-changed')
  check(existsSync(path.join(mutatingRoot, 'files', 'late.txt')), false)
  result = await run(mutatingRoot); check(result.status, 'complete'); check(String(await read(mutatingRoot, 'late.txt')), 'late')

  const sharedRoot = await seed('shared-startup', [{ path: 'active-task.json', content: 'same startup operation' }]), shared = new DiskRecords(sharedRoot)
  const sharedResults = await Promise.all([materializeLegacyLocalFiles(path.join(sharedRoot, 'files'), shared), materializeLegacyLocalFiles(path.join(sharedRoot, 'files'), shared)])
  check(sharedResults[0].operationId, sharedResults[1].operationId); check(sharedResults.map(result => result.status), ['complete', 'complete'])
  console.log(JSON.stringify({ status: 'passed', assertions, platform: process.platform, runtime: process.version,
    coverage: ['actual-v44-worker-source', 'committed-wal-bytes-retained', 'exact-text-binary-empty-signal', 'unknown-safe-logical-path', 'physical-customization-preserved', 'fresh-process-stop-at-seven-boundaries', 'owned-partial-prefix-continuation', 'unowned-stage-create-gap-continues-without-business-target', 'atomic-no-replace-real-linux-syscall', 'no-hardlink', 'concurrent-target-create-never-overwritten', 'source-commit-before-cutover-detected', 'readonly-inspection-never-materializes', 'ordinary-acquisition-independent-of-conversion-and-target-conflict', 'no-symlink-escape', 'invalid-source-row-retained', 'physical-read-edit-and-user-deletion-after-cutover', 'completed-export-user-edit-delete-during-deferred-activation', 'shared-one-time-operation', 'missing-source-and-sidecar-not-empty-success', 'old-no-binary-schema'],
    limits: 'Controlled Linux fixtures and source acquisition seam, not native DSH startup wiring, AI semantic upgrade, production default switch, Windows, power-loss durability, dependency-backed full typecheck, build, package or real user database.',
    historicalProducer, sourceHashes: Object.fromEntries([...loaded].sort()), scriptHash: hash(readFileSync(fileURLToPath(import.meta.url))) }, null, 2))
} finally { for (const source of heldSources) source.close(); hooks.deregister(); await fs.rm(sandbox, { recursive: true, force: true }) }
