import { PhysicalLocalFiles } from './physical-local-files.js'
import { randomUUID } from 'node:crypto'
import { foregroundGuidePath } from './foreground-prompt.js'
import { foregroundFullGuide } from './role-prompts.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { GitFiles, withSnapshot, type FilesStore } from './transactions.js'
import { foregroundGuideUpgradeVersion, upgradeForegroundGuide, type ForegroundGuideUpgrade } from './foreground-guide-upgrade.js'

export type RoleGuideInitialization = Omit<ForegroundGuideUpgrade, 'text'> & { status: 'created' | 'migrated' | 'unchanged' }
const inspect = (bytes: Uint8Array | undefined): ForegroundGuideUpgrade => {
  if (bytes === undefined) return { text: foregroundFullGuide(), changedRules: 0, unreviewedSections: [] }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return { text: '', changedRules: 0, unreviewedSections: ['non-UTF-8 guide (original bytes preserved)'] } }
  return upgradeForegroundGuide(text)
}

/** Explicit connection initialization and continuation of that acquisition. Read-only access and conversation reads never generate it.
 * Existing custom content is preserved. Only precisely recognized obsolete
 * template rules migrate in place. A conflict rechecks the current bytes and
 * repeats recognition; UNKNOWN resolves the original operation before any new write.
 */
export function createRoleGuideInitialization(files: FilesStore, transactions: FrameworkTransactions,
  options: { missingOnly?: boolean } = {}): (signal?: AbortSignal) => Promise<RoleGuideInitialization> {
  const acquisitionId = randomUUID()
  let attempted = false
  let result: RoleGuideInitialization = { status: 'unchanged', changedRules: 0, unreviewedSections: [] }
  return async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const inspectCurrent = (bytes: Uint8Array | undefined) => options.missingOnly && bytes !== undefined
      ? { text: '', changedRules: 0, unreviewedSections: [] } : inspect(bytes)
    if (files instanceof PhysicalLocalFiles) return files.update(foregroundGuidePath, bytes => {
      signal?.throwIfAborted()
      const next = inspectCurrent(bytes)
      const value: RoleGuideInitialization = { status: bytes === undefined ? 'created' : next.changedRules ? 'migrated' : 'unchanged',
        changedRules: next.changedRules, unreviewedSections: next.unreviewedSections }
      return { value, ...(bytes === undefined || next.changedRules ? { content: next.text } : {}) }
    })
    if (!attempted) {
      const initial = await withSnapshot(files, async snapshot => {
        const bytes = await files.readBytes(snapshot, foregroundGuidePath)
        return { missing: bytes === undefined, ...inspectCurrent(bytes) }
      }, { files: [foregroundGuidePath], signal })
      result = { status: initial.missing ? 'created' : initial.changedRules ? 'migrated' : 'unchanged',
        changedRules: initial.changedRules, unreviewedSections: initial.unreviewedSections }
      if (!initial.missing && !initial.changedRules) return result
    }
    signal?.throwIfAborted()
    // Re-enter this accepted command before observing newer bytes. A visible
    // file alone cannot acknowledge its original UNKNOWN transport outcome.
    attempted = true
    const receipt = await transactions.run('initialize-role-guide:Foreground:' + foregroundGuideUpgradeVersion + ':' + acquisitionId,
      { kind: 'initialize-role-guide', path: foregroundGuidePath, upgrade: foregroundGuideUpgradeVersion },
      { reevaluate: true, gitReplay: 'session-only', gitEmptyResult: 'observation-only', readPlan: { files: [foregroundGuidePath], signal } }, async snapshot => {
        signal?.throwIfAborted()
        const bytes = await files.readBytes(snapshot, foregroundGuidePath), next = inspectCurrent(bytes)
        result = { status: bytes === undefined ? 'created' : next.changedRules ? 'migrated' : 'unchanged',
          changedRules: next.changedRules, unreviewedSections: next.unreviewedSections }
        return bytes === undefined || next.changedRules ? [{ path: foregroundGuidePath, content: next.text }] : []
      })
    // Release only a confirmed actual transport operation. A no-write observation
    // has no operationId and does not claim a commit. UNKNOWN keeps its original
    // operation identity for this connection-owned continuation.
    if (files instanceof GitFiles && receipt.operationId) await files.operations.delete?.(receipt.operationId)
    return result
  }
}

/** A new explicit acquisition, distinct from continuation of an accepted one. */
export function initializeRoleGuides(files: FilesStore, transactions: FrameworkTransactions, signal?: AbortSignal,
  options: { missingOnly?: boolean } = {}): Promise<RoleGuideInitialization> {
  return createRoleGuideInitialization(files, transactions, options)(signal)
}
