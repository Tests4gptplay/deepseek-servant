import type { RoleBinding } from './contracts.js'

/** Historical record shapes used only by the one-time legacy migration. */
export interface Review {
  reported: string; checked: string; discrepancy: string; decision: string; next: string
}
export interface Child {
  id: string; workId: string; assignmentVersion: number; title: string; direction: string; acceptance: string
  dependencies: string[]
}
export interface ChildState extends Child { revision: number; state: 'pending' | 'accepted'; result?: string; review?: Review }
export interface RootTask {
  id: string; title: string; originatingParticipantId: string; coordinatorParticipantId: string
  originIntentId: string; originPath: string; goalPath: string
  revision: number; goalRevision: number; epoch: number
  status: 'active' | 'waiting' | 'accepted' | 'cancelled'
  createdAt: string; updatedAt: string
  sourcePath?: string; sourceRevision?: string; writer?: RoleBinding
}
export interface Join {
  taskId: string; participantId: string; instanceId: string; sourceIntentId: string
  sourceHash: string; scope: string; capabilities: string; revision: number; epoch: number
  state: 'active' | 'paused' | 'left'; goalRevision: number; writer: RoleBinding
}
export interface ParticipantPlan {
  revision: number; children: ChildState[]; writer: RoleBinding
  /** Goal whose directions this Planner confirmed; absent in pre-upgrade records. */
  goalRevision?: number
}
