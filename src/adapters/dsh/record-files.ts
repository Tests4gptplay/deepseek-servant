import { createHash } from 'node:crypto'
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'

type KvFacet = JsonStorageBackend['kv']
type KvUnit = Awaited<ReturnType<KvFacet['open']>>
const descriptor = { name: 'record', version: 1, tables: ['records'], hasGlobal: false } as const
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
          const file = await this.openFile(recordFolder(key))
          await file.unit.putRecord('records', key, value)
        },
        deleteRecord: async (table, key) => {
          this.assertTable(table)
          const relative = recordFolder(key)
          const file = this.files.get(relative)
          if (!file) return
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
        const file = await this.openFile(relative)
        const snapshot = await file.unit.loadAll()
        const entries = Object.entries(snapshot.tables.records ?? {})
        if (entries.length > 1) throw new Error('每个记录文件只能保存一个记录：' + filePath)
        for (const [key, value] of entries) {
          if (recordFolder(key) !== relative || Object.hasOwn(records, key)) throw new Error('记录路径与身份不匹配：' + filePath)
          records[key] = value
        }
      }
    }
    return { tables: { records }, global: null }
  }
}
