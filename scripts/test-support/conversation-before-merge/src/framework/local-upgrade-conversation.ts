import { createHash, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { localRecordPath } from './local-record-files.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { withLegacySqliteSnapshot, type LegacySqliteFile } from './legacy-sqlite-reader.js'
import { rememberLocalUpgradeMapping, localUpgradeResultKey } from './local-upgrade-mapping.js'
import { publishLocalUpgradeBytes, type LocalUpgradePublication, type LocalUpgradeIssue, type LocalStartupUpgradeOptions } from './local-startup-upgrade.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
const logical = (path: string): string => localRecordPath(path.startsWith('dss-coop/') ? path.slice('dss-coop/'.length) : path)
const parse = (bytes: Uint8Array): Record<string, any> => {
  const value = JSON.parse(decode(bytes).replace(/^\uFEFF/, ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The original conversation object is not a JSON record.')
  return value
}
export interface LocalConversationUpgradeReport {
  status: 'not-needed' | 'complete' | 'incomplete'
  directory: string
  collaborationId: string
  converted: number
  issues: LocalUpgradeIssue[]
  retainedStages: ReadonlyArray<{ path: string; reason: string }>
}
interface ConversationUpgrade extends LocalUpgradePublication {
  kind: 'dss-once-conversation-full-text'
  directory: string
  collaborationId: string
  status: 'converting' | 'complete'
  converted: string[]
  issues: LocalUpgradeIssue[]
}
export const localConversationUpgradeKey = (directory: string, collaborationId: string): string =>
  'framework-upgrade-conversation/' + hash(directory + '\0' + collaborationId)
const describe = (state: ConversationUpgrade): LocalConversationUpgradeReport => ({
  status: state.status === 'complete' ? 'complete' : 'incomplete', directory: state.directory, collaborationId: state.collaborationId,
  converted: state.converted.length, issues: state.issues, retainedStages: state.retainedStages ?? [],
})

/** Restores ONE actually addressed Local conversation before that scope accepts
 * a new send. Its existing startup/access owner awaits this actual work promise;
 * no permanent ready signal, normal-file hash gate or whole-store queue exists.
 * Message IDs, entry paths, index order and context references remain unchanged.
 */
export async function restoreLegacyConversationScope(directory: string, collaborationId: string, storage: StoragePort,
  options: LocalStartupUpgradeOptions = {}): Promise<LocalConversationUpgradeReport> {
  options.signal?.throwIfAborted()
  if (!collaborationId || /[\\/\0\r\n]/.test(collaborationId)) throw new Error('Use the original single-segment conversation scope.')
  const root = await canonicalLocalLocation(directory, true), key = localConversationUpgradeKey(root, collaborationId)
  const completed = await storage.get<{ kind: string; directory: string; report: { status: string } }>(localUpgradeResultKey(root))
  if (completed?.kind === 'dss-local-upgrade-result' && completed.directory === root && completed.report.status === 'complete')
    return { status: 'complete', directory: root, collaborationId, converted: 0, issues: [], retainedStages: [] }
  const prior = await storage.get<ConversationUpgrade>(key)
  if (prior && (prior.kind !== 'dss-once-conversation-full-text' || prior.directory !== root || prior.collaborationId !== collaborationId
    || !Array.isArray(prior.files) || !Array.isArray(prior.converted) || !Array.isArray(prior.issues))) throw new Error('The original conversation upgrade record is invalid; it was retained.')
  if (prior?.status === 'complete') return describe(prior)
  const empty: LocalConversationUpgradeReport = { status: 'not-needed', directory: root, collaborationId, converted: 0, issues: [], retainedStages: [] }
  const database = join(root, 'dss-files.sqlite')
  try { await lstat(database) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (prior) return { ...describe(prior), status: 'incomplete', issues: [{ code: 'source-missing', message: 'The original conversation database is unavailable; its pending conversion was retained.' }] }
    return empty
  }
  const indexPath = 'conversation-index/local/' + encodeURIComponent(collaborationId) + '/index.json'
  const contextPath = 'conversation-context/local/' + encodeURIComponent(collaborationId) + '/index.json'
  return withLegacySqliteSnapshot(database, async snapshot => {
    const originals = new Map<string, LegacySqliteFile>()
    const originalAt = async (path: string): Promise<LegacySqliteFile | undefined> => {
      if (originals.has(path)) return originals.get(path)
      const entry = await snapshot.read(path)
      if (entry?.kind === 'issue') throw new Error(entry.issue.message)
      if (entry) originals.set(path, entry)
      return entry
    }
    const originalIndex = await originalAt(indexPath)
    if (!originalIndex) return prior ? { ...describe(prior), status: 'incomplete', issues: [{ code: 'source-row', path: indexPath, message: 'The assigned original index is unavailable; no empty replacement was created.' }] } : empty
    const state: ConversationUpgrade = prior ?? { kind: 'dss-once-conversation-full-text', operationId: randomUUID(), directory: root,
      collaborationId, status: 'converting', files: [], converted: [], issues: [] }
    state.issues = []
    const save = () => storage.set(key, structuredClone(state))
    const files = new PhysicalLocalFiles(root)
    const view = await files.snapshot()
    const publish = async (path: string, bytes: Uint8Array) => {
      const problem = await publishLocalUpgradeBytes(root, { path, bytes }, state, save, options)
      if (problem) state.issues.push(problem)
      return !problem
    }
    await save()
    try {
      // If the user already changed the physical index, do not restore its old
      // ordering or resurrect removed messages. Work only on current references.
      const currentIndex = await files.readBytes(view, indexPath)
      const index = parse(currentIndex ?? originalIndex.bytes)
      if (index.version !== 1 || !Array.isArray(index.messages)) throw new Error('Unsupported original Local conversation index.')
      for (const reference of index.messages) {
        options.signal?.throwIfAborted()
        if (!reference || typeof reference.id !== 'string' || typeof reference.path !== 'string') {
          state.issues.push({ code: 'source-row', path: indexPath, message: 'The original index has an invalid message identity/reference.' }); continue
        }
        let entryPath: string
        try { entryPath = logical(reference.path); if (!entryPath.startsWith('conversations/local/') || !entryPath.endsWith('/entry.json')) throw new Error('Entry is outside its original conversation.') }
        catch (error) { state.issues.push({ code: 'unsafe-target', path: reference.path, message: String(error) }); continue }
        const original = await originalAt(entryPath)
        const present = await files.readBytes(view, entryPath)
        if (!original && !present) { state.issues.push({ code: 'source-row', path: entryPath, message: 'The indexed original entry is absent. It was not replaced with a placeholder.' }); continue }
        try {
          const entry = parse(present ?? original!.bytes)
          if (entry.id !== reference.id || entry.collaborationId !== collaborationId || typeof entry.textPath !== 'string') throw new Error('The entry identity differs from its actual index/scope.')
          const alreadyPhysical = logical(entry.textPath).endsWith('.txt')
          const legacy = original ? parse(original.bytes) : undefined
          const sourceEntry = alreadyPhysical ? legacy : entry
          if (alreadyPhysical && await files.readBytes(view, logical(entry.textPath)) === undefined) throw new Error('The already-converted physical message body is missing.')
          // An independent new physical entry has no SQL original to convert.
          if (!sourceEntry || logical(sourceEntry.textPath).endsWith('.txt')) {
            if (!alreadyPhysical) throw new Error('The original message body reference is unavailable.')
            if (original) await rememberLocalUpgradeMapping(storage, root, original, state.operationId, [entryPath, logical(entry.textPath)], 'physical-original-retained')
            if (!state.converted.includes(entryPath)) state.converted.push(entryPath)
            continue
          }
          const textRoot = logical(sourceEntry.textPath)
          if (!textRoot.startsWith('conversations/local/')) throw new Error('The original text reference is outside this conversation.')
          const manifestSource = await originalAt(textRoot + '/manifest.json')
          if (!manifestSource) throw new Error('The original text manifest is missing.')
          const manifest = parse(manifestSource.bytes)
          if (manifest.version !== 1 || !Array.isArray(manifest.chunks) || !Number.isSafeInteger(manifest.characters) || typeof manifest.sha256 !== 'string') throw new Error('The original text manifest is invalid.')
          const parts: Uint8Array[] = [], chunkSources: LegacySqliteFile[] = []
          for (const value of manifest.chunks) {
            if (typeof value !== 'string') throw new Error('The original chunk reference is invalid.')
            const partPath = logical(value)
            if (!partPath.startsWith(textRoot + '/parts/')) throw new Error('An original chunk points outside its text record.')
            const part = await originalAt(partPath)
            if (!part) throw new Error('The original text chunk is missing: ' + partPath)
            parts.push(part.bytes); chunkSources.push(part)
          }
          const body = Buffer.concat(parts.map(part => Buffer.from(part))), text = decode(body)
          if (text.length !== manifest.characters || hash(body) !== manifest.sha256) throw new Error('Original chunk order/body differs from the manifest hash or character count.')
          const textPath = alreadyPhysical ? logical(entry.textPath) : entryPath.slice(0, -'entry.json'.length) + 'text.txt'
          if (!alreadyPhysical && !await publish(textPath, body)) continue
          if (!present) {
            if (!await publish(entryPath, Buffer.from(JSON.stringify({ ...entry, textPath }, null, 2) + '\n'))) continue
          } else if (!alreadyPhysical) {
            // Real same-file update: preserve all current user metadata and only
            // change the still-matching legacy text reference. No version/hash
            // comparison is imposed on ordinary later physical reads or edits.
            const updated = await files.update(entryPath, current => {
              if (!current) return { value: false }
              const now = parse(current)
              if (now.id !== reference.id || now.collaborationId !== collaborationId) return { value: false }
              if (now.textPath === textPath) return { value: true }
              if (now.textPath !== entry.textPath) return { value: false }
              return { value: true, content: JSON.stringify({ ...now, textPath }, null, 2) + '\n' }
            })
            if (!updated) { state.issues.push({ code: 'target-conflict', path: entryPath, message: 'The message metadata/reference changed during conversion; current metadata was retained.' }); continue }
          }
          // Record exact completed source disposition before unrelated export can
          // see this scope. No subsequent source replay can restore old chunks or
          // reject later user edits/deletions of these physical originals.
          for (const source of [original, manifestSource, ...chunkSources]) if (source)
            await rememberLocalUpgradeMapping(storage, root, source, state.operationId, [entryPath, textPath])
          if (!state.converted.includes(entryPath)) state.converted.push(entryPath)
          await save()
        } catch (error) { options.signal?.throwIfAborted(); state.issues.push({ code: 'source-row', path: entryPath, message: error instanceof Error ? error.message : String(error) }) }
      }
      if (!state.issues.length) {
        // Entry/body targets precede shared context/index. Existing shared files
        // keep their actual user contents; no empty defaults precede restoration.
        const context = await originalAt(contextPath)
        if (context && await files.readBytes(view, contextPath) === undefined) await publish(contextPath, context.bytes)
        if (currentIndex === undefined) await publish(indexPath, originalIndex.bytes)
        if (!state.issues.length) {
          if (context) await rememberLocalUpgradeMapping(storage, root, context, state.operationId, [contextPath], 'physical-original-retained')
          await rememberLocalUpgradeMapping(storage, root, originalIndex, state.operationId, [indexPath], 'physical-original-retained')
        }
      }
      options.signal?.throwIfAborted()
      if (!state.issues.length) state.status = 'complete'
      await save(); return describe(state)
    } finally { await view.release(); await files.close() }
  }, { signal: options.signal })
}

/** Explicit UI inspection. It does not restore a scope or create an empty index. */
export async function legacyConversationNeedsRestoration(directory: string, collaborationId: string, storage: StoragePort, signal?: AbortSignal): Promise<boolean> {
  const root = await canonicalLocalLocation(directory, true)
  const completed = await storage.get<{ kind: string; directory: string; report: { status: string } }>(localUpgradeResultKey(root))
  if (completed?.kind === 'dss-local-upgrade-result' && completed.directory === root && completed.report.status === 'complete') return false
  const state = await storage.get<ConversationUpgrade>(localConversationUpgradeKey(root, collaborationId))
  if (state?.kind === 'dss-once-conversation-full-text' && state.directory === root && state.collaborationId === collaborationId && state.status === 'complete') return false
  try { await lstat(join(root, 'dss-files.sqlite')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  return withLegacySqliteSnapshot(join(root, 'dss-files.sqlite'), async source => {
    const entry = await source.read('conversation-index/local/' + encodeURIComponent(collaborationId) + '/index.json')
    if (entry?.kind === 'issue') throw new Error(entry.issue.message)
    return entry !== undefined
  }, { signal })
}
