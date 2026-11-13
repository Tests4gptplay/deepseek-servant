/** Object/transport boundary only. Authorization, receipts, ownership and business
 * transactions remain in RemoteGitRepository. */
export interface GitCommandOptions {
  signal: AbortSignal
  token?: string
  input?: Uint8Array | string
  fixtureTransport?: boolean
}
export type GitObjectCommand =
  | { op: 'fetchHead'; remote: string; ref: string; tip?: string }
  | { op: 'fetchMetadata'; remote: string; revision: string }
  | { op: 'ensureObjects'; remote: string; ids: string[]; kind: 'blob' | 'commit'; commitDepth?: number }
  | { op: 'readObject'; kind: 'blob' | 'commit'; id: string }
  | { op: 'readTree'; id: string }
  | { op: 'writeBlob' }
  | { op: 'writeTree' }
  | { op: 'writeCommit'; tree: string; parent: string; identity: string; email: string; timestamp: number }
  | { op: 'push'; remote: string; ref: string; commit: string; expected: string }
export type GitBackendErrorKind = 'cancelled' | 'auth' | 'stale' | 'rejected' | 'missing_branch' | 'fatal' | 'transport' | 'invalid'
export interface GitBackendFailureDetails {
  /** Validated target-ref OID from a rejected pre-POST advertisement only. */
  advertisedHead?: string
  status?: number
  phase?: 'advertisement' | 'upload-pack' | 'receive-pack'
  category?: 'http' | 'timeout' | 'connection' | 'tls' | 'protocol' | 'other'
  responseObserved?: boolean
}
export class GitBackendError extends Error {
  readonly advertisedHead?: string
  readonly status?: number
  readonly phase?: GitBackendFailureDetails['phase']
  readonly category?: GitBackendFailureDetails['category']
  readonly responseObserved?: boolean
  constructor(readonly kind: GitBackendErrorKind, message: string, details?: GitBackendFailureDetails) {
    super(message); this.name = 'GitBackendError'
    if (kind === 'stale' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(details?.advertisedHead ?? '') && !/^0+$/.test(details!.advertisedHead!)) this.advertisedHead = details!.advertisedHead
    // The helper boundary is deliberately allowlisted, never Object.assign.
    if (Number.isInteger(details?.status) && details!.status! >= 100 && details!.status! <= 599) this.status = details!.status
    if (['advertisement', 'upload-pack', 'receive-pack'].includes(details?.phase ?? '')) this.phase = details!.phase
    if (['http', 'timeout', 'connection', 'tls', 'protocol', 'other'].includes(details?.category ?? '')) this.category = details!.category
    if (typeof details?.responseObserved === 'boolean') this.responseObserved = details.responseObserved
  }
}
export interface GitObjectBackend {
  /** Shared only by generations hosted in the same owned process. */
  readonly lifetime: object
  /** Optional owned dependency readiness; no credentials or network. */
  ready?(signal: AbortSignal): Promise<void>
  execute(command: GitObjectCommand, options: GitCommandOptions): Promise<Buffer>
  storageBytes(): Promise<number>
  replacement(roots: readonly { head: string; tree?: string }[], signal: AbortSignal, retainedBlobIds?: ReadonlySet<string>): Promise<{
    transport: GitObjectBackend; objects: number; packBytes: number; rawBytes: number; roots: { head: string; tree: string }[]
  }>
  release(): Promise<void>
}
