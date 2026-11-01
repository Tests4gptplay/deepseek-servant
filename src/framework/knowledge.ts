import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import type { SkillRecord, SkillVersion } from '../contracts/knowledge.js'
import { FrameworkTransactions } from './command-transactions.js'
import { filePath, withSnapshot, type FilesStore, type FileChange } from './transactions.js'
import { prepareFrameworkSkillIndex, frameworkSkillIndexPath, frameworkSkillControlsPath, type FrameworkSkillControls } from './skills.js'

const candidateIndex = 'technical/skills/candidates.json'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}'
    : JSON.stringify(value)
export interface KnowledgeItem {
  path: string
  kind: 'legacy' | 'markdown' | 'legacy-git'
  name: string
  description: string
  status: string
  indexed: boolean
  activeVersion?: number
  versions?: Array<{ version: number; status: string; contentHash: string }>
  candidates: Array<{ path: string; hash: string; createdAt: string }>
  error?: string
}
interface Candidate { sourcePath: string; path: string; hash: string; createdAt: string }
interface CandidateIndex { version: 1; entries: Candidate[] }
export interface KnowledgeEdit {
  path: string
  expectedRevision: string
  body: string
  /** Freeze this actual timestamp with the caller's command identity on retry. */
  createdAt: string
  title?: string
  description?: string
  applicability?: string
}
function kind(path: string): KnowledgeItem['kind'] {
  filePath(path)
  if (!path.startsWith('skills/')) throw new Error('Select a skill record inside the skills directory.')
  if (path.endsWith('/record.json')) return 'legacy'
  if (path.endsWith('/legacy-git.json')) return 'legacy-git'
  if (path.endsWith('/SKILL.md')) return 'markdown'
  throw new Error('Select the skill definition, not one of its resource files.')
}
function legacy(text: string): SkillRecord {
  const record = JSON.parse(text) as SkillRecord
  if (record.schemaVersion !== 1 || record.kind !== 'skill' || typeof record.skillId !== 'string'
    || typeof record.scope?.assistantId !== 'string' || typeof record.scope.workspaceId !== 'string'
    || !Number.isSafeInteger(record.revision) || !Array.isArray(record.versions) || !record.versions.length
    || record.versions.some(value => !Number.isSafeInteger(value.version) || value.version < 1
      || ['title', 'description', 'applicability', 'body', 'contentHash'].some(key => typeof value[key as keyof SkillVersion] !== 'string')))
    throw new Error('Invalid migrated skill record.')
  return record
}

/** User-facing knowledge maintenance, invoked on demand rather than by Host polling.
 * Edits are candidates; no invented validation, success count or automatic promotion.
 */
export class FrameworkKnowledge {
  constructor(private readonly files: FilesStore, private readonly transactions: FrameworkTransactions,
    private readonly onChanged: () => void = () => {}) {}
  list() {
    return withSnapshot(this.files, async snapshot => {
      const controls = JSON.parse(await this.files.read(snapshot, frameworkSkillControlsPath) ?? '{"version":1,"entries":{}}') as FrameworkSkillControls
      const candidates = JSON.parse(await this.files.read(snapshot, candidateIndex) ?? '{"version":1,"entries":[]}') as CandidateIndex
      const catalog = JSON.parse(await this.files.read(snapshot, frameworkSkillIndexPath) ?? '{"version":1,"entries":[]}') as { entries: Array<{path: string; hash: string}> }
      const items: KnowledgeItem[] = []
      for (const entry of await this.files.list(snapshot, 'skills/')) {
        if (!['/record.json', '/legacy-git.json', '/SKILL.md'].some(suffix => entry.path.endsWith(suffix))) continue
        const item: KnowledgeItem = { path: entry.path, kind: kind(entry.path), name: entry.path, description: '', status: controls.entries[entry.path]?.status ?? 'stored', indexed: false, candidates: candidates.entries.filter(row => row.sourcePath === entry.path).map(({ path, hash, createdAt }) => ({ path, hash, createdAt })) }
        try {
          const text = await this.files.read(snapshot, entry.path)
          if (text === undefined) throw new Error('Skill definition is missing.')
          item.indexed = !controls.entries[entry.path] && catalog.entries.some(row => row.path === entry.path && row.hash === hash(text))
          if (!controls.entries[entry.path]) item.status = item.indexed ? 'active' : 'unindexed'
          if (item.kind === 'legacy') {
            const record = legacy(text), selected = record.versions.find(version => version.version === record.activeVersion) ?? record.versions.at(-1)!
            item.name = selected.title; item.description = selected.description; item.activeVersion = record.activeVersion
            item.status = controls.entries[entry.path]?.status ?? selected.status
            item.versions = record.versions.map(({ version, status, contentHash }) => ({ version, status, contentHash }))
          } else if (item.kind === 'legacy-git') {
            const record = JSON.parse(text) as { name: string; description: string }
            item.name = record.name; item.description = record.description
          } else {
            const header = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))
            if (!header) throw new Error('Skill front matter is missing.')
            const fields = parseYaml(header[1]!) as { name?: string; description?: string }
            item.name = typeof fields?.name === 'string' ? fields.name : entry.path; item.description = typeof fields?.description === 'string' ? fields.description : ''
          }
        } catch (error) { item.error = error instanceof Error ? error.message : String(error) }
        items.push(item)
      }
      return { revision: snapshot.revision, items }
    })
  }
  read(path: string) {
    const selectedKind = kind(path)
    return withSnapshot(this.files, async snapshot => {
      const text = await this.files.read(snapshot, path)
      if (text === undefined) return { revision: snapshot.revision, path, text }
      if (selectedKind === 'legacy') {
        const value = legacy(text).versions.at(-1)!
        return { revision: snapshot.revision, path, text, edit: { body: value.body, title: value.title, description: value.description, applicability: value.applicability } }
      }
      if (selectedKind === 'legacy-git') {
        const value = JSON.parse(text) as { body: string }
        return { revision: snapshot.revision, path, text, edit: { body: value.body } }
      }
      return { revision: snapshot.revision, path, text, edit: { body: text } }
    })
  }
  async edit(commandId: string, input: KnowledgeEdit) {
    const selectedKind = kind(input.path)
    if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error('Use the edit command’s actual timestamp.')
    const receipt = await this.transactions.run('knowledge-edit:' + commandId, input, { expectedRevision: input.expectedRevision }, async snapshot => {
      const text = await this.files.read(snapshot, input.path)
      if (text === undefined) throw new Error('Skill definition is missing.')
      if (selectedKind === 'legacy') {
        const record = legacy(text), previous = record.versions.at(-1)!
        const content = { title: input.title ?? previous.title, description: input.description ?? previous.description,
          body: input.body, applicability: input.applicability ?? previous.applicability, scope: record.scope }
        const contentHash = hash(stable(content))
        if (contentHash === previous.contentHash && !previous.bodyRetiredAt) return []
        const candidate: SkillVersion = { ...content, skillId: record.skillId, version: previous.version + 1,
          contentHash, status: 'candidate', createdAt: input.createdAt, sourceResultIds: [], validations: [], uses: [], feedback: [], supersedes: previous.version }
        record.versions.push(candidate); record.revision++
        const change: FileChange = { path: input.path, content: encode(record) }
        const index = await prepareFrameworkSkillIndex(this.files, snapshot, [change])
        return [change, ...index.changes]
      }
      const candidates = JSON.parse(await this.files.read(snapshot, candidateIndex) ?? '{"version":1,"entries":[]}') as CandidateIndex
      const digest = hash(input.body)
      if (candidates.entries.some(row => row.sourcePath === input.path && row.hash === digest)) return []
      // A candidate resource is not named SKILL.md and never enters the active catalog.
      const path = input.path.slice(0, input.path.lastIndexOf('/')) + '/candidates/' + hash(commandId) + '.md'
      candidates.entries.push({ sourcePath: input.path, path, hash: digest, createdAt: input.createdAt })
      return [{ path, content: input.body }, { path: candidateIndex, content: encode(candidates) }]
    })
    this.onChanged()
    return receipt
  }
  async setStatus(commandId: string, input: { path: string; expectedRevision: string; status: 'disabled' | 'retired'; reason?: string; updatedAt?: string }) {
    const selectedKind = kind(input.path)
    if (input.status !== 'disabled' && input.status !== 'retired') throw new Error('Choose disable or retire for this operation.')
    const receipt = await this.transactions.run('knowledge-status:' + commandId, input, { expectedRevision: input.expectedRevision }, async snapshot => {
      const text = await this.files.read(snapshot, input.path)
      if (text === undefined) throw new Error('Skill definition is missing.')
      const controls = JSON.parse(await this.files.read(snapshot, frameworkSkillControlsPath) ?? '{"version":1,"entries":{}}') as FrameworkSkillControls
      controls.entries[input.path] = { status: input.status, ...(input.reason === undefined ? {} : { reason: input.reason }), ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }) }
      const changes: FileChange[] = [{ path: frameworkSkillControlsPath, content: encode(controls) }]
      if (selectedKind === 'legacy') {
        let record: SkillRecord
        try { record = legacy(text) } catch { return changes } // Explicit disable still applies; malformed history stays untouched.
        const selected = record.versions.find(version => version.version === record.activeVersion) ?? record.versions.at(-1)!
        selected.status = input.status
        if (input.reason !== undefined) selected.statusReason = input.reason
        if (record.activeVersion === selected.version) delete record.activeVersion
        record.revision++
        const change: FileChange = { path: input.path, content: encode(record) }
        changes.push(change, ...(await prepareFrameworkSkillIndex(this.files, snapshot, [change])).changes)
      }
      return changes
    })
    this.onChanged()
    return receipt
  }
}
