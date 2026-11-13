import type { WorkIdentity } from './recovery.js'

/** Error ownership and the original runtime facts delivered to Safety Net. */
export interface RoleErrorOrigin {
  role?: WorkIdentity['role']
  identity?: WorkIdentity
  taskId?: string
  hostRestorationCommandId?: string
  restoreCommandId?: string
  admissionTimeout?: { helperWakeId: string; context: Record<string, unknown> }
  diagnosticContext?: Record<string, unknown>
  errorSignature?: string
}
export type RoleErrorResolution = { taskId: string } | { hostRestorationCommandId: string }

// Keep the original error (including UNKNOWN storage errors) and native stack.
// A selected tool View supplies display context for taskless roles such as Foreground.
const origins = new WeakMap<object, RoleErrorOrigin>()
export function rememberRoleErrorOrigin(error: unknown, origin: RoleErrorOrigin): void {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') origins.set(error, origin)
}
export function roleErrorOrigin(error: unknown): RoleErrorOrigin | undefined {
  return (typeof error === 'object' && error !== null) || typeof error === 'function' ? origins.get(error) : undefined
}

/** One live execution's display context. Session events provide call/turn
 * identity; tools provide their actual selected View. No log or storage read. */
export function createRoleErrorTurnContext(identity: WorkIdentity) {
  let current: { turn: number; calls: Set<string>; tasks: Set<string> } | undefined
  return {
    observe(event: import('@deepseek-ai/dsh-session').SessionEvent): void {
      if (event.type === 'turn/start') current = { turn: event.data.turn, calls: new Set(), tasks: new Set() }
      else if (event.type === 'tool/call' && current?.turn === event.data.turn) current.calls.add(event.data.callId)
      else if (event.type === 'turn/end' && current?.turn === event.data.turn) current = undefined
    },
    selectTask(taskId: string | undefined, call: { callId: string; rootCallId?: string }): void {
      if (taskId && current?.calls.has(call.rootCallId ?? call.callId)) current.tasks.add(taskId)
    },
    capture(error: unknown, turn: number): void {
      // Original error ownership wins. A taskless role can inspect several
      // Tasks in one turn; that is not a uniquely attributable display error.
      if (roleErrorOrigin(error) || current?.turn !== turn || current.tasks.size !== 1) return
      rememberRoleErrorOrigin(error, { identity, taskId: current.tasks.values().next().value! })
    },
  }
}
