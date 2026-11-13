import { RecordMoveNotStartedError } from './client-error.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FrameworkClientSettings } from './client-contracts.js'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { LocalLocationRegistry, canonicalLocalLocation as canonical } from './local-location.js'
import { localRecordFingerprint, prepareLocalRecordCopy, type LocalRecordBackend } from './maintenance.js'
import { retireRecordTreeSource, type RecordTreeCopyState } from './record-tree-copy.js'
import { prepareLocalUpgradeRelocation, projectLocalUpgradeRelocation, applyLocalUpgradeRelocation, type LocalUpgradeRelocation } from './local-upgrade-relocation.js'

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
export interface RecordMoveReceipt extends RecordMoveRequest {
  commandId: string
  targetLocal?: string
  localKind: 'owned' | 'custom' | 'none'
  fingerprint?: string
  localCopy?: RecordTreeCopyState
  upgradeRelocation?: LocalUpgradeRelocation
  upgradeRelocated?: true
  /** Result of this command’s one-shot old-copy cleanup; absent on older receipts. */
  sourceCleanup?: { retained: Array<{ directory: string; reason: string }> }
  phase: 'prepared' | 'published' | 'reopening' | 'applied'
  settingsAfter: { revision: string; settings: FrameworkClientSettings }
}
export interface RecordMovePhysicalStore {
  storageView(): { directory: string }
  moveRecords(target: string, expected: string, signal: AbortSignal, verifyPublished?: (directory: string) => Promise<void>, commandId?: string): Promise<{ directory: string }>
  recordMoveCopy?(commandId: string): RecordTreeCopyState | undefined | Promise<RecordTreeCopyState | undefined>
}
export interface RecordMoveLifecycle {
  /** Must confirm all affected native producers stopped before resolving. */
  quiesce(receipt: Readonly<RecordMoveReceipt>, signal: AbortSignal): Promise<void>
  /** Compare the retained original revision or recognize the same new revision. */
  applySettings(receipt: Readonly<RecordMoveReceipt>): Promise<void>
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
const equalRequest = (a: RecordMoveRequest, b: RecordMoveRequest) => a.sourceRecords === b.sourceRecords && a.targetRecords === b.targetRecords
  && a.sourceLocal === b.sourceLocal && (a.localBackend ?? 'sqlite') === (b.localBackend ?? 'sqlite') && a.scope === b.scope && isDeepStrictEqual(a.settingsBefore, b.settingsBefore) && a.nextSettingsRevision === b.nextSettingsRevision
/** One current applied move supports the existing UI's uncertain retry. A
 * later applied move replaces it; copy inventories end after this move’s one-shot cleanup. */
function currentReceipts(receipts: RecordMoveReceipt[]): RecordMoveReceipt[] {
  const latest = receipts.filter(receipt => receipt.phase === 'applied').at(-1)
  return receipts.filter(receipt => receipt.phase !== 'applied' || receipt === latest).map(receipt => {
    if (receipt.phase !== 'applied') return receipt
    const { localCopy: _finishedCopy, ...current } = receipt
    return current
  })
}
const queues = new WeakMap<StoragePort, Promise<unknown>>()
const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep) }

/** Coordinates the physical store adapter and explicit Local scope binding.
 * It never rewrites business/session payloads or copies native Host data. The
 * exact one-time upgrade's location/inode metadata follows this verified move.
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
    if (value.version !== 1 || !Array.isArray(value.receipts) || value.receipts.some(item => !item.commandId || !['prepared', 'published', 'reopening', 'applied'].includes(item.phase)))
      throw new Error('Invalid record move receipts; inspect before reopening storage.')
    return structuredClone(value.receipts)
  }
  private async save(receipts: RecordMoveReceipt[], commandId: string): Promise<void> {
    try { await this.storage.set(recordMoveKey, { version: 1, receipts: structuredClone(currentReceipts(receipts)) }) }
    catch (error) { throw new RecordMoveOutcomeUnknownError(commandId, error) }
  }
  async receipt(commandId: string): Promise<RecordMoveReceipt | undefined> { return currentReceipts(await this.receipts()).find(item => item.commandId === commandId) }
  async pendingReceipt(): Promise<RecordMoveReceipt | undefined> {
    const pending = (await this.receipts()).filter(item => item.phase !== 'applied')
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
        if (!equalRequest(prior, request)) throw new Error('Move command was reused with different locations or settings revisions.')
        return this.advance(receipts, prior, signal)
      }
      if (!commandId || !request.settingsBefore?.revision || !request.nextSettingsRevision || request.sourceRecords === request.targetRecords
        || Boolean(request.sourceLocal) !== Boolean(request.scope)) throw new RecordMoveNotStartedError('An explicit record move requires its original settings and Local scope identity.')
      if (receipts.some(item => item.phase !== 'applied')) throw new Error('Resolve the existing record move before starting another.')
      if (await canonical(this.physical.storageView().directory) !== request.sourceRecords) throw new RecordMoveNotStartedError('Active record storage changed before preparing the move.')
      const localKind = !request.sourceLocal ? 'none' : request.sourceLocal === join(request.sourceRecords, 'deepseek_servant', 'framework') ? 'owned' : 'custom'
      const targetLocal = localKind === 'none' ? undefined : localKind === 'owned' ? join(request.targetRecords, 'deepseek_servant', 'framework')
        : join(request.targetRecords, 'framework-local-' + createHash('sha256').update(request.scope!).digest('hex'))
      const sourceTree = join(request.sourceRecords, 'deepseek_servant'), targetTree = join(request.targetRecords, 'deepseek_servant')
      if (inside(sourceTree, targetTree) || inside(targetTree, sourceTree)
        || request.sourceLocal && targetLocal && (inside(request.sourceLocal, targetLocal) || inside(targetLocal, request.sourceLocal)))
        throw new RecordMoveNotStartedError('Record move source and destination trees must not overlap.')
      if (request.localBackend === 'physical' && request.sourceLocal && inside(request.sourceLocal, sourceTree))
        throw new RecordMoveNotStartedError('The selected Local record tree also contains the technical record root; separate these locations before moving them.')
      if (targetLocal && await exists(request.localBackend === 'physical' ? targetLocal : join(targetLocal, 'dss-files.sqlite')))
        throw new RecordMoveNotStartedError('Move target already has Local records without this prepared command.')
      const configuredDefault = request.settingsBefore.settings.localDirectory
        && await canonical(request.settingsBefore.settings.localDirectory) === join(request.sourceRecords, 'deepseek_servant', 'framework')
      const localDirectory = targetLocal ?? (configuredDefault ? join(request.targetRecords, 'deepseek_servant', 'framework') : request.settingsBefore.settings.localDirectory)
      const settingsAfter = { revision: request.nextSettingsRevision, settings: { ...request.settingsBefore.settings, localDirectory } }
      const receipt: RecordMoveReceipt = { ...request, commandId, localKind, ...(targetLocal ? { targetLocal } : {}), settingsAfter, phase: 'prepared' }
      receipts.push(receipt); await this.save(receipts, commandId)
      return this.advance(receipts, receipt, signal)
    })
  }
  resumePending(signal: AbortSignal): Promise<RecordMoveReceipt | undefined> {
    return this.serial(async () => {
      const receipts = await this.receipts(), pending = receipts.filter(item => item.phase !== 'applied')
      if (pending.length > 1) throw new Error('Multiple unresolved record moves require inspection.')
      if (pending[0]) return this.advance(receipts, pending[0], signal)
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
      await this.lifecycle.quiesce(structuredClone(receipt), signal)
      signal.throwIfAborted()
      if (receipt.sourceLocal) {
        if (receipt.localBackend === 'physical' && !receipt.upgradeRelocation && !receipt.upgradeRelocated) {
          receipt.upgradeRelocation = await prepareLocalUpgradeRelocation(this.storage, receipt.sourceLocal, receipt.targetLocal!, signal)
          await this.save(receipts, receipt.commandId)
        }
        const fingerprint = await localRecordFingerprint(receipt.sourceLocal, receipt.localBackend, signal)
        if (receipt.fingerprint && receipt.fingerprint !== fingerprint) throw new Error('Original Local records changed after the move fingerprint was frozen.')
        if (!receipt.fingerprint) { receipt.fingerprint = fingerprint; await this.save(receipts, receipt.commandId) }
        const identity = { source: receipt.sourceLocal, target: receipt.targetLocal!, scope: receipt.scope!, fingerprint }
        await this.locations.prepare(receipt.commandId, identity)
        if (receipt.localKind === 'custom') {
          if (receipt.localBackend !== 'physical' && await exists(join(receipt.targetLocal!, 'dss-files.sqlite'))) await verify(receipt.targetRecords)
          else {
            const copy = await prepareLocalRecordCopy(receipt.sourceLocal, receipt.targetLocal!, signal, receipt.localBackend, {
              state: receipt.localCopy, save: async state => { receipt.localCopy = state; await this.save(receipts, receipt.commandId) },
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
      }, receipt.commandId)
      if (await canonical(this.physical.storageView().directory) !== receipt.targetRecords) throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error('Physical move did not confirm the active target.'))
    }
    if (receipt.phase !== 'reopening') {
      // Reuse only this call's completed callback, never a prior move's result.
      if (!verifiedByMove) await verify(receipt.targetRecords)
      if (receipt.sourceLocal) await this.locations.publish(receipt.commandId, { source: receipt.sourceLocal, target: receipt.targetLocal!, scope: receipt.scope!, fingerprint: receipt.fingerprint! })
      if (receipt.phase === 'prepared') { receipt.phase = 'published'; await this.save(receipts, receipt.commandId) }
    } else if (receipt.targetLocal && await this.locations.resolve(receipt.targetLocal) !== receipt.scope) {
      throw new Error('Reopened target no longer owns the published logical scope.')
    }
    if (receipt.phase !== 'reopening' && receipt.sourceLocal && receipt.localBackend === 'physical' && !receipt.upgradeRelocated) {
      // A prior accepted move can have published its physical location before
      // acknowledgement. Its retained original records remain the exact input;
      // this is continuation of that command, never an ordinary-read fallback.
      if (!receipt.upgradeRelocation) {
        receipt.upgradeRelocation = await prepareLocalUpgradeRelocation(this.storage, receipt.sourceLocal, receipt.targetLocal!, signal)
        await this.save(receipts, receipt.commandId)
      }
      const upgrade = receipt.upgradeRelocation
      if (!upgrade.projected) {
        const copy = receipt.localKind === 'custom' ? receipt.localCopy : await this.physical.recordMoveCopy?.(receipt.commandId)
        upgrade.projected = await projectLocalUpgradeRelocation(upgrade, copy, signal)
        await this.save(receipts, receipt.commandId)
      }
      await applyLocalUpgradeRelocation(this.storage, upgrade, signal)
      // No permanent second metadata manifest. The new exact keys now own
      // their existing responsibility; historical source keys are unchanged.
      receipt.upgradeRelocated = true; delete receipt.upgradeRelocation
      await this.save(receipts, receipt.commandId)
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
    // New records are already usable. Cleanup failure is an applied move with
    // a visible residual, not a reason to roll back or hold the new location.
    const retained: Array<{ directory: string; reason: string }> = []
    const copies = [{ source: join(receipt.sourceRecords, 'deepseek_servant'), destination: join(receipt.targetRecords, 'deepseek_servant'),
      copy: () => this.physical.recordMoveCopy?.(receipt.commandId) },
      ...(receipt.localKind === 'custom' ? [{ source: receipt.sourceLocal!, destination: receipt.targetLocal!, copy: () => receipt.localCopy }] : [])]
    for (const { source, destination, copy: readCopy } of copies) {
      try {
        const copy = await readCopy()
        if (!copy || copy.source !== source || copy.destination !== destination) throw new Error('This move has no matching verified copy inventory; source retained.')
        await retireRecordTreeSource(copy)
      } catch (error) {
        retained.push({ directory: source, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    receipt.sourceCleanup = { retained }; delete receipt.localCopy
    receipt.phase = 'applied'; await this.save(receipts, receipt.commandId)
    return receipt
  }
}
