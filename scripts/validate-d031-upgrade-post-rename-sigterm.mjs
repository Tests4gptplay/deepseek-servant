import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { Worker } from 'node:worker_threads'

// The real production Local publisher uses Koffi's Linux renameat2 with
// RENAME_NOREPLACE. Only the JS/TS import bridge is installed here.
const sourceRoot = new URL('../src/', import.meta.url)
const oldTaskRoot = new URL('./test-support/historical-v44/conversation-producer/src/', import.meta.url)
const hashes = new Map()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && (context.parentURL?.startsWith(sourceRoot.href) || context.parentURL?.startsWith(oldTaskRoot.href)) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if ((url.startsWith(sourceRoot.href) || url.startsWith(oldTaskRoot.href)) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      hashes.set(url.startsWith(sourceRoot.href) ? url.slice(sourceRoot.href.length) : 'frozen-v44/' + url.slice(oldTaskRoot.href.length), hash(source))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})

const { materializeLegacyLocalFiles, inspectLocalStartupUpgrade, readLegacyLocalOriginal, localStartupUpgradeKey } = await import('../src/framework/local-startup-upgrade.ts')
const { assessLocalUpgradeCompletion } = await import('../src/framework/local-upgrade-completion.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { localFilesWorkerSource, historicalProducer } = await import('./test-support/historical-v44/load-sql-producer.mjs')
const oldTaskManifest = JSON.parse(readFileSync(new URL('./test-support/historical-v44/conversation-producer/SOURCE.json', import.meta.url), 'utf8'))
for (const [name, expected] of Object.entries(oldTaskManifest.files)) {
  assert.equal(hash(readFileSync(new URL(name, new URL('./test-support/historical-v44/conversation-producer/', import.meta.url)))), expected,
    'Frozen v44 Task source: ' + name)
}
const oldTaskProducer = await import(new URL('framework/task-files.ts', oldTaskRoot))
const mode = process.argv[2]
const phase = process.argv[4]
const taskId = '01234567-89ab-cdef-0123-456789abcdef'
// The frozen v44 Helper binding and dss_record path check permit this dated
// report. Unlike Task Note files, no specialized Task restorer owns this path.
const note = 'debug/2026-11-07.md'
const state = `state/member/${taskId}/Organizer_Task`
const taskPath = `tasks/${taskId}.json`

async function pause(detail) {
  process.send?.({ boundary: true, ...detail })
  await new Promise(() => setInterval(() => {}, 1000))
}
class DiskRecords {
  constructor(root) {
    this.root = root
    this.records = new LocalRecordFiles(path.join(root, 'records'))
    this.key = localStartupUpgradeKey(path.join(root, 'files'))
  }
  async get(key) {
    if (key !== this.key) return undefined
    const raw = await this.records.read('upgrade.json')
    return raw === undefined ? undefined : JSON.parse(raw)
  }
  async set(key, value) {
    assert.equal(key, this.key)
    const file = value.files?.find(item => item.path === note && item.status === 'published')
    // Pause before the real durable write. The actual rename has already
    // returned; the parent then sends SIGTERM, not a simulated fs exception.
    if (mode === '--producer' && phase === 'post-rename' && file) await pause({ phase,
      target: path.join(this.root, 'files', ...note.split('/')),
      stage: path.join(this.root, 'files', ...file.stagePath.split('/')),
      fact: path.join(this.root, 'records/upgrade.json'),
    })
    await this.records.replace('upgrade.json', JSON.stringify(value))
  }
  async list() { throw new Error('Startup did not require an unrelated records scan.') }
}

if (mode === '--producer' || mode === '--resume') {
  try {
    const root = process.argv[3]
    const records = new DiskRecords(root)
    const result = await materializeLegacyLocalFiles(path.join(root, 'files'), records, { deferActivation: true,
      onProgress: async progress => {
        if (mode !== '--producer' || phase !== 'pre-rename' || progress.path !== note || progress.step !== 'ready') return
        const prior = await records.get(records.key), file = prior.files.find(item => item.path === note)
        await pause({ phase, target: path.join(root, 'files', ...note.split('/')),
          stage: path.join(root, 'files', ...file.stagePath.split('/')), fact: path.join(root, 'records/upgrade.json') })
      },
    })
    process.send?.({ result })
    process.exit(0)
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.stack : String(error) })
    process.exit(2)
  }
}

let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-d031-'))
const results = []
async function seed(root) {
  await fs.mkdir(path.join(root, 'files'), { recursive: true })
  const worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath: path.join(root, 'files/dss-files.sqlite'), writer: true } })
  const sourcePath = 'tasks/sample_O.md', original = 'Task ID: ' + taskId + '\nOriginal requirement'
  const planned = await oldTaskProducer.initializeTask({
    read: async (_view, requested) => requested === sourcePath ? original : undefined,
    listDirectoryNames: async () => [],
  }, {}, sourcePath, 'member', ['member'])
  assert.equal(planned.value.taskId, taskId)
  assert.deepEqual(new Set(planned.changes.map(change => change.path)), new Set([
    sourcePath, taskPath, `task-runs/${taskId}/Organizer_Note.md`, `task-runs/${taskId}/Dispatch.md`, `Recorder Cache/${taskId}/links.json`, state,
  ]))
  const changes = [...planned.changes, { path: note, content: 'Original Helper report' }]
  try {
    await new Promise((resolve, reject) => {
      worker.on('error', reject)
      worker.on('message', message => {
        if (message.startupError) reject(Error(message.startupError.message))
        else if (message.ready) worker.postMessage({ id: 1, method: 'commit', args: { changes, dependencies: [], revision: 'fixture' } })
        else if (message.id === 1) message.error ? reject(Error(message.error.message)) : resolve()
      })
    })
  } finally { await worker.terminate() }
}
async function child(action, root, boundary, phase = 'post-rename') {
  const cp = fork(fileURLToPath(import.meta.url), [action, root, phase], { silent: true })
  const messages = []
  let stderr = ''
  cp.stderr.on('data', chunk => { stderr += chunk })
  cp.stdout.resume()
  const watchdog = setTimeout(() => cp.kill('SIGKILL'), 30000)
  try {
    return await new Promise((resolve, reject) => {
      cp.on('error', reject)
      cp.on('message', async message => {
        messages.push(message)
        if (message.boundary) {
          try { await boundary(message); check(cp.kill('SIGTERM'), true) }
          catch (error) { cp.kill('SIGTERM'); reject(error) }
        }
      })
      cp.on('exit', (code, signal) => resolve({ code, signal, messages, stderr }))
    })
  } finally { clearTimeout(watchdog) }
}
try {
  for (const disposition of ['none', 'edit', 'delete', 'replace', 'pre-rename-delete']) {
    if (process.env.D031_CASE && process.env.D031_CASE !== disposition) continue
    const root = path.join(scratch, disposition)
    await seed(root)
    const timing = disposition === 'pre-rename-delete' ? 'pre-rename' : 'post-rename'
    let boundary, ownedAtBoundary
    const stopped = await child('--producer', root, async message => {
      boundary = message
      check(message.phase, timing)
      check(existsSync(message.target), timing === 'post-rename')
      check(existsSync(message.stage), timing === 'pre-rename')
      const persisted = JSON.parse(await fs.readFile(message.fact, 'utf8'))
      const published = persisted.files.find(item => item.path === note)
      ownedAtBoundary = published.owned
      check(persisted.status, 'publishing')
      check(published.status, 'owned')
      check(published.ready, true)
      check(published.stagePath !== undefined, true)
      const current = await fs.stat(timing === 'post-rename' ? message.target : message.stage, { bigint: true })
      check(String(current.dev), published.owned.dev)
      check(String(current.ino), published.owned.ino)
      check(String(current.birthtimeNs), published.owned.birthtimeNs)
    }, timing)
    check(stopped.signal, 'SIGTERM')
    check(!!boundary, true)
    if (disposition === 'edit') await fs.writeFile(boundary.target, 'user edit after native folder open')
    else if (disposition === 'delete') await fs.rm(path.dirname(boundary.target), { recursive: true })
    else if (disposition === 'replace') {
      const replacement = boundary.target + '.new'
      await fs.writeFile(replacement, 'user replacement with another inode')
      await fs.rename(replacement, boundary.target)
    } else if (disposition === 'pre-rename-delete') await fs.rm(path.dirname(boundary.stage), { recursive: true })
    if (disposition === 'edit' || disposition === 'replace') {
      const changed = await fs.stat(boundary.target, { bigint: true })
      check(String(changed.dev) === ownedAtBoundary.dev && String(changed.ino) === ownedAtBoundary.ino
        && String(changed.birthtimeNs) === ownedAtBoundary.birthtimeNs, disposition === 'edit')
    }
    const cold = await child('--resume', root)
    check(cold.code, 0)
    const outcome = cold.messages.at(-1)
    check(outcome.error, undefined)
    check(outcome.result.status, 'incomplete')
    const noteIssue = outcome.result.issues.find(issue => issue.path === note)
    const resolved = disposition === 'none' || disposition === 'edit'
    check(noteIssue?.code, resolved ? undefined : 'target-conflict')
    if (!resolved) check(noteIssue.message.includes('unconfirmed'), true)
    check(outcome.result.issues.filter(issue => issue.path !== note).map(issue => [issue.code, issue.path]), [
      ['source-row', state], ['source-row', taskPath], ['source-row', 'tasks/sample_O.md'],
    ])
    const after = await new DiskRecords(root).get(localStartupUpgradeKey(path.join(root, 'files')))
    check(after.status, 'publishing')
    check(after.files.find(item => item.path === note).status, resolved ? 'published' : 'owned')
    const inspection = await inspectLocalStartupUpgrade(path.join(root, 'files'), new DiskRecords(root))
    check(inspection.status, 'incomplete')
    const assessment = await assessLocalUpgradeCompletion(path.join(root, 'files'), new DiskRecords(root))
    check(assessment.report.status, 'incomplete')
    if (!resolved) check(assessment.pending.some(item => item.path === note), true)
    const original = await readLegacyLocalOriginal(path.join(root, 'files'), note)
    check(Buffer.from(original.bytes).toString(), 'Original Helper report')
    if (disposition === 'edit') check(await fs.readFile(boundary.target, 'utf8'), 'user edit after native folder open')
    else if (disposition === 'replace') check(await fs.readFile(boundary.target, 'utf8'), 'user replacement with another inode')
    else if (disposition === 'delete' || disposition === 'pre-rename-delete') { check(existsSync(boundary.target), false); check(existsSync(path.dirname(boundary.target)), false) }
    else check(await fs.readFile(boundary.target, 'utf8'), 'Original Helper report')
    if (!resolved) {
      const retried = await child('--resume', root)
      check(retried.code, 0)
      check(retried.messages.at(-1).result.issues.some(issue => issue.path === note && issue.message.includes('unconfirmed')), true)
      const retained = await new DiskRecords(root).get(localStartupUpgradeKey(path.join(root, 'files')))
      check(retained.status, 'publishing')
      check(retained.files.find(item => item.path === note).status, 'owned')
      if (disposition !== 'replace') check(existsSync(path.dirname(boundary.target)), false)
    }
    results.push({ disposition, stopped: stopped.signal, issueCodes: outcome.result.issues.map(issue => issue.code), noteStatus: resolved ? 'published' : 'owned', sourceRetained: true })
  }
  console.log(JSON.stringify({ status: 'passed', assertions, results, historicalProducer, oldTaskManifest, sourceHashes: Object.fromEntries([...hashes].sort()),
    limits: 'Frozen v44 initializeTask and Worker commit; dated Helper report path checked against frozen v44 role-runtime/role-tools. Actual Linux Koffi renameat2. Controlled pauses locate post-rename/pre-save and pre-rename/ready boundaries, then actual SIGTERM. Disposable files and external edit/delete/replace, not full historical Host, current DSH native UI/model, Windows/macOS, power loss or user incident.' }, null, 2))
} finally { hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
