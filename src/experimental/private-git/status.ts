import type { GitRepository, GitSnapshot, RoleBinding } from './contracts.js'
import { GitJournal, json, readJson } from './journal.js'
import { Id, sameBinding, type TurnSignal } from './protocol.js'

export type StatusKind = 'started' | 'completed' | 'closed' | 'replaced'
export interface RoleStatus {
  version: 1
  kind: StatusKind
  binding: RoleBinding
  createdAt: string
  turn_signal?: TurnSignal
  outcomePath?: string
  observedTrigger?: string
  successor?: string
  reason?: string
}
export const statusPrefix = (taskId?: string): string =>
  'dss-coop/status/' + (taskId ? 'tasks/' + Id.parse(taskId) : 'foreground') + '/'
export const statusPath = (binding: RoleBinding, kind: StatusKind): string =>
  statusPrefix(binding.taskId) + Id.parse(binding.participantId) + '/' + Id.parse(binding.instanceId) + '/' + Id.parse(binding.executionId) + '/' + kind + '.json'

/** Status records are new files; later lifecycle facts never rewrite earlier ones. */
export async function appendStatus(journal: GitJournal, snapshot: GitSnapshot, status: RoleStatus) {
  return journal.immutable(snapshot, statusPath(status.binding, status.kind), json(status))
}
export async function readStatus(repo: GitRepository, snapshot: GitSnapshot, binding: RoleBinding, kind: StatusKind): Promise<RoleStatus | undefined> {
  const status = await readJson<RoleStatus>(repo, snapshot, statusPath(binding, kind))
  return status?.version === 1 && status.kind === kind && status.binding && sameBinding(status.binding, binding) ? status : undefined
}
