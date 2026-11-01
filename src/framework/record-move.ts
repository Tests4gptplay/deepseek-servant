import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FrameworkClientSettings } from './client-contracts.js'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { LocalLocationRegistry, canonicalLocalLocation as canonical } from './local-location.js'
import { localRecordFingerprint, prepareLocalRecordCopy } from './maintenance.js'

export const recordMoveKey = 'framework/record-moves'
export interface RecordMoveRequest {
  sourceRecords: string
  targetRecords: string
  sourceLocal?: string
  scope?: string
  settingsBefore: { revision: string; settings: FrameworkClientSettings }
  nextSettingsRevision: string
}
export interface RecordMoveReceipt extends RecordMoveRequest {
  commandId: string
  targetLocal?: string
  localKind: 'owned' | 'custom' | 'none'
  fingerprint?: string
  phase: 'prepared' | 'published' | 'reopening' | 'applied'
  settingsAfter: { revision: string; settings: FrameworkClientSettings }
}
export interface RecordMovePhysicalStore {
  storageView(): { directory: string }
  moveRecords(target: string, expected: string, signal: AbortSignal, verifyPublished?: (directory: string) => Promise<void>): Promise<{ directory: string }>
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
  && a.sourceLocal === b.sourceLocal && a.scope === b.scope && isDeepStrictEqual(a.settingsBefore, b.settingsBefore) && a.nextSettingsRevision === b.nextSettingsRevision
const queues = new WeakMap<StoragePort, Promise<unknown>>()

/** Coordinates the physical store adapter and explicit Local scope binding.
 * It never rewrites role/session/operation payloads or copies native Host data.
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
    try { await this.storage.set(recordMoveKey, { version: 1, receipts: structuredClone(receipts) }) }
    catch (error) { throw new RecordMoveOutcomeUnknownError(commandId, error) }
  }
  async receipt(commandId: string): Promise<RecordMoveReceipt | undefined> { return (await this.receipts()).find(item => item.commandId === commandId) }
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
        || Boolean(request.sourceLocal) !== Boolean(request.scope)) throw new Error('An explicit record move requires its original settings and Local scope identity.')
      if (receipts.some(item => item.phase !== 'applied')) throw new Error('Resolve the existing record move before starting another.')
      if (await canonical(this.physical.storageView().directory) !== request.sourceRecords) throw new Error('Active record storage changed before preparing the move.')
      const localKind = !request.sourceLocal ? 'none' : request.sourceLocal === join(request.sourceRecords, 'deepseek_servant', 'framework') ? 'owned' : 'custom'
      const targetLocal = localKind === 'none' ? undefined : localKind === 'owned' ? join(request.targetRecords, 'deepseek_servant', 'framework')
        : join(request.targetRecords, 'framework-local-' + createHash('sha256').update(request.scope!).digest('hex'))
      if (targetLocal && await exists(join(targetLocal, 'dss-files.sqlite'))) throw new Error('Move target already has Local records without this prepared command.')
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
      return pending[0] ? this.advance(receipts, pending[0], signal) : undefined
    })
  }
  private async advance(receipts: RecordMoveReceipt[], receipt: RecordMoveReceipt, signal: AbortSignal): Promise<RecordMoveReceipt> {
    if (receipt.phase === 'applied') return receipt
    signal.throwIfAborted()
    const actual = await canonical(this.physical.storageView().directory)
    if (actual !== receipt.sourceRecords && actual !== receipt.targetRecords) throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error('Active root is neither retained move location.'))
    const verify = async (directory: string) => {
      if (await canonical(directory) !== receipt.targetRecords) throw new Error('Published record destination differs from the prepared move.')
      if (receipt.targetLocal && (!receipt.fingerprint || await localRecordFingerprint(receipt.targetLocal) !== receipt.fingerprint)) throw new Error('Published Local records differ from the frozen source fingerprint.')
    }
    if (actual === receipt.sourceRecords) {
      if (receipt.phase !== 'prepared') throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error('Published receipt disagrees with active root.'))
      await this.lifecycle.quiesce(structuredClone(receipt), signal)
      signal.throwIfAborted()
      if (receipt.sourceLocal) {
        const fingerprint = await localRecordFingerprint(receipt.sourceLocal)
        if (receipt.fingerprint && receipt.fingerprint !== fingerprint) throw new Error('Original Local records changed after the move fingerprint was frozen.')
        if (!receipt.fingerprint) { receipt.fingerprint = fingerprint; await this.save(receipts, receipt.commandId) }
        const identity = { source: receipt.sourceLocal, target: receipt.targetLocal!, scope: receipt.scope!, fingerprint }
        await this.locations.prepare(receipt.commandId, identity)
        if (receipt.localKind === 'custom') {
          if (await exists(join(receipt.targetLocal!, 'dss-files.sqlite'))) await verify(receipt.targetRecords)
          else {
            const copy = await prepareLocalRecordCopy(receipt.sourceLocal, receipt.targetLocal!, signal)
            try {
              if (copy.fingerprint !== fingerprint) throw new Error('Local records changed while preparing their physical copy.')
              await copy.publish()
            } finally { await copy.dispose() }
          }
        }
      }
      await this.physical.moveRecords(receipt.targetRecords, receipt.sourceRecords, signal, verify)
      if (await canonical(this.physical.storageView().directory) !== receipt.targetRecords) throw new RecordMoveOutcomeUnknownError(receipt.commandId, new Error('Physical move did not confirm the active target.'))
    }
    if (receipt.phase !== 'reopening') {
      await verify(receipt.targetRecords)
      if (receipt.sourceLocal) await this.locations.publish(receipt.commandId, { source: receipt.sourceLocal, target: receipt.targetLocal!, scope: receipt.scope!, fingerprint: receipt.fingerprint! })
      if (receipt.phase === 'prepared') { receipt.phase = 'published'; await this.save(receipts, receipt.commandId) }
    } else if (receipt.targetLocal && await this.locations.resolve(receipt.targetLocal) !== receipt.scope) {
      throw new Error('Reopened target no longer owns the published logical scope.')
    }
    await this.lifecycle.applySettings(structuredClone(receipt))
    if (receipt.phase !== 'reopening') {
      if (receipt.sourceLocal) await this.locations.applied(receipt.commandId)
      // Persist permission for new writers before reopening: later replay must
      // not compare their legitimate new records to the original copy digest.
      receipt.phase = 'reopening'; await this.save(receipts, receipt.commandId)
    }
    await this.lifecycle.reopen(structuredClone(receipt), signal)
    receipt.phase = 'applied'; await this.save(receipts, receipt.commandId)
    return receipt
  }
}
