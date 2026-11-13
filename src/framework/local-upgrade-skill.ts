import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { localRecordPath } from './local-record-files.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { withLegacySqliteSnapshot, type LegacySqliteFile } from './legacy-sqlite-reader.js'
import { publishLocalUpgradeBytes, type LocalUpgradePublication, type LocalUpgradeIssue, type LocalStartupUpgradeOptions } from './local-startup-upgrade.js'
import { rememberLocalUpgradeMapping, localSkillUpgradeKey } from './local-upgrade-mapping.js'
import { prepareFrameworkSkillIndex, refreshPhysicalFrameworkSkillIndex, frameworkSkillControlsPath, frameworkSkillIndexPath } from './skills.js'
import { readLegacySkillSource, readSkillControls, type LegacySkillSource } from './legacy-skill-source.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
const equal = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a === undefined || b === undefined ? a === b : Buffer.from(a).equals(Buffer.from(b))
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
interface CandidateIndex { version: 1; entries: Array<{ sourcePath: string; path: string; hash?: string; createdAt?: string }> }
const candidateIndexPath = 'technical/skills/candidates.json'
function readCandidateIndex(bytes: Uint8Array | undefined): CandidateIndex {
  if (bytes === undefined) return { version: 1, entries: [] }
  // Only path identity is needed for repointing. Missing historical digest or
  // timestamp stays absent; the exact index is retained and no fact is invented.
  const value = JSON.parse(decode(bytes)) as CandidateIndex
  if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.some(row => !row
    || typeof row.path !== 'string' || typeof row.sourcePath !== 'string'))
    throw new Error('Existing skill candidates index is invalid; the original was retained.')
  return value
}
export { localSkillUpgradeKey } from './local-upgrade-mapping.js'
export interface LocalSkillUpgradeOptions extends LocalStartupUpgradeOptions {
  /** Only exact physical bytes actually read by this one-time AI, not a save-time baseline. */
  readSources?: ReadonlyMap<string, Uint8Array | undefined>
}
interface SkillUpgrade extends LocalUpgradePublication {
  kind: 'dss-once-native-skill'; directory: string; sourcePath: string; targetPath: string; sourceHash: string
  proposalHash: string; status: 'converting' | 'complete'; issues: LocalUpgradeIssue[]
  /** Exact retained source for this unfinished publication, retired with its owner. */
  retainedSources?: Record<string, string>
}
export interface LocalSkillUpgradeReport { status: 'complete' | 'incomplete'; sourcePath: string; targetPath: string; issues: LocalUpgradeIssue[] }
const report = (state: SkillUpgrade): LocalSkillUpgradeReport => ({ status: state.status === 'complete' ? 'complete' : 'incomplete', sourcePath: state.sourcePath, targetPath: state.targetPath, issues: state.issues })
export { convertedLocalSkillPath } from './local-upgrade-mapping.js'

/** One-time conversion to the existing same-root DSS native skill provider.
 * Historical identities remain exact source facts, not new runtime permission
 * fields. Ordinary discovery/editor paths never consume old JSON definitions. */
export async function publishLegacyNativeSkill(directory: string, sourcePath: string, content: string, storage: StoragePort,
  options: LocalSkillUpgradeOptions = {}): Promise<LocalSkillUpgradeReport> {
  localRecordPath(sourcePath)
  if (!/^skills\/(?:[^/]+\/)+(?:SKILL\.md|record\.json|legacy-git\.json)$/.test(sourcePath)) throw new Error('Choose one exact existing skill definition.')
  const root = await canonicalLocalLocation(directory, true), folder = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1), targetPath = folder + 'SKILL.md'
  const key = localSkillUpgradeKey(root, sourcePath), prior = await storage.get<SkillUpgrade>(key)
  if (prior && (prior.kind !== 'dss-once-native-skill' || prior.directory !== root || prior.sourcePath !== sourcePath || prior.targetPath !== targetPath)) throw new Error('The exact skill conversion identity changed; prior material was retained.')
  if (prior?.status === 'complete') return report(prior)
  return withLegacySqliteSnapshot(join(root, 'dss-files.sqlite'), async source => {
    const get = async (path: string) => { const value = await source.read(path); if (value?.kind === 'issue') throw new Error(value.issue.message); return value }
    const original = await get(sourcePath)
    if (!original) throw new Error('The selected original skill definition is unavailable.')
    const state: SkillUpgrade = prior ?? { kind: 'dss-once-native-skill', operationId: randomUUID(), directory: root, sourcePath, targetPath,
      sourceHash: hash(original.bytes), proposalHash: hash(content), status: 'converting', files: [], issues: [] }
    if (state.sourceHash !== hash(original.bytes)) throw new Error('The original skill changed during conversion; both sources were retained.')
    if (state.proposalHash !== hash(content)) {
      if (state.files.some(file => file.path === targetPath && !['published', 'already-present'].includes(file.status))) throw new Error('Continue the exact already prepared native publication before proposing another body.')
      state.proposalHash = hash(content)
    }
    const save = () => storage.set(key, structuredClone(state)), files = new PhysicalLocalFiles(root), view = await files.snapshot()
    const originals: LegacySqliteFile[] = [], histories = new Map<string, string[]>()
    const parsed: Array<{ path: string; source: LegacySkillSource; bytes: Uint8Array; sql?: LegacySqliteFile; physical?: Uint8Array }> = []
    const issue = (code: LocalUpgradeIssue['code'], path: string, message: string) => state.issues.push({ code, path, message })
    const publish = async (path: string, bytes: Uint8Array) => {
      const failure = await publishLocalUpgradeBytes(root, { path, bytes }, state, save, options)
      if (failure) state.issues.push(failure)
      return !failure
    }
    const retain = async (preferred: string, bytes: Uint8Array): Promise<string> => {
      const present = await files.readBytes(view, preferred), prepared = state.files.find(file => file.path === preferred)
      // A different actual historical resource is user content too. Retain
      // this distinct source under a content-specific ordinary resource name.
      // The digest is a filename, not a version/admission gate on later reads.
      const occupied = present !== undefined && !equal(present, bytes)
        || prepared !== undefined && prepared.sha256 !== hash(bytes) && ['published', 'already-present'].includes(prepared.status)
      const path = occupied ? preferred.replace(/(\.[^/.]+)$/, '-' + hash(bytes) + '$1') : preferred
      await publish(path, bytes)
      return path
    }
    state.issues = []; await save()
    try {
      const candidate = await prepareFrameworkSkillIndex(files, view, [{ path: targetPath, content }])
      const catalogText = candidate.changes.find(change => change.path === frameworkSkillIndexPath)?.content
      const catalog = typeof catalogText === 'string' ? JSON.parse(catalogText) : undefined
      const native = catalog?.entries?.find((entry: { path: string; kind: string }) => entry.path === targetPath && entry.kind === 'markdown')
      if (candidate.issues.length || !native) issue('source-row', targetPath, candidate.issues.join('; ') || 'The proposal is not a native skill definition.')
      for await (const entry of source.entries(folder)) {
        options.signal?.throwIfAborted()
        if (entry.kind === 'issue') { issue('source-row', entry.issue.path ?? sourcePath, entry.issue.message); continue }
        originals.push(entry)
      }
      // A nested definition owns its own skill folder and conversion. Do not
      // materialize a child skill's unconverted definition as a parent resource.
      const nestedRoots = originals.filter(entry => /\/(?:SKILL\.md|record\.json|legacy-git\.json)$/.test(entry.path))
        .map(entry => entry.path.slice(0, entry.path.lastIndexOf('/') + 1)).filter(path => path !== folder)
      const owned = originals.filter(entry => !nestedRoots.some(path => entry.path.startsWith(path)))
      originals.splice(0, originals.length, ...owned)
      // Read each exact old source, including a record beside an old rendered
      // SKILL.md. Selecting that rendering cannot bypass its disabled state.
      for (const path of [folder + 'record.json', folder + 'legacy-git.json']) {
        const sql = originals.find(entry => entry.path === path), physical = await files.readBytes(view, path)
        const retainedPath = state.retainedSources?.[path]
        let retained: Uint8Array | undefined
        if (physical === undefined && retainedPath) {
          retained = await files.readBytes(view, retainedPath)
          const confirmed = state.files.find(file => file.path === retainedPath)
          if (retained === undefined || !confirmed || hash(retained) !== confirmed.sha256) {
            issue('source-row', path, 'The exact retained current source is unavailable or changed. Its original SQL and current resources were preserved; no older version was silently substituted.'); continue
          }
        }
        const bytes = physical ?? retained ?? sql?.bytes
        if (bytes === undefined) continue
        if (physical && (!sql || !equal(physical, sql.bytes)) && !equal(options.readSources?.get(path), physical)) {
          issue('source-row', path, 'The current physical skill differs from the SQL original. Read this exact current source in the one-time tool before converting its newer content.'); continue
        }
        try { parsed.push({ path, source: readLegacySkillSource(path, decode(bytes)), bytes, sql, physical }) }
        catch (error) { issue('source-row', path, error instanceof Error ? error.message : String(error)); continue }
      }
      // v848's current sharing target is this existing Files root's DSS role
      // provider. Old scope/participant/source remain complete historical facts;
      // they do not introduce a second discovery root or a runtime permit check.
      if (sourcePath.endsWith('.json') && !parsed.some(entry => entry.path === sourcePath) && !state.issues.length)
        issue('source-row', sourcePath, 'The original skill input is not recognized.')
      const oldTarget = originals.find(entry => entry.path === targetPath), current = await files.readBytes(view, targetPath), proposed = Buffer.from(content)
      const oldRendering = current !== undefined && parsed.some(entry => entry.source.renderings.includes(decode(current)))
      const wasRead = options.readSources?.has(targetPath) && equal(options.readSources.get(targetPath), current)
      if (current !== undefined && !equal(current, proposed) && !equal(current, oldTarget?.bytes) && !oldRendering && !wasRead)
        issue('target-conflict', targetPath, 'The physical target contains a current contribution. Read this exact target in the one-time tool and supply the merged native definition; its body is unchanged.')
      // These indexes are inputs to this conversion. Reject an unreadable
      // original before publishing its new definition, while other skills can
      // still be handled independently by the existing once owner.
      const originalControls = await get(frameworkSkillControlsPath)
      const originalCandidates = parsed.length ? await get(candidateIndexPath) : undefined
      let oldControls: ReturnType<typeof readSkillControls>, oldCandidates: CandidateIndex
      const currentControlBytes = await files.readBytes(view, frameworkSkillControlsPath)
      try { oldControls = readSkillControls(originalControls?.bytes); readSkillControls(currentControlBytes) }
      catch (error) { issue('source-row', frameworkSkillControlsPath, error instanceof Error ? error.message : String(error)) }
      try { oldCandidates = readCandidateIndex(originalCandidates?.bytes); if (parsed.length) readCandidateIndex(await files.readBytes(view, candidateIndexPath)) }
      catch (error) { issue('source-row', candidateIndexPath, error instanceof Error ? error.message : String(error)) }
      if (state.issues.length) { await save(); return report(state) }
      const convertedControls = (bytes: Uint8Array | undefined) => {
        const currentControls = readSkillControls(bytes), entries = { ...oldControls!.entries, ...currentControls.entries }
        // Current controls win for their exact source. A separately disabled
        // target cannot silently weaken an actual retired source; leave both
        // choices intact for this item's one-time resolution.
        const restrictions = parsed.map(({ path, source: definition }) => {
          const restriction = entries[path] ?? definition.restriction
          if (!entries[path] && restriction) entries[path] = restriction
          return restriction
        }).filter(value => value !== undefined)
        if (entries[targetPath]?.status === 'disabled' && restrictions.some(value => value.status === 'retired')) {
          issue('target-conflict', targetPath, 'The disabled native target conflicts with a retired source. Both actual choices and source bodies remain retained; resolve this item without weakening either state.')
          return undefined
        }
        if (!entries[targetPath]) entries[targetPath] = restrictions.find(value => value.status === 'retired') ?? restrictions[0]!
        if (entries[targetPath] === undefined) delete entries[targetPath]
        return entries
      }
      const entries = convertedControls(currentControlBytes)
      if (native && entries && !entries[targetPath] && catalog.entries.some((entry: { path: string; name: string }) =>
        entry.path !== targetPath && entry.name === native.name && !entries[entry.path]))
        issue('target-conflict', targetPath, 'Another native skill uses this name. Both definitions remain available for the one-time AI to resolve.')
      if (state.issues.length) { await save(); return report(state) }
      // Full actual records, including every candidate/version and source fact,
      // are long-term skill material, not a second live JSON definition.
      for (const entry of parsed) {
        const originalName = entry.path.slice(folder.length)
        const retainedPath = await retain(folder + 'resources/original-' + originalName, entry.bytes)
        histories.set(entry.path, [retainedPath])
        if (state.issues.length) { await save(); return report(state) }
        state.retainedSources ??= {}; state.retainedSources[entry.path] = retainedPath; await save()
        if (entry.sql && !equal(entry.sql.bytes, entry.bytes)) {
          const sqlPath = await retain(folder + 'resources/original-sql-' + originalName, entry.sql.bytes)
          histories.get(entry.path)!.push(sqlPath)
        }
      }
      for (const originalIndex of parsed.length ? [originalControls, originalCandidates] : []) if (originalIndex) {
        const path = await retain(folder + 'resources/original-' + originalIndex.path.slice(originalIndex.path.lastIndexOf('/') + 1), originalIndex.bytes)
        histories.set(originalIndex.path, [path])
      }
      if (state.issues.length) { await save(); return report(state) }
      // Ordinary candidate/binary/resource files keep exact paths and bytes.
      for (const entry of originals) if (entry.path !== targetPath && !histories.has(entry.path)) await publish(entry.path, entry.bytes)
      if (state.issues.length) { await save(); return report(state) }
      // Custom native source text is actual content, independently of the new
      // complete definition. Keep each distinct original as an ordinary resource.
      if (oldTarget && !parsed.some(entry => entry.source.renderings.includes(decode(oldTarget.bytes))) && !equal(oldTarget.bytes, proposed)) {
        const path = await retain(folder + 'resources/original-SKILL.md', oldTarget.bytes); histories.set(targetPath, [path])
      }
      if (current && !equal(current, proposed) && !equal(current, oldTarget?.bytes) && !oldRendering) {
        const path = await retain(folder + 'resources/original-current-SKILL.md', current)
        histories.set(targetPath, [...histories.get(targetPath) ?? [], path])
      }
      if (state.issues.length) { await save(); return report(state) }
      await files.update(frameworkSkillControlsPath, bytes => {
        const currentControls = readSkillControls(bytes), entries = convertedControls(bytes)
        if (!entries || JSON.stringify(entries) === JSON.stringify(currentControls.entries)) return { value: undefined }
        return { value: undefined, content: encode({ ...currentControls, entries }) }
      }, options.signal)
      if (state.issues.length) { await save(); return report(state) }
      let written: boolean
      if (current !== undefined) {
        written = await files.update(targetPath, latest => equal(latest, proposed) ? { value: true }
          : equal(latest, current) ? { value: true, content } : { value: false }, options.signal)
        if (!written) issue('target-conflict', targetPath, 'The physical target changed after the AI input was checked. Current content and source history remain retained.')
      } else written = await publish(targetPath, proposed)
      if (written) {
        // Merge the complete actual index, so an unchanged native/other-skill
        // row is not falsely marked transferred while absent physically.
        if (parsed.length) await files.update(candidateIndexPath, bytes => {
          const currentIndex = readCandidateIndex(bytes), entries = [...currentIndex.entries]
          for (const row of oldCandidates!.entries) if (!entries.some(entry => entry.path === row.path)) entries.push(row)
          const mapped = entries.map(row => parsed.some(entry => entry.path === row.sourcePath) ? { ...row, sourcePath: targetPath } : row)
          return bytes !== undefined && JSON.stringify(mapped) === JSON.stringify(currentIndex.entries) ? { value: undefined }
            : { value: undefined, content: encode({ ...currentIndex, entries: mapped }) }
        }, options.signal)
        for (const message of await refreshPhysicalFrameworkSkillIndex(files, [targetPath], options.signal)) {
          // Catalog reconstruction can report another still-pending original.
          // That does not undo this independent native publication.
          if (message === 'Not a native skill definition: ' + targetPath || message.startsWith(targetPath + ': '))
            issue('source-row', targetPath, message)
        }
        if (!state.issues.length) {
          // Only retire the exact current live JSON after native/control state
          // and complete original history exist. Later edits stay pending.
          for (const entry of parsed) if (entry.physical) {
            const removed = await files.update(entry.path, latest => latest === undefined ? { value: true }
              : equal(latest, entry.physical) ? { value: true, content: null } : { value: false }, options.signal)
            if (!removed) issue('target-conflict', entry.path, 'The old source changed during publication. Its new bytes remain at their original path for this one-time operation.')
          }
        }
        if (!state.issues.length) {
          for (const entry of parsed) if (!entry.sql)
            await rememberLocalUpgradeMapping(storage, root, entry, state.operationId, [targetPath, ...histories.get(entry.path) ?? []])
          for (const entry of originals) await rememberLocalUpgradeMapping(storage, root, entry, state.operationId,
            entry.path === targetPath || histories.has(entry.path) ? [targetPath, ...histories.get(entry.path) ?? []] : [entry.path])
          for (const path of [frameworkSkillIndexPath, frameworkSkillControlsPath, ...parsed.length ? [candidateIndexPath] : []]) {
            const entry = await get(path); if (entry) await rememberLocalUpgradeMapping(storage, root, entry, state.operationId, [path, ...histories.get(path) ?? []], 'physical-original-retained')
          }
          state.status = 'complete'
        }
      }
      options.signal?.throwIfAborted(); await save(); return report(state)
    } finally { await view.release(); await files.close() }
  }, { signal: options.signal })
}
