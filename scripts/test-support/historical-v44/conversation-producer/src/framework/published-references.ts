// Reconstructed from the 55fe host bundle's published-references runtime module.
// Runtime behavior is retained; TypeScript types/imports/exports are reconstructed.
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

interface PublishedReferenceRecord { original: string; target: string; sha256: string; revision: string }

export async function readPublishedReference(files: FilesStore, snapshot: FilesSnapshot, id: string, original: string, historical = false): Promise<Uint8Array | undefined> {
  if (referenceTaskId(original) !== id) return undefined
  const task = await readTaskArchiveIdentity(files, snapshot, id)
  const record = await readJson<PublishedReferenceRecord>(files, snapshot, referenceIndex(task, original, historical))
  if (!record) return undefined
  if (record.original !== original || !filePath(record.target).startsWith((historical ? taskArchiveReadPath(task) : paths.archive(task)) + '/published/') || !record.revision)
    throw new Error('Published reference identity differs: ' + original)
  const bytes = await files.readBytes(snapshot, record.target)
  if (!bytes || hash(bytes) !== record.sha256) throw new Error('Published reference integrity differs: ' + original)
  return bytes
}
