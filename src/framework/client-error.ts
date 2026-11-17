import { isLocalAttachmentError } from './conversation-attachment-reference.js'
import { isClientLifecycleCancellation } from '../client/request-lifecycle.js'
import type { SafetyPresentation } from './safety-net.js'

/** The requested history belongs to a selection the Host no longer owns. */
export class HistorySelectionChangedError extends Error {
  static readonly code = 'dss/history-selection-changed'
}
export function frameworkRpcError(method: string, error: { message: string; code: string; details?: unknown }): Error {
  const failure = method === 'history' && error.code === HistorySelectionChangedError.code
    ? new HistorySelectionChangedError(error.message) : new Error(error.message)
  return Object.assign(failure, { code: error.code, details: error.details })
}

/** A move input was rejected before its command was admitted. */
export class RecordMoveNotStartedError extends Error {
  static readonly code = 'dss/record-move-not-started'
}
export function isRecordMoveNotStarted(error: unknown): boolean {
  return error instanceof RecordMoveNotStartedError || !!error && typeof error === 'object'
    && (error as { code?: string }).code === RecordMoveNotStartedError.code
}

const localPresentations = new WeakMap<object, SafetyPresentation>()
const deliveredClientFaults = new WeakSet<object>()
export function clientFaultDelivered(error: unknown): boolean { return !!error && typeof error === 'object' && deliveredClientFaults.has(error) }
export function completeClientFault(error: object, presentation: SafetyPresentation | undefined): void {
  deliveredClientFaults.add(error)
  if (presentation) localPresentations.set(error, presentation)
  else if (localPresentations.get(error)?.faultId === 'client-pending') localPresentations.delete(error)
}
export function rememberSafetyPresentation(error: object, presentation: SafetyPresentation): void { localPresentations.set(error, presentation) }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
/** Actual native confirmation interactions remain actionable. Ordinary 401,
 * 403 and filesystem permission failures are still runtime faults, not grants
 * or confirmation prompts. No error wording selects this exception. */
export function requiresUserAction(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { interaction?: { kind?: string; requiresConfirmation?: boolean }; details?: { interaction?: { kind?: string; requiresConfirmation?: boolean } } }
  const interaction = value.interaction ?? value.details?.interaction
  return interaction?.requiresConfirmation === true && (interaction.kind === 'authorization' || interaction.kind === 'authentication')
}
export function safetyPresentation(error: unknown): SafetyPresentation | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { safetyNet?: SafetyPresentation; details?: { safetyNet?: SafetyPresentation } }
  const presentation = localPresentations.get(error) ?? value.safetyNet ?? value.details?.safetyNet
  return presentation
}
let reportLocal: ((error: unknown) => void) | undefined
export function installClientErrorReporter(report: (error: unknown) => void): () => void {
  reportLocal = report
  return () => { if (reportLocal === report) reportLocal = undefined }
}
/** All user-visible exception text crosses this boundary. Rejection and draft
 * ownership remain with the original caller; this function cannot report success. */
export function frameworkErrorText(error: unknown): string {
  if (isClientLifecycleCancellation(error) || error instanceof HistorySelectionChangedError) return ''
  if (isLocalAttachmentError(error) || requiresUserAction(error)) return errorMessage(error)
  const presentation = safetyPresentation(error)
  if (!presentation && !clientFaultDelivered(error)) reportLocal?.(error)
  return ''
}
