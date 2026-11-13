import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'

// Execute the actual source, without a build, package install, SQLite substitute,
// mocked schema, production user database, Windows device, or Git operation.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(target))) return { url: target.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { withLegacySqliteSnapshot, LegacySqliteReadError } = await import('../src/framework/legacy-sqlite-reader.ts')
const { localFilesWorkerSource, historicalProducer } = await import('./test-support/historical-v44/load-sql-producer.mjs')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-legacy-reader-'))
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (action, expected) => { await assert.rejects(action, expected); assertions++ }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashFile = async name => digest(await fs.readFile(name))
const collect = async snapshot => { const result = []; for await (const entry of snapshot.entries()) result.push(entry); return result }
const read = databasePath => withLegacySqliteSnapshot(databasePath, collect)
const asFiles = rows => new Map(rows.filter(row => row.kind === 'file').map(row => [row.path, row]))
const openWorker = async databasePath => {
  const worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath, writer: true }, name: 'legacy-fixture-v44' })
  const pending = new Map()
  let sequence = 0, ready, failed
  const startup = new Promise((resolve, reject) => { ready = resolve; failed = reject })
  const exit = new Promise(resolve => worker.once('exit', resolve))
  worker.on('error', error => { failed(error); for (const request of pending.values()) request.reject(error) })
  worker.on('message', message => {
    if (message.startupError) { failed(Object.assign(Error(message.startupError.message), message.startupError)); return }
    if (message.ready) { ready(); return }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(Object.assign(Error(message.error.message), message.error)); else request.resolve(message.result)
  })
  await startup
  return {
    request(method, args = {}) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args }) }) },
    async close() { await this.request('close'); await exit },
    async terminate() { await worker.terminate(); await exit },
  }
}
let worker, extra
try {
  const databasePath = path.join(sandbox, 'actual-v44.sqlite')
  worker = await openWorker(databasePath)
  const text = '\uFEFF  {"事实":"原始文本🙂"}\r\n\u0000tail\n'
  const initial = [
    { path: 'tasks/existing.json', content: text },
    { path: 'state/member/task/Planner', content: '' },
    { path: 'archives/task/data.bin', bytes: new Uint8Array([0, 0xff, 0x80, 0x0a]) },
    { path: 'archives/task/empty.bin', bytes: new Uint8Array() },
    { path: 'future-category/unclassified.dat', content: 'keep unknown category' },
  ]
  await worker.request('commit', { changes: initial, dependencies: [], revision: 'fixture-only' })
  extra = new DatabaseSync(databasePath)
  // Fixture-only mutation demonstrates that non-NULL zero binary wins over text.
  extra.prepare('UPDATE files SET content=? WHERE path=?').run('must not resurrect stale text', 'archives/task/empty.bin')
  const schemaBefore = extra.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()
  const mainBefore = await hashFile(databasePath), walBefore = await hashFile(databasePath + '-wal')
  check((await fs.stat(databasePath + '-wal')).size > 32, true)
  let rows = await read(databasePath), files = asFiles(rows)
  check(rows.length, initial.length)
  check(rows.every(row => row.kind === 'file'), true)
  check([...files.get('tasks/existing.json').bytes], [...Buffer.from(text)])
  check([...files.get('tasks/existing.json').bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])
  check([...files.get('archives/task/data.bin').bytes], [0, 0xff, 0x80, 0x0a])
  check([...files.get('archives/task/empty.bin').bytes], [])
  check(files.get('archives/task/empty.bin').source.representation, 'binary')
  check(files.get('state/member/task/Planner').source.representation, 'text')
  check(files.get('state/member/task/Planner').bytes.length, 0)
  check(Buffer.from(files.get('future-category/unclassified.dat').bytes).toString(), 'keep unknown category')
  check(rows.every(row => row.kind === 'file' && row.issues.length === 0), true)
  check(files.has('head'), false)
  check(files.has('metadata/head'), false)
  check(await hashFile(databasePath), mainBefore)
  check(await hashFile(databasePath + '-wal'), walBefore)
  check(extra.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(), schemaBefore)
  check(extra.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')

  // A committed writer update AFTER callback entry but BEFORE iteration is not
  // visible. Awaited scratch materialization and a repeat enumeration use one view.
  let escapedView, escapedIterator
  const output = path.join(sandbox, 'materialized')
  await withLegacySqliteSnapshot(databasePath, async snapshot => {
    escapedView = snapshot
    check(snapshot.schema, { hasBinary: true, textEncoding: 'UTF-8' })
    await worker.request('commit', { changes: [
      { path: 'tasks/existing.json', content: 'committed later' },
      { path: 'tasks/later.json', content: 'later' },
    ], dependencies: [], revision: 'fixture-only' })
    const first = await collect(snapshot)
    check(first.map(row => row.path), rows.map(row => row.path))
    check([...asFiles(first).get('tasks/existing.json').bytes], [...Buffer.from(text)])
    for (const entry of first) {
      check(entry.kind, 'file')
      const target = path.join(output, ...entry.path.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, entry.bytes)
      check([...await fs.readFile(target)], [...entry.bytes])
    }
    check(await collect(snapshot), first)
    escapedIterator = snapshot.entries()
    await escapedIterator.next() // Intentionally abandoned; callback owns cleanup.
  })
  await rejects(() => escapedIterator.next(), { code: 'DSS_LEGACY_VIEW_CLOSED' })
  await rejects(async () => escapedView.entries(), { code: 'DSS_LEGACY_VIEW_CLOSED' })
  files = asFiles(await read(databasePath))
  check(Buffer.from(files.get('tasks/existing.json').bytes).toString(), 'committed later')
  check(files.has('tasks/later.json'), true)

  // Dirty transactions never cross the source read boundary.
  extra.exec('BEGIN IMMEDIATE')
  extra.prepare('INSERT INTO files(path,content,version,bytes,binary) VALUES (?,?,?,?,?)').run('tasks/uncommitted.json', 'dirty', 'v', 5, null)
  check(asFiles(await read(databasePath)).has('tasks/uncommitted.json'), false)
  extra.exec('ROLLBACK')
  const sentinel = new Error('materialization failed')
  await rejects(() => withLegacySqliteSnapshot(databasePath, async snapshot => {
    const iterator = snapshot.entries(); await iterator.next(); throw sentinel
  }), error => error === sentinel)
  const controller = new AbortController()
  await rejects(() => withLegacySqliteSnapshot(databasePath, async snapshot => {
    const iterator = snapshot.entries(); await iterator.next(); controller.abort(); await iterator.next()
  }, { signal: controller.signal }), { name: 'AbortError' })
  await rejects(() => withLegacySqliteSnapshot(databasePath, collect, { signal: controller.signal }), { name: 'AbortError' })
  // This checkpoint is ONLY the disposable fixture writer, to prove reader locks
  // were released after failure/abort. Production reader contains no checkpoint.
  check(extra.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0)
  extra.close(); extra = undefined
  await worker.close(); worker = undefined

  // Old actual schema without binary remains unmodified; no metadata table/head
  // is required to extract the existing file records.
  const oldPath = path.join(sandbox, 'old.sqlite')
  extra = new DatabaseSync(oldPath)
  extra.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL) STRICT')
  extra.prepare('INSERT INTO files VALUES (?,?,?,?)').run('notes/BOM.md', '\uFEFFlegacy\r\n', 'original-version', Buffer.byteLength('\uFEFFlegacy\r\n'))
  extra.exec("INSERT INTO files VALUES ('notes/raw.txt',CAST(x'EFBBBF00FF0D0A' AS TEXT),'raw-version',7)")
  extra.close(); extra = undefined
  const oldHash = await hashFile(oldPath)
  rows = await withLegacySqliteSnapshot(oldPath, async snapshot => { check(snapshot.schema.hasBinary, false); return collect(snapshot) })
  files = asFiles(rows)
  check([...files.get('notes/BOM.md').bytes], [...Buffer.from('\uFEFFlegacy\r\n')])
  check([...files.get('notes/raw.txt').bytes], [0xef, 0xbb, 0xbf, 0, 0xff, 0x0d, 0x0a])
  check(files.get('notes/BOM.md').source.version, 'original-version')
  check(await hashFile(oldPath), oldHash)
  extra = new DatabaseSync(oldPath, { readOnly: true })
  check(extra.prepare('PRAGMA table_info(files)').all().some(column => column.name === 'binary'), false)
  extra.close(); extra = undefined

  // Malformed rows produce scoped issues, not path rewriting, record fabrication,
  // JSON interpretation, or loss of unrelated valid rows.
  const malformedPath = path.join(sandbox, 'malformed.sqlite')
  extra = new DatabaseSync(malformedPath)
  extra.exec('CREATE TABLE files(path,content,version,bytes,binary)')
  const put = extra.prepare('INSERT INTO files VALUES (?,?,?,?,?)')
  const invalidPaths = ['../escape', '/absolute', 'C:/drive', 'part//gap', 'part/./dot', 'part/../parent', 'back\\slash', 'line\nbreak', 'nul\0path', '']
  for (const name of invalidPaths) put.run(name, 'retained', 'v', 8, null)
  put.run(null, 'retained', 'v', 8, null)
  put.run(9223372036854775807n, 'retained', 'v', 8, null)
  put.run('good/unknown.json', '{  not reformatted  }\n', 'v', 22, null)
  put.run('good/wrong-metadata', 'valid', null, 'wrong', null)
  put.run('bad/binary-text', 'valid fallback must not hide error', 'v', 4, 'not blob')
  put.run('bad/null-content', null, 'v', 0, null)
  put.run('good/binary-wins', null, 'v', 2, new Uint8Array([7, 8]))
  extra.exec("INSERT INTO files VALUES (CAST(x'6261642FFF' AS TEXT),'retained','v',8,NULL)")
  extra.close(); extra = undefined
  rows = await read(malformedPath); files = asFiles(rows)
  check(rows.filter(row => row.kind === 'issue' && row.issue.code === 'invalid-path').length, invalidPaths.length + 3)
  check(rows.filter(row => row.kind === 'issue' && row.issue.code === 'invalid-content').length, 2)
  check(files.size, 3)
  check(Buffer.from(files.get('good/unknown.json').bytes).toString(), '{  not reformatted  }\n')
  check(files.get('good/wrong-metadata').issues.length, 2)
  check(files.get('good/wrong-metadata').source, { representation: 'text', version: null, declaredBytes: null })
  check([...files.get('good/binary-wins').bytes], [7, 8])
  check(rows.every(row => row.kind === 'file' || row.issue.ordinal > 0), true)

  const missingPath = path.join(sandbox, 'missing.sqlite')
  await rejects(() => read(missingPath), { code: 'DSS_LEGACY_SOURCE_UNAVAILABLE' })
  await rejects(() => fs.stat(missingPath), { code: 'ENOENT' })
  const wrongSchema = path.join(sandbox, 'wrong-schema.sqlite')
  extra = new DatabaseSync(wrongSchema); extra.exec('CREATE TABLE unrelated(x)'); extra.close(); extra = undefined
  await rejects(() => read(wrongSchema), { code: 'DSS_LEGACY_SCHEMA_UNSUPPORTED' })
  const wrongColumns = path.join(sandbox, 'wrong-columns.sqlite')
  extra = new DatabaseSync(wrongColumns); extra.exec('CREATE TABLE files(path,content)'); extra.close(); extra = undefined
  await rejects(() => read(wrongColumns), { code: 'DSS_LEGACY_SCHEMA_UNSUPPORTED' })
  const viewPath = path.join(sandbox, 'view.sqlite')
  extra = new DatabaseSync(viewPath); extra.exec("CREATE VIEW files AS SELECT 'a' AS path,'b' AS content,'v' AS version,1 AS bytes"); extra.close(); extra = undefined
  await rejects(() => read(viewPath), { code: 'DSS_LEGACY_SCHEMA_UNSUPPORTED' })
  const virtualPath = path.join(sandbox, 'virtual.sqlite')
  extra = new DatabaseSync(virtualPath); extra.exec('CREATE VIRTUAL TABLE files USING fts5(path,content,version,bytes)'); extra.close(); extra = undefined
  await rejects(() => read(virtualPath), { code: 'DSS_LEGACY_SCHEMA_UNSUPPORTED' })
  const corrupt = path.join(sandbox, 'corrupt.sqlite'); await fs.writeFile(corrupt, 'not SQLite')
  await rejects(() => read(corrupt), error => error instanceof LegacySqliteReadError && error.code === 'DSS_LEGACY_READ_FAILED' && Boolean(error.cause))
  const utf16 = path.join(sandbox, 'utf16.sqlite')
  extra = new DatabaseSync(utf16); extra.exec("PRAGMA encoding='UTF-16'; CREATE TABLE files(path,content,version,bytes)"); extra.close(); extra = undefined
  await rejects(() => read(utf16), { code: 'DSS_LEGACY_SCHEMA_UNSUPPORTED' })
  // A crashed disposable writer leaves the committed WAL. With no live writer,
  // remove ONLY this fixture's SHM to exercise SQLite's normal index rebuild.
  const sidecarDir = path.join(sandbox, 'sidecars'); await fs.mkdir(sidecarDir)
  const sidecarPath = path.join(sidecarDir, 'wal.sqlite')
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(sidecarPath)});
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL) STRICT');
    db.prepare('INSERT INTO files VALUES (?,?,?,?)').run('committed/wal-only.txt','saved in WAL','v',12);
    process.exit(0);
  `], { encoding: 'utf8' })
  check(crashed.status, 0)
  const sidecarMainHash = await hashFile(sidecarPath), sidecarWalHash = await hashFile(sidecarPath + '-wal')
  await fs.rm(sidecarPath + '-shm', { force: true })
  check(Buffer.from(asFiles(await read(sidecarPath)).get('committed/wal-only.txt').bytes).toString(), 'saved in WAL')
  check(await hashFile(sidecarPath), sidecarMainHash)
  check(await hashFile(sidecarPath + '-wal'), sidecarWalHash)
  // Permission refusal must surface rather than inventing an immutable view or
  // copying a main DB alone. POSIX enforcement is a fixture test, not a new gate.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await fs.rm(sidecarPath + '-shm', { force: true })
    await fs.chmod(sidecarPath, 0o444); await fs.chmod(sidecarPath + '-wal', 0o444); await fs.chmod(sidecarDir, 0o555)
    try {
      await rejects(() => read(sidecarPath), error => error.code === 'DSS_LEGACY_READ_FAILED' && Boolean(error.cause))
      check(await hashFile(sidecarPath), sidecarMainHash)
      check(await hashFile(sidecarPath + '-wal'), sidecarWalHash)
    } finally {
      await fs.chmod(sidecarDir, 0o755); await fs.chmod(sidecarPath, 0o644); await fs.chmod(sidecarPath + '-wal', 0o644)
    }
  }
  const linked = path.join(sandbox, 'linked.sqlite'); await fs.symlink(oldPath, linked)
  await rejects(() => read(linked), { code: 'DSS_LEGACY_SOURCE_UNAVAILABLE' })
  await rejects(() => withLegacySqliteSnapshot(oldPath, async snapshot => {
    await fs.rename(oldPath, oldPath + '.original')
    await fs.copyFile(wrongSchema, oldPath)
    await collect(snapshot)
  }), { code: 'DSS_LEGACY_SOURCE_CHANGED' })

  const reader = readFileSync(new URL('../src/framework/legacy-sqlite-reader.ts', import.meta.url), 'utf8')
  // The test's mutable fixture setup is separate from the production read API.
  check(/new DatabaseSync\(databasePath, \{ readOnly: true/.test(reader), true)
  check(/\.exec\(['"`][^'"`]*(?:ALTER |CREATE |INSERT |UPDATE |DELETE |wal_checkpoint|journal_mode=)/i.test(reader), false)
  console.log(JSON.stringify({ status: 'passed', assertions, runtime: process.version, platform: process.platform,
    coverage: ['actual-v44-worker', 'committed-active-wal', 'uncommitted-excluded', 'pinned-across-async-materialization', 'raw-text-bom-nul-invalid-utf8', 'binary-null-and-zero', 'old-no-binary-no-alter', 'unknown-category-preserved', 'scoped-malformed-rows', 'metadata-not-user-records', 'failure-cancel-iterator-cleanup', 'missing-corrupt-replaced-source', 'normal-missing-shm-rebuild', 'unwritable-shm-error-no-fallback'],
    scope: 'Disposable cloud Linux fixtures only; no build, package, full typecheck, production cutover, Windows/device, or user database execution.',
    historicalProducer, sourceHashes: Object.fromEntries([...loaded].sort()), scriptHash: digest(readFileSync(fileURLToPath(import.meta.url))) }, null, 2))
} finally {
  try { if (extra?.isTransaction) extra.exec('ROLLBACK'); extra?.close() }
  finally { try { await worker?.terminate() } finally { hooks.deregister(); await fs.rm(sandbox, { recursive: true, force: true }) } }
}
