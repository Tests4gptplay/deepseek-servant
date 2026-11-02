import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { ArtifactRef, Task } from '../contracts/task.js'
import type { LegacyCapture, MigrationManifest } from './legacy-migration.js'
import { decodeLegacySealedTask, LEGACY_BASELINE, legacyMigratedTaskId } from './legacy-record-export.js'
import { FrameworkTransactions } from './command-transactions.js'
import { LocalFiles } from './local-files.js'
import { RecordJournal } from '../application/record-journal.js'
import { TaskRecords, isSeparatedTask, type PreparedTask } from '../application/task-records.js'
import type { StoragePort } from '../contracts/ports.js'
import { paths } from './task-files.js'
import { FilesConflictError, filePath, withSnapshot, type FilesStore, type FilesSnapshot, type FileChange } from './transactions.js'

export interface CapturedLegacyArtifact { taskId: string; artifactId: string; sourcePath: string; bytes: Uint8Array }
export interface LegacyArtifactIssue { oldTaskId: string; id: string; sourcePath: string; detail: string; error?: unknown }
export interface LegacyArtifactReference extends Omit<LegacyArtifactIssue, 'error'> {
  taskId: string; sha256?: string; archivedPath?: string; status: 'pending' | 'archived' | 'unavailable'
}
export interface LegacyArtifactOptions { signal?: AbortSignal; onIssue?(issue: LegacyArtifactIssue): void }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const WINDOW = 1024 * 1024 // Transfer window, not a total-size retention limit.
type Manifest = MigrationManifest & { clearedTasks?: Array<{ oldId: string }> }
type Declaration = { task: Task; artifact: ArtifactRef }
interface Attached { version: 1; request: { migrationId: string; oldTaskId: string; artifact: ArtifactRef; sha256: string }; path: string; manifestPath: string; bytes: number }

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
      if (task?.schemaVersion !== 1 || task.id !== row.id || !task.workspace?.directory || !task.reports) throw new Error('Original Task workspace and identity are unavailable.')
      for (const artifact of legacyDeclaredArtifacts(task)) result.push({ task, artifact })
    } catch (error) { issue(options, row.id, '', '', error) }
  }
  return result
}
function issue(options: LegacyArtifactOptions, oldTaskId: string, id: string, sourcePath: string, error: unknown): LegacyArtifactIssue {
  if (options.signal?.aborted && (error === options.signal.reason
    || error instanceof Error && error.name === 'AbortError' && error.cause === options.signal.reason)) throw error
  const item = { oldTaskId, id, sourcePath, detail: error instanceof Error ? error.message : String(error), error }
  if (!options.onIssue) throw error
  options.onIssue(item); return item
}
async function captureOne(ctx: Pick<Context, 'fs'>, value: Declaration, signal?: AbortSignal): Promise<Uint8Array> {
  const { task, artifact } = value
  signal?.throwIfAborted()
  const root = await ctx.fs.resolve(task.workspace.directory, { signal })
  if ((await ctx.fs.stat(root, signal))?.type !== 'directory') throw new Error('Original Task workspace is not an existing directory.')
  const target = await ctx.fs.resolve(artifact.path, { cwd: task.workspace.directory, signal })
  // ctx.fs alone is not a permission pipeline. Enforce the actual old API's
  // canonical Task-workspace boundary before reading even one content byte.
  if (!ctx.fs.contains(root, target)) throw new Error('Original artifact is outside its Task workspace; retain its path/hash for explicit user access, not automatic import.')
  const before = await ctx.fs.stat(target, signal)
  if (!before || before.type !== 'file') throw new Error('Original artifact is not an existing regular file.')
  const chunks: Uint8Array[] = []; let offset = 0
  for (;;) {
    signal?.throwIfAborted()
    const chunk = await ctx.fs.readByteRange(target, { offset, length: WINDOW }, signal)
    if (chunk.byteLength > WINDOW) throw new Error('Filesystem returned more bytes than requested.')
    if (!chunk.byteLength) break
    chunks.push(chunk.slice()); offset += chunk.byteLength
  }
  const after = await ctx.fs.stat(target, signal)
  if (!after || after.type !== 'file' || after.version !== before.version || after.size !== before.size
    || after.size !== undefined && after.size !== offset) throw new Error('Original artifact changed while being captured.')
  signal?.throwIfAborted()
  const bytes = Buffer.concat(chunks, offset)
  if (artifact.sha256 && hash(bytes) !== artifact.sha256) throw new Error('Original artifact bytes differ from its recorded hash.')
  return bytes
}
/** Initial cutover capture. Never receives model-selected paths or allowOutside. */
export async function captureLegacyArtifacts(ctx: Pick<Context, 'fs'>, capture: LegacyCapture, options: LegacyArtifactOptions = {}): Promise<CapturedLegacyArtifact[]> {
  const result: CapturedLegacyArtifact[] = []
  for (const value of declarations(capture, options)) {
    try { result.push({ taskId: value.task.id, artifactId: value.artifact.id, sourcePath: value.artifact.path, bytes: await captureOne(ctx, value, options.signal) }) }
    catch (error) { issue(options, value.task.id, value.artifact.id, value.artifact.path, error) }
  }
  return result
}
function destination(taskId: string, artifact: ArtifactRef): string {
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
async function checkArchived(files: FilesStore, snapshot: FilesSnapshot, manifest: Manifest, value: Declaration, allBytes: boolean): Promise<string | undefined> {
  const taskId = legacyMigratedTaskId(manifest.id, value.task.id), reference = 'legacy-task/' + value.task.id + '/' + value.artifact.id
  const path = manifest.references[reference]
  if (!path) return undefined
  if (path !== destination(taskId, value.artifact) || !digest(manifest.referenceHashes[reference])) throw new Error('Archived legacy artifact has a different original identity.')
  const raw = await files.read(snapshot, artifactMetadataPath(path)), metadata = raw && JSON.parse(raw)
  if (!metadata || metadata.version !== 1 || metadata.taskId !== taskId || metadata.path !== path || metadata.manifestPath !== artifactMetadataPath(path)
    || metadata.sha256 !== manifest.referenceHashes[reference] || value.artifact.sha256 && metadata.sha256 !== value.artifact.sha256
    || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) throw new Error('Archived legacy artifact manifest is missing or inconsistent.')
  if (files instanceof LocalFiles) {
    // LocalFiles commits this exact SHA-256 and byte length with the bytes in
    // one SQLite transaction. Read only this artifact directory, not the tree.
    const entry = (await files.listDirectory(snapshot, path.slice(0, path.lastIndexOf('/') + 1))).find(entry => entry.path === path)
    if (!entry || entry.version !== metadata.sha256 || entry.bytes !== metadata.bytes) throw new Error('Archived legacy artifact bytes are missing or changed.')
  }
  if (allBytes || !(files instanceof LocalFiles)) {
    const bytes = await files.readBytes(snapshot, path)
    if (!bytes || bytes.byteLength !== metadata.bytes || hash(bytes) !== metadata.sha256) throw new Error('Archived legacy artifact bytes are missing or corrupt.')
  }
  return path
}
/** Explicit Archives only: original declared references remain discoverable
 * without inventing download URLs for paths outside the old read boundary. */
export async function listLegacyArtifactReferences(files: FilesStore, snapshot: FilesSnapshot, manifestPath: string): Promise<LegacyArtifactReference[]> {
  const { manifest, capture } = await preserved(files, snapshot, manifestPath), result: LegacyArtifactReference[] = []
  const values = declarations(capture, { onIssue: ({ error: _error, ...item }) => result.push({ ...item, taskId: legacyMigratedTaskId(manifest.id, item.oldTaskId), status: 'unavailable' }) })
  for (const value of values) {
    const base = { oldTaskId: value.task.id, taskId: legacyMigratedTaskId(manifest.id, value.task.id), id: value.artifact.id, sourcePath: value.artifact.path, sha256: value.artifact.sha256 }
    try {
      const archivedPath = await checkArchived(files, snapshot, manifest, value, false)
      result.push({ ...base, archivedPath, status: archivedPath ? 'archived' : 'pending', detail: archivedPath ? '' : 'Original declared path is not archived. Automatic import is limited to its original Task workspace; external paths require explicit user access.' })
    } catch (error) { result.push({ ...base, status: 'unavailable', detail: error instanceof Error ? error.message : String(error) }) }
  }
  return result
}
/** Complete original declared artifact preservation, including sealed histories
 * omitted from old pending-adapter indexes. The old cutover identity,
 * business Tasks, control state and original files are never replaced/deleted. */
export async function resumePendingLegacyArtifacts(ctx: Pick<Context, 'fs'>, files: FilesStore, transactions: FrameworkTransactions,
  manifestPath: string, options: LegacyArtifactOptions = {}): Promise<{ attached: string[]; pending: LegacyArtifactIssue[] }> {
  if (!(files instanceof LocalFiles)) throw new Error('Legacy filesystem artifact import is Local only.')
  const pending: LegacyArtifactIssue[] = [], observed = { ...options, onIssue: (item: LegacyArtifactIssue) => { pending.push(item); options.onIssue?.(item) } }
  const original = await withSnapshot(files, snapshot => preserved(files, snapshot, manifestPath)), attached: string[] = []
  for (const value of declarations(original.capture, observed)) {
    options.signal?.throwIfAborted()
    const marker = 'artifact-bytes:' + value.task.id + ':' + value.artifact.id
    const identity = hash(json([original.manifest.id, value.task.id, value.artifact]))
    const command = 'legacy-artifact:' + identity, receiptPath = 'technical/legacy-artifacts/' + identity + '.json'
    try {
      const existingReceipt = await withSnapshot(files, snapshot => files.read(snapshot, receiptPath))
      if (existingReceipt === undefined && !original.manifest.pendingAdapters.includes(marker)
        && await withSnapshot(files, snapshot => checkArchived(files, snapshot, original.manifest, value, false))) continue
      const request = { migrationId: original.manifest.id, oldTaskId: value.task.id,
        workspace: value.task.workspace, artifact: value.artifact }
      const verify = async (snapshot: FilesSnapshot, fullBytes: boolean): Promise<string> => {
        // The declaration was established by the original fixed source view.
        // Verification owns current attachment metadata/bytes, not another
        // reconstruction of every original Task for each artifact.
        const manifest = await readManifest(files, snapshot, manifestPath)
        const path = await checkArchived(files, snapshot, manifest, value, fullBytes)
        const raw = await files.read(snapshot, receiptPath), receipt = raw && JSON.parse(raw) as Attached
        if (!path || manifest.pendingAdapters.includes(marker) || !receipt || receipt.version !== 1 || receipt.path !== path
          || receipt.manifestPath !== artifactMetadataPath(path) || receipt.request.migrationId !== manifest.id || receipt.request.oldTaskId !== value.task.id
          || json(receipt.request.artifact) !== json(value.artifact) || receipt.request.sha256 !== manifest.referenceHashes['legacy-task/' + value.task.id + '/' + value.artifact.id])
          throw new Error('Legacy artifact read-back has not confirmed its original preservation request.')
        return path
      }
      // Acknowledgement alone is not caller readback. Pair the existing command
      // fact with current authoritative Local content identities; UNKNOWN has
      // no confirmed record and must take the full run/readback path below.
      if (await transactions.confirmed(command, request)) {
        attached.push(await withSnapshot(files, snapshot => verify(snapshot, false)))
        continue
      }
      // Stable declared request, not a fresh byte hash. FrameworkTransactions
      // resolves the original authoritative receipt before entering this builder.
      const apply = () => transactions.run(command, request, { reevaluate: true }, async snapshot => {
        const { manifest, capture } = await preserved(files, snapshot, manifestPath)
        const actual = declarations(capture, observed).find(item => item.task.id === value.task.id && item.artifact.id === value.artifact.id)
        if (!actual || json(actual) !== json(value)) throw new Error('Original artifact declaration changed; retain its same operation.')
        if (await files.read(snapshot, receiptPath) !== undefined) throw new Error('Legacy artifact exists without its matching transaction receipt.')
        const bytes = await captureOne(ctx, actual, options.signal), sha256 = hash(bytes)
        const taskId = legacyMigratedTaskId(manifest.id, value.task.id), path = destination(taskId, value.artifact), metadataPath = artifactMetadataPath(path)
        const existing = await files.readBytes(snapshot, path)
        if (existing && hash(existing) !== sha256) throw new Error('Artifact destination already contains different bytes.')
        const name = value.artifact.path.split(/[\\/]/).at(-1) || value.artifact.id
        const metadata = { version: 1, taskId, path, manifestPath: metadataPath, name, sha256, bytes: bytes.byteLength }
        const priorMetadata = await files.read(snapshot, metadataPath)
        if (priorMetadata !== undefined && json(JSON.parse(priorMetadata)) !== json(metadata)) throw new Error('Artifact destination metadata already differs.')
        for (const reference of [value.artifact.path, value.artifact.id]) {
          const qualified = 'legacy-task/' + value.task.id + '/' + reference
          manifest.references[qualified] = path; manifest.referenceHashes[qualified] = sha256
          const ambiguous = 'Legacy artifact reference is task-scoped and ambiguous without its Task: ' + reference
          if (manifest.issues.includes(ambiguous)) continue
          if (manifest.references[reference] && manifest.referenceHashes[reference] !== sha256) {
            delete manifest.references[reference]; delete manifest.referenceHashes[reference]; manifest.issues.push(ambiguous)
          } else { manifest.references[reference] = path; manifest.referenceHashes[reference] = sha256 }
        }
        manifest.pendingAdapters = manifest.pendingAdapters.filter(item => item !== marker)
        const changes: FileChange[] = [{ path, bytes }, { path: metadataPath, content: json(metadata) },
          { path: receiptPath, content: json({ version: 1, request: { migrationId: manifest.id, oldTaskId: value.task.id, artifact: value.artifact, sha256 }, path, manifestPath: metadataPath, bytes: bytes.byteLength } satisfies Attached) },
          { path: manifestPath, content: json(manifest) }]
        for (const task of manifest.tasks) changes.push({ path: task.recordPath.replace(/task.json$/, 'references.json'), content: json(manifest.references) })
        options.signal?.throwIfAborted(); return changes
      })
      for (;;) {
        options.signal?.throwIfAborted()
        try { await apply(); break }
        catch (error) {
          if (!(error instanceof FilesConflictError)
            || await withSnapshot(files, async snapshot => snapshot.revision) === error.expectedRevision) throw error
          // A real new authority permits reevaluating this same declared command.
          // Its builder rechecks source ownership, permission, hash and targets;
          // UNKNOWN and ordinary errors never authorize another dispatch.
        }
      }
      attached.push(await withSnapshot(files, snapshot => verify(snapshot, true)))
    } catch (error) { issue(observed, value.task.id, value.artifact.id, value.artifact.path, error) }
  }
  return { attached, pending }
}
