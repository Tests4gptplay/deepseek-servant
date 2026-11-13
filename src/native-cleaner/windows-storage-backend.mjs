import * as nodeFs from 'node:fs/promises';
import { win32 } from 'node:path';
import { constants as bufferConstants } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EXACT_FILE_OPEN_POLICY, prepareExactFile, sessionHeaderMatches } from './exact-file.mjs';
import { checkedWindowsPath, loadWindowsFileApi } from './windows-native-api.mjs';
import { cacheLifecycleMatches } from './cache-domain.mjs';
export { cacheLifecycleMatches } from './cache-domain.mjs';

const missing = error => error?.code === 'ENOENT';
const refuse = message => Object.assign(new Error(message), { code: 'EWIN32STORAGE', retainRecoveryEvidence: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const result = (more = {}) => ({ namespaceDurability: 'unverified', retainRecoveryEvidence: true, ...more });
export function comparableWindowsPath(path) {
  const native = checkedWindowsPath(path, { directory: true });
  return win32.resolve(native.slice(4)).toLowerCase();
}
const samePath = (a, b) => comparableWindowsPath(a) === comparableWindowsPath(b);
const sameObject = (a, b) => a.volumeId === b.volumeId && a.fileId === b.fileId;
const ordinary = info => info?.kind === 'file' && !info.reparse && info.links === 1;

// The official rc.5 pathname codec, kept independent of host path semantics.
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || !raw.length) throw refuse('Empty path segment');
  if (raw === '.') return '~002E'; if (raw === '..') return '~002E~002E';
  let out = ''; for (let i = 0; i < raw.length; i++) out += /^[A-Za-z0-9._-]$/.test(raw[i]) ? raw[i] : '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return out;
}
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || !cwd.length) throw refuse('Empty cwd');
  let out = '', separator = false;
  for (let i = 0; i < cwd.length; i++) {
    const c = cwd[i]; if (c === '/' || c === '\\' || c === ':') { if (!separator) out += '-'; separator = true; }
    else { out += /^[A-Za-z0-9._-]$/.test(c) ? c : '~' + cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0'); separator = false; }
  }
  return `--${(out.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
export const sessionDirectory = (root, header) => win32.join(root, header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd), encodeSegment(header.id));

async function closeAll(items) {
  const errors = [];
  for (const item of [...items].reverse()) try { await item?.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'One or more held Windows resources could not close');
}

/** All ancestors are held without delete sharing. No procfs path and no sync(). */
export async function pinWindowsDirectory(api, path) {
  const nativePath = checkedWindowsPath(path, { directory: true });
  const plain = nativePath.slice(4), root = win32.parse(plain).root;
  const paths = [root]; let current = root;
  for (const part of plain.slice(root.length).split('\\').filter(Boolean)) { current = win32.join(current, part); paths.push(current); }
  const held = []; let closing;
  const close = () => closing ??= closeAll(held.map(({ handle }) => ({ close: () => api.close(handle) })));
  const verify = async () => {
    if (closing) throw refuse('Directory pin is closed');
    for (const { handle, initial } of held) {
      const now = await api.info(handle);
      if (now.kind !== 'directory' || now.reparse || !sameObject(now, initial)) throw refuse('Pinned directory changed or became a reparse point');
    }
  };
  try {
    for (const part of paths) {
      const handle = await api.openDirectory(part), entry = { handle }; held.push(entry);
      entry.initial = await api.info(handle);
      if (entry.initial.kind !== 'directory' || entry.initial.reparse) throw refuse('Directory route contains a non-directory or reparse point');
    }
    await verify(); return Object.freeze({ path: win32.normalize(path), verify, close });
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Directory acquisition and cleanup failed'); }
    throw error;
  }
}

function deletionPlan(targets, preservedArtifacts, resources, verify) {
  let deletion, closing, closed = false;
  return Object.freeze({ targets, preservedArtifacts, bytes: targets.reduce((n, t) => n + t.identity.size, 0n),
    deleteExact(beforeEach = async () => {}) {
      if (deletion) return deletion;
      if (closed) return Promise.reject(refuse('Deletion plan is closed'));
      deletion = (async () => {
        for (const target of targets) { await verify(); await beforeEach(target); await target.prepared.deleteExact(); }
        return result({ status: 'disposition-requested', files: targets.length });
      })(); return deletion;
    },
    close() { return closing ??= (async () => { closed = true; if (deletion) await deletion.catch(() => {}); await closeAll(resources); })(); },
  });
}

/** Executable Windows backend. Each log plan owns its native session lease. */
export class WindowsStorageBackend {
  // Official JSON is UTF-8: one UTF-16 code unit can occupy up to three bytes.
  // This is an encoding ceiling, not a memory budget or a cache policy limit.
  constructor({ api, fs = nodeFs, acquireLock, parseGeneration, maxDocumentBytes = 3 * bufferConstants.MAX_STRING_LENGTH } = {}) {
    if (!api || typeof acquireLock !== 'function' || typeof parseGeneration !== 'function') throw new TypeError('Native API, official-compatible lock and generation parser are required');
    if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes < 1) throw new RangeError('Invalid JSON byte bound');
    Object.assign(this, { api, fs, acquireLock, parseGeneration, maxDocumentBytes });
    this.platform = 'win32'; this.namespaceDurability = 'unverified'; this.retainRecoveryEvidence = true;
  }
  legacyLockPath(storageRoot) { return win32.join(comparableWindowsPath(storageRoot), '.native-cleaner-legacy.lock'); }
  async names(pin) {
    await pin.verify(); const names = await this.fs.readdir(pin.path); await pin.verify();
    if (names.some(name => typeof name !== 'string' || !name || /[\\/\0]/.test(name) || name === '.' || name === '..')) throw refuse('Invalid directory entry name');
    return names;
  }
  async planLogs({ root, life, allowMissing = false }) {
    let pin; const resources = [], targets = [], preserved = [];
    try {
      const sessionPath = sessionDirectory(root, life.header);
      try { pin = await pinWindowsDirectory(this.api, sessionPath); }
      catch (error) { if (missing(error) && allowMissing) return deletionPlan([], [], [], async () => {}); throw error; }
      resources.push(pin);
      resources.push(await this.acquireLock(win32.join(sessionPath, 'session.lock')));
      for (const name of await this.names(pin)) {
        if (name === 'session.lock') continue;
        const compressed = name.endsWith('.zstd'), version = this.parseGeneration(compressed ? name.slice(0, -5) : name);
        if (version === undefined) { preserved.push(name); continue; }
        if (version > life.header.version) throw refuse('Future format generation retained');
        const path = win32.join(pin.path, name);
        const prepared = await prepareExactFile(this.api, path, { mode: compressed ? 'jsonl-zstd' : 'jsonl',
          validate: actual => sessionHeaderMatches(actual, { ...life.header, id: life.id, version }) });
        resources.push(prepared); targets.push({ name, path, identity: prepared.identity, info: { size: prepared.identity.size }, prepared });
      }
      return deletionPlan(targets, preserved, resources, () => pin.verify());
    } catch (error) { try { await closeAll(resources); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Log planning and cleanup failed'); } throw error; }
  }
  async planCache({ directory, life, acceptedVersions }) {
    let pin; const resources = [], targets = [], preserved = [];
    if (!/^[A-Za-z0-9_-]+$/.test(life.id)) throw refuse('Session ID is unsupported by official cache key codec');
    try {
      try { pin = await pinWindowsDirectory(this.api, directory); }
      catch (error) { if (missing(error)) return deletionPlan([], [], [], async () => {}); throw error; }
      resources.push(pin);
      const current = life.id + '.json';
      for (const name of (await this.names(pin)).filter(name => name === current || name.startsWith(current + '.bak.'))) {
        try {
          const path = win32.join(pin.path, name);
          const prepared = await prepareExactFile(this.api, path, { mode: 'cache', maxBytes: this.maxDocumentBytes,
            validate: row => acceptedVersions.includes(row?.version) && cacheLifecycleMatches(life.header, row?.record?.identity) });
          resources.push(prepared); targets.push({ name, path, identity: prepared.identity, info: { size: prepared.identity.size }, prepared });
        } catch (error) { if (name === current) throw error; preserved.push(name); }
      }
      return deletionPlan(targets, preserved, resources, () => pin.verify());
    } catch (error) { try { await closeAll(resources); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Cache planning and cleanup failed'); } throw error; }
  }
  async readLegacy(path) {
    const handle = await this.api.openLegacy(path); let closed = false;
    const close = async () => { if (!closed) { closed = true; await this.api.close(handle); } };
    try {
      const initial = await this.api.info(handle);
      if (!ordinary(initial)) throw refuse('Unsafe legacy file');
      if (initial.size > BigInt(this.maxDocumentBytes)) throw refuse('Legacy document exceeds the configured JSON byte limit');
      let size = 0; const parts = [];
      for (;;) {
        const bytes = await this.api.read(handle, Math.min(1024 * 1024, this.maxDocumentBytes + 1 - size));
        if (!Buffer.isBuffer(bytes) || bytes.length > Math.min(1024 * 1024, this.maxDocumentBytes + 1 - size)) throw refuse('Invalid bounded legacy read');
        if (!bytes.length) break;
        size += bytes.length; if (size > this.maxDocumentBytes) throw refuse('Legacy document exceeds the configured JSON byte limit'); parts.push(bytes);
      }
      const bytes = Buffer.concat(parts, size);
      const verify = async () => { if (closed || !isDeepStrictEqual(await this.api.info(handle), initial)) throw refuse('Held legacy file changed'); };
      await verify();
      return { bytes, digest: digest(bytes), identity: initial, verify, close };
    } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Legacy read and cleanup failed'); } throw error; }
  }
  async snapshot(path) { try { const held = await this.readLegacy(path); try { return { digest: held.digest, identity: held.identity }; } finally { await held.close(); } } catch (error) { if (missing(error)) return; throw error; } }
  async writeNew(path, bytes, { onCreated } = {}) {
    const handle = await this.api.createNew(path);
    try {
      const info = await this.api.info(handle); if (!ordinary(info) || info.size !== 0n) throw refuse('Fresh legacy temporary is unsafe');
      await onCreated?.(info);
      for (let offset = 0; offset < bytes.length;) {
        const block = bytes.subarray(offset, offset + 1024 * 1024), count = await this.api.write(handle, block);
        if (!Number.isSafeInteger(count) || count < 1 || count > block.length) throw refuse('Invalid native write count'); offset += count;
      }
      await this.api.flush(handle); // Real file-data flush, never a namespace-sync substitute.
      return await this.api.info(handle);
    } finally { await this.api.close(handle); }
  }
  async cleanupArtifact(path, expectedDigest, expectedObject) {
    let prepared; const hash = createHash('sha256');
    try {
      const api = { ...this.api, read: async (handle, count) => { const bytes = await this.api.read(handle, count); hash.update(bytes); return bytes; } };
      prepared = await prepareExactFile(api, path, { mode: 'cache', maxBytes: this.maxDocumentBytes,
        validate: () => hash.digest('hex') === expectedDigest });
      if (!expectedObject || !sameObject(prepared.identity, expectedObject)) throw refuse('Recovery artifact identity is not the recorded object');
      await prepared.deleteExact(); return false;
    } catch (error) { if (missing(error)) return false; return true; }
    finally { await prepared?.close(); }
  }
  async cleanupIntent(intent) {
    const retained = [];
    if (await this.cleanupArtifact(intent.backup, intent.originalDigest, intent.originalObject)) retained.push(intent.backup);
    // A failed write may leave invalid JSON. Only a durable CREATE_NEW file ID,
    // rather than the intended complete digest, authorizes partial-temp cleanup.
    if (await this.deleteOwnedTemporary(intent.temp, intent.replacementObject)) retained.push(intent.temp);
    return retained;
  }
  async deleteOwnedTemporary(path, object) {
    let handle;
    try {
      handle = await this.api.open(path, EXACT_FILE_OPEN_POLICY);
      const info = await this.api.info(handle);
      if (!ordinary(info) || !object || !sameObject(info, object)) return true;
      // This is our CREATE_NEW temporary, whose native identity was committed
      // before its first write. Partial or malformed bytes do not make it a
      // different user's file. Disposition targets this same held object.
      await this.api.disposition(handle, { deleteFile: true }); return false;
    } catch (error) { if (missing(error)) return false; return true; }
    finally { if (handle !== undefined) await this.api.close(handle); }
  }
  async cleanupRestoreTemps(root, recovery) {
    const artifacts = [], source = win32.join(root, 'session_projcache.json');
    for (const row of await recovery.restoreRecords(root)) {
      if (!samePath(row.storageRoot, root) || !/^[a-f0-9-]{36}$/.test(row.id)
        || !samePath(row.path, source + '.native-cleaner-restore-' + row.id + '.tmp')) throw refuse('Invalid snapshot restore intent');
      const retained = await this.deleteOwnedTemporary(row.path, row.object);
      if (retained) artifacts.push(row.path); else await recovery.releaseRestored(row);
    }
    return artifacts;
  }
  async restoreSnapshot(source, snapshot, root, recovery) {
    const bytes = Buffer.from(snapshot.bytes);
    if (bytes.length > this.maxDocumentBytes || digest(bytes) !== snapshot.digest) throw refuse('Legacy SQLite snapshot failed its digest or size check');
    const id = randomUUID(), path = source + '.native-cleaner-restore-' + id + '.tmp';
    const row = { id, storageRoot: root, path };
    await recovery.planRestore(row);
    try {
      await this.writeNew(path, bytes, { onCreated: async info => {
        row.object = { volumeId: info.volumeId, fileId: info.fileId };
        await recovery.updateRestore(row); // Durable identity before first byte.
      } });
      await this.api.moveNew(path, source); // Never overwrite a competing main.
      if ((await this.snapshot(source))?.digest !== snapshot.digest) throw refuse('Restored SQLite snapshot failed verification');
      // This new temporary was moved, and the destination was just verified.
      // Its exact intent has no remaining temporary-file responsibility.
      await recovery.releaseRestored(row);
    } catch (error) { Object.assign(error, { retainRecoveryEvidence: true, recoveryArtifacts: [path] }); throw error; }
  }
  async recoverLegacy({ storageRoot, recovery, lockHeld = false }) {
    if (typeof recovery?.database === 'function') recovery = createLegacyRecovery(recovery);
    if (!recovery) throw refuse('Durable legacy recovery store is required');
    const pin = await pinWindowsDirectory(this.api, storageRoot); let lock;
    const artifacts = [], conflicts = [];
    try {
      if (!lockHeld) lock = await this.acquireLock(this.legacyLockPath(pin.path), { wait: true, create: true });
      const records = await recovery.retained(pin.path);
      for (const intent of records) validateIntent(intent, pin.path);
      const source = win32.join(pin.path, 'session_projcache.json');
      if (!await this.snapshot(source)) {
        // The last validated source bytes are committed before ReplaceFileW,
        // then replaced with validated new bytes after it. Thus this one fixed
        // snapshot is never older than a mutation that could remove main.
        const snapshot = await recovery.snapshot(pin.path);
        if (snapshot) { await pin.verify(); await this.restoreSnapshot(source, snapshot, pin.path, recovery); }
        else {
          for (const intent of records) {
            const backup = await this.snapshot(intent.backup);
            if (backup?.digest !== intent.originalDigest) continue;
            const temporary = await this.snapshot(intent.temp);
            if (temporary && temporary.digest !== intent.replacementDigest) throw refuse('Known recovery temporary has unknown bytes');
            await pin.verify(); await this.api.moveNew(temporary ? intent.temp : intent.backup, source);
            const restored = await this.snapshot(source);
            if (restored?.digest !== (temporary ? intent.replacementDigest : intent.originalDigest)) throw refuse('Restored legacy source failed verification');
            break;
          }
          if (records.length && !await this.snapshot(source)) throw refuse('Missing legacy source cannot be restored from recorded evidence');
        }
      }
      // Keep snapshot responsibility until a missing main has been restored.
      artifacts.push(...await this.cleanupRestoreTemps(pin.path, recovery));
      // Replay only unfinished exact removals, never historical completed work.
      // A completed record may still own an artifact, but is not a new prune.
      const seen = new Set();
      for (const intent of records) {
        if (intent.stage !== 'prepared') continue;
        const key = JSON.stringify([intent.life, intent.acceptedVersions]);
        if (seen.has(key)) continue; seen.add(key);
        const reapplied = await this.pruneLegacy({ storageRoot: pin.path, life: intent.life,
          acceptedVersions: intent.acceptedVersions, recovery, lockHeld: true, skipRecovery: true });
        artifacts.push(...reapplied.recoveryArtifacts); conflicts.push(...reapplied.preservedArtifacts);
      }
      if (records.length) {
        const current = await this.readLegacy(source);
        try {
          let data; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes)); } catch {}
          const sourceRecognized = data?.unit?.name === 'session_projcache'
            && data.tables?.sessions && typeof data.tables.sessions === 'object' && !Array.isArray(data.tables.sessions);
          const canComplete = intent => ['prepared', 'completed-retained'].includes(intent.stage)
            && sourceRecognized && intent.acceptedVersions.includes(data.unit.version)
            && !Object.hasOwn(data.tables.sessions, intent.life.id);
          if (records.some(canComplete)) await recovery.saveSnapshot(pin.path, current.bytes);
          for (const intent of records) {
            if (canComplete(intent)) {
              await current.verify();
              if (intent.stage === 'prepared') await recovery.finish(intent.id);
              const retained = await this.cleanupIntent(intent);
              artifacts.push(...retained);
              if (!retained.length) await recovery.releaseCompleted(intent);
            } else {
              for (const path of [intent.temp, intent.backup]) {
                try { if (await this.snapshot(path)) artifacts.push(path); } catch { artifacts.push(path); }
              }
            }
          }
        } finally { await current.close(); }
      }
      return result({ preservedArtifacts: [...new Set(conflicts)], recoveryArtifacts: [...new Set(artifacts)] });
    } finally { try { await lock?.close(); } finally { await pin.close(); } }
  }
  async pruneLegacy({ storageRoot, life, acceptedVersions, recovery, lockHeld = false, skipRecovery = false }) {
    if (!storageRoot) return result({ preservedArtifacts: [], recoveryArtifacts: [] });
    if (typeof recovery?.database === 'function') recovery = createLegacyRecovery(recovery);
    if (!recovery) throw refuse('Durable legacy recovery store is required');
    const pin = await pinWindowsDirectory(this.api, storageRoot); let lock, held;
    const source = win32.join(pin.path, 'session_projcache.json');
    let intent;
    try {
      if (!lockHeld) lock = await this.acquireLock(this.legacyLockPath(pin.path), { wait: true, create: true });
      const previous = skipRecovery ? { preservedArtifacts: [], recoveryArtifacts: [] } : await this.recoverLegacy({ storageRoot: pin.path, recovery, lockHeld: true });
      const output = result({ preservedArtifacts: previous.preservedArtifacts, recoveryArtifacts: previous.recoveryArtifacts });
      try { held = await this.readLegacy(source); } catch (error) { if (missing(error)) return output; throw error; }
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(held.bytes)); }
      catch { output.preservedArtifacts.push('session_projcache.json'); return output; }
      if (data?.unit?.name !== 'session_projcache' || !acceptedVersions.includes(data.unit.version)
        || !data.tables?.sessions || typeof data.tables.sessions !== 'object' || Array.isArray(data.tables.sessions)) {
        output.preservedArtifacts.push('session_projcache.json'); return output;
      }
      if (!Object.hasOwn(data.tables.sessions, life.id)) return output;
      if (!cacheLifecycleMatches(life.header, data.tables.sessions[life.id]?.identity)) { output.preservedArtifacts.push('session_projcache.json'); return output; }
      delete data.tables.sessions[life.id];
      const bytes = Buffer.from(JSON.stringify(data) + '\n');
      if (bytes.length > this.maxDocumentBytes) throw refuse('Legacy replacement exceeds the configured JSON byte limit');
      const id = randomUUID(), temp = source + '.native-cleaner-' + id + '.tmp', backup = source + '.native-cleaner-' + id + '.bak';
      intent = { id, storageRoot: pin.path, source, temp, backup, life: { id: life.id, header: life.header }, acceptedVersions, originalObject: { volumeId: held.identity.volumeId, fileId: held.identity.fileId }, originalDigest: held.digest, replacementDigest: digest(bytes), stage: 'prepared' };
      await recovery.put(intent); // FULL SQLite commit precedes all source mutation.
      await this.writeNew(temp, bytes, { onCreated: async info => {
        intent.replacementObject = { volumeId: info.volumeId, fileId: info.fileId };
        await recovery.update(intent); // Durable identity before first byte.
      } });
      await pin.verify(); await held.verify();
      const current = await this.snapshot(source);
      if (!current || !sameObject(current.identity, held.identity) || current.digest !== held.digest) throw refuse('Legacy source path changed before replacement');
      if (await this.snapshot(backup)) throw refuse('Legacy backup path unexpectedly exists');
      await recovery.saveSnapshot(pin.path, held.bytes);
      await this.api.replace(source, temp, backup);
      const replaced = await this.snapshot(source), saved = await this.snapshot(backup);
      if (replaced?.digest !== intent.replacementDigest || saved?.digest !== intent.originalDigest) throw refuse('Legacy replacement or backup could not be verified');
      // Retain the latest snapshot and exact intent until artifact cleanup
      // finishes. Completed operations do not remain permanent replay records.
      await recovery.completeReplacement(pin.path, bytes, id);
      await held.close(); held = undefined;
      const retained = await this.cleanupIntent(intent);
      output.recoveryArtifacts.push(...retained);
      if (!retained.length) await recovery.releaseCompleted(intent);
      return output;
    } catch (error) {
      if (intent) Object.assign(error, { retainRecoveryEvidence: true, recoveryArtifacts: [intent.source, intent.temp, intent.backup] });
      throw error;
    } finally { try { await held?.close(); } finally { try { await lock?.close(); } finally { await pin.close(); } } }
  }
}

function validateIntent(row, root) {
  const source = win32.join(root, 'session_projcache.json');
  if (!row || !samePath(row.storageRoot, root) || !samePath(row.source, source) || !/^[a-f0-9-]{36}$/.test(row.id)
    || !samePath(row.temp, source + '.native-cleaner-' + row.id + '.tmp')
    || !samePath(row.backup, source + '.native-cleaner-' + row.id + '.bak')
    || typeof row.life?.id !== 'string' || row.life.id !== row.life.header?.id || !Number.isFinite(row.life.header?.createdAt)
    || !Number.isSafeInteger(row.life.header?.version) || !Array.isArray(row.acceptedVersions) || !row.acceptedVersions.every(Number.isInteger)
    || !/^[a-f0-9]{64}$/.test(row.originalDigest) || !/^[a-f0-9]{64}$/.test(row.replacementDigest))
    throw refuse('Invalid legacy recovery intent; no artifact touched');
}

/** Reuses RetirementStore.database: one fixed SQLite file for unfinished work. */
export function createLegacyRecovery(store) {
  if (typeof store?.database !== 'function') throw new TypeError('RetirementStore.database is required');
  const saveSnapshot = (db, root, bytes) => db.prepare('INSERT INTO windows_legacy_snapshot(storage_root,digest,contents) VALUES (?,?,?) ON CONFLICT(storage_root) DO UPDATE SET digest=excluded.digest,contents=excluded.contents').run(comparableWindowsPath(root), digest(bytes), bytes);
  const run = operation => store.database(db => {
    db.exec('CREATE TABLE IF NOT EXISTS windows_legacy_intents (id TEXT PRIMARY KEY, storage_root TEXT NOT NULL, stage TEXT NOT NULL, intent TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS windows_legacy_snapshot (storage_root TEXT PRIMARY KEY, digest TEXT NOT NULL, contents BLOB NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS windows_legacy_restore (id TEXT PRIMARY KEY, storage_root TEXT NOT NULL, intent TEXT NOT NULL)');
    return operation(db);
  });
  const release = (table, row, stage = '') => run(db => {
    const root = comparableWindowsPath(row.storageRoot);
    db.exec('BEGIN IMMEDIATE');
    try {
      const removed = db.prepare(`DELETE FROM ${table} WHERE id=? AND storage_root=?${stage}`).run(row.id, root);
      if (removed.changes) db.prepare(`DELETE FROM windows_legacy_snapshot WHERE storage_root=?
        AND NOT EXISTS (SELECT 1 FROM windows_legacy_intents WHERE storage_root=?)
        AND NOT EXISTS (SELECT 1 FROM windows_legacy_restore WHERE storage_root=?)`).run(root, root, root);
      db.exec('COMMIT');
      return removed;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Legacy evidence release and rollback failed'); }
      throw error;
    }
  });
  return Object.freeze({
    planRestore(row) { return run(db => db.prepare('INSERT INTO windows_legacy_restore(id,storage_root,intent) VALUES (?,?,?)').run(row.id, comparableWindowsPath(row.storageRoot), JSON.stringify(row))); },
    updateRestore(row) { return run(db => db.prepare('UPDATE windows_legacy_restore SET intent=? WHERE id=?').run(JSON.stringify(row), row.id)); },
    releaseRestored(row) { return release('windows_legacy_restore', row); },
    releaseCompleted(row) { return release('windows_legacy_intents', row, " AND stage='completed-retained'"); },
    restoreRecords(root) { return run(db => db.prepare('SELECT intent FROM windows_legacy_restore WHERE storage_root=? ORDER BY rowid').all(comparableWindowsPath(root)).map(row => JSON.parse(row.intent))); },
    put(row) { return run(db => db.prepare('INSERT INTO windows_legacy_intents(id,storage_root,stage,intent) VALUES (?,?,?,?)')
      .run(row.id, comparableWindowsPath(row.storageRoot), 'prepared', JSON.stringify(row))); },
    update(row) { return run(db => db.prepare('UPDATE windows_legacy_intents SET intent=? WHERE id=?').run(JSON.stringify(row), row.id)); },
    saveSnapshot(root, bytes) { return run(db => saveSnapshot(db, root, bytes)); },
    completeReplacement(root, bytes, id) {
      return run(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          saveSnapshot(db, root, bytes);
          db.prepare('UPDATE windows_legacy_intents SET stage=? WHERE id=? AND storage_root=?').run('completed-retained', id, comparableWindowsPath(root));
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Legacy completion and rollback failed'); }
          throw error;
        }
      });
    },
    snapshot(root) { return run(db => { const row = db.prepare('SELECT digest,contents FROM windows_legacy_snapshot WHERE storage_root=?').get(comparableWindowsPath(root)); return row && { digest: row.digest, bytes: Buffer.from(row.contents) }; }); },
    retained(root) { return run(db => db.prepare('SELECT intent,stage FROM windows_legacy_intents WHERE storage_root=? ORDER BY rowid DESC').all(comparableWindowsPath(root)).map(row => ({ ...JSON.parse(row.intent), stage: row.stage }))); },
    finish(id) {
      return run(db => db.prepare("UPDATE windows_legacy_intents SET stage='completed-retained' WHERE id=?").run(id));
    },
  });
}
export async function loadWindowsStorageBackend(options) {
  const { api, layout, koffiVersion } = await loadWindowsFileApi(options);
  return Object.assign(new WindowsStorageBackend({ ...options, api }), { nativeLayout: layout, koffiVersion });
}
