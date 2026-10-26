import type { GitRepository, GitSnapshot, RoleBinding } from './contracts.js'
import { readJson } from './journal.js'
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
  const signal = value.turn_signal ?? legacySignal(binding.role, value)
  const disposition = signal && signalDisposition(binding.role, signal)
  if (!disposition) return undefined
  return { ...value, ...disposition, binding, turn_signal: signal,
    textPath: value.textPath ?? executionPath(binding) + '/output/text',
    prerequisitePaths: value.prerequisitePaths ?? [], createdAt: value.createdAt ?? '' }
}

/** Protocol changes are consumed by the Host; business-source notices go to Foreground. */
export const isProtocolPath = (path: string): boolean =>
  /^dss-coop\/(?:tasks|foreground|intents|inputs|instances|participants|assistants|conversations|history|records|origins|events|incidents)\//.test(path)
