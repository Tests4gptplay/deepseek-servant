import { z } from 'zod'
import type { RoleBinding } from './contracts.js'

export const Id = z.string().regex(/^[A-Za-z0-9_-]+$/).max(120)
export const Text = z.string().min(1)
export const Revision = z.int().nonnegative()
export const ReviewSchema = z.object({
  reported: Text.describe('What the Worker reported.'),
  checked: Text.describe('Evidence the Planner actually inspected.'),
  discrepancy: Text.describe('Differences found, or none.'),
  decision: Text.describe('Acceptance decision and reason.'),
  next: Text.describe('Next bounded action or completion.'),
})
export type Review = z.infer<typeof ReviewSchema>
export const WorkSchema = z.object({
  id: Id, title: Text, direction: Text, acceptance: Text,
  participantId: Id, instanceId: Id, version: z.int().positive(),
})
export type Work = z.infer<typeof WorkSchema>
export const ChildSchema = z.object({
  id: Id, workId: Id, assignmentVersion: z.int().positive(), title: Text, direction: Text, acceptance: Text,
  dependencies: z.array(Id).default([]),
})
export type Child = z.infer<typeof ChildSchema>
export interface ChildState extends Child { revision: number; state: 'pending' | 'accepted'; result?: string; review?: Review }
export interface RootTask {
  id: string; title: string; originatingParticipantId: string; coordinatorParticipantId: string
  originIntentId: string; originPath: string; goalPath: string
  revision: number; goalRevision: number; epoch: number
  status: 'active' | 'waiting' | 'accepted' | 'cancelled'
  createdAt: string; updatedAt: string
}
export interface RootPlan { revision: number; works: Work[] }
export interface Join {
  taskId: string; participantId: string; instanceId: string; sourceIntentId: string
  sourceHash: string; scope: string; capabilities: string; revision: number; epoch: number
  state: 'active' | 'paused' | 'left'; goalRevision: number; writer: RoleBinding
}
export interface Claim {
  taskId: string; workId: string; assignmentVersion: number; participantId: string; instanceId: string
  scope: string; joinRevision: number; writer: RoleBinding
}
export interface ParticipantPlan { revision: number; children: ChildState[]; writer: RoleBinding }
export interface RoleAction {
  id: string; binding: RoleBinding; trigger: string; input: unknown
  state: 'active' | 'closed'; createdAt: string
}
export interface RoleOutcome {
  binding: RoleBinding; kind: 'respond' | 'handoff_planner' | 'plan_ready' | 'wait' | 'result' | 'continue' | 'complete'
  textPath: string; memoryPath?: string; notePath?: string; taskId?: string; question?: string
  prerequisitePaths: string[]; createdAt: string; observedTrigger?: string; resultStatus?: 'done' | 'failed' | 'handoff'
}
export interface LocalGrant { taskId: string; joinPath: string; joinHash: string; sourceIntentId: string }
export const CommandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('root'), id: Id, title: Text, goal: Text, initialPlan: Text }),
  z.object({ op: z.literal('join'), id: Id, taskId: Id, scope: Text, capabilities: z.string().default('') }),
  z.object({ op: z.literal('revise'), id: Id, taskId: Id, expectedRevision: Revision, goal: Text }),
  z.object({ op: z.literal('control'), id: Id, taskId: Id, expectedRevision: Revision, state: z.enum(['pause', 'resume', 'leave', 'cancel']) }),
  z.object({ op: z.literal('root_plan'), id: Id, expectedRevision: Revision, works: z.array(WorkSchema) }),
  z.object({ op: z.literal('proposal'), id: Id, text: Text }),
  z.object({ op: z.literal('claim'), id: Id, workId: Id, assignmentVersion: z.int().positive(), scope: Text }),
  z.object({ op: z.literal('participant_plan'), id: Id, expectedRevision: Revision, children: z.array(ChildSchema) }),
  z.object({ op: z.literal('review'), id: Id, childId: Id, expectedRevision: Revision, resultExecutionId: Id,
    accepted: z.boolean(), review: ReviewSchema, nextDirection: z.string().optional() }),
  z.object({ op: z.literal('report'), id: Id, workId: Id, assignmentVersion: z.int().positive(), review: ReviewSchema, text: Text }),
  z.object({ op: z.literal('accept'), id: Id, expectedRevision: Revision, review: ReviewSchema, text: Text }),
  z.object({ op: z.literal('entry'), id: Id, kind: z.enum(['memory', 'note', 'reply', 'checkpoint', 'handoff', 'knowledge', 'skill', 'preference']), text: Text }),
  z.object({ op: z.literal('outcome'), id: Id,
    kind: z.enum(['respond', 'handoff_planner', 'plan_ready', 'wait', 'result', 'continue', 'complete']),
    text: Text, memory: z.string().optional(), note: z.string().optional(), taskId: Id.optional(),
    question: Text.optional().describe('Planner wait only: a concrete question for this participant’s local user, delivered through their Foreground.'),
    prerequisitePaths: z.array(z.string()).default([]), resultStatus: z.enum(['done', 'failed', 'handoff']).optional() }),
])
export type CoopCommand = z.infer<typeof CommandSchema>
export const taskPath = (id: string): string => 'dss-coop/tasks/' + Id.parse(id)
export const participantPath = (taskId: string, participantId: string): string => taskPath(taskId) + '/participants/' + Id.parse(participantId)
export const joinPath = (taskId: string, participantId: string, instanceId: string): string => participantPath(taskId, participantId) + '/instances/' + Id.parse(instanceId) + '/join.json'
export const planPath = (taskId: string, participantId: string, instanceId: string): string => participantPath(taskId, participantId) + '/instances/' + Id.parse(instanceId) + '/plan.json'
export const actionPath = (b: Pick<RoleBinding, 'taskId' | 'participantId' | 'instanceId' | 'actionId'>): string =>
  (b.taskId ? taskPath(b.taskId) : 'dss-coop/foreground') + '/actions/' + Id.parse(b.participantId) + '/' + Id.parse(b.instanceId) + '/' + Id.parse(b.actionId) + '.json'
export const executionPath = (b: Pick<RoleBinding, 'taskId' | 'participantId' | 'executionId'>): string =>
  (b.taskId ? taskPath(b.taskId) : 'dss-coop/foreground') + '/executions/' + Id.parse(b.participantId) + '/' + Id.parse(b.executionId)
export const sameBinding = (a: RoleBinding, b: RoleBinding): boolean =>
  ['participantId', 'instanceId', 'taskId', 'role', 'actionId', 'executionId', 'sessionId', 'generation', 'epoch', 'fence', 'assignmentVersion', 'childId', 'childRevision', 'sourceIntentId', 'outputPath']
    .every(key => a[key as keyof RoleBinding] === b[key as keyof RoleBinding])
export class RejectedCoopWrite extends Error { constructor(message: string) { super(message); this.name = 'RejectedCoopWrite' } }
export class StaleCoopWrite extends RejectedCoopWrite { constructor(message: string) { super(message); this.name = 'StaleCoopWrite' } }
