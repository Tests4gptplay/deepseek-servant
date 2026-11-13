import { createHash } from 'node:crypto'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { samePhysicalPublication, type PreparedLocalReport } from './local-record-files.js'
import { encodeJson, paths, readJson, type TaskMetadata } from './task-files.js'
import { withSnapshot, type FilesSnapshot } from './transactions.js'

interface Body { path: string; text: string; fillOnly?: true }
export interface PhysicalRecoveredTaskPlan {
  task: TaskMetadata
  source?: Body
  inbox?: Body
  memberStatus?: Body
  cache?: Body
  history?: {
    path: string; execution: string; recovery: string
    copies: Array<{ source: string; target: string }>
    signals: Array<{ path: string; version: string }>
  }
}
interface StagedBody {
  path: string; stage: string; fillOnly?: true
  prepared?: PreparedLocalReport
  published?: true; preserved?: true
}
interface Copy { source: string; target: string; stage: string; prepared?: { bytes: number; sha256: string } }
interface Reconstruction {
  commandId: string; request: string; taskId: string
  task: StagedBody
  source?: StagedBody
  inbox?: StagedBody
  memberStatus?: StagedBody
  cache?: StagedBody
  history?: { execution: StagedBody; recovery: StagedBody; copies: Copy[]; signals: Array<{ path: string; version: string }> }
  complete?: true
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const operations = new Map<string, Promise<unknown>>()
/** Restore exactly the Task selected by an existing stopped execution and its
 * retained evidence. Original material is copied before old notices are retired;
 * the recovered Task metadata is published last. This is not a general commit
 * engine and cannot replay arbitrary FileChange arrays or discover other work. */
export async function reconstructPhysicalTask(files: PhysicalLocalFiles, taskId: string, commandId: string, input: unknown,
  build: (snapshot: FilesSnapshot) => Promise<PhysicalRecoveredTaskPlan>, beforeAttempt: () => void | Promise<void>): Promise<void> {
  const root = paths.run(taskId) + '/.recovery/reconstruct-' + hash(commandId), path = root + '.json'
  const key = files.directory + '\0' + path
  const operation = (operations.get(key)?.catch(() => {}) ?? Promise.resolve()).then(() => withSnapshot(files, async snapshot => {
    await beforeAttempt()
    const request = hash(JSON.stringify(input))
    let fact = await readJson<Reconstruction>(files, snapshot, path)
    const persist = () => files.replace(path, encodeJson(fact))
    if (fact && (fact.commandId !== commandId || fact.taskId !== taskId || fact.request !== request))
      throw new Error('Task reconstruction must continue its original exact recovery input.')
    if (fact?.complete) return
    if (!fact) {
      const plan = await build(snapshot)
      if (plan.task.taskId !== taskId || plan.task.status !== 'running') throw new Error('Recovery must reconstruct its selected running Task.')
      const stage = async (name: string, body: Body): Promise<StagedBody> => {
        const stage = root + '.' + name + '.stage'
        const target = await files.fileInfo(body.path)
        await files.replace(stage, body.text)
        const prepared = await files.fileInfo(stage)
        if (!prepared) throw new Error('The prepared Task reconstruction file is missing: ' + stage)
        return { path: body.path, stage, prepared: { stageVersion: prepared.version, targetVersion: target?.version ?? null },
          ...(body.fillOnly ? { fillOnly: true } : {}) }
      }
      fact = { commandId, taskId, request, task: await stage('task', { path: paths.task(taskId), text: encodeJson(plan.task) }),
        ...(plan.source ? { source: await stage('source', plan.source) } : {}),
        ...(plan.inbox ? { inbox: await stage('inbox', plan.inbox) } : {}),
        ...(plan.memberStatus ? { memberStatus: await stage('member-status', plan.memberStatus) } : {}),
        ...(plan.cache ? { cache: await stage('cache', plan.cache) } : {}),
        ...(plan.history ? { history: {
          execution: await stage('execution', { path: plan.history.path + '/execution.json', text: plan.history.execution }),
          recovery: await stage('recovery', { path: plan.history.path + '/recovery.json', text: plan.history.recovery }),
          copies: plan.history.copies.map((copy, index) => ({ ...copy, stage: root + '.copy-' + index + '.stage' })),
          signals: plan.history.signals,
        } } : {}) }
      await persist()
    }
    const publish = async (body: StagedBody | undefined) => {
      if (!body || body.published) return
      await beforeAttempt()
      // Only this unfinished handoff observes file identity. A later user edit
      // is never a reason to replay an already confirmed publication.
      if (!body.prepared) throw new Error('The original Task reconstruction publication identity is unavailable: ' + body.path)
      if (body.preserved) {
        await files.deleteObserved(body.stage, body.prepared.stageVersion)
        return
      }
      if (body.fillOnly) {
        const staged = await files.fileInfo(body.stage)
        if (staged && staged.version !== body.prepared.stageVersion)
          throw new Error('The prepared Task reconstruction file changed; it was preserved: ' + body.stage)
        const outcome = staged ? await files.renameIfAbsent(body.stage, body.path) : 'source-missing'
        if (outcome === 'destination-exists') {
          // Filling a missing support file can intentionally keep a file that
          // appeared meanwhile. Save that fact before discarding our own stage.
          body.preserved = true
          await persist()
          await files.deleteObserved(body.stage, body.prepared.stageVersion)
          return
        }
        if (outcome === 'source-missing') {
          const actual = await files.fileInfo(body.path)
          if (!actual || !samePhysicalPublication(body.prepared.stageVersion, actual.version))
            throw new Error('The prepared Task reconstruction file is missing and publication is unconfirmed: ' + body.path)
        }
      } else {
        // The exact accepted full bytes are already staged. Reuse the existing
        // single-file handoff; do not rebuild them from a later recovery input.
        await files.publishPreparedReport(body.path, body.stage, '', false, body.prepared,
          async () => { throw new Error('Task reconstruction already owns its prepared original.') })
      }
      body.published = true
      await persist()
    }
    if (fact.history) {
      for (const copy of fact.history.copies) {
        await beforeAttempt()
        if (!copy.prepared) {
          const original = await files.stageCopy(copy.source, copy.stage)
          if (!original) throw new Error('Original recovery material disappeared before preservation: ' + copy.source)
          const existing = await files.fingerprint(copy.target)
          if (existing && (existing.bytes !== original.bytes || existing.sha256 !== original.sha256))
            throw new Error('Lifecycle history already differs; preserve the original material: ' + copy.target)
          copy.prepared = original
          await persist()
        }
        await files.renameIfAbsent(copy.stage, copy.target)
        const preserved = await files.fingerprint(copy.target)
        if (!preserved || preserved.bytes !== copy.prepared.bytes || preserved.sha256 !== copy.prepared.sha256)
          throw new Error('Original recovery material is not preserved at its exact archive path: ' + copy.target)
      }
      await publish(fact.history.execution)
      await publish(fact.history.recovery)
      for (const signal of fact.history.signals) await files.deleteObserved(signal.path, signal.version)
    }
    await publish(fact.source)
    await publish(fact.inbox)
    await publish(fact.memberStatus)
    await publish(fact.cache)
    await publish(fact.task)
    fact.complete = true
    await persist()
  }))
  operations.set(key, operation)
  try { await operation } finally { if (operations.get(key) === operation) operations.delete(key) }
}
