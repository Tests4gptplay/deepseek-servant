import { createHash } from 'node:crypto'
import type { AssistantInputEvidence } from '../contracts/assistant.js'

export interface NativeRecoveryDelivery<Request> {
  request: Request
  messageId: string
  text?: string
  confirmed: boolean
}
export interface NativeRecoveryInput<Request> {
  request: Request
  /** Native admission is not the same fact as model consumption. */
  state: AssistantInputEvidence['state'] | 'unadmitted' | 'unknown'
  active: boolean
  messageId?: string
  text?: string
  source?: string
}

/** Resolve the saved delivery responsibility before choosing a recovery Task.
 * A prior confirmed request must not replace a newer uncertain delivery. This
 * function describes native evidence only; it does not start or cancel a turn. */
export function resolveNativeRecoveryInput<Request>(
  delivery: NativeRecoveryDelivery<Request> | undefined,
  lastRequest: Request | undefined,
  inputs: ReadonlyMap<string, AssistantInputEvidence>,
): NativeRecoveryInput<Request> | undefined {
  if (!delivery) return lastRequest === undefined ? undefined
    : { request: lastRequest, state: 'unknown', active: false }
  const evidence = inputs.get(delivery.messageId)
  if (evidence && delivery.text !== undefined && evidence.text !== delivery.text) {
    throw new Error('Saved native delivery body differs from its original input identity.')
  }
  return {
    request: delivery.request,
    state: evidence?.state ?? (delivery.confirmed ? 'unknown' : 'unadmitted'),
    active: evidence?.active === true,
    messageId: delivery.messageId,
    ...(evidence?.text !== undefined || delivery.text !== undefined ? { text: evidence?.text ?? delivery.text } : {}),
    ...(evidence ? { source: evidence.source } : {}),
  }
}

/** A pending explanation keeps its identity across retries and Host restarts.
 * Only a newly interrupted native turn after consumption creates another one. */
export function nativeRecoveryWakeId(sessionId: string, turn: number | undefined, originalIdentity: string,
  pendingExplanation?: { id: string; state: NativeRecoveryInput<unknown>['state'] }): string {
  if (pendingExplanation && pendingExplanation.state !== 'consumed') return pendingExplanation.id
  return 'native-continuation:' + createHash('sha256').update(JSON.stringify([sessionId, turn ?? null, originalIdentity])).digest('hex')
}
