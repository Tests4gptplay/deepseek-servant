import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { directoryPrefix, filePath, FilesConflictError, validateChanges,
  type FileChange, type FileEntry, type FileReceipt, type FilesSnapshot, type FilesStore,
  type GitOperationRecord, type GitOperationStore } from './transactions.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** SQLite commits multi-file changes and the checked revision together. A sequence of
 * filesystem renames would expose partial handoffs after an interrupted write.
 * WAL readers retain their snapshot only until release; no permanent body-history table.
 * Uses the built-in Node SQLite API available in the declared Node runtime range.
 */
export class LocalFiles implements FilesStore {
  private readonly snapshots = new Map<FilesSnapshot, DatabaseSync>()
  private closed = false
  private constructor(readonly directory: string, readonly databasePath: string, private readonly writer: DatabaseSync) {}
  static async open(directory: string): Promise<LocalFiles> {
    await mkdir(directory, { recursive: true })
    const root = await realpath(directory), databasePath = join(root, 'dss-files.sqlite')
    const writer = new DatabaseSync(databasePath)
    try {
      // FULL persists the WAL commit before acknowledging. Default busy timeout is
      // zero: contention is visible; there is no hidden business retry/reparent.
      writer.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, content TEXT NOT NULL, version TEXT NOT NULL, bytes INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS git_operations(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`)
      const columns = writer.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>
      if (!columns.some(column => column.name === 'binary')) writer.exec('ALTER TABLE files ADD COLUMN binary BLOB')
      writer.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('head', randomUUID())
      return new LocalFiles(root, databasePath, writer)
    } catch (error) { writer.close(); throw error }
  }
  private assertOpen(): void { if (this.closed) throw new Error('Local file storage is closed.') }
  async snapshot(): Promise<FilesSnapshot> {
    this.assertOpen()
    const reader = new DatabaseSync(this.databasePath, { readOnly: true })
    try {
      reader.exec('BEGIN')
      const revision = (reader.prepare("SELECT value FROM metadata WHERE key='head'").get() as { value: string }).value
      const snapshot: FilesSnapshot = { revision, release: async () => {
        const current = this.snapshots.get(snapshot)
        if (!current) return
        current.exec('ROLLBACK'); current.close(); this.snapshots.delete(snapshot)
      } }
      this.snapshots.set(snapshot, reader)
      return snapshot
    } catch (error) { reader.close(); throw error }
  }
  private reader(snapshot: FilesSnapshot): DatabaseSync {
    this.assertOpen()
    const reader = this.snapshots.get(snapshot)
    if (!reader) throw new Error('Snapshot was released or belongs to another store.')
    return reader
  }
  async read(snapshot: FilesSnapshot, path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(snapshot, path)
    return bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  async readBytes(snapshot: FilesSnapshot, path: string): Promise<Uint8Array | undefined> {
    const row = this.reader(snapshot).prepare('SELECT content,binary FROM files WHERE path=?').get(filePath(path)) as { content: string; binary: Uint8Array | null } | undefined
    return row === undefined ? undefined : row.binary ?? Buffer.from(row.content, 'utf8')
  }
  async list(snapshot: FilesSnapshot, prefix: string): Promise<FileEntry[]> {
    const value = directoryPrefix(prefix)
    // Directory prefixes end in '/'; the next ASCII character gives an indexed
    // upper bound without SQL LIKE wildcards or scanning unrelated file metadata.
    const rows = (value ? this.reader(snapshot).prepare('SELECT path,version,bytes FROM files WHERE path>=? AND path<? ORDER BY path').all(value, value.slice(0, -1) + '0')
      : this.reader(snapshot).prepare('SELECT path,version,bytes FROM files ORDER BY path').all()) as unknown as FileEntry[]
    return rows.map(row => ({ ...row, empty: row.bytes === 0 }))
  }
  async listDirectory(snapshot: FilesSnapshot, prefix: string): Promise<FileEntry[]> {
    const value = directoryPrefix(prefix)
    const rows = (value ? this.reader(snapshot).prepare(
      "SELECT path,version,bytes FROM files WHERE path>=? AND path<? AND instr(substr(path,?),'/')=0 ORDER BY path"
    ).all(value, value.slice(0, -1) + '0', value.length + 1)
      : this.reader(snapshot).prepare("SELECT path,version,bytes FROM files WHERE instr(path,'/')=0 ORDER BY path").all()) as unknown as FileEntry[]
    return rows.map(row => ({ ...row, empty: row.bytes === 0 }))
  }
  async commit(snapshot: FilesSnapshot, changes: readonly FileChange[], _message: string): Promise<FileReceipt> {
    this.reader(snapshot)
    validateChanges(changes)
    this.writer.exec('BEGIN IMMEDIATE')
    try {
      const head = (this.writer.prepare("SELECT value FROM metadata WHERE key='head'").get() as { value: string }).value
      if (head !== snapshot.revision) throw new FilesConflictError(snapshot.revision)
      const put = this.writer.prepare('INSERT INTO files(path,content,version,bytes,binary) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,version=excluded.version,bytes=excluded.bytes,binary=excluded.binary')
      const remove = this.writer.prepare('DELETE FROM files WHERE path=?')
      for (const change of changes) {
        if (change.content === null) remove.run(change.path)
        else {
          const bytes = change.bytes ?? Buffer.from(change.content!, 'utf8')
          put.run(change.path, change.content ?? '', digest(bytes), bytes.byteLength, change.bytes ?? null)
        }
      }
      // Logical files follow the same file/directory distinction as Git trees.
      for (const change of changes) if (change.content !== null) {
        const parts = change.path.split('/')
        for (let index = 1; index < parts.length; index++) {
          const ancestor = parts.slice(0, index).join('/')
          if (this.writer.prepare('SELECT 1 FROM files WHERE path=?').get(ancestor)) throw new Error('File occupies a parent directory: ' + ancestor)
        }
        const prefix = change.path + '/'
        if (this.writer.prepare('SELECT 1 FROM files WHERE path>=? AND path<? LIMIT 1').get(prefix, prefix.slice(0, -1) + '0')) {
          throw new Error('Directory already contains files: ' + change.path)
        }
      }
      const revision = randomUUID()
      this.writer.prepare("UPDATE metadata SET value=? WHERE key='head'").run(revision)
      this.writer.exec('COMMIT')
      return { revision, replay: false }
    } catch (error) {
      if (this.writer.isTransaction) this.writer.exec('ROLLBACK')
      throw error
    }
  }
  /** Technical write receipts stay local; values are operation IDs and hashes, not Git bodies. */
  readonly operations: GitOperationStore = {
    save: async (record: GitOperationRecord) => {
      this.assertOpen()
      this.writer.prepare('INSERT INTO git_operations(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
        .run(record.operation.id, JSON.stringify(record))
    },
    get: async (id: string) => {
      this.assertOpen()
      const row = this.writer.prepare('SELECT value FROM git_operations WHERE id=?').get(id) as { value: string } | undefined
      return row ? JSON.parse(row.value) as GitOperationRecord : undefined
    },
    list: async () => {
      this.assertOpen()
      const rows = this.writer.prepare('SELECT value FROM git_operations ORDER BY id').all() as Array<{ value: string }>
      return rows.map(row => JSON.parse(row.value) as GitOperationRecord)
    },
  }
  async close(): Promise<void> {
    if (this.closed) return
    for (const snapshot of [...this.snapshots.keys()]) await snapshot.release()
    this.writer.close()
    this.closed = true
  }
}
