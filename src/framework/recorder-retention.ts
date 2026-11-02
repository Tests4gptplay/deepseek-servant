import { createHash } from 'node:crypto'
import type { RetentionManifest } from './cleaner.js'
import { filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'
import { encodeJson, paths, taskIdentity, type TaskMetadata } from './task-files.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const within = (path: string, root: string) => path === root || path.startsWith(root + '/')
export function taskWorkingRoots(task: TaskMetadata): string[] {
  return [paths.run(task.taskId), 'Recorder Cache/' + task.taskId, 'technical/recovery-inputs/' + task.taskId,
    ...new Set([task.owner, ...(task.members ?? [])].map(member => paths.state(member, task.taskId)))]
}
export function taskStateSignal(task: TaskMetadata, path: string, bytes: Uint8Array): boolean {
  return [...new Set([task.owner, ...(task.members ?? [])])].some(member => within(path, paths.state(member, task.taskId)))
    && (bytes.byteLength === 0 || /^(recovery|Cleaner|complete|running|(?:Foreground|Planner|Worker|Organizer|Recorder|Helper)(?:_.*)?)$/.test(path.split('/').at(-1)!))
}
export function archivedReference(manifest: RetentionManifest, original: string): string[] {
  const exact = manifest.relocatedReferences?.[original]
  if (exact) return [exact]
  return Object.entries(manifest.relocatedReferences ?? {}).filter(([path]) => within(path, original)).map(([, path]) => path)
}
/** Copy authoritative bytes, never generate a summary or reinterpret native files.
 * The caller persists this plan with its archive and verifies it before cleanup. */
export async function prepareRecorderRetention(files: FilesStore, snapshot: FilesSnapshot, task: TaskMetadata,
  manifest: RetentionManifest, staged: readonly FileChange[] = []): Promise<{ changes: FileChange[]; task: TaskMetadata; retention: RetentionManifest; relocated: boolean }> {
  const changes = new Map(staged.map(change => [change.path, change]))
  const roots = taskWorkingRoots(task), mapping = { ...manifest.relocatedReferences }, sources = { ...manifest.relocatedSources }
  // This invocation owns one immutable snapshot. Reuse only its reads; staged
  // writes take precedence and no values survive into a later prepare/readback.
  const reads = new Map<string, Promise<Uint8Array | undefined>>()
  const read = async (path: string) => {
    const change = changes.get(path)
    if (change) return change.bytes ?? (change.content === null ? undefined : Buffer.from(change.content!, 'utf8'))
    let pending = reads.get(path)
    if (!pending) { pending = files.readBytes(snapshot, path); reads.set(path, pending) }
    return pending
  }
  const ownSource = /^tasks\/[^/]+_(P|O)\.md$/.test(task.sourcePath)
    && taskIdentity(await files.read(snapshot, task.sourcePath) ?? '') === task.taskId
  const working = (path: string) => roots.some(root => within(path, root)) || (ownSource && path === task.sourcePath)
  let relocated = false
  const expandReference = async (reference: string): Promise<string[]> => {
    const path = filePath(reference), bytes = await read(path)
    // LocalFiles rejects file/descendant coexistence, as Git trees do.
    const listed = bytes === undefined ? await files.list(snapshot, path + '/') : []
    const entries = [...new Set([...(bytes === undefined ? [] : [path]), ...listed.map(entry => entry.path)])]
    // Preserve unresolved references through the save transaction: authored output
    // and withdrawal of an older Cleaner remain durable. Readback rejects them.
    if (!entries.length) return [path]
    const result: string[] = []
    for (const source of entries) {
      if (!working(source)) { result.push(source); continue }
      const value = await read(source)
      if (value === undefined) throw new Error('Retained reference is missing: ' + source)
      relocated = true
      const leaf = source.split('/').at(-1)!
      // State's control signals are not user artifacts, even when a legacy
      // manifest retained their parent directory. Never archive an R/Cleaner.
      if (taskStateSignal(task, source, value)) continue
      const destination = paths.archive(task.taskId) + '/retained/' + hash(source) + '/' + hash(value) + '/' + leaf
      const prior = await read(destination)
      if (prior !== undefined && hash(prior) !== hash(value)) throw new Error('Archived retained reference already differs: ' + destination)
      if (prior === undefined) changes.set(destination, { path: destination, bytes: value })
      mapping[source] = destination; sources[destination] = { sourcePath: source, sourceRevision: snapshot.revision, sha256: hash(value) }; result.push(destination)
    }
    return [...new Set(result)]
  }
  const expansions = new Map<string, Promise<string[]>>()
  const expand = (reference: string): Promise<string[]> => {
    const path = filePath(reference)
    let pending = expansions.get(path)
    if (!pending) { pending = expandReference(path); expansions.set(path, pending) }
    return pending
  }
  const outputs = [...new Set((await Promise.all(manifest.outputs.map(expand))).flat())]
  const retainedPaths = [...new Set((await Promise.all(manifest.retainedPaths.map(expand))).flat())]
  const resultPaths = task.resultPaths ? [...new Set((await Promise.all(task.resultPaths.map(expand))).flat())] : undefined
  const updated = { ...task, ...(resultPaths ? { resultPaths } : {}) }
  if (JSON.stringify(task.resultPaths) !== JSON.stringify(resultPaths)) changes.set(paths.task(task.taskId), { path: paths.task(task.taskId), content: encodeJson(updated) })
  const references = [...new Set([...outputs, ...retainedPaths, ...(resultPaths ?? [])])], verifiedReferences: Record<string, string> = {}
  for (const path of references) {
    const bytes = await read(path)
    if (bytes !== undefined) verifiedReferences[path] = hash(bytes)
  }
  return { changes: [...changes.values()], task: updated, relocated,
    retention: { ...manifest, outputs, retainedPaths: [...new Set([...retainedPaths, ...(resultPaths ?? [])])], verifiedReferences,
      ...(Object.keys(mapping).length ? { relocatedReferences: mapping, relocatedSources: sources } : {}) } }
}

/** Exact legacy link lookup, scoped by an already-known Task identity. Never
 * scans other archives or guesses the owner of an old submission filename. */
export async function readArchivedReference(files: FilesStore, snapshot: FilesSnapshot, taskId: string,
  originalPath: string): Promise<Uint8Array | undefined> {
  filePath(originalPath)
  const root = paths.archive(taskId), raw = await files.read(snapshot, root + '/retention.json')
  if (raw === undefined) return undefined
  const manifest = JSON.parse(raw) as RetentionManifest
  const target = manifest.relocatedReferences?.[originalPath]
  if (target === undefined) return undefined
  if (typeof target !== 'string' || !filePath(target).startsWith(root + '/')) throw new Error('Archived reference escapes its Task: ' + originalPath)
  const expected = manifest.verifiedReferences?.[target]
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Archived reference lacks verified content: ' + originalPath)
  const bytes = await files.readBytes(snapshot, target)
  if (bytes === undefined || hash(bytes) !== expected) throw new Error('Archived reference integrity differs: ' + originalPath)
  const source = manifest.relocatedSources?.[target]
  if (!source || source.sourcePath !== originalPath || source.sha256 !== expected || typeof source.sourceRevision !== 'string' || !source.sourceRevision) throw new Error('Archived reference source identity differs: ' + originalPath)
  return bytes
}
