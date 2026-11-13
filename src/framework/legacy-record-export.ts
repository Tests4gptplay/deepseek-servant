import { createHash } from 'node:crypto'
import type { MigrationManifest } from './legacy-migration.js'
import { filePath, type FilesSnapshot, type FilesStore } from './transactions.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const LEGACY_BASELINE = '0acd3ba39a2ae23d66759279b3c54c4637cd0ad5'
/** The existing migration mapping, also used by read-only history discovery. */
export function legacyMigratedTaskId(scope: string, oldId: string): string {
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(oldId)) return oldId
  const digest = hash(scope + '\0' + oldId)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
export const legacyLocalRecordsReference = (id: string): string => 'records/' + encodeURIComponent(id) + '/records.md'

async function readSealedPart(part: unknown, taskId: string, read: (key: string) => Promise<unknown>): Promise<string> {
  if (!object(part) || !digest(part.sha256) || !integer(part.characters) || !integer(part.bytes)
    || part.key !== 'records/' + encodeURIComponent(taskId) + '/content/' + part.sha256)
    throw new Error('Invalid sealed legacy record part: ' + taskId)
  const body = await read(part.key as string)
  if (!object(body) || body.schemaVersion !== 1 || typeof body.text !== 'string' || hash(body.text) !== part.sha256
    || body.text.length !== part.characters || Buffer.byteLength(body.text, 'utf8') !== part.bytes)
    throw new Error('Sealed legacy record part is missing or corrupt: ' + part.key)
  return body.text
}

/** Read the archived Task identity from its original stored snapshot parts. */
export async function decodeLegacySealedTask(value: unknown, taskId: string,
  read: (key: string) => Promise<unknown>): Promise<Record<string, unknown>> {
  if (!object(value) || value.schemaVersion !== 1 || value.state !== 'sealed' || value.taskId !== taskId || !Array.isArray(value.snapshot))
    throw new Error('Legacy sealed Task snapshot is missing or invalid: ' + taskId)
  const pieces: string[] = []
  for (const part of value.snapshot) pieces.push(await readSealedPart(part, taskId, read))
  const task: unknown = JSON.parse(pieces.join(''))
  if (!object(task) || task.schemaVersion !== 1 || task.id !== taskId) throw new Error('Invalid legacy sealed Task identity: ' + taskId)
  return task
}

/** Decode the sealed 0acd document in its stored segment order. This is not a
 * new seal: no Task serialization, journal sorting, summarization or mutation. */
export async function decodeLegacySealedRecords(value: unknown, taskId: string,
  read: (key: string) => Promise<unknown>): Promise<string> {
  if (!object(value) || value.schemaVersion !== 1 || value.state !== 'sealed' || value.taskId !== taskId
    || !['accepted', 'ended'].includes(value.stage as string) || !Array.isArray(value.document)
    || !integer(value.characters) || !integer(value.bytes) || !digest(value.sha256))
    throw new Error('Invalid sealed legacy records: ' + taskId)
  const sections: string[] = []
  for (const segment of value.document) {
    if (!object(segment)) throw new Error('Invalid sealed legacy document segment: ' + taskId)
    if (typeof segment.text === 'string' && !('parts' in segment)) sections.push(segment.text)
    else if (Array.isArray(segment.parts) && !('text' in segment)) {
      for (const part of segment.parts) {
        sections.push(await readSealedPart(part, taskId, read))
      }
    } else throw new Error('Invalid sealed legacy document segment: ' + taskId)
  }
  const text = sections.join('')
  if (text.length !== value.characters || Buffer.byteLength(text, 'utf8') !== value.bytes || hash(text) !== value.sha256)
    throw new Error('Sealed legacy records integrity mismatch: ' + taskId)
  return text
}

interface ExportManifest extends MigrationManifest { clearedTasks?: Array<{ oldId: string; taskId: string }> }
async function context(files: FilesStore, snapshot: FilesSnapshot, manifestPath: string) {
  filePath(manifestPath)
  const match = /^technical\/legacy-migrations\/([^/]+)\/manifest\.json$/.exec(manifestPath)
  if (!match) throw new Error('Select an existing legacy migration manifest.')
  const raw = await files.read(snapshot, manifestPath)
  if (raw === undefined) throw new Error('Legacy migration manifest is missing.')
  const manifest = JSON.parse(raw) as ExportManifest
  if (manifest?.version !== 1 || manifest.id !== match[1] || manifest.baseline !== LEGACY_BASELINE
    || !['local', 'git'].includes(manifest.source?.mode) || !Array.isArray(manifest.records)
    || !Array.isArray(manifest.tasks) || !object(manifest.references) || !object(manifest.referenceHashes)
    || manifest.clearedTasks !== undefined && !Array.isArray(manifest.clearedTasks))
    throw new Error('Invalid legacy migration manifest.')
  const root = manifestPath.slice(0, -'/manifest.json'.length)
  const checkedBytes = async (reference: string): Promise<{ bytes: Uint8Array; sha256: string }> => {
    const path = manifest.references[reference], expected = manifest.referenceHashes[reference]
    if (typeof path !== 'string' || !digest(expected)) throw new Error('Legacy records reference has not been migrated: ' + reference)
    filePath(path)
    if (!path.startsWith(root + '/source/') && !path.startsWith(root + '/text/')) throw new Error('Legacy records reference escapes its migration: ' + reference)
    const body = await files.readBytes(snapshot, path)
    if (body === undefined) throw new Error('Migrated legacy records are missing or corrupt: ' + reference)
    const sha256 = hash(body)
    if (sha256 !== expected) throw new Error('Migrated legacy records are missing or corrupt: ' + reference)
    return { bytes: body, sha256 }
  }
  const bytes = async (reference: string): Promise<Uint8Array> => (await checkedBytes(reference)).bytes
  const json = async (key: string): Promise<unknown> => {
    const rows = manifest.records.filter(row => row.key === key)
    if (rows.length !== 1 || rows[0]!.path !== root + '/source/' + hash(key) + '.bin'
      || manifest.references[key] !== rows[0]!.path || manifest.referenceHashes[key] !== rows[0]!.sha256)
      throw new Error('Legacy source record has not been preserved unambiguously: ' + key)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bytes(key)))
  }
  return { manifest, root, bytes, checkedBytes, json }
}

export interface LegacyRecordExportIdentity { oldTaskId: string; taskId: string; continuation: 'complete' | 'cancelled' }
export interface LegacyRecordExport { taskId: string; path?: string; bytes: Uint8Array; /** Digest of these exact bytes, computed by this read. */ sha256?: string }

type ExportContext = Awaited<ReturnType<typeof context>>
async function identityFor(c: ExportContext, oldTaskId: string): Promise<LegacyRecordExportIdentity | undefined> {
  const { manifest, json } = c
  if (typeof oldTaskId !== 'string' || !oldTaskId) throw new Error('A preserved legacy Task identity is required.')
  if (manifest.clearedTasks?.some(task => task.oldId === oldTaskId)) return undefined
  const matches = manifest.tasks.filter(task => task.oldId === oldTaskId)
  if (matches.length > 1) throw new Error('Ambiguous migrated legacy Task identity: ' + oldTaskId)
  const mapped = matches[0]
  if (mapped && mapped.taskId !== legacyMigratedTaskId(manifest.id, oldTaskId)) throw new Error('Migrated legacy Task identity differs from its original mapping.')
  if (!mapped && manifest.source.mode === 'local' && manifest.records.some(row => row.key === 'task:' + oldTaskId)) return undefined
  if (mapped && !['complete', 'cancelled'].includes(mapped.continuation)) return undefined
  const key = manifest.source.mode === 'local' ? 'records/' + encodeURIComponent(oldTaskId) + '/manifest'
    : 'records/' + oldTaskId + '/manifest.json'
  if (!manifest.records.some(row => row.key === key)) return undefined
  const sealed = await json(key)
  if (!object(sealed) || sealed.taskId !== oldTaskId
    || (manifest.source.mode === 'local' ? sealed.schemaVersion !== 1 || sealed.state !== 'sealed' : sealed.version !== 1))
    throw new Error('Invalid preserved legacy records manifest: ' + oldTaskId)
  let continuation = mapped?.continuation as 'complete' | 'cancelled' | undefined
  if (manifest.source.mode === 'local') {
    const historyKey = 'task-history/' + encodeURIComponent(oldTaskId)
    if (manifest.records.some(row => row.key === historyKey)) {
      const history = await json(historyKey)
      if (!object(history) || history.schemaVersion !== 1 || history.taskId !== oldTaskId) throw new Error('Invalid preserved legacy history: ' + oldTaskId)
      if (history.deleting) return undefined
    } else if (!mapped) return undefined
    if (!mapped) {
      // Decode the preserved snapshot only to establish the original terminal
      // identity. It is never serialized back into the records document.
      const task = await decodeLegacySealedTask(sealed, oldTaskId, json)
      continuation = task.phase === 'cancelled' || task.control === 'cancelled' ? 'cancelled' : task.phase === 'completed' ? 'complete' : undefined
      if (!continuation) return undefined
    }
  }
  if (!continuation) return undefined
  return { oldTaskId, taskId: mapped?.taskId ?? legacyMigratedTaskId(manifest.id, oldTaskId), continuation }
}

/** Include history-only Local archives omitted by older migration consumers.
 * This is a read-only document index, never a Task scheduling/continuation input.
 * An optional visible diagnostic callback lets other valid archives stay listed. */
export async function listLegacyRecordExports(files: FilesStore, snapshot: FilesSnapshot,
  manifestPath: string, onError?: (error: unknown, oldTaskId: string) => void): Promise<LegacyRecordExportIdentity[]> {
  const c = await context(files, snapshot, manifestPath), { manifest } = c
  const ids = new Set(manifest.tasks.map(task => task.oldId))
  if (manifest.source.mode === 'local') for (const row of manifest.records) {
    if (!row.key.startsWith('task-history/')) continue
    try {
      const id = decodeURIComponent(row.key.slice('task-history/'.length))
      if (!id || row.key !== 'task-history/' + encodeURIComponent(id)) throw new Error('Invalid legacy history identity.')
      ids.add(id)
    } catch (error) { if (!onError) throw error; onError(error, row.key) }
  }
  const result: LegacyRecordExportIdentity[] = []
  for (const id of ids) {
    try { const item = await identityFor(c, id); if (item) result.push(item) }
    catch (error) { if (!onError) throw error; onError(error, id) }
  }
  return result
}

/** Resolve only the original sealed records. Older Local migrations retain the
 * manifest and parts instead of a materialized text path; return their verified
 * document bytes without inventing a path or rewriting the migration. */
export async function readLegacyRecordExport(files: FilesStore, snapshot: FilesSnapshot,
  input: { manifestPath: string; oldTaskId: string }): Promise<LegacyRecordExport> {
  const c = await context(files, snapshot, input.manifestPath), selected = await identityFor(c, input.oldTaskId)
  if (!selected) throw new Error('Sealed legacy task records are unavailable or were explicitly cleared.')
  const { manifest, root, bytes, checkedBytes, json } = c
  if (manifest.source.mode === 'local') {
    const sealed = await json('records/' + encodeURIComponent(input.oldTaskId) + '/manifest')
    const text = await decodeLegacySealedRecords(sealed, input.oldTaskId, json)
    const reference = legacyLocalRecordsReference(input.oldTaskId), path = manifest.references[reference]
    if (path !== undefined || manifest.referenceHashes[reference] !== undefined) {
      if (path !== root + '/text/' + hash(reference) + '.md') throw new Error('Invalid materialized legacy records path.')
      const body = await bytes(reference)
      if (!Buffer.from(body).equals(Buffer.from(text, 'utf8'))) throw new Error('Materialized legacy records differ from the original sealed document.')
      return { taskId: selected.taskId, path, bytes: body }
    }
    return { taskId: selected.taskId, bytes: Buffer.from(text, 'utf8') }
  }
  const sealed = await json('records/' + input.oldTaskId + '/manifest.json')
  if (!object(sealed) || typeof sealed.recordsPath !== 'string' || !digest(sealed.recordsSha256)
    || !sealed.recordsPath.startsWith('dss-coop/records/' + input.oldTaskId + '/versions/')) throw new Error('Invalid sealed legacy Git records reference.')
  if (manifest.references[sealed.recordsPath] !== root + '/text/' + hash(sealed.recordsPath) + '.md') throw new Error('Invalid materialized legacy Git records path.')
  const body = await checkedBytes(sealed.recordsPath)
  if (body.sha256 !== sealed.recordsSha256) throw new Error('Sealed legacy Git records integrity mismatch.')
  return { taskId: selected.taskId, path: manifest.references[sealed.recordsPath], ...body }
}
