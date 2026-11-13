import { PhysicalLocalFiles } from './physical-local-files.js'
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { FrameworkTransactions, CommandInputsChangedError } from './command-transactions.js'
import { filePath, withSnapshot, type FilesStore, type FilesSnapshot, type FileEntry, type FileChange } from './transactions.js'
import { frameworkSkillIndexPath, frameworkSkillControlsPath, prepareFrameworkSkillIndex, refreshPhysicalFrameworkSkillIndex, type FrameworkSkillControls } from './skills.js'
import { mergeSkillProposals, publishPhysicalSkillProposal, SkillMergeRequired, type SkillReadBase } from './skill-merge.js'

const candidateIndex = 'technical/skills/candidates.json'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}'
    : JSON.stringify(value)
const targetRevision = (path: string, text: string | undefined, controls: FrameworkSkillControls) =>
  'knowledge:' + hash(stable([path, text ?? null, controls.entries[path] ?? null]))
export interface KnowledgeItem {
  path: string
  /** Identity of this definition and its own status control, not the storage HEAD. */
  revision?: string
  kind: 'legacy' | 'markdown' | 'legacy-git' | 'project-fact' | 'preference'
  name: string
  description: string
  status: string
  indexed: boolean
  readOnly?: boolean
  /** Exact pending original bytes, never parsed as a live skill definition. */
  text?: string
  resources?: string[]
  candidates: Array<{ path: string; hash: string; createdAt: string }>
  error?: string
  scope?: KnowledgeReadRecord['scope']
  source?: string
}
export interface KnowledgeReadRecord {
  kind: 'project-fact' | 'preference'
  text: string
  scope: { assistantId?: string; workspaceId?: string; participantId?: string }
  source: string
  applicability?: string
}
function isReadOnlyRecord(path: string): boolean {
  filePath(path)
  return /^knowledge\/(facts|preferences)\/.+\.json$/.test(path)
    || /^knowledge\/legacy-git\/[^/]+\/(knowledge|preference)\/[^/]+\.json$/.test(path)
}
function readOnlyRecord(path: string, text: string): KnowledgeReadRecord {
  if (!isReadOnlyRecord(path)) throw new Error('Select a migrated fact or preference record.')
  const value = JSON.parse(text)
  if (typeof value.text !== 'string') throw new Error('Knowledge record body is invalid.')
  if (path.startsWith('knowledge/legacy-git/')) {
    if (value.version !== 1 || !['knowledge', 'preference'].includes(value.kind)
      || typeof value.participantId !== 'string' || typeof value.source?.path !== 'string') throw new Error('Migrated Git knowledge provenance is invalid.')
    return { kind: value.kind === 'preference' ? 'preference' : 'project-fact', text: value.text,
      scope: { participantId: value.participantId }, source: JSON.stringify(value.source) }
  }
  if (value.schemaVersion !== 1 || !['project-fact', 'preference'].includes(value.kind)
    || typeof value.scope?.assistantId !== 'string' || typeof value.scope.workspaceId !== 'string'
    || typeof (value.kind === 'project-fact' ? value.sourceResultId : value.userSourceRef) !== 'string'
    || (value.kind === 'preference' && typeof value.applicability !== 'string')) throw new Error('Migrated knowledge provenance is invalid.')
  return { kind: value.kind, text: value.text, scope: value.scope,
    source: value.kind === 'project-fact' ? value.sourceResultId : value.userSourceRef,
    ...(value.kind === 'preference' ? { applicability: value.applicability } : {}) }
}
interface Candidate { sourcePath: string; path: string; hash: string; createdAt: string }
interface CandidateIndex { version: 1; entries: Candidate[] }
export interface KnowledgeEdit {
  path: string
  /** Target identity returned by knowledge read/list, not a storage revision. */
  expectedRevision: string
  body: string
  /** Complete original text delivered to this editor; frozen with the command on retry. */
  baseBody: string
}
function kind(path: string): KnowledgeItem['kind'] {
  filePath(path)
  if (!path.startsWith('skills/')) throw new Error('Select a skill record inside the skills directory.')
  if (path.endsWith('/record.json')) return 'legacy'
  if (path.endsWith('/legacy-git.json')) return 'legacy-git'
  if (path.endsWith('/SKILL.md')) return 'markdown'
  throw new Error('Select the skill definition, not one of its resource files.')
}
export interface KnowledgeConversionBridge {
  resolve(path: string): Promise<{ convertedPath?: string; text?: string }>
  /** Already inventoried by the one-time owner. Never starts discovery. */
  pendingPaths?(): readonly string[]
}
class OriginalSkillTransition extends Error {}
export interface KnowledgeReadResult {
  revision: string; path: string; text?: string; record?: KnowledgeReadRecord
  readOnly?: boolean; sourcePath?: string; convertedPath?: string; resources?: string[]
  edit?: { body: string }
}
function resources(path: string, entries: readonly FileEntry[]): string[] {
  const prefix = path.slice(0, path.lastIndexOf('/')) + '/'
  const childSkills = entries.filter(entry => entry.path.startsWith(prefix) && entry.path !== prefix + 'SKILL.md'
    && entry.path.endsWith('/SKILL.md')).map(entry => entry.path.slice(0, -'SKILL.md'.length))
  return entries.filter(entry => entry.path.startsWith(prefix) && entry.path !== path
    && !childSkills.some(child => entry.path.startsWith(child))
    && !entry.path.startsWith(prefix + 'candidates/')
    && !['record.json', 'legacy-git.json', 'SKILL.md'].includes(entry.path.slice(prefix.length))).map(entry => entry.path)
}

/** User-facing knowledge maintenance, invoked on demand rather than by Host polling.
 * Explicit user edits publish the native definition, retaining existing controls and history.
 */
export class FrameworkKnowledge {
  constructor(private readonly files: FilesStore, private readonly transactions: FrameworkTransactions,
    private readonly onChanged: () => void = () => {}, private readonly conversion?: KnowledgeConversionBridge) {}
  list() {
    return withSnapshot(this.files, async snapshot => {
      const controls = JSON.parse(await this.files.read(snapshot, frameworkSkillControlsPath) ?? '{"version":1,"entries":{}}') as FrameworkSkillControls
      const candidates = JSON.parse(await this.files.read(snapshot, candidateIndex) ?? '{"version":1,"entries":[]}') as CandidateIndex
      const catalog = JSON.parse(await this.files.read(snapshot, frameworkSkillIndexPath) ?? '{"version":1,"entries":[]}') as { entries: Array<{path: string; hash: string}> }
      const items: KnowledgeItem[] = []
      const skillEntries = await this.files.list(snapshot, 'skills/')
      const definitions = new Set(skillEntries.map(entry => entry.path))
      const pendingPaths = new Set(this.conversion?.pendingPaths?.() ?? [])
      for (const path of pendingPaths) definitions.add(path)
      for (const path of definitions) {
        const entry = { path }
        if (!['/record.json', '/legacy-git.json', '/SKILL.md'].some(suffix => entry.path.endsWith(suffix))) continue
        const item: KnowledgeItem = { path: entry.path, kind: kind(entry.path), name: entry.path, description: '', status: controls.entries[entry.path]?.status ?? 'stored', indexed: false, candidates: candidates.entries.filter(row => row.sourcePath === entry.path).map(({ path, hash, createdAt }) => ({ path, hash, createdAt })) }
        item.resources = resources(entry.path, skillEntries)
        if (this.files instanceof PhysicalLocalFiles) item.candidates = await this.physicalCandidates(this.files, snapshot, entry.path, candidates, skillEntries)
        if (item.kind !== 'markdown') {
          item.readOnly = true; item.status = 'read-only'; items.push(item); continue
        }
        try {
          const text = await this.files.read(snapshot, entry.path)
          item.revision = targetRevision(entry.path, text, controls)
          if (text === undefined && pendingPaths.has(entry.path)) {
            const original = await this.conversion?.resolve(entry.path)
            item.text = original?.text; item.readOnly = true; item.status = 'read-only'
            items.push(item); continue
          }
          if (text === undefined) throw new Error('Skill definition is missing.')
          item.indexed = !controls.entries[entry.path] && catalog.entries.some(row => row.path === entry.path && row.hash === hash(text))
          if (!controls.entries[entry.path]) item.status = item.indexed ? 'active' : 'unindexed'
          {
            const header = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))
            if (!header) throw new Error('Skill front matter is missing.')
            const fields = parseYaml(header[1]!) as { name?: string; description?: string }
            item.name = typeof fields?.name === 'string' ? fields.name : entry.path; item.description = typeof fields?.description === 'string' ? fields.description : ''
          }
        } catch (error) { item.error = error instanceof Error ? error.message : String(error) }
        items.push(item)
      }
      const legacyIndex = JSON.parse(await this.files.read(snapshot, 'knowledge/legacy-index.json') ?? '{"version":1,"entries":[]}') as { entries: Array<{ path: string; kind: string }> }
      const recordPaths = new Set(legacyIndex.entries.filter(entry => ['project-fact', 'preference'].includes(entry.kind)).map(entry => entry.path))
      for (const entry of await this.files.list(snapshot, 'knowledge/legacy-git/')) if (isReadOnlyRecord(entry.path)) recordPaths.add(entry.path)
      for (const path of recordPaths) {
        const item: KnowledgeItem = { path, kind: 'project-fact', name: path, description: '', status: 'read-only', indexed: false, candidates: [] }
        try {
          if (!isReadOnlyRecord(path)) throw new Error('Invalid migrated knowledge record path.')
          const text = await this.files.read(snapshot, path)
          if (text === undefined) throw new Error('Migrated knowledge record is missing.')
          const record = readOnlyRecord(path, text)
          item.kind = record.kind; item.scope = record.scope; item.source = record.source
          item.description = record.applicability ?? ''
        } catch (error) { item.error = error instanceof Error ? error.message : String(error) }
        items.push(item)
      }
      return { revision: snapshot.revision, items }
    })
  }
  async read(path: string): Promise<KnowledgeReadResult> {
    if (isReadOnlyRecord(path)) return withSnapshot(this.files, async snapshot => {
      const text = await this.files.read(snapshot, path)
      return { revision: snapshot.revision, path, text, ...(text === undefined ? {} : { record: readOnlyRecord(path, text) }) }
    })
    const selectedKind = kind(path)
    if (selectedKind !== 'markdown') {
      // A later user-created/edited old path remains a real readable original.
      // A previously recorded conversion must not hide those current bytes.
      const current = await withSnapshot(this.files, async snapshot => {
        const text = await this.files.read(snapshot, path)
        return text === undefined ? undefined : { revision: snapshot.revision, path, text, readOnly: true,
          resources: resources(path, await this.files.list(snapshot, path.slice(0, path.lastIndexOf('/')) + '/')) }
      })
      if (current) return current
      const resolved = await this.conversion?.resolve(path)
      if (resolved?.convertedPath) {
        if (kind(resolved.convertedPath) !== 'markdown') throw new Error('Converted skill must be a native definition.')
        return { ...await this.read(resolved.convertedPath), sourcePath: path, convertedPath: resolved.convertedPath }
      }
      return withSnapshot(this.files, async snapshot => ({ revision: snapshot.revision, path,
        text: await this.files.read(snapshot, path) ?? resolved?.text, readOnly: true,
        resources: resources(path, await this.files.list(snapshot, path.slice(0, path.lastIndexOf('/')) + '/')) }))
    }
    return withSnapshot(this.files, async snapshot => {
      const text = await this.files.read(snapshot, path)
      // Only an absent, already-inventoried original can consult the bridge.
      // A real native file always wins, even while the owner still lists it.
      if (text === undefined && this.conversion?.pendingPaths?.().includes(path)) {
        const original = await this.conversion.resolve(path)
        return { revision: snapshot.revision, path, text: original.text, readOnly: true,
          resources: resources(path, await this.files.list(snapshot, path.slice(0, path.lastIndexOf('/')) + '/')) }
      }
      const controls = JSON.parse(await this.files.read(snapshot, frameworkSkillControlsPath) ?? '{"version":1,"entries":{}}') as FrameworkSkillControls
      return { revision: targetRevision(path, text, controls), path, text,
        resources: resources(path, await this.files.list(snapshot, path.slice(0, path.lastIndexOf('/')) + '/')),
        ...(text === undefined ? {} : { edit: { body: text } }) }
    })
  }
  private async transition(path: string) {
    const resolved = await this.conversion?.resolve(path)
    if (resolved?.convertedPath && kind(resolved.convertedPath) !== 'markdown') throw new Error('Converted skill must be a native definition.')
    return { saved: false as const, ...(resolved?.convertedPath ? { convertedPath: resolved.convertedPath } : {}) }
  }
  async edit(commandId: string, input: KnowledgeEdit) {
    const selectedKind = kind(input.path)
    if (selectedKind !== 'markdown' && this.files instanceof PhysicalLocalFiles) return this.transition(input.path)
    // Old retained candidate commands must not become a new direct publication.
    // The editor must explicitly reload a native definition to establish intent.
    const base = (): SkillReadBase => {
      if (typeof input.baseBody !== 'string') throw new Error('Reload the native skill before saving; the original draft has been retained.')
      return { id: commandId, path: input.path, revision: input.expectedRevision, text: input.baseBody }
    }
    let receipt, issues: string[] = []
    try {
      if (this.files instanceof PhysicalLocalFiles) {
        await publishPhysicalSkillProposal(this.files, { path: input.path, text: input.body }, base())
        // The definition is already saved. A derived index error cannot turn that
        // confirmed write into a failed edit or cause its body to be published again.
        try { issues = await refreshPhysicalFrameworkSkillIndex(this.files, [input.path]) }
        catch (error) { issues = ['Skill saved, but catalog refresh did not complete: ' + (error instanceof Error ? error.message : String(error))] }
      } else {
        receipt = await this.transactions.run('knowledge-edit:' + commandId, input,
          { reevaluate: true, ...(selectedKind === 'markdown' ? { gitReplay: 'session-only' as const } : {}) }, async snapshot => {
            // Resolve an original UNKNOWN before evaluating or converting its input.
            if (selectedKind !== 'markdown') throw new OriginalSkillTransition()
            const changes = await mergeSkillProposals(this.files, snapshot, [{ path: input.path, text: input.body }], new Map([[input.path, base()]]))
            // Derive from current authority even for an already-included edit.
            // The exact definition and shared catalog participate in the same CAS.
            const bytes = changes.length ? undefined : await this.files.readBytes(snapshot, input.path)
            const current: FileChange = changes[0] ?? (bytes === undefined ? { path: input.path, content: null } : { path: input.path, bytes })
            const index = await prepareFrameworkSkillIndex(this.files, snapshot, [current], { skipUnchanged: true })
            issues = index.issues
            return [...changes, ...index.changes]
          })
      }
    } catch (error) {
      if (error instanceof OriginalSkillTransition) return this.transition(input.path)
      if (error instanceof SkillMergeRequired) return { saved: false as const, conflicts: error.issues }
      throw error
    }
    this.onChanged()
    return { ...receipt, saved: true as const, issues }
  }
  async setStatus(commandId: string, input: { path: string; expectedRevision: string; status: 'disabled' | 'retired'; reason?: string; updatedAt?: string }) {
    const selectedKind = kind(input.path)
    if (input.status !== 'disabled' && input.status !== 'retired') throw new Error('Choose disable or retire for this operation.')
    if (this.files instanceof PhysicalLocalFiles) return this.statusPhysical(this.files, commandId, input, selectedKind)
    let receipt
    try { receipt = await this.transactions.run('knowledge-status:' + commandId, input, { reevaluate: true, ...(selectedKind === 'markdown' ? { gitReplay: 'session-only' as const } : {}) }, async snapshot => {
      // run resolves any original UNKNOWN command before this new builder.
      if (selectedKind !== 'markdown') throw new OriginalSkillTransition()
      const text = await this.files.read(snapshot, input.path)
      if (text === undefined) throw new Error('Skill definition is missing.')
      const controls = JSON.parse(await this.files.read(snapshot, frameworkSkillControlsPath) ?? '{"version":1,"entries":{}}') as FrameworkSkillControls
      const value = { status: input.status, ...(input.reason === undefined ? {} : { reason: input.reason }), ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }) }
      if (stable(controls.entries[input.path]) === stable(value)) return []
      if (targetRevision(input.path, text, controls) !== input.expectedRevision) throw new CommandInputsChangedError()
      controls.entries[input.path] = value
      const changes: FileChange[] = [{ path: frameworkSkillControlsPath, content: encode(controls) }]
      return changes
    }) } catch (error) {
      if (!(error instanceof OriginalSkillTransition)) throw error
      return this.transition(input.path)
    }
    // Refresh discovery after confirmed publication or observation that the
    // complete desired status already exists in the current controls.
    this.onChanged()
    return receipt
  }
  /** Candidate files are originals in Local. The on-demand UI discovers the
   * selected skill's actual folder; a derived catalog cannot hide a saved file. */
  private async physicalCandidates(files: PhysicalLocalFiles, snapshot: FilesSnapshot, sourcePath: string,
    oldCatalog?: CandidateIndex, entries?: readonly FileEntry[]): Promise<Candidate[]> {
    const prefix = sourcePath.slice(0, sourcePath.lastIndexOf('/')) + '/candidates/'
    const found = entries ?? await files.listDirectory(snapshot, prefix)
    const result: Candidate[] = []
    for (const entry of found) {
      if (!entry.path.startsWith(prefix) || entry.path.slice(prefix.length).includes('/') || !entry.path.endsWith('.md')) continue
      const body = await files.read(snapshot, entry.path)
      if (body === undefined) continue
      const timestamp = /^(\d+)-[a-f0-9]{64}\.md$/.exec(entry.path.slice(prefix.length))
      const original = oldCatalog?.entries.find(row => row.path === entry.path && row.sourcePath === sourcePath)
      result.push({ sourcePath, path: entry.path, hash: hash(body),
        createdAt: timestamp && Number.isFinite(Number(timestamp[1])) && Number(timestamp[1]) <= 8.64e15
          ? new Date(Number(timestamp[1])).toISOString() : original?.createdAt ?? '' })
    }
    return result
  }
  private async statusPhysical(files: PhysicalLocalFiles, _commandId: string,
    input: { path: string; expectedRevision: string; status: 'disabled' | 'retired'; reason?: string; updatedAt?: string }, selectedKind: KnowledgeItem['kind']) {
    if (selectedKind !== 'markdown') return this.transition(input.path)
    return withSnapshot(files, async snapshot => {
      if (await files.read(snapshot, input.path) === undefined) throw new Error('Skill definition is missing.')
      // Controls are the actual native/UI availability state. Old skill JSON
      // remains original history; a disable does not rewrite its versions or
      // accumulate a second command ledger beside the user's content.
      await files.update(frameworkSkillControlsPath, bytes => {
        const controls = JSON.parse(bytes === undefined ? '{"version":1,"entries":{}}'
          : new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as FrameworkSkillControls
        const value = { status: input.status, ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }) }
        if (JSON.stringify(controls.entries[input.path]) === JSON.stringify(value)) return { value: undefined }
        controls.entries[input.path] = value
        return { value: undefined, content: encode(controls) }
      })
      this.onChanged()
      return { revision: snapshot.revision, replay: false }
    })
  }

}
