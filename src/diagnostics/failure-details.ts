/** Diagnostic evidence only. Never consulted for authority, retry or UI state.
 * Dependency text, stacks, URLs, headers, bodies and enumerable extras are never
 * copied. Identity fields are opaque application operation IDs, not commands. */
export interface FailureDetails {
  name: string
  kind?: string
  code?: string
  operationId?: string
  expectedHead?: string
  status?: number
  phase?: FailurePhase
  stage?: FailurePhase
  category?: string
  responseObserved?: boolean
  cause?: FailureDetails
  errors?: FailureDetails[]
  resolution?: { status: 'pending' | 'unknown' | 'failed'; head?: string; error?: FailureDetails }
  truncated?: true
}
export type FailurePhase = 'controls-held-task' | 'controls-pending-stops' | 'controls-settle-stop' | 'controls-stop-confirmation'
  | 'publication' | 'resolution' | 'advertisement' | 'upload-pack' | 'receive-pack'
interface Annotation {
  phase?: FailurePhase
  resolution?: { status: 'pending' | 'unknown' | 'failed'; head?: string; error?: unknown }
}
const annotations = new WeakMap<object, Annotation>()
/** Keep original errors (including frozen errors) and their control flow intact. */
export function annotateFailure<T>(error: T, details: Annotation): T {
  if (error && typeof error === 'object') annotations.set(error, { ...annotations.get(error), ...details })
  return error
}
const names = new Set(['Error', 'AggregateError', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError',
  'GitBackendError', 'GitHubError', 'GitConflictError', 'GitCommitOutcomeUnknownError',
  'FilesConflictError', 'FilesOutcomeUnknownError'])
const kinds = new Set(['cancelled', 'auth', 'stale', 'rejected', 'missing_branch', 'fatal', 'transport', 'invalid'])
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ABORT_ERR',
  'dss/outcome-unknown', 'dss/conflict'])
const phases = new Set<string>(['controls-held-task', 'controls-pending-stops', 'controls-settle-stop', 'controls-stop-confirmation',
  'publication', 'resolution', 'advertisement', 'upload-pack', 'receive-pack'])
const categories = new Set(['http', 'timeout', 'connection', 'tls', 'protocol', 'other'])
function own(value: object, key: string): unknown {
  // Do not invoke dependency getters while handling an unrelated failure.
  try { return Object.getOwnPropertyDescriptor(value, key)?.value } catch { return undefined }
}
const head = (value: unknown): string | undefined => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : undefined
export function failureDetails(error: unknown): FailureDetails {
  const seen = new WeakSet<object>()
  function visit(value: unknown, depth: number): FailureDetails {
    if (!value || typeof value !== 'object') return { name: 'Error' }
    if (seen.has(value)) return { name: 'Error', truncated: true }
    seen.add(value)
    const rawName = own(value, 'name') ?? (value instanceof AggregateError ? 'AggregateError' : value instanceof TypeError ? 'TypeError' : value instanceof RangeError ? 'RangeError' : 'Error')
    const name = typeof rawName === 'string' && names.has(rawName) ? rawName : 'Error'
    const result: FailureDetails = { name }
    const kind = own(value, 'kind'), code = own(value, 'code'), status = own(value, 'status')
    if (typeof kind === 'string' && kinds.has(kind)) result.kind = kind
    if (typeof code === 'string' && codes.has(code)) result.code = code
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.status = status
    if (name === 'FilesOutcomeUnknownError' || name === 'GitCommitOutcomeUnknownError') {
      const id = own(value, 'operationId')
      if (typeof id === 'string') result.operationId = id
      const expected = head(own(value, 'expectedHead'))
      if (expected) result.expectedHead = expected
    }
    const annotation = annotations.get(value), phase = own(value, 'phase') ?? annotation?.phase, category = own(value, 'category')
    if (annotation?.phase) result.stage = annotation.phase
    if (typeof phase === 'string' && phases.has(phase)) result.phase = phase as FailurePhase
    if (typeof category === 'string' && categories.has(category)) result.category = category
    const observed = own(value, 'responseObserved')
    if (typeof observed === 'boolean') result.responseObserved = observed
    const cause = own(value, 'cause')
    if (cause !== undefined) result.cause = visit(cause, depth + 1)
    const errors = own(value, 'errors')
    if (name === 'AggregateError' && Array.isArray(errors)) {
      result.errors = []
      for (let i = 0; i < errors.length; i++) result.errors.push(visit(own(errors, String(i)), depth + 1))
      if (errors.length > result.errors.length) result.truncated = true
    }
    if (annotation?.resolution) {
      const resolution = annotation.resolution
      result.resolution = { status: resolution.status }
      const observedHead = head(resolution.head)
      if (observedHead) result.resolution.head = observedHead
      if (resolution.error !== undefined) result.resolution.error = visit(resolution.error, depth + 1)
    }
    return result
  }
  try { return visit(error, 0) } catch { return { name: 'Error', truncated: true } }
}
