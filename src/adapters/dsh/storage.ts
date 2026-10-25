import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import type { StoragePort } from '../../contracts/ports.js'
import type { RecordStorageView } from '../../contracts/views.js'
import { RecordFilesBackend, recordCategories } from './record-files.js'

interface StoredEnvelope { key: string; value: unknown }
const storedEnvelope: z.ZodType<StoredEnvelope> = z.object({ key: z.string().min(1), value: z.json() })
const servantDomain = defineDomain({ name: 'deepseek_servant', version: 1, tables: { records: domainTable<string, StoredEnvelope>(storedEnvelope) } })
const locationDomain = defineDomain({ name: 'deepseek_servant_location', version: 1,
  tables: { settings: domainTable<string, { directory: string; layout?: 'folders-v1' }>(
    z.object({ directory: z.string().min(1), layout: z.literal('folders-v1').optional() })) } })
const DATA_FOLDER = 'deepseek_servant'
const LEGACY_FILE = 'deepseek_servant.json'
const LAYOUT = { format: 'deepseek-servant-record-folders', version: 1 } as const
type Records = Domain<typeof servantDomain>
interface OpenRecords { domain: Records; close(): Promise<void> }

/** One durable Task or skill record remains the atomic commit boundary. */
export class DshStorageAdapter implements StoragePort {
  private chain: Promise<unknown> = Promise.resolve()
  private retainedSource?: string
  private constructor(private readonly ctx: Context, private records: OpenRecords, private directory: string,
    private readonly location: Domain<typeof locationDomain>) {}

  static async open(ctx: Context): Promise<DshStorageAdapter> {
    const location = await ctx.storageDomain.open(locationDomain)
    let legacy: OpenRecords | undefined
    let records: OpenRecords | undefined
    let createdTree = false
    let stage: string | undefined
    let directory: string | undefined
    try {
      const selected = location.table('settings').get('active')
      if (selected) {
        directory = await realpath(selected.directory)
        if (!(await stat(directory)).isDirectory()) throw new Error('记录目录不可用：' + directory)
      } else {
        const domain = await ctx.storageDomain.open(servantDomain)
        legacy = { domain, close: () => domain.close() }
        directory = path.dirname(legacyFile(domain))
      }
      const tree = path.join(directory, DATA_FOLDER)
      if (await exists(tree)) {
        await validateTree(tree)
        records = await openTree(ctx, tree)
      } else {
        if (selected?.layout === 'folders-v1') throw new Error('记录子文件夹不可用：' + tree)
        if (!legacy) {
          if (!(await stat(path.join(directory, LEGACY_FILE))).isFile()) throw new Error('原记录文件不可用：' + directory)
          legacy = await openBackend(ctx, new JsonStorageBackend(directory))
        }
        stage = path.join(directory, '.servant-split-' + randomUUID())
        await createTree(stage)
        records = await openTree(ctx, stage)
        for (const [key, record] of legacy.domain.table('records').entries()) {
          await records.domain.table('records').put(key, record)
        }
        await records.close()
        records = await openTree(ctx, stage)
        assertSameRecords(legacy.domain, records.domain)
        await records.close()
        records = undefined
        const original = path.join(directory, LEGACY_FILE)
        if (await exists(original)) {
          const backup = path.join(stage, 'backups', 'deepseek_servant.before-split.json')
          await copyFile(original, backup, constants.COPYFILE_EXCL)
          await syncFile(backup)
        }
        await rename(stage, tree)
        stage = undefined
        createdTree = true
        records = await openTree(ctx, tree)
      }
      // The complete new tree is already durable before the native locator
      // switches. An old/unplugged source never silently becomes empty storage.
      await location.table('settings').put('active', { directory, layout: 'folders-v1' })
      const adapter = new DshStorageAdapter(ctx, records, directory, location)
      if (legacy) {
        try {
          await legacy.close()
          if (createdTree && await exists(path.join(directory, LEGACY_FILE))) await unlink(path.join(directory, LEGACY_FILE))
        } catch { adapter.retainedSource = directory }
      }
      return adapter
    } catch (error) {
      await records?.close()
      await legacy?.close()
      if (stage) await rm(stage, { recursive: true, force: true })
      if (createdTree && directory) await rm(path.join(directory, DATA_FOLDER), { recursive: true, force: true })
      await location.close()
      throw error
    }
  }

  recordsDirectory(): string { return this.directory }
  storageView(): RecordStorageView {
    const nativeRoot = (this.ctx.get('sessionPersistence') as unknown as { root?: unknown } | undefined)?.root
    return { directory: this.directory,
      ...(typeof nativeRoot === 'string' && path.isAbsolute(nativeRoot) ? { nativeDirectory: nativeRoot } : {}),
      ...(this.retainedSource ? { retainedSource: this.retainedSource } : {}) }
  }

  /** Move the owned tree, including its legacy backup, without moving other host files. */
  moveRecords(directory: string, expectedDirectory: string, signal: AbortSignal): Promise<RecordStorageView> {
    return this.serial(async () => {
      signal.throwIfAborted()
      if (expectedDirectory !== this.directory) throw new Error('记录目录已变化，请刷新后重试。')
      if (!path.isAbsolute(directory)) throw new Error('请输入已有文件夹的完整绝对路径。')
      const destination = await realpath(directory)
      if (!(await stat(destination)).isDirectory()) throw new Error('请选择一个文件夹。')
      if (destination === await realpath(this.directory)) return this.storageView()
      const sourceTree = path.join(this.directory, DATA_FOLDER)
      const relative = path.relative(sourceTree, destination)
      if (relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
        throw new Error('不能迁移到当前记录子文件夹内部。')
      }
      const targetTree = path.join(destination, DATA_FOLDER)
      if (await exists(targetTree) || await exists(path.join(destination, LEGACY_FILE))) throw new Error('目标文件夹已有 Servant 记录，请选择其他文件夹；不会覆盖已有记录。')
      const stage = path.join(destination, '.servant-move-' + randomUUID())
      let target: OpenRecords | undefined
      let published = false
      try {
        await cp(sourceTree, stage, { recursive: true, errorOnExist: true, force: false })
        await syncCopiedTree(stage)
        target = await openTree(this.ctx, stage)
        assertSameRecords(this.records.domain, target.domain)
        await target.close()
        target = undefined
        signal.throwIfAborted()
        await rename(stage, targetTree)
        published = true
        target = await openTree(this.ctx, targetTree)
        signal.throwIfAborted()
        await this.location.table('settings').put('active', { directory: destination, layout: 'folders-v1' })
      } catch (error) {
        await target?.close()
        await rm(published ? targetTree : stage, { recursive: true, force: true })
        throw error
      }
      const previous = this.records
      this.records = target!
      this.directory = destination
      this.retainedSource = undefined
      try { await previous.close(); await rm(sourceTree, { recursive: true }) }
      catch { this.retainedSource = path.dirname(sourceTree) }
      return this.storageView()
    })
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.serial(async () => {
      const record = this.records.domain.table('records').get(key)
      if (record === undefined) return undefined
      if (record.key !== key) throw new Error('Servant storage key mismatch: ' + key)
      return structuredClone(record.value) as T
    })
  }
  set<T>(key: string, value: T): Promise<void> {
    const record = storedEnvelope.parse({ key, value: structuredClone(value) })
    return this.serial(() => this.records.domain.table('records').put(key, record))
  }
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return this.serial(async () => {
      const records: Array<{ key: string; value: T }> = []
      for (const [key, record] of this.records.domain.table('records').entries()) {
        if (record.key !== key) throw new Error('Servant storage key mismatch: ' + key)
        if (key.startsWith(prefix)) records.push({ key, value: structuredClone(record.value) as T })
      }
      return records
    })
  }
  delete(key: string): Promise<void> { return this.serial(async () => { await this.records.domain.table('records').delete(key) }) }
  close(): Promise<void> { return this.serial(async () => { await this.records.close(); await this.location.close() }) }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.catch(() => {})
    return result
  }
}

function legacyFile(domain: Records): string {
  const unit = (domain as unknown as { unit?: { path?: unknown } }).unit
  if (typeof unit?.path !== 'string' || !path.isAbsolute(unit.path)) throw new Error('当前记录存储没有可管理的本地文件夹。')
  return unit.path
}
async function openBackend(ctx: Context, backend: Pick<JsonStorageBackend, 'kv' | 'close'>): Promise<OpenRecords> {
  const backendName = 'servant_records_' + randomUUID().replaceAll('-', '_')
  const unregister = ctx.storage.backend.register(backendName, backend)
  try {
    const facility = new DomainFacility(ctx, { backend: backendName })
    const domain = await facility.open(servantDomain)
    return { domain, close: async () => { await domain.close(); await backend.close(); unregister() } }
  } catch (error) { await backend.close(); unregister(); throw error }
}
async function openTree(ctx: Context, tree: string): Promise<OpenRecords> {
  await validateTree(tree)
  return openBackend(ctx, new RecordFilesBackend(tree))
}
async function validateTree(tree: string): Promise<void> {
  const kind = await lstat(tree)
  if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('Servant 记录目录不是普通文件夹：' + tree)
  const format: unknown = JSON.parse(await readFile(path.join(tree, 'layout.json'), 'utf8'))
  if (!isDeepStrictEqual(format, LAYOUT)) throw new Error('不支持的 Servant 记录目录格式：' + tree)
}
async function createTree(tree: string): Promise<void> {
  await mkdir(tree)
  for (const category of [...recordCategories, 'backups']) await mkdir(path.join(tree, category), { recursive: true })
  await writeFile(path.join(tree, 'layout.json'), JSON.stringify(LAYOUT, null, 2) + '\n', { flag: 'wx' })
  await syncFile(path.join(tree, 'layout.json'))
}
function assertSameRecords(left: Records, right: Records): void {
  if (!isDeepStrictEqual(new Map(left.table('records').entries()), new Map(right.table('records').entries()))) {
    throw new Error('记录迁移校验失败，原目录保持不变。')
  }
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function syncCopiedTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('记录迁移不接受符号链接：' + file)
    if (entry.isDirectory()) await syncCopiedTree(file)
    else if (entry.isFile()) await syncFile(file)
  }
}
