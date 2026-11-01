import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import type { KnowledgeScope, SkillRecord } from '../contracts/knowledge.js'
import { filePath, withSnapshot, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'

export const frameworkSkillControlsPath = 'technical/skills/controls.json'
export interface FrameworkSkillControls { version: 1; entries: Record<string, { status: 'disabled' | 'retired'; reason?: string; updatedAt?: string }> }
export const frameworkSkillIndexPath = 'technical/skills/catalog.json'
const providerName = 'deepseek-servant-framework'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
interface IndexedSkill {
  path: string; hash: string; name: string; description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  kind: 'markdown' | 'legacy' | 'legacy-git'; scope?: KnowledgeScope; activeVersion?: number; participantId?: string
}
interface Catalog { version: 1; entries: IndexedSkill[] }
const sameScope = (left: KnowledgeScope, right: KnowledgeScope) => left.assistantId === right.assistantId && left.workspaceId === right.workspaceId
function markdown(text: string): { name: string; description: string; invocation: IndexedSkill['invocation']; content: string } | undefined {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(normalized)
  if (!match) return undefined
  const data = parseYaml(match[1]!) as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !isSkillName(data.name)
    || typeof data.description !== 'string' || !data.description.trim()) return undefined
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) if (Object.hasOwn(data, key)) return undefined
  for (const key of ['disable-model-invocation', 'user-invocable']) if (data[key] !== undefined && typeof data[key] !== 'boolean') return undefined
  return { name: data.name, description: data.description,
    invocation: { modelInvocable: data['disable-model-invocation'] !== true, userInvocable: data['user-invocable'] !== false },
    content: normalized.slice(match[0].length).trim() }
}
function legacy(text: string): { record: SkillRecord; active: SkillRecord['versions'][number] } | undefined {
  const record = JSON.parse(text) as SkillRecord
  if (record.schemaVersion !== 1 || record.kind !== 'skill' || !record.scope?.assistantId || !record.scope.workspaceId
    || !Array.isArray(record.versions) || !isSkillName('servant-' + record.skillId)) return undefined
  const active = record.versions.find(version => version.version === record.activeVersion && version.status === 'active' && !version.bodyRetiredAt)
  if (!active || typeof active.description !== 'string' || typeof active.applicability !== 'string' || typeof active.body !== 'string') return undefined
  return { record, active }
}
interface LegacyGitSkill { version: 1; kind: 'legacy-git-skill'; participantId: string; name: string; description: string; body: string; source: { path: string; metadata: unknown } }
function legacyGit(text: string): LegacyGitSkill | undefined {
  const value = JSON.parse(text) as LegacyGitSkill
  if (value.version !== 1 || value.kind !== 'legacy-git-skill' || typeof value.participantId !== 'string' || !value.participantId
    || typeof value.name !== 'string' || !isSkillName(value.name) || typeof value.description !== 'string' || !value.description.trim()
    || typeof value.body !== 'string' || typeof value.source?.path !== 'string') return undefined
  return value
}
async function catalog(files: FilesStore, snapshot: FilesSnapshot): Promise<Catalog> {
  const text = await files.read(snapshot, frameworkSkillIndexPath)
  if (text === undefined) return { version: 1, entries: [] }
  const value = JSON.parse(text) as Catalog
  if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid framework skill catalog.')
  return value
}

async function controls(files: FilesStore, snapshot: FilesSnapshot): Promise<FrameworkSkillControls> {
  const text = await files.read(snapshot, frameworkSkillControlsPath)
  if (text === undefined) return { version: 1, entries: {} }
  const value = JSON.parse(text) as FrameworkSkillControls
  if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw new Error('Invalid skill controls record.')
  return value
}
const disabled = (value: FrameworkSkillControls, path: string) => ['disabled', 'retired'].includes(value.entries[path]?.status)

/** Append these index changes to the SAME Recorder/migration transaction. This
 * extracts metadata from already supplied output, not a background body scan.
 * Invalid/unactivated material remains preserved but is not advertised as a skill.
 */
export async function prepareFrameworkSkillIndex(files: FilesStore, snapshot: FilesSnapshot, changes: readonly FileChange[]): Promise<{ changes: FileChange[]; issues: string[] }> {
  const relevant = changes.filter(change => change.path.startsWith('skills/') && (change.path.endsWith('/SKILL.md') || change.path.endsWith('/record.json') || change.path.endsWith('/legacy-git.json')))
  if (!relevant.length) return { changes: [], issues: [] }
  const index = await catalog(files, snapshot), entries = new Map(index.entries.map(entry => [entry.path, entry])), issues: string[] = []
  for (const change of relevant) {
    filePath(change.path); entries.delete(change.path)
    if (change.content === null) continue
    try {
      const text = change.bytes === undefined ? change.content! : new TextDecoder('utf-8', { fatal: true }).decode(change.bytes)
      if (change.path.endsWith('/SKILL.md')) {
        const parsed = markdown(text)
        if (!parsed) { issues.push('Not a native skill definition: ' + change.path); continue }
        entries.set(change.path, { path: change.path, hash: hash(text), name: parsed.name, description: parsed.description,
          invocation: parsed.invocation, kind: 'markdown' })
      } else if (change.path.endsWith('/legacy-git.json')) {
        const parsed = legacyGit(text)
        if (!parsed) { issues.push('Invalid migrated Git skill: ' + change.path); continue }
        entries.set(change.path, { path: change.path, hash: hash(text), name: parsed.name, description: parsed.description,
          invocation: { modelInvocable: true, userInvocable: true }, kind: 'legacy-git', participantId: parsed.participantId })
      } else {
        const parsed = legacy(text)
        if (!parsed) continue
        const { record, active } = parsed
        entries.set(change.path, { path: change.path, hash: hash(text), name: 'servant-' + record.skillId,
          description: active.description + '\n适用范围：' + active.applicability, invocation: { modelInvocable: true, userInvocable: true },
          kind: 'legacy', scope: record.scope, activeVersion: active.version })
      }
    } catch (error) { issues.push(change.path + ': ' + (error instanceof Error ? error.message : String(error))) }
  }
  return { changes: [{ path: frameworkSkillIndexPath, content: JSON.stringify({ version: 1, entries: [...entries.values()].sort((a,b) => a.path.localeCompare(b.path)) }) + '\n' }], issues }
}

/** Explicit one-time adapter installation for already migrated files. Never call
 * this from tick/catalog lookup. The caller commits returned changes with CAS. */
export async function rebuildFrameworkSkillIndex(files: FilesStore, snapshot: FilesSnapshot): Promise<{ changes: FileChange[]; issues: string[] }> {
  const changes: FileChange[] = []
  const existing = await catalog(files, snapshot)
  for (const entry of existing.entries) changes.push({ path: entry.path, content: null })
  for (const entry of await files.list(snapshot, 'skills/')) if (entry.path.endsWith('/SKILL.md') || entry.path.endsWith('/record.json') || entry.path.endsWith('/legacy-git.json')) {
    const text = await files.read(snapshot, entry.path)
    if (text !== undefined) changes.push({ path: entry.path, content: text })
  }
  return prepareFrameworkSkillIndex(files, snapshot, changes)
}

/** Uses the real native registry in the exact actual Agent scope. Local/Git share
 * logical storage; neither requires filesystem mirrors or global skill leakage. */
export function installFrameworkSkillProvider(scope: Context, agent: Agent, files: FilesStore,
  options: { legacyScopes?: readonly KnowledgeScope[]; legacyGitParticipants?: readonly string[] } = {}): { dispose(): Promise<void>; invalidate(): void; available(): boolean; diagnostics(): string[]; canReadResource(path: string): boolean } {
  if (scopeOf(scope) !== agent) throw new Error('Framework skills must be installed in the actual Agent scope.')
  let control: SkillProviderControl | undefined
  const selectedRoots = new Set<string>()
  // Native catalog publication awaits next() before reading registry summaries.
  // Invalidating here refreshes at actual model steps, never on a polling timer.
  const stopRefresh = scope.on('agent/pre-step', (event, next) => {
    if (event.agent === agent) control?.invalidate()
    return next()
  })
  const allowed = (entry: IndexedSkill) => entry.kind === 'markdown' || (entry.kind === 'legacy'
    ? !!entry.scope && (options.legacyScopes ?? []).some(value => sameScope(value, entry.scope!))
    : entry.kind === 'legacy-git' && !!entry.participantId && (options.legacyGitParticipants ?? []).includes(entry.participantId))
  const fiber = scope.inject(['skills'], child => {
  child.effect(() => () => { control = undefined; selectedRoots.clear() }, 'framework.skillCapability')
  child.skills.registerProvider(value => {
    control = value
    return {
      name: providerName,
      list: async lookup => {
        lookup.signal?.throwIfAborted()
        const entries = await withSnapshot(files, async snapshot => { const states = await controls(files, snapshot); return (await catalog(files, snapshot)).entries.filter(entry => !disabled(states, entry.path)) })
        lookup.signal?.throwIfAborted()
        return entries.filter(allowed).map((entry): SkillCandidate => ({ name: entry.name, description: entry.description,
          invocation: entry.invocation, source: 'runtime', provider: providerName, rank: 250,
          resourceBase: { kind: 'opaque', description: 'DSS logical skill resources: ' + entry.path.slice(0, entry.path.lastIndexOf('/')) + '. Read selected resources with dss_read at a fixed storage revision.' },
          locator: entry }))
      },
      get: async (candidate, lookup): Promise<SkillDefinition | undefined> => {
        lookup.signal?.throwIfAborted()
        const entry = candidate.locator as IndexedSkill
        if (!entry.path.startsWith('skills/') || !allowed(entry)) return undefined
        const text = await withSnapshot(files, async snapshot => disabled(await controls(files, snapshot), entry.path) ? undefined : files.read(snapshot, filePath(entry.path)))
        lookup.signal?.throwIfAborted()
        if (text === undefined || hash(text) !== entry.hash) { control?.invalidate(); return undefined }
        let content: string | undefined
        if (entry.kind === 'markdown') content = markdown(text)?.content
        else if (entry.kind === 'legacy-git') {
          const parsed = legacyGit(text)
          if (parsed?.participantId === entry.participantId && parsed?.name === entry.name) content = parsed.body
        } else {
          const parsed = legacy(text)
          if (parsed && parsed.active.version === entry.activeVersion && entry.scope && sameScope(parsed.record.scope, entry.scope)) {
            const active = parsed.active
            content = `# ${active.title}\n\n${active.description}\n\n## 适用范围\n\n${active.applicability}\n\n${active.body}\n`
          }
        }
        if (content !== undefined) selectedRoots.add(entry.path.slice(0, entry.path.lastIndexOf('/')))
        return content === undefined ? undefined : { name: candidate.name, description: candidate.description, invocation: candidate.invocation,
          source: candidate.source, provider: candidate.provider, resourceBase: candidate.resourceBase, content }
      },
    }
  })
  })
  return { dispose: async () => { stopRefresh(); selectedRoots.clear(); await fiber.dispose() },
    canReadResource: path => {
      try { filePath(path) } catch { return false }
      return [...selectedRoots].some(root => path === root || path.startsWith(root + '/'))
    }, invalidate: () => control?.invalidate(), available: () => control !== undefined,
    diagnostics: () => control ? [] : ['Native skill registry is unavailable in this Agent scope; preserved skill files are not currently discoverable by the native skill tool.'] }
}
