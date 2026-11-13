import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'

type KvFacet = JsonStorageBackend['kv']
type KvUnit = Awaited<ReturnType<KvFacet['open']>>
const descriptor = { name: 'record', version: 1, tables: ['records'], hasGlobal: false } as const
const LAYOUT = { format: 'deepseek-servant-record-folders', version: 2 } as const
const PREVIOUS_LAYOUT = { format: 'deepseek-servant-record-folders', version: 1 } as const
// This marker identifies the owned layout; extra fields and its version are
// not storage gates. Only the known v1 value requests configuration carry.
function isRecordLayout(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && 'format' in value && value.format === LAYOUT.format
}
// Each current producer has an explicit owner. There is no fallback category.
const currentConfigurations = new Set([
  'framework-settings/local', 'framework-settings/git',
  'framework-participation/local', 'framework-participation/git',
  'framework-active-mode', 'framework-git-enabled', 'framework-instance-uuid', 'framework/local-locations',
])
const runtimeCategories: Readonly<Record<string, string>> = {
  roles: 'state/roles', 'retired-workers': 'state/retired-workers', wakes: 'state/wakes',
  'foreground-resets': 'state/foreground-resets', restores: 'state/role-restores',
  'host-restores': 'state/host-restores', observations: 'state/observation-actions',
  'recovery-watch': 'state/recovery-watch',
}
const stateCategories: Readonly<Record<string, string>> = {
  'framework-host': 'state/host', 'framework-user-controls': 'state/user-controls',
  'framework-observations': 'state/execution-observations',
  // Existing one-time AI/semantic upgrade responsibilities use the same
  // per-record native persistence, not a new database or admission mechanism.
  'framework-startup-upgrade-agent': 'state/startup-upgrade',
  'framework-physical-upgrade': 'state/startup-upgrade',
  'framework-upgrade-task': 'state/startup-upgrade',
  'framework-upgrade-conversation': 'state/startup-upgrade',
  'framework-upgrade-skill': 'state/startup-upgrade',
  'framework-upgrade-source': 'state/startup-upgrade',
  'framework-local-upgrade-result': 'state/startup-upgrade',
}
const currentRecordCategories = [...new Set(['配置记录', ...Object.values(runtimeCategories), ...Object.values(stateCategories), 'state/record-moves'])]
export const recordCategories = currentRecordCategories

/** Shared settings and current Local registration are not Git business authority. */
export function recordCategory(key: string): string | undefined {
  if (currentConfigurations.has(key) || /^framework-(?:connection-settings|instance)\/[a-f0-9]{64}$/.test(key)) return '配置记录'
  if (key === 'framework/record-moves') return 'state/record-moves'
  const parts = key.split('/')
  if (parts[0] === 'framework-runtime' && /^[a-f0-9]{64}$/.test(parts[1] ?? '') && parts.length === 4 && parts[3]) {
    return Object.hasOwn(runtimeCategories, parts[2]!) ? runtimeCategories[parts[2]!] : undefined
  }
  if (parts[0] === 'framework-user-controls' && parts.length === 4
    && /^[a-f0-9]{64}$/.test(parts[1] ?? '') && ['tasks', 'executions', 'commands'].includes(parts[2]!)
    && /^[a-f0-9]{64}$/.test(parts[3] ?? '')) return 'state/user-controls'
  const state = Object.hasOwn(stateCategories, parts[0]!) ? stateCategories[parts[0]!] : undefined
  if (state && /^[a-f0-9]{64}$/.test(parts[1] ?? '')
    && (parts[0] === 'framework-observations'
      ? parts.length === 3 && /^[a-f0-9]{64}$/.test(parts[2] ?? '') : parts.length === 2)) return state
}

/** A readable ID plus a digest keeps distinct scopes and Windows case variants apart. */
export function recordFolder(key: string): string {
  const category = recordCategory(key)
  if (!category) throw new Error('记录类型没有对应的存储位置：' + key)
  const label = (key.split(/[/:]/).at(-1) ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0,32).toLowerCase() || 'record'
  return path.join(category, label + '--' + createHash('sha256').update(key).digest('hex'))
}

/** Exact read-through of a d19 Local technical configuration. No migration,
 * broad old-tree scan, cleanup, or inference of another storage scope. */
export class LegacyLocalConfigurationReadError extends Error {}
export async function readPreviousLocalConfiguration(directory: string, key: string): Promise<unknown | undefined> {
  if (key !== 'framework/local-locations'
    && !/^framework-(?:connection-settings|instance)\/[a-f0-9]{64}$/.test(key)) return undefined
  try {
  const label = (key.split(/[/:]/).at(-1) ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0,32).toLowerCase() || 'record'
  const sourceRoot = path.join(directory, 'other')
  const sourceKind = await lstat(sourceRoot).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!sourceKind) return
  if (!sourceKind.isDirectory() || sourceKind.isSymbolicLink()) throw new Error('旧 Local 配置来源不是普通文件夹：' + sourceRoot)
  const folder = path.join(sourceRoot, label + '--' + createHash('sha256').update(key).digest('hex'))
  const folderKind = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!folderKind) return
  if (!folderKind.isDirectory() || folderKind.isSymbolicLink()) throw new Error('旧 Local 配置来源不是普通文件夹：' + folder)
  const file = path.join(folder, 'record.json')
  const kind = await lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!kind) return
  if (!kind.isFile() || kind.isSymbolicLink()) throw new Error('旧 Local 配置来源不是普通文件：' + file)
  const native: unknown = JSON.parse(await readFile(file, 'utf8'))
  const unit = native as { unit?: { name?: unknown; version?: unknown }; tables?: { records?: Record<string, unknown> } }
  const rows = unit?.tables?.records
  const envelope = rows?.[key] as { key?: unknown; value?: unknown } | undefined
  if (unit?.unit?.name !== 'record' || unit.unit.version !== 1 || !rows || Object.keys(rows).length !== 1
    || !envelope || envelope.key !== key || !Object.hasOwn(envelope, 'value'))
    throw new Error('旧 Local 配置来源身份或封装不匹配：' + file)
  return envelope.value
  } catch (cause) {
    throw new LegacyLocalConfigurationReadError('原 Local 配置读取失败，原件未修改；请检查该记录并重启 DSS Host 重试：' + key + '：' + String(cause), { cause })
  }
}

/** Count real bytes in the owned tree, including formatting, envelopes and backup files. */
export async function recordFileUsage(directory: string, keys: Iterable<string>): Promise<Array<{ key?: string; path: string; bytes: number }>> {
  const identities = new Map([...keys].map(key => [recordFolder(key), key]))
  const result: Array<{ key?: string; path: string; bytes: number }> = []
  async function visit(relative = ''): Promise<void> {
    let entries
    try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (!relative && entry.name === 'other') continue
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) await visit(child)
      else {
        const info = await lstat(path.join(directory, child)).catch(error => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (info) result.push({ key: identities.get(relative), path: child.replaceAll(path.sep, '/'), bytes: info.size })
      }
    }
  }
  await visit()
  return result
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
  assertReadable(key: string): void { if (!recordCategory(key)) return; const error = this.faults.get(recordFolder(key)); if (error) throw error }
  /** A manually removed record is absent even while this Host still holds its old native unit. */
  async hasRecord(key: string): Promise<boolean> {
    const folder = path.join(this.directory, recordFolder(key))
    const kind = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!kind) return false
    if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('记录目录不是普通文件夹：' + folder)
    const file = path.join(folder, 'record.json')
    const body = await lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!body) return false
    if (!body.isFile() || body.isSymbolicLink()) throw new Error('记录不是普通文件：' + file)
    return true
  }
  needsRetry(key?: string): boolean { return this.recovered || (key === undefined ? this.faults.size > 0 : !!recordCategory(key) && this.faults.has(recordFolder(key))) }
  async retryFaults(key?: string): Promise<boolean> {
    for (const relative of [...this.faults.keys()]) {
      if (key !== undefined && (!recordCategory(key) || relative !== recordFolder(key))) continue
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
          await rm(path.join(this.directory, relative), { recursive: true, force: true })
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
    const folderPath = path.join(this.directory, relative), filePath = path.join(folderPath, 'record.json')
    try {
      const folderKind = await lstat(folderPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!folderKind) { this.faults.delete(relative); return [] }
      if (!folderKind.isDirectory() || folderKind.isSymbolicLink()) throw new Error('记录目录不是普通文件夹：' + folderPath)
      const fileKind = await lstat(filePath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!fileKind) { this.faults.delete(relative); return [] }
      if (!fileKind.isFile() || fileKind.isSymbolicLink()) throw new Error('记录不是普通文件：' + filePath)
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
      const error = new Error(filePath + ': ' + (reason instanceof Error ? reason.message : String(reason)), { cause: reason })
      const file = this.files.get(relative)
      this.files.delete(relative)
      await file?.backend.close()
      if (this.faults.get(relative)?.message !== error.message) console.error('deepseek-servant record', error.message)
      this.faults.set(relative, error)
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
        // Ordinary notes are not records. A replaced record folder still has
        // its mapped name, so preserve its exact fault instead of hiding it.
        if (!entry.isDirectory() && !entry.isSymbolicLink() && !/^[a-z0-9_-]{1,32}--[a-f0-9]{64}$/.test(entry.name)) continue
        const relative = path.join(category, entry.name)
        try {
          for (const [key, value] of await this.readRecord(relative)) records[key] = value
        } catch { /* Preserve the unreadable original and continue loading unrelated records. */ }
      }
    }
    return { tables: { records }, global: null }
  }
}

/** Create a missing layout marker; existing descriptive metadata is not a
 * prerequisite for reading or writing the individually identified records. */
export async function ensureRecordTree(directory: string, pendingConfigurationCarry = false, prepareCategories = true): Promise<void> {
  const initialLayout = pendingConfigurationCarry ? PREVIOUS_LAYOUT : LAYOUT
  let kind = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!kind) {
    await mkdir(directory, { recursive: true })
    kind = await lstat(directory)
  }
  if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('Servant 记录目录不是普通文件夹：' + directory)
  const marker = path.join(directory, 'layout.json')
  const markerKind = await lstat(marker).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (markerKind && (!markerKind.isFile() || markerKind.isSymbolicLink())) throw new Error('记录布局标记不是普通文件：' + marker)
  let created = false
  if (!markerKind) {
    let handle
    try { handle = await open(marker, 'wx') }
    catch (error) {
      // Independent record writers may initialize the same missing marker.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const current = await lstat(marker)
      if (!current.isFile() || current.isSymbolicLink()) throw new Error('记录布局标记不是普通文件：' + marker)
    }
    if (handle) {
      try { await handle.writeFile(JSON.stringify(initialLayout, null, 2) + '\n', 'utf8'); await handle.sync() }
      finally { await handle.close() }
      created = true
    }
  }
  // Ordinary publication checks the actual root and marker file types, but its
  // native record handle creates only the addressed parent. Full directory
  // preparation belongs to open/explicit repair or a missing marker.
  if (prepareCategories || created)
    for (const category of [...currentRecordCategories, 'backups']) await mkdir(path.join(directory, category), { recursive: true })
}

/** Only the version transition may read these exact current configuration keys.
 * Registration history, movement receipts and all Task/runtime records stay put.
 */
const configurationCarryKeys = [
  'framework-settings/local', 'framework-settings/git', 'framework-instance-uuid',
  'framework-active-mode', 'framework-git-enabled', 'framework-participation/local', 'framework-participation/git',
] as const

export async function configurationCarryRequired(directory: string, selectedLayout?: 'folders-v1' | 'folders-v2'): Promise<boolean> {
  if (selectedLayout === 'folders-v2') return false
  const treeKind = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (treeKind && (!treeKind.isDirectory() || treeKind.isSymbolicLink())) throw new Error('Servant 记录目录不是普通文件夹：' + directory)
  const marker = path.join(directory, 'layout.json')
  const markerKind = await lstat(marker).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (markerKind && (!markerKind.isFile() || markerKind.isSymbolicLink())) throw new Error('记录布局标记不是普通文件：' + marker)
  try {
    const layout: unknown = JSON.parse(await readFile(path.join(directory, 'layout.json'), 'utf8'))
    if (isRecordLayout(layout) && layout.version === LAYOUT.version) return false
    return selectedLayout === 'folders-v1' || isRecordLayout(layout) && layout.version === PREVIOUS_LAYOUT.version
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return selectedLayout === 'folders-v1'
  }
}

export async function carryCurrentConfigurations(directory: string,
  save: (key: string, value: unknown) => Promise<void>): Promise<void> {
  const sourceRoot = path.join(directory, 'other')
  let inspectedSource = false
  // Before v2 cutover these are the seven current source configurations.
  // Other historical records are never opened by configuration carry.
  for (const key of configurationCarryKeys) {
    const relative = recordFolder(key)
    if (!inspectedSource) {
      const sourceKind = await lstat(sourceRoot).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!sourceKind) return
      if (!sourceKind.isDirectory() || sourceKind.isSymbolicLink()) throw new Error('当前配置来源不是普通文件夹：' + sourceRoot)
      inspectedSource = true
    }
    const originalFolder = path.join(sourceRoot, path.basename(relative))
    const folderKind = await lstat(originalFolder).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!folderKind) continue
    if (!folderKind.isDirectory() || folderKind.isSymbolicLink()) throw new Error('当前配置来源不是普通文件夹：' + originalFolder)
    const original = path.join(originalFolder, 'record.json')
    const kind = await lstat(original).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!kind) continue
    if (!kind.isFile() || kind.isSymbolicLink()) throw new Error('当前配置来源不是普通文件：' + original)
    const native: unknown = JSON.parse(await readFile(original, 'utf8'))
    const unit = native as { unit?: { name?: unknown; version?: unknown }; tables?: { records?: Record<string, unknown> } }
    const rows = unit?.tables?.records
    const envelope = rows?.[key] as { key?: unknown; value?: unknown } | undefined
    if (unit?.unit?.name !== 'record' || unit.unit.version !== 1 || !rows || Object.keys(rows).length !== 1
      || !envelope || envelope.key !== key || !Object.hasOwn(envelope, 'value')) throw new Error('当前配置来源身份或封装不匹配：' + original)
    await save(key, envelope.value)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Runs after the existing v2 location selection. The seven old configuration
 * directories are obsolete at that point; other/runtime records are not.
 * Failed cleanup stays visible and is retried at the next real storage open.
 */
export async function retirePreviousConfigurations(directory: string, assertCurrentReadable: (key: string) => void,
  requestedCarry = false): Promise<string[]> {
  const sourceRoot = path.join(directory, 'other'), work = path.join(directory, '.dss-layout-migration')
  const issues: string[] = [], pending: Array<{ key?: string; directory: string }> = []
  try {
    const source = await lstat(sourceRoot).catch(error => { if (error.code === 'ENOENT') return; throw error })
    if (source && (!source.isDirectory() || source.isSymbolicLink())) throw new Error('旧配置来源不是普通目录')
    for (const key of configurationCarryKeys) {
      const original = path.join(sourceRoot, path.basename(recordFolder(key)))
      if (await lstat(original).catch(error => { if (error.code === 'ENOENT') return; throw error })) pending.push({ key, directory: original })
    }
    if (await lstat(work).catch(error => { if (error.code === 'ENOENT') return; throw error })) pending.push({ directory: work })
    // Completed current roots take only these fixed-path checks, no enumeration.
    if (!pending.length && !requestedCarry) return issues
    if (!pending.length) {
      // A selected v1 with no settings still owns its interrupted cleanup work.
      await mkdir(work, { recursive: true }); pending.push({ directory: work })
    }
  } catch (error) { return ['旧配置清理未完成：' + sourceRoot + '：' + String(error)] }
  // Clean old UUID names first. Keep an existing old directory until this
  // succeeds so interruption is resumed from actual remaining migration files.
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^layout\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(entry.name)) continue
      const temporary = path.join(directory, entry.name)
      try { await rm(temporary, { force: true }) }
      catch (error) { issues.push('旧布局临时文件清理未完成：' + temporary + '：' + String(error)) }
    }
    await syncDirectory(directory)
  } catch (error) { issues.push('旧布局临时文件清理未完成：' + directory + '：' + String(error)) }
  if (issues.length) return issues
  // Native JSON already used .UUID.tmp before this change. Inspect only the
  // destinations whose old configuration directories still await retirement.
  const blocked = new Set<string>()
  for (const item of pending) {
    if (!item.key) continue
    const key = item.key, target = path.join(directory, recordFolder(key))
    try {
      assertCurrentReadable(key)
      const entries = await readdir(target, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      let removed = false
      for (const entry of entries) {
        if (!entry.isFile() || !/^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(entry.name)) continue
        await rm(path.join(target, entry.name), { force: true }); removed = true
      }
      if (removed) await syncDirectory(target)
    } catch (error) { blocked.add(key); issues.push('配置迁移清理未完成，旧配置保留：' + target + '：' + String(error)) }
  }
  for (const item of pending) {
    if (item.key ? blocked.has(item.key) : blocked.size > 0) continue
    try {
      const kind = await lstat(item.directory).catch(error => { if (error.code === 'ENOENT') return; throw error })
      if (!kind) continue
      if (!kind.isDirectory() || kind.isSymbolicLink()) throw new Error('不是原配置的普通目录')
      await rm(item.directory, { recursive: true, force: true })
      await syncDirectory(path.dirname(item.directory))
    } catch (error) { issues.push('旧配置清理未完成：' + item.directory + '：' + String(error)) }
  }
  return issues
}

/** The small owned staging directory belongs to this one-time transition;
 * completed publication removes it, including interrupted prior copies.
 */
export async function finishConfigurationCarry(directory: string): Promise<void> {
  const marker = path.join(directory, 'layout.json'), work = path.join(directory, '.dss-layout-migration')
  const published = async () => {
    try { const current: unknown = JSON.parse(await readFile(marker, 'utf8')); return isRecordLayout(current) && current.version === LAYOUT.version }
    catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  let layout: unknown
  try { layout = JSON.parse(await readFile(marker, 'utf8')) }
  catch (error) { if (error instanceof SyntaxError) return; throw error }
  if (isRecordLayout(layout) && layout.version === PREVIOUS_LAYOUT.version) {
    const temporary = path.join(work, randomUUID() + '.tmp')
    try {
      await mkdir(work, { recursive: true })
      const handle = await open(temporary, 'wx')
      try { await handle.writeFile(JSON.stringify({ ...layout, version: LAYOUT.version }, null, 2) + '\n', 'utf8'); await handle.sync() }
      finally { await handle.close() }
      await rename(temporary, marker)
      await syncDirectory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !await published()) throw error
    } finally { await rm(temporary, { force: true }) }
  }
}
