import { createHash } from 'node:crypto'
import { prepareRecorderRetention, taskWorkingRoots, taskStateSignal } from './recorder-retention.js'
import { FrameworkTransactions } from './command-transactions.js'
import { filePath, withSnapshot, type FileChange, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'
import { encodeJson, paths, readJson, taskIdentity, type TaskMetadata } from './task-files.js'

export interface RetentionManifest {
  relocatedReferences?: Record<string, string>
  relocatedSources?: Record<string, { sourcePath: string; sourceRevision: string; sha256: string }>
  outputs: string[]
  retainedPaths: string[]
  recorderCommand?: string
  inputs?: Record<string, string>
  verifiedReferences?: Record<string, string>
}
/** Metadata for original material at Recorder's actual save snapshot. */
export async function captureCleanupInputs(files: FilesStore, snapshot: FilesSnapshot, task: TaskMetadata): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {}
  for (const root of [paths.run(task.taskId), 'Recorder Cache/' + task.taskId]) {
    for (const entry of await files.list(snapshot, root)) {
      if (entry.path.endsWith('/inbox-observation.json')) continue
      inputs[entry.path] = entry.version
    }
  }
  if (/^tasks\/[^/]+_(P|O)\.md$/.test(task.sourcePath)) {
    const source = await files.read(snapshot, task.sourcePath)
    if (source !== undefined && taskIdentity(source) === task.taskId) {
      const entry = (await files.listDirectory(snapshot, 'tasks/')).find(row => row.path === task.sourcePath)
      if (entry) inputs[entry.path] = entry.version
    }
  }
  return Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)))
}
/** Exact bytes for only the declared retained references, including staged outputs.
 * Missing references remain unverified; callers must not infer successful readback.
 */
export async function captureCleanupReferences(files: FilesStore, snapshot: FilesSnapshot,
  references: readonly string[], stagedChanges: readonly FileChange[] = []): Promise<Record<string, string>> {
  const staged = new Map(stagedChanges.map(change => [change.path, change]))
  const hashes: Record<string, string> = {}
  for (const path of [...new Set(references.map(filePath))].sort()) {
    const change = staged.get(path)
    const bytes = change ? change.bytes ?? (change.content === null ? undefined : Buffer.from(change.content!, 'utf8'))
      : await files.readBytes(snapshot, path)
    if (bytes !== undefined) hashes[path] = createHash('sha256').update(bytes).digest('hex')
  }
  return hashes
}
// Cache only digests paired with immutable content identities, scoped to a live Task.
const referenceCache = new WeakMap<FilesStore, Map<string, Map<string, { version: string; hash: string }>>>()
export function clearCleanupReferenceCache(files: FilesStore, taskId: string): void {
  referenceCache.get(files)?.delete(taskId)
}
async function cachedCleanupReferences(files: FilesStore, snapshot: FilesSnapshot, taskId: string,
  references: readonly string[]): Promise<Record<string, string>> {
  let tasks = referenceCache.get(files)
  if (!tasks) referenceCache.set(files, tasks = new Map())
  let cache = tasks.get(taskId)
  if (!cache) tasks.set(taskId, cache = new Map())
  const selected = new Set(references)
  for (const path of cache.keys()) if (!selected.has(path)) cache.delete(path)
  const versions = new Map<string, string>()
  for (const directory of new Set(references.map(path => path.slice(0, path.lastIndexOf('/') + 1)))) {
    for (const entry of await files.listDirectory(snapshot, directory)) if (selected.has(entry.path)) versions.set(entry.path, entry.version)
  }
  const hashes: Record<string, string> = {}
  for (const path of references) {
    const version = versions.get(path), previous = cache.get(path)
    if (version && previous?.version === version) { hashes[path] = previous.hash; continue }
    cache.delete(path)
    if (!version) continue
    const bytes = await files.readBytes(snapshot, path)
    if (bytes === undefined) continue
    const hash = createHash('sha256').update(bytes).digest('hex')
    hashes[path] = hash
    if (version) cache.set(path, { version, hash })
  }
  return hashes
}
export class CleanupMaterialsChangedError extends Error {
  constructor(readonly taskId: string, readonly paths: string[], readonly signature: string) {
    super('Recorder must review changed or previously unverified original material or retained references before cleanup.');
    this.name = 'CleanupMaterialsChangedError'
  }
}
export async function changedCleanupMaterials(files: FilesStore, snapshot: FilesSnapshot, task: TaskMetadata,
  manifest: RetentionManifest, raw: string): Promise<CleanupMaterialsChangedError | undefined> {
  const inputs = await captureCleanupInputs(files, snapshot, task)
  const changed = [...new Set([...Object.keys(inputs), ...Object.keys(manifest.inputs ?? {})])]
    .filter(path => !manifest.inputs || manifest.inputs[path] !== inputs[path]).sort()
  const references = new Set<string>(), evaluatedDirectoryFiles = new Set<string>()
  for (const reference of [...new Set([...manifest.outputs, ...manifest.retainedPaths].map(filePath))]) {
    const directory = reference.slice(0, reference.lastIndexOf('/') + 1)
    const exact = (await files.listDirectory(snapshot, directory)).some(entry => entry.path === reference)
    const children = await files.list(snapshot, reference + '/')
    const selected = [...(exact || !children.length ? [reference] : []), ...children.map(entry => entry.path)]
    for (const path of selected) {
      if (path.startsWith('state/')) {
        const bytes = await files.readBytes(snapshot, path)
        if (bytes !== undefined && taskStateSignal(task, path, bytes)) continue
      }
      references.add(path)
      // Legacy directory references have no directory blob to hash. Their work
      // leaves are already fenced by Recorder's exact evaluated input versions.
      if (path !== reference && inputs[path] && manifest.inputs?.[path] === inputs[path]) evaluatedDirectoryFiles.add(path)
    }
  }
  const actual = await cachedCleanupReferences(files, snapshot, task.taskId, [...references])
  for (const path of references) if (!actual[path] || (manifest.verifiedReferences?.[path]
    ? actual[path] !== manifest.verifiedReferences[path] : !evaluatedDirectoryFiles.has(path))) changed.push(path)
  if (!manifest.inputs || !manifest.verifiedReferences || changed.length) return new CleanupMaterialsChangedError(task.taskId, [...new Set(changed)].sort(),
    createHash('sha256').update(JSON.stringify([createHash('sha256').update(raw).digest('hex'), inputs, actual])).digest('hex'))
}
export interface CleanupRecord {
  version: 1
  taskId: string
  phase: 'files-cleaned' | 'released'
  retentionHash: string
  deletedPaths: string[]
  preservedPaths: string[]
}
export type CleanupResult = { status: 'not-requested' } | { status: 'released'; record: CleanupRecord; receipt: FileReceipt }
export type TaskRelease = (task: TaskMetadata, record: CleanupRecord) => Promise<void>
export class CleanupReleaseError extends Error {
  constructor(readonly taskId: string, readonly record: CleanupRecord, cause: unknown) {
    super('Task files are cleaned; Host association release remains pending.', { cause }); this.name = 'CleanupReleaseError'
  }
}
export const cleanupRecordPath = (taskId: string): string => 'technical/cleanup/' + filePath(taskId) + '.json'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** Runs the fixed deletion plan only after Recorder's retained-reference manifest.
 * Release is an idempotent Host operation, ordered after confirmed file cleanup.
 * Technical receipts contain paths/hashes, never substitute generated summaries.
 */
export class FrameworkCleaner {
  constructor(readonly files: FilesStore, readonly transactions: FrameworkTransactions, private readonly onTaskReleased: TaskRelease) {}
  async clean(task: TaskMetadata, snapshot: FilesSnapshot): Promise<CleanupResult> {
    const recordPath = cleanupRecordPath(task.taskId)
    let recordRevision = snapshot.revision
    let record = await readJson<CleanupRecord>(this.files, snapshot, recordPath)
    const cleaner = paths.state(task.owner, task.taskId) + '/Cleaner'
    if (!record && await this.files.read(snapshot, cleaner) === undefined) return { status: 'not-requested' }
    if (!record) {
      const expectedRetention = await this.files.read(snapshot, paths.archive(task.taskId) + '/retention.json')
      if (expectedRetention === undefined) throw new Error('Recorder retention manifest is missing.')
      const originalManifest = JSON.parse(expectedRetention) as RetentionManifest
      const currentTask = await readJson<TaskMetadata>(this.files, snapshot, paths.task(task.taskId))
      if (!currentTask || currentTask.status !== 'complete' || currentTask.owner !== task.owner) throw new Error('Cleanup requires the principal’s sealed task.')
      const materialChanged = await changedCleanupMaterials(this.files, snapshot, currentTask, originalManifest, expectedRetention)
      if (materialChanged) throw materialChanged
      const archival = await prepareRecorderRetention(this.files, snapshot, currentTask, originalManifest)
      if (archival.relocated) {
        await this.transactions.run('cleanup:' + task.taskId + ':archive:' + digest(expectedRetention),
          { taskId: task.taskId, retentionHash: digest(expectedRetention) }, { snapshot, expectedRevision: snapshot.revision, reevaluate: true },
          async checked => {
            const selected = await readJson<TaskMetadata>(this.files, checked, paths.task(task.taskId))
            const raw = await this.files.read(checked, paths.archive(task.taskId) + '/retention.json')
            if (!selected || selected.status !== 'complete' || selected.owner !== task.owner || raw !== expectedRetention
              || await this.files.read(checked, cleaner) === undefined) throw new Error('Recorder retention changed; inspect the current cleanup request.')
            const changed = await changedCleanupMaterials(this.files, checked, selected, originalManifest, raw)
            if (changed) throw changed
            const plan = await prepareRecorderRetention(this.files, checked, selected, originalManifest)
            return [...plan.changes, { path: paths.archive(task.taskId) + '/retention.json', content: encodeJson(plan.retention) }]
          })
        // Fresh snapshot checks all persisted archive hashes before any source deletion.
        return withSnapshot(this.files, checked => this.clean(archival.task, checked))
      }
      const retentionHash = digest(expectedRetention)
      await this.transactions.run('cleanup:' + task.taskId + ':files:' + retentionHash, { taskId: task.taskId, owner: task.owner, retentionHash },
        { snapshot, expectedRevision: snapshot.revision, reevaluate: true }, async checked => {
          const current = await readJson<TaskMetadata>(this.files, checked, paths.task(task.taskId))
          if (!current || current.status !== 'complete' || current.owner !== task.owner) throw new Error('Cleanup requires the principal’s sealed task.')
          if (await this.files.read(checked, cleaner) === undefined) throw new Error('Recorder has not requested cleanup at this revision.')
          const manifestPath = paths.archive(task.taskId) + '/retention.json'
          const raw = await this.files.read(checked, manifestPath)
          if (raw === undefined) throw new Error('Recorder retention manifest is missing.')
          if (digest(raw) !== retentionHash) throw new Error('Recorder retention changed; inspect the current cleanup request.')
          const manifest = JSON.parse(raw) as RetentionManifest
          if (!Array.isArray(manifest.outputs) || !Array.isArray(manifest.retainedPaths)
            || !manifest.outputs.includes(paths.archive(task.taskId) + '/records.md')) throw new Error('Recorder retention manifest lacks its Task records.')
          const changed = await changedCleanupMaterials(this.files, checked, current, manifest, raw)
          if (changed) throw changed
          const preserve = new Set([...manifest.outputs, ...manifest.retainedPaths, ...(current.resultPaths ?? [])].map(filePath))
          for (const path of [...manifest.outputs, ...manifest.retainedPaths]) {
            if (await this.files.readBytes(checked, path) === undefined) throw new Error('Retained Recorder reference is missing: ' + path)
          }
          const candidates = new Set<string>()
          for (const root of taskWorkingRoots(current)) {
            for (const entry of await this.files.list(checked, root)) candidates.add(entry.path)
          }
          // A later new task may reuse the submission filename; never delete that new input.
          const source = await this.files.read(checked, filePath(current.sourcePath))
          if (/^tasks\/[^/]+_(P|O)\.md$/.test(current.sourcePath) && source !== undefined && taskIdentity(source) === task.taskId) candidates.add(current.sourcePath)
          const retained = (path: string) => [...preserve].some(reference => path === reference || path.startsWith(reference.replace(/\/$/, '') + '/'))
          // Final sealed-Task cleanup reclaims its state namespace, including recovery.
          // Ordinary running-role claims retain their separate consumption rules.
          const deletedPaths = [...candidates].filter(path => !retained(path)).sort()
          const cleanup: CleanupRecord = { version: 1, taskId: task.taskId, phase: 'files-cleaned', retentionHash: digest(raw),
            deletedPaths, preservedPaths: [...preserve].sort() }
          return [...deletedPaths.map(path => ({ path, content: null } satisfies FileChange)), { path: recordPath, content: encodeJson(cleanup) }]
        })
      const confirmed = await withSnapshot(this.files, async checked => ({ revision: checked.revision, record: await readJson<CleanupRecord>(this.files, checked, recordPath) }))
      record = confirmed.record; recordRevision = confirmed.revision
    }
    if (!record || record.taskId !== task.taskId) throw new Error('Confirmed cleanup receipt is missing or belongs to another Task.')
    if (record.phase === 'released') return { status: 'released', record, receipt: { revision: recordRevision, replay: true } }
    // On process restart or callback failure, the same durable record resumes this step.
    try { await this.onTaskReleased(task, record) } catch (error) { throw new CleanupReleaseError(task.taskId, record, error) }
    const released: CleanupRecord = { ...record, phase: 'released' }
    const receipt = await withSnapshot(this.files, checked => this.transactions.run('cleanup:' + task.taskId + ':released',
      { taskId: task.taskId }, { snapshot: checked, expectedRevision: checked.revision, reevaluate: true }, async () => [{ path: recordPath, content: encodeJson(released) }]))
    return { status: 'released', record: released, receipt }
  }
}
