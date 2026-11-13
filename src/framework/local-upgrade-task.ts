import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { localRecordPath } from './local-record-files.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { withLegacySqliteSnapshot, type LegacySqliteFile } from './legacy-sqlite-reader.js'
import { publishLocalUpgradeBytes, type LocalUpgradePublication, type LocalUpgradeIssue, type LocalStartupUpgradeOptions } from './local-startup-upgrade.js'
import { rememberLocalUpgradeMapping, localUpgradeResultKey } from './local-upgrade-mapping.js'
import { taskHistoryChange } from './task-history.js'
import { paths, taskLifecycle, foregroundTaskSignal, type TaskMetadata } from './task-files.js'
import { taskArchiveReadPath, taskArchiveCleanup, taskArchiveHostFacts, type TaskArchiveState } from './task-archive.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const parse = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, '')) as T
export const localTaskUpgradeKey = (directory: string, taskId: string) => 'framework-upgrade-task/' + hash(directory + '\0' + taskId)
interface TaskUpgrade extends LocalUpgradePublication {
  kind: 'dss-once-task-layout'
  directory: string
  taskId: string
  status: 'restoring' | 'complete'
  disposition: 'current' | 'history'
  /** Actual one-time material/source publication, before consumable notices. */
  materialsRestored?: true
  issues: LocalUpgradeIssue[]
}
export interface LocalTaskUpgradeReport { status: 'not-needed' | 'incomplete' | 'complete'; taskId: string; disposition?: TaskUpgrade['disposition']; issues: LocalUpgradeIssue[] }
const report = (value: TaskUpgrade): LocalTaskUpgradeReport => ({ status: value.status === 'complete' ? 'complete' : 'incomplete', taskId: value.taskId, disposition: value.disposition, issues: value.issues })
/** Restore only this actual Task's own paths. Old terminal status is not proof
 * of release. History conversion requires this Host's exact release fact and
 * the recorded completed cleanup; unknown/other live Hosts are never guessed. */
export async function restoreLegacyTask(directory: string, taskId: string, hostKey: string, storage: StoragePort,
  options: LocalStartupUpgradeOptions = {}): Promise<LocalTaskUpgradeReport> {
  const root = await canonicalLocalLocation(directory, true), taskPath = paths.task(taskId), key = localTaskUpgradeKey(root, taskId)
  if (!hostKey) throw new Error('Use the actual Local Host archive identity for this Task.')
  const complete = await storage.get<{ kind: string; directory: string; report: { status: string } }>(localUpgradeResultKey(root))
  if (complete?.kind === 'dss-local-upgrade-result' && complete.directory === root && complete.report.status === 'complete') return { status: 'complete', taskId, issues: [] }
  const prior = await storage.get<TaskUpgrade>(key)
  if (prior && (prior.kind !== 'dss-once-task-layout' || prior.directory !== root || prior.taskId !== taskId || !Array.isArray(prior.files))) throw new Error('The original Task conversion state is invalid; it was retained.')
  if (prior?.status === 'complete') return report(prior)
  return withLegacySqliteSnapshot(join(root, 'dss-files.sqlite'), async source => {
    const get = async (path: string): Promise<LegacySqliteFile | undefined> => {
      const value = await source.read(localRecordPath(path))
      if (value?.kind === 'issue') throw new Error(value.issue.message)
      return value
    }
    const original = await get(taskPath)
    if (!original) return { status: 'not-needed', taskId, issues: [] }
    const task = parse<TaskMetadata>(original.bytes)
    if (task.version !== 1 || task.taskId !== taskId || !['P', 'O'].includes(task.route) || !['running', 'complete', 'cancelled'].includes(task.status)
      || typeof task.owner !== 'string' || !task.owner || typeof task.sourcePath !== 'string')
      return { status: 'incomplete', taskId, issues: [{ code: 'source-row', path: taskPath, message: 'The original Task identity/lifecycle is unknown. It was not guessed into a running Task.' }] }
    localRecordPath(task.sourcePath); paths.state(task.owner, taskId)
    for (const member of task.members ?? []) paths.state(member, taskId)
    const archiveRoot = taskArchiveReadPath(task), archive = await get(archiveRoot + '/state.json')
    const archiveState = archive ? parse<TaskArchiveState>(archive.bytes) : undefined
    if (archiveState && (archiveState.version !== 1 || archiveState.taskId !== taskId || !archiveState.lifecycles))
      return { status: 'incomplete', taskId, issues: [{ code: 'source-row', path: archiveRoot + '/state.json', message: 'Original archive lifecycle identity is invalid; no release was inferred.' }] }
    const own = taskArchiveHostFacts(archiveState, task, hostKey), cleanup = taskArchiveCleanup(archiveState, task)
    const hosts = archiveState?.lifecycles[taskLifecycle(task)]?.hosts
    const released = task.status !== 'running' && own?.released === true && cleanup?.phase === 'released'
      && !!hosts && Object.keys(hosts).length > 0 && Object.keys(hosts).every(key => taskArchiveHostFacts(archiveState, task, key)?.released === true)
    if (task.status === 'running' && own?.released) return { status: 'incomplete', taskId, issues: [{ code: 'source-row', path: taskPath, message: 'Running Task metadata contradicts its recorded release. Original facts were retained without restarting it.' }] }
    const state: TaskUpgrade = prior ?? { kind: 'dss-once-task-layout', operationId: randomUUID(), directory: root, taskId,
      status: 'restoring', disposition: released ? 'history' : 'current', files: [], issues: [] }
    if (state.disposition !== (released ? 'history' : 'current')) throw new Error('The original Task release facts changed during restoration; prior results were retained.')
    state.issues = []
    const save = () => storage.set(key, structuredClone(state)), originals = new Map<string, LegacySqliteFile>(), retired = new Set<string>()
    const publish = async (entry: Pick<LegacySqliteFile, 'path' | 'bytes'>, signal = false) => {
      options.signal?.throwIfAborted()
      const issue = await publishLocalUpgradeBytes(root, entry, state, save, { ...options, ...(signal ? { publishedSignal: true } : {}) })
      if (issue) state.issues.push(issue)
      return !issue
    }
    const range = async (prefix: string, exclude: (path: string) => boolean = () => false) => {
      for await (const entry of source.entries(prefix)) {
        if (entry.kind === 'issue') { state.issues.push({ code: 'source-row', path: entry.issue.path, message: entry.issue.message }); continue }
        originals.set(entry.path, entry)
        if (exclude(entry.path)) retired.add(entry.path); else await publish(entry, entry.path.startsWith('state/') && entry.bytes.byteLength === 0)
      }
    }
    await save()
    if (!state.materialsRestored) {
    // Long-lived archive originals and this Task's own material precede its
    // identity. No unrelated Task or whole-store completion is awaited.
    await range(archiveRoot + '/', path => released && path === archiveRoot + '/state.json')
    await range(paths.run(taskId) + '/', () => released)
    await range('Recorder Cache/' + taskId + '/', () => released)
    await range('technical/recovery-inputs/' + taskId + '/', () => released)
    if (released) for (const member of new Set([task.owner, ...(task.members ?? [])])) await range(paths.state(member, taskId) + '/', () => true)
    const sourceFile = await get(task.sourcePath)
    if (!released && !sourceFile) state.issues.push({ code: 'source-row', path: task.sourcePath, message: 'The current Task original source is unavailable; runtime metadata was not published.' })
    if (!state.issues.length) {
      const pinned: TaskMetadata = { ...task, archiveFolder: archiveRoot.slice('archives/'.length) }
      const changed = released ? taskHistoryChange(pinned) : { path: taskPath, content: JSON.stringify(pinned, null, 2) + '\n' }
      if (typeof changed.content !== 'string') throw new Error('Task conversion did not produce its known identity.')
      let metadataReady = false
      const identityFiles = new PhysicalLocalFiles(root), view = await identityFiles.snapshot()
      try {
        const present = await identityFiles.readBytes(view, changed.path)
        if (!released && present !== undefined && Buffer.from(present).equals(Buffer.from(original.bytes))) {
          metadataReady = await identityFiles.update(changed.path, current => current !== undefined && Buffer.from(current).equals(Buffer.from(original.bytes))
            ? { value: true, content: changed.content! } : { value: false })
          if (!metadataReady) state.issues.push({ code: 'target-conflict', path: changed.path, message: 'Task identity changed during its exact old-layout update; current data was retained.' })
        } else metadataReady = await publish({ path: changed.path, bytes: Buffer.from(changed.content) })
      } finally { await view.release(); await identityFiles.close() }
      if (metadataReady) {
        if (sourceFile) { originals.set(sourceFile.path, sourceFile); await publish(sourceFile) }
        if (!state.issues.length && released) {
          const physical = new PhysicalLocalFiles(root)
          try {
            for (const obsolete of [original, ...[...originals.values()].filter(entry => retired.has(entry.path))]) {
              const removed = await physical.update(obsolete.path, current => current === undefined ? { value: true }
                : Buffer.from(current).equals(Buffer.from(obsolete.bytes)) ? { value: true, content: null } : { value: false })
              if (!removed) state.issues.push({ code: 'target-conflict', path: obsolete.path, message: 'Existing physical runtime material differs from the old released source; it was retained.' })
            }
          } finally { await physical.close() }
        }
        if (!state.issues.length) {
          await rememberLocalUpgradeMapping(storage, root, original, state.operationId, [changed.path])
          for (const entry of originals.values()) await rememberLocalUpgradeMapping(storage, root, entry, state.operationId,
            [retired.has(entry.path) ? changed.path : entry.path], 'physical-original-retained')
          state.materialsRestored = true
          await save()
        }
      }
    }
    }
    if (state.materialsRestored && !state.issues.length) {
      // Only notices remain. A restart never recopies already independent user
      // material or resurrects runtime data that the real Host since cleaned.
      const publishSignal = async (entry: LegacySqliteFile) => {
        if (await publish(entry, entry.bytes.byteLength === 0)) await rememberLocalUpgradeMapping(storage, root, entry, state.operationId, [entry.path], 'physical-original-retained')
      }
      if (!released) for (const member of new Set([task.owner, ...(task.members ?? [])])) for await (const entry of source.entries(paths.state(member, taskId) + '/')) {
        if (entry.kind === 'issue') state.issues.push({ code: 'source-row', path: entry.issue.path, message: entry.issue.message })
        else await publishSignal(entry)
      }
      const notice = await get(foregroundTaskSignal(taskId))
      if (notice) await publishSignal(notice)
      if (!state.issues.length) state.status = 'complete'
    }
    options.signal?.throwIfAborted(); await save(); return report(state)
  }, { signal: options.signal })
}

/** The existing Host asks only about this addressed Task. It is an actual
 * incomplete source restoration, not a permanent Task readiness/version flag. */
export async function legacyTaskNeedsRestoration(directory: string, taskId: string, storage: StoragePort, signal?: AbortSignal): Promise<boolean> {
  const root = await canonicalLocalLocation(directory, true)
  const complete = await storage.get<{ kind: string; directory: string; report: { status: string } }>(localUpgradeResultKey(root))
  if (complete?.kind === 'dss-local-upgrade-result' && complete.directory === root && complete.report.status === 'complete') return false
  const state = await storage.get<TaskUpgrade>(localTaskUpgradeKey(root, taskId))
  if (state?.kind === 'dss-once-task-layout' && state.directory === root && state.taskId === taskId && (state.status === 'complete' || state.materialsRestored)) return false
  try { await lstat(join(root, 'dss-files.sqlite')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return !!state; throw error }
  return withLegacySqliteSnapshot(join(root, 'dss-files.sqlite'), async source => (await source.read(paths.task(taskId))) !== undefined, { signal })
}
