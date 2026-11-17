import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { hooks, hash, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { localFilesWorkerSource, historicalProducer } from './test-support/historical-v44/load-sql-producer.mjs'

// This exact Note path is emitted by the SHA-verified frozen v44
// taskInitializationFiles for a running O Task. The old SQLite Worker supplies
// the actual original row; this is not a complete original Host invocation.
const note = 'task-runs/10000000-0000-4000-8000-000000000001/Organizer_Note.md'
const body = 'Original authored Organizer note\n'
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { materializeLegacyLocalFiles, localStartupUpgradeKey } = await import('../src/framework/local-startup-upgrade.ts')
const { assessLocalUpgradeCompletion } = await import('../src/framework/local-upgrade-completion.ts')
const { localUpgradeView } = await import('../src/framework/local-upgrade-view.ts')
const { LocalUpgradeStatus } = await import('../src/framework/client-upgrade-status.ts')
const { renderToStaticMarkup } = await import(new URL('../node_modules/react-dom/server.node.js', import.meta.url))

class Records {
  constructor(root) { this.files = new LocalRecordFiles(path.join(root, 'records')) }
  async get(key) { const value = await this.files.read(hash(key) + '.json'); return value === undefined ? undefined : JSON.parse(value) }
  async set(key, value) { await this.files.replace(hash(key) + '.json', JSON.stringify(value)) }
  async list() { throw Error('Addressed disk record test must not scan Host storage') }
}

if (process.argv[2] === '--stop') {
  const root = process.argv[3], phase = process.argv[4]
  await materializeLegacyLocalFiles(path.join(root, 'files'), new Records(root), {
    onProgress: ({ step, path: logical }) => {
      if (phase.startsWith('created') && step === 'created' && logical === note) process.kill(process.pid, 'SIGKILL')
    },
  })
  throw Error('The requested real stop boundary was not reached')
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-d071-ambiguity-'))
const results = []
let assertions = 0
function check(actual, expected, reason) { assert.deepEqual(actual, expected, reason); assertions++ }
async function seed(root) {
  const directory = path.join(root, 'files'); await fs.mkdir(directory, { recursive: true })
  const worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath: path.join(directory, 'dss-files.sqlite'), writer: true } })
  try {
    await new Promise((resolve, reject) => {
      worker.on('error', reject)
      worker.on('message', message => {
        if (message.startupError) reject(Error(message.startupError.message))
        else if (message.ready) worker.postMessage({ id: 1, method: 'commit', args: { changes: [{ path: note, content: body }], dependencies: [], revision: 'old-note' } })
        else if (message.id === 1) message.error ? reject(Error(message.error.message)) : resolve()
      })
    })
  } finally { await worker.terminate() }
  return directory
}
try {
  for (const phase of ['created', 'created-replaced']) {
    const root = path.join(scratch, phase), directory = await seed(root), records = new Records(root)
    const sqlBefore = hash(await fs.readFile(path.join(directory, 'dss-files.sqlite')))
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop', root, phase], { encoding: 'utf8', timeout: 30000, env: process.env })
    check(child.signal, 'SIGKILL', phase + ' truly stopped the process')
    const operation = await records.get(localStartupUpgradeKey(directory)), recorded = operation.files.find(file => file.path === note)
    check(recorded.status, 'prepared', phase + ' was not owned')
    check(recorded.owned, undefined, phase + ' has no durable inode identity')
    check(typeof recorded.stagePath, 'string', phase + ' saved a concrete private path')
    const stage = path.join(directory, recorded.stagePath)
    const producerIdentity = await fs.stat(stage, { bigint: true })
    if (phase === 'created-replaced') {
      // A normal editor can save an empty file by atomic replace after the
      // original stage became visible in the user's physical records folder.
      await fs.writeFile(stage + '.editor-save', '')
      await fs.rename(stage + '.editor-save', stage)
      const replacement = await fs.stat(stage, { bigint: true })
      assert.notDeepEqual([replacement.dev, replacement.ino, replacement.birthtimeNs],
        [producerIdentity.dev, producerIdentity.ino, producerIdentity.birthtimeNs], 'editor replacement did not keep the producer inode')
      assertions++
    }
    check((await fs.readFile(stage)).length, 0, phase + ' has an empty file at the same persisted path')
    const unowned = await fs.stat(stage, { bigint: true })
    const resumed = await materializeLegacyLocalFiles(directory, new Records(root))
    check(resumed.status, 'complete', phase + ' exported the original independently')
    check(await fs.readFile(path.join(directory, note), 'utf8'), body, phase + ' retained original final bytes')
    check((await fs.readFile(stage)).length, 0, phase + ' did not overwrite unowned stage')
    const after = await fs.stat(stage, { bigint: true })
    check([after.dev, after.ino, after.birthtimeNs], [unowned.dev, unowned.ino, unowned.birthtimeNs], phase + ' preserved exact unowned inode')
    const pendingBefore = await assessLocalUpgradeCompletion(directory, records)
    check(pendingBefore.pending.some(item => item.path === recorded.stagePath), true, phase + ' keeps unresolved stage visible to finish')
    const noFinishView = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report: resumed } })
    check(noFinishView.pending?.some(item => item.path === recorded.stagePath) ?? false, true,
      phase + ' projection of retained stage without finish assessment')
    const statusHtml = renderToStaticMarkup(LocalUpgradeStatus({ value: noFinishView, tr: chinese => chinese }))
    check(statusHtml.includes(recorded.stagePath), true, phase + ' actual rendered status exposes stage path only when projected')
    check(statusHtml.includes(resumed.retainedStages[0].reason), true, phase + ' actual rendered status exposes retention reason')
    check(statusHtml.includes('归属待核'), true, phase + ' adds cautious Chinese stage guidance')
    const finishView = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report: resumed, pending: pendingBefore.pending } })
    check(finishView.pending.some(item => item.path === recorded.stagePath), true, phase + ' projects the exact path after finish assessment')
    check(finishView.pending.filter(item => item.path === recorded.stagePath).length, 1, phase + ' does not duplicate existing finish item')
    const runningView = await localUpgradeView(directory, records, {})
    check(runningView.pending, undefined, phase + ' does not claim an unseen running stage')
    const completedView = await localUpgradeView(directory, records, { result: { status: 'complete', scope: 'local-sql-physical-upgrade', report: resumed } })
    check(completedView.pending, undefined, phase + ' does not surface old stage entries after confirmed completion')
    const assessedNoStage = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report: resumed, pending: [] } })
    check(assessedNoStage.pending, undefined, phase + ' does not revive a stage after a newer finish assessment found none')
    const otherIssue = { path: note, reason: 'An unrelated original remains pending' }
    const unfinishedReport = { ...resumed, status: 'incomplete', issues: [{ code: 'source-row', path: note, message: otherIssue.reason }] }
    const unfinishedView = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report: unfinishedReport, pending: [otherIssue] } })
    check(unfinishedView.pending.some(item => item.path === recorded.stagePath), true,
      phase + ' shows last-reported stage even when unrelated work prevents a complete finish assessment')
    check(unfinishedView.pending.filter(item => item.path === note).length, 1, phase + ' keeps the separate actual issue once')
    await fs.rm(stage) // only after exact manual review; not an automated cleanup grant
    const pendingAfter = await assessLocalUpgradeCompletion(directory, records)
    check(pendingAfter.pending.some(item => item.path === recorded.stagePath), false, phase + ' can finish this stage after reviewed removal')
    check(hash(await fs.readFile(path.join(directory, 'dss-files.sqlite'))), sqlBefore, phase + ' retained original SQL')
    results.push({ phase, recorded, resumed, stageWasEmpty: true, stageRetainedUntilManualRemoval: true,
      viewBeforeFinish: noFinishView, viewAfterFinish: finishView, pendingBefore: pendingBefore.pending, pendingAfter: pendingAfter.pending })
  }
  console.log(JSON.stringify({ assertions, results, historicalProducer, ...evidence(), limits: [
    'Actual frozen v44 Worker row and currently shipped Local publisher on disposable Linux files; Note path independently verified against frozen taskInitializationFiles.',
    'Both SIGKILLs occur at the actual created callback; one case then uses ordinary editor-style atomic replace of that visible empty stage with another empty inode. This is a safety counterexample, not a reported user incident.',
    'The disk Records adapter is controlled, not a full DSH Host, Agent/model, UI, Windows/macOS or power-loss acceptance test.',
    'Removing the exact unowned stage is a demonstration of existing reviewed recovery, not permission for automatic deletion.',
    'UI projection and LocalUpgradeStatus native React server rendering are executed; full Service/Agent/model interaction is source traced, not executed.'
  ] }, null, 2))
} finally { hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
