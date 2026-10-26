import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type {
  ServantSkillDescriptor, KnowledgeEvidenceResolver, KnowledgeMutationReceipt,
  KnowledgeRecord, KnowledgeResultEvidence, KnowledgeScope, Preference,
  ProjectFact, ProposeSkillInput, RecordSkillUseInput, ReviseSkillInput,
  SkillFeedbackInput, SkillRecord, SkillStatusInput, SkillVersion, ValidateSkillInput,
} from '../contracts/knowledge.js'
import type { KnowledgeMaintenanceSession, SkillCompactionRequest, SkillCompactionResult } from '../contracts/retention.js'
import { jsonBytes } from '../domain/retention.js'

const SKILL_PREFIX = 'servant-'
const ROOT = 'knowledge/'

export class KnowledgeError extends Error {
  readonly code: 'not_found' | 'stale' | 'rejected'
  constructor(code: KnowledgeError['code'], message: string) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
  }
}

export interface KnowledgeServiceOptions {
  store: StoragePort
  evidence: KnowledgeEvidenceResolver
  now?: () => string
  onChanged?: () => void
}

/** One owner, one serialized write stream per knowledge aggregate, one durable record per commit. */
export class KnowledgeService {
  private readonly store: StoragePort
  private readonly evidence: KnowledgeEvidenceResolver
  private readonly now: () => string
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<() => void>()
  private maintenanceBarrier: Promise<void> = Promise.resolve()
  private readonly writes = new Set<Promise<unknown>>()

  constructor(options: KnowledgeServiceOptions) {
    this.store = options.store
    this.evidence = options.evidence
    this.now = options.now ?? (() => new Date().toISOString())
    if (options.onChanged) this.listeners.add(options.onChanged)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** A local maintenance lease, not a cross-record KV transaction. New evidence
   * references wait until archive pruning has finished, preventing dangling pins. */
  async withRetentionLock<T>(work: (session: KnowledgeMaintenanceSession) => Promise<T>): Promise<T> {
    const previous = this.maintenanceBarrier
    let release!: () => void
    this.maintenanceBarrier = new Promise<void>(resolve => { release = resolve })
    const existing = [...this.writes]
    try {
      await previous
      await Promise.allSettled(existing)
      return await work({
        listSkills: async () => (await this.store.list<SkillRecord>(`${ROOT}skills/`)).map(item => structuredClone(item.value)),
        compactSkill: input => this.compactForRetention(input),
      })
    } finally { release() }
  }

  async proposeSkill(input: ProposeSkillInput): Promise<KnowledgeMutationReceipt> {
    const key = skillKey(input.scope, input.skillId)
    return this.serialize(key, async () => {
      validateProposal(input)
      const fingerprint = digest(input)
      const current = await this.store.get<SkillRecord>(key)
      const duplicate = this.receipt(current, input.commandId, fingerprint)
      if (duplicate) return duplicate
      await this.result(input.sourceResultId, input.scope, false)
      const contentHash = skillContentHash(input)
      if (current) {
        const previous = current.versions.find(version => version.contentHash === contentHash
          && version.sourceResultIds.includes(input.sourceResultId))
        if (previous) return { status: 'duplicate', skillId: current.skillId, version: previous.version, revision: current.revision }
        throw new KnowledgeError('rejected', 'This skill already exists; revise the explicit current version instead.')
      }
      const version = this.makeVersion(input, 1)
      const record: SkillRecord = {
        schemaVersion: 1, kind: 'skill', skillId: input.skillId, scope: { ...input.scope },
        revision: 0, versions: [version], receipts: {},
      }
      return this.commit(key, record, input.commandId, fingerprint, version.version)
    })
  }

  async reviseSkill(input: ReviseSkillInput): Promise<KnowledgeMutationReceipt> {
    return this.change(input, async record => {
      validateProposal(input)
      const latest = record.versions.at(-1)!
      if (latest.version !== input.expectedVersion) throw new KnowledgeError('stale', 'The skill has a newer version; inspect it before editing.')
      await this.result(input.sourceResultId, input.scope, false)
      const version = this.makeVersion(input, latest.version + 1)
      if (version.contentHash === latest.contentHash && !latest.bodyRetiredAt) throw new KnowledgeError('rejected', 'The proposed revision does not change the skill content or its scope.')
      version.supersedes = latest.version
      record.versions.push(version)
      // The previously active, proven method remains available until its replacement is validated.
      // No validation, use, feedback, or success count is copied into the new candidate.
      return version.version
    })
  }

  async validateSkill(input: ValidateSkillInput): Promise<KnowledgeMutationReceipt> {
    return this.change(input, async record => {
      required(input.explanation, 'validation explanation')
      const version = findVersion(record, input.version)
      if (version.bodyRetiredAt) throw new KnowledgeError('rejected', 'This historical body was retired; supply a new candidate body and validate it separately.')
      if (version.contentHash !== input.contentHash) throw new KnowledgeError('stale', 'Validation refers to different skill content.')
      if (version.status !== 'candidate' && version.status !== 'active') throw new KnowledgeError('rejected', 'Only a current candidate or active version may receive validation.')
      if (record.versions.at(-1)!.version !== input.version && version.status === 'candidate') {
        throw new KnowledgeError('stale', 'A newer candidate exists; validate the intended current version.')
      }
      const result = await this.result(input.resultId, input.scope, true)
      if (!Array.isArray(input.artifactRefs) || !input.artifactRefs.length) throw new KnowledgeError('rejected', 'Validation needs an artifact from the accepted result.')
      if (input.artifactRefs.some(ref => !result.artifactRefs.includes(ref))) {
        throw new KnowledgeError('rejected', 'A validation artifact is not part of the accepted result.')
      }
      if (!version.validations.some(validation => validation.resultId === input.resultId && validation.contentHash === input.contentHash)) {
        version.validations.push({
          validationId: `validation:${digest([input.skillId, input.version, input.resultId, input.contentHash])}`,
          resultId: input.resultId, contentHash: input.contentHash, explanation: input.explanation,
          artifactRefs: [...new Set(input.artifactRefs)], validatedAt: this.now(),
        })
      }
      if (record.activeVersion !== undefined && record.activeVersion !== version.version) {
        const old = findVersion(record, record.activeVersion)
        old.status = 'revised'
        old.statusReason = `Replaced by validated version ${version.version}.`
      }
      version.status = 'active'
      delete version.statusReason
      record.activeVersion = version.version
      return version.version
    })
  }

  async disableSkill(input: SkillStatusInput): Promise<KnowledgeMutationReceipt> {
    return this.setStatus(input, 'disabled')
  }

  async retireSkill(input: SkillStatusInput): Promise<KnowledgeMutationReceipt> {
    return this.setStatus(input, 'retired')
  }

  /** Runtime-only entry point. Bind every field to the actual host skill-load observation. */
  async recordUse(input: RecordSkillUseInput): Promise<KnowledgeMutationReceipt> {
    const scope = { assistantId: input.assistantId, workspaceId: input.workspaceId }
    const key = skillKey(scope, input.skillId)
    return this.serialize(key, async () => {
      required(input.observationId, 'observationId')
      required(input.taskId, 'taskId')
      required(input.executionId, 'executionId')
      const record = await this.loadRequired(input.skillId, scope)
      const version = findVersion(record, input.version)
      if (version.archivedUses?.some(use => use.taskId === input.taskId && use.executionId === input.executionId)) {
        throw new KnowledgeError('stale', 'This closed execution has already been compacted; it cannot record new skill use.')
      }
      const previous = version.uses.find(use => use.observationId === input.observationId)
      if (previous) {
        if (previous.contentHash !== input.contentHash || previous.taskId !== input.taskId || previous.executionId !== input.executionId) {
          throw new KnowledgeError('rejected', 'An observation id cannot be rebound to another use.')
        }
        return { status: 'duplicate', skillId: record.skillId, version: version.version, revision: record.revision }
      }
      if (record.activeVersion !== input.version || version.status !== 'active' || version.contentHash !== input.contentHash) {
        throw new KnowledgeError('stale', 'This is not the currently published skill version.')
      }
      version.uses.push({
        observationId: input.observationId, skillId: input.skillId, version: input.version,
        contentHash: input.contentHash, taskId: input.taskId, executionId: input.executionId, observedAt: this.now(),
      })
      record.revision += 1
      await this.store.set(key, record)
      this.changed()
      return { status: 'applied', skillId: record.skillId, version: version.version, revision: record.revision }
    })
  }

  async feedback(input: SkillFeedbackInput): Promise<KnowledgeMutationReceipt> {
    return this.change(input, async record => {
      required(input.explanation, 'feedback explanation')
      const version = findVersion(record, input.version)
      const archived = version.archivedFeedback?.find(feedback => feedback.resultId === input.resultId)
      if (archived) {
        if (archived.observationId !== input.observationId || archived.outcome !== input.outcome) throw new KnowledgeError('rejected', 'Archived feedback cannot be rebound to a different observation or outcome.')
        return version.version
      }
      const use = version.uses.find(item => item.observationId === input.observationId)
      if (!use) throw new KnowledgeError('rejected', 'Feedback requires a recorded host skill-load observation.')
      const result = await this.result(input.resultId, input.scope, false)
      if (result.taskId !== use.taskId || result.executionId !== use.executionId) {
        throw new KnowledgeError('rejected', 'The result does not belong to the execution that loaded this skill.')
      }
      const expectedOutcome = result.status === 'accepted' ? 'success' : 'failure'
      if (input.outcome !== expectedOutcome) throw new KnowledgeError('rejected', 'Feedback outcome disagrees with the recorded result.')
      // Multiple loads, transport retries, or different command ids for one result are one outcome.
      const previous = version.feedback.find(item => item.resultId === input.resultId)
      if (previous) {
        if (previous.outcome !== input.outcome) throw new KnowledgeError('rejected', 'This result already has a different outcome.')
        return version.version
      }
      version.feedback.push({
        feedbackId: `feedback:${digest([input.skillId, input.version, input.resultId])}`,
        observationId: input.observationId, resultId: input.resultId, outcome: input.outcome,
        explanation: input.explanation, recordedAt: this.now(),
      })
      return version.version
    })
  }

  async listSkills(scope: KnowledgeScope): Promise<SkillRecord[]> {
    validateScope(scope)
    const records = await this.store.list<SkillRecord>(`${ROOT}skills/${scopeKey(scope)}/`)
    return records.map(item => structuredClone(item.value)).filter(record => sameScope(record.scope, scope))
      .sort((a, b) => a.skillId.localeCompare(b.skillId))
  }

  async getSkill(skillId: string, scope: KnowledgeScope): Promise<SkillRecord | undefined> {
    const record = await this.store.get<SkillRecord>(skillKey(scope, skillId))
    return record && sameScope(record.scope, scope) ? structuredClone(record) : undefined
  }

  async catalog(scope: KnowledgeScope): Promise<ServantSkillDescriptor[]> {
    const records = await this.listSkills(scope)
    return records.flatMap(record => {
      const active = record.versions.find(version => version.version === record.activeVersion && version.status === 'active' && !version.bodyRetiredAt)
      return active ? [{ name: `${SKILL_PREFIX}${record.skillId}`, skillId: record.skillId, version: active.version,
        title: active.title, description: `${active.description}\n适用范围：${active.applicability}`, contentHash: active.contentHash }] : []
    })
  }

  async getSkillBody(name: string, scope: KnowledgeScope, expectedVersion?: number): Promise<string | undefined> {
    if (!name.startsWith(SKILL_PREFIX)) return undefined
    const skillId = name.slice(SKILL_PREFIX.length)
    if (!validId(skillId)) return undefined
    const record = await this.getSkill(skillId, scope)
    if (!record || record.activeVersion === undefined) return undefined
    const active = record.versions.find(version => version.version === record.activeVersion && version.status === 'active' && !version.bodyRetiredAt)
    if (!active || expectedVersion !== undefined && active.version !== expectedVersion) return undefined
    return `# ${active.title}\n\n${active.description}\n\n## 适用范围\n\n${active.applicability}\n\n${active.body}\n`
  }

  async putProjectFact(input: {
    id: string, scope: KnowledgeScope, text: string, sourceResultId: string, expectedRevision?: number,
  }): Promise<ProjectFact> {
    const key = knowledgeKey('facts', input.scope, input.id)
    return this.serialize(key, async () => {
      required(input.text, 'fact text')
      await this.result(input.sourceResultId, input.scope, true)
      const current = await this.store.get<ProjectFact>(key)
      checkRevision(current, input.expectedRevision)
      const record: ProjectFact = {
        schemaVersion: 1, kind: 'project-fact', id: input.id, scope: { ...input.scope },
        revision: (current?.revision ?? 0) + 1, text: input.text, sourceResultId: input.sourceResultId, updatedAt: this.now(),
      }
      await this.store.set(key, record)
      this.changed()
      return structuredClone(record)
    })
  }

  async putPreference(input: {
    id: string, scope: KnowledgeScope, text: string, applicability: string,
    userSourceRef: string, expectedRevision?: number,
  }): Promise<Preference> {
    const key = knowledgeKey('preferences', input.scope, input.id)
    return this.serialize(key, async () => {
      required(input.text, 'preference text')
      required(input.applicability, 'preference applicability')
      required(input.userSourceRef, 'user source')
      const source = await this.evidence.resolveUserSource?.(input.userSourceRef)
      if (!source || !sameScope(source, input.scope)) throw new KnowledgeError('rejected', 'A lasting preference requires a verified user message in this scope.')
      const current = await this.store.get<Preference>(key)
      checkRevision(current, input.expectedRevision)
      const record: Preference = {
        schemaVersion: 1, kind: 'preference', id: input.id, scope: { ...input.scope },
        revision: (current?.revision ?? 0) + 1, text: input.text, applicability: input.applicability,
        userSourceRef: input.userSourceRef, updatedAt: this.now(),
      }
      await this.store.set(key, record)
      this.changed()
      return structuredClone(record)
    })
  }

  async list(scope: KnowledgeScope): Promise<KnowledgeRecord[]> {
    validateScope(scope)
    const [skills, facts, preferences] = await Promise.all([
      this.listSkills(scope),
      this.store.list<ProjectFact>(`${ROOT}facts/${scopeKey(scope)}/`),
      this.store.list<Preference>(`${ROOT}preferences/${scopeKey(scope)}/`),
    ])
    return structuredClone([...skills, ...facts.map(item => item.value), ...preferences.map(item => item.value)])
      .filter(record => sameScope(record.scope, scope))
  }

  private async setStatus(input: SkillStatusInput, status: 'disabled' | 'retired'): Promise<KnowledgeMutationReceipt> {
    return this.change(input, record => {
      required(input.reason, 'status reason')
      const version = findVersion(record, input.version)
      version.status = status
      version.statusReason = input.reason
      if (record.activeVersion === version.version) delete record.activeVersion
      return version.version
    })
  }

  private async change<T extends { commandId: string, skillId: string, scope: KnowledgeScope }>(
    input: T, mutate: (record: SkillRecord) => Promise<number> | number,
  ): Promise<KnowledgeMutationReceipt> {
    const key = skillKey(input.scope, input.skillId)
    return this.serialize(key, async () => {
      required(input.commandId, 'commandId')
      const fingerprint = digest(input)
      const record = await this.loadRequired(input.skillId, input.scope)
      const duplicate = this.receipt(record, input.commandId, fingerprint)
      if (duplicate) return duplicate
      const version = await mutate(record)
      return this.commit(key, record, input.commandId, fingerprint, version)
    })
  }

  private async commit(key: string, record: SkillRecord, commandId: string, fingerprint: string, version: number): Promise<KnowledgeMutationReceipt> {
    record.revision += 1
    Object.defineProperty(record.receipts, commandId, {
      value: { commandId, fingerprint, revision: record.revision, version },
      enumerable: true, configurable: true, writable: true,
    })
    await this.store.set(key, record)
    this.changed()
    return { status: 'applied', skillId: record.skillId, version, revision: record.revision }
  }

  private receipt(record: SkillRecord | undefined, commandId: string, fingerprint: string): KnowledgeMutationReceipt | undefined {
    if (!record) return undefined
    const receipt = Object.hasOwn(record.receipts, commandId) ? record.receipts[commandId] : undefined
    if (!receipt) return undefined
    if (receipt.fingerprint !== fingerprint) throw new KnowledgeError('rejected', 'A command id cannot be reused with a different payload.')
    return { status: 'duplicate', skillId: record.skillId, version: receipt.version, revision: receipt.revision }
  }

  private async loadRequired(skillId: string, scope: KnowledgeScope): Promise<SkillRecord> {
    const record = await this.getSkill(skillId, scope)
    if (!record) throw new KnowledgeError('not_found', 'No Servant skill exists at this identity and scope.')
    return record
  }

  private async result(resultId: string, scope: KnowledgeScope, acceptedOnly: boolean): Promise<KnowledgeResultEvidence> {
    required(resultId, 'source result')
    validateScope(scope)
    const result = await this.evidence.resolveResult(resultId)
    if (!result || result.resultId !== resultId || !sameScope(result, scope)) {
      throw new KnowledgeError('rejected', 'The result does not exist in this assistant and workspace.')
    }
    if (result.status === 'pending' || acceptedOnly && result.status !== 'accepted') {
      throw new KnowledgeError('rejected', acceptedOnly ? 'Promotion requires an actually accepted result.' : 'The result has not been evaluated.')
    }
    return result
  }

  private makeVersion(input: ProposeSkillInput, version: number): SkillVersion {
    return {
      skillId: input.skillId, version, title: input.title, description: input.description,
      body: input.body, applicability: input.applicability, scope: { ...input.scope }, contentHash: skillContentHash(input),
      status: 'candidate', createdAt: this.now(), sourceResultIds: [input.sourceResultId],
      validations: [], uses: [], feedback: [],
    }
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const barrier = this.maintenanceBarrier
    const next = Promise.all([previous.catch(() => undefined), barrier]).then(operation)
    this.queues.set(key, next)
    this.writes.add(next)
    try { return await next } finally { this.writes.delete(next); if (this.queues.get(key) === next) this.queues.delete(key) }
  }

  private async compactForRetention(input: SkillCompactionRequest): Promise<SkillCompactionResult> {
    const key = skillKey(input.scope, input.skillId)
    const record = await this.loadRequired(input.skillId, input.scope)
    if (record.revision !== input.expectedRevision) return { status: 'stale', reclaimedBytes: 0 }
    if (input.maxReceipts !== undefined && (!Number.isInteger(input.maxReceipts) || input.maxReceipts < 1)) throw new KnowledgeError('rejected', 'Retention requires a positive receipt budget when set.')
    const beforeJson = JSON.stringify(record)
    const before = jsonBytes(record)
    const latest = record.versions.at(-1)!.version
    const prune = new Set(input.pruneVersions)
    const archivedTasks = new Set(input.archivedTaskIds)
    const retireBodies = new Set(input.retireBodies ?? [])
    for (const version of record.versions) if (prune.has(version.version)) {
      if (version.version === latest || version.version === record.activeVersion || version.status === 'active'
        || version.uses.length || version.validations.length || version.feedback.length || version.archivedUses?.length || version.archivedFeedback?.length) {
        throw new KnowledgeError('rejected', 'Active, latest, used or evidence-bearing skill versions cannot be pruned.')
      }
    }
    for (const version of record.versions) if (retireBodies.has(version.version)) {
      if (version.version === record.activeVersion || version.status === 'active' || version.uses.some(use => !archivedTasks.has(use.taskId))) {
        throw new KnowledgeError('rejected', 'Active skill bodies or bodies still used by a nonarchived Task cannot be retired.')
      }
    }
    record.versions = record.versions.filter(version => !prune.has(version.version))
    for (const version of record.versions) {
      if (retireBodies.has(version.version) && !version.bodyRetiredAt) { version.body = ''; version.bodyRetiredAt = this.now() }
      const archivedUses = version.archivedUses ?? []
      const archivedFeedback = version.archivedFeedback ?? []
      const uses = new Map(version.uses.map(use => [use.observationId, use]))
      for (const use of version.uses) {
        if (!archivedTasks.has(use.taskId)) continue
        const summary = archivedUses.find(item => item.taskId === use.taskId && item.executionId === use.executionId)
        if (summary) {
          summary.observedLoads += 1
          if (use.observedAt < summary.firstObservedAt) summary.firstObservedAt = use.observedAt
          if (use.observedAt > summary.lastObservedAt) summary.lastObservedAt = use.observedAt
        } else archivedUses.push({ taskId: use.taskId, executionId: use.executionId, contentHash: use.contentHash,
          observedLoads: 1, firstObservedAt: use.observedAt, lastObservedAt: use.observedAt })
      }
      version.feedback = version.feedback.filter(feedback => {
        const use = uses.get(feedback.observationId)
        if (!use || !archivedTasks.has(use.taskId)) return true
        const { explanation: _explanation, ...thin } = feedback
        archivedFeedback.push({ ...thin, taskId: use.taskId, executionId: use.executionId })
        return false
      })
      version.uses = version.uses.filter(use => !archivedTasks.has(use.taskId))
      if (archivedUses.length) version.archivedUses = archivedUses
      if (archivedFeedback.length) version.archivedFeedback = archivedFeedback
    }
    if (input.maxReceipts !== undefined) {
      const receipts = Object.entries(record.receipts).sort(([, left], [, right]) => right.revision - left.revision)
      record.receipts = Object.fromEntries(receipts.slice(0, input.maxReceipts))
    }
    if (JSON.stringify(record) === beforeJson) return { status: 'unchanged', reclaimedBytes: 0 }
    record.revision += 1
    await this.store.set(key, record)
    this.changed()
    return { status: 'applied', reclaimedBytes: Math.max(0, before - jsonBytes(record)) }
  }

  private changed(): void {
    // UI/catalog invalidation is a notification after durable success, never a second commit gate.
    for (const listener of this.listeners) { try { listener() } catch { /* a subscriber cannot undo the commit */ } }
  }
}

export function skillContentHash(input: Pick<ProposeSkillInput, 'title' | 'description' | 'body' | 'applicability' | 'scope'>): string {
  return digest({ title: input.title, description: input.description, body: input.body, applicability: input.applicability, scope: input.scope })
}

function digest(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex') }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function validId(value: string): boolean { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value) }
function required(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new KnowledgeError('rejected', `${label} is required.`)
}
function validateScope(scope: KnowledgeScope): void {
  if (!scope || typeof scope !== 'object') throw new KnowledgeError('rejected', 'Knowledge scope is required.')
  required(scope.assistantId, 'assistantId')
  required(scope.workspaceId, 'workspaceId')
}
function sameScope(a: KnowledgeScope, b: KnowledgeScope): boolean { return a.assistantId === b.assistantId && a.workspaceId === b.workspaceId }
function scopeKey(scope: KnowledgeScope): string { return `${encodeURIComponent(scope.assistantId)}/${encodeURIComponent(scope.workspaceId)}` }
function knowledgeKey(type: string, scope: KnowledgeScope, id: string): string {
  validateScope(scope)
  if (!validId(id)) throw new KnowledgeError('rejected', 'Knowledge ids must be lowercase kebab-case.')
  return `${ROOT}${type}/${scopeKey(scope)}/${id}`
}
function skillKey(scope: KnowledgeScope, id: string): string { return knowledgeKey('skills', scope, id) }
function validateProposal(input: ProposeSkillInput): void {
  required(input.commandId, 'commandId')
  required(input.title, 'title')
  required(input.description, 'description')
  required(input.body, 'body')
  required(input.applicability, 'applicability')
  validateScope(input.scope)
}
function findVersion(record: SkillRecord, version: number): SkillVersion {
  const found = record.versions.find(item => item.version === version)
  if (!found) throw new KnowledgeError('not_found', 'The requested skill version does not exist.')
  return found
}
function checkRevision(record: { revision: number } | undefined, expected: number | undefined): void {
  if (record && expected === undefined || expected !== undefined && expected !== (record?.revision ?? 0)) {
    throw new KnowledgeError('stale', 'Read the current knowledge revision before replacing it.')
  }
}
