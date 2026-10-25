import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type { RecordEntry, RecordPart } from '../contracts/records.js'
import type { Task } from '../contracts/task.js'
import type { TaskTombstone } from '../contracts/retention.js'
import { archivedRecordKey, canonicalJson, RecordJournal, taskRecordPrefixes } from './record-journal.js'

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const root = (id: string) => 'records/' + encodeURIComponent(id) + '/'
const indexKey = (id: string) => 'task-history/' + encodeURIComponent(id)
function fence(text: string): string {
  let length = 3
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  return '`'.repeat(length)
}
type Segment = { text: string } | { parts: RecordPart[] }
export interface SealedTaskRecords {
  schemaVersion: 1
  state: 'sealed'
  taskId: string
  taskRevision: number
  stage: 'accepted' | 'ended'
  sealedAt: string
  snapshot: RecordPart[]
  document: Segment[]
  sha256: string
  characters: number
  bytes: number
  copiedRefs: string[]
  cleanupKeys: string[]
}
export interface TaskHistoryIndex {
  schemaVersion: 1
  taskId: string
  assistantId: string
  workspaceId: string
  objective: string
  updatedAt: string
  stage: SealedTaskRecords['stage']
  taskRevision: number
  hidden?: boolean
  tombstone?: TaskTombstone
  cleanedAt?: string
  deliveryReadAt?: string
}

/** Permanent, same-domain records. Sealing reads the stored parts before publishing its manifest. */
export class TaskArchiveStore {
  readonly journal: RecordJournal
  constructor(readonly storage: StoragePort, private readonly now: () => string = () => new Date().toISOString()) {
    this.journal = new RecordJournal(storage, now)
  }
  async manifest(id: string): Promise<SealedTaskRecords | undefined> { return this.storage.get(root(id) + 'manifest') }
  async index(id: string): Promise<TaskHistoryIndex | undefined> { return this.storage.get(indexKey(id)) }
  async list(): Promise<TaskHistoryIndex[]> { return (await this.storage.list<TaskHistoryIndex>('task-history/')).map(row => row.value).filter(row => row.schemaVersion === 1 && !!row.taskId) }
  private async parts(id: string, text: string): Promise<RecordPart[]> {
    const parts: RecordPart[] = []
    for (let offset = 0; offset < text.length || !parts.length;) {
      let end = Math.min(text.length, offset + 65536)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
      const body = text.slice(offset, end), sha256 = hash(body), key = root(id) + 'content/' + sha256
      if (!await this.storage.get(key)) await this.storage.set(key, { schemaVersion: 1, text: body })
      parts.push({ key, characters: body.length, bytes: Buffer.byteLength(body, 'utf8'), sha256 })
      offset = end
      if (end === text.length) break
    }
    return parts
  }
  private async text(part: RecordPart): Promise<string> {
    const value = await this.storage.get<{ text: string }>(part.key)
    if (!value || hash(value.text) !== part.sha256 || value.text.length !== part.characters
      || Buffer.byteLength(value.text, 'utf8') !== part.bytes) throw new Error('Archive part readback failed: ' + part.key)
    return value.text
  }
  async seal(task: Task, stage: SealedTaskRecords['stage']): Promise<SealedTaskRecords> {
    const previous = await this.manifest(task.id)
    const published = await this.index(task.id)
    if (previous?.taskRevision === task.revision && previous.stage === stage && published?.taskRevision === task.revision && published.stage === stage) return previous
    const rows = (await Promise.all([...taskRecordPrefixes(task.id), 'task-origin/' + encodeURIComponent(task.id) + '/']
      .map(prefix => this.storage.list<unknown>(prefix)))).flat()
    const entries = rows.filter(row => (row.value as RecordEntry)?.kind === 'servant-record-entry')
      .map(row => ({ key: row.key, entry: row.value as RecordEntry }))
      .filter(row => row.entry.scope.taskId === task.id)
      .sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.entry.sequence - b.entry.sequence || a.key.localeCompare(b.key))
    const snapshotText = JSON.stringify(task, null, 2), snapshotFence = fence(snapshotText)
    const snapshot = await this.parts(task.id, snapshotText)
    const document: Segment[] = [
      { text: '# ' + task.goal.objective + '\n\nTask: ' + task.id + '\n\n## Task snapshot\n\n' + snapshotFence + 'json\n' },
      { parts: snapshot },
      { text: '\n' + snapshotFence + '\n\n## Complete work records\n' },
    ]
    const copiedRefs: string[] = []
    for (const { key, entry } of entries) {
      const text = await this.journal.fullText(entry.ref)
      const parts = await this.parts(task.id, text)
      const archived: RecordEntry = { ...entry, parts }
      await this.storage.set(archivedRecordKey(key), archived)
      copiedRefs.push(entry.ref)
      document.push({ text: '\n### ' + entry.scope.kind + ' / ' + entry.sequence + '\n\n'
        + 'Time: ' + entry.createdAt + '\n\nSource: ' + canonicalJson(entry.source) + '\n\nReference: ' + entry.ref + '\n\n' + fence(text) + 'text\n' },
        { parts }, { text: '\n' + fence(text) + '\n' })
    }
    const digest = createHash('sha256')
    let characters = 0, bytes = 0
    for (const segment of document) {
      const bodies = 'text' in segment ? [segment.text] : await Promise.all(segment.parts.map(part => this.text(part)))
      for (const text of bodies) { digest.update(text, 'utf8'); characters += text.length; bytes += Buffer.byteLength(text, 'utf8') }
    }
    // The copied entry metadata is also required for original memory references after cleanup.
    for (const { key, entry } of entries) {
      const copy = await this.storage.get<RecordEntry>(archivedRecordKey(key))
      if (!copy || copy.ref !== entry.ref || copy.sha256 !== entry.sha256 || canonicalJson({ ...copy, parts: entry.parts }) !== canonicalJson(entry)) {
        throw new Error('Archive record readback failed: ' + entry.ref)
      }
    }
    const manifest: SealedTaskRecords = { schemaVersion: 1, state: 'sealed', taskId: task.id, taskRevision: task.revision, stage,
      sealedAt: this.now(), snapshot, document, sha256: digest.digest('hex'), characters, bytes, copiedRefs,
      cleanupKeys: rows.map(row => row.key).filter(key => taskRecordPrefixes(task.id).some(prefix => key.startsWith(prefix))) }
    await this.storage.set(root(task.id) + 'manifest', manifest)
    const prior = await this.index(task.id)
    await this.storage.set(indexKey(task.id), { schemaVersion: 1, taskId: task.id, assistantId: task.assistantId,
      workspaceId: task.workspace.id, objective: task.goal.objective, updatedAt: task.updatedAt, stage, taskRevision: task.revision,
      ...(prior?.hidden ? { hidden: true } : {}), ...(prior?.deliveryReadAt ? { deliveryReadAt: prior.deliveryReadAt } : {}) } satisfies TaskHistoryIndex)
    return manifest
  }
  async task(id: string): Promise<Task | undefined> {
    const manifest = await this.manifest(id)
    if (!manifest) return undefined
    const task = JSON.parse((await Promise.all(manifest.snapshot.map(part => this.text(part)))).join('')) as Task
    const readAt = (await this.index(id))?.deliveryReadAt
    if (task.delivery && readAt) task.delivery.readAt = readAt
    return task
  }
  async *chunks(manifest: SealedTaskRecords): AsyncGenerator<string> {
    for (const segment of manifest.document) {
      if ('text' in segment) yield segment.text
      else for (const part of segment.parts) yield await this.text(part)
    }
  }
  async read(id: string, cursor = 0, limit = 32768): Promise<{ text: string; nextCursor?: number; sha256: string }> {
    const manifest = await this.manifest(id)
    if (!manifest) throw new Error('Task records do not exist.')
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > manifest.characters || !Number.isInteger(limit) || limit < 1 || limit > 262144) throw new Error('Invalid archive page.')
    const end = Math.min(cursor + limit, manifest.characters)
    let position = 0, text = ''
    for (const segment of manifest.document) {
      const pieces = 'text' in segment ? [{ text: segment.text, characters: segment.text.length }] : segment.parts
      for (const piece of pieces) {
        const next = position + piece.characters
        if (next > cursor && position < end) {
          const body = 'text' in piece ? piece.text : await this.text(piece)
          text += body.slice(Math.max(0, cursor - position), Math.min(piece.characters, end - position))
        }
        position = next
        if (position >= end) return { text, sha256: manifest.sha256, ...(end < manifest.characters ? { nextCursor: end } : {}) }
      }
    }
    return { text, sha256: manifest.sha256 }
  }
  /** Called inside the Task command queue after exact native ownership has settled. */
  async cleanup(task: Task): Promise<void> {
    if (!this.storage.delete) throw new Error('Storage does not support task cleanup.')
    const manifest = await this.seal(task, 'ended')
    const index = (await this.index(task.id))!
    const tombstone: TaskTombstone = { schemaVersion: 1, kind: 'task-tombstone', id: task.id,
      assistantId: task.assistantId, workspaceId: task.workspace.id, revision: task.revision + 1, retiredAt: this.now() }
    await this.storage.set(indexKey(task.id), { ...index, tombstone })
    // Fence late commands before removing any cold history needed to hydrate the live root.
    await this.storage.set('task:' + task.id, tombstone)
    await this.finishCleanup(manifest)
  }
  private async finishCleanup(manifest: SealedTaskRecords): Promise<void> {
    if (!this.storage.delete) throw new Error('Storage does not support task cleanup.')
    for (const key of manifest.cleanupKeys) await this.storage.delete(key)
    await this.storage.delete('task:' + manifest.taskId)
    const index = (await this.index(manifest.taskId))!
    await this.storage.set(indexKey(manifest.taskId), { ...index, cleanedAt: this.now() })
  }
  async resumeCleanup(): Promise<void> {
    for (const index of await this.list()) if (index.tombstone && !index.cleanedAt) {
      const manifest = await this.manifest(index.taskId)
      if (!manifest || manifest.stage !== 'ended') throw new Error('Cleanup requires its sealed records.')
      await this.finishCleanup(manifest)
    }
  }
  async markDeliveryRead(id: string): Promise<void> {
    const index = await this.index(id)
    if (index && !index.deliveryReadAt) await this.storage.set(indexKey(id), { ...index, deliveryReadAt: this.now() })
  }
  async hide(id: string): Promise<void> {
    const index = await this.index(id)
    if (index?.stage === 'ended') await this.storage.set(indexKey(id), { ...index, hidden: true })
  }
}
