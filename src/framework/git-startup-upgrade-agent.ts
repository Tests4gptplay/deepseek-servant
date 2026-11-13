import { handoffGitUpgradeNative, type GitUpgradeNativeOwner, type GitUpgradeNativeRetirement } from './git-upgrade-native-retirement.js'
import { createHash, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DshAgentGateway, installExecutionGuard } from '../adapters/dsh/agents.js'
import type { DshAgentCreationFailure, DshAgentRequest, DshModelRoute, OwnedDshAgent } from '../adapters/dsh/host-types.js'
import { withSnapshot, type FilesSnapshot, type FilesStore } from './transactions.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { SkillReadBases, type SkillReadBase } from './skill-merge.js'
import { prepareGitLegacySkillConversion } from './git-legacy-skill-conversion.js'

import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installFrameworkSkillProvider, readFrameworkSkillCatalog } from './skills.js'

/** An on-demand diagnostic of this Files root only. It neither mounts a new
 * production sharing hierarchy nor changes any normal provider. Other preset
 * providers in a live role can have different precedence; report that boundary. */
export async function inspectGitUpgradeName(files: FilesStore, name: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const entries = (await readFrameworkSkillCatalog(files, signal)).filter(row => row.name === name)
  const ctx = new Context(); new SkillRegistry(ctx)
  const agent = { id: 'dss-g09-name-inspection', session: {}, options: {} } as Agent
  const scope = createScope(ctx, agent), provider = installFrameworkSkillProvider(scope.ctx, agent, files)
  try {
    const boundary = 'this DSS Files provider only; not other providers in a live role'
    // Await the actual Cordis installation, not repeated availability polling.
    // A stable missing dependency is distinct from an attempted startup failure.
    try { await provider.settleRegistration() }
    catch (error) {
      signal.throwIfAborted()
      return { scope: boundary, entries, selected: null, status: 'registration-failed', diagnostics: [error instanceof Error ? error.message : String(error)] }
    }
    signal.throwIfAborted()
    if (!provider.available()) return { scope: boundary, entries, selected: null, status: 'unavailable', diagnostics: provider.diagnostics() }
    const selected = await ctx.skills.get(name, { scope: agent, signal })
    return { scope: boundary, entries, selected: selected ?? null, status: 'available', diagnostics: [] }
  } finally { await provider.dispose(); await scope.dispose(); await ctx.fiber.dispose() }
}

/** Explicit assignment in the authorized Git Files root. Only the one-time
 * package signal may prepare it; ordinary activation never recreates it. */
export const gitUpgradeWakePath = 'technical/upgrades/g09-skills-once.json'
export interface GitUpgradeItem { sourcePath: string; originals: Array<{ path: string; sha256: string }> }
export interface GitUpgradeWake { version: 1; nativeSessions: string[]; kind: 'dss-g09-git-skills'; operationId: string; pending: GitUpgradeItem[] }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)
const originalPattern = /^skills\/(?:[^/\\\0\r\n]+\/)+(?:record\.json|legacy-git\.json)$/
class GitUpgradePeerObservation extends Error { constructor(readonly targetPath: string, readonly currentContent: string, readonly sameContent: boolean) { super('The assigned item changed outside this proposal. Only its source history and current bytes were verified; this proposal was not confirmed.') } }
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
export function parseGitUpgradeWake(text: string): GitUpgradeWake {
  const wake = JSON.parse(text) as GitUpgradeWake
  if (wake.version !== 1 || wake.kind !== 'dss-g09-git-skills' || typeof wake.operationId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(wake.operationId) || !Array.isArray(wake.pending)) throw new Error('Invalid deployed Git upgrade wake; retained unchanged.')
  if (!Array.isArray(wake.nativeSessions) || new Set(wake.nativeSessions).size !== wake.nativeSessions.length || wake.nativeSessions.some(id => typeof id !== 'string' || !/^dss-git-upgrade-[0-9a-f-]{36}$/.test(id))) throw new Error('Unconfirmed native responsibility field; retain the wake unchanged.')
  const folders = new Set<string>()
  for (const item of wake.pending) {
    if (typeof item.sourcePath !== 'string' || !originalPattern.test(item.sourcePath) || item.sourcePath.split('/').some(p => p === '.' || p === '..')) throw new Error('Invalid assigned original path.')
    const folder = folderOf(item.sourcePath)
    if (folders.has(folder) || !Array.isArray(item.originals) || !item.originals.length || item.originals.length > 2) throw new Error('Duplicate or incomplete assigned folder.')
    folders.add(folder)
    const paths = new Set<string>()
    for (const original of item.originals) {
      if (![folder + 'record.json', folder + 'legacy-git.json'].includes(original.path) || !/^[0-9a-f]{64}$/.test(original.sha256) || paths.has(original.path)) throw new Error('Invalid assigned original hash.')
      paths.add(original.path)
    }
    if (!paths.has(item.sourcePath)) throw new Error('Selected source has no original hash.')
  }
  return wake
}
const prompt = `You are the independent one-time DSS Git skill upgrade Agent, started from the explicit Git wake after the authorized Git Host activated. The deployed Git startup file is the assignment. Use only dss_upgrade_git_skills. Inspect the addressed pending inventory, read each assigned folder's complete originals/current native file, then publish a complete native SKILL.md. Preserve actual effective methods, source/participant/scope text, all history, candidates and disabled/retired controls. Historical identity is source information, not a new runtime access gate. Native skills are shared only among DSS roles using this Files root. Never select the last candidate as active or invent validation. The mechanical tool removes obsolete source JSON in the native conversion commit and maps controls atomically. The original Git parent tree retains the source bytes; source read revisions and paths provide the existing history references. Do not publish whole old files as backup resources. Keep genuinely useful converted methods and relevant provenance in native content. If material is insufficient or conflicts, leave that item pending and continue others. Use inspect_name when actual same-name definitions or unclear references need investigation; it is not a mandatory per-item step. It reports the actual same-root native selection and matching paths. Same names are legal but one can shadow another; inspect original methods and avoid unintended shadowing, rename the proposed native name only where supported by its original meaning and preserve references, or leave the item pending if uncertain. Do not mistake a shadowed file for lost data. No shell, normal task dispatch, Local SQL, catalog completion inference, or new scope/root is allowed. On UNKNOWN repeat publish with the exact same sourcePath and content; do not substitute a new command. If a peer result reports different current content, inspect that content and the referenced originals before judging it; do not claim your proposal was accepted or semantically equivalent. Call finish only after inspect reports no pending items. An idle model is not completion.`
const toolName = 'dss_upgrade_git_skills'
export class GitStartupUpgradeAgent {
  private nativeHandle?: GitUpgradeNativeOwner
  private nativeReport?: GitUpgradeNativeRetirement
  private resolveNativeWake?: () => Promise<void>
  /** While this Host owner remains active, it retains the exact handle/report.
   * This is not durable recovery if Cleaner acceptance itself failed. */
  async retryNativeRetirement(): Promise<GitUpgradeNativeRetirement | undefined> {
    if (!this.nativeHandle) return this.nativeReport
    const result = await handoffGitUpgradeNative(this.ctx, this.nativeHandle, this.nativeReport)
    this.nativeReport = result
    this.config.nativeRetirement?.(result)
    if (result.retirement === 'fulfilled' && result.close === 'closed') {
      await this.resolveNativeWake?.()
      this.nativeHandle = undefined
    }
    return result
  }
  constructor(private readonly ctx: Context, private readonly files: FilesStore, private readonly transactions: FrameworkTransactions,
    private readonly config: { cwd: string; presetId?: string; model?: DshModelRoute; changed?(): void; beforeWakeRetirement?(): Promise<void>; nativeRetirement?(result: GitUpgradeNativeRetirement): void },
    private readonly gateway: Pick<DshAgentGateway, 'create'> = new DshAgentGateway(ctx)) {}
  async start(signal: AbortSignal): Promise<'not-needed' | 'pending' | 'complete' | 'converted-native-pending'> {
    signal.throwIfAborted()
    const initial = await withSnapshot(this.files, s => this.files.read(s, gitUpgradeWakePath), { signal })
    if (initial === undefined) return 'not-needed'
    const assigned = parseGitUpgradeWake(initial)
    const currentWake = async (s: FilesSnapshot) => {
      const text = await this.files.read(s, gitUpgradeWakePath)
      if (text === undefined) return undefined
      const value = parseGitUpgradeWake(text)
      if (value.operationId !== assigned.operationId) throw new Error('The deployed upgrade assignment changed; retain the new wake.')
      return value
    }
    // The assignment and native content change atomically. Existing original
    // read revisions address Git history, not a new permanent index. Even when
    // history is readable, current target existence is not proof of this proposal.
    const sourceHistoryMatches = async (s: FilesSnapshot, item: GitUpgradeItem, bases: ReadonlyMap<string, SkillReadBase>) => {
      if (typeof bases.get(item.sourcePath)?.text !== 'string') return false
      const wake = await currentWake(s)
      if (wake?.pending.some(row => row.sourcePath === item.sourcePath)) return false
      const git = this.files as FilesStore & { at?(revision: string): Promise<FilesSnapshot> }
      if (!git.at) return false
      for (const original of [...bases.values()].filter(row => row.text !== null && /(?:record|legacy-git)\.json$/.test(row.path))) {
        if (await this.files.readBytes(s, original.path) !== undefined) return false
        const historical = await git.at(original.revision)
        try {
          const bytes = await this.files.readBytes(historical, original.path)
          if (bytes === undefined || hash(bytes) !== hash(original.text!)) return false
        } finally { await historical.release() }
      }
      return await this.files.read(s, folderOf(item.sourcePath) + 'SKILL.md') !== undefined
    }
    let resolvedOwnNative = false
    let closed = false, verified = assigned.pending.length === 0, handle: OwnedDshAgent | undefined
    const accepted = new Set<Promise<unknown>>(), reads = new SkillReadBases()
    const submissions = new Map<string, { content: string; reads: Map<string, SkillReadBase>; request: unknown }>()
    // Serial tool lane prevents finish racing an accepted publication. It is
    // owned and drained, not a durable or recurring work queue.
    let lane: Promise<unknown> = Promise.resolve()
    const execute = async (raw: unknown, exec: ToolRunContext, agent: Agent): Promise<unknown> => {
      if (closed || exec.agent !== agent) throw new Error('Tool does not belong to this live upgrade Agent.')
      const combined = AbortSignal.any([signal, exec.signal]); combined.throwIfAborted()
      const input = raw as { action?: string; sourcePath?: string; content?: string; name?: string }
      if (!input || typeof input !== 'object') throw new Error('Select an upgrade action.')
      if (input.action === 'inspect_name') { if (typeof input.name !== 'string') throw new Error('Supply the proposed native name.'); return inspectGitUpgradeName(this.files, input.name, combined) }
      if (input.action === 'inspect' || input.action === 'finish') return withSnapshot(this.files, async s => {
        const wake = await currentWake(s)
        if (!wake) throw new Error('The assigned wake disappeared outside this owner; no completion is inferred.')
        if (input.action === 'finish') { if (wake.pending.length) throw new Error('Assigned conversions remain pending.'); verified = true }
        return wake
      }, { signal: combined })
      const item = assigned.pending.find(row => row.sourcePath === input.sourcePath)
      if (!item) throw new Error('Choose an exact assigned original sourcePath.')
      const folder = folderOf(item.sourcePath)
      if (input.action === 'read') return withSnapshot(this.files, async s => {
        const wake = await currentWake(s)
        if (!wake?.pending.some(row => row.sourcePath === item.sourcePath)) return { assignedPending: false }
        const result = []
        for (const path of [folder + 'record.json', folder + 'legacy-git.json', folder + 'SKILL.md']) {
          const bytes = await this.files.readBytes(s, path)
          const text = bytes === undefined ? null : path.endsWith('.json')
            ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
            : await this.files.read(s, path) ?? null
          reads.remember(path, s.revision, text); result.push({ path, text })
        }
        return result
      }, { signal: combined })
      if (input.action !== 'publish' || typeof input.content !== 'string') throw new Error('Supply complete native content for publish.')
      let submission = submissions.get(item.sourcePath)
      if (submission && submission.content !== input.content) throw new Error('Continue the exact accepted publication before changing content.')
      if (!submission) {
        const bases = new Map<string, SkillReadBase>()
        for (const path of [folder + 'record.json', folder + 'legacy-git.json', folder + 'SKILL.md']) {
          const base = reads.resolve(path); if (!base) throw new Error('Read the complete assigned folder first.'); bases.set(path, base)
        }
        if (typeof bases.get(item.sourcePath)?.text !== 'string') throw new Error('The selected original was not actually read; no conversion can be confirmed.')
        submission = { content: input.content, reads: bases, request: { operationId: assigned.operationId, item, content: input.content, reads: [...bases.values()] } }
        submissions.set(item.sourcePath, submission)
      }
      const acceptedSubmission = submission
      let rejectedBeforeBuildReturned = false
      const receipt = await this.transactions.runFinalization('g09:' + assigned.operationId + ':' + hash(item.sourcePath), submission.request,
        { reevaluate: true, readPlan: { signal: combined }, beforeAttempt: () => combined.throwIfAborted() }, async s => {
          try {
          const wake = await currentWake(s), pending = wake?.pending.find(row => row.sourcePath === item.sourcePath)
          if (!pending && await sourceHistoryMatches(s, item, acceptedSubmission.reads)) {
            const current = (await this.files.read(s, folder + 'SKILL.md'))!
            throw new GitUpgradePeerObservation(folder + 'SKILL.md', current, current === acceptedSubmission.content)
          }
          if (!wake || JSON.stringify(pending) !== JSON.stringify(item)) throw new Error('Assigned item changed before publication.')
            const publication = await prepareGitLegacySkillConversion(this.files, s, { sourcePath: item.sourcePath, content: acceptedSubmission.content, reads: acceptedSubmission.reads })
          return [...publication.changes, { path: gitUpgradeWakePath, content: encode({ ...wake, pending: wake.pending.filter(row => row.sourcePath !== item.sourcePath) }) }]
          } catch (error) { rejectedBeforeBuildReturned = true; throw error }
        // Only native Git operation resolution can confirm this exact proposal.
        // A later matching tree is an observation, not our command receipt.
        }, async () => false).catch(error => {
          // This builder never returned changes for dispatch. The existing
          // transaction enters a resumed builder only after resolving UNKNOWN.
          // Failures after a returned builder retain the accepted submission.
          if (rejectedBeforeBuildReturned) submissions.delete(item.sourcePath)
          if (error instanceof GitUpgradePeerObservation) return { status: error.sameContent ? 'current-content-matches' : 'peer-change-unconfirmed',
            targetPath: error.targetPath, currentContent: error.currentContent, sourceHistoryVerified: true, exactContentMatches: error.sameContent,
            proposalConfirmed: false, semanticEquivalenceConfirmed: false,
            sourceHistory: [...acceptedSubmission.reads.values()].filter(row => row.text !== null && /(?:record|legacy-git)\.json$/.test(row.path))
              .map(row => ({ revision: row.revision, path: row.path, sha256: hash(row.text!) })) }
          throw error
        })
      this.config.changed?.()
      return receipt
    }
    let creationFailure: DshAgentCreationFailure | undefined
    let executionFailed = false, executionError: unknown
    if (!verified) {
      const setup: DshAgentRequest['setup'] = (scope, agent) => {
        scope.systemPrompt.section({ name: 'deepseek-servant:once-git-upgrade', order: 100, interpolate: false, text: prompt })
        const off = installExecutionGuard(scope, agent, (_owner, name) => !closed && name === toolName)
        scope.effect(() => off, 'dss.once-git-upgrade-tools')
        scope.tools.register({ name: toolName, description: 'Read assigned Git originals, publish native skills atomically, and verify completion.',
          parameters: { type: 'object', properties: { action: { type: 'string', enum: ['inspect', 'inspect_name', 'read', 'publish', 'finish'] }, sourcePath: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' } }, required: ['action'], additionalProperties: false },
          output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: (raw, exec) => {
            const work = lane.then(() => execute(raw, exec, agent)); lane = work.catch(() => {})
            accepted.add(work); void work.finally(() => accepted.delete(work)).catch(() => {}); return work
          } })
      }
      try {
        signal.throwIfAborted()
        const sessionId = 'dss-git-upgrade-' + randomUUID()
        // Register before create. An uncertain append never dispatches native
        // creation; only this exact returned handle can later resolve its entry.
        await this.transactions.runFinalization('g09:' + assigned.operationId + ':native-register:' + sessionId,
          { operationId: assigned.operationId, sessionId },
          { reevaluate: true, readPlan: { signal }, beforeAttempt: () => signal.throwIfAborted() }, async s => {
            const wake = await currentWake(s)
            if (!wake) throw new Error('The assigned wake disappeared before native registration.')
            return wake.nativeSessions.includes(sessionId) ? [] : [{ path: gitUpgradeWakePath, content: encode({ ...wake, nativeSessions: [...wake.nativeSessions, sessionId] }) }]
          }, async s => (await currentWake(s))?.nativeSessions.includes(sessionId) === true)
        this.resolveNativeWake = async () => {
          await this.transactions.runFinalization('g09:' + assigned.operationId + ':native-resolve:' + sessionId,
            { operationId: assigned.operationId, sessionId }, { reevaluate: true }, async s => {
              const wake = await currentWake(s)
              if (!wake) throw new Error('The assigned wake disappeared before exact native resolution.')
              const remaining = wake.nativeSessions.filter(id => id !== sessionId)
              // Confirm this exact native responsibility separately. A later
              // package-file unlink may be interrupted without losing the wake.
              return wake.nativeSessions.includes(sessionId) ? [{ path: gitUpgradeWakePath, content: encode({ ...wake, nativeSessions: remaining }) }] : []
            }, async s => { const wake = await currentWake(s); return wake !== undefined && !wake.nativeSessions.includes(sessionId) })
          resolvedOwnNative = true
        }
        // This exact owner has confirmed registration but has not dispatched
        // create. Unlike a Gateway rejection, this local fact is unambiguous.
        if (signal.aborted) { await this.resolveNativeWake(); signal.throwIfAborted() }
        try {
          handle = await this.gateway.create({ sessionId, role: 'helper', cwd: this.config.cwd, presetId: this.config.presetId, model: this.config.model, signal, setup,
            creationFailure: outcome => { if (outcome.sessionId === sessionId) creationFailure = outcome } })
        } catch (error) {
          // Only the actual Gateway's pre-dispatch observation can withdraw a
          // registered ID without native retirement. A plain rejection is unknown.
          if (creationFailure?.disposition === 'not-dispatched') {
            try { await this.resolveNativeWake() }
            catch (resolution) { throw new AggregateError([error, resolution], 'Creation was not dispatched; registration withdrawal remains unconfirmed.') }
          }
          throw error
        }
        if (handle.sessionId !== sessionId) { this.resolveNativeWake = undefined; throw new Error('Native returned a different session identity; retain the registered responsibility.') }
        let interrupt!: (reason: unknown) => void
        const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject }); void interrupted.catch(() => {})
        let cancellation: Promise<void> | undefined
        const stop = () => { cancellation ??= handle!.cancel(); void cancellation.catch(() => {}); interrupt(signal.reason) }
        signal.addEventListener('abort', stop, { once: true })
        try {
          signal.throwIfAborted()
          await handle.send(prompt + '\nAssignment: ' + encode(assigned), 'g09:' + assigned.operationId + ':' + randomUUID(), 'followup', 'deepseek-servant')
          await Promise.race([handle.whenIdle(), interrupted]); signal.throwIfAborted()
        } finally { signal.removeEventListener('abort', stop); await cancellation }
      } catch (error) {
        executionFailed = true; executionError = error; throw error
      } finally {
        closed = true
        await Promise.allSettled([...accepted])
        // A failed acquisition may have already awaited its real native dispose.
        // Retire that exact session through Cleaner without inventing a handle.
        this.nativeHandle = handle ?? (creationFailure?.disposition === 'closed' ? { sessionId: creationFailure.sessionId, close: 'closed' } : undefined)
        try { await this.retryNativeRetirement() }
        catch (retirementError) {
          if (executionFailed) throw new AggregateError([executionError, retirementError], 'Upgrade execution and native responsibility resolution both failed.')
          throw retirementError
        } finally { reads.clear() }
      }
    }
    if (!verified) return 'pending'
    if (this.nativeReport && (this.nativeReport.retirement !== 'fulfilled' || this.nativeReport.close !== 'closed')) return 'converted-native-pending'
    signal.throwIfAborted()
    const finalWake = await withSnapshot(this.files, currentWake, { signal })
    if (!finalWake) {
      if (resolvedOwnNative && verified) { await this.config.beforeWakeRetirement?.(); return 'complete' }
      throw new Error('The assigned wake disappeared without this owner completing its responsibility.')
    }
    if (finalWake.nativeSessions.length) return 'converted-native-pending'
    // Business and native confirmation already survive in this empty wake.
    // Remove package startup material first; this addressed Git wake remains
    // the restart source until its own final publication confirms.
    await this.config.beforeWakeRetirement?.()
    await this.transactions.runFinalization('g09:' + assigned.operationId + ':retire', { operationId: assigned.operationId },
      { reevaluate: true, readPlan: { signal }, beforeAttempt: () => signal.throwIfAborted() }, async s => {
        const wake = await currentWake(s)
        if (!wake && resolvedOwnNative && verified) return []
        if (!wake || wake.pending.length || wake.nativeSessions.length) throw new Error('The exact wake is not ready for retirement.')
        return [{ path: gitUpgradeWakePath, content: null }]
      }, async s => await this.files.read(s, gitUpgradeWakePath) === undefined)
    return 'complete'
  }
}
