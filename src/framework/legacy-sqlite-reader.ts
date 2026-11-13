import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** A source-side problem is never repaired, renamed, or classified by this reader. */
export interface LegacySqliteIssue {
  code: 'invalid-path' | 'invalid-content' | 'invalid-metadata'
  ordinal: number
  path?: string
  message: string
}
export interface LegacySqliteFile {
  kind: 'file'
  path: string
  bytes: Uint8Array
  source: {
    representation: 'text' | 'binary'
    version: string | null
    declaredBytes: number | null
  }
  issues: readonly LegacySqliteIssue[]
}
export interface LegacySqliteRejectedRow {
  kind: 'issue'
  issue: LegacySqliteIssue
}
export type LegacySqliteEntry = LegacySqliteFile | LegacySqliteRejectedRow
export type LegacySqlitePath = { kind: 'path'; path: string } | LegacySqliteRejectedRow
export interface LegacySqliteSnapshot {
  /** This identity belongs to the opened source file, not a business revision. */
  readonly identity: Readonly<{ dev: string; ino: string }>
  readonly schema: Readonly<{ hasBinary: boolean; textEncoding: 'UTF-8' }>
  /** Enumerate while the enclosing callback is running. Each enumeration uses
   * the SAME pinned SQLite read transaction, including committed WAL frames.
   * Unknown logical categories are returned unchanged, never guessed or dropped.
   * An issue row is not permission to mark its conversion complete. */
  entries(prefix?: string): AsyncIterableIterator<LegacySqliteEntry>
  /** Explicit relocation metadata only: never selects content or binary BLOBs.
   * Uses this same pinned transaction and the original path-byte validation. */
  paths(): AsyncIterableIterator<LegacySqlitePath>
  /** Read exactly one known logical source reference in this same pinned view. */
  read(path: string): Promise<LegacySqliteEntry | undefined>
  /** Original non-file recovery obligations; values are not exported or rewritten. */
  infrastructure(): Promise<{ metadataKeys: string[]; gitOperationIds: string[]; otherTables: string[] }>
}
export class LegacySqliteReadError extends Error {
  constructor(readonly code: 'DSS_LEGACY_SOURCE_UNAVAILABLE' | 'DSS_LEGACY_SOURCE_CHANGED'
    | 'DSS_LEGACY_SCHEMA_UNSUPPORTED' | 'DSS_LEGACY_READ_FAILED' | 'DSS_LEGACY_VIEW_CLOSED',
    message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LegacySqliteReadError'
  }
}

type Row = Record<string, unknown>
type Identity = { dev: string; ino: string }
const identityOf = (databasePath: string): Identity => {
  try {
    const info = lstatSync(databasePath, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The source must be an existing regular database file.')
    return { dev: String(info.dev), ino: String(info.ino) }
  } catch (cause) {
    throw new LegacySqliteReadError('DSS_LEGACY_SOURCE_UNAVAILABLE', 'The original Local database is unavailable. No empty database was created.', { cause })
  }
}
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino
const failure = (cause: unknown): Error => cause instanceof LegacySqliteReadError ? cause
  : new LegacySqliteReadError('DSS_LEGACY_READ_FAILED',
    'SQLite could not read the original Local database and its committed WAL view. Read-only SQLite may need its normal shared-memory sidecar; source permissions, recovery requirements, or damage can prevent this. No checkpoint, journal-mode change, source-copy fallback, or repair was attempted.', { cause })

const readPath = (row: Row, ordinal: number): LegacySqlitePath => {
  const path = typeof row.path === 'string' ? row.path : undefined
  const issue = (code: LegacySqliteIssue['code'], message: string): LegacySqliteIssue => ({ code, ordinal, ...(path === undefined ? {} : { path }), message })
  // Check the byte/string round trip as well: SQLite's JS string conversion can
  // otherwise silently replace malformed UTF-8 in a damaged path. Do NOT apply
  // TextDecoder to file content (its default strips a UTF-8 BOM).
  if (row.path_type !== 'text' || path === undefined || !(row.path_bytes instanceof Uint8Array)
    || !Buffer.from(row.path_bytes).equals(Buffer.from(path, 'utf8')) || !path
    || /[\\\0\r\n]/.test(path) || isAbsolute(path) || /^[a-z]:/i.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    return { kind: 'issue', issue: issue('invalid-path', 'The row has an invalid or non-round-tripping relative file path. Keep its source row unresolved; do not normalize or publish it elsewhere.') }
  }
  return { kind: 'path', path }
}
const readRow = (row: Row, ordinal: number): LegacySqliteEntry => {
  const addressed = readPath(row, ordinal)
  if (addressed.kind === 'issue') return addressed
  const path = addressed.path
  const issue = (code: LegacySqliteIssue['code'], message: string): LegacySqliteIssue => ({ code, ordinal, path, message })
  // NULL, not truthiness or byteLength, selects the legacy TEXT fallback. An
  // empty non-NULL binary BLOB is a real empty file and wins over stale content.
  const binary = row.binary_type !== 'null'
  if (binary ? row.binary_type !== 'blob' : row.content_type !== 'text') {
    return { kind: 'issue', issue: issue('invalid-content', 'The selected source representation is not the expected BLOB or legacy TEXT. Keep the row unresolved.') }
  }
  const value = binary ? row.binary : row.text_bytes
  if (!(value instanceof Uint8Array)) {
    return { kind: 'issue', issue: issue('invalid-content', 'SQLite did not return the selected file representation as bytes. Keep the row unresolved.') }
  }
  // CAST(TEXT AS BLOB) returns stored UTF-8 bytes, including BOM, embedded NUL,
  // line endings and malformed UTF-8. Never parse/reformat JSON or normalize text.
  const bytes = Uint8Array.from(value)
  const issues: LegacySqliteIssue[] = []
  const version = row.version_type === 'text' && typeof row.version === 'string' ? row.version : null
  const size = row.bytes_type === 'integer' && typeof row.declared_bytes === 'string' ? Number(row.declared_bytes) : NaN
  const declaredBytes = Number.isSafeInteger(size) && size >= 0 ? size : null
  if (version === null) issues.push(issue('invalid-metadata', 'The legacy version is not text; preserve the real file bytes without inventing a version.'))
  if (declaredBytes === null || declaredBytes !== bytes.byteLength) issues.push(issue('invalid-metadata', 'The legacy byte-count metadata does not match the real file bytes; preserve the real bytes.'))
  return { kind: 'file', path, bytes, source: { representation: binary ? 'binary' : 'text', version, declaredBytes }, issues }
}

/** One-time extraction primitive for startup conversion, NOT an ordinary Local
 * storage adapter. The caller must await physical materialization inside use().
 * BEGIN + an immediate schema read pin a single consistent database/WAL view
 * before use() starts; neither async writes nor later commits change that view.
 *
 * readOnly protects the business database. SQLite may create/update -shm reader
 * bookkeeping while reading WAL; this API does not promise immutable sidecar
 * bytes. It never changes SQL records/schema/journal mode, checkpoints, copies
 * source files, uses immutable=1, or deletes the source. A sidecar/access/recovery
 * error is surfaced, not worked around. Production activation and cutover are
 * the coordinator's responsibility; this function creates no user-choice gate.
 */
export async function withLegacySqliteSnapshot<T>(databasePath: string,
  use: (snapshot: LegacySqliteSnapshot) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
  options.signal?.throwIfAborted()
  const identity = identityOf(databasePath)
  let db: DatabaseSync | undefined
  let open = true
  const cursors = new Set<Iterator<Row>>()
  const assertOpen = (): void => {
    if (!open) throw new LegacySqliteReadError('DSS_LEGACY_VIEW_CLOSED', 'The legacy SQLite read callback has ended; its view cannot be reused.')
    options.signal?.throwIfAborted()
    if (!sameIdentity(identity, identityOf(databasePath))) throw new LegacySqliteReadError('DSS_LEGACY_SOURCE_CHANGED', 'The original Local database path was replaced during extraction. Keep conversion incomplete and retain its source.')
  }
  const guardRead = <R>(read: () => R): R => {
    assertOpen()
    try { return read() } catch (cause) { throw failure(cause) }
  }
  try {
    try {
      db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false })
      db.exec('PRAGMA query_only=ON; BEGIN')
      // This read establishes the transaction's snapshot before the async caller.
      const table = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='files'").get()
      if (table?.type !== 'table' || typeof table.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(table.sql)) throw new LegacySqliteReadError('DSS_LEGACY_SCHEMA_UNSUPPORTED', 'The source has no ordinary files table. No schema was created or changed.')
      const columns = db.prepare('PRAGMA table_info(files)').all()
      if (!['path', 'content', 'version', 'bytes'].every(name => columns.some(column => column.name === name))) {
        throw new LegacySqliteReadError('DSS_LEGACY_SCHEMA_UNSUPPORTED', 'The source files table is missing required legacy columns. No schema was created or changed.')
      }
      const encoding = db.prepare('PRAGMA encoding').get()?.encoding
      if (encoding !== 'UTF-8') throw new LegacySqliteReadError('DSS_LEGACY_SCHEMA_UNSUPPORTED', 'The source uses a text encoding other than the v44 UTF-8 schema. Its bytes were not silently transcoded.')
      assertOpen()
    } catch (cause) { throw failure(cause) }
    const hasBinary = db.prepare('PRAGMA table_info(files)').all().some(column => column.name === 'binary')
    const sql = 'SELECT path, typeof(path) AS path_type, CAST(path AS BLOB) AS path_bytes, '
      + 'typeof(content) AS content_type, CAST(content AS BLOB) AS text_bytes, '
      + (hasBinary ? 'binary, typeof(binary)' : "NULL AS binary, 'null'") + ' AS binary_type, '
      + 'version, typeof(version) AS version_type, CAST(bytes AS TEXT) AS declared_bytes, typeof(bytes) AS bytes_type '
      + 'FROM files'
    const orderedSql = sql + ' ORDER BY path COLLATE BINARY'
    const snapshot: LegacySqliteSnapshot = Object.freeze({
      identity: Object.freeze(identity), schema: Object.freeze({ hasBinary, textEncoding: 'UTF-8' as const }),
      async infrastructure() {
        return guardRead(() => {
          const names = db!.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name))
          const metadataKeys = names.includes('metadata') ? db!.prepare('SELECT key FROM metadata ORDER BY key').all().map(row => String(row.key)) : []
          const gitOperationIds = names.includes('git_operations') ? db!.prepare('SELECT id FROM git_operations ORDER BY id').all().map(row => String(row.id)) : []
          return { metadataKeys, gitOperationIds, otherTables: names.filter(name => !['files', 'metadata', 'git_operations'].includes(name)) }
        })
      },
      async read(path: string): Promise<LegacySqliteEntry | undefined> {
        return guardRead(() => {
          const statement = db!.prepare(sql + ' WHERE path = ? COLLATE BINARY LIMIT 2')
          statement.setReadBigInts(true)
          const rows = statement.all(path) as Row[]
          if (rows.length > 1) throw new LegacySqliteReadError('DSS_LEGACY_SCHEMA_UNSUPPORTED', 'The addressed original path has duplicate rows. No row was silently selected.')
          return rows[0] ? readRow(rows[0], 1) : undefined
        })
      },
      paths(): AsyncIterableIterator<LegacySqlitePath> {
        const cursor = guardRead(() => {
          const statement = db!.prepare('SELECT path, typeof(path) AS path_type, CAST(path AS BLOB) AS path_bytes FROM files ORDER BY path COLLATE BINARY')
          statement.setReadBigInts(true)
          return statement.iterate() as Iterator<Row>
        })
        cursors.add(cursor)
        let ordinal = 0, done = false
        const finish = () => { if (!done) { done = true; try { cursor.return?.() } finally { cursors.delete(cursor) } } }
        return {
          [Symbol.asyncIterator]() { return this },
          async next(): Promise<IteratorResult<LegacySqlitePath>> {
            assertOpen()
            if (done) return { done: true, value: undefined }
            try {
              const row = guardRead(() => cursor.next())
              if (row.done) { finish(); return { done: true, value: undefined } }
              return { done: false, value: readPath(row.value, ++ordinal) }
            } catch (cause) { finish(); throw cause }
          },
          async return(): Promise<IteratorResult<LegacySqlitePath>> { finish(); return { done: true, value: undefined } },
        }
      },
      entries(prefix?: string): AsyncIterableIterator<LegacySqliteEntry> {
        const cursor = guardRead(() => {
          if (prefix !== undefined && (!prefix || !prefix.endsWith('/') || /[\\\0\r\n]/.test(prefix) || prefix.split('/').slice(0, -1).some(part => !part || part === '.' || part === '..')))
            throw new Error('Use an exact original directory prefix.')
          const statement = db!.prepare(prefix === undefined ? orderedSql : sql + ' WHERE path >= ? COLLATE BINARY AND path < ? COLLATE BINARY ORDER BY path COLLATE BINARY')
          // Damaged numeric path/version cells must become scoped row issues,
          // not throw during JS conversion for an out-of-range SQLite integer.
          statement.setReadBigInts(true)
          return (prefix === undefined ? statement.iterate() : statement.iterate(prefix, prefix.slice(0, -1) + '0')) as Iterator<Row>
        })
        cursors.add(cursor)
        let ordinal = 0, done = false
        const finish = (): void => { if (!done) { done = true; try { cursor.return?.() } finally { cursors.delete(cursor) } } }
        return {
          [Symbol.asyncIterator]() { return this },
          async next(): Promise<IteratorResult<LegacySqliteEntry>> {
            assertOpen()
            if (done) return { done: true, value: undefined }
            try {
              const row = guardRead(() => cursor.next())
              if (row.done) { finish(); return { done: true, value: undefined } }
              return { done: false, value: readRow(row.value, ++ordinal) }
            } catch (cause) { finish(); throw cause }
          },
          async return(): Promise<IteratorResult<LegacySqliteEntry>> { finish(); return { done: true, value: undefined } },
        }
      },
    })
    const result = await use(snapshot)
    assertOpen()
    return result
  } finally {
    open = false
    // Finalize abandoned iterators before ending the transaction. Never leave a
    // cursor/read lock behind when materialization throws or the caller cancels.
    try { for (const cursor of cursors) cursor.return?.() }
    finally {
      try { if (db?.isTransaction) db.exec('ROLLBACK') }
      finally { db?.close() }
    }
  }
}
