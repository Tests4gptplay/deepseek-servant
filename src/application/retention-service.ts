import { createHash, randomUUID } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type { KnowledgeScope, SkillRecord, SkillVersion } from '../contracts/knowledge.js'
import type { Task } from '../contracts/task.js'
import {
  defaultRetentionPolicy, parseRetentionPolicy, type KnowledgeMaintenanceSession, type KnowledgeRetentionPort,
  type NativeSessionRetentionPort, type RetentionConfiguration, type RetentionPolicy,
  type RetentionPreview,
  type RetentionSweepResult, type TaskRetentionPort, type TaskTombstone, type StorageUsageStats,
} from '../contracts/retention.js'
import { calculateStorageUsage } from './storage-usage.js'
import { applyRetentionCommand, jsonBytes, retentionBlockers } from '../domain/retention.js'

const POLICY_KEY = 'retention/policy'
const DAY = 86_400_000
export interface RetentionServiceOptions {
  store: StoragePort
  tasks: TaskRetentionPort
  knowledge: KnowledgeRetentionPort
  nativeSessions?: NativeSessionRetentionPort
  now?: () => string
  onChanged?: () => void
  completedTasks?: Pick<import('./task-service.js').TaskService, 'cleanupCompleted' | 'archives'>
}

/** Local record maintenance. It never runs models, deletes artifact files, or edits native Skills. */
export class RetentionService {
  private serial: Promise<unknown> = Promise.resolve()
  private readonly previews = new Map<string, RetentionPreview>()
  constructor(private readonly options: RetentionServiceOptions) {}
  private now(): string { return this.options.now?.() ?? new Date().toISOString() }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.catch(() => undefined).then(work)
    this.serial = next
    return next
  }
  /** Read-only storage figures; one snapshot of this plugin's own domain keys. */
  async stats(): Promise<StorageUsageStats> {
    return calculateStorageUsage(await this.options.store.list<unknown>(''), this.now())
  }

  async configuration(): Promise<RetentionConfiguration> {
    return await this.options.store.get<RetentionConfiguration>(POLICY_KEY)
      ?? { schemaVersion: 1, revision: 0, policy: { ...defaultRetentionPolicy }, updatedAt: this.now() }
  }
  configure(policy: RetentionPolicy, expectedRevision?: number): Promise<RetentionConfiguration> {
    return this.enqueue(async () => {
      const normalized = parseRetentionPolicy(policy)
      const current = await this.configuration()
      if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error('Retention settings changed; refresh before saving.')
      const next: RetentionConfiguration = { schemaVersion: 1, revision: current.revision + 1, policy: normalized, updatedAt: this.now() }
      await this.options.store.set(POLICY_KEY, next)
      this.changed()
      return next
    })
  }
  async preview(input: { scope?: KnowledgeScope; manual?: boolean } = {}): Promise<RetentionPreview> {
    return this.options.knowledge.withRetentionLock(session => this.makePreview(session, input.scope, input.manual))
  }
  sweep(input: { previewId?: string; scope?: KnowledgeScope; manual?: boolean } = {}): Promise<RetentionSweepResult> {
    return this.enqueue(async () => {
      if (this.options.completedTasks) return this.sweepCompleted(input)
      const startedAt = this.now()
      const requested = input.previewId ? this.previews.get(input.previewId) : undefined
      if (input.previewId && (!requested || !requested.manual && Date.parse(startedAt) - Date.parse(requested.createdAt) > 15 * 60_000)) throw new Error('The cleanup preview expired; request a new preview.')
      const manual = requested?.manual ?? input.manual ?? false
      const scope = requested?.scope ?? input.scope
      const result: Omit<RetentionSweepResult, 'remaining'> = {
        startedAt, finishedAt: startedAt, archivedTasks: [], deletedArchives: [], compactedSkills: [],
        retiredNativeSessions: [], nativeLogsRetained: [], skipped: [], reclaimedServantBytes: 0, nativeReclaimedBytes: 0,
      }
      let plan!: RetentionPreview
      let startingBytes = 0
      await this.options.knowledge.withRetentionLock(async session => {
        const fresh = await this.makePreview(session, scope, manual)
        startingBytes = fresh.totals.servantBytes
        if (!manual && requested && requested.policyRevision !== fresh.policyRevision) throw new Error('The retention policy changed after this preview.')
        plan = requested ?? fresh
        const freshSkills = new Map(fresh.compactSkills.map(item => [skillKey(item), item]))
        for (const candidate of plan.compactSkills) {
          const current = freshSkills.get(skillKey(candidate))
          if (!current || current.expectedRevision !== candidate.expectedRevision) { result.skipped.push({ id: candidate.skillId, reason: 'Skill changed after preview.' }); continue }
          try {
            const compacted = await session.compactSkill(candidate)
            if (compacted.status === 'applied') { result.compactedSkills.push(candidate.skillId); result.reclaimedServantBytes += compacted.reclaimedBytes }
          } catch (error) { result.skipped.push({ id: candidate.skillId, reason: message(error) }) }
        }
        const pins = manual ? new Set<string>() : await this.resultPins(session)
        const freshTasks = new Map(fresh.archiveTasks.map(item => [item.taskId, item]))
        for (const candidate of plan.archiveTasks) {
          const current = freshTasks.get(candidate.taskId)
          if (!current || current.expectedRevision !== candidate.expectedRevision) { result.skipped.push({ id: candidate.taskId, reason: 'Task changed after preview.' }); continue }
          const task = await this.options.tasks.get(candidate.taskId)
          if (!task) continue
          try {
            const receipt = await this.options.tasks.execute(task.id, {
              type: 'task.archive', commandId: `archive:${digest([task.id, task.revision])}`, source: { kind: 'runtime', id: 'servant-retention' },
              expectedRevision: task.revision, purgeId: purgeId(task), retainedResultIds: Object.keys(task.reports).filter(id => pins.has(id)),
            })
            if (receipt.status === 'applied' || receipt.status === 'duplicate') {
              result.archivedTasks.push(task.id)
              const archived = await this.options.tasks.get(task.id)
              if (archived) result.reclaimedServantBytes += Math.max(0, jsonBytes(task) - jsonBytes(archived))
            } else result.skipped.push({ id: task.id, reason: receipt.reason ?? receipt.status })
          } catch (error) { result.skipped.push({ id: task.id, reason: message(error) }) }
        }
      })

      // Native retirement follows the committed manifest. A crash before its
      // receipt is retried idempotently; an unsupported erasure is never assumed.
      const allowedTasks = new Set([...plan.nativeCleanup.map(item => item.taskId), ...result.archivedTasks])
      for (const taskId of allowedTasks) await this.retireNative(taskId, result)

      await this.options.knowledge.withRetentionLock(async session => {
        const pins = manual ? new Set<string>() : await this.resultPins(session)
        for (const candidate of plan.deleteArchives) {
          const task = await this.options.tasks.get(candidate.taskId)
          if (!task?.archive || task.archive.purgeId !== candidate.purgeId) { result.skipped.push({ id: candidate.taskId, reason: 'Archive changed after preview.' }); continue }
          try {
            const removed = await this.options.tasks.deleteArchived(task.id, task.revision, task.archive.purgeId, [...pins])
            if (removed.status === 'deleted') { result.deletedArchives.push(task.id); result.reclaimedServantBytes += removed.reclaimedBytes ?? 0 }
            else result.skipped.push({ id: task.id, reason: removed.reason ?? removed.status })
          } catch (error) { result.skipped.push({ id: task.id, reason: message(error) }) }
        }
      })
      this.changed()
      const remaining = await this.preview({ scope, manual })
      return { ...result, reclaimedServantBytes: Math.max(0, startingBytes - remaining.totals.servantBytes), finishedAt: this.now(), remaining }
    })
  }

  private async sweepCompleted(input: { previewId?: string; scope?: KnowledgeScope; manual?: boolean }): Promise<RetentionSweepResult> {
    const requested = input.previewId ? this.previews.get(input.previewId) : undefined
    if (input.previewId && !requested) throw new Error('请重新查看本次清理范围。')
    const scope = requested?.scope ?? input.scope, startedAt = this.now()
    const manual = requested?.manual ?? input.manual ?? false
    const fresh = await this.preview({ scope, manual }), plan = requested ?? fresh
    if (!manual && plan.policyRevision !== fresh.policyRevision) throw new Error('The retention policy changed after this preview.')
    const archivedTasks: string[] = [], deletedArchives: string[] = [], compactedSkills: string[] = []
    const skipped: Array<{ id: string; reason: string }> = []
    const allowed = new Map([...fresh.archiveTasks, ...fresh.deleteArchives].map(row => [row.taskId, row.expectedRevision]))
    for (const candidate of plan.archiveTasks) {
      if (allowed.get(candidate.taskId) !== candidate.expectedRevision) { skipped.push({ id: candidate.taskId, reason: 'Task changed after preview.' }); continue }
      try {
        if (await this.options.completedTasks!.cleanupCompleted(candidate.taskId)) archivedTasks.push(candidate.taskId)
        else if (!(await this.options.completedTasks!.archives.index(candidate.taskId))?.cleanedAt)
          skipped.push({ id: candidate.taskId, reason: '任务仍有尚未结束的执行或作业。' })
      } catch (error) { skipped.push({ id: candidate.taskId, reason: message(error) }) }
    }
    await this.options.completedTasks!.archives.resumeCleanup()
    for (const candidate of plan.deleteArchives) {
      if (allowed.get(candidate.taskId) !== candidate.expectedRevision) continue
      if (!(await this.options.completedTasks!.archives.index(candidate.taskId))?.cleanedAt) continue
      await this.options.completedTasks!.archives.hide(candidate.taskId)
      deletedArchives.push(candidate.taskId)
    }
    await this.options.knowledge.withRetentionLock(async session => {
      const current = await this.makePreview(session, scope, manual)
      for (const candidate of plan.compactSkills) {
        const fresh = current.compactSkills.find(row => skillKey(row) === skillKey(candidate))
        if (!fresh || fresh.expectedRevision !== candidate.expectedRevision) { skipped.push({ id: candidate.skillId, reason: 'Skill changed after preview.' }); continue }
        try {
          if ((await session.compactSkill(fresh)).status === 'applied') compactedSkills.push(candidate.skillId)
        } catch (error) { skipped.push({ id: candidate.skillId, reason: message(error) }) }
      }
    })
    const remaining = await this.preview({ scope, manual })
    this.changed()
    return { startedAt, finishedAt: this.now(), archivedTasks, deletedArchives, compactedSkills,
      retiredNativeSessions: [], nativeLogsRetained: [], skipped,
      reclaimedServantBytes: Math.max(0, fresh.totals.servantBytes - remaining.totals.servantBytes), nativeReclaimedBytes: 0, remaining }
  }

  private async retireNative(taskId: string, result: Omit<RetentionSweepResult, 'remaining'>): Promise<void> {
    let task = await this.options.tasks.get(taskId)
    if (!task?.archive) return
    for (const item of task.archive.sessions) {
      if (item.state === 'archived' || item.state === 'absent') continue
      const native = this.options.nativeSessions
      if (!native) { result.skipped.push({ id: item.sessionId, reason: 'Native Session retirement is unavailable; its manifest is retained.' }); continue }
      try {
        const retired = await native.retire(item.sessionId)
        const facts = (await native.catalog([item.sessionId])).find(fact => fact.sessionId === item.sessionId)
        task = await this.options.tasks.get(taskId)
        if (!task?.archive) return
        const receipt = await this.options.tasks.execute(task.id, {
          type: 'task.purgeArchive', commandId: `retire:${digest([task.archive.purgeId, item.sessionId, retired.status])}`,
          source: { kind: 'runtime', id: 'servant-retention' }, expectedRevision: task.revision, purgeId: task.archive.purgeId,
          session: { sessionId: item.sessionId, state: retired.status, logRetained: retired.logRetained,
            ...(facts?.sizeBytes === undefined ? {} : { retainedBytes: facts.sizeBytes }) },
        })
        if (receipt.status !== 'applied' && receipt.status !== 'duplicate') throw new Error(receipt.reason ?? receipt.status)
        result.retiredNativeSessions.push(item.sessionId)
        if (retired.logRetained) result.nativeLogsRetained.push(item.sessionId)
        result.nativeReclaimedBytes += retired.reclaimedBytes
      } catch (error) {
        const reason = message(error)
        result.skipped.push({ id: item.sessionId, reason })
        task = await this.options.tasks.get(taskId)
        if (task?.archive) {
          try {
            await this.options.tasks.execute(task.id, { type: 'task.purgeArchive', commandId: `retire-blocked:${digest([task.archive.purgeId, item.sessionId, task.revision])}`,
              source: { kind: 'runtime', id: 'servant-retention' }, expectedRevision: task.revision, purgeId: task.archive.purgeId,
              session: { ...item, state: 'blocked', logRetained: true, reason } })
          } catch { /* The durable pending manifest already guarantees another safe retry. */ }
        }
      }
    }
  }

  private async makePreview(session: KnowledgeMaintenanceSession, scope?: KnowledgeScope, manual = false): Promise<RetentionPreview> {
    const [configuration, liveTasks, skills, rows] = await Promise.all([
      this.configuration(), this.options.tasks.list(), session.listSkills(), this.options.store.list<unknown>(''),
    ])
    const sealed = this.options.completedTasks ? await this.options.completedTasks.archives.list() : []
    const historical = this.options.completedTasks ? (await Promise.all(sealed.filter(index => index.tombstone && !index.hidden)
      .map(index => this.options.completedTasks!.archives.task(index.taskId)))).filter((task): task is Task => !!task) : []
    const allTasks = [...new Map([...historical, ...liveTasks].map(task => [task.id, task])).values()]
    // Manual cleanup targets ended Tasks immediately and leaves knowledge and settings unchanged.
    const policy: RetentionPolicy = manual ? { taskDetailDays: 0, archiveDays: 0 } : parseRetentionPolicy(configuration.policy)
    const taskRetentionEnabled = policy.taskDetailDays !== undefined || policy.archiveDays !== undefined
      || policy.maxArchives !== undefined || policy.maxServantBytes !== undefined
    const now = this.now()
    const inScope = (task: Task) => !scope || task.assistantId === scope.assistantId && task.workspace.id === scope.workspaceId
    const tasks = allTasks.filter(inScope).sort((a, b) => terminalAt(a).localeCompare(terminalAt(b)))
    const pins = manual ? new Set<string>() : await this.resultPins(session, skills, rows)
    const endedIds = new Set(sealed.filter(index => index.stage === 'ended').map(index => index.taskId))
    const archives = allTasks.filter(task => !!task.archive || endedIds.has(task.id))
    const archivedTaskIds = [...new Set([...archives.map(task => task.id), ...endedIds])]
    const tombstones = rows.map(row => row.value).filter(isTombstone)
    const totals: RetentionPreview['totals'] = {
      servantBytes: rows.reduce((sum, row) => sum + jsonBytes(row.value), 0),
      taskBytes: rows.filter(row => row.key.startsWith('task:') && !isTombstone(row.value)).reduce((sum, row) => sum + jsonBytes(row.value), 0),
      knowledgeBytes: rows.filter(row => row.key.startsWith('knowledge/')).reduce((sum, row) => sum + jsonBytes(row.value), 0),
      assistantBytes: rows.filter(row => row.key.startsWith('assistant/')).reduce((sum, row) => sum + jsonBytes(row.value), 0),
      tombstoneBytes: tombstones.reduce((sum, item) => sum + jsonBytes(item), 0),
      detailedTasks: allTasks.length - archives.length, archivedTasks: archives.length,
      pinnedArchives: archives.filter(task => Object.keys(task.reports).some(id => pins.has(id))).length,
      nativeSessionBytes: tombstones.reduce((sum, item) => sum + (item.nativeBytesRetained ?? 0), 0),
      nativeSizeUnknown: tombstones.reduce((sum, item) => sum + (item.nativeSizeUnknown ?? 0), 0), nativeRetainedSessions: tombstones.reduce((sum, item) => sum + (item.nativeLogsRetained ?? 0), 0),
      foregroundSessionBytes: 0, foregroundSizeUnknown: 0,
      estimatedReclaimedBytes: 0, overBudgetBytes: 0,
    }
    const plan: RetentionPreview = { previewId: `retention-${randomUUID()}`, createdAt: now, policyRevision: configuration.revision,
      manual, policy: structuredClone(configuration.policy), ...(scope ? { scope: { ...scope } } : {}), archiveTasks: [], deleteArchives: [], compactSkills: [], nativeCleanup: [], blocked: [], totals }
    const bytePressure = policy.maxServantBytes !== undefined && totals.servantBytes > policy.maxServantBytes
    let countPressure = policy.maxArchives === undefined ? 0 : Math.max(0, allTasks.filter(task => ['completed', 'cancelled'].includes(task.phase)).length - policy.maxArchives)
    for (const task of tasks) {
      const blockers = retentionBlockers(task)
      if (blockers.length) { plan.blocked.push({ id: task.id, kind: 'task', bytes: jsonBytes(task), reasons: blockers }); continue }
      let projected = task
      const age = ageDays(now, terminalAt(task))
      const detailExpires = policy.taskDetailDays !== undefined && age >= policy.taskDetailDays
      const historyExpires = policy.archiveDays !== undefined && age >= policy.archiveDays
      if (this.options.completedTasks) {
        const index = sealed.find(row => row.taskId === task.id)
        if (!index?.cleanedAt) plan.archiveTasks.push({ taskId: task.id, expectedRevision: task.revision, retainResultIds: [], estimatedReclaimedBytes: 0 })
        if (manual || detailExpires || historyExpires || countPressure > 0 || bytePressure) {
          plan.deleteArchives.push({ taskId: task.id, expectedRevision: task.revision, purgeId: 'records:' + task.id, estimatedReclaimedBytes: 0 })
          if (countPressure > 0) countPressure--
        }
        continue
      }
      if (!task.archive && (detailExpires || historyExpires || bytePressure || countPressure > 0)) {
        const retained = Object.keys(task.reports).filter(id => pins.has(id))
        projected = structuredClone(task)
        const transition = applyRetentionCommand(projected, { type: 'task.archive', commandId: 'retention-preview', source: { kind: 'runtime', id: 'servant-retention' },
          expectedRevision: task.revision, purgeId: purgeId(task), retainedResultIds: retained }, now)
        if (!transition.ok) { plan.blocked.push({ id: task.id, kind: 'task', bytes: jsonBytes(task), reasons: [transition.reason] }); continue }
        const reclaimed = Math.max(0, jsonBytes(task) - jsonBytes(projected))
        plan.archiveTasks.push({ taskId: task.id, expectedRevision: task.revision, retainResultIds: retained, estimatedReclaimedBytes: reclaimed })
        totals.estimatedReclaimedBytes += reclaimed
      }
      if (!projected.archive) continue
      if (taskRetentionEnabled) for (const item of projected.archive.sessions) if (item.state !== 'archived' && item.state !== 'absent') {
        plan.nativeCleanup.push({ taskId: task.id, purgeId: projected.archive.purgeId, sessionId: item.sessionId })
        if (item.state === 'blocked') plan.blocked.push({ id: item.sessionId, kind: 'native', bytes: item.retainedBytes ?? 0, reasons: [item.reason ?? 'native-retirement'] })
      }
      const pinned = Object.keys(projected.reports).some(id => pins.has(id))
      const expires = historyExpires || countPressure > 0 || bytePressure
      if (pinned) plan.blocked.push({ id: task.id, kind: 'task', bytes: jsonBytes(projected), reasons: ['knowledge-evidence'] })
      else if (expires) {
        const reclaimed = Math.max(0, jsonBytes(projected) - 256)
        plan.deleteArchives.push({ taskId: task.id, expectedRevision: task.revision, purgeId: projected.archive.purgeId, estimatedReclaimedBytes: reclaimed })
        totals.estimatedReclaimedBytes += reclaimed
        if (countPressure > 0) countPressure -= 1
      }
    }
    for (const record of skills) {
      if (scope && !sameScope(record.scope, scope)) continue
      const eligible = record.versions.filter(version => isUnusedHistorical(record, version))
      const excess = policy.maxFullSkillVersions === undefined ? 0 : Math.max(0, eligible.length - policy.maxFullSkillVersions)
      const prune = eligible.filter((version, index) => index < excess || policy.skillHistoryDays !== undefined && ageDays(now, version.createdAt) >= policy.skillHistoryDays)
      const prunedVersions = new Set(prune.map(version => version.version))
      const historicalBodies = record.versions.filter(version => version.version !== record.activeVersion && version.status !== 'active'
        && !version.bodyRetiredAt && version.uses.every(use => archivedTaskIds.includes(use.taskId)) && !prunedVersions.has(version.version))
      const bodyExcess = policy.maxFullSkillVersions === undefined ? 0 : Math.max(0, historicalBodies.length - policy.maxFullSkillVersions)
      const retireBodies = historicalBodies.filter((version, index) => index < bodyExcess || policy.skillHistoryDays !== undefined && ageDays(now, version.createdAt) >= policy.skillHistoryDays)
      const compactHistory = policy.skillHistoryDays !== undefined || policy.maxFullSkillVersions !== undefined
      const archiveUse = compactHistory && record.versions.some(version => version.uses.some(use => archivedTaskIds.includes(use.taskId)))
      const receiptExcess = policy.maxSkillReceipts !== undefined && Object.keys(record.receipts).length > policy.maxSkillReceipts
      if (prune.length || retireBodies.length || archiveUse || receiptExcess) {
        const estimate = prune.reduce((sum, version) => sum + jsonBytes(version), 0) + retireBodies.reduce((sum, version) => sum + jsonBytes(version.body), 0)
        plan.compactSkills.push({ skillId: record.skillId, scope: record.scope, expectedRevision: record.revision,
          pruneVersions: prune.map(version => version.version), retireBodies: retireBodies.map(version => version.version),
          archivedTaskIds: compactHistory ? archivedTaskIds : [],
          ...(policy.maxSkillReceipts === undefined ? {} : { maxReceipts: policy.maxSkillReceipts }), estimatedReclaimedBytes: estimate })
        totals.estimatedReclaimedBytes += estimate
      }
      if (bytePressure) {
        const protectedVersions = record.versions.filter(version => !isUnusedHistorical(record, version))
        if (protectedVersions.length) plan.blocked.push({ id: record.skillId, kind: 'skill', bytes: jsonBytes(protectedVersions), reasons: ['active-latest-used-or-evidence-bearing-version'] })
      }
    }
    const sessionIds = [...new Set(allTasks.flatMap(task => task.archive ? task.archive.sessions.map(item => item.sessionId) : Object.values(task.executions).filter(execution => execution.role !== 'foreground').map(execution => execution.sessionId)))]
    const foregroundIds = [...new Set(rows.filter(row => row.key.startsWith('assistant/')).flatMap(row => {
      const value = row.value
      if (!value || typeof value !== 'object' || !('sessionId' in value) || typeof value.sessionId !== 'string') return []
      const prior = 'priorSessionIds' in value && Array.isArray(value.priorSessionIds) ? value.priorSessionIds.filter((id): id is string => typeof id === 'string') : []
      return [value.sessionId, ...prior]
    }))]
    const nativeFacts = this.options.nativeSessions ? await this.options.nativeSessions.catalog([...new Set([...sessionIds, ...foregroundIds])]) : []
    for (const id of sessionIds) {
      const fact = nativeFacts.find(item => item.sessionId === id)
      if (fact && fact.sizeBytes === undefined || !this.options.nativeSessions) totals.nativeSizeUnknown += 1
      else if (fact?.sizeBytes !== undefined) totals.nativeSessionBytes += fact.sizeBytes
      if (fact?.archived) totals.nativeRetainedSessions += 1
      if (fact?.liveAgent || fact?.liveSession) plan.blocked.push({ id, kind: 'native', bytes: fact.sizeBytes ?? 0, reasons: ['live-native-owner'] })
    }
    for (const id of foregroundIds) {
      const fact = nativeFacts.find(item => item.sessionId === id)
      if (fact?.sizeBytes !== undefined) totals.foregroundSessionBytes += fact.sizeBytes
      else if (fact || !this.options.nativeSessions) totals.foregroundSizeUnknown += 1
    }
    totals.overBudgetBytes = policy.maxServantBytes === undefined ? 0 : Math.max(0, totals.servantBytes - totals.estimatedReclaimedBytes - policy.maxServantBytes)
    this.previews.set(plan.previewId, structuredClone(plan))
    while (this.previews.size > 4) this.previews.delete(this.previews.keys().next().value!)
    return plan
  }

  private async resultPins(session: KnowledgeMaintenanceSession, records?: SkillRecord[], rows?: Array<{ key: string; value: unknown }>): Promise<Set<string>> {
    const skills = records ?? await session.listSkills()
    const pins = new Set<string>()
    for (const record of skills) for (const version of record.versions) {
      for (const id of version.sourceResultIds) pins.add(id)
      for (const validation of version.validations) pins.add(validation.resultId)
      for (const feedback of [...version.feedback, ...version.archivedFeedback ?? []]) pins.add(feedback.resultId)
    }
    for (const row of rows ?? await this.options.store.list<unknown>('knowledge/facts/')) {
      const value = row.value
      if (value && typeof value === 'object' && 'kind' in value && value.kind === 'project-fact' && 'sourceResultId' in value && typeof value.sourceResultId === 'string') pins.add(value.sourceResultId)
    }
    return pins
  }
  private changed(): void { try { this.options.onChanged?.() } catch { /* post-commit invalidation cannot undo cleanup */ } }
}

function terminalAt(task: Task): string { return task.completedAt ?? task.cancelledAt ?? task.delivery?.deliveredAt ?? task.updatedAt }
function ageDays(now: string, since: string): number { const milliseconds = Date.parse(now) - Date.parse(since); return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) / DAY : 0 }
function purgeId(task: Task): string { return `purge-${digest([task.id, task.revision])}` }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32) }
function skillKey(value: { skillId: string; scope: KnowledgeScope }): string { return JSON.stringify([value.scope.assistantId, value.scope.workspaceId, value.skillId]) }
function sameScope(a: KnowledgeScope, b: KnowledgeScope): boolean { return a.assistantId === b.assistantId && a.workspaceId === b.workspaceId }
function isUnusedHistorical(record: SkillRecord, version: SkillVersion): boolean {
  return version.version !== record.versions.at(-1)?.version && version.version !== record.activeVersion && version.status !== 'active'
    && version.uses.length === 0 && version.validations.length === 0 && version.feedback.length === 0
    && !version.archivedUses?.length && !version.archivedFeedback?.length
}
function isTombstone(value: unknown): value is TaskTombstone { return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'task-tombstone' }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
