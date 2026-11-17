import type { SkillRecord, SkillVersion } from '../contracts/knowledge.js'
import type { FrameworkSkillControls } from './skills.js'

/** Only the once-only upgrade uses these old input formats. They are never
 * registered as native definitions or used by the ordinary knowledge editor. */
export interface LegacyGitSkillSource {
  version: 1; kind: 'legacy-git-skill'; participantId: string; name: string; description: string; body: string
  source: { path: string; metadata: unknown }
}
export interface LegacySkillSource {
  kind: 'record' | 'legacy-git'
  value: SkillRecord | LegacyGitSkillSource
  active: boolean
  restriction?: FrameworkSkillControls['entries'][string]
  renderings: string[]
}
const bodyPresent = (version: SkillVersion): boolean => !version.bodyRetiredAt
  && ['title', 'description', 'applicability', 'body'].every(key => typeof version[key as keyof SkillVersion] === 'string')
export const renderLegacySkillVersion = (version: Pick<SkillVersion, 'title' | 'description' | 'applicability' | 'body'>): string =>
  `# ${version.title}\n\n${version.description}\n\n## 适用范围\n\n${version.applicability}\n\n${version.body}\n`
export function readLegacySkillSource(path: string, text: string): LegacySkillSource {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (path.endsWith('/legacy-git.json')) {
    const original = value as LegacyGitSkillSource
    if (original.version !== 1 || original.kind !== 'legacy-git-skill' || typeof original.participantId !== 'string' || !original.participantId
      || typeof original.name !== 'string' || !original.name || typeof original.description !== 'string' || typeof original.body !== 'string'
      || typeof original.source?.path !== 'string') throw new Error('The original Git skill source is not recognized; its exact bytes remain retained.')
    return { kind: 'legacy-git', value: original, active: true, renderings: [] }
  }
  const record = value as SkillRecord
  if (!path.endsWith('/record.json') || record.schemaVersion !== 1 || record.kind !== 'skill' || typeof record.skillId !== 'string'
    || typeof record.scope?.assistantId !== 'string' || typeof record.scope.workspaceId !== 'string' || !Array.isArray(record.versions))
    throw new Error('The original skill record is not recognized; its exact bytes remain retained.')
  const available = record.versions.filter(version => version && bodyPresent(version))
  const methods = available.filter(version => ['active', 'disabled', 'retired'].includes(version.status))
  if (!available.length) throw new Error('The original has no retained complete method or candidate body. Its actual history remains pending without invented content.')
  const active = methods.find(version => version.version === record.activeVersion && version.status === 'active')
  // Candidate-only inputs are converted only by the AI's explicit complete
  // proposal, still disabled; their original statuses are retained verbatim.
  // An absent pointer cannot be replaced by the final candidate. The AI selects
  // content from actual inputs; this flag only preserves original availability.
  const restriction = active ? undefined : { status: methods.length > 0 && methods.every(version => version.status === 'retired') ? 'retired' as const : 'disabled' as const }
  return { kind: 'record', value: record, active: !!active, restriction, renderings: available.map(renderLegacySkillVersion) }
}
export function readSkillControls(bytes: Uint8Array | undefined): FrameworkSkillControls {
  if (bytes === undefined) return { version: 1, entries: {} }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as FrameworkSkillControls
  if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)
    || Object.values(value.entries).some(entry => !entry || !['disabled', 'retired'].includes(entry.status)))
    throw new Error('Skill controls are invalid; original choices were retained.')
  return value
}
