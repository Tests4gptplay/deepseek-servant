/** Knowledge belongs to one Servant assistant and workspace; it is never global by accident. */
export interface KnowledgeScope {
  assistantId: string
  workspaceId: string
}

export type SkillStatus = 'candidate' | 'active' | 'revised' | 'disabled' | 'retired'

/** Facts supplied by TaskService, not claims supplied in a model tool argument. */
export interface KnowledgeResultEvidence extends KnowledgeScope {
  resultId: string
  taskId: string
  executionId?: string
  status: 'accepted' | 'failed' | 'pending'
  summary: string
  artifactRefs: string[]
}

export interface KnowledgeEvidenceResolver {
  resolveResult(resultId: string): Promise<KnowledgeResultEvidence | undefined>
  resolveUserSource?(sourceRef: string): Promise<KnowledgeScope | undefined>
}

export interface SkillValidation {
  validationId: string
  resultId: string
  contentHash: string
  /** The reviewer explicitly relates this method and its limited applicability to the result. */
  explanation: string
  artifactRefs: string[]
  validatedAt: string
}

/** Created only from an observed host skill load, never from a model saying it used a skill. */
export interface SkillUse {
  observationId: string
  skillId: string
  version: number
  contentHash: string
  taskId: string
  executionId: string
  observedAt: string
}

export interface SkillFeedback {
  feedbackId: string
  observationId: string
  resultId: string
  outcome: 'success' | 'failure'
  explanation: string
  recordedAt: string
}

/** Closed Task use retains exact Task/execution/content attribution without every load receipt. */
export interface SkillUseArchive {
  taskId: string
  executionId: string
  contentHash: string
  observedLoads: number
  firstObservedAt: string
  lastObservedAt: string
}
export interface SkillFeedbackArchive extends Omit<SkillFeedback, 'explanation'> { taskId: string; executionId: string }

export interface SkillVersion {
  skillId: string
  version: number
  title: string
  description: string
  body: string
  /** The immutable hash/provenance survives; this obsolete body is unavailable after cleanup. */
  bodyRetiredAt?: string
  /** Human-readable boundary of the supported method, included in the content hash. */
  applicability: string
  scope: KnowledgeScope
  contentHash: string
  status: SkillStatus
  createdAt: string
  sourceResultIds: string[]
  validations: SkillValidation[]
  uses: SkillUse[]
  feedback: SkillFeedback[]
  archivedUses?: SkillUseArchive[]
  archivedFeedback?: SkillFeedbackArchive[]
  supersedes?: number
  statusReason?: string
}

export interface KnowledgeCommandReceipt {
  commandId: string
  fingerprint: string
  revision: number
  version: number
}

export interface SkillRecord {
  schemaVersion: 1
  kind: 'skill'
  skillId: string
  scope: KnowledgeScope
  revision: number
  activeVersion?: number
  versions: SkillVersion[]
  receipts: Record<string, KnowledgeCommandReceipt>
}

export interface KnowledgeMutationReceipt {
  status: 'applied' | 'duplicate'
  skillId: string
  version: number
  revision: number
}

export interface ProposeSkillInput {
  commandId: string
  skillId: string
  scope: KnowledgeScope
  title: string
  description: string
  body: string
  applicability: string
  sourceResultId: string
}

export interface ValidateSkillInput {
  commandId: string
  skillId: string
  version: number
  scope: KnowledgeScope
  contentHash: string
  resultId: string
  explanation: string
  /** Only evidence refs present on the accepted result may be selected. */
  artifactRefs: string[]
}

export interface ReviseSkillInput extends ProposeSkillInput {
  expectedVersion: number
}

export interface SkillStatusInput {
  commandId: string
  skillId: string
  version: number
  scope: KnowledgeScope
  reason: string
}

export interface RecordSkillUseInput extends KnowledgeScope {
  observationId: string
  skillId: string
  version: number
  contentHash: string
  taskId: string
  executionId: string
}

export interface SkillFeedbackInput {
  commandId: string
  skillId: string
  version: number
  scope: KnowledgeScope
  observationId: string
  resultId: string
  outcome: 'success' | 'failure'
  explanation: string
}

/** A native Skill provider adapts these; Servant does not implement a second loader. */
export interface ServantSkillDescriptor {
  name: string
  skillId: string
  version: number
  title: string
  description: string
  contentHash: string
}

export interface ProjectFact {
  schemaVersion: 1
  kind: 'project-fact'
  id: string
  scope: KnowledgeScope
  revision: number
  text: string
  sourceResultId: string
  updatedAt: string
}

export interface Preference {
  schemaVersion: 1
  kind: 'preference'
  id: string
  scope: KnowledgeScope
  revision: number
  text: string
  applicability: string
  /** A verified user message identity, supplied by the user-facing boundary. */
  userSourceRef: string
  updatedAt: string
}

export type KnowledgeRecord = SkillRecord | ProjectFact | Preference
