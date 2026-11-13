// Reconstructed from the 55fe host bundle's published-references runtime module.
// Runtime behavior is retained; TypeScript types/imports/exports are reconstructed.
import { readTaskReferenceIdentity } from './task-history.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { readTaskArchiveIdentity, taskArchiveReadPath } from './task-archive.js'
import { createHash } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { markdownDestinationRange } from './markdown-destination.js'
import { encodeJson, paths, readJson, type TaskMetadata } from './task-files.js'
import { filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

export function referenceTaskId(path: string): string | undefined {
  return /^(?:task-runs|Recorder Cache|technical\/recovery-inputs)\/([^/]+)\//.exec(path)?.[1]
    ?? /^state\/[^/]+\/([^/]+)\//.exec(path)?.[1]
}

export function taskReference(taskId: string, original: string): string {
  if (filePath(taskId).includes('/')) throw new Error('Invalid Task identity.')
  return 'task-references/' + taskId + '/' + encodeURIComponent(filePath(original))
}

export function parseTaskReference(path: string): { taskId: string; original: string } | undefined {
  const match = /^task-references\/([^/]+)\/([^/]+)$/.exec(path)
  return match ? { taskId: filePath(match[1]), original: filePath(decodeURIComponent(match[2])) } : undefined
}

interface MarkdownNode {
  type: string
  url?: unknown
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

export function materialLinks(text: string): Array<{ path: string; start: number; end: number }> {
  const links: Array<{ path: string; start: number; end: number }> = []
  const visit = (node: MarkdownNode): void => {
    if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string') {
      const range = markdownDestinationRange(text, node)
      if (range) links.push({ path: node.url, ...range })
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(fromMarkdown(text))
  return links
}

const referenceIndex = (task: Pick<TaskMetadata, 'taskId' | 'archiveFolder'> & Partial<Pick<TaskMetadata, 'sourcePath'>>, original: string, historical = false): string => (historical ? taskArchiveReadPath(task) : paths.archive(task)) + '/published-links/' + hash(original) + '.json'

export async function preservePublishedReferences(files: FilesStore, snapshot: FilesSnapshot, text: string): Promise<FileChange[]> {
  const changes = new Map<string, FileChange>()
  const tasks = new Map<string, TaskMetadata | undefined>()
  // Repeated Markdown destinations preserve the same source, not another copy.
  // This reuse belongs only to this immutable publication snapshot.
  for (const original of new Set(materialLinks(text).map(link => link.path))) {
    const id = referenceTaskId(original)
    if (!id) continue
    filePath(original)
    if (!tasks.has(id)) tasks.set(id, await readJson<TaskMetadata>(files, snapshot, paths.task(id)))
    const task = tasks.get(id)
    if (!task || task.taskId !== id) continue
    const bytes = await files.readBytes(snapshot, original)
    if (bytes === undefined) continue
    const sha256 = hash(bytes), originalHash = hash(original)
    const target = paths.archive(task) + '/published/' + originalHash + '/' + sha256 + '/' + original.split('/').at(-1)
    const index = paths.archive(task) + '/published-links/' + originalHash + '.json'
    changes.set(target, { path: target, bytes })
    changes.set(index, { path: index, content: encodeJson({ original, target, sha256, revision: snapshot.revision }) })
  }
  return [...changes.values()]
}

/** Preserve only actual task-working-file links already selected by an assistant
 * reply. The existing published-link record names the unfinished copy while it
 * exists; it is not a command journal or a reason for Cleaner to wait. */
const physicalReferenceWrites = new Map<string, Promise<void>>()
export async function preservePhysicalPublishedReferences(files: PhysicalLocalFiles, snapshot: FilesSnapshot, text: string): Promise<void> {
  for (const original of new Set(materialLinks(text).map(link => link.path))) {
    const id = referenceTaskId(original)
    if (!id) continue
    filePath(original)
    const task = await readTaskReferenceIdentity(files, snapshot, id)
    if (!task || task.taskId !== id) continue
    const index = referenceIndex(task, original), physical = files.directory + '/' + index
    const key = process.platform === 'win32' ? physical.toLowerCase() : physical
    const publication = (physicalReferenceWrites.get(key) ?? Promise.resolve()).then(async () => {
      type Publication = Partial<PublishedReferenceRecord> & { pending?: PublishedReferenceRecord }
      let record = await readJson<Publication>(files, snapshot, index)
      if (record?.pending) {
        const pending = record.pending
        if (pending.original !== original || !pending.target.startsWith(paths.archive(task) + '/published/'))
          throw new Error('Unfinished published reference belongs to another original.')
        let target = await files.readBytes(snapshot, pending.target)
        if (target === undefined) {
          const source = await files.readBytes(snapshot, original)
          if (source === undefined || hash(source) !== pending.sha256)
            throw new Error('The original of an unfinished published reference is no longer available: ' + original)
          await files.replace(pending.target, source)
          target = source
        }
        if (hash(target) !== pending.sha256) throw new Error('Unfinished published reference integrity differs: ' + original)
        await files.replace(index, encodeJson(pending))
        record = pending
      }
      const source = await files.readBytes(snapshot, original)
      if (source === undefined) return // Existing durable reference remains authoritative after task cleanup.
      const sha256 = hash(source), target = paths.archive(task) + '/published/' + hash(original) + '/' + sha256 + '/' + original.split('/').at(-1)
      if (record?.original === original && record.target === target && record.sha256 === sha256) {
        const saved = await files.readBytes(snapshot, target)
        if (saved !== undefined) return // Keep later ordinary edits to the preserved physical original.
      }
      const pending: PublishedReferenceRecord = { original, target, sha256, revision: snapshot.revision }
      await files.replace(index, encodeJson({ ...record, pending }))
      await files.replace(target, source)
      await files.replace(index, encodeJson(pending))
    })
    const settled = publication.then(() => {}, () => {})
    physicalReferenceWrites.set(key, settled)
    void settled.then(() => { if (physicalReferenceWrites.get(key) === settled) physicalReferenceWrites.delete(key) })
    await publication
  }
}

interface PublishedReferenceRecord { original: string; target: string; sha256: string; revision: string }

export async function readPublishedReference(files: FilesStore, snapshot: FilesSnapshot, id: string, original: string, historical = false): Promise<Uint8Array | undefined> {
  if (referenceTaskId(original) !== id) return undefined
  const task = await readTaskArchiveIdentity(files, snapshot, id)
  const record = await readJson<PublishedReferenceRecord>(files, snapshot, referenceIndex(task, original, historical))
  if (!record) return undefined
  if (record.original !== original || !filePath(record.target).startsWith((historical ? taskArchiveReadPath(task) : paths.archive(task)) + '/published/') || !record.revision)
    throw new Error('Published reference identity differs: ' + original)
  const bytes = await files.readBytes(snapshot, record.target)
  if (!bytes || !(files instanceof PhysicalLocalFiles) && hash(bytes) !== record.sha256) throw new Error('Published reference integrity differs: ' + original)
  return bytes
}
