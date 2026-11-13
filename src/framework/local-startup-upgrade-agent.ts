import { PhysicalLocalFiles } from './physical-local-files.js'
import type { LocalSkillUpgradeReport } from './local-upgrade-skill.js'
import { convertedLocalSkillPath, localUpgradeMappingKey, type LocalUpgradeMapping } from './local-upgrade-mapping.js'
import type { CurrentLocalUpgradeInstance } from './local-upgrade-instance.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { StoragePort } from '../contracts/ports.js'
import { DshAgentGateway, installExecutionGuard } from '../adapters/dsh/agents.js'
import type { DshAgentRequest, DshModelRoute, OwnedDshAgent } from '../adapters/dsh/host-types.js'
import { restoreLegacyTask, type LocalTaskUpgradeReport } from './local-upgrade-task.js'
import { localConversationUpgradeKey, restoreLegacyConversationScope, restoreLegacyConversationSignals, type LocalConversationUpgradeReport } from './local-upgrade-conversation.js'
import { assessLocalUpgradeCompletion, readLocalUpgradeCompleted, retireLocalUpgradeRecords, type LocalUpgradeAssessment, type LocalUpgradeCompleted } from './local-upgrade-completion.js'
import { canonicalLocalLocation } from './local-location.js'
import { auditLocalUpgradeSource, type LocalSourceRetirementAudit } from './local-upgrade-source-audit.js'
import { inspectLegacyLocalInventory, inspectLocalStartupUpgrade, materializeLegacyLocalFiles, readLegacyLocalOriginal,
  type LocalStartupUpgradeReport } from './local-startup-upgrade.js'

const toolName = 'dss_upgrade_local_files'
interface UpgradeWake {
  kind: 'dss-once-local-upgrade'
  operationId: string
  directory: string
  status: 'pending' | 'verified'
  sessionId?: string
  inputId?: string
  result?: LocalStartupUpgradeReport
  assessment?: LocalUpgradeAssessment
  sourceAudit?: LocalSourceRetirementAudit
}
export interface LocalUpgradeAgentResult {
  status: 'not-needed' | 'pending' | 'complete'
  scope: 'local-sql-physical-upgrade'
  pending?: LocalUpgradeAssessment['pending']
  specialStageChoices?: LocalUpgradeAssessment['specialStageChoices']
  retainedSpecialStages?: LocalUpgradeAssessment['retainedSpecialStages']
  report: LocalStartupUpgradeReport
  detail?: string
  sourceDisposition?: 'retained-pending-retirement-review'
  sourceAudit?: LocalSourceRetirementAudit
}
export interface LocalUpgradeAgentConfiguration {
  directory: string
  /** Existing resolved DSS workspace and configured/default native model route. */
  cwd: string
  presetId?: string
  /** Actual taskArchiveHostKey from this existing Local connection. */
  hostKey?: string
  model?: DshModelRoute
  collaborationId?: string
  /** Actual currently selected Local scope, not the Agent's opening snapshot. */
  currentCollaborationId?(): string | undefined
  /** Existing startup source inspection found an old SQL responsibility. */
  onOldSourceFound?(): void
  /** Existing Service opening boundary, used only by an early one-time
   * restore_conversation call before its Local Host has become active. */
  whenLocalOpened?(): Promise<unknown> | undefined
  currentInstance?(): CurrentLocalUpgradeInstance
  onTaskRestoration?(taskId: string, operation: Promise<LocalTaskUpgradeReport>): void
  onConversationRestoration?(scope: string, operation: Promise<LocalConversationUpgradeReport>): void
  onSkillRestoration?(result: LocalSkillUpgradeReport): void
  onMaterialization?(report: LocalStartupUpgradeReport): void
  changed?(): void
}
export const localUpgradeAgentKey = (directory: string): string => 'framework-startup-upgrade-agent/' + createHash('sha256').update(directory).digest('hex')
const prompt = `You are the independent one-time DSS Local upgrade execution, started after DSH activated DSS Host. The user has already authorized this upgrade; do not create a new scope/time confirmation step.
This assignment owns the one-time physical conversion of the existing Local files table and its known layouts. Use dss_upgrade_local_files inspect/status to see the actual source, read to inspect an original, and materialize to invoke the lossless mechanical tool. The tool preserves original bytes, Task IDs, signals, conversation order, custom guides, skills, controls and unknown safe paths. Do not rewrite source text, guess Task ownership, classify unknown content, invent a migration, or delete a source or backup.
Existing physical conflicts and unsafe rows must be preserved and reported specifically. An already exported file is not permission to overwrite later user changes. The exact-path export alone is not completion of Task or skill conversion. Published individual scopes remain independent even while source-retirement review is unfinished. Never describe pending source cleanup as completed or as a permanent fallback.
Use restore_conversation with an actual collaborationId found in the original conversation-index paths to restore that scope's complete message bodies before its new writes. Use restore_task for each exact original tasks/<id>.json identity. The tool preserves its actual running/terminal state and only moves proven released history out of runtime. Use publish_skill to supply the complete native SKILL.md for each exact original skill definition. The approved target is the existing skills/ directory and the same opened Files root's DSS role provider, not Host-global registration or another root. Preserve original scope/participant/source as historical facts; do not create owner roots, extra permission checks or permanent mapping tables from them. The generic materialize tool defers definition paths until this specialized publication verifies them; run materialize again after eligible conversions. Read the complete original record, all real versions/candidates, same-folder SKILL.md, current physical contributions and relevant controls before deciding the full native content. The read result distinguishes current physical bytes from original SQL; do not overwrite later user contributions.
Keep the actually pointed effective active method; never choose the last candidate as active. An absent activeVersion is not missing history: disabled/retired bodies or candidate-only inputs may be explicitly converted after reading their real content, but remain disabled/retired and are not given fabricated validation. Original disabled/retired controls keep their reason and time. Full actual old skill records and distinct original/current native text remain readable as resources; ordinary candidate/resource files stay intact. Existing body-only SKILL.md may be the real shipped rendering, not a new-user conflict. Unknown input without complete retained content, actual name/content/resource conflicts or changed current sources stay specifically pending; continue other independent items. The tool never deletes the original SQL. Finish checks all known conversion work, not merely the file export. Unmapped Task lifecycles or skills stay pending and preserve originals. Only call finish after all assigned conversion work is verified. Oral claims, missing notifications and an idle model are not completion. When blocked, report the actual remaining path and reason. Use audit_source to report exact old-only bytes and non-file recovery obligations for the separate final-retirement review. This tool never deletes or moves original SQL or chooses a permanent backup location. Finish confirms file-layout conversion, not final source disposal. After verified conversion the scoped tools and wake retire; the original SQL and its exact source mapping evidence remain until the outstanding retirement scope is resolved.`

/** An actual native Agent owner, separate from normal task roles. The Host must
 * schedule start() at its activation boundary after selecting the approved Local
 * upgrade scope. This module is deliberately NOT attached to the current legacy
 * SQL-writer startup order. No foreground page, ordinary read, or Git mode starts
 * or waits for it. Configuration comes from existing DSS/native settings. */
export class LocalStartupUpgradeAgent {
  private pending?: Promise<LocalUpgradeAgentResult>
  private readonly skillRestorations = new Map<string, { content: string; work: Promise<LocalSkillUpgradeReport> }>()
  private readonly skillReads = new Map<string, Uint8Array | undefined>()
  private readonly skillInputs = new Set<string>()
  private readonly taskRestorations = new Map<string, Promise<LocalTaskUpgradeReport>>()
  constructor(private readonly ctx: Context, private readonly storage: StoragePort, private readonly config: LocalUpgradeAgentConfiguration,
    private readonly gateway: Pick<DshAgentGateway, 'create' | 'exists' | 'hasLiveOwner'> = new DshAgentGateway(ctx)) {}

  start(signal?: AbortSignal): Promise<LocalUpgradeAgentResult> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.pending) return this.pending
    const work = this.run(signal)
    this.pending = work
    void work.finally(() => { if (this.pending === work) this.pending = undefined }).catch(() => {})
    return work
  }
  /** The existing one-time owner restores only this addressed original Task.
   * UI controls and its native tool share the same in-flight responsibility. */
  restoreTask(taskId: string, signal?: AbortSignal): Promise<LocalTaskUpgradeReport> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!this.config.hostKey) return Promise.reject(new Error('Use the existing Local Host archive identity.'))
    const pending = this.taskRestorations.get(taskId)
    if (pending) return pending
    const operation = restoreLegacyTask(this.config.directory, taskId, this.config.hostKey, this.storage, { signal })
    this.taskRestorations.set(taskId, operation)
    this.config.onTaskRestoration?.(taskId, operation)
    void operation.finally(() => {
      if (this.taskRestorations.get(taskId) === operation) this.taskRestorations.delete(taskId)
      this.config.changed?.()
    }).catch(() => {})
    return operation
  }
  /** UI reads only this already-discovered one-time inventory. */
  pendingSkillPaths(): readonly string[] { return [...this.skillInputs] }
  async skillSelection(path: string): Promise<{ convertedPath?: string; text?: string }> {
    const convertedPath = await convertedLocalSkillPath(this.config.directory, path, this.storage)
    if (convertedPath) return { convertedPath }
    if (!this.skillInputs.has(path)) return {}
    const original = await readLegacyLocalOriginal(this.config.directory, path)
    return original ? { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original.bytes) } : {}
  }
  /** The original scoped tool and addressed publication share one live owner;
   * no UI request launches an Agent or manufactures conversion content. */
  publishSkill(path: string, content: string, signal?: AbortSignal): Promise<LocalSkillUpgradeReport> {
    signal?.throwIfAborted()
    const folder = path.slice(0, path.lastIndexOf('/') + 1), pending = this.skillRestorations.get(folder)
    if (pending) {
      if (pending.content !== content) return Promise.reject(new Error('This skill folder already has an accepted one-time publication. Continue its original content first.'))
      return pending.work
    }
    const wasPending = [...this.skillInputs].some(source => source.slice(0, source.lastIndexOf('/') + 1) === folder)
    const readSources = new Map(this.skillReads)
    const work = import('./local-upgrade-skill.js').then(({ publishLegacyNativeSkill }) =>
      publishLegacyNativeSkill(this.config.directory, path, content, this.storage, { signal, readSources }))
    this.skillRestorations.set(folder, { content, work })
    void work.then(result => {
      if (result.status === 'complete') for (const source of this.skillInputs)
        if (source.slice(0, source.lastIndexOf('/') + 1) === folder) this.skillInputs.delete(source)
      if (wasPending) this.config.onSkillRestoration?.(result)
      this.config.changed?.()
    }).finally(() => { if (this.skillRestorations.get(folder)?.work === work) this.skillRestorations.delete(folder) }).catch(() => {})
    return work
  }
  private async run(signal?: AbortSignal): Promise<LocalUpgradeAgentResult> {
    signal?.throwIfAborted()
    const directory = await canonicalLocalLocation(this.config.directory, true), key = localUpgradeAgentKey(directory)
    const prior = await this.storage.get<UpgradeWake>(key)
    if (prior && (prior.kind !== 'dss-once-local-upgrade' || prior.directory !== directory
      || !prior.operationId || !['pending', 'verified'].includes(prior.status))) throw new Error('The one-time upgrade wake is invalid; its original state was retained.')
    const result = (status: LocalUpgradeAgentResult['status'], report: LocalStartupUpgradeReport): LocalUpgradeAgentResult => ({ status, scope: 'local-sql-physical-upgrade', report, sourceDisposition: 'retained-pending-retirement-review' })
    const completed = await readLocalUpgradeCompleted(directory, this.storage)
    if (completed) {
      if (prior?.sessionId && this.gateway.hasLiveOwner(prior.sessionId)) throw new Error('The completed upgrade still has a live native owner; its wake was retained.')
      const detail = prior || completed.cleanup ? await retireLocalUpgradeRecords(this.storage, completed, key) : undefined
      return { ...result(detail ? 'pending' : 'complete', completed.report), sourceAudit: completed.sourceAudit,
        ...(completed.retainedSpecialStages?.length ? { retainedSpecialStages: completed.retainedSpecialStages } : {}), ...(detail ? { detail } : {}) }
    }
    const initial = await inspectLocalStartupUpgrade(directory, this.storage, { signal })
    if (initial.issues.some(issue => issue.code === 'source-missing'))
      return { ...result('pending', initial), detail: 'The assigned original SQL source is unavailable. Published physical records remain usable; the existing conversion responsibility and remaining files were retained.' }
    if (initial.status === 'not-needed') {
      if (prior) return { ...result('pending', { ...initial, status: 'incomplete', issues: [{ code: 'source-missing', message: 'The original assigned SQL source disappeared before conversion. Its one-time wake was retained.' }] }), detail: 'Assigned source is unavailable.' }
      return result('not-needed', initial)
    }
    // Reuse the real inventory before announcing an old source. An empty
    // original has no migration task; retain the original SQL unchanged.
    const initialInventory = !prior && !initial.operationId ? await inspectLegacyLocalInventory(directory, { signal }) : undefined
    if (initialInventory && !initialInventory.files.length && !initialInventory.issues.length)
      return result('not-needed', { ...initial, status: 'not-needed', issues: [] })
    this.config.onOldSourceFound?.()
    const wake: UpgradeWake = prior ?? { kind: 'dss-once-local-upgrade', operationId: randomUUID(), directory, status: 'pending' }
    const save = () => this.storage.set(key, structuredClone(wake))
    // A verified prior run only needs its own retirement. Do not awaken another
    // model or repeat SQL export merely because Host stopped before compacting.
    if (wake.status === 'verified') {
      if (!wake.result || wake.result.status !== 'complete') throw new Error('Verified upgrade has no completed mechanical report; its wake was retained.')
      if (wake.sessionId && this.gateway.hasLiveOwner(wake.sessionId)) throw new Error('The verified upgrade execution still has a live native owner; its wake was retained until that owner closes.')
      if (!wake.assessment || wake.assessment.pending.length) throw new Error('The verified upgrade has no full conversion assessment; its wake was retained.')
      const completed: LocalUpgradeCompleted = { kind: 'dss-local-upgrade-result', directory, operationId: wake.operationId, completedAt: new Date().toISOString(), report: wake.result, cleanup: wake.assessment.cleanup, sourceAudit: wake.sourceAudit,
        ...(wake.assessment.retainedSpecialStages?.length ? { retainedSpecialStages: wake.assessment.retainedSpecialStages } : {}) }
      const detail = await retireLocalUpgradeRecords(this.storage, completed, key)
      return { ...result(detail ? 'pending' : 'complete', wake.result), sourceAudit: wake.sourceAudit,
        ...(completed.retainedSpecialStages?.length ? { retainedSpecialStages: completed.retainedSpecialStages } : {}), ...(detail ? { detail } : {}) }
    }
    const inventory = initialInventory ?? await inspectLegacyLocalInventory(directory, { signal })
    this.skillInputs.clear()
    for (const file of inventory.files) if (/^skills\/(?:[^/]+\/)+(?:SKILL\.md|record\.json|legacy-git\.json)$/.test(file.path)) {
      const mapped = await this.storage.get<LocalUpgradeMapping>(localUpgradeMappingKey(directory, file.path))
      if (!(mapped?.kind === 'dss-once-source-mapping' && mapped.directory === directory && mapped.sourcePath === file.path
        && mapped.disposition === 'converted' && mapped.targets.includes(file.path.slice(0, file.path.lastIndexOf('/') + 1) + 'SKILL.md'))) this.skillInputs.add(file.path)
    }
    this.config.changed?.()
    wake.sessionId ??= 'dss-local-upgrade-' + randomUUID()
    if (this.gateway.hasLiveOwner(wake.sessionId)) throw new Error('The one-time upgrade session already has a native owner. A second execution was not created.')
    const resume = await this.gateway.exists(wake.sessionId)
    wake.inputId = 'dss-local-upgrade:' + wake.operationId + ':' + randomUUID()
    await save()
    let handle: OwnedDshAgent | undefined, verified = false, closed = false
    let report = initial, pendingDetail: string | undefined, remaining: LocalUpgradeAssessment['pending'] | undefined
    let review: Pick<LocalUpgradeAssessment, 'specialStageChoices' | 'retainedSpecialStages'> | undefined
    const accepted = new Set<Promise<unknown>>()
    const execute = async (raw: unknown, exec: ToolRunContext, agent: Agent): Promise<unknown> => {
      if (closed || exec.agent !== agent) throw new Error('The upgrade tool does not belong to this active one-time Agent.')
      const combined = signal ? AbortSignal.any([signal, exec.signal]) : exec.signal
      combined.throwIfAborted()
      if (!raw || typeof raw !== 'object' || !('action' in raw)) throw new Error('Select an upgrade action.')
      const input = raw as { action: string; path?: unknown; collaborationId?: unknown; taskId?: unknown; content?: unknown }
      if (input.action === 'status') return inspectLocalStartupUpgrade(directory, this.storage, { signal: combined })
      if (input.action === 'inspect') return inventory
      if (input.action === 'read') {
        if (typeof input.path !== 'string' || !input.path) throw new Error('Read one exact original logical path.')
        const original = await readLegacyLocalOriginal(directory, input.path, { signal: combined })
        let currentPhysical: { present: boolean; text?: string; base64?: string } | undefined
        if (input.path.startsWith('skills/') || ['technical/skills/controls.json', 'technical/skills/candidates.json'].includes(input.path)) {
          const files = new PhysicalLocalFiles(directory), view = await files.snapshot()
          try {
            const bytes = await files.readBytes(view, input.path)
            this.skillReads.set(input.path, bytes?.slice())
            currentPhysical = { present: bytes !== undefined }
            if (bytes !== undefined) {
              currentPhysical.base64 = Buffer.from(bytes).toString('base64')
              try { currentPhysical.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch {}
            }
          } finally { await view.release(); await files.close() }
        }
        if (!original) return { source: 'original-sql', path: input.path, present: false, ...(currentPhysical ? { currentPhysical } : {}) }
        let text: string | undefined
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original.bytes) } catch {}
        return { source: 'original-sql', sourcePath: original.sourcePath, path: original.path, present: true,
          representation: original.representation, byteLength: original.bytes.byteLength,
          base64: Buffer.from(original.bytes).toString('base64'), ...(text === undefined ? {} : { text }), ...(currentPhysical ? { currentPhysical } : {}) }
      }
      if (input.action === 'materialize') {
        report = await materializeLegacyLocalFiles(directory, this.storage, { signal: combined, deferActivation: true, currentInstance: this.config.currentInstance?.() })
        this.config.onMaterialization?.(report)
        return { scope: 'sqlite-files-exact-path-export', report, semanticUpgrade: 'not-performed-by-this-tool' }
      }
      if (input.action === 'restore_conversation') {
        if (typeof input.collaborationId !== 'string') throw new Error('Supply the original indexed conversation scope.')
        const operation = restoreLegacyConversationScope(directory, input.collaborationId, this.storage, { signal: combined })
        this.config.onConversationRestoration?.(input.collaborationId, operation)
        const result = await operation
        this.config.changed?.()
        if (result.status !== 'complete') return result
        if (this.config.currentCollaborationId && !this.config.currentCollaborationId()) {
          const opening = this.config.whenLocalOpened?.()
          if (opening) {
            let aborted: (() => void) | undefined
            const cancellation = new Promise<never>((_, reject) => {
              aborted = () => reject(combined.reason)
              combined.addEventListener('abort', aborted, { once: true })
              if (combined.aborted) aborted()
            })
            try { await Promise.race([opening.catch(() => undefined), cancellation]) }
            finally { if (aborted) combined.removeEventListener('abort', aborted) }
            combined.throwIfAborted()
          }
        }
        const signals = await restoreLegacyConversationSignals(directory, input.collaborationId, this.storage,
          () => this.config.currentCollaborationId ? this.config.currentCollaborationId() : this.config.collaborationId, combined, true)
        return { ...result, signals }
      }
      if (input.action === 'restore_task') {
        if (typeof input.taskId !== 'string' || !this.config.hostKey) throw new Error('Use an original Task ID and the existing Local Host archive identity.')
        return this.restoreTask(input.taskId, combined)
      }
      if (input.action === 'publish_skill') {
        if (typeof input.path !== 'string' || typeof input.content !== 'string') throw new Error('Supply the exact original skill definition path and its complete native Markdown definition.')
        return this.publishSkill(input.path, input.content, combined)
      }
      if (input.action === 'audit_source') {
        wake.sourceAudit = await auditLocalUpgradeSource(directory, this.storage, combined)
        await save()
        return wake.sourceAudit
      }
      if (input.action === 'finish') {
        const assessment = await assessLocalUpgradeCompletion(directory, this.storage, combined)
        // The generic exporter correctly retains unconverted STATE, but only
        // the addressed specialist knows why an old chat signal stayed there.
        // Reuse its existing exact-scope receipts during this one-time finish;
        // a cold Agent can recover them without a normal-view read or new scan.
        const genericSignals = new Map(assessment.report.issues.filter(issue => issue.code === 'source-row'
          && issue.path?.startsWith('state/Foreground_') && issue.path.includes('-GMT'))
          .map(issue => [issue.path!, issue.message]))
        if (genericSignals.size) {
          const specific = new Map<string, Set<string>>()
          for (const file of inventory.files) {
            const match = /^conversation-index\/local\/([^/]+)\/index\.json$/.exec(file.path)
            if (!match) continue
            let scope: string
            try { scope = decodeURIComponent(match[1]!) } catch { continue }
            const state = await this.storage.get<{ kind?: string; directory?: string; collaborationId?: string; status?: string;
              signalsAssessed?: { version?: number; pending?: Array<{ path: string; reason: string }> } }>(localConversationUpgradeKey(directory, scope))
            if (state?.kind !== 'dss-once-conversation-full-text' || state.directory !== directory
              || state.collaborationId !== scope || state.status !== 'complete'
              || state.signalsAssessed?.version !== 1 || !Array.isArray(state.signalsAssessed.pending)) continue
            for (const row of state.signalsAssessed.pending) if (genericSignals.has(row.path) && typeof row.reason === 'string') {
              const reasons = specific.get(row.path) ?? new Set<string>()
              reasons.add(row.reason); specific.set(row.path, reasons)
            }
          }
          assessment.pending = assessment.pending.map(row => {
            const reasons = specific.get(row.path)
            return reasons?.size && genericSignals.get(row.path) === row.reason
              ? { ...row, reason: 'Exact old-conversation assessment: ' + [...reasons].join(' | ') + ' The original remains in SQL.' }
              : row
          })
        }
        report = assessment.report; remaining = assessment.pending
        review = { specialStageChoices: assessment.specialStageChoices, retainedSpecialStages: assessment.retainedSpecialStages }
        if (report.status !== 'complete' || assessment.pending.length) return { completed: false, report, pending: assessment.pending }
        const sourceAudit = await auditLocalUpgradeSource(directory, this.storage, combined)
        // A completed conversion does not grant source-disposal authority. Keep
        // every unresolved original/non-file obligation in the durable audit,
        // rather than making an action this tool cannot perform a forever wake.
        // Actual unreadable/unsafe sources still prevent verified completion.
        wake.sourceAudit = sourceAudit; await save()
        remaining = sourceAudit.issues.map(issue => ({ path: issue.path ?? report.sourcePath, reason: issue.message }))
        if (remaining.length) return { completed: false, report, pending: remaining, sourceAudit }
        wake.status = 'verified'; wake.result = report; wake.assessment = assessment; wake.sourceAudit = sourceAudit; await save(); verified = true
        return { completed: true, scope: 'local-sql-physical-upgrade', retainedSource: report.sourcePath, sourceDisposition: sourceAudit.sourceDisposition, sourceAudit }
      }
      throw new Error('Unknown one-time upgrade action.')
    }
    const setup: DshAgentRequest['setup'] = (scope, agent) => {
      scope.systemPrompt.section({ name: 'deepseek-servant:once-local-upgrade', order: 100, interpolate: false, text: prompt })
      // Reuse the native scoped execution hook, not a general permission rule.
      // No shell, task dispatch, or other inherited tool is part of this upgrade.
      const off = installExecutionGuard(scope, agent, (_owner, name) => !closed && name === toolName)
      scope.effect(() => off, 'dss.once-local-upgrade-tools')
      scope.tools.register({ name: toolName,
        description: 'Inspect/read the original Local SQL files, execute their approved lossless exact-path physical export, report conflicts, restore one known conversation body layout, and finish only after all assigned conversions are verified. Unmapped tasks and skills remain pending; originals are never deleted.',
        parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'inspect', 'read', 'materialize', 'restore_conversation', 'restore_task', 'publish_skill', 'audit_source', 'finish'] }, path: { type: 'string' }, collaborationId: { type: 'string' }, taskId: { type: 'string' }, content: { type: 'string' } }, required: ['action'], additionalProperties: false },
        output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: (raw, exec) => {
          const work = execute(raw, exec, agent); accepted.add(work)
          void work.finally(() => accepted.delete(work)).catch(() => {})
          return work
        },
      })
    }
    try {
      signal?.throwIfAborted()
      handle = await this.gateway.create({ sessionId: wake.sessionId, role: 'helper', cwd: this.config.cwd,
        presetId: this.config.presetId, model: this.config.model, resume, signal, setup })
      let interrupt!: (reason: unknown) => void
      const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject })
      void interrupted.catch(() => {})
      let cancellation: Promise<void> | undefined
      const stop = () => {
        cancellation ??= handle!.cancel()
        void cancellation.catch(() => {})
        // Do not wait for an idle event after Host disposal. Native disposal
        // below still owns and drains this exact execution and accepted tools.
        interrupt(signal?.reason ?? new Error('DSS Host disposed during upgrade.'))
      }
      signal?.addEventListener('abort', stop, { once: true })
      try {
        signal?.throwIfAborted()
        await handle.send(prompt + '\nSelected original directory: ' + directory + (this.config.collaborationId ? '\nRestore the currently selected original conversation first, if present: ' + this.config.collaborationId : ''), wake.inputId, 'followup', 'deepseek-servant')
        await Promise.race([handle.whenIdle(), interrupted])
        signal?.throwIfAborted()
        pendingDetail = handle.observe().error?.message
      } finally { signal?.removeEventListener('abort', stop); await cancellation }
    } finally {
      closed = true
      await Promise.allSettled([...accepted])
      // Native scope disposal removes this execution's tool/prompt/hooks. No
      // filesystem tool scripts or recurring wake timer are installed at all.
      await handle?.dispose()
    }
    if (!verified) return { ...result('pending', await inspectLocalStartupUpgrade(directory, this.storage, { signal })), ...(remaining ? { pending: remaining } : {}), ...(review ? { ...review } : {}), ...(wake.sourceAudit ? { sourceAudit: wake.sourceAudit } : {}),
      detail: pendingDetail ?? 'The one-time Agent ended without a verified finish; its wake and original data remain available for continuation.' }
    // Full conversion was verified by the tool, and native disposal above has
    // actually removed the scoped tool/prompt/hooks. Retire its exact wake now.
    const completedResult: LocalUpgradeCompleted = { kind: 'dss-local-upgrade-result', directory, operationId: wake.operationId, completedAt: new Date().toISOString(), report, cleanup: wake.assessment!.cleanup, sourceAudit: wake.sourceAudit,
      ...(wake.assessment!.retainedSpecialStages?.length ? { retainedSpecialStages: wake.assessment!.retainedSpecialStages } : {}) }
    const detail = await retireLocalUpgradeRecords(this.storage, completedResult, key)
    this.skillInputs.clear(); this.skillReads.clear()
    return { ...result(detail ? 'pending' : 'complete', report), sourceAudit: wake.sourceAudit,
      ...(completedResult.retainedSpecialStages?.length ? { retainedSpecialStages: completedResult.retainedSpecialStages } : {}), ...(detail ? { detail } : {}) }
  }
}
