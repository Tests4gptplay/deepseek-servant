import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

// Execute real source and disposable SQLite/physical files. Fixture creation
// uses the original v44 Local worker. No actual DSH, model, Windows, power loss,
// production switch, package build, user records or Git operations are involved.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const schema = `const schema = new Proxy(function () {}, { get(_t,k){if(k==='parse')return v=>v;return schema},apply(){return schema} }); export const z=schema;`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'koffi') return { url: new URL('./helpers/fixture-no-replace-koffi.mjs', import.meta.url).href, shortCircuit: true }
    if (specifier === 'zod') return { url: 'data:text/javascript;base64,' + Buffer.from(schema).toString('base64'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), hash(source))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { localStartupUpgradeKey, inspectLocalStartupUpgrade, inspectLegacyLocalInventory, readLegacyLocalOriginal } = await import('../src/framework/local-startup-upgrade.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { localFilesWorkerSource, historicalProducer } = await import('./test-support/historical-v44/load-sql-producer.mjs')
class DiskRecords {
  constructor(root) { this.records = new LocalRecordFiles(path.join(root, 'startup-records')); this.key = localStartupUpgradeKey(path.join(root, 'files')); this.writes = 0 }
  async get(key) { if(key !== this.key) return undefined; const bytes = await this.records.read('operation.json'); return bytes === undefined ? undefined : JSON.parse(bytes) }
  async set(key, value) { assert.equal(key, this.key); this.writes++; await this.records.replace('operation.json', JSON.stringify(value)) }
  async list() { throw new Error('Startup must not scan unrelated host records') }
}
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-startup-upgrade-'))
const heldSources = []
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const dbPath = root => path.join(root, 'files', 'dss-files.sqlite')
async function seed(name, entries) {
  const root = path.join(sandbox, name); await fs.mkdir(path.join(root, 'files'), { recursive: true })
  const worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath: dbPath(root), writer: true } })
  const requests = new Map(); let sequence = 0, ready, failed
  const startup = new Promise((resolve, reject) => { ready = resolve; failed = reject })
  worker.on('error', failed)
  worker.on('message', message => {
    if (message.startupError) return failed(Error(message.startupError.message))
    if (message.ready) return ready()
    const request = requests.get(message.id)
    if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result)
    requests.delete(message.id)
  })
  try {
    await startup
    await new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject }); worker.postMessage({ id, method: 'commit', args: { changes: entries, dependencies: [], revision: 'fixture' } }) })
  } finally { await worker.terminate() }
  // Keep a fixture connection alive so SQLite retains committed WAL frames
  // while the actual readonly extractor materializes them asynchronously.
  const held = new DatabaseSync(dbPath(root)); held.exec('BEGIN; UPDATE files SET bytes=bytes; COMMIT'); heldSources.push(held)
  return root
}
try {
  const original='\uFEFF原笔记\r\n\0keep', logical='tasks/original.md'
  const root=await seed('legacy-source',[{path:logical,content:original},{path:'state/original',content:''}])
  const directory=path.join(root,'files'), records=new DiskRecords(root), before=await fs.readFile(dbPath(root))
  const report=await inspectLocalStartupUpgrade(directory,records)
  check(report.status,'incomplete')
  check((await inspectLegacyLocalInventory(directory)).files.map(row=>row.path).sort(),['state/original',logical])
  check(Buffer.from((await readLegacyLocalOriginal(directory,logical)).bytes).toString(),original)
  check((await readLegacyLocalOriginal(directory,'state/original')).bytes.byteLength,0)
  check(await readLegacyLocalOriginal(directory,'tasks/missing.md'),undefined)
  check(await fs.readFile(dbPath(root)),before);check(records.writes,0)
  check(existsSync(path.join(directory,logical)),false)
  const missing=path.join(sandbox,'missing')
  check((await inspectLocalStartupUpgrade(missing,records)).status,'not-needed');check(existsSync(missing),false)
  await assert.rejects(()=>inspectLocalStartupUpgrade(missing,records,{requireExisting:true}),/existing Local directory/)
  const orphan=path.join(sandbox,'orphan');await fs.mkdir(orphan);await fs.writeFile(path.join(orphan,'dss-files.sqlite-wal'),'retained')
  check((await inspectLocalStartupUpgrade(orphan,records)).issues[0].code,'source-missing')
  check(await fs.readFile(path.join(orphan,'dss-files.sqlite-wal'),'utf8'),'retained')
  console.log(JSON.stringify({status:'passed',assertions,historicalProducer,scope:'read-only historical compatibility; no exporter',sourceHashes:Object.fromEntries(loaded)},null,2))
} finally {heldSources.forEach(x=>x.close());hooks.deregister();await fs.rm(sandbox,{recursive:true,force:true})}
