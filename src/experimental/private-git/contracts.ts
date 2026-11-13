import type { GitDirectoryIndex, GitDirectoryIndexOptions } from '../../framework/git-directory-index.js'
import type { FailureDetails } from '../../diagnostics/failure-details.js'
import { z } from 'zod'
import { posix } from 'node:path'

/** UI paths are relative to the repository; root aliases share one stored value. */
export const RepositoryDirectorySchema = z.string().trim().default('dss-coop')
  .transform(value => posix.normalize(value.replace(/\\/g, '/')).replace(/^\/+|\/+$/g, ''))
  .transform(value => value === '.' ? '' : value)
  .refine(value => !/[\0\r\n]/.test(value) && value !== '..' && !value.startsWith('../'), 'Use a directory inside the Git repository.')

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
export interface GitSnapshot { head: string; tree: string; files: ReadonlyMap<string, string>; reads?: Map<string, string | undefined> }
export type GitChange = { path: string; deleteTree?: true } & ({ content: string | null; bytes?: never } | { bytes: Uint8Array; content?: never })
export interface GitFileChange { path: string; status: 'A' | 'M' | 'D'; commit: string; parent?: string; before?: string; after?: string }
export interface GitChangeNotice { from: string; to: string; changes: GitFileChange[] }
export interface GitDependencyList { prefix: string; recursive: boolean; selection?: import('../../framework/file-list-selection.js').FileListSelection; namesOnly?: boolean }
export interface GitReadDependencies { files: readonly string[]; lists: readonly GitDependencyList[] }
export interface GitReceipt { commit: string; replay: boolean }
/** Fixed transport pools, never caller-generated identities or repository authority. */
export type GitOperationChannel = 'read' | 'write' | 'refresh' | 'foreground-read' | 'foreground-write' | 'host-poll' | 'host-poll-write'
/** Explicit operation-local demands. This contract does not select a transport. */
export interface GitReadPlan { files?: readonly string[]; directories?: readonly string[]; signal?: AbortSignal; isolatePathErrors?: boolean }

export function validCoopPath(path: string): boolean {
  return path.startsWith('dss-coop/') && !/[\\\0\r\n]/.test(path)
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}
/** Persist this receipt metadata BEFORE dispatch; it contains no business body or secret. */
export interface GitCommitOperation {
  version: 1
  id: string
  expectedHead: string
  repositoryId: number
  repository: string
  branch: string
  directory: string
  authorId: number
  requestHash: string
  /** Native commit author/committer time, Unix seconds, persisted before dispatch. */
  preparedAt?: number
  writes: Array<{ path: string; sha256: string | null; deleteTree?: true }>
}
export type GitCommitResolution =
  | { status: 'confirmed'; commit: string; head: string }
  // A request can still be in flight. Only the SAME operation at the SAME H may be retried.
  | { status: 'pending'; head: string }
  | { status: 'conflict'; head: string }
  | { status: 'unknown'; head?: string; reason: string; failureDetails?: FailureDetails }
export class GitCommitOutcomeUnknownError extends Error {
  readonly operationId: string
  readonly expectedHead: string
  constructor(readonly operation: GitCommitOperation, options?: ErrorOptions) {
    super('Git commit result is unknown; retain operation ' + operation.id + ' and resolve it before creating a replacement.', options)
    this.name = 'GitCommitOutcomeUnknownError'
    this.operationId = operation.id
    this.expectedHead = operation.expectedHead
  }
}

export interface RepoBinding { ownerRepo: string; repositoryId?: number; participantId?: number; branch?: string; repositoryDirectory?: string; instanceId?: string }
export interface GitRepository {
  connect(): Promise<RepoConnection>
  snapshot(afterWrite?: boolean): Promise<GitSnapshot>
  read(snapshot: GitSnapshot, path: string): Promise<string | undefined>
  changes?(snapshot: GitSnapshot, from: string, ownInstance?: string): Promise<GitFileChange[]>
  at?(revision: string): Promise<GitSnapshot>
  /** Load only a requested directory's metadata into this snapshot. */
  list?(snapshot: GitSnapshot, prefix: string): Promise<void>
  directories?(snapshot: GitSnapshot, prefix: string): Promise<string[]>
  /** Untracked discovery metadata; business reads remain independently tracked. */
  directoryIndex?(snapshot: GitSnapshot, prefix: string, previous?: GitDirectoryIndex, options?: GitDirectoryIndexOptions): Promise<GitDirectoryIndex>
  cancel?(): void
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
export const ForegroundProfileSchema = z.object({ workspace: z.string(), presetId: z.string(), provider: z.string().optional(), model: z.string().optional(), reasoningEffort: z.string().optional() })
export interface UserIntent {
  foreground?: z.infer<typeof ForegroundProfileSchema>
  contextPath?: string
  contextHead?: string
  context?: Array<{ role: string; text: string; at?: string }>
  id: string
  participantId: string
  instanceId: string
  text: string
  createdAt: string
}
