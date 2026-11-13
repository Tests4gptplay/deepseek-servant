import { PhysicalLocalFiles } from './physical-local-files.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import type { FrameworkTransactions } from './command-transactions.js'
import { GitFiles, filePath, withOperationChannel, withSnapshot, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'

export const frameworkSkillControlsPath = 'technical/skills/controls.json'
export interface FrameworkSkillControls { version: 1; entries: Record<string, { status: 'disabled' | 'retired'; reason?: string; updatedAt?: string }> }
export const frameworkSkillIndexPath = 'technical/skills/catalog.json'
const providerName = 'deepseek-servant-framework'
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const skillFileNames = ['SKILL.md']
const isSkillFile = (path: string) => path.startsWith('skills/') && skillFileNames.some(name => path.endsWith('/' + name))
/** Only definitions contribute derived catalog metadata; resources do not. */
export const isFrameworkSkillDefinitionPath = isSkillFile
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
type NativeSkillMetadata = Pick<SkillDefinition, 'whenToUse' | 'metadata'>
interface IndexedSkill extends Pick<SkillDefinition, 'whenToUse'> {
  path: string; hash: string; name: string; description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  kind: 'markdown'
}
interface Catalog { version: 1; entries: IndexedSkill[] }
/** Match the native filesystem provider's public fields. The SDK exposes its
 * provider, not a standalone parser; neither field changes scope or permission. */
function nativeSkillMetadata(data: { whenToUse?: unknown; metadata?: unknown }): NativeSkillMetadata {
  return { ...(typeof data.whenToUse === 'string' && data.whenToUse.length > 0 ? { whenToUse: data.whenToUse } : {}),
    ...(typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)
      ? { metadata: data.metadata as Readonly<Record<string, unknown>> } : {}) }
}
/** Native canonical invocation keys accept these boolean forms only. Explicit
 * null and unrecognized values are invalid, while absence uses native defaults. */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') switch (value.toLowerCase()) {
    case 'true': case 'yes': case 'on': return true
    case 'false': case 'no': case 'off': return false
  }
  throw new TypeError('frontmatter field "' + key + '" must be a boolean')
}
function markdown(text: string): NativeSkillMetadata & { name: string; description: string; invocation: IndexedSkill['invocation']; content: string } | undefined {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(normalized)
  if (!match) return undefined
  const data = parseYaml(match[1]!) as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.name !== 'string' || !isSkillName(data.name)
    || typeof data.description !== 'string' || data.description.length === 0) return undefined
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) if (Object.hasOwn(data, key)) return undefined
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return { name: data.name, description: data.description, ...nativeSkillMetadata(data),
    invocation: { modelInvocable: disableModelInvocation !== true, userInvocable: userInvocable !== false },
    content: normalized.slice(match[0].length).trim() }
}
/** Arbitrary native metadata stays with the loaded definition, not the JSON
 * discovery catalog. YAML aliases and non-finite numbers must not be lost. */
interface ParsedSkill extends Pick<SkillDefinition, 'metadata'> { entry: IndexedSkill; content: string }
function parseSkill(path: string, text: string, fingerprint: string): ParsedSkill | undefined {
  if (path.endsWith('/SKILL.md')) {
    const parsed = markdown(text)
    if (!parsed) return undefined
    return { entry: { path, hash: fingerprint, name: parsed.name, description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}), invocation: parsed.invocation, kind: 'markdown' },
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}), content: parsed.content }
  }
  return undefined
}
function invalidSkillIssue(path: string): string | undefined {
  if (path.endsWith('/SKILL.md')) return 'Not a native skill definition: ' + path
  return undefined
}
const encodeCatalog = (entries: Iterable<IndexedSkill>) => JSON.stringify({ version: 1,
  entries: [...entries].sort((a, b) => a.path.localeCompare(b.path)) }) + '\n'
/** The catalog is disposable metadata, not an authority for definitions or
 * user controls. Check only fields consumed by discovery, using definition
 * parsing rules. Content hashes/version labels and unknown extension fields are
 * not admission gates; get() parses actual current definitions independently. */
function parseCatalog(bytes: Uint8Array | undefined): Catalog | undefined {
  if (bytes === undefined) return
  try {
    const value = JSON.parse(decode(bytes)) as Catalog
    if (!value || value.version !== 1 || !Array.isArray(value.entries)) return
    const seen = new Set<string>()
    for (const entry of value.entries) {
      if (!entry || typeof entry.path !== 'string' || !isSkillFile(entry.path) || filePath(entry.path) !== entry.path || seen.has(entry.path)
        || typeof entry.name !== 'string' || !isSkillName(entry.name) || typeof entry.description !== 'string' || entry.description.length === 0
        || typeof entry.invocation?.modelInvocable !== 'boolean' || typeof entry.invocation.userInvocable !== 'boolean') return
      if (entry.kind !== 'markdown' || !entry.path.endsWith('/SKILL.md')) return
      seen.add(entry.path)
    }
    return { ...value, entries: value.entries.map(({ whenToUse, ...entry }) =>
      ({ ...entry, ...(typeof whenToUse === 'string' && whenToUse.length > 0 ? { whenToUse } : {}) })) }
  } catch { return undefined }
}
/** A missing or corrupt catalog is derived from existing definitions at this snapshot.
 * Reading never writes it, and invalid bodies remain untouched and unadvertised.
 * Hash the exact stored bytes, including any UTF-8 BOM, not a decoded substitute.
 */
async function rebuildCatalog(files: FilesStore, snapshot: FilesSnapshot): Promise<{ index: Catalog; issues: string[] }> {
  const entries: IndexedSkill[] = [], issues: string[] = []
  for (const item of await files.list(snapshot, 'skills', { names: skillFileNames })) {
    const path = filePath(item.path)
    if (!isSkillFile(path)) continue
    const bytes = await files.readBytes(snapshot, path)
    if (bytes === undefined) continue
    try {
      const parsed = parseSkill(path, decode(bytes), hash(bytes))
      if (parsed) entries.push(parsed.entry)
      else { const issue = invalidSkillIssue(path); if (issue) issues.push(issue) }
    } catch (error) { issues.push(path + ': ' + (error instanceof Error ? error.message : String(error))) }
  }
  return { index: { version: 1, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) }, issues }
}
async function catalog(files: FilesStore, snapshot: FilesSnapshot): Promise<Catalog> {
  return parseCatalog(await files.readBytes(snapshot, frameworkSkillIndexPath)) ?? (await rebuildCatalog(files, snapshot)).index
}

export interface FrameworkSkillIndexInitialization { status: 'created' | 'rebuilt' | 'unchanged'; issues: string[] }
/** Host-owned maintenance of missing/corrupt derived metadata only. Valid
 * catalogs, skill bodies and custom controls are never rewritten. Concurrent
 * repairs update only this catalog file in Physical Local; Git retains its
 * conditional transaction and reevaluates source changes there.
 */
export function createFrameworkSkillIndexInitialization(files: FilesStore, transactions: FrameworkTransactions, options: { missingOnly?: boolean } = {}):
  (signal?: AbortSignal) => Promise<FrameworkSkillIndexInitialization> {
  const commandId = 'initialize-skill-catalog:' + randomUUID()
  let attempted = false
  let result: FrameworkSkillIndexInitialization = { status: 'unchanged', issues: [] }
  return async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (!attempted) {
      const present = await withSnapshot(files, async snapshot => {
        const bytes = await files.readBytes(snapshot, frameworkSkillIndexPath)
        return options.missingOnly && bytes !== undefined || parseCatalog(bytes) !== undefined
      }, { files: [frameworkSkillIndexPath], signal })
      if (present) return result
    }
    signal?.throwIfAborted()
    if (files instanceof PhysicalLocalFiles) return files.updateAsync<FrameworkSkillIndexInitialization>(frameworkSkillIndexPath, async bytes => {
      signal?.throwIfAborted()
      if (options.missingOnly && bytes !== undefined || parseCatalog(bytes)) return { value: { status: 'unchanged' as const, issues: [] } }
      const rebuilt = await withSnapshot(files, snapshot => rebuildCatalog(files, snapshot), { signal })
      signal?.throwIfAborted()
      return { value: { status: bytes === undefined ? 'created' as const : 'rebuilt' as const, issues: rebuilt.issues },
        content: encodeCatalog(rebuilt.index.entries) }
    }, signal)
    attempted = true
    const receipt = await transactions.run(commandId,
      { kind: 'initialize-skill-catalog', path: frameworkSkillIndexPath },
      { reevaluate: true, gitReplay: 'session-only', gitEmptyResult: 'observation-only', readPlan: { files: [frameworkSkillIndexPath], signal } }, async snapshot => {
        signal?.throwIfAborted()
        const bytes = await files.readBytes(snapshot, frameworkSkillIndexPath)
        if (options.missingOnly && bytes !== undefined || parseCatalog(bytes)) { result = { status: 'unchanged', issues: [] }; return [] }
        const rebuilt = await rebuildCatalog(files, snapshot)
        signal?.throwIfAborted()
        result = { status: bytes === undefined ? 'created' : 'rebuilt', issues: rebuilt.issues }
        return [{ path: frameworkSkillIndexPath, content: encodeCatalog(rebuilt.index.entries) }]
      })
    if (files instanceof GitFiles && receipt.operationId) await files.operations.delete?.(receipt.operationId)
    return result
  }
}

export function initializeFrameworkSkillIndex(files: FilesStore, transactions: FrameworkTransactions, signal?: AbortSignal): Promise<FrameworkSkillIndexInitialization> {
  return createFrameworkSkillIndexInitialization(files, transactions)(signal)
}

async function controls(files: FilesStore, snapshot: FilesSnapshot): Promise<FrameworkSkillControls> {
  const text = await files.read(snapshot, frameworkSkillControlsPath)
  if (text === undefined) return { version: 1, entries: {} }
  const value = JSON.parse(text) as FrameworkSkillControls
  if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw new Error('Invalid skill controls record.')
  return value
}
const disabled = (value: FrameworkSkillControls, path: string) => ['disabled', 'retired'].includes(value.entries[path]?.status)

/** One authoritative metadata view, shared by every Agent after a local commit.
 * This is background read work, never a foreground or Host-poll request. */
export async function readFrameworkSkillCatalog(files: FilesStore, signal?: AbortSignal): Promise<readonly IndexedSkill[]> {
  return withOperationChannel(files, 'read', () => withSnapshot(files, async snapshot => {
    const states = await controls(files, snapshot)
    return (await catalog(files, snapshot)).entries.filter(entry => !disabled(states, entry.path))
  }, { files: [frameworkSkillControlsPath, frameworkSkillIndexPath], signal }))
}

export interface FrameworkSkillProvider {
  /** Settle this installation attempt; missing services remain unavailable and startup failures reject. */
  settleRegistration(): Promise<void>
  dispose(): Promise<void>
  invalidate(): void
  available(): boolean
  diagnostics(): string[]
  catalogGeneration(): number
  replaceCatalog(entries: readonly IndexedSkill[]): void
  clearCatalog(): void
  notifyCatalogChange(): boolean
}

/** Derive catalog changes at the caller's publication snapshot. This
 * extracts metadata from supplied definition bytes. A missing or corrupt catalog needs
 * reconstruction from existing definitions before merging the staged changes.
 * Invalid/unactivated material remains preserved but is not advertised as a skill.
 */
export async function prepareFrameworkSkillIndex(files: FilesStore, snapshot: FilesSnapshot, changes: readonly FileChange[], options: { skipUnchanged?: boolean } = {}): Promise<{ changes: FileChange[]; issues: string[] }> {
  const relevant = changes.filter(change => isSkillFile(change.path))
  if (!relevant.length) return { changes: [], issues: [] }
  const previous = await files.readBytes(snapshot, frameworkSkillIndexPath)
  const index = parseCatalog(previous) ?? (await rebuildCatalog(files, snapshot)).index
  const entries = new Map(index.entries.map(entry => [entry.path, entry])), issues: string[] = []
  for (const change of relevant) {
    filePath(change.path); entries.delete(change.path)
    if (change.content === null) continue
    try {
      const text = change.bytes === undefined ? change.content! : decode(change.bytes)
      const parsed = parseSkill(change.path, text, hash(change.bytes ?? text))
      if (parsed) entries.set(change.path, parsed.entry)
      else { const issue = invalidSkillIssue(change.path); if (issue) issues.push(issue) }
    } catch (error) { issues.push(change.path + ': ' + (error instanceof Error ? error.message : String(error))) }
  }
  const content = encodeCatalog(entries.values())
  const unchanged = options.skipUnchanged && previous !== undefined && Buffer.from(previous).equals(Buffer.from(content))
  return { changes: unchanged ? [] : [{ path: frameworkSkillIndexPath, content }], issues }
}

/** Derived Local catalog update is a separate, best-effort consequence of
 * actual skill publication. Only the shared catalog file serializes. Definitions
 * are read at this update, never replaced by an earlier proposal or stale row. */
export async function refreshPhysicalFrameworkSkillIndex(files: import('./physical-local-files.js').PhysicalLocalFiles,
  changedPaths: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const relevant = [...new Set(changedPaths.filter(isSkillFile))]
  if (!relevant.length) return []
  return files.updateAsync(frameworkSkillIndexPath, async bytes => withSnapshot(files, async snapshot => {
    const rebuilt = parseCatalog(bytes) ? undefined : await rebuildCatalog(files, snapshot)
    const entries = new Map((parseCatalog(bytes) ?? rebuilt!.index).entries.map(entry => [entry.path, entry]))
    const issues = [...rebuilt?.issues ?? []]
    for (const path of relevant) {
      entries.delete(path)
      const body = await files.readBytes(snapshot, path)
      if (body === undefined) continue
      try {
        const parsed = parseSkill(path, decode(body), hash(body))
        if (parsed) entries.set(path, parsed.entry)
        else { const issue = invalidSkillIssue(path); if (issue) issues.push(issue) }
      } catch (error) { issues.push(path + ': ' + (error instanceof Error ? error.message : String(error))) }
    }
    return { value: issues, content: encodeCatalog(entries.values()) }
  }, { signal }), signal)
}

/** Uses the real native registry in the exact actual Agent scope. Local/Git share
 * logical storage; neither requires filesystem mirrors or global skill leakage. */
export function installFrameworkSkillProvider(scope: Context, agent: Agent, files: FilesStore,
  options: { channel?: 'read' | 'foreground-read'; taskKey?(): string } = {}): FrameworkSkillProvider {
  if (scopeOf(scope) !== agent) throw new Error('Framework skills must be installed in the actual Agent scope.')
  let control: SkillProviderControl | undefined
  let disposed = false
  // The native registry clears every scope's catalog cache on any provider
  // invalidation/mount. Keep this task's summaries here too, so unrelated Agents
  // cannot turn their own lifecycle into another remote read for this task.
  let listed: Promise<IndexedSkill[]> | undefined
  let taskKey = options.taskKey?.()
  let generation = 0, catalogRevision = 0, nextRead = 0
  const entryReads = new Map<string, number>()
  const clearCatalog = () => { generation++; catalogRevision++; listed = undefined; entryReads.clear() }
  const invalidate = () => { clearCatalog(); control?.invalidate() }
  const rememberList = (pending: Promise<IndexedSkill[]>) => {
    listed = pending
    // Failed reads remain retryable rather than becoming an empty catalog.
    void pending.catch(() => { if (listed === pending) listed = undefined })
    return pending
  }
  const refreshEntry = (path: string, entry: IndexedSkill, observedGeneration: number, read: number) => {
    if (generation !== observedGeneration || entryReads.get(path) !== read || disposed) return
    // Independent in-flight gets merge by path. Only whole-cache replacement
    // fences every path; a later read of this path supersedes its earlier read.
    catalogRevision++
    if (listed) rememberList(listed.then(entries => {
      const next = entries.filter(value => value.path !== path)
      next.push(entry)
      return next.sort((a, b) => a.path.localeCompare(b.path))
    }))
    control?.invalidate()
  }
  // Native publication awaits next() before reading summaries. Only a changed
  // admitted task reloads storage summaries; additional steps and turns reuse
  // them, with selected definitions refreshed from their current bytes below.
  // This callback reads in-memory ownership only, never storage or a timer.
  const stopRefresh = scope.on('agent/pre-step', (event, next) => {
    if (event.agent === agent && options.taskKey) {
      const current = options.taskKey()
      if (current !== taskKey) { taskKey = current; invalidate() }
    }
    return next()
  })
  const allowed = (entry: IndexedSkill) => entry.kind === 'markdown'
  const fiber = scope.inject(['skills'], child => {
  child.effect(() => () => { clearCatalog(); control = undefined }, 'framework.skillCapability')
  child.skills.registerProvider(value => {
    control = value
    return {
      name: providerName,
      list: async lookup => {
        lookup.signal?.throwIfAborted()
        if (!listed) {
          const pending = withOperationChannel(files, options.channel ?? 'read', () => withSnapshot(files, async snapshot => { const states = await controls(files, snapshot); return (await catalog(files, snapshot)).entries.filter(entry => !disabled(states, entry.path)) },
            { files: [frameworkSkillControlsPath, frameworkSkillIndexPath] }))
          rememberList(pending)
        }
        const entries = await listed!
        lookup.signal?.throwIfAborted()
        return entries.filter(allowed).map((entry): SkillCandidate => ({ name: entry.name, description: entry.description,
          ...(entry.whenToUse !== undefined ? { whenToUse: entry.whenToUse } : {}), invocation: entry.invocation, source: 'runtime', provider: providerName, rank: 250,
          resourceBase: { kind: 'opaque', description: 'DSS logical skill resources: ' + entry.path.slice(0, entry.path.lastIndexOf('/')) + '. Read selected resources with dss_read; Git views stay at their opened revision, while physical Local reads the current addressed file.' },
          locator: entry }))
      },
      get: async (candidate, lookup): Promise<SkillDefinition | undefined> => {
        lookup.signal?.throwIfAborted()
        const entry = candidate.locator as IndexedSkill
        if (!entry || typeof entry.path !== 'string' || !isSkillFile(entry.path)) return undefined
        const path = filePath(entry.path), observedGeneration = generation, observedControl = control, read = ++nextRead
        entryReads.set(path, read)
        const bytes = await withOperationChannel(files, options.channel ?? 'read', () =>
          withSnapshot(files, async snapshot => disabled(await controls(files, snapshot), path) ? undefined : files.readBytes(snapshot, path),
            { files: [frameworkSkillControlsPath, path], signal: lookup.signal }))
        lookup.signal?.throwIfAborted()
        if (disposed || !observedControl || observedControl.signal.aborted || control !== observedControl) return undefined
        let current: ParsedSkill | undefined
        if (bytes !== undefined) {
          try { current = parseSkill(path, decode(bytes), hash(bytes)) } catch { /* Invalid definitions are not advertised. */ }
        }
        if (!current || !allowed(current.entry)) {
          // Do not retain a negative result for this task: a later repair or
          // re-enable must be discoverable at the next native request boundary.
          if (generation === observedGeneration && entryReads.get(path) === read) invalidate()
          return undefined
        }
        // The catalog is a discovery hint, not a version lock. Revalidate actual
        // current metadata and return the current body in this same call.
        if (JSON.stringify(current.entry) !== JSON.stringify(entry)) refreshEntry(path, current.entry, observedGeneration, read)
        // Native get(name) requires this identity. A rename updates discovery;
        // it must never return the new skill while pretending to be the old one.
        if (current.entry.name !== candidate.name) return undefined
        return { name: current.entry.name, description: current.entry.description,
          ...nativeSkillMetadata({ whenToUse: current.entry.whenToUse, metadata: current.metadata }), invocation: current.entry.invocation,
          source: candidate.source, provider: candidate.provider, resourceBase: candidate.resourceBase, content: current.content }
      },
    }
  })
  })
  return { settleRegistration: async () => { await fiber },
    dispose: async () => { disposed = true; stopRefresh(); clearCatalog(); await fiber.dispose() },
    invalidate, available: () => !disposed && control !== undefined && !control.signal.aborted,
    catalogGeneration: () => catalogRevision,
    replaceCatalog: entries => {
      if (disposed) return
      // A committed metadata refresh changes discovery only. Skill content
      // already loaded into model context stays intact.
      generation++; catalogRevision++; entryReads.clear()
      rememberList(Promise.resolve([...entries]))
    },
    clearCatalog,
    notifyCatalogChange: () => { if (disposed || !control || control.signal.aborted) return false; control.invalidate(); return true },
    diagnostics: () => control ? [] : ['Native skill registry is unavailable in this Agent scope; preserved skill files are not currently discoverable by the native skill tool.'] }
}
