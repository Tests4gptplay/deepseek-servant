import { filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'
import { readLegacySkillSource, readSkillControls, type LegacySkillSource } from './legacy-skill-source.js'
import { frameworkSkillControlsPath, frameworkSkillIndexPath, prepareFrameworkSkillIndex } from './skills.js'
import { mergeSkillProposals, type SkillReadBase } from './skill-merge.js'

const candidateIndexPath = 'technical/skills/candidates.json'
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
export interface GitLegacySkillConversion {
  sourcePath: string
  content: string
  /** Full text actually returned to this once-only Agent, not a catalog projection. */
  reads: ReadonlyMap<string, SkillReadBase>
}
export class GitSkillConversionPending extends Error {
  constructor(readonly path: string, reason: string) { super(reason + ': ' + path); this.name = 'GitSkillConversionPending' }
}

/** One addressed folder inside the existing Git command. No inventory discovery,
 * new queue or separate cleanup commit. The caller keeps the original command
 * identity/inputs for UNKNOWN and derives the catalog in that same transaction. */
export async function prepareGitLegacySkillConversion(files: FilesStore, snapshot: FilesSnapshot,
  input: GitLegacySkillConversion): Promise<{ targetPath: string; sourcePaths: string[]; changes: FileChange[] }> {
  const selected = filePath(input.sourcePath)
  if (!/^skills\/(?:[^/]+\/)+(?:SKILL\.md|record\.json|legacy-git\.json)$/.test(selected))
    throw new Error('Choose the exact original skill definition in its existing folder.')
  const folder = selected.slice(0, selected.lastIndexOf('/') + 1), targetPath = folder + 'SKILL.md'
  const changes = new Map<string, FileChange>(), originals: Array<{ path: string; text: string; definition: LegacySkillSource }> = []
  // These are the two historical producer filenames, not a recursive folder scan.
  for (const path of [folder + 'record.json', folder + 'legacy-git.json']) {
    const bytes = await files.readBytes(snapshot, path)
    if (bytes === undefined) continue
    const text = decode(bytes), read = input.reads.get(path)
    if (!read || read.text !== text)
      throw new GitSkillConversionPending(path, 'Read the current complete original before converting its content')
    const definition = readLegacySkillSource(path, text)
    originals.push({ path, text, definition })
  }
  if (!originals.length) throw new GitSkillConversionPending(selected, 'The original JSON definition is absent; no conversion was inferred')
  if (selected !== targetPath && !originals.some(original => original.path === selected))
    throw new GitSkillConversionPending(selected, 'The selected original is unavailable')
  const current = await files.readBytes(snapshot, targetPath), currentText = current === undefined ? null : decode(current)
  const bases = new Map([[targetPath, input.reads.get(targetPath)]])
  const merged = await mergeSkillProposals(files, snapshot, [{ path: targetPath, text: input.content }], bases)
  const publication = merged.find(change => change.path === targetPath)?.content ?? currentText
  if (typeof publication !== 'string') throw new GitSkillConversionPending(targetPath, 'No native definition was published')
  // The same Git commit deletes the old definitions and publishes the native
  // content. Its parent tree already retains the exact original bytes, including
  // replaced native text; do not duplicate those whole files or add a HEAD index.
  for (const change of merged) changes.set(change.path, change)
  const candidate = await prepareFrameworkSkillIndex(files, snapshot, [{ path: targetPath, content: publication }])
  const catalog = candidate.changes.find(change => change.path === frameworkSkillIndexPath)?.content
  const index = typeof catalog === 'string' ? JSON.parse(catalog) as { entries: Array<{ path: string; name: string }> } : undefined
  const native = index?.entries.find(entry => entry.path === targetPath)
  if (candidate.issues.length || !native) throw new GitSkillConversionPending(targetPath,
    candidate.issues.join('; ') || 'The proposal is not a complete native skill definition')

  const controls = readSkillControls(await files.readBytes(snapshot, frameworkSkillControlsPath)), entries = { ...controls.entries }
  // Match the existing Local conversion rule: retain exact source controls,
  // and do not silently weaken retired to a separately disabled target.
  const restrictions = originals.map(original => {
    const restriction = entries[original.path] ?? original.definition.restriction
    if (!entries[original.path] && restriction) entries[original.path] = restriction
    return restriction
  }).filter(value => value !== undefined)
  if (entries[targetPath]?.status === 'disabled' && restrictions.some(value => value.status === 'retired'))
    throw new GitSkillConversionPending(targetPath, 'The disabled native target conflicts with a retired source. Both actual choices and source bodies remain retained')
  if (!entries[targetPath]) entries[targetPath] = restrictions.find(value => value.status === 'retired') ?? restrictions[0]!
  if (entries[targetPath] === undefined) delete entries[targetPath]
  if (JSON.stringify(entries) !== JSON.stringify(controls.entries))
    changes.set(frameworkSkillControlsPath, { path: frameworkSkillControlsPath, content: encode({ ...controls, entries }) })
  const candidates = await files.read(snapshot, candidateIndexPath)
  if (candidates !== undefined) {
    const value = JSON.parse(candidates) as { version: number; entries: Array<{ sourcePath: string; [key: string]: unknown }> }
    if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Existing skill candidate index is invalid; its original was retained.')
    const entries = value.entries.map(entry => originals.some(original => original.path === entry.sourcePath) ? { ...entry, sourcePath: targetPath } : entry)
    if (JSON.stringify(entries) !== JSON.stringify(value.entries))
      changes.set(candidateIndexPath, { path: candidateIndexPath, content: encode({ ...value, entries }) })
  }
  // Only the current exact inputs referenced above are retired in this atomic
  // publication. The original transaction keeps concurrent input/CAS handling.
  for (const original of originals) changes.set(original.path, { path: original.path, content: null })
  return { targetPath, sourcePaths: originals.map(original => original.path), changes: [...changes.values(), ...candidate.changes] }
}
