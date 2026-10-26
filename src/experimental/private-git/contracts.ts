import { z } from 'zod'

export const CoopSettingsSchema = z.object({
  ownerRepo: z.string().default(''),
  tokenRef: z.string().min(1).default('DSS_COOP_GITHUB_TOKEN'),
  workerSeats: z.int().min(1).max(32).default(2),
  workspace: z.string().default(''),
  presetId: z.string().default('standard'),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
})
export type CoopSettings = z.infer<typeof CoopSettingsSchema>
export interface GitHubIdentity { id: number; login: string }
export interface PrivateRepository {
  id: number
  fullName: string
  branch: string
  private: true
  permissions: { pull: boolean; push: boolean; admin: boolean }
}
export interface RepoConnection { identity: GitHubIdentity; repository: PrivateRepository }
export interface CoopInvitation { id: number; login: string; status: 'pending'; htmlUrl?: string }
export interface CoopCollaborator { id: number; login: string; permissions: Record<string, boolean>; status: 'accepted' }
export interface GitSnapshot { head: string; tree: string; files: ReadonlyMap<string, string> }
export interface GitChange { path: string; content: string | null }
export interface GitReceipt { commit: string; replay: boolean }
export interface RepoBinding { ownerRepo: string; repositoryId?: number; participantId?: number; branch?: string }
export interface GitRepository {
  connect(): Promise<RepoConnection>
  snapshot(): Promise<GitSnapshot>
  read(snapshot: GitSnapshot, path: string): Promise<string | undefined>
  commit(base: GitSnapshot, changes: readonly GitChange[], message: string): Promise<GitReceipt>
}
export type CoopRole = 'foreground' | 'planner' | 'worker'
export interface RoleBinding {
  participantId: string
  instanceId: string
  taskId?: string
  role: CoopRole
  actionId: string
  executionId: string
  sessionId: string
  generation: number
  epoch: number
  fence: string
  assignmentVersion?: number
  childId?: string
  childRevision?: number
  sourceIntentId?: string
  outputPath: string
}
export interface UserIntent {
  id: string
  participantId: string
  instanceId: string
  text: string
  createdAt: string
}
export interface PendingDraft { id: string; kind: 'user-input' | 'transaction'; createdAt: string; state: 'PENDING_UNCOMMITTED'; payload: unknown; error?: string }
export interface CoopView {
  settings: CoopSettings
  instanceId: string
  connection?: RepoConnection
  credential: { configured: boolean; source?: string; writable: boolean }
  confirmedHead?: string
  status: 'unconfigured' | 'connected' | 'offline'
  error?: string
  pending: PendingDraft[]
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: string; commit: string }>
  moreBefore?: string
  tasks: Array<{ id: string; title: string; coordinator: string; status: string }>
}
