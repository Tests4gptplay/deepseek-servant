import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { StorageUsageStats } from '../contracts/retention.js'
import { ensureWriteDirectory, openNewOutput } from './write-directories.js'
import { readTaskArchiveIdentity, taskArchivePath, taskArchiveReadPath } from './task-archive.js'
import { filePath, withSnapshot, type FilesStore } from './transactions.js'
import { copyRecordTree, recordTreeFingerprint, type RecordTreeCopyState } from './record-tree-copy.js'

/** User-requested accounting of logical DSS records, not SQLite allocation or
 * native DSH session logs. No background sweep or retention policy is installed.
 */
export async function frameworkStorageUsage(files: FilesStore, now = new Date()): Promise<StorageUsageStats> {
  return withSnapshot(files, async snapshot => {
    const usage: StorageUsageStats = {
      totalBytes: 0, permanentBytes: 0, temporaryBytes: 0, recordedAt: now.toISOString(),
      permanent: { chatBytes: 0, assistantBytes: 0, knowledgeBytes: 0, originBytes: 0, archiveBytes: 0, planningBytes: 0, debugBytes: 0 },
      temporary: { taskBytes: 0, plannerMemoryBytes: 0, plannerNoteBytes: 0, workerReplyBytes: 0, executionBytes: 0, recoveryBytes: 0 },
    }
    for (const entry of await files.list(snapshot, '')) {
      // Local directory metadata contains exact byte sizes. A store without sizes
      // may read the requested record; this is an explicit statistics action only.
      const bytes = entry.bytes ?? (await files.readBytes(snapshot, entry.path))?.byteLength
      if (bytes === undefined) throw new Error('Record disappeared from the statistics snapshot: ' + entry.path)
      usage.totalBytes += bytes
      const p = entry.path
      if (p.startsWith('conversations/') || p.startsWith('conversation-index/') || p.startsWith('conversation-context/')) usage.permanent.chatBytes += bytes
      else if (p.startsWith('assistants/') && /\/Foreground_(?:List|Cache)\.md$/.test(p)) usage.permanent.planningBytes += bytes
      else if (p.startsWith('assistants/')) usage.permanent.assistantBytes += bytes
      else if (p.startsWith('skills/') || p.startsWith('knowledge/')) usage.permanent.knowledgeBytes += bytes
      else if (p.startsWith('debug/')) usage.permanent.debugBytes = (usage.permanent.debugBytes ?? 0) + bytes
      else if (p.startsWith('archives/')) usage.permanent.archiveBytes += bytes
      else if (/^tasks\/.*_(P|O)\.md$/.test(p)) usage.permanent.originBytes += bytes
      else if (p.startsWith('task-runs/')) {
        if (p.endsWith('/Planner_Memory.md')) usage.temporary.plannerMemoryBytes += bytes
        else if (p.endsWith('/Plan_Note.md') || p.endsWith('/Organizer_Note.md')) usage.temporary.plannerNoteBytes += bytes
        else if (p.includes('/workers/') || p.endsWith('/Reply.md')) usage.temporary.workerReplyBytes += bytes
        else usage.temporary.taskBytes += bytes
      } else if (p.startsWith('tasks/')) usage.temporary.taskBytes += bytes
      else if (p.startsWith('state/') || p.startsWith('technical/recovery-inputs/') || p.startsWith('technical/worker-transfers/')) usage.temporary.recoveryBytes += bytes
      else if (p.startsWith('instances/') || p.startsWith('Recorder Cache/')) usage.temporary.executionBytes += bytes
    }
    usage.temporaryBytes = Object.values(usage.temporary).reduce((sum, bytes) => sum + bytes, 0)
    // Unclassified records remain included in the retained total without a
    // catchall display category. This accounting never changes stored records.
    usage.permanentBytes = usage.totalBytes - usage.temporaryBytes
    return usage
  })
}

async function fileDigest(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function removeOwnedOutput(path: string, identity: { dev: number; ino: number }): Promise<void> {
  let current
  try { current = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  // A different operation may have replaced the pathname while our write was
  // settling. Its replacement never belongs to this action's rollback.
  if (current.dev === identity.dev && current.ino === identity.ino) await unlink(path)
}

async function rollbackOutput(path: string, identity: { dev: number; ino: number }, original: unknown): Promise<never> {
  try { await removeOwnedOutput(path, identity) }
  catch (cleanup) { throw new AggregateError([original, cleanup], 'Record output failed and its owned rollback also failed.') }
  throw original
}

async function assertAbsent(paths: string[]): Promise<void> {
  for (const path of paths) {
    try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    throw Object.assign(new Error('The destination already contains SQLite records or sidecar state: ' + path), { code: 'EEXIST' })
  }
}

/** Restore the existing records.md export: a copy into the selected workspace.
 * The authoritative archive and all result artifacts remain unchanged.
 */
export async function exportFrameworkRecords(files: FilesStore, taskId: string, workspace: string): Promise<{ path: string; sha256: string; bytes: number }> {
  const data = await withSnapshot(files, async snapshot => {
    const task = await readTaskArchiveIdentity(files, snapshot, taskId)
    const current = taskArchivePath(task), historical = taskArchiveReadPath(task)
    const body = await files.readBytes(snapshot, current + '/records.md')
      ?? (historical !== current ? await files.readBytes(snapshot, historical + '/records.md') : undefined)
    if (body === undefined) throw new Error('Task records have not been saved yet.')
    return body
  })
  return exportFrameworkBytes(data, taskId, workspace)
}

/** The caller resolves this document from the current Task/archive or a verified
 * legacy migration manifest; this does not reconstruct or summarize records.
 */
export async function exportFrameworkDocument(files: FilesStore, recordPath: string, taskId: string,
  workspace: string): Promise<{ path: string; sha256: string; bytes: number }> {
  filePath(recordPath)
  const data = await withSnapshot(files, async snapshot => {
    const body = await files.readBytes(snapshot, recordPath)
    if (body === undefined) throw new Error('Task records have not been saved yet.')
    return body
  })
  return exportFrameworkBytes(data, taskId, workspace)
}

/** Copies an already assembled and verified historical record verbatim. This
 * does not reconstruct journals or produce a new summary. */
export async function exportFrameworkBytes(data: Uint8Array, taskId: string,
  workspace: string, sourceSha256?: string): Promise<{ path: string; sha256: string; bytes: number }> {
  // Reuse only the digest handed over with these bytes by the current read.
  // The actual output file still owns its separate verification below.
  const sha256 = sourceSha256 ?? createHash('sha256').update(data).digest('hex')
  // Keep the existing export naming convention, including its short display hashes.
  const filename = 'records-' + createHash('sha256').update(taskId).digest('hex').slice(0, 12) + '-' + sha256.slice(0, 12) + '.md'
  const path = join(await ensureWriteDirectory(workspace), filename)
  let file
  try { file = await openNewOutput(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await fileDigest(path) !== sha256) throw new Error('The export path already contains different content: ' + path)
    return { path, sha256, bytes: data.byteLength }
  }
  let identity: { dev: number; ino: number } | undefined
  try {
    identity = await file.stat()
    await file.writeFile(data)
    await file.sync()
    await file.close()
    if (await fileDigest(path) !== sha256) throw new Error('The exported records differ from the source snapshot.')
    return { path, sha256, bytes: data.byteLength }
  } catch (error) {
    let failure = error
    try { await file.close() } catch (close) { failure = new AggregateError([error, close], 'Export failure and handle-close failure.') }
    if (!identity) throw new Error('Could not verify the created export; inspect the retained output path: ' + path, { cause: failure })
    // Only this action's exclusively created export belongs to its rollback.
    return rollbackOutput(path, identity, failure)
  }
}

function databaseDigest(database: DatabaseSync): string {
  const digest = createHash('sha256')
  const encode = (value: unknown) => JSON.stringify(value, (_key, item) => item instanceof Uint8Array
    ? { binary: Buffer.from(item).toString('base64') } : typeof item === 'bigint' ? { integer: String(item) } : item)
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  digest.update(encode(schema))
  // These are the LocalFiles database's three actual tables, including technical
  // pending-operation receipts. Backup also preserves its full SQLite schema.
  for (const [table, key] of [['files', 'path'], ['metadata', 'key'], ['git_operations', 'id']]) {
    digest.update(table!)
    for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate()) digest.update(encode(row) + '\n')
  }
  return digest.digest('hex')
}

function inspectDatabase(path: string, integrity = false): string {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    database.exec('BEGIN')
    if (integrity) {
      const checks = database.prepare('PRAGMA integrity_check').all()
      if (checks.length !== 1 || Object.values(checks[0]!)[0] !== 'ok') throw new Error('The copied Local records database failed its integrity check.')
    }
    return databaseDigest(database)
  } finally { if (database.isTransaction) database.exec('ROLLBACK'); database.close() }
}

export type LocalRecordBackend = 'sqlite' | 'physical'
/** Verify the selected backend after its affected writers closed. Historical
 * receipts without a backend retain their original SQLite interpretation. */
export async function localRecordFingerprint(directory: string, backend: LocalRecordBackend = 'sqlite', signal?: AbortSignal): Promise<string> {
  if (backend === 'physical') return recordTreeFingerprint(directory, signal)
  return inspectDatabase(join(await realpath(directory), 'dss-files.sqlite'))
}

export interface PreparedLocalRecordCopy {
  source: string
  destination: string
  fingerprint: string
  /** Exclusive target creation after byte/content validation. Does not change
   * active settings or technical scope ownership, and never deletes the source. */
  publish(): Promise<void>
  dispose(): Promise<void>
}

/** Physical half of the existing user-requested move. Service owns stopping all
 * affected producers, migrating their scope receipts, switching active settings
 * and confirming the new store before considering source-copy cleanup.
 */
export async function prepareLocalRecordCopy(sourceDirectory: string, destinationDirectory: string,
  signal?: AbortSignal, backend: LocalRecordBackend = 'sqlite',
  continuation?: { state?: RecordTreeCopyState; save(state: RecordTreeCopyState): Promise<void> }): Promise<PreparedLocalRecordCopy> {
  signal?.throwIfAborted()
  if (!isAbsolute(sourceDirectory) || !isAbsolute(destinationDirectory)) throw new Error('Choose absolute record directory paths.')
  if (backend === 'physical') {
    if (!continuation) throw new Error('A physical record move requires its accepted copy continuation.')
    const fingerprint = await recordTreeFingerprint(sourceDirectory, signal)
    let disposed = false, publishing: Promise<void> | undefined
    return { source: sourceDirectory, destination: destinationDirectory, fingerprint,
      publish: () => {
        if (disposed) return Promise.reject(new Error('The prepared record copy has been released.'))
        return publishing ??= copyRecordTree(sourceDirectory, destinationDirectory, continuation.state, continuation.save, signal, fingerprint).then(state => {
          if (state.fingerprint !== fingerprint) throw new Error('Local records changed while preparing their physical copy.')
        })
      },
      // Retain a partial accepted copy for exact continuation. No source, target,
      // or user-added file is deleted by releasing this operation handle.
      dispose: async () => { disposed = true; await publishing?.catch(() => {}) },
    }
  }
  const source = await realpath(sourceDirectory)
  await mkdir(destinationDirectory, { recursive: true })
  const destination = await realpath(destinationDirectory)
  const nested = relative(source, destination)
  if (nested === '' || !isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))
    throw new Error('The record destination must not be the current directory or inside it.')
  const sourcePath = join(source, 'dss-files.sqlite'), targetPath = join(destination, 'dss-files.sqlite')
  const stage = await mkdtemp(join(destination, '.dss-record-copy-')), stagePath = join(stage, 'dss-files.sqlite')
  let fingerprint: string, stagedSha256: string
  try {
    const database = new DatabaseSync(sourcePath, { readOnly: true })
    try {
      database.exec('BEGIN')
      fingerprint = databaseDigest(database)
      // Official Node/SQLite online backup includes committed WAL content. Raw
      // copying the .sqlite file alone can omit acknowledged records.
      await backup(database, stagePath)
    } finally { if (database.isTransaction) database.exec('ROLLBACK'); database.close() }
    signal?.throwIfAborted()
    if (inspectDatabase(stagePath, true) !== fingerprint) throw new Error('Copied records do not match the source snapshot.')
    stagedSha256 = await fileDigest(stagePath)
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
  let disposed = false, publishing: Promise<void> | undefined, disposal: Promise<void> | undefined
  const publish = async () => {
    signal?.throwIfAborted()
    if (inspectDatabase(sourcePath) !== fingerprint) throw new Error('Source records changed after the copy was prepared.')
    const sidecars = [targetPath + '-wal', targetPath + '-shm', targetPath + '-journal']
    await assertAbsent([targetPath, ...sidecars])
    const output = await open(targetPath, 'wx')
    let identity: { dev: number; ino: number } | undefined
    try {
      identity = await output.stat()
      await output.writeFile(createReadStream(stagePath)); await output.sync(); await output.close()
      signal?.throwIfAborted()
      // Do not open the target with SQLite during validation: even a read-only
      // WAL connection can touch another process's shared-memory sidecar.
      await assertAbsent(sidecars)
      const current = await lstat(targetPath)
      if (current.dev !== identity.dev || current.ino !== identity.ino
        || await fileDigest(targetPath) !== stagedSha256 || inspectDatabase(sourcePath) !== fingerprint)
        throw new Error('Record contents changed before the destination was confirmed.')
    } catch (error) {
      let failure = error
      try { await output.close() } catch (close) { failure = new AggregateError([error, close], 'Database copy failure and handle-close failure.') }
      if (!identity) throw new Error('Could not verify the created database; inspect the retained destination: ' + targetPath, { cause: failure })
      return rollbackOutput(targetPath, identity, failure)
    }
  }
  return {
    source, destination, fingerprint,
    publish: () => {
      if (disposed) return Promise.reject(new Error('The prepared record copy has been released.'))
      if (publishing) return publishing
      // wx preserves any pre-existing target. The new database is not an active
      // store until Service has verified it and switched its settings.
      return publishing = publish()
    },
    dispose: () => {
      if (disposal) return disposal
      disposed = true
      return disposal = (async () => { await publishing?.catch(() => {}); await rm(stage, { recursive: true, force: true }) })()
    },
  }
}
