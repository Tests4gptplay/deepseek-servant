import { matchesFileSelection } from './file-list-selection.js'

/** Static package-owned worker program. It is bundled into the Host so every
 * compiled/test entry launches the exact reviewed bytes, without a second asset
 * path, runtime compiler, downloaded code or caller-supplied JavaScript. */
export const localFilesWorkerSource = String.raw`
'use strict';
const { parentPort, workerData, threadId } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { lstatSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const matchesFileSelection = ${matchesFileSelection.toString()};
const readers = new Map();
let writer;
let databaseIdentity = workerData.databaseIdentity;
const unavailable = cause => Object.assign(Error('The original Local records database is missing or was replaced. Its contents cannot be restored by creating a directory or an empty database; restore the original records and reopen storage.', { cause }), { code: 'DSS_LOCAL_DATABASE_UNAVAILABLE' });
const inspectIdentity = () => {
  let info;
  try { info = lstatSync(workerData.databasePath, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') throw unavailable(error); throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw unavailable();
  return { dev: String(info.dev), ino: String(info.ino) };
};
const sameIdentity = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const assertDatabasePresent = () => {
  if (!sameIdentity(inspectIdentity(), databaseIdentity)) throw unavailable();
};
const filePath = value => {
  if (typeof value !== 'string' || !value || /[\\\0\r\n]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Use a relative file path inside the DSS storage root.');
  return value;
};
const prefix = value => value === '' ? '' : filePath(value.replace(/\/$/, '')) + '/';
const reader = id => { const db = readers.get(id); if (!db) throw Error('Snapshot was released or belongs to another store.'); return db; };
const release = id => { const db = readers.get(id); if (!db) return; try { if (db.isTransaction) db.exec('ROLLBACK'); } finally { db.close(); readers.delete(id); } };
const serializeError = error => ({ name: error.name, message: error.message, stack: error.stack,
  code: error.code, errcode: error.errcode, errstr: error.errstr, expectedRevision: error.expectedRevision });
const listRows = (db, method, value, selection) => {
  if (selection?.archiveScope) {
    const { root, childTaskIds } = selection.archiveScope;
    filePath(root);
    // Apply the same first-segment Task boundary in SQLite before returning
    // metadata rows. Child bodies and metadata never cross the reader bridge.
    const start = Array.from(root).length + 2, rest = 'substr(files.path,' + start + ')';
    const first = 'lower(substr(' + rest + ',1,instr(' + rest + "||'/', '/')-1))";
    const scope = " AND NOT EXISTS (SELECT 1 FROM json_each(?) child WHERE " + first + "=lower(child.value) OR substr(" + first + ",-(length(child.value)+1))='_'||lower(child.value))";
    const direct = method === 'listDirectory' ? " AND instr(substr(path,?),'/')=0" : '';
    const sql = 'SELECT path,version,bytes FROM files WHERE path>=? AND path<?' + direct + scope + ' ORDER BY path';
    const args = [value, value.slice(0,-1)+'0', ...(direct ? [Array.from(value).length+1] : []), JSON.stringify(childTaskIds)];
    return db.prepare(sql).all(...args).filter(row => matchesFileSelection(row.path, selection));
  }
  const rows = method === 'list'
    ? (value ? db.prepare('SELECT path,version,bytes FROM files WHERE path>=? AND path<? ORDER BY path').all(value, value.slice(0,-1)+'0') : db.prepare('SELECT path,version,bytes FROM files ORDER BY path').all())
    : (value ? db.prepare("SELECT path,version,bytes FROM files WHERE path>=? AND path<? AND instr(substr(path,?),'/')=0 ORDER BY path").all(value,value.slice(0,-1)+'0',value.length+1) : db.prepare("SELECT path,version,bytes FROM files WHERE instr(path,'/')=0 ORDER BY path").all());
  return rows.filter(row => matchesFileSelection(row.path, selection));
};
const conflict = revision => {
  const error = Error('Storage changed since the checked snapshot; read and evaluate the business conditions again.');
  error.name = 'FilesConflictError'; error.expectedRevision = revision; throw error;
};
const execute = (method, args) => {
  // These boundaries open a new durable view or operate on the writer. Existing
  // leased readers may finish, but no new operation adopts another path identity.
  if (['verify', 'snapshot', 'commit', 'checkpoint', 'operationSave', 'operationGet', 'operationList'].includes(method)) assertDatabasePresent();
  if (method === 'verify') return;
  if (method === 'checkpoint') {
    if (!writer) throw Error('This Local worker does not own writes.');
    // COMMIT's own leased reader prevents automatic checkpoint completion.
    // PASSIVE runs only after an actual release and never waits for other readers.
    const result = writer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    return result.busy === 0 && result.log === result.checkpointed;
  }
  if (method === 'snapshot') {
    const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
    try {
      db.exec('BEGIN');
      const revision = db.prepare("SELECT value FROM metadata WHERE key='head'").get().value;
      assertDatabasePresent();
      readers.set(args.id, db);
      return { revision, threadId };
    } catch (error) { db.close(); throw error; }
  }
  if (method === 'release') return release(args.id);
  if (method === 'read' || method === 'readBytes') {
    const row = reader(args.id).prepare('SELECT content,binary,version FROM files WHERE path=?').get(filePath(args.path));
    const bytes = row === undefined ? undefined : row.binary ?? Buffer.from(row.content, 'utf8');
    return { value: method === 'read' && bytes !== undefined ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes,
      version: row?.version ?? null };
  }
  if (method === 'list' || method === 'listDirectory') {
    const value = prefix(args.prefix), db = reader(args.id);
    const rows = listRows(db, method, value, args.selection);
    return { value: rows.map(row => ({ ...row, empty: row.bytes === 0 })),
      ...(args.observe ? { fingerprint: digest(JSON.stringify(rows.map(row => [row.path,row.version]).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))) } : {}) };
  }
  if (method === 'listNames') return listRows(reader(args.id), 'listDirectory', prefix(args.prefix), args.selection).map(row => ({path:row.path}));
  if (method === 'dependencies') {
    const db = reader(args.id), version = db.prepare('SELECT version FROM files WHERE path=?');
    return args.dependencies.map(dependency => dependency.kind === 'file'
      ? { ...dependency, version: version.get(filePath(dependency.path))?.version ?? null }
      : { ...dependency, entries: listRows(db, dependency.kind, prefix(dependency.prefix), dependency.selection).map(row => [row.path,dependency.namesOnly?'':row.version]) });
  }
  if (method === 'commit') {
    if (!writer) throw Error('This Local worker does not own writes.');
    const paths = new Set();
    for (const change of args.changes) {
      filePath(change.path);
      if (paths.has(change.path)) throw Error('A transaction cannot write the same path twice: '+change.path);
      paths.add(change.path);
      if (change.bytes !== undefined ? !(change.bytes instanceof Uint8Array) || change.content !== undefined : typeof change.content !== 'string' && change.content !== null) throw Error('A change must carry text, bytes, or a deletion, never mixed representations.');
    }
    writer.exec('BEGIN IMMEDIATE');
    try {
      {
        const version = writer.prepare('SELECT version FROM files WHERE path=?');
        for (const dependency of args.dependencies) {
          if (dependency.kind === 'file') {
            if ((version.get(filePath(dependency.path))?.version ?? null) !== dependency.version) conflict(args.revision);
          } else if (dependency.kind === 'list' || dependency.kind === 'listDirectory') {
            const current = listRows(writer, dependency.kind, prefix(dependency.prefix), dependency.selection).map(row => [row.path,dependency.namesOnly?'':row.version]);
            if (JSON.stringify(current) !== JSON.stringify(dependency.entries)) conflict(args.revision);
          } else throw Error('Unknown Local read dependency.');
        }
      }
      const put = writer.prepare('INSERT INTO files(path,content,version,bytes,binary) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,version=excluded.version,bytes=excluded.bytes,binary=excluded.binary');
      const remove = writer.prepare('DELETE FROM files WHERE path=?');
      for (const change of args.changes) {
        if (change.content === null) remove.run(change.path);
        else { const bytes = change.bytes ?? Buffer.from(change.content, 'utf8'); put.run(change.path,change.content ?? '',digest(bytes),bytes.byteLength,change.bytes ?? null); }
      }
      for (const change of args.changes) if (change.content !== null) {
        const parts = change.path.split('/');
        for (let i=1;i<parts.length;i++) {
          const ancestor=parts.slice(0,i).join('/');
          if (writer.prepare('SELECT 1 FROM files WHERE path=?').get(ancestor)) throw Error('File occupies a parent directory: '+ancestor);
        }
        const value=change.path+'/';
        if (writer.prepare('SELECT 1 FROM files WHERE path>=? AND path<? LIMIT 1').get(value,value.slice(0,-1)+'0')) throw Error('Directory already contains files: '+change.path);
      }
      const revision = randomUUID();
      writer.prepare("UPDATE metadata SET value=? WHERE key='head'").run(revision);
      writer.exec('COMMIT');
      try { assertDatabasePresent(); } catch (cause) { const error = Error('Local database identity disappeared during publication; the commit outcome must be reconciled from the original database.', { cause }); error.name = 'LocalCommitOutcomeUnknownError'; throw error; }
      return { revision, replay: false };
    } catch (error) { if (writer.isTransaction) writer.exec('ROLLBACK'); throw error; }
  }
  if (method === 'operationSave') { writer.prepare('INSERT INTO git_operations(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(args.record.operation.id,JSON.stringify(args.record)); return; }
  if (method === 'operationGet') { const row=writer.prepare('SELECT value FROM git_operations WHERE id=?').get(args.id); return row ? JSON.parse(row.value) : undefined; }
  if (method === 'operationList') return writer.prepare('SELECT value FROM git_operations ORDER BY id').all().map(row=>JSON.parse(row.value));
  if (method === 'close') { for (const id of [...readers.keys()]) release(id); if (writer) writer.close(); return; }
  throw Error('Unknown Local storage operation.');
};
try {
  if (workerData.writer) {
    let original;
    try { original = inspectIdentity(); }
    catch (error) {
      if (error.code !== 'DSS_LOCAL_DATABASE_UNAVAILABLE' || error.cause?.code !== 'ENOENT' || workerData.requireExisting) throw error;
      // Orphaned WAL/journal files are existing data, not a fresh installation.
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try { lstatSync(workerData.databasePath + suffix); }
        catch (sidecar) { if (sidecar.code === 'ENOENT') continue; throw sidecar; }
        throw unavailable();
      }
    }
    writer = new DatabaseSync(workerData.databasePath);
    databaseIdentity = inspectIdentity();
    if (original && !sameIdentity(original, databaseIdentity)) throw unavailable();
    if (workerData.requireExisting) {
      const tables = writer.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
      if (!['files', 'metadata'].every(name => tables.some(table => table.name === name))
        || !writer.prepare("SELECT value FROM metadata WHERE key='head'").get()?.value) throw unavailable();
    }
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS git_operations(id TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;");
    if (!writer.prepare('PRAGMA table_info(files)').all().some(column=>column.name==='binary')) writer.exec('ALTER TABLE files ADD COLUMN binary BLOB');
    writer.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('head',randomUUID());
    // DDL can outlive the path identity captured at open. Ready certifies this
    // final identity so the new owner needs no second verify round trip.
    assertDatabasePresent();
  }
  parentPort.on('message', ({ id, method, args, cancellation }) => {
    try {
      if (cancellation && Atomics.load(new Int32Array(cancellation),0)) { const error=Error('Local read was cancelled.'); error.name='AbortError'; throw error; }
      const result=execute(method,args);
      if (cancellation && Atomics.load(new Int32Array(cancellation),0)) {
        if (method==='snapshot') release(args.id);
        const error=Error('Local read was cancelled.'); error.name='AbortError'; throw error;
      }
      parentPort.postMessage({ id, result });
      if (method==='close') parentPort.close();
    } catch (error) { parentPort.postMessage({ id, error: serializeError(error) }); }
  });
  parentPort.postMessage({ ready: true, threadId, databaseIdentity });
} catch (error) { try { writer?.close(); } catch {} parentPort.postMessage({ startupError: serializeError(error) }); parentPort.close(); }
`;
