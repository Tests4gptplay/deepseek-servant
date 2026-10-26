import { createHash, randomUUID } from 'node:crypto'
import { assistantRuntimeProfile, isAutoModel } from '../domain/model-route.ts'
import type { StoragePort } from '../contracts/ports.ts'
import type { Assistant, AssistantSettings, AssistantSettingsChange, AssistantUserInput, ConversationMessage,
  AssistantInputEvidence, AssistantInputReceipt, AssistantDeliveryReceipt, ForegroundCapture } from '../contracts/assistant.ts'
import type { Delivery, ModelRoute, WorkspaceBinding } from '../contracts/task.ts'
import { ConversationStore } from './conversation-store.js'

export interface AssistantRuntimePort {
  send(assistant: Assistant, text: string, messageId: string, source?: 'user' | 'deepseek-servant'): Promise<void>
  hasInput(sessionId: string, messageId: string): Promise<boolean>
  inputs(sessionId: string): Promise<ReadonlyMap<string, AssistantInputEvidence>>
  conversation(sessionId: string): Promise<ConversationMessage[]>
  capture?(sessionId: string): Promise<ForegroundCapture>
  /** Returns false while the exact owner is running or still owns native jobs. */
  retire?(assistant: Assistant): Promise<boolean>
  /** Explicit owner-requested conversation deletion stops this foreground only. */
  cancel?(assistant: Assistant): Promise<boolean>
  resume?(assistant: Assistant, messageId: string): Promise<void>
  deliver(assistant: Assistant, delivery: Delivery, messageId: string): Promise<void>
  prepareConfiguration?(previous: Assistant, updated: Assistant): Promise<void>
}
export interface AssistantRecoveryFailure { assistantId: string; messageId: string; error: string }
export interface AssistantServiceOptions {
  store: StoragePort
  runtime: AssistantRuntimePort
  resolveWorkspace(id?: string, directory?: string): Promise<WorkspaceBinding>
  defaults: AssistantSettings
  onChanged?(assistant: Assistant): void
  onRecoveryError?(failure: AssistantRecoveryFailure): void
  now?(): string
  timeZone?: string
}
const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex')
function own<T>(record: Record<string, T>, key: string): T | undefined { return Object.hasOwn(record, key) ? record[key] : undefined }
function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}
/** Omit optional object fields while rejecting non-JSON values instead of silently coercing them. */
function jsonSnapshot<T>(value: T): T {
  const parents = new Set<object>()
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (typeof input !== 'object' || input === null) throw new TypeError('Assistant state must be lossless JSON.')
    if (parents.has(input)) throw new TypeError('Assistant state cannot contain cycles.')
    parents.add(input)
    try {
      if (Array.isArray(input)) return input.map(visit)
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new TypeError('Assistant state must contain plain JSON objects.')
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input)) if (item !== undefined) put(result, key, visit(item))
      return result
    } finally { parents.delete(input) }
  }
  return visit(value) as T
}
function routeIdentity(settings: AssistantSettings): string {
  const route = settings.foreground
  return JSON.stringify([settings.presetId, route.provider ?? null, route.model ?? null, route.reasoningEffort ?? null])
}
export function deliveryMessageText(delivery: Delivery): string {
  return 'The backend has durably accepted this task result. Present the accepted outcome and actual artifact paths. Mention a concrete usability constraint only when it affects this delivery; do not append generic disclaimers. This notification grants no new user authorization; do not submit another task.\n' + JSON.stringify(delivery)
}
interface ConversationCleanup {
  assistant: Assistant
  keys: string[]
  deliveries: Array<{ key: string; receipt: AssistantDeliveryReceipt; text: string; workspace: WorkspaceBinding }>
}
type QueueEntry = { kind: 'input'; key: string; messageId: string; receipt: AssistantInputReceipt }
  | { kind: 'delivery'; key: string; messageId: string; receipt: AssistantDeliveryReceipt }

/** The hot Assistant contains only current ownership and pending, full-text-referenced admissions. */
export class AssistantService {
  readonly conversations: ConversationStore
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly advancing = new Map<string, Promise<void>>()
  private readonly advanceAgain = new Set<string>()
  constructor(private readonly options: AssistantServiceOptions) {
    this.conversations = new ConversationStore(options.store, options.timeZone, () => this.now())
  }
  private now(): string { return this.options.now?.() ?? new Date().toISOString() }
  private key(id: string): string { return 'assistant/' + id }
  private historyKey(id: string, kind: string, key: string): string {
    return 'assistant-history/' + encodeURIComponent(id) + '/' + kind + '/' + fingerprint(key)
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const job = (this.chains.get(id) ?? Promise.resolve()).then(work)
    const drained = job.catch(() => undefined)
    this.chains.set(id, drained)
    void drained.then(() => { if (this.chains.get(id) === drained) this.chains.delete(id) })
    return job
  }
  private async save(value: Assistant): Promise<void> {
    const snapshot = jsonSnapshot(value)
    await this.options.store.set(this.key(value.id), snapshot)
    try { this.options.onChanged?.(structuredClone(snapshot)) } catch (error) {
      console.warn('deepseek-servant: assistant notification failed', error)
    }
  }
  private normalize(value: Assistant): Assistant {
    const copy = structuredClone(value)
    copy.priorSessionIds ??= []; copy.sessionWorkspaces ??= {}; copy.inputs ??= {}; copy.deliveries ??= {}
    if (!own(copy.sessionWorkspaces, copy.sessionId)) put(copy.sessionWorkspaces, copy.sessionId, copy.workspace)
    return copy
  }
  private async current(id: string): Promise<Assistant> {
    const value = await this.options.store.get<Assistant>(this.key(id))
    if (!value) throw new Error('Assistant does not exist')
    return this.normalize(value)
  }
  private queue(assistant: Assistant): QueueEntry[] {
    return [
      ...Object.entries(assistant.inputs).map(([key, receipt]) => ({ kind: 'input' as const, key, messageId: key, receipt })),
      ...Object.entries(assistant.deliveries).map(([key, receipt]) => ({ kind: 'delivery' as const, key, messageId: receipt.messageId, receipt })),
    ].sort((a, b) => (a.receipt.sequence ?? 0) - (b.receipt.sequence ?? 0) || a.receipt.at.localeCompare(b.receipt.at))
  }
  private async rememberSession(assistant: Assistant, sessionId: string, workspace: WorkspaceBinding): Promise<void> {
    const key = this.historyKey(assistant.id, 'session', sessionId)
    if (!await this.options.store.get(key)) await this.options.store.set(key, { sessionId, workspace })
  }
  private async capture(assistant: Assistant, sessionId: string): Promise<ForegroundCapture> {
    const value = this.options.runtime.capture ? await this.options.runtime.capture(sessionId)
      : { messages: await this.options.runtime.conversation(sessionId), turns: [], finished: false }
    for (const message of value.messages) await this.conversations.append(assistant.id, sessionId, message)
    for (const turn of value.turns) await this.conversations.complete(assistant.id, sessionId, turn.turn,
      value.messages.filter(message => turn.messageIds.includes(message.id)), turn.at)
    return value
  }
  private async rememberReceipt(assistant: Assistant, entry: QueueEntry): Promise<void> {
    const receipt = { ...entry.receipt }
    if ('text' in receipt) delete receipt.text
    if ('delivery' in receipt) delete receipt.delivery
    await this.options.store.set(this.historyKey(assistant.id, entry.kind, entry.key), jsonSnapshot(receipt))
  }
  /** Archive legacy originals before the single hot-root replacement. A failed migration is retryable. */
  private async migrate(assistant: Assistant): Promise<Assistant> {
    const completed = new Set<string>(), native = new Map<string, ReadonlyMap<string, AssistantInputEvidence>>()
    for (const sessionId of [...new Set([...assistant.priorSessionIds, assistant.sessionId, ...Object.keys(assistant.sessionWorkspaces)])]) {
      const workspace = own(assistant.sessionWorkspaces, sessionId)
      if (workspace) await this.rememberSession(assistant, sessionId, workspace)
      const snapshot = await this.capture(assistant, sessionId)
      for (const turn of snapshot.turns) for (const id of turn.messageIds) completed.add(sessionId + '\0' + id)
      native.set(sessionId, await this.options.runtime.inputs(sessionId))
    }
    let sequence = 0
    for (const entry of this.queue(assistant)) {
      const receipt = entry.receipt
      receipt.sessionId ??= assistant.sessionId
      receipt.sequence = ++sequence
      const evidence = native.get(receipt.sessionId)?.get(entry.messageId)
      const source = entry.kind === 'input' ? 'user' : 'deepseek-servant'
      if (evidence && evidence.source !== source) throw new Error('Historical input source differs from its saved receipt.')
      const archived = await this.conversations.find(assistant.id, receipt.sessionId, entry.messageId)
      const text = entry.kind === 'input' ? entry.receipt.text ?? evidence?.text ?? archived?.text
        : evidence?.text ?? archived?.text ?? (entry.receipt.delivery ? deliveryMessageText(entry.receipt.delivery) : undefined)
      if (text === undefined) throw new Error('Historical input original is unavailable: ' + entry.messageId)
      if (entry.kind === 'input' && receipt.fingerprint && fingerprint(text) !== receipt.fingerprint) throw new Error('Historical input body differs from its saved receipt.')
      const original = await this.conversations.append(assistant.id, receipt.sessionId,
        { id: entry.messageId, role: entry.kind === 'input' ? 'user' : 'system', source, text, at: receipt.at })
      receipt.ref = original.ref
      if (entry.kind === 'input') delete entry.receipt.text
      else delete entry.receipt.delivery
      if (completed.has(receipt.sessionId + '\0' + entry.messageId)) {
        await this.rememberReceipt(assistant, entry)
        if (entry.kind === 'input') delete assistant.inputs[entry.key]
        else delete assistant.deliveries[entry.key]
      }
    }
    assistant.nextInputSequence = sequence
    assistant.activeMessageId ??= this.queue(assistant).find(entry => entry.receipt.sessionId === assistant.sessionId)?.messageId
    assistant.priorSessionIds = []
    const needed = new Set([assistant.sessionId, ...this.queue(assistant).map(entry => entry.receipt.sessionId)])
    assistant.sessionWorkspaces = Object.fromEntries(Object.entries(assistant.sessionWorkspaces).filter(([id]) => needed.has(id)))
    if (assistant.latestUser) delete assistant.latestUser.text
    assistant.historyMigrated = true
    await this.save(assistant)
    return assistant
  }
  async get(id = 'default'): Promise<Assistant> {
    if (await this.options.store.get(this.cleanupKey(id))) await this.serial(id, () => this.finishConversationCleanup(id))
    const existing = await this.options.store.get<Assistant>(this.key(id))
    if (existing?.historyMigrated) return this.normalize(existing)
    return this.serial(id, async () => {
      const concurrent = await this.options.store.get<Assistant>(this.key(id))
      if (concurrent) return concurrent.historyMigrated ? this.normalize(concurrent) : this.migrate(this.normalize(concurrent))
      const now = this.now(), sessionId = 'servant-foreground-' + randomUUID()
      const workspace = await this.options.resolveWorkspace(this.options.defaults.workspaceId, this.options.defaults.workspaceDirectory)
      const value: Assistant = { schemaVersion: 1, id, revision: 1, sessionId, priorSessionIds: [], sessionWorkspaces: { [sessionId]: workspace },
        settings: jsonSnapshot(this.options.defaults), workspace, inputs: {}, deliveries: {}, historyMigrated: true,
        nextInputSequence: 0, createdAt: now, updatedAt: now }
      await this.save(value)
      return value
    })
  }
  async configure(id: string, change: AssistantSettingsChange): Promise<Assistant> {
    await this.get(id)
    return this.serial(id, async () => {
      const assistant = await this.current(id)
      if (assistant.revision !== change.expectedRevision) throw new Error('助理设置已经变化，请刷新后再保存。')
      const settings = jsonSnapshot(change.settings)
      const workspace = await this.options.resolveWorkspace(settings.workspaceId, settings.workspaceDirectory)
      const rotate = workspace.id !== assistant.workspace.id || workspace.directory !== assistant.workspace.directory
        || routeIdentity(settings) !== routeIdentity(assistant.settings)
      if (rotate) await this.pump(assistant, false, false)
      const waiting = this.queue(assistant)
      if (rotate && waiting.length) {
        if (workspace.id !== assistant.workspace.id || workspace.directory !== assistant.workspace.directory)
          throw new Error('前台消息保留在原工作区；请先完成本轮回复或清理前台对话，再切换工作区。')
        for (const entry of waiting) {
          const native = (await this.options.runtime.inputs(entry.receipt.sessionId)).get(entry.messageId)
          if (native && native.state !== 'discarded') throw new Error('前台正在处理已提交的消息，请等本轮结束后再更换模型。')
        }
      }
      const updated: Assistant = { ...assistant, settings, workspace, revision: assistant.revision + 1, updatedAt: this.now() }
      if (rotate) {
        await this.options.runtime.prepareConfiguration?.(assistant, updated)
        await this.rememberSession(assistant, assistant.sessionId, assistant.workspace)
        updated.sessionId = 'servant-foreground-' + randomUUID()
        updated.sessionWorkspaces = { [updated.sessionId]: workspace }
        for (const entry of waiting) {
          entry.receipt.runtimeProfile = assistantRuntimeProfile(updated)
          delete entry.receipt.error
          put(updated.sessionWorkspaces, entry.receipt.sessionId, structuredClone(workspace))
        }
        delete updated.activeMessageId
      }
      await this.save(updated)
      if (rotate && waiting.length) await this.pump(updated)
      return updated
    })
  }
  async sendMessage(id: string, messageId: string, text: string, autoModel?: ModelRoute): Promise<{ messageId: string; status: 'sent' | 'duplicate' }> {
    if (!messageId || !text.trim()) throw new Error('消息标识和正文不能为空。')
    await this.get(id)
    return this.serial(id, async () => {
      const assistant = await this.current(id)
      const prior = own(assistant.inputs, messageId) ?? await this.options.store.get<AssistantInputReceipt>(this.historyKey(id, 'input', messageId))
      if (prior) {
        if (prior.fingerprint !== fingerprint(text)) throw new Error('同一消息标识不能用于不同正文。')
        if (own(assistant.inputs, messageId)) await this.pump(assistant, true)
        return { messageId, status: 'duplicate' }
      }
      if (autoModel) {
        assistant.autoModel = jsonSnapshot(autoModel)
        if (isAutoModel(assistant.settings.foreground)) assistant.settings.foreground = jsonSnapshot(autoModel)
      }
      const sessionId = 'servant-foreground-' + fingerprint(id + '\0user\0' + messageId)
      const original = await this.conversations.append(id, sessionId, { id: messageId, role: 'user', source: 'user', text, at: this.now() })
      const receipt: AssistantInputReceipt = { ref: original.ref, fingerprint: fingerprint(text), sessionId, workspaceId: assistant.workspace.id,
        status: 'pending', at: original.at, sequence: (assistant.nextInputSequence ?? 0) + 1, runtimeProfile: assistantRuntimeProfile(assistant) }
      put(assistant.inputs, messageId, receipt)
      put(assistant.sessionWorkspaces, sessionId, structuredClone(assistant.workspace))
      assistant.nextInputSequence = receipt.sequence
      assistant.latestUser = { id: messageId, at: original.at }
      assistant.revision += 1; assistant.updatedAt = this.now()
      await this.save(assistant)
      await this.pump(assistant)
      return { messageId, status: 'sent' }
    })
  }
  async deliver(id: string, taskId: string, delivery: Delivery): Promise<string> {
    await this.get(id)
    return this.serial(id, async () => {
      const assistant = await this.current(id), key = JSON.stringify([taskId, delivery.id])
      const hash = fingerprint(JSON.stringify(jsonSnapshot({ summary: delivery.summary, artifacts: delivery.artifacts, resultIds: delivery.resultIds, createdAt: delivery.createdAt })))
      const prior = own(assistant.deliveries, key) ?? await this.options.store.get<AssistantDeliveryReceipt>(this.historyKey(id, 'delivery', key))
      if (prior) {
        if (prior.fingerprint !== hash) throw new Error('同一交付标识不能用于不同交付内容。')
        if (own(assistant.deliveries, key)) await this.pump(assistant, true)
        return prior.messageId
      }
      const messageId = 'servant-delivery-' + fingerprint(key), sessionId = 'servant-foreground-' + fingerprint(id + '\0delivery\0' + key)
      const original = await this.conversations.append(id, sessionId,
        { id: messageId, role: 'system', source: 'deepseek-servant', text: deliveryMessageText(delivery), at: this.now() })
      const receipt: AssistantDeliveryReceipt = { taskId, messageId, sessionId, fingerprint: hash, ref: original.ref, at: original.at, status: 'pending',
        sequence: (assistant.nextInputSequence ?? 0) + 1, workspaceId: assistant.workspace.id, runtimeProfile: assistantRuntimeProfile(assistant) }
      put(assistant.deliveries, key, receipt)
      put(assistant.sessionWorkspaces, sessionId, structuredClone(assistant.workspace))
      assistant.nextInputSequence = receipt.sequence; assistant.updatedAt = this.now()
      await this.save(assistant); await this.pump(assistant)
      return messageId
    })
  }
  private execution(assistant: Assistant, entry: QueueEntry): Assistant {
    const profile = entry.receipt.runtimeProfile
    return { ...assistant, sessionId: entry.receipt.sessionId,
      workspace: own(assistant.sessionWorkspaces, entry.receipt.sessionId) ?? assistant.workspace,
      settings: profile ? { ...assistant.settings, presetId: profile.presetId, foreground: profile.foreground } : assistant.settings }
  }
  private async admit(assistant: Assistant, entry: QueueEntry): Promise<void> {
    const receipt = entry.receipt, source = entry.kind === 'input' ? 'user' : 'deepseek-servant'
    try {
      const native = (await this.options.runtime.inputs(receipt.sessionId)).get(entry.messageId)
      const text = await this.conversations.journal.fullText(receipt.ref!)
      if (native && (native.source !== source || native.text !== text)) throw new Error('Native input identity differs from its saved original.')
      const execution = this.execution(assistant, entry)
      if (native?.state === 'consumed' || native?.state === 'claimed' && native.active) await this.options.runtime.resume?.(execution, entry.messageId)
      else await this.options.runtime.send(execution, text, entry.messageId, source)
      receipt.status = 'sent'; delete receipt.error
    } catch (error) {
      receipt.error = String(error)
      await this.save(assistant)
      throw error
    }
    assistant.updatedAt = this.now()
    await this.save(assistant)
  }
  private async pump(assistant: Assistant, resume = false, admitNext = true): Promise<void> {
    const active = this.queue(assistant).find(entry => entry.messageId === assistant.activeMessageId)
    if (active) {
      const captured = await this.capture(assistant, assistant.sessionId)
      const completed = new Set(captured.turns.flatMap(turn => turn.messageIds))
      const failed = captured.ended && !captured.ended.interrupted && captured.ended.reason !== 'completed' && captured.ended.messageIds.includes(active.messageId)
      if ((!captured.finished || !completed.has(active.messageId)) && !failed) {
        if (resume) await this.admit(assistant, active)
        return
      }
      if (!await this.options.runtime.retire?.(assistant)) return
      if (failed) {
        for (const id of captured.ended!.messageIds) completed.add(id)
        const reason = captured.ended!.message ?? captured.ended!.reason
        active.receipt.error = reason
        await this.conversations.append(assistant.id, assistant.sessionId, {
          id: 'foreground-end:' + active.messageId, role: 'system', source: 'deepseek-servant-status',
          text: '本轮前台回复已结束：' + reason, at: captured.ended!.at,
        })
      }
      for (const entry of this.queue(assistant).filter(entry => entry.receipt.sessionId === assistant.sessionId && completed.has(entry.messageId))) {
        await this.rememberReceipt(assistant, entry)
        if (entry.kind === 'input') delete assistant.inputs[entry.key]
        else delete assistant.deliveries[entry.key]
      }
      const previous = assistant.sessionId
      delete assistant.activeMessageId
      assistant.sessionId = 'servant-foreground-' + randomUUID()
      delete assistant.sessionWorkspaces[previous]
      put(assistant.sessionWorkspaces, assistant.sessionId, structuredClone(assistant.workspace))
      assistant.updatedAt = this.now()
      await this.save(assistant)
    }
    if (!admitNext) return
    const next = this.queue(assistant)[0]
    if (!next) return
    // Persist ownership before native admission; a lost native receipt resumes this exact identity.
    await this.options.runtime.prepareConfiguration?.(assistant, this.execution(assistant, next))
    delete assistant.sessionWorkspaces[assistant.sessionId]
    assistant.sessionId = next.receipt.sessionId; assistant.activeMessageId = next.messageId
    put(assistant.sessionWorkspaces, assistant.sessionId, structuredClone(assistant.workspace))
    await this.rememberSession(assistant, assistant.sessionId, assistant.workspace)
    await this.save(assistant)
    await this.admit(assistant, next)
  }
  /** Coalesce native completion/status/job notifications; never schedule a polling loop. */
  async advance(id: string, sessionId?: string, resume = false): Promise<void> {
    const pending = this.advancing.get(id)
    if (pending) { this.advanceAgain.add(id); return pending }
    const work = (async () => {
      do {
        this.advanceAgain.delete(id)
        await this.get(id)
        await this.serial(id, async () => {
          const assistant = await this.current(id)
          await this.pump(assistant, resume)
        })
      } while (this.advanceAgain.has(id))
    })().finally(() => this.advancing.delete(id))
    this.advancing.set(id, work)
    return work
  }
  async conversationPage(id = 'default', before?: string, limit = 40, date?: string) {
    await this.get(id)
    return this.conversations.page(id, before, limit, date)
  }
  async conversation(id = 'default'): Promise<ConversationMessage[]> { return (await this.conversationPage(id)).messages }
  /** The exact archived original remains available after its physical Session has retired. */
  async userInput(id: string, messageId: string): Promise<AssistantUserInput | undefined> {
    if (!messageId) return undefined
    const assistant = await this.get(id)
    const receipt = own(assistant.inputs, messageId) ?? await this.options.store.get<AssistantInputReceipt>(this.historyKey(id, 'input', messageId))
    if (!receipt?.ref) return undefined
    const original = await this.conversations.find(id, receipt.sessionId, messageId)
    if (!original || original.role !== 'user' || original.source !== 'user') return undefined
    if (fingerprint(original.text) !== receipt.fingerprint) throw new Error('Stored user input fingerprint mismatch.')
    return { id: messageId, text: original.text, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, at: original.at }
  }
  private cleanupKey(id: string): string { return 'conversation-cleanup/' + encodeURIComponent(id) }
  private async finishConversationCleanup(id: string): Promise<void> {
    const plan = await this.options.store.get<ConversationCleanup>(this.cleanupKey(id))
    if (!plan) return
    if (!this.options.store.delete) throw new Error('Storage does not support conversation deletion.')
    for (const key of plan.keys) await this.options.store.delete(key)
    for (const entry of plan.deliveries) {
      const original = await this.conversations.append(id, entry.receipt.sessionId, { id: entry.receipt.messageId,
        role: 'system', source: 'deepseek-servant', text: entry.text, at: entry.receipt.at })
      put(plan.assistant.deliveries, entry.key, { ...entry.receipt, ref: original.ref, status: 'pending', error: undefined })
      put(plan.assistant.sessionWorkspaces, entry.receipt.sessionId, entry.workspace)
    }
    await this.save(plan.assistant)
    await this.options.store.delete(this.cleanupKey(id))
  }
  async clearConversation(id = 'default'): Promise<{ cleared: true }> {
    await this.get(id)
    return this.serial(id, async () => {
      const assistant = await this.current(id)
      const stopped = this.options.runtime.cancel
        ? await this.options.runtime.cancel(assistant) : await this.options.runtime.retire?.(assistant)
      if (!stopped) throw new Error('前台作业正在结束，请结束后再清理对话。')
      const reset = this.normalize(assistant), epoch = randomUUID()
      reset.sessionId = 'servant-foreground-' + epoch
      reset.revision++; reset.updatedAt = this.now(); reset.historyMigrated = true
      reset.inputs = {}; reset.deliveries = {}; reset.priorSessionIds = []
      reset.sessionWorkspaces = { [reset.sessionId]: structuredClone(reset.workspace) }
      delete reset.activeMessageId; delete reset.latestUser
      const encoded = encodeURIComponent(id)
      const prefixes = ['conversations/' + encoded + '/', 'conversation-index/' + encoded + '/',
        'conversation-staging/' + encoded + '/', 'conversation-exchanges/' + encoded + '/',
        'assistant-history/' + encoded + '/session/', 'assistant-history/' + encoded + '/input/']
      const keys = (await Promise.all(prefixes.map(prefix => this.options.store.list(prefix)))).flat().map(row => row.key)
      const deliveries: ConversationCleanup['deliveries'] = []
      for (const [key, receipt] of Object.entries(assistant.deliveries)) {
        const sessionId = 'servant-foreground-' + fingerprint(epoch + '\0' + receipt.messageId)
        deliveries.push({ key, receipt: { ...receipt, sessionId },
          text: await this.conversations.journal.fullText(receipt.ref!),
          workspace: own(assistant.sessionWorkspaces, receipt.sessionId) ?? assistant.workspace })
      }
      await this.options.store.set(this.cleanupKey(id), jsonSnapshot({ assistant: reset, keys, deliveries } satisfies ConversationCleanup))
      await this.finishConversationCleanup(id)
      await this.pump(await this.current(id))
      return { cleared: true }
    })
  }
  async recoverInputs(): Promise<{ recovered: number; failed: AssistantRecoveryFailure[] }> {
    const report = { recovered: 0, failed: [] as AssistantRecoveryFailure[] }
    for (const { value } of await this.options.store.list<Assistant>('assistant/')) {
      try { await this.advance(value.id, undefined, true); report.recovered += 1 } catch (error) {
        const failure = { assistantId: value.id, messageId: value.activeMessageId ?? '', error: String(error) }
        report.failed.push(failure)
        this.options.onRecoveryError?.(failure)
      }
    }
    return report
  }
  async flush(): Promise<void> {
    while (this.chains.size || this.advancing.size) await Promise.all([...this.chains.values(), ...this.advancing.values()])
  }
}
