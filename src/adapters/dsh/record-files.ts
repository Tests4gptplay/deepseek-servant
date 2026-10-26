import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'

type KvFacet = JsonStorageBackend['kv']
type KvUnit = Awaited<ReturnType<KvFacet['open']>>
const descriptor = { name: 'record', version: 1, tables: ['records'], hasGlobal: false } as const
const LAYOUT = { format: 'deepseek-servant-record-folders', version: 1 } as const
export const recordCategories = ['tasks', 'assistants', 'skills', 'knowledge/facts', 'knowledge/preferences', 'settings', 'other'] as const

/** A readable ID plus a digest keeps distinct scopes and Windows case variants apart. */
export function recordFolder(key: string): string {
  const category = key.startsWith('task:') ? 'tasks'
    : key.startsWith('assistant/') ? 'assistants'
    : key.startsWith('knowledge/skills/') ? 'skills'
    : key.startsWith('knowledge/facts/') ? 'knowledge/facts'
    : key.startsWith('knowledge/preferences/') ? 'knowledge/preferences'
    : key.startsWith('retention/') ? 'settings' : 'other'
  const label = (key.split(/[/:]/).at(-1) ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0,32).toLowerCase() || 'record'
  return path.join(category, label + '--' + createHash('sha256').update(key).digest('hex'))
}

interface OpenFile { backend: JsonStorageBackend; unit: KvUnit }
/**
 * Keep the existing native Domain and its single-record commit semantics.
 * Each logical record uses a native JSON unit in its own folder instead of
 * rewriting every task and skill together. No parallel index is authoritative.
 */
export class RecordFilesBackend {
  private readonly files = new Map<string, OpenFile>()
  private opened = false
  private readonly faults = new Map<string, Error>()
  private recovered = false
  problems(): string[] { return [...this.faults.values()].map(error => error.message) }
  assertReadable(key: string): void { const error = this.faults.get(recordFolder(key)); if (error) throw error }
  async retryFaults(): Promise<boolean> {
    for (const relative of [...this.faults.keys()]) {
      try { await this.readRecord(relative); this.recovered = true } catch { /* The exact record remains unavailable. */ }
    }
    return this.recovered
  }
  private closing?: Promise<void>
  constructor(private readonly directory: string) {}
  readonly kv: KvFacet = {
    open: async input => {
      this.assertOpen()
      if (this.opened) throw new Error('Servant record tree is already open.')
      if (input.name !== 'deepseek_servant' || input.version !== 1 || input.hasGlobal
        || input.tables.length !== 1 || input.tables[0] !== 'records') throw new Error('Unexpected Servant record domain.')
      this.opened = true
      return {
        loadAll: () => this.loadAll(),
        putRecord: async (table, key, value) => {
          this.assertTable(table)
          if (this.faults.has(recordFolder(key))) await this.readRecord(recordFolder(key))
          const file = await this.openFile(recordFolder(key))
          await file.unit.putRecord('records', key, value)
        },
        deleteRecord: async (table, key) => {
          this.assertTable(table)
          const relative = recordFolder(key)
          this.assertReadable(key)
          const file = this.files.get(relative)
          if (!file) return
          await mkdir(path.join(this.directory, relative), { recursive: true })
          // First publish the empty native unit. Cleanup below cannot resurrect
          // deleted data if interrupted; an empty unit reads as no record.
          await file.unit.deleteRecord('records', key)
          await file.backend.close()
          this.files.delete(relative)
          try { await unlink(path.join(this.directory, relative, 'record.json')); await rmdir(path.join(this.directory, relative)) }
          catch { /* Preserve any additional files in the record folder. */ }
        },
        setGlobal: async () => { throw new Error('Servant records have no global slot.') },
        close: () => this.close(),
      }
    },
  }
  close(): Promise<void> {
    return this.closing ??= Promise.all([...this.files.values()].map(file => file.backend.close())).then(() => { this.files.clear() })
  }
  private assertOpen(): void { if (this.closing) throw new Error('Servant record tree is closed.') }
  private assertTable(table: string): void {
    this.assertOpen()
    if (table !== 'records') throw new Error('Unknown Servant record table: ' + table)
  }
  private async openFile(relative: string): Promise<OpenFile> {
    this.assertOpen()
    // The handle may outlive a folder removed in Explorer. Recreate its parent
    // before the native atomic JSON write, including for cached handles.
    await mkdir(path.join(this.directory, relative), { recursive: true })
    const existing = this.files.get(relative)
    if (existing) return existing
    const backend = new JsonStorageBackend(path.join(this.directory, relative))
    try {
      const unit = await backend.kv.open(descriptor)
      const file = { backend, unit }
      this.files.set(relative, file)
      return file
    } catch (error) { await backend.close(); throw error }
  }
  private async readRecord(relative: string): Promise<Array<[string, unknown]>> {
    const filePath = path.join(this.directory, relative, 'record.json')
    try {
      const file = await this.openFile(relative)
      const snapshot = await file.unit.loadAll()
      const entries = Object.entries(snapshot.tables.records ?? {})
      if (entries.length > 1) throw new Error('每个记录文件只能保存一个记录')
      for (const [key, value] of entries) {
        if (recordFolder(key) !== relative || !value || typeof value !== 'object'
          || !('key' in value) || value.key !== key || !('value' in value)) throw new Error('记录路径、身份或封装不匹配')
      }
      this.faults.delete(relative)
      return entries
    } catch (reason) {
      const error = new Error(filePath + ': ' + (reason instanceof Error ? reason.message : String(reason)))
      if (this.faults.get(relative)?.message !== error.message) console.error('deepseek-servant record', error.message)
      this.faults.set(relative, error)
      const file = this.files.get(relative)
      this.files.delete(relative)
      await file?.backend.close()
      throw error
    }
  }
  private async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: null }> {
    this.assertOpen()
    const records: Record<string, unknown> = Object.create(null)
    for (const category of recordCategories) {
      const categoryPath = path.join(this.directory, category)
      const kind = await lstat(categoryPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!kind) continue
      if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('记录分类目录不是普通文件夹：' + categoryPath)
      for (const entry of await readdir(categoryPath, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('记录目录不能是符号链接：' + entry.name)
        if (!entry.isDirectory()) continue
        const relative = path.join(category, entry.name)
        const filePath = path.join(this.directory, relative, 'record.json')
        const fileKind = await lstat(filePath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
        if (!fileKind) continue
        if (!fileKind.isFile() || fileKind.isSymbolicLink()) throw new Error('记录不是普通文件：' + filePath)
        try {
          for (const [key, value] of await this.readRecord(relative)) records[key] = value
        } catch { /* Preserve the unreadable original and continue loading unrelated records. */ }
      }
    }
    return { tables: { records }, global: null }
  }
}

/** Rebuild a truncated derived marker after preserving its original bytes. */
export async function ensureRecordTree(directory: string): Promise<boolean> {
  await mkdir(directory, { recursive: true })
  const kind = await lstat(directory)
  if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('Servant 记录目录不是普通文件夹：' + directory)
  const marker = path.join(directory, 'layout.json')
  let created = false
  let text: string | undefined
  try { text = await readFile(marker, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (text === undefined) {
    const handle = await open(marker, 'wx')
    try { await handle.writeFile(JSON.stringify(LAYOUT, null, 2) + '\n', 'utf8'); await handle.sync() }
    finally { await handle.close() }
    created = true
  } else {
    let layout: unknown
    try { layout = JSON.parse(text) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      const suffix = randomUUID()
      await mkdir(path.join(directory, 'backups'), { recursive: true })
      await copyFile(marker, path.join(directory, 'backups', 'layout-' + suffix + '.json'))
      const temporary = marker + '.' + suffix + '.tmp'
      await writeFile(temporary, JSON.stringify(LAYOUT, null, 2) + '\n', { flag: 'wx' })
      await rename(temporary, marker)
      layout = LAYOUT
    }
    if (!isDeepStrictEqual(layout, LAYOUT)) throw new Error('不支持的 Servant 记录目录格式：' + directory)
  }
  for (const category of [...recordCategories, 'backups']) await mkdir(path.join(directory, category), { recursive: true })
  return created
}
