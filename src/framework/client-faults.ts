import { isClientLifecycleCancellation } from '../client/request-lifecycle.js'
import { HistorySelectionChangedError, completeClientFault, clientFaultDelivered, errorMessage, rememberSafetyPresentation, requiresUserAction, safetyPresentation } from './client-error.js'
import type { SafetyPresentation } from './safety-net.js'

export interface ClientFaultInput {
  mode: 'local' | 'git'; storageScope?: string; source: string; target?: string
  message: string; code?: string; occurrence: number; displayOwner?: string
}
/** Delivery of browser-only diagnostic facts. Transport failure keeps the same
 * fact pending until an existing connection event; never retries business I/O. */
export function createClientFaults(send: (input: ClientFaultInput) => Promise<SafetyPresentation | undefined>) {
  let occurrence = 0, displayOwner: string | undefined, disposed = false
  const records = new Map<string, { input: ClientFaultInput; errors: Set<object>; pending: boolean; sending: boolean; presentation?: SafetyPresentation }>()
  const flush = () => {
    if (disposed) return
    for (const [key, record] of records) {
      if (!record.pending || record.sending) continue
      record.sending = true
      void send(record.input).then(presentation => {
        record.pending = false; record.presentation = presentation
        for (const error of record.errors) completeClientFault(error, presentation)
        // Presentation lives weakly with each actual Error object. Successfully
        // delivered diagnostics have no retry responsibility or strong roots.
        record.errors.clear()
        if (records.get(key) === record) records.delete(key)
      }, () => {}).finally(() => { record.sending = false })
    }
  }
  return {
    begin: () => ({ occurrence, displayOwner }),
    observeOccurrence: (value: unknown, owner?: string) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return
      if (owner !== undefined && owner !== displayOwner) { displayOwner = owner; occurrence = value }
      else if (owner === displayOwner && value >= occurrence) occurrence = value
    },
    capture(error: unknown, context: Omit<ClientFaultInput, 'message' | 'code' | 'occurrence' | 'displayOwner'>, started: { occurrence: number; displayOwner?: string } = { occurrence: 0 }): void {
      if (disposed || isClientLifecycleCancellation(error) || error instanceof HistorySelectionChangedError || safetyPresentation(error) || clientFaultDelivered(error) || requiresUserAction(error)) return
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      const input = { ...context, message: errorMessage(error), ...(code ? { code } : {}), ...started }
      const key = JSON.stringify(input)
      let record = records.get(key)
      if (!record) { record = { input, errors: new Set(), pending: true, sending: false }; records.set(key, record) }
      if (error && typeof error === 'object') {
        record.errors.add(error)
        rememberSafetyPresentation(error, record.presentation ?? { faultId: 'client-pending', state: 'repairing' })
      }
      flush()
    },
    flush,
    pending: () => [...records.values()].filter(record => record.pending).map(record => record.input),
    dispose: () => { disposed = true; records.clear() },
  }
}
