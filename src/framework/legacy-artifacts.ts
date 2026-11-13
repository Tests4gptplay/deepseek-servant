// Reconstructed from d19 source and the verified 55fe legacy-artifacts runtime module.
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { ArtifactRef, Task } from '../contracts/task.js'
import type { LegacyCapture, MigrationManifest } from './legacy-migration.js'
import { decodeLegacySealedTask, LEGACY_BASELINE, legacyMigratedTaskId } from './legacy-record-export.js'
import { RecordJournal } from '../application/record-journal.js'
import { TaskRecords, isSeparatedTask, type PreparedTask } from '../application/task-records.js'
import type { StoragePort } from '../contracts/ports.js'
import { paths } from './task-files.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { filePath, type FilesStore, type FilesSnapshot } from './transactions.js'

export interface LegacyArtifactIssue { oldTaskId: string; id: string; sourcePath: string; detail: string; error?: unknown }
export interface LegacyArtifactReference extends Omit<LegacyArtifactIssue, 'error'> {
  taskId: string; sha256?: string; archivedPath?: string; originalAbsolutePath?: string; status: 'pending' | 'archived' | 'unavailable'
}
interface LegacyArtifactOptions { onIssue?(issue: LegacyArtifactIssue): void }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
type Manifest = MigrationManifest & { clearedTasks?: Array<{ oldId: string }> }
type Declaration = { task: Task; artifact: ArtifactRef }

/** Same declared union as baseline openArtifact. Conflicting ids are not a
 * license to choose whichever file happens to be readable. */
export function legacyDeclaredArtifacts(task: Task): ArtifactRef[] {
  const found = new Map<string, ArtifactRef>()
  for (const artifact of [...(task.delivery?.artifacts ?? []), ...Object.values(task.reports).flatMap(report => report.artifacts)]) {
    if (!artifact || typeof artifact.id !== 'string' || !artifact.id || typeof artifact.path !== 'string' || !artifact.path
      || artifact.sha256 !== undefined && !digest(artifact.sha256)) throw new Error('Invalid original legacy artifact declaration: ' + task.id)
    const prior = found.get(artifact.id)
    if (prior && (prior.path !== artifact.path || prior.sha256 && artifact.sha256 && prior.sha256 !== artifact.sha256))
      throw new Error('Ambiguous original legacy artifact id: ' + task.id + ':' + artifact.id)
    found.set(artifact.id, { ...artifact, ...(prior?.sha256 ? { sha256: prior.sha256 } : {}) })
  }
  return [...found.values()]
}
function declarations(capture: LegacyCapture, options: LegacyArtifactOptions): Declaration[] {
  if (capture.mode !== 'local') return []
  const result: Declaration[] = []
  for (const row of capture.tasks) {
    const task = row.original as Task
    try {
      if (task?.schemaVersion !== 1 || task.id !== row.id || !task.reports) throw new Error('Original Task identity and report declarations are unavailable.')
      for (const artifact of legacyDeclaredArtifacts(task)) result.push({ task, artifact })
    } catch (error) { issue(options, row.id, '', '', error) }
  }
  return result
}
function issue(options: LegacyArtifactOptions, oldTaskId: string, id: string, sourcePath: string, error: unknown): LegacyArtifactIssue {
  const item = { oldTaskId, id, sourcePath, detail: error instanceof Error ? error.message : String(error), error }
  if (!options.onIssue) throw error
  options.onIssue(item); return item
}
function expectedArchivedPath(taskId: string, artifact: ArtifactRef): string {
  const name = artifact.path.split(/[\\/]/).at(-1) || artifact.id
  return paths.archive(taskId) + '/legacy/artifacts/' + hash(artifact.path) + '/' + encodeURIComponent(name)
}
async function readManifest(files: FilesStore, snapshot: FilesSnapshot, manifestPath: string): Promise<Manifest> {
  const match = /^technical\/legacy-migrations\/([^/]+)\/manifest.json$/.exec(filePath(manifestPath))
  const raw = match && await files.read(snapshot, manifestPath), manifest = raw && JSON.parse(raw) as Manifest
  if (!manifest || manifest.version !== 1 || manifest.id !== match![1] || manifest.baseline !== LEGACY_BASELINE || manifest.source.mode !== 'local'
    || !Array.isArray(manifest.records) || !Array.isArray(manifest.tasks) || !Array.isArray(manifest.pendingAdapters)) throw new Error('A preserved Local migration manifest is required.')
  return manifest
}
async function preserved(files: FilesStore, snapshot: FilesSnapshot, manifestPath: string): Promise<{ manifest: Manifest; capture: LegacyCapture }> {
  const manifest = await readManifest(files, snapshot, manifestPath)
  const root = manifestPath.slice(0, -'/manifest.json'.length), index = new Map<string, Manifest['records'][number]>()
  for (const record of manifest.records) {
    if (index.has(record.key)) throw new Error('Original legacy source record identity is ambiguous.')
    index.set(record.key, record)
  }
  // The manifest supplies only a metadata index. Verify and decode original
  // bytes on demand, never scan unrelated conversation/knowledge/document bodies.
  const decoded = new Map<string, unknown>()
  const read = async <T>(key: string): Promise<T | undefined> => {
    if (decoded.has(key)) return decoded.get(key) as T
    const record = index.get(key)
    if (!record) return undefined
    if (record.path !== root + '/source/' + hash(record.key) + '.bin' || !digest(record.sha256)
      || manifest.references[record.key] !== record.path || manifest.referenceHashes[record.key] !== record.sha256) throw new Error('Original legacy source record identity is ambiguous.')
    const bytes = await files.readBytes(snapshot, record.path)
    if (!bytes || hash(bytes) !== record.sha256) throw new Error('Original legacy source record is missing or corrupt: ' + record.key)
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    decoded.set(key, value); return value as T
  }
  const ids = new Set<string>()
  for (const key of index.keys()) {
    if (key.startsWith('task:')) ids.add(key.slice(5))
    else if (key.startsWith('task-history/')) {
      const id = decodeURIComponent(key.slice('task-history/'.length))
      if (key !== 'task-history/' + encodeURIComponent(id)) throw new Error('Invalid original history identity.')
      ids.add(id)
    } else if (/^task-staging\/[^/]+\/commit$/.test(key)) ids.add(decodeURIComponent(key.split('/')[1]!))
  }
  const capture: LegacyCapture = { mode: 'local', baseline: LEGACY_BASELINE, revision: manifest.source.revision, records: [], texts: [], tasks: [], issues: [] }
  for (const id of ids) {
    if (manifest.clearedTasks?.some(item => item.oldId === id)) continue
    let value = await read<Task>('task:' + id)
    const staged = await read<PreparedTask>('task-staging/' + encodeURIComponent(id) + '/commit')
    const overlay = new Map<string, unknown>(), prefix = 'worker-reply/' + encodeURIComponent(id) + '/', archivePrefix = 'record-archive/' + encodeURIComponent(id) + '/'
    const reportStorage: StoragePort = {
      get: async <T>(key: string) => {
        if (!key.startsWith(prefix) && !key.startsWith(archivePrefix)) throw new Error('Original report reference escapes its Task.')
        return overlay.has(key) ? overlay.get(key) as T : read<T>(key)
      },
      set: async (key, value) => { if (!key.startsWith(prefix)) throw new Error('Staged report escaped its original Task.'); overlay.set(key, value) },
      list: async <T>(requested: string) => {
        if (!requested.startsWith(prefix) && !requested.startsWith(archivePrefix)) return []
        const keys = new Set([...index.keys(), ...overlay.keys()].filter(key => key.startsWith(requested) && key.includes('/entry/')))
        const rows: Array<{ key: string; value: T }> = []
        for (const key of keys) { const value = overlay.has(key) ? overlay.get(key) as T : await read<T>(key); if (value !== undefined) rows.push({ key, value }) }
        return rows
      },
    }
    const records = new TaskRecords(new RecordJournal(reportStorage))
    if (staged) {
      if (staged.schemaVersion !== 1 || staged.root?.id !== id) throw new Error('Invalid original pending Task record.')
      if ((value?.revision ?? 0) < staged.root.revision) {
        if ((value?.revision ?? 0) !== staged.expectedRevision) throw new Error('Original Task staging revision differs.')
        await records.write({ ...staged, writes: staged.writes.filter(write => write.metadata?.field === 'reports') })
        value = staged.root as Task
      }
    }
    let task: Task | undefined
    if (value && (value as unknown as { kind?: string }).kind !== 'task-tombstone') {
      task = isSeparatedTask(value) ? await records.hydrate({ ...value, recordsLayout: { ...value.recordsLayout,
        fields: value.recordsLayout.fields.filter(field => field === 'reports'), counts: { reports: value.recordsLayout.counts?.reports } } }) : value
    } else {
      const history = await read<{ schemaVersion: number; taskId: string; deleting?: boolean }>('task-history/' + encodeURIComponent(id))
      if (!history || history.deleting) continue
      if (history.schemaVersion !== 1 || history.taskId !== id) throw new Error('Invalid original Task history identity.')
      task = await decodeLegacySealedTask(await read('records/' + encodeURIComponent(id) + '/manifest'), id, read) as unknown as Task
      if (task.phase !== 'completed' && task.phase !== 'cancelled' && task.control !== 'cancelled') throw new Error('Historical artifact declaration has no terminal Task identity.')
    }
    if (!task || task.schemaVersion !== 1 || task.id !== id) throw new Error('Original Task identity is missing or corrupt.')
    capture.tasks.push({ id, original: task, continuation: 'unresolved', request: '', participants: [] })
  }
  return { manifest, capture }
}
function artifactMetadataPath(path: string): string { return 'technical/artifacts/manifests/' + hash(path) + '.json' }
async function checkArchived(files: FilesStore, snapshot: FilesSnapshot, manifest: Manifest, value: Declaration): Promise<string | undefined> {
  const taskId = legacyMigratedTaskId(manifest.id, value.task.id), reference = 'legacy-task/' + value.task.id + '/' + value.artifact.id
  const path = manifest.references[reference]
  if (!path) return undefined
  if (path !== expectedArchivedPath(taskId, value.artifact) || !digest(manifest.referenceHashes[reference])) throw new Error('Archived legacy artifact has a different original identity.')
  const raw = await files.read(snapshot, artifactMetadataPath(path)), metadata = raw && JSON.parse(raw)
  if (!metadata || metadata.version !== 1 || metadata.taskId !== taskId || metadata.path !== path || metadata.manifestPath !== artifactMetadataPath(path)
    || metadata.sha256 !== manifest.referenceHashes[reference] || value.artifact.sha256 && metadata.sha256 !== value.artifact.sha256
    || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) throw new Error('Archived legacy artifact manifest is missing or inconsistent.')
  if (files instanceof PhysicalLocalFiles) {
    // The captured digest identifies the original import, not later edits to
    // this user-editable Local file. Still require an actual ordinary file.
    if (!await files.fileInfo(path)) throw new Error('Archived legacy artifact file is missing.')
    return path
  }
  const bytes = await files.readBytes(snapshot, path)
  if (!bytes || bytes.byteLength !== metadata.bytes || hash(bytes) !== metadata.sha256) throw new Error('Archived legacy artifact bytes are missing or corrupt.')
  return path
}
const historicalText = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\u0000-\u001f\u007f]/u.test(value)
const windowsAbsolute = (value: string): boolean => /^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value)
function originalAbsolutePath(source: unknown, workspace: unknown): string | undefined {
  if (!historicalText(source) || /^[a-z][a-z0-9+.-]*:/iu.test(source) && !windowsAbsolute(source)) return undefined
  const hasParent = source.split(/[\\/]/u).includes('..')
  if (!hasParent && (windowsAbsolute(source) || posix.isAbsolute(source))) return source
  if (!historicalText(workspace)) return undefined
  const syntax = windowsAbsolute(workspace) ? win32 : posix.isAbsolute(workspace) ? posix : undefined
  if (!syntax || /^[a-z]:(?![\\/])/iu.test(source) || source.startsWith('\\') && !windowsAbsolute(source)) return undefined
  if (windowsAbsolute(source) && syntax !== win32 || posix.isAbsolute(source) && !windowsAbsolute(source) && syntax !== posix) return undefined
  if (syntax === posix && source.includes('\\')) return undefined
  const root = syntax.resolve(workspace), absolute = syntax.resolve(root, source), relative = syntax.relative(root, absolute)
  if (!relative || syntax.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + syntax.sep)) return undefined
  return absolute
}
/** Explicit Archives only: original declared references remain discoverable
 * without inventing download URLs for paths outside the old read boundary. */
export async function listLegacyArtifactReferences(files: FilesStore, snapshot: FilesSnapshot, manifestPath: string): Promise<LegacyArtifactReference[]> {
  const { manifest, capture } = await preserved(files, snapshot, manifestPath), result: LegacyArtifactReference[] = []
  const values = declarations(capture, { onIssue: ({ error: _error, ...item }) => result.push({ ...item, taskId: legacyMigratedTaskId(manifest.id, item.oldTaskId), status: 'unavailable' }) })
  for (const value of values) {
    const base = { oldTaskId: value.task.id, taskId: legacyMigratedTaskId(manifest.id, value.task.id), id: value.artifact.id, sourcePath: value.artifact.path, sha256: value.artifact.sha256, originalAbsolutePath: originalAbsolutePath(value.artifact.path, value.task.workspace?.directory) }
    try {
      const archivedPath = await checkArchived(files, snapshot, manifest, value)
      result.push({ ...base, archivedPath, status: archivedPath ? 'archived' : 'pending', detail: archivedPath ? '' : 'Original declaration is preserved but not imported. A historical address does not verify current existence or authorize opening it on this Host.' })
    } catch (error) { result.push({ ...base, status: 'unavailable', detail: error instanceof Error ? error.message : String(error) }) }
  }
  return result
}
