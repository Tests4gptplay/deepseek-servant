import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, parse, sep, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireKernelLock } from './kernel-lock.mjs';

const identity = h => ({ formatVersion: h.version ?? h.formatVersion, createdAt: h.createdAt,
  ...h.cwd === undefined ? {} : { cwd: h.cwd }, isSeeded: h.isSeeded ?? false });
const fingerprint = h => JSON.stringify(identity(h));
const stages = new Set(['closed', 'prepared', 'logs-removed']);

/** Lexical comparison only. Filesystem checks still inspect actual components.
 * Device namespaces and drive-relative paths are refused. */
export function comparablePath(path, platform = process.platform) {
  if (platform !== 'win32') return resolve(path);
  let value = path.replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(value)) value = '\\\\' + value.slice(8);
  else if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) value = value.slice(4);
  else if (/^\\\\[?.]\\/.test(value)) throw new Error('Unsupported Windows device namespace');
  if (!/^[A-Za-z]:\\/.test(value) && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value)) throw new Error('Windows path must be drive-absolute or UNC');
  value = win32.normalize(value);
  const root = win32.parse(value).root;
  while (value.length > root.length && value.endsWith('\\')) value = value.slice(0, -1);
  return value.toLowerCase();
}

/** Cleaner-owned lock/database paths share one Windows namespace even when
 * the configuration changes case or uses a standard extended path prefix. */
export function canonicalStorePath(path, platform = process.platform) {
  return comparablePath(platform === 'win32' ? win32.resolve(path) : resolve(path), platform);
}

/** Node identifies symlinks and junctions with isSymbolicLink. Native stat
 * adapters may also expose reparse flags/tags. Unexposed reparse metadata
 * is not claimed to have been inspected. */
export function recognizedLinkOrReparse(info) {
  return info.isSymbolicLink?.() === true || info.isReparsePoint?.() === true
    || typeof info.reparseTag === 'number' && info.reparseTag !== 0
    || typeof info.fileAttributes === 'number' && (info.fileAttributes & 0x400) !== 0
    || typeof info.attributes === 'number' && (info.attributes & 0x400) !== 0;
}

async function checkDirectoryTree(path, { allowMissing = false } = {}) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of ['', ...absolute.slice(root.length).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (allowMissing && error?.code === 'ENOENT') return; throw error; }
    if (recognizedLinkOrReparse(info) || !info.isDirectory()) throw new Error('Unsafe retirement store directory');
  }
  if (comparablePath(await realpath(absolute)) !== comparablePath(absolute)) throw new Error('Unsafe retirement store real path');
}

function rowValue(row) {
  if (!row) return;
  return { kind: 'dsh-native-cleanup-v2', sessionRoot: row.session_root,
    header: JSON.parse(row.header), stage: row.stage, retired: row.retired === 1,
    logsCompleted: row.logs_completed === 1, projectionCompleted: row.projection_completed === 1,
    inheritedEventCount: row.inherited_event_count ?? undefined };
}

/** Existing unfinished-cleanup records remain at their original location.
 * A completed operation releases only its exact record. Old records are not
 * enumerated or treated as new Host retirement instructions. */
export class RetirementStore {
  constructor(root, sessionRoot) {
    // Preserve the actual I/O spelling. Only named semaphore inputs are case-folded.
    this.root = process.platform === 'win32' ? win32.resolve(root) : resolve(root);
    this.lockRoot = canonicalStorePath(root);
    this.sessionRoot = canonicalStorePath(sessionRoot);
    this.openedDatabase = false;
  }
  async initialize() {
    await checkDirectoryTree(this.root, { allowMissing: true });
    // An already used journal contains recovery evidence. Recreating its folder
    // cannot recover that evidence and must not turn it into an empty journal.
    if (this.openedDatabase) {
      try { await lstat(join(this.root, 'retirements.sqlite')); }
      catch (error) { if (error?.code === 'ENOENT') throw this.missingDatabase(error); throw error; }
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await checkDirectoryTree(this.root);
  }
  missingDatabase(cause) {
    return Object.assign(new Error('The existing native cleanup journal is missing. Restore its original recovery records before retrying; an empty journal is not a recovery.', { cause }), { code: 'DSS_CLEANUP_JOURNAL_MISSING' });
  }
  async database(operation) {
    await this.initialize();
    const lock = await acquireKernelLock(join(this.lockRoot, 'journal.lock'), { wait: true, create: true });
    let db;
    try {
      const path = join(this.root, 'retirements.sqlite');
      try {
        const info = await lstat(path);
        if (recognizedLinkOrReparse(info) || !info.isFile() || info.nlink !== 1) throw new Error('Unsafe journal database');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (this.openedDatabase) throw this.missingDatabase(error);
      }
      db = new DatabaseSync(path);
      db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
      db.exec('CREATE TABLE IF NOT EXISTS retirements (session_root TEXT NOT NULL, id TEXT NOT NULL, identity TEXT NOT NULL, header TEXT NOT NULL, stage TEXT NOT NULL, inherited_event_count INTEGER, PRIMARY KEY(session_root,id,identity));');
      const columns = db.prepare('PRAGMA table_info(retirements)').all();
      if (!columns.some(row => row.name === 'inherited_event_count')) db.exec('ALTER TABLE retirements ADD COLUMN inherited_event_count INTEGER');
      // Old closed/prepared rows never become permanent-retirement authority.
      if (!columns.some(row => row.name === 'retired')) db.exec('ALTER TABLE retirements ADD COLUMN retired INTEGER NOT NULL DEFAULT 0');
      // The existing exact retirement owns both independent unfinished duties.
      // Old intermediate stages do not prove that resource close succeeded.
      if (!columns.some(row => row.name === 'logs_completed')) db.exec('ALTER TABLE retirements ADD COLUMN logs_completed INTEGER NOT NULL DEFAULT 0');
      if (!columns.some(row => row.name === 'projection_completed')) db.exec('ALTER TABLE retirements ADD COLUMN projection_completed INTEGER NOT NULL DEFAULT 0');
      this.openedDatabase = true;
      return operation(db);
    } finally { try { db?.close(); } finally { await lock.close(); } }
  }
  async read(id, header) {
    return this.database(db => {
      // The existing writer already canonicalizes this root, including Windows
      // case and extended prefixes. Read that identity through the primary key.
      const row = header
        ? db.prepare('SELECT * FROM retirements WHERE session_root=? AND id=? AND identity=? ORDER BY rowid DESC LIMIT 1').get(this.sessionRoot, id, fingerprint(header))
        : db.prepare('SELECT * FROM retirements WHERE session_root=? AND id=? ORDER BY rowid DESC LIMIT 1').get(this.sessionRoot, id);
      return rowValue(row);
    });
  }
  async write(header, stage, { inheritedEventCount } = {}) {
    if (!stages.has(stage)) throw new Error('Invalid cleanup stage');
    return this.database(db => db.prepare('INSERT INTO retirements (session_root,id,identity,header,stage,inherited_event_count) VALUES (?,?,?,?,?,?) ON CONFLICT(session_root,id,identity) DO UPDATE SET header=excluded.header,stage=excluded.stage,inherited_event_count=COALESCE(excluded.inherited_event_count,retirements.inherited_event_count)')
      .run(this.sessionRoot, header.id, fingerprint(header), JSON.stringify(header), stage, inheritedEventCount ?? null));
  }
  async accept(lives, verify) {
    return this.database(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const insert = db.prepare("INSERT INTO retirements (session_root,id,identity,header,stage,inherited_event_count,retired) VALUES (?,?,?,?,?,?,1) ON CONFLICT(session_root,id,identity) DO UPDATE SET retired=1,inherited_event_count=COALESCE(excluded.inherited_event_count,retirements.inherited_event_count)");
        const read = db.prepare('SELECT * FROM retirements WHERE session_root=? AND id=? AND identity=?');
        const accepted = [];
        for (const life of lives) {
          verify?.(life);
          insert.run(this.sessionRoot, life.id, fingerprint(life.header), JSON.stringify(life.header), 'retired', life.inheritedEventCount ?? null);
          accepted.push(rowValue(read.get(this.sessionRoot, life.id, fingerprint(life.header))));
        }
        db.exec('COMMIT');
        return accepted;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Retirement acceptance and rollback failed'); }
        throw error;
      }
    });
  }
  async accepted() {
    // Startup reads only this existing store's explicitly accepted identities.
    // Do not create an empty journal merely because the plugin was mounted.
    try { await lstat(join(this.root, 'retirements.sqlite')); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (this.openedDatabase) throw this.missingDatabase(error);
      return [];
    }
    return this.database(db => db.prepare('SELECT * FROM retirements WHERE session_root=? AND retired=1 ORDER BY rowid').all(this.sessionRoot).map(rowValue));
  }
  complete(header) { return this.completeDuty(header, 'logs_completed'); }
  completeProjection(header) { return this.completeDuty(header, 'projection_completed'); }
  async completeDuty(header, column) {
    if (column !== 'logs_completed' && column !== 'projection_completed') throw new Error('Unknown cleanup duty');
    return this.database(db => {
      const key = [this.sessionRoot, header.id, fingerprint(header)];
      let result, retained;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`UPDATE retirements SET ${column}=1 WHERE session_root=? AND id=? AND identity=?`).run(...key);
        result = db.prepare('DELETE FROM retirements WHERE session_root=? AND id=? AND identity=? AND logs_completed=1 AND projection_completed=1').run(...key);
        retained = !!db.prepare('SELECT 1 FROM retirements WHERE session_root=? AND id=? AND identity=?').get(...key);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Cleanup completion and rollback failed'); }
        throw error;
      }
      db.exec('PRAGMA incremental_vacuum(32)');
      return { ...result, retained };
    });
  }
}

