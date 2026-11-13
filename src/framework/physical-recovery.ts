import { createHash } from 'node:crypto'
import { PhysicalLocalFiles } from './physical-local-files.js'
import type { PreparedLocalAppend } from './local-record-files.js'
import type { DirectSignalSources } from './physical-direct-delivery.js'
import { publishPreparedPhysicalFile } from './physical-publication-evidence.js'
import { paths, readJson, encodeJson } from './task-files.js'
import { withSnapshot } from './transactions.js'
import { hostRecoveryDebugPath, hostRecoverySignalPath, hostRecoverySignalRecordPath } from './recovery-debug-record.js'

interface RecoveryPublication {
  commandId: string
  taskId?: string
  lifecycleId?: string
  markerPath?: string
  debug?: { path: string; text: string }
  recoveryInput?: { path: string; text: string }
  signalPath?: string
}
export interface PhysicalRecoveryTargets { debugPath?: string; signalPath?: string }
interface Publication {
  /** Present only for new Local records. Legacy accepted facts keep the exact
   * original paths in their request; neither layout is inferred from absence. */
  targets?: PhysicalRecoveryTargets
  request: string
  marker?: string
  markerVersion?: string
  markerPublished?: true
  markerReused?: true
  signal?: string
  signalVersion?: string
  signalPublished?: true
  input?: string
  inputVersion?: string
  inputPublished?: true
  debugPrepared?: PreparedLocalAppend
  debugPublished?: true
  published?: true
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const operations = new Map<string, Promise<unknown>>()
async function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
  const pending = (operations.get(key)?.catch(() => {}) ?? Promise.resolve()).then(action)
  operations.set(key, pending)
  try { return await pending } finally { if (operations.get(key) === pending) operations.delete(key) }
}
const base = (taskId: string | undefined, commandId: string) => (taskId ? paths.run(taskId) : 'debug') + '/.recovery/' + hash(commandId)

/** The old request hash keeps its original meaning. Only a newly accepted
 * fact pins new physical destinations; a prior fact without targets continues
 * its original files, even when its stage or signal has already been consumed. */
function publicationTargets(input: RecoveryPublication, targets?: PhysicalRecoveryTargets): PhysicalRecoveryTargets {
  if (targets?.debugPath && (!input.debug || targets.debugPath !== hostRecoveryDebugPath(input.debug.path, input.commandId)))
    throw new Error('The accepted Host recovery record target is invalid.')
  if (targets?.signalPath && targets.signalPath !== input.signalPath) {
    const name = targets.signalPath.slice(targets.signalPath.lastIndexOf('/') + 1)
    const recordPath = hostRecoverySignalRecordPath(targets.signalPath)
    if (!input.signalPath || !name.startsWith('Planner_Recovery_Report_') || !recordPath
      || targets.signalPath !== hostRecoverySignalPath(input.signalPath, recordPath))
      throw new Error('The accepted Host recovery signal target is invalid.')
  }
  if (targets?.debugPath && input.signalPath && targets.signalPath !== hostRecoverySignalPath(input.signalPath, targets.debugPath))
    throw new Error('The Host recovery notice must name its accepted record.')
  return { ...(input.debug ? { debugPath: targets?.debugPath ?? input.debug.path } : {}),
    ...(input.signalPath ? { signalPath: targets?.signalPath ?? input.signalPath } : {}) }
}

/** The exact already-owned recovery operation only. Debug is preserved before
 * its ordinary Planner notice. A fixed marker already pending is not replaced.
 * A missing prepared source requires exact publication evidence; absence alone
 * proves nothing. Ordinary notice sources do not prove Planner consumption of
 * the fixed recovery marker. No directory-wide replay, transaction or watcher. */
export async function publishPhysicalRecovery(files: PhysicalLocalFiles, input: RecoveryPublication,
  beforeAttempt: () => void | Promise<void> = () => {}, signalSources?: DirectSignalSources,
  targets?: PhysicalRecoveryTargets): Promise<PhysicalRecoveryTargets> {
  const root = base(input.taskId, input.commandId), factPath = root + '.json'
  return serial(files.directory + '\0' + (input.markerPath ?? factPath), () => withSnapshot(files, async snapshot => {
    await beforeAttempt()
    const request = hash(JSON.stringify(input))
    let fact = await readJson<Publication>(files, snapshot, factPath)
    const persist = () => files.replace(factPath, encodeJson(fact))
    if (fact && fact.request !== request) throw new Error('Continue this recovery publication with its original facts and input.')
    if (!fact) {
      publicationTargets(input, targets)
      const marker = input.markerPath && !await files.fileInfo(input.markerPath) ? root + '.marker.stage' : undefined
      const signal = input.signalPath ? root + '.signal.stage' : undefined
      if (marker) await files.replace(marker, '')
      if (signal) await files.replace(signal, '')
      const originalInput = input.recoveryInput ? root + '.input.stage' : undefined
      if (originalInput) await files.replace(originalInput, input.recoveryInput!.text)
      const version = async (stage: string): Promise<string> => {
        const info = await files.fileInfo(stage)
        if (!info) throw new Error('The prepared recovery file is missing: ' + stage)
        return info.version
      }
      fact = { request, ...(targets ? { targets: { ...targets } } : {}), ...(marker ? { marker, markerVersion: await version(marker) } : {}),
        ...(signal ? { signal, signalVersion: await version(signal) } : {}),
        ...(originalInput ? { input: originalInput, inputVersion: await version(originalInput) } : {}) }
      await persist()
    }
    const actual = publicationTargets(input, fact.targets)
    const { debugPath, signalPath } = actual
    if (fact.published) return actual
    if (input.debug && !fact.debugPublished) {
      await files.appendPrepared(debugPath!, root + '.debug.stage', input.debug.text, fact.debugPrepared,
        async prepared => { fact!.debugPrepared = prepared; await persist() })
      fact.debugPublished = true
      await persist()
    }
    const publish = async (kind: 'input' | 'marker' | 'signal', target: string | undefined): Promise<void> => {
      const stage = fact![kind], versionKey = `${kind}Version` as const, publishedKey = `${kind}Published` as const
      if (!stage || fact![publishedKey]) return
      const version = fact![versionKey]
      if (!target || !version) throw new Error('The original recovery publication identity is unavailable: ' + kind)
      await beforeAttempt()
      if (kind === 'marker') {
        // The fixed marker means this member still needs Planner continuation,
        // not an acknowledgement per publication. While our own stage remains,
        // another already-pending marker can carry that same responsibility.
        // Save this distinct fact before discarding only our unused stage. A
        // later retry must not recreate a marker Planner has since consumed.
        if (!fact!.markerReused && await files.fileInfo(stage) && await files.fileInfo(target)) {
          fact!.markerReused = true
          await persist()
        }
        if (fact!.markerReused) {
          await files.delete(stage)
          return
        }
      }
      await publishPreparedPhysicalFile(files, stage, target, version,
        kind === 'signal' && signalSources ? () => signalSources(target) : undefined)
      fact![publishedKey] = true
      await persist()
    }
    await publish('input', input.recoveryInput?.path)
    await publish('marker', input.markerPath)
    await publish('signal', signalPath)
    fact.published = true
    await persist()
    return actual
  }))
}
/** The existing completed restore row closes this exact debug retry window.
 * Published stages are already consumed. Unfinished/unknown publications and
 * the long-lived diagnostic body remain untouched; no directory is listed. */
export async function retirePublishedPhysicalRecovery(files: PhysicalLocalFiles, commandId: string): Promise<boolean> {
  const factPath = base(undefined, commandId) + '.json'
  return serial(files.directory + '\0' + factPath, () => withSnapshot(files, async snapshot => {
    const fact = await readJson<Publication>(files, snapshot, factPath)
    if (!fact) return true
    if (!fact.published) return false
    await files.delete(factPath)
    return true
  }))
}
interface Consumption { request: string; markerVersion: string; notePrepared?: PreparedLocalAppend; notePublished?: true; complete?: true }
/** Planner alone saves its continuation then consumes the particular fixed
 * member marker it received. A retry preserves new marker publications and all
 * existing Memory. Its small operation fact retires with the Task directory. */
export async function consumePhysicalRecovery(files: PhysicalLocalFiles, input: {
  commandId: string; taskId: string; lifecycleId?: string; member: string; continuation: string
}, beforeAttempt: () => void | Promise<void>): Promise<boolean> {
  const marker = paths.state(input.member, input.taskId) + '/recovery'
  const root = base(input.taskId, 'consume:' + input.commandId), factPath = root + '.json'
  return serial(files.directory + '\0' + marker, () => withSnapshot(files, async snapshot => {
    await beforeAttempt()
    const request = hash(JSON.stringify(input))
    let fact = await readJson<Consumption>(files, snapshot, factPath)
    const persist = () => files.replace(factPath, encodeJson(fact))
    if (fact && fact.request !== request) throw new Error('Continue this Planner recovery consumption with its original continuation.')
    if (fact?.complete) return false
    if (!fact) {
      const actual = await files.fileInfo(marker)
      if (!actual) throw new Error('This member has no pending recovery marker.')
      fact = { request, markerVersion: actual.version }
      await persist()
    }
    if (!fact.notePublished) {
      await files.appendPrepared(paths.member(input.taskId, input.member) + '/Planner_Memory.md', root + '.memory.stage',
        input.continuation, fact.notePrepared, async prepared => { fact!.notePrepared = prepared; await persist() })
      fact.notePublished = true
      await persist()
    }
    await beforeAttempt()
    const consumed = await files.deleteObserved(marker, fact.markerVersion)
    fact.complete = true
    await persist()
    return consumed
  }))
}
