import { failureDetails, type FailureDetails } from '../diagnostics/failure-details.js'
import { createHash, randomUUID } from 'node:crypto'
import type { WorkIdentity } from './recovery.js'

export interface SafetyFaultContext {
  mode: 'local' | 'git'
  scope?: string
  source: string
  identity?: WorkIdentity
  role?: WorkIdentity['role']
  workId?: string
  executionId?: string
  taskId?: string
  operationId?: string
  target?: string
  code?: string
  admissionTimeout?: { helperWakeId: string; context: Record<string, unknown> }
  diagnosticContext?: Record<string, unknown>
  errorSignature?: string
}
export interface SafetyFault extends SafetyFaultContext {
  id: string
  message: string
  occurrence: number
  fingerprint?: string
  failureDetails?: FailureDetails
}
export interface SafetyPresentation { faultId: string; state: 'repairing' | 'awaiting-outcome' | 'visible'; message?: string }
interface FaultRecord {
  fault: SafetyFault
  assigned: boolean
  attempted?: { id: string; boundary: number }
  visible: boolean
  recoveryFailure?: string
  repairSettled?: boolean
  kind: string
  observed: number
  observedMessage?: string
}

/** Display-only incidents. A failed operation stays failed throughout recovery.
 * Occurrences are captured before work, not when its delayed error arrives. */
export class FrameworkSafetyNet {
  constructor(private readonly displayOwner?: string) {}
  private sequence = 0
  private readonly records = new Map<string, FaultRecord>()
  private readonly byId = new Map<string, FaultRecord>()
  private readonly resolvedProjections = new Map<string, { mode: SafetyFault['mode']; scope?: string; workId: string; executionId: string }>()
  current(): number { return this.sequence }
  begin(): number { return ++this.sequence }
  private key(context: SafetyFaultContext, kind: string): string {
    if (context.admissionTimeout) return JSON.stringify([context.mode, context.scope, context.source, 'admission-timeout', context.admissionTimeout.helperWakeId])
    // Keep the existing first-fault grouping for ordinary reports. Only the
    // content/restore diagnostics that already owned exact runtime signatures
    // distinguish changed record contents or a different restore target here.
    const signature = typeof context.diagnosticContext?.roleAuthorityContent === 'string'
      || typeof context.diagnosticContext?.hostRestorationCommandId === 'string' ? context.errorSignature : undefined
    return JSON.stringify([context.mode, context.scope, context.source, context.identity?.role ?? context.role,
      context.identity?.workId ?? context.workId, context.taskId ?? context.identity?.taskId, context.target, kind, signature])
  }
  /** A projected detail is an existing fact, not a new producer failure. Match
   * exact execution and opaque facts only; missing Task metadata is not guessed. */
  private projectionKey(context: SafetyFaultContext, message: string): string | undefined {
    const work = context.identity?.workId ?? context.workId, execution = context.identity?.executionId ?? context.executionId
    return work && execution ? JSON.stringify([context.mode, context.scope, work, execution, message]) : undefined
  }
  projected(context: SafetyFaultContext, message: string): SafetyPresentation | null | undefined {
    const identity = context.identity
    if (!identity) return undefined
    const found = [...new Set(this.records.values())].filter(({ fault }) => fault.mode === context.mode && fault.scope === context.scope
      && (fault.identity?.workId ?? fault.workId) === identity.workId
      && (fault.identity?.executionId ?? fault.executionId) === identity.executionId && fault.message === message)
    if (found.length === 1) return this.presentation(found[0]!.fault.id)
    const key = this.projectionKey(context, message)
    return key && this.resolvedProjections.has(key) ? null : undefined
  }
  pruneResolvedProjections(mode: SafetyFault['mode'], scope: string, executions: readonly Pick<WorkIdentity, 'workId' | 'executionId'>[]): void {
    const current = new Set(executions.map(identity => JSON.stringify([identity.workId, identity.executionId])))
    for (const [key, identity] of this.resolvedProjections) if (identity.mode === mode && identity.scope === scope
      && !current.has(JSON.stringify([identity.workId, identity.executionId]))) this.resolvedProjections.delete(key)
  }
  bindScope(id: string, scope: string): void {
    const record = this.byId.get(id)
    if (!record) return
    record.fault = { ...record.fault, scope }
    this.index(record)
  }
  private index(record: FaultRecord): FaultRecord {
    const key = this.key(record.fault, record.kind), existing = this.records.get(key)
    if (existing && existing !== record) {
      if (existing.attempted || record.attempted) {
        if (existing.attempted && !record.attempted) this.records.set(key, record)
        return record
      }
      existing.assigned ||= record.assigned
      existing.attempted ??= record.attempted
      existing.visible ||= record.visible
      existing.repairSettled ||= record.repairSettled
      existing.recoveryFailure ??= record.recoveryFailure
      if (record.observed > existing.observed) existing.observedMessage = record.observedMessage
      existing.observed = Math.max(existing.observed, record.observed)
      for (const [alias, value] of this.records) if (value === record) this.records.set(alias, existing)
      for (const [alias, value] of this.byId) if (value === record) this.byId.set(alias, existing)
      return existing
    }
    this.records.set(key, record)
    return record
  }
  capture(error: unknown, context: SafetyFaultContext, occurrence: number): SafetyPresentation {
    const message = error instanceof Error ? error.message : String(error)
    const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    const code = context.code ?? errorCode
    // Opaque equality is only a fallback for untyped errors. Never parse error
    // prose to choose a Task, repair target, or business action.
    const kind = code ?? createHash('sha256').update(JSON.stringify([error instanceof Error ? error.name : typeof error, message])).digest('hex')
    const key = this.key(context, kind)
    let record = this.records.get(key)
    // A producer operation that began after an actual repair is new evidence.
    // Replayed details and delayed failures from before that repair remain the
    // original incident. Neither a Helper turn ending nor a read of old state
    // creates another repair request or a user-visible error.
    const afterRepair = record?.repairSettled && record.attempted && occurrence > record.attempted.boundary
    if (!record || afterRepair) {
      record = { fault: { ...context, ...(code ? { code } : {}), id: randomUUID(), message, occurrence, fingerprint: kind, failureDetails: failureDetails(error) }, assigned: false, visible: false, kind, observed: occurrence }
      this.records.set(key, record); this.byId.set(record.fault.id, record)
    }
    // The new Helper decides what to do and whether the user needs a report.
    // An older UNKNOWN operation keeps its own identity and outcome.
    if (occurrence > 0 && occurrence >= record.observed) record.observedMessage = message
    record.observed = Math.max(record.observed, occurrence)
    return this.presentation(record.fault.id)!
  }
  pending(mode: SafetyFault['mode'], scope?: string): readonly SafetyFault[] {
    return [...new Set(this.records.values())].filter(record => !record.assigned && !record.attempted && !record.visible
      && record.fault.mode === mode && record.fault.scope === scope).map(record => record.fault)
  }
  assigned(id: string): void { const record = this.byId.get(id); if (record) record.assigned = true }
  needsRepair(id: string): boolean {
    const record = this.byId.get(id)
    return !!record && !record.assigned && !record.attempted && !record.visible
  }
  attempted(id: string, attemptId: string, settled = false): boolean {
    const record = this.byId.get(id)
    if (!record || record.attempted && (!settled || record.repairSettled)) return false
    record.attempted = { id: attemptId, boundary: this.begin() }
    record.assigned = true
    if (settled) record.repairSettled = true
    return true
  }
  failed(id: string, attemptId: string, error: unknown, terminal = false): void {
    this.attempted(id, attemptId)
    const record = this.byId.get(id)
    if (record) {
      if (terminal) record.visible = true
      record.recoveryFailure = error instanceof Error ? error.message : String(error)
    }
  }
  /** The Helper repaired its responsibility. The original operation still owns
   * an unknown result; this is not a successful operation or a user notification. */
  awaitingOutcome(id: string): void {
    const record = this.byId.get(id)
    if (record?.fault.operationId) { record.repairSettled = true; record.assigned = true; record.visible = false }
  }
  presentation(id: string): SafetyPresentation | undefined {
    const record = this.byId.get(id)
    const message = record?.visible ? record.recoveryFailure ?? record.observedMessage : undefined
    return record && { faultId: record.fault.id, state: record.visible ? 'visible' : record.repairSettled ? 'awaiting-outcome' : 'repairing', ...(message !== undefined ? { message } : {}) }
  }
  fault(id: string): SafetyFault | undefined { return this.byId.get(id)?.fault }
  restore(fault: SafetyFault, result: { attemptId?: string; failure?: string; terminal?: boolean; displayOwner?: string }): void {
    const kind = fault.fingerprint ?? fault.code ?? createHash('sha256').update(JSON.stringify(['Error', fault.message])).digest('hex')
    const key = this.key(fault, kind)
    let record = this.byId.get(fault.id)
    if (record && !record.fault.diagnosticContext && fault.diagnosticContext) {
      // The original persisted wake can supply facts absent from older fault
      // records. Rekey that same responsibility without discarding its attempt.
      const previous = this.key(record.fault, record.kind)
      if (this.records.get(previous) === record) this.records.delete(previous)
      record.fault = { ...record.fault, diagnosticContext: fault.diagnosticContext, errorSignature: fault.errorSignature }
      record = this.index(record)
    }
    const grouped = this.records.get(key)
    if (!record && !result.attemptId && !grouped?.attempted) record = grouped
    if (!record) {
      record = { fault: { ...fault, occurrence: 0 }, assigned: true, visible: false, kind, observed: 0 }
      // A still-unhandled recurrence owns new observations. Replaying its older
      // repair must not fold the two persisted fault identities back together.
      if (!grouped || grouped.attempted) this.records.set(key, record)
    }
    record.assigned = true
    this.byId.set(fault.id, record)
    if (result.attemptId) {
      if (result.failure !== undefined) this.failed(fault.id, result.attemptId, result.failure, result.terminal)
      else this.attempted(fault.id, result.attemptId, true)
      // A prior Host's attempt does not decide visibility on this Host.
    }

  }
  ids(id: string): string[] {
    const record = this.byId.get(id)
    return record ? [...this.byId].filter(([, value]) => value === record).map(([key]) => key) : []
  }
  resolved(id: string): void {
    const record = this.byId.get(id)
    if (!record) return
    for (const message of [record.fault.message, record.observedMessage]) if (message !== undefined) {
      const key = this.projectionKey(record.fault, message)
      if (key) this.resolvedProjections.set(key, { mode: record.fault.mode, scope: record.fault.scope,
        workId: (record.fault.identity?.workId ?? record.fault.workId)!, executionId: (record.fault.identity?.executionId ?? record.fault.executionId)! })
    }
    for (const [key, value] of this.byId) if (value === record) this.byId.delete(key)
    for (const [key, value] of this.records) if (value === record) this.records.delete(key)
  }
}
