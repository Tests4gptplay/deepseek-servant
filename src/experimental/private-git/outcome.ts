import type { GitRepository, GitSnapshot, RoleBinding } from './contracts.js'
import { readJson } from './journal.js'
import { readStatus } from './status.js'
import { actionPath, executionPath, sameBinding, type RoleAction, type RoleOutcome, type TurnSignal } from './protocol.js'

type Disposition = Pick<RoleOutcome, 'kind' | 'resultStatus'>

/** CAH's durable role signals, adapted to DSS's native role executions. */
export function signalDisposition(role: RoleBinding['role'], signal: string): Disposition | undefined {
  if (role === 'foreground') {
    if (signal === 'respond' || signal === 'handoff_planner') return { kind: signal }
  } else if (role === 'worker') {
    if (signal === 'continue') return { kind: 'continue' }
    if (signal === 'complete') return { kind: 'result', resultStatus: 'done' }
    if (signal === 'blocked' || signal === 'error') return { kind: 'result', resultStatus: 'failed' }
  } else {
    if (signal === 'done' || signal === 'rework') return { kind: 'plan_ready' }
    if (signal === 'complete') return { kind: 'complete' }
    if (signal === 'handoff') return { kind: 'continue' }
    if (signal === 'wait' || signal === 'need_user' || signal === 'error') return { kind: 'wait' }
  }
}

export function legacySignal(role: RoleBinding['role'], value: Pick<Partial<RoleOutcome>, 'kind' | 'resultStatus' | 'question'>): TurnSignal | undefined {
  if (role === 'foreground' && (value.kind === 'respond' || value.kind === 'handoff_planner')) return value.kind
  if (role === 'worker') {
    if (value.kind === 'continue' || value.kind === 'result' && value.resultStatus === 'handoff') return 'continue'
    if (value.kind === 'result') return value.resultStatus === 'failed' ? 'error' : 'complete'
  }
  if (role === 'planner') {
    if (value.kind === 'plan_ready') return 'done'
    if (value.kind === 'continue') return 'handoff'
    if (value.kind === 'complete') return 'complete'
    if (value.kind === 'wait') return value.question ? 'need_user' : 'wait'
  }
}

/** Read the bound protocol body. IDs come from Host bindings, not prose matching. */
export async function readOutcome(repo: GitRepository, snapshot: GitSnapshot, expected: RoleBinding | string): Promise<RoleOutcome | undefined> {
  const path = typeof expected === 'string' ? expected : expected.outputPath
  const value = await readJson<Partial<RoleOutcome>>(repo, snapshot, path)
  const binding = typeof expected === 'string' ? value?.binding : expected
  if (!value?.binding || !binding || !sameBinding(value.binding, binding)
    || binding.outputPath !== path || executionPath(binding) + '/outcome.json' !== path) return undefined
  const action = await readJson<RoleAction>(repo, snapshot, actionPath(binding))
  if (!action?.binding || !sameBinding(action.binding, binding)) return undefined
  const completed = action.stateProtocol === 1 ? await readStatus(repo, snapshot, binding, 'completed') : undefined
  if (action.stateProtocol === 1 && (!completed?.turn_signal || completed.outcomePath !== path
    || completed.turn_signal !== value.turn_signal)) return undefined
  const signal = completed?.turn_signal ?? value.turn_signal ?? legacySignal(binding.role, value)
  const disposition = signal && signalDisposition(binding.role, signal)
  if (!disposition) return undefined
  const closed = value.observedTrigger === undefined && binding.role === 'planner'
    ? await readStatus(repo, snapshot, binding, 'closed') : undefined
  return { ...value, ...disposition, binding, turn_signal: signal, observedTrigger: value.observedTrigger ?? closed?.observedTrigger,
    textPath: value.textPath ?? executionPath(binding) + '/output/text',
    prerequisitePaths: value.prerequisitePaths ?? [], createdAt: value.createdAt ?? '' }
}

/** Mutable Host indexes become schedulable only after their author's remote completion. */
export async function recordPublished(repo: GitRepository, snapshot: GitSnapshot, writer?: RoleBinding, handoffTaskId?: string): Promise<boolean> {
  if (!writer) return true // Existing records predate separate status files.
  const action = await readJson<RoleAction>(repo, snapshot, actionPath(writer))
  const started = await readStatus(repo, snapshot, writer, 'started')
  if (!started && action?.stateProtocol !== 1) return true
  const completed = await readStatus(repo, snapshot, writer, 'completed')
  if (completed?.turn_signal && completed.outcomePath === writer.outputPath && signalDisposition(writer.role, completed.turn_signal)) return true
  // A recovered intake explicitly hands off the same saved task after its original turn was interrupted.
  const current = action?.binding
  if (handoffTaskId && writer.role === 'foreground' && current?.role === 'foreground'
    && current.generation > writer.generation && current.sourceIntentId === writer.sourceIntentId
    && actionPath(current) === actionPath(writer)) {
    const outcome = await readOutcome(repo, snapshot, current)
    return outcome?.kind === 'handoff_planner' && outcome.taskId === handoffTaskId
  }
  return false
}

/** Protocol changes are consumed by the Host; business-source notices go to Foreground. */
export const isProtocolPath = (path: string): boolean =>
  path === 'dss-coop/README.md' || /^dss-coop\/(?:tasks|foreground|intents|inputs|instances|participants|assistants|conversations|history|records|origins|events|incidents|status)\//.test(path)
