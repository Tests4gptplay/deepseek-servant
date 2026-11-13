import { createHash, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { FrameworkConversation, scopedLocalForegroundSourceNotification } from './conversation.js'
import { FrameworkTransactions } from './command-transactions.js'
import type { FilesStore } from './transactions.js'
import { appendConversationContext, emptyConversationContext, parseConversationContext, type ConversationContextIndex } from './conversation-context.js'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { localRecordPath } from './local-record-files.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { parseForegroundTaskSignal } from './task-files.js'
import { withLegacySqliteSnapshot, type LegacySqliteFile } from './legacy-sqlite-reader.js'
import { inspectLocalUpgradeMapping, rememberLocalUpgradeMapping, localUpgradeResultKey } from './local-upgrade-mapping.js'
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
  /** This source index has actually joined the physical timeline. Later user
   * removals must not be restored when an unrelated source row is still pending. */
  indexRestored?: true
  originalsRestored?: true
  issues: LocalUpgradeIssue[]
  /** One addressed, active-Host review of old chat notices. A deferred
   * different-scope call does not mark this complete. */
  signalsAssessed?: { version: 1; pending: Array<{ path: string; reason: string }> }
}
export const localConversationUpgradeKey = (directory: string, collaborationId: string): string =>
  'framework-upgrade-conversation/' + hash(directory + '\0' + collaborationId)
const describe = (state: ConversationUpgrade): LocalConversationUpgradeReport => ({
  status: state.status === 'complete' ? 'complete' : 'incomplete', directory: state.directory, collaborationId: state.collaborationId,
  converted: state.converted.length, issues: state.issues, retainedStages: state.retainedStages ?? [],
})

/** The actual Local source owner, called by service and runtime conversation
 * handles. No normal record hash check or all-Host readiness dependency exists. */
export async function prepareLocalConversation(files: FilesStore, collaborationId: string, storage: StoragePort): Promise<void> {
  if (!(files instanceof PhysicalLocalFiles)) return
  const result = await restoreLegacyConversationScope(files.directory, collaborationId, storage)
  if (result.status === 'incomplete') throw new Error('This conversation conversion is incomplete: '
    + result.issues.map(issue => (issue.path ? issue.path + ': ' : '') + issue.message).join('; ')
    + ' Original SQL and current physical content are retained.')
}

/** Restores ONE addressed conversation before any of its reads or writes.
 * Join the existing shared index boundary, including a previously accepted
 * physical send. The mechanical converter uses an unhooked handle deliberately:
 * it never recursively waits on the normal handle's preparation promise. */
export async function restoreLegacyConversationScope(directory: string, collaborationId: string, storage: StoragePort,
  options: LocalStartupUpgradeOptions = {}): Promise<LocalConversationUpgradeReport> {
  options.signal?.throwIfAborted()
  if (!collaborationId || /[\\/\0\r\n]/.test(collaborationId)) throw new Error('Use the original single-segment conversation scope.')
  const root = await canonicalLocalLocation(directory, true), files = new PhysicalLocalFiles(root)
  const conversation = new FrameworkConversation(files, new FrameworkTransactions(files, storage),
    { mode: 'local', collaborationId })
  try { return await conversation.withPhysicalPublication(() => restoreConversationOriginals(root, collaborationId, storage, files, options)) }
  finally { await files.close() }
}

type ConversationSignalsResult = { published: number; alreadyPresent: number; pending: Array<{ path: string; reason: string }> }
const runningConversationSignals = new WeakMap<StoragePort, Map<string, Promise<ConversationSignalsResult>>>()
/** An addressed one-time tool action after original conversation restoration.
 * Coordinate only concurrent copies of this upgrade action, never ordinary
 * conversation sends or their index lane. */
export async function restoreLegacyConversationSignals(directory: string, collaborationId: string, storage: StoragePort,
  currentScope: () => string | undefined, signal?: AbortSignal, recheckPending = false): Promise<ConversationSignalsResult> {
  signal?.throwIfAborted()
  const root = await canonicalLocalLocation(directory, true), key = root + '\0' + collaborationId
  let running = runningConversationSignals.get(storage)
  if (!running) runningConversationSignals.set(storage, running = new Map())
  const prior = running.get(key)
  if (prior) return prior
  const work = restoreLegacyConversationSignalsOwned(root, collaborationId, storage, currentScope, signal, recheckPending)
  running.set(key, work)
  try { return await work }
  finally { if (running.get(key) === work) running.delete(key) }
}
async function restoreLegacyConversationSignalsOwned(root: string, collaborationId: string, storage: StoragePort,
  currentScope: () => string | undefined, signal?: AbortSignal, recheckPending = false): Promise<ConversationSignalsResult> {
  const key = localConversationUpgradeKey(root, collaborationId)
  if (currentScope() !== collaborationId) return { published: 0, alreadyPresent: 0,
    pending: [{ path: key, reason: 'This original chat is not the currently bound Local conversation; its global signal was retained.' }] }
  const state = await storage.get<ConversationUpgrade>(key)
  if (state?.kind !== 'dss-once-conversation-full-text' || state.directory !== root || state.collaborationId !== collaborationId
    || state.status !== 'complete' || !state.originalsRestored || !state.indexRestored || !Array.isArray(state.files))
    return { published: 0, alreadyPresent: 0, pending: [{ path: key, reason: 'Restore the exact original conversation and its index before its old notification.' }] }
  if (state.signalsAssessed?.version === 1 && (!recheckPending || !state.signalsAssessed.pending.length))
    return { published: 0, alreadyPresent: 0, pending: state.signalsAssessed.pending }
  const pending: Array<{ path: string; reason: string }> = []
  let published = 0, alreadyPresent = 0
  let bindingChanged = false
  const save = () => storage.set(key, structuredClone(state))
  await withLegacySqliteSnapshot(join(root, 'dss-files.sqlite'), async source => {
    const candidates = new Map<number, Array<{ scope: string; id: string; path: string; createdAt: string }>>()
    let uncertainIndex = false
    for await (const row of source.entries('conversation-index/local/')) {
      const match = row.kind === 'file' || row.issue.path ? /^conversation-index\/local\/([^/]+)\/index\.json$/.exec(row.kind === 'file' ? row.path : row.issue.path!) : undefined
      if (row.kind === 'issue') { if (match || !row.issue.path) uncertainIndex = true; continue }
      if (!match) continue
      try {
        const scope = decodeURIComponent(match[1]!), index = parse(row.bytes)
        if (!scope || index.version !== 1 || !Array.isArray(index.messages)) { uncertainIndex = true; continue }
        for (const ref of index.messages) {
          if (!ref || typeof ref.id !== 'string' || typeof ref.path !== 'string' || typeof ref.createdAt !== 'string' || typeof ref.role !== 'string') { uncertainIndex = true; continue }
          if (ref.role !== 'user') continue
          const date = Date.parse(ref.createdAt)
          if (!Number.isFinite(date)) { uncertainIndex = true; continue }
          const group = candidates.get(date) ?? []
          group.push({ scope, id: ref.id, path: ref.path, createdAt: ref.createdAt }); candidates.set(date, group)
        }
      } catch { uncertainIndex = true }
    }
    for await (const row of source.entries('state/')) {
      signal?.throwIfAborted()
      if (row.kind === 'issue') {
        if (row.issue.path && !parseForegroundTaskSignal(row.issue.path) && originalConversationSignalStamp(row.issue.path))
          pending.push({ path: row.issue.path, reason: row.issue.message })
        continue
      }
      if (!row.path.startsWith('state/Foreground_')) continue
      if (parseForegroundTaskSignal(row.path)) continue // Exact Task UUID notifications retain their Task owner.
      const stamp = originalConversationSignalStamp(row.path)
      if (!stamp) continue // Task, Helper, Legacy, or unknown Foreground notices have other owners.
      if (currentScope() !== collaborationId) {
        bindingChanged = true
        pending.push({ path: row.path, reason: 'The currently bound Local conversation changed; no old signal was published.' }); continue
      }
      const matches = (candidates.get(stamp.utc) ?? []).filter(ref => !stamp.suffix || stamp.suffix === hash('local\0' + ref.scope + '\0' + ref.id))
      const owners = new Set<string>()
      let uncertainEntry = uncertainIndex
      for (const ref of matches) try {
        const entryPath = logical(ref.path)
        if (!entryPath.startsWith('conversations/local/') || !entryPath.endsWith('/entry.json')) { uncertainEntry = true; continue }
        const original = await source.read(entryPath)
        if (original?.kind !== 'file') { uncertainEntry = true; continue }
        const entry = parse(original.bytes)
        if (entry.id !== ref.id || entry.collaborationId !== ref.scope || entry.createdAt !== ref.createdAt || entry.role !== 'user') { uncertainEntry = true; continue }
        if (entry.recipient === 'ai') owners.add(ref.scope)
      } catch { uncertainEntry = true }
      if (owners.size === 1 && !owners.has(collaborationId) && !uncertainEntry) continue // Another exact scope owns this source.
      if (row.bytes.byteLength !== 0 || uncertainEntry || owners.size !== 1) {
        const reason = row.bytes.byteLength !== 0 ? 'The old chat signal is no longer empty; its changed bytes were retained.'
          : uncertainEntry ? 'An original conversation index or message needed for exact signal ownership could not be verified; the old signal was retained.'
          : owners.size > 1 ? 'More than one original Local conversation has a user-to-AI message matching this signal time; the old signal does not name its conversation, so its scope cannot be chosen.'
          : 'No original user-to-AI conversation uniquely owns this old signal; it was retained.'
        pending.push({ path: row.path, reason }); continue
      }
      const mapping = await inspectLocalUpgradeMapping(storage, root, row)
      if (mapping === 'mapped') continue
      if (mapping === 'source-changed') { pending.push({ path: row.path, reason: 'The old signal changed after its prior conversion.' }); continue }
      const targetPath = scopedLocalForegroundSourceNotification(row.path, collaborationId)
      const target = { path: targetPath, bytes: row.bytes }
      const issue = await publishLocalUpgradeBytes(root, target, state, save, { signal, publishedSignal: true,
        onProgress: () => { if (currentScope() !== collaborationId) throw new Error('The bound Local conversation changed during old signal publication.') } })
      if (issue) { if (currentScope() !== collaborationId) bindingChanged = true; pending.push({ path: row.path, reason: issue.message }); continue }
      const publication = state.files.find(file => file.path === targetPath)
      if (publication?.status === 'published') published++
      else if (publication?.status === 'already-present') alreadyPresent++
      await rememberLocalUpgradeMapping(storage, root, row, state.operationId, [targetPath])
    }
  }, { signal })
  if (!bindingChanged && currentScope() === collaborationId) {
    state.signalsAssessed = { version: 1, pending }
    await save()
  }
  return { published, alreadyPresent, pending }
}

function originalConversationSignalStamp(path: string): { utc: number; suffix?: string } | undefined {
  const match = /^state\/Foreground_[^/]+-GMT(-?)(\d+)(?:m(\d{2}))?-(\d{8})-(\d{9})(?:-([0-9a-f]{64}))?$/.exec(path)
  if (!match) return
  const [, sign, hours, minutes, day, clock, suffix] = match
  const offset = (sign ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? 0))
  const local = Date.UTC(Number(day!.slice(0, 4)), Number(day!.slice(4, 6)) - 1, Number(day!.slice(6, 8)),
    Number(clock!.slice(0, 2)), Number(clock!.slice(2, 4)), Number(clock!.slice(4, 6)), Number(clock!.slice(6, 9)))
  if (!Number.isFinite(local) || new Date(local).toISOString().replace(/[-:.TZ]/g, '').slice(0, 17) !== day + clock || Number(minutes ?? 0) >= 60) return
  return { utc: local - offset * 60_000, ...(suffix ? { suffix } : {}) }
}

function mergeOriginalIndex(original: Record<string, any>, current: Record<string, any> | undefined, restore: boolean): Record<string, any> {
  for (const index of [original, current]) if (index && (index.version !== 1 || !Array.isArray(index.messages)
    || index.messages.some((row: any) => !row || typeof row.id !== 'string' || typeof row.path !== 'string')
    || new Set(index.messages.map((row: any) => row.id)).size !== index.messages.length))
    throw new Error('Unsupported original/current Local conversation index.')
  if (!current) return restore ? structuredClone(original) : { version: 1, messages: [] }
  if (!restore) return structuredClone(current)
  const positions = new Map<string, number>(current.messages.map((row: any, index: number) => [row.id, index]))
  const following: Array<number | undefined> = new Array(original.messages.length)
  let next: number | undefined
  for (let i = original.messages.length - 1; i >= 0; i--) {
    following[i] = next
    const at = positions.get(original.messages[i].id)
    if (at !== undefined) next = at
  }
  const insertions = new Map<number, any[]>()
  let previous: number | undefined
  for (let i = 0; i < original.messages.length; i++) {
    const row = original.messages[i], at = positions.get(row.id)
    if (at !== undefined) {
      if (logical(current.messages[at].path) !== logical(row.path)) throw new Error('Original/current message identity refers to different entries: ' + row.id)
      previous = at; continue
    }
    // Original neighbors select insertion positions in one pass. A long mixed
    // timeline must not repeatedly search its whole original/current history.
    const position = following[i] ?? (previous === undefined ? 0 : previous + 1)
    const rows = insertions.get(position) ?? []
    rows.push(row); insertions.set(position, rows)
  }
  const messages: any[] = []
  for (let i = 0; i <= current.messages.length; i++) {
    for (const row of insertions.get(i) ?? []) messages.push(row)
    if (i < current.messages.length) messages.push(current.messages[i])
  }
  const currentGroups = new Set((current.processGroups ?? []).map((group: any) => group.id))
  const groups = [...(original.processGroups ?? []).filter((group: any) => !currentGroups.has(group.id)), ...current.processGroups ?? []]
  return { ...original, ...current, messages, ...(groups.length ? { processGroups: groups } : {}) }
}

async function restoreConversationOriginals(directory: string, collaborationId: string, storage: StoragePort, files: PhysicalLocalFiles,
  options: LocalStartupUpgradeOptions): Promise<LocalConversationUpgradeReport> {
  options.signal?.throwIfAborted()
  if (!collaborationId || /[\\/\0\r\n]/.test(collaborationId)) throw new Error('Use the original single-segment conversation scope.')
  const root = await canonicalLocalLocation(directory, true), key = localConversationUpgradeKey(root, collaborationId)
  const completed = await storage.get<{ kind: string; directory: string; report: { status: string } }>(localUpgradeResultKey(root))
  if (completed?.kind === 'dss-local-upgrade-result' && completed.directory === root && completed.report.status === 'complete')
    return { status: 'complete', directory: root, collaborationId, converted: 0, issues: [], retainedStages: [] }
  const prior = await storage.get<ConversationUpgrade>(key)
  if (prior && (prior.kind !== 'dss-once-conversation-full-text' || prior.directory !== root || prior.collaborationId !== collaborationId
    || !Array.isArray(prior.files) || !Array.isArray(prior.converted) || !Array.isArray(prior.issues))) throw new Error('The original conversation upgrade record is invalid; it was retained.')
  if (prior?.status === 'complete' && prior.originalsRestored) return describe(prior)
  const empty: LocalConversationUpgradeReport = { status: 'not-needed', directory: root, collaborationId, converted: 0, issues: [], retainedStages: [] }
  const database = join(root, 'dss-files.sqlite')
  try { await lstat(database) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (prior) return { ...describe(prior), status: 'incomplete', issues: [{ code: 'source-missing', message: 'The original conversation database is unavailable; its pending conversion was retained.' }] }
    return empty
  }
  const indexPath = 'conversation-index/local/' + encodeURIComponent(collaborationId) + '/index.json'
  const contextPath = 'conversation-context/local/' + encodeURIComponent(collaborationId) + '/index.json'
  const memoryRoot = 'assistants/collaborations/local/' + encodeURIComponent(collaborationId)
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
    const memories = await Promise.all(['Foreground_List.md', 'Foreground_Cache.md'].map(name => originalAt(memoryRoot + '/' + name)))
    if (!originalIndex && memories.every(row => !row)) return prior ? { ...describe(prior), status: 'incomplete', issues: [{ code: 'source-row', path: indexPath, message: 'The assigned conversation originals are unavailable; no empty replacement was created.' }] } : empty
    const state: ConversationUpgrade = prior ?? { kind: 'dss-once-conversation-full-text', operationId: randomUUID(), directory: root,
      collaborationId, status: 'converting', files: [], converted: [], issues: [] }
    state.issues = []; state.status = 'converting'
    const save = () => storage.set(key, structuredClone(state))
    const view = await files.snapshot()
    const publish = async (path: string, bytes: Uint8Array) => {
      const problem = await publishLocalUpgradeBytes(root, { path, bytes }, state, save, options)
      if (problem) state.issues.push(problem)
      return !problem
    }
    await save()
    try {
      const currentIndex = await files.readBytes(view, indexPath)
      const original = originalIndex ? parse(originalIndex.bytes) : { version: 1, messages: [] }
      const current = currentIndex ? parse(currentIndex) : undefined
      const index = mergeOriginalIndex(original, current, !state.indexRestored)
      const currentIds = new Set(current?.messages.map((row: any) => row.id))
      const missingOriginals = original.messages.some((row: any) => !currentIds.has(row.id))
      const entries = new Map<string, Record<string, any>>()
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
          entries.set(reference.id, entry)
          const alreadyPhysical = logical(entry.textPath).endsWith('.txt')
          const legacy = original ? parse(original.bytes) : undefined
          const sourceEntry = alreadyPhysical ? legacy : entry
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
        // Long-lived memory is part of this addressed conversation, not a blank
        // default. An existing physical document is authoritative and untouched.
        for (const memory of memories) if (memory) {
          if (await files.readBytes(view, memory.path) === undefined && !await publish(memory.path, memory.bytes)) continue
          await rememberLocalUpgradeMapping(storage, root, memory, state.operationId, [memory.path], 'physical-original-retained')
        }
        const context = await originalAt(contextPath), currentContext = await files.readBytes(view, contextPath)
        if (!state.indexRestored && originalIndex) {
          if (currentIndex === undefined) {
            if (context && currentContext === undefined) await publish(contextPath, context.bytes)
          } else if (missingOriginals && (context || currentContext)) {
            // An early physical send may have started a second context at zero.
            // Rejoin only explicitly classified publications in timeline order;
            // do not infer a final/acknowledgment from replyTo or old plain text.
            const old = context && parseConversationContext(decode(context.bytes)), now = currentContext && parseConversationContext(decode(currentContext))
            const classified = new Map<string, string>()
            for (const value of [old, now]) if (value) for (const ref of [...value.recent.flatMap(round => round.messages), ...value.current]) classified.set(ref.id, ref.kind)
            let joined: ConversationContextIndex = emptyConversationContext()
            for (const reference of index.messages) {
              const entry = entries.get(reference.id)
              if (!entry) continue
              const kind = classified.get(entry.id) ?? (entry.conversationContext?.version === 1
                ? entry.role === 'user' && entry.recipient === 'ai' ? 'input' : entry.responsePhase : undefined)
              if (!kind) continue
              joined = appendConversationContext(joined, { id: entry.id, role: kind === 'input' ? 'user' : 'assistant',
                ...(kind === 'input' ? { recipient: 'ai' } : { responsePhase: kind as 'interim' | 'final' }) }, logical(reference.path)).index
            }
            await files.replace(contextPath, JSON.stringify({ ...now, ...joined }, null, 2) + '\n')
          }
          if (!state.issues.length) {
            if (currentIndex === undefined) await publish(indexPath, originalIndex.bytes)
            else await files.update(indexPath, bytes => {
              const merged = mergeOriginalIndex(original, bytes ? parse(bytes) : undefined, true)
              return { value: undefined, content: JSON.stringify(merged, null, 2) + '\n' }
            })
            if (!state.issues.length) { state.indexRestored = true; await save() }
          }
        }
        if (!state.issues.length) {
          if (context && originalIndex) await rememberLocalUpgradeMapping(storage, root, context, state.operationId, [contextPath], 'physical-original-retained')
          if (originalIndex) await rememberLocalUpgradeMapping(storage, root, originalIndex, state.operationId, [indexPath], 'physical-original-retained')
        }
      }
      options.signal?.throwIfAborted()
      if (!state.issues.length) { state.status = 'complete'; state.originalsRestored = true }
      await save(); return describe(state)
    } finally { await view.release() }
  }, { signal: options.signal })
}

/** Explicit UI inspection. It does not restore a scope or create an empty index. */
export async function legacyConversationNeedsRestoration(directory: string, collaborationId: string, storage: StoragePort, signal?: AbortSignal): Promise<boolean> {
  const root = await canonicalLocalLocation(directory, true)
  const completed = await storage.get<{ kind: string; directory: string; report: { status: string } }>(localUpgradeResultKey(root))
  if (completed?.kind === 'dss-local-upgrade-result' && completed.directory === root && completed.report.status === 'complete') return false
  const state = await storage.get<ConversationUpgrade>(localConversationUpgradeKey(root, collaborationId))
  if (state?.kind === 'dss-once-conversation-full-text' && state.directory === root && state.collaborationId === collaborationId && state.status === 'complete' && state.originalsRestored) return false
  try { await lstat(join(root, 'dss-files.sqlite')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  return withLegacySqliteSnapshot(join(root, 'dss-files.sqlite'), async source => {
    const entry = await source.read('conversation-index/local/' + encodeURIComponent(collaborationId) + '/index.json')
    if (entry?.kind === 'issue') throw new Error(entry.issue.message)
    return entry !== undefined
  }, { signal })
}
