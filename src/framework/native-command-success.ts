import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

/** One existing inspection's already-persisted events, never a live cleanup queue. */
export class NativeCommandSuccess {
  private readonly calls = new Map<number, Extract<SessionEvent, { type: 'tool/call' }>>()
  private readonly ptc = new Map<string, Extract<SessionEvent, { type: 'tool/ptc-dispatch-start' }>>()
  private readonly successful = new Set<string>()
  constructor(private readonly names: ReadonlySet<string>) {}
  readonly accept = (event: SessionEvent): void => {
    if (event.type === 'tool/call' && this.names.has(event.data.name)) this.calls.set(event.seq, event)
    if (event.type === 'tool/result' && event.surfaceOp === 'append' && !event.data.message.isError) {
      const call = event.sourceEventSeqs?.map(seq => this.calls.get(seq)).find(call => call
        && call.data.callId === event.data.message.toolCallId && call.data.turn === event.data.turn && call.data.step === event.data.step)
      if (call) this.successful.add(String(call.data.callId))
    }
    if (event.type === 'tool/ptc-dispatch-start' && this.names.has(event.data.name)) this.ptc.set(String(event.data.subCallId), event)
    if (event.type === 'tool/ptc-dispatch' && !event.data.isError) {
      const start = this.ptc.get(String(event.data.subCallId))
      if (start && start.seq < event.seq && start.data.name === event.data.name
        && start.data.parentCallId === event.data.parentCallId && start.data.rootCallId === event.data.rootCallId)
        this.successful.add(String(event.data.subCallId))
    }
  }
  callIds(): readonly string[] { return [...this.successful] }
}

/** The direct handoff returns null only after delivery and concludeTurn. */
export function directDeliveryCompleted(events: readonly SessionEvent[]): boolean {
  // Preserve the established ordinary-call rule, including older persisted
  // events. Only the PTC path needs the additional exact delivery result.
  const ordinary = new Set(events.filter(event => event.type === 'tool/call' && event.data.name === 'dss_direct_deliver')
    .map(event => (event as Extract<SessionEvent, { type: 'tool/call' }>).data.callId))
  if (events.some(event => event.type === 'tool/result' && !event.data.message.isError && ordinary.has(event.data.message.toolCallId))) return true
  const delivered = new NativeCommandSuccess(new Set(['dss_direct_deliver']))
  for (const event of events) {
    if (event.type === 'tool/call' || event.type === 'tool/result') continue
    if (event.type === 'tool/ptc-dispatch') {
      const content = event.data.content
      // PendingRoleNotifications is a normal continuation object, not a delivery.
      if (content.length !== 1 || content[0].type !== 'text' || content[0].text !== 'null') continue
    }
    delivered.accept(event)
  }
  return delivered.callIds().length > 0
}
