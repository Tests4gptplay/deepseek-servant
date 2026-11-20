import { RecordMoveNotStartedError } from './client-error.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FrameworkClientSettings } from './client-contracts.js'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { LocalLocationRegistry, canonicalLocalLocation as canonical } from './local-location.js'
import { localRecordFingerprint, prepareLocalRecordCopy, type LocalRecordBackend } from './maintenance.js'
import type { RecordTreeCopyState } from './record-tree-copy.js'
import { publishPreparedUpgradeFile } from './local-upgrade-publish.js'

export const recordMoveKey = 'framework/record-moves'
export interface RecordMoveRequest {
  sourceRecords: string
  targetRecords: string
  sourceLocal?: string
  localBackend?: LocalRecordBackend
  scope?: string
  settingsBefore: { revision: string; settings: FrameworkClientSettings }
  nextSettingsRevision: string
}
type DirectoryIdentity = { dev: string; ino: string; birthtimeNs: string }
interface RecordDeparture { commandId: string; records: string; local: string; nextLocal: string; scope: string }
interface RetainedLocalTarget { backup: string; original: DirectoryIdentity }
export interface RecordMoveReceipt extends RecordMoveRequest {
  commandId: string
  targetLocal?: string
  localKind: 'owned' | 'custom' | 'none'
  fingerprint?: string
  localCopy?: RecordTreeCopyState
  sourceRetained?: true
  returnFrom?: string
  departures?: RecordDeparture[]
  retainedTargets?: string[]
  retainedLocalTarget?: RetainedLocalTarget
  phase: 'prepared' | 'published' | 'reopening' | 'applied' | 'abandoning' | 'abandoned'
  settingsAfter: { revision: string; settings: FrameworkClientSettings }
}
export interface RecordMovePhysicalStore {
  storageView(): { directory: string }
  moveRecords(target: string, expected: string, signal: AbortSignal, verifyPublished?: (directory: string) => Promise<void>, commandId?: string, retainedTarget?: true): Promise<{ directory: string; retainedTarget?: string }>
  canAbandonRecordMove?(commandId: string, source: string, target: string): Promise<boolean>
  recordMoveRetainedTarget?(commandId: string, destination: string): Promise<string | undefined>
  abandonRecordMove?(commandId: string, source: string, target: string): Promise<void>
}
export interface RecordMoveLifecycle {
  /** Must confirm all affected native producers stopped before resolving. */
  quiesce(receipt: Readonly<RecordMoveReceipt>, signal: AbortSignal): Promise<void>
  /** Compare the retained original revision or recognize the same new revision. */
  applySettings(receipt: Readonly<RecordMoveReceipt>): Promise<void>
  restoreSettings?(receipt: Readonly<RecordMoveReceipt>): Promise<void>
  /** Idempotently reopen the confirmed target, without restarting completed work. */
  reopen(receipt: Readonly<RecordMoveReceipt>, signal: AbortSignal): Promise<void>
}
export class RecordMoveOutcomeUnknownError extends Error {
  constructor(readonly commandId: string, cause: unknown) {
    super('Record move is not confirmed; retain both locations and resume the original command.', { cause })
    this.name = 'RecordMoveOutcomeUnknownError'
  }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function directoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || await canonical(path) !== path)
      throw new Error('Retained Local records are not at their exact original directory: ' + path)
    return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
const equalRequest = (a: RecordMoveRequest, b: RecordMoveRequest) => a.sourceRecords === b.sourceRecords && a.targetRecords === b.targetRecords
  && a.sourceLocal === b.sourceLocal && (a.localBackend ?? 'sqlite') === (b.localBackend ?? 'sqlite') && a.scope === b.scope && isDeepStrictEqual(a.settingsBefore, b.settingsBefore) && a.nextSettingsRevision === b.nextSettingsRevision
/** One current applied move supports the existing UI's uncertain retry. A
 * later applied move replaces it; copy inventories end after this move’s one-shot cleanup. */
function currentReceipts(receipts: RecordMoveReceipt[]): RecordMoveReceipt[] {
  const latest = receipts.filter(receipt => (receipt.phase === 'applied' || receipt.phase === 'abandoned')).at(-1)
  const applied = receipts.filter(receipt => receipt.phase === 'applied').at(-1)
  return receipts.filter(receipt => (receipt.phase !== 'applied' && receipt.phase !== 'abandoned') || receipt === latest || receipt === applied).map(receipt => {
    if (receipt.phase !== 'applied' && receipt.phase !== 'abandoned') return receipt
    const { localCopy: _finishedCopy, ...current } = receipt
    return current
  })
}
function departureHistory(previous: RecordMoveReceipt | undefined): RecordDeparture[] {
  const history = previous?.departures ?? []
  if (!previous?.sourceRetained || previous.localBackend !== 'physical' || !previous.sourceLocal || !previous.targetLocal || !previous.scope) return history
  return [...history.filter(departure => departure.records !== previous.sourceRecords && departure.records !== previous.targetRecords), {
    commandId: previous.commandId, records: previous.sourceRecords, local: previous.sourceLocal, nextLocal: previous.targetLocal, scope: previous.scope,
  }]
}
const queues = new WeakMap<StoragePort, Promise<unknown>>()
const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep) }

/** Coordinates the physical store adapter and explicit Local scope binding.
 * It never rewrites business/session payloads or copies native Host data. The
 * original physical records remain at the old location.
 */
export class FrameworkRecordMove {
  private readonly locations: LocalLocationRegistry
  constructor(private readonly storage: StoragePort, private readonly physical: RecordMovePhysicalStore, private readonly lifecycle: RecordMoveLifecycle) {
    this.locations = new LocalLocationRegistry(storage)
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.storage) ?? Promise.resolve()).catch(() => {}).then(action)
    queues.set(this.storage, result.catch(() => {})); return result
  }
  private async receipts(): Promise<RecordMoveReceipt[]> {
    const value = await this.storage.get<{ version: 1; receipts: RecordMoveReceipt[] }>(recordMoveKey)
    if (value === undefined) return []
    if (value.version !== 1 || !Array.isArray(value.receipts) || value.receipts.some(item => !item.commandId || !['prepared', 'published', 'reopening', 'applied', 'abandoning', 'abandoned'].includes(item.phase)))
      throw new Error('Invalid record move receipts; inspect before reopening storage.')
    return structuredClone(value.receipts)
  }
  private async save(receipts: RecordMoveReceipt[], commandId: string): Promise<void> {
    try { await this.storage.set(recordMoveKey, { version: 1, receipts: structuredClone(currentReceipts(receipts)) }) }
    catch (error) { throw new RecordMoveOutcomeUnknownError(commandId, error) }
  }
  async receipt(commandId: string): Promise<RecordMoveReceipt | undefined> { return currentReceipts(await this.receipts()).find(item => item.commandId === commandId) }
  async pendingReceipt(): Promise<RecordMoveReceipt | undefined> {
    const pending = (await this.receipts()).filter(item => item.phase !== 'applied' && item.phase !== 'abandoned')
    if (pending.length > 1) throw new Error('Multiple unresolved record moves require inspection.')
    return pending[0]
  }
  run(commandId: string, input: RecordMoveRequest, signal: AbortSignal): Promise<RecordMoveReceipt> {
    return this.serial(async () => {
      signal.throwIfAborted()
      const request: RecordMoveRequest = { ...structuredClone(input), sourceRecords: await canonical(input.sourceRecords), targetRecords: await canonical(input.targetRecords),
        ...(input.sourceLocal ? { sourceLocal: await canonical(input.sourceLocal) } : {}) }
      const receipts = await this.receipts(), prior = receipts.find(item => item.commandId === commandId)
      if (prior) {
        if (prior.phase === 'abandoning' || prior.phase === 'abandoned') throw new Error('This move was abandoned; choose a new destination for a new move.')
        if (!equalRequest(prior, request)) throw new Error('Move command was reused with different locations or settings revisions.')
        return this.advance(receipts, prior, signal)
      }
      if (!commandId || !request.settingsBefore?.revision || !request.nextSettingsRevision || request.sourceRecords === request.targetRecords
        || Boolean(request.sourceLocal) !== Boolean(request.scope)) throw new RecordMoveNotStartedError('An explicit record move requires its original settings and Local scope identity.')
      if (receipts.some(item => item.phase !== 'applied' && item.phase !== 'abandoned')) throw new Error('Resolve the existing record move before starting another.')
      if (await canonical(this.physical.storageView().directory) !== request.sourceRecords) throw new RecordMoveNotStartedError('Active record storage changed before preparing the move.')
      const previous = receipts.filter(item => item.phase === 'applied').at(-1)
      this.checkWrongLocalTarget(previous, request)
      const departures = departureHistory(previous)
      const departed = departures.find(item => item.records === request.targetRecords)
      const returning = departed && previous?.targetRecords === request.sourceRecords
        && previous.targetLocal === request.sourceLocal && previous.localBackend === 'physical' && request.localBackend === 'physical'
        && departed.scope === request.scope && request.sourceLocal && request.scope
        && await this.locations.confirmsDeparture(departed.commandId, departed.local, departed.nextLocal,
          previous.commandId, request.sourceLocal, request.scope)
        ? departed : undefined
      const localKind = !request.sourceLocal ? 'none' : request.sourceLocal === join(request.sourceRecords, 'deepseek_servant', 'framework') ? 'owned' : 'custom'
      const targetLocal = localKind === 'none' ? undefined : localKind === 'owned' ? join(request.targetRecords, 'deepseek_servant', 'framework')
        : join(request.targetRecords, 'framework-local-' + createHash('sha256').update(request.scope!).digest('hex'))
      const sourceTree = join(request.sourceRecords, 'deepseek_servant'), targetTree = join(request.targetRecords, 'deepseek_servant')
      if (inside(sourceTree, targetTree) || inside(targetTree, sourceTree)
        || request.sourceLocal && targetLocal && (inside(request.sourceLocal, targetLocal) || inside(targetLocal, request.sourceLocal)))
        throw new RecordMoveNotStartedError('Record move source and destination trees must not overlap.')
      if (request.localBackend === 'physical' && request.sourceLocal && inside(request.sourceLocal, sourceTree))
        throw new RecordMoveNotStartedError('The selected Local record tree also contains the technical record root; separate these locations before moving them.')
      let retainedLocalTarget: RetainedLocalTarget | undefined
      if (targetLocal && await exists(request.localBackend === 'physical' ? targetLocal : join(targetLocal, 'dss-files.sqlite'))) {
        // The retained owned Local tree moves together with its technical tree.
        // A separate custom destination needs its own, exact old-tree backup.
        if (!returning || returning.local !== targetLocal)
          throw new RecordMoveNotStartedError('Move target already has Local records without this prepared command.')
        if (localKind === 'custom') {
          const original = await directoryIdentity(targetLocal)
          if (!original) throw new RecordMoveNotStartedError('The old Local folder changed before preparing the return move.')
          const backup = targetLocal + '.dss-retained-' + createHash('sha256').update(commandId).digest('hex')
          if (await exists(backup)) throw new RecordMoveNotStartedError('The return move backup location is already occupied; nothing was overwritten.')
          retainedLocalTarget = { backup, original }
        }
      }
      const configuredDefault = request.settingsBefore.settings.localDirectory
        && await canonical(request.settingsBefore.settings.localDirectory) === join(request.sourceRecords, 'deepseek_servant', 'framework')
      const localDirectory = targetLocal ?? (configuredDefault ? join(request.targetRecords, 'deepseek_servant', 'framework') : request.settingsBefore.settings.localDirectory)
      const settingsAfter = { revision: request.nextSettingsRevision, settings: { ...request.settingsBefore.settings, localDirectory } }
      const receipt: RecordMoveReceipt = { ...request, commandId, localKind, ...(targetLocal ? { targetLocal } : {}), settingsAfter, phase: 'prepared',
        ...(returning ? { returnFrom: returning.commandId } : {}), ...(retainedLocalTarget ? { retainedLocalTarget } : {}),
        ...(departures.length ? { departures } : {}) }
      receipts.push(receipt); await this.save(receipts, commandId)
      return this.advance(receipts, receipt, signal)
    })
  }
  resumePending(signal: AbortSignal): Promise<RecordMoveReceipt | undefined> {
    return this.serial(async () => {
      const receipts = await this.receipts(), pending = receipts.filter(item => item.phase !== 'applied' && item.phase !== 'abandoned')
      if (pending.length > 1) throw new Error('Multiple unresolved record moves require inspection.')
      if (pending[0]) return pending[0].phase === 'abandoning' ? this.finishAbandon(receipts, pending[0], signal) : this.advance(receipts, pending[0], signal)
      // This existing startup path also retires already completed legacy detail.
      // A failed write is reported for retry; optional housekeeping never
      // becomes an admission condition for ordinary records.
      try {
        const current = currentReceipts(receipts)
        if (!isDeepStrictEqual(current, receipts)) await this.save(current, current[0]!.commandId)
        await this.locations.compactCompleted()
      } catch (error) { console.error('deepseek-servant completed record move maintenance', error) }
      return undefined
    })
  }
  abandon(commandId: string, signal: AbortSignal): Promise<RecordMoveReceipt> {
    return this.serial(async () => {
      const receipts = await this.receipts(), receipt = receipts.find(item => item.commandId === commandId)
      if (!receipt) throw new Error('The original move receipt is unavailable.')
      if (receipt.phase === 'abandoned') return receipt
      if (receipt.phase !== 'prepared' && receipt.phase !== 'abandoning') throw new Error('The target was published; continue the original move instead.')
      if (await canonical(this.physical.storageView().directory) !== receipt.sourceRecords)
        throw new Error('The target may be active; the original location cannot be restored blindly.')
      if (!this.physical.abandonRecordMove) throw new Error('This Host does not expose record move cancellation.')
      if (receipt.phase !== 'abandoning') {
        if (receipt.retainedLocalTarget && await exists(receipt.retainedLocalTarget.backup)
          || this.physical.canAbandonRecordMove && !await this.physical.canAbandonRecordMove(commandId, receipt.sourceRecords, receipt.targetRecords))
          throw new Error('The return move already preserved the previous target. Resume it to keep both generations intact.')
      }
      if (receipt.phase !== 'abandoning') { receipt.phase = 'abandoning'; await this.save(receipts, commandId) }
      return this.finishAbandon(receipts, receipt, signal)
    })
  }
  private async finishAbandon(receipts: RecordMoveReceipt[], receipt: RecordMoveReceipt, signal: AbortSignal): Promise<RecordMoveReceipt> {
    signal.throwIfAborted()
    if (await canonical(this.physical.storageView().directory) !== receipt.sourceRecords || !this.physical.abandonRecordMove)
      throw new Error('Cannot abandon a move whose original location is not active.')
    await this.physical.abandonRecordMove(receipt.commandId, receipt.sourceRecords, receipt.targetRecords)
    await this.locations.abandon(receipt.commandId)
    await this.lifecycle.restoreSettings?.(structuredClone(receipt))
    await this.lifecycle.reopen(structuredClone(receipt), signal)
    receipt.phase = 'abandoned'
    await this.save(receipts, receipt.commandId)
    return receipt
  }
  private checkWrongLocalTarget(previous: RecordMoveReceipt | undefined, request: RecordMoveRequest, prepared = false): void {
    const mistaken = departureHistory(previous).find(item => item.local !== item.records && request.targetRecords === item.local)
    if (previous?.targetRecords === request.sourceRecords && mistaken) {
      const detail = 'Choose the previous records folder, not its former Local data folder: ' + mistaken.records
      if (prepared) throw new Error('Abandon this uncompleted migration first. ' + detail)
      throw new RecordMoveNotStartedError(detail)
    }
  }
  private async preserveRetainedLocalTarget(receipt: RecordMoveReceipt): Promise<void> {
    const retained = receipt.retainedLocalTarget
    if (!retained) return
    const target = receipt.targetLocal!
    const atBackup = await directoryIdentity(retained.backup), atTarget = await directoryIdentity(target)
    if (isDeepStrictEqual(atBackup, retained.original)) {
      if (atTarget && (atTarget.dev !== receipt.localCopy?.owned['']?.dev || atTarget.ino !== receipt.localCopy?.owned['']?.ino))
        throw new Error('The return destination changed after the retained Local backup was published; both locations were preserved.')
      return
    }
    if (atBackup || !isDeepStrictEqual(atTarget, retained.original))
      throw new Error('The retained Local target or backup no longer matches this return move; neither location was replaced.')
    if (await publishPreparedUpgradeFile(target, retained.backup) !== 'published'
      || !isDeepStrictEqual(await directoryIdentity(retained.backup), retained.original))
      throw new Error('The return Local backup was not confirmed; neither location was overwritten.')
  }
  private async advance(receipts: RecordMoveReceipt[], receipt: RecordMoveReceipt, signal: AbortSignal): Promise<RecordMoveReceipt> {
    if (receipt.phase === 'applied') return receipt
    signal.throwIfAborted()
    const actual = await canonical(this.physical.storageView().directory)
    if (actual !== receipt.sourceRecords && actual !== receipt.targetRecords) throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error('Active root is neither retained move location.'))
    const verify = async (directory: string) => {
      if (await canonical(directory) !== receipt.targetRecords) throw new Error('Published record destination differs from the prepared move.')
      if (receipt.targetLocal && (!receipt.fingerprint || await localRecordFingerprint(receipt.targetLocal, receipt.localBackend, signal) !== receipt.fingerprint)) throw new Error('Published Local records differ from the frozen source fingerprint.')
    }
    let verifiedByMove = false
    if (actual === receipt.sourceRecords) {
      if (receipt.phase !== 'prepared') throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error('Published receipt disagrees with active root.'))
      this.checkWrongLocalTarget(receipts.filter(item => item.phase === 'applied').at(-1), receipt, true)
      await this.lifecycle.quiesce(structuredClone(receipt), signal)
      signal.throwIfAborted()
      if (receipt.sourceLocal) {
        const fingerprint = await localRecordFingerprint(receipt.sourceLocal, receipt.localBackend, signal)
        if (receipt.fingerprint && receipt.fingerprint !== fingerprint) throw new Error('Original Local records changed after the move fingerprint was frozen.')
        if (!receipt.fingerprint) { receipt.fingerprint = fingerprint; await this.save(receipts, receipt.commandId) }
        const identity = { source: receipt.sourceLocal, target: receipt.targetLocal!, scope: receipt.scope!, fingerprint }
        await this.locations.prepare(receipt.commandId, identity)
        if (receipt.localKind === 'custom') {
          await this.preserveRetainedLocalTarget(receipt)
          if (receipt.localBackend !== 'physical' && await exists(join(receipt.targetLocal!, 'dss-files.sqlite'))) await verify(receipt.targetRecords)
          else {
            const copy = await prepareLocalRecordCopy(receipt.sourceLocal, receipt.targetLocal!, signal, receipt.localBackend, {
              state: receipt.localCopy, fingerprint, save: async state => { receipt.localCopy = state; await this.save(receipts, receipt.commandId) },
            })
            try {
              if (copy.fingerprint !== fingerprint) throw new Error('Local records changed while preparing their physical copy.')
              await copy.publish()
            } finally { await copy.dispose() }
          }
        }
      }
      await this.physical.moveRecords(receipt.targetRecords, receipt.sourceRecords, signal, async directory => {
        await verify(directory)
        verifiedByMove = true
      }, receipt.commandId, receipt.returnFrom ? true : undefined)
      if (await canonical(this.physical.storageView().directory) !== receipt.targetRecords) throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error('Physical move did not confirm the active target.'))
    }
    if (receipt.returnFrom && !receipt.retainedTargets?.length) {
      const technical = await this.physical.recordMoveRetainedTarget?.(receipt.commandId, receipt.targetRecords)
      const preserved = [technical, receipt.retainedLocalTarget?.backup].filter((path): path is string => !!path)
      if (preserved.length) { receipt.retainedTargets = preserved; await this.save(receipts, receipt.commandId) }
    }
    if (receipt.phase !== 'reopening') {
      // Reuse only this call's completed callback, never a prior move's result.
      if (!verifiedByMove) await verify(receipt.targetRecords)
      if (receipt.sourceLocal) await this.locations.publish(receipt.commandId, { source: receipt.sourceLocal, target: receipt.targetLocal!, scope: receipt.scope!, fingerprint: receipt.fingerprint! })
      if (receipt.phase === 'prepared') { receipt.phase = 'published'; await this.save(receipts, receipt.commandId) }
    } else if (receipt.targetLocal && await this.locations.resolve(receipt.targetLocal) !== receipt.scope) {
      throw new Error('Reopened target no longer owns the published logical scope.')
    }
    await this.lifecycle.applySettings(structuredClone(receipt))
    if (receipt.phase !== 'reopening') {
      // Persist permission for new writers before retiring the exact location
      // operation. Cold continuation then uses its published binding directly.
      receipt.phase = 'reopening'
      await this.save(receipts, receipt.commandId)
    }
    if (receipt.sourceLocal) await this.locations.applied(receipt.commandId)
    await this.lifecycle.reopen(structuredClone(receipt), signal)
    delete receipt.localCopy
    receipt.sourceRetained = true
    receipt.phase = 'applied'; await this.save(receipts, receipt.commandId)
    return receipt
  }
}
