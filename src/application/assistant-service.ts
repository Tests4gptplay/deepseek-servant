import { createHash, randomUUID } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.ts'
import type { Assistant, AssistantSettings, AssistantSettingsChange, AssistantUserInput, ConversationMessage, AssistantInputEvidence, AssistantDeliveryReceipt } from '../contracts/assistant.ts'
import type { Delivery, WorkspaceBinding } from '../contracts/task.ts'

export interface AssistantRuntimePort {
  send(assistant: Assistant, text: string, messageId: string, source?: 'user' | 'deepseek-servant'): Promise<void>
  /** Certifies current queued or already-consumed native input, including a live flush barrier. */
  hasInput(sessionId: string, messageId: string): Promise<boolean>
  /** One cold-safe native projection per Session; historical discarded admissions retain their exact body. */
  inputs(sessionId: string): Promise<ReadonlyMap<string, AssistantInputEvidence>>
  conversation(sessionId: string): Promise<ConversationMessage[]>
  /** Admit a task-delivery followup through the Foreground Agent's serialized inbox. */
  deliver(assistant: Assistant, delivery: Delivery, messageId: string): Promise<void>
  /** Refuse a busy old foreground owner, then release an idle owner before committing a new Session identity. */
  prepareConfiguration?(previous: Assistant, updated: Assistant): Promise<void>
}
export interface AssistantRecoveryFailure { assistantId: string; messageId: string; error: string }
export interface AssistantServiceOptions {
  store: StoragePort
  runtime: AssistantRuntimePort
  resolveWorkspace(id?: string): Promise<WorkspaceBinding>
  defaults: AssistantSettings
  onChanged?(assistant: Assistant): void
  onRecoveryError?(failure: AssistantRecoveryFailure): void
  now?(): string
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

/** Assistant state owns durable admission; native Sessions retain conversation text. */
export class AssistantService {
  private readonly chains = new Map<string, Promise<unknown>>()
  constructor(private readonly options: AssistantServiceOptions) {}
  private now(): string { return this.options.now?.() ?? new Date().toISOString() }
  private key(id: string): string { return `assistant/${id}` }

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
    const sessionWorkspaces = structuredClone(value.sessionWorkspaces ?? {})
    if (!Object.hasOwn(sessionWorkspaces, value.sessionId)) put(sessionWorkspaces, value.sessionId, structuredClone(value.workspace))
    return { ...structuredClone(value), priorSessionIds: [...(value.priorSessionIds ?? [])], sessionWorkspaces }
  }
  async get(id = 'default'): Promise<Assistant> {
    const existing = await this.options.store.get<Assistant>(this.key(id))
    if (existing) return this.normalize(existing)
    return this.serial(id, async () => {
      const concurrent = await this.options.store.get<Assistant>(this.key(id))
      if (concurrent) return this.normalize(concurrent)
      const now = this.now()
      const sessionId = `servant-foreground-${randomUUID()}`
      const workspace = await this.options.resolveWorkspace(this.options.defaults.workspaceId)
      const value: Assistant = {
        schemaVersion: 1, id, revision: 1, sessionId, priorSessionIds: [], sessionWorkspaces: { [sessionId]: workspace },
        settings: jsonSnapshot(this.options.defaults),
        workspace,
        inputs: {}, deliveries: {}, createdAt: now, updatedAt: now,
      }
      await this.save(value)
      return value
    })
  }
  async configure(id: string, change: AssistantSettingsChange): Promise<Assistant> {
    await this.get(id)
    return this.serial(id, async () => {
      const stored = await this.options.store.get<Assistant>(this.key(id))
      if (!stored) throw new Error('Assistant disappeared during configuration')
      const assistant = this.normalize(stored)
      if (assistant.revision !== change.expectedRevision) throw new Error('助理设置已经变化，请刷新后再保存。')
      const settings = jsonSnapshot(change.settings)
      const workspace = await this.options.resolveWorkspace(settings.workspaceId)
      const rotate = workspace.id !== assistant.workspace.id || workspace.directory !== assistant.workspace.directory
        || routeIdentity(settings) !== routeIdentity(assistant.settings)
      if (rotate) {
        const native = await this.options.runtime.inputs(assistant.sessionId)
        const unresolved = (messageId: string, status: 'pending' | 'sent') => {
          const input = native.get(messageId)
          // A native rejection/interrupted claim is visible as a failed input;
          // it must not prevent the user fixing settings and sending a new request.
          if (input?.state === 'claimed' && !input.active) return false
          return status === 'pending' || input?.state !== 'consumed'
        }
        const unconsumed = Object.entries(assistant.inputs).some(([messageId, input]) => input.sessionId === assistant.sessionId && unresolved(messageId, input.status))
          || Object.values(assistant.deliveries).some(delivery => delivery.sessionId === assistant.sessionId && unresolved(delivery.messageId, delivery.status))
        if (unconsumed) throw new Error('前台还有未完成接纳或尚未消费的消息或交付，请先恢复并处理后再更换工作区、预设或前台模型。')
      }
      const updated: Assistant = { ...assistant, settings, workspace, sessionWorkspaces: structuredClone(assistant.sessionWorkspaces), revision: assistant.revision + 1, updatedAt: this.now(),
        ...(rotate ? { sessionId: `servant-foreground-${randomUUID()}`, priorSessionIds: [...new Set([...assistant.priorSessionIds, assistant.sessionId])] } : {}) }
      put(updated.sessionWorkspaces, updated.sessionId, structuredClone(workspace))
      if (rotate) await this.options.runtime.prepareConfiguration?.(assistant, updated)
      // No new owner exists until this save succeeds. A failed save can resume the released old idle Session.
      await this.save(updated)
      return updated
    })
  }
  async sendMessage(id: string, messageId: string, text: string): Promise<{ messageId: string; status: 'sent' | 'duplicate' }> {
    if (!messageId || !text.trim()) throw new Error('消息标识和正文不能为空。')
    await this.get(id)
    return this.serial(id, async () => {
      const stored = await this.options.store.get<Assistant>(this.key(id))
      if (!stored) throw new Error('Assistant disappeared during input admission')
      const assistant = this.normalize(stored)
      let prior = own(assistant.inputs, messageId)
      const wasSent = prior?.status === 'sent'
      const hash = fingerprint(text)
      if (prior) {
        const previousText = prior.text ?? (prior.fingerprint === undefined ? (await this.findUserInput(assistant, messageId))?.text : undefined)
        const previousHash = prior.fingerprint ?? (previousText === undefined ? undefined : fingerprint(previousText))
        if (previousHash === undefined || previousHash !== hash) throw new Error('同一消息标识不能用于不同正文，或其原始证据已不可用。')
        const sessionId = prior.sessionId ?? assistant.sessionId
        const workspaceId = prior.workspaceId ?? own(assistant.sessionWorkspaces, sessionId)?.id
        if (workspaceId === undefined) throw new Error('原始消息工作区证据不可用，不能关联到当前工作区。')
        prior = { ...prior, fingerprint: hash, sessionId, workspaceId }
      } else {
        const at = this.now()
        prior = { text, fingerprint: hash, sessionId: assistant.sessionId, workspaceId: assistant.workspace.id, status: 'pending', at }
        put(assistant.inputs, messageId, prior)
        assistant.latestUser = { id: messageId, text, at }
        assistant.revision += 1
        assistant.updatedAt = at
        await this.save(assistant)
      }
      let duplicate = false
      try {
        const native = (await this.options.runtime.inputs(prior.sessionId)).get(messageId)
        if (native && (native.source !== 'user' || fingerprint(native.text) !== hash)) throw new Error('Native user input identity or body differs from its saved receipt.')
        if (native?.state === 'claimed' && !native.active) throw new Error('原生回合已领取此消息，但尚无消费记录；原文已保留。请确认前台状态或修正设置后重新发送，新消息可以正常继续。')
        if (native?.state === 'consumed' || native?.state === 'claimed') {
          if (wasSent) return { messageId, status: 'duplicate' }
        } else {
          if (prior.sessionId !== assistant.sessionId) throw new Error('未消费的消息属于旧前台会话，不能投递到新的工作区或模型。')
          if (wasSent && native === undefined && prior.text === undefined) throw new Error('已接纳消息的原生证据不可用，无法证明它从未被消费。')
          duplicate = wasSent && native?.state === 'queued'
          prior = { ...prior, text, status: 'pending' }
          delete prior.error
          put(assistant.inputs, messageId, prior)
          await this.save(assistant)
          // Even a queued cold Session needs its native owner resumed. The gateway
          // recognizes that current queued ID and does not insert a second copy.
          await this.options.runtime.send(assistant, text, messageId, 'user')
        }
      } catch (error) {
        put(assistant.inputs, messageId, { ...prior, error: String(error) })
        await this.save(assistant)
        throw error
      }
      put(assistant.inputs, messageId, { fingerprint: hash, sessionId: prior.sessionId, workspaceId: prior.workspaceId, status: 'sent', at: prior.at })
      assistant.updatedAt = this.now()
      await this.save(assistant)
      return { messageId, status: duplicate ? 'duplicate' : 'sent' }
    })
  }

  async deliver(id: string, taskId: string, delivery: Delivery): Promise<string> {
    await this.get(id)
    return this.serial(id, async () => {
      const stored = await this.options.store.get<Assistant>(this.key(id))
      if (!stored) throw new Error('Assistant disappeared during delivery')
      const assistant = this.normalize(stored)
      const key = JSON.stringify([taskId, delivery.id])
      const payload = JSON.stringify(jsonSnapshot({ summary: delivery.summary, artifacts: delivery.artifacts, resultIds: delivery.resultIds, createdAt: delivery.createdAt }))
      const hash = fingerprint(payload)
      let receipt = own(assistant.deliveries, key)
      if (receipt) {
        if (receipt.fingerprint !== hash) throw new Error('同一交付标识不能用于不同交付内容。')
      } else {
        receipt = { taskId, messageId: `servant-delivery-${fingerprint(key)}`, sessionId: assistant.sessionId, fingerprint: hash,
          delivery: jsonSnapshot(delivery), status: 'pending', at: this.now() }
        put(assistant.deliveries, key, receipt)
        assistant.updatedAt = this.now()
        await this.save(assistant)
      }
      return this.admitDelivery(assistant, key, receipt, delivery)
    })
  }

  private async admitDelivery(assistant: Assistant, key: string, receipt: AssistantDeliveryReceipt, available?: Delivery): Promise<string> {
    try {
      const native = (await this.options.runtime.inputs(receipt.sessionId)).get(receipt.messageId)
      if (native && native.source !== 'deepseek-servant') throw new Error('Native delivery input has an unexpected source.')
      if (native?.state === 'claimed' && !native.active) throw new Error('前台通知已被原生回合领取，但尚无消费记录；后台结果仍保留在任务卡中，可发送新消息要求整理结果。')
      if (native?.state === 'consumed' || native?.state === 'claimed') {
        if (receipt.status === 'sent') return receipt.messageId
      } else {
        if (receipt.sessionId !== assistant.sessionId) throw new Error('未消费的交付属于旧前台会话，不能投递到新的工作区或模型。')
        if (receipt.status === 'sent' && native === undefined && receipt.delivery === undefined) throw new Error('已接纳交付的原生证据不可用，无法证明它从未被消费。')
        const delivery = receipt.delivery ?? available
        if (native === undefined && delivery === undefined) throw new Error('交付尚未消费，但原始正文和待接纳内容均不可用。')
        receipt = { ...receipt, status: 'pending', ...(delivery === undefined ? {} : { delivery: jsonSnapshot(delivery) }) }
        delete receipt.error
        put(assistant.deliveries, key, receipt)
        await this.save(assistant)
        if (native) await this.options.runtime.send(assistant, native.text, receipt.messageId, 'deepseek-servant')
        else await this.options.runtime.deliver(assistant, delivery!, receipt.messageId)
      }
    } catch (error) {
      put(assistant.deliveries, key, { ...receipt, error: String(error) })
      await this.save(assistant)
      throw error
    }
    const { error: _error, delivery: _delivery, ...admitted } = receipt
    put(assistant.deliveries, key, { ...admitted, status: 'sent' })
    assistant.updatedAt = this.now()
    await this.save(assistant)
    return receipt.messageId
  }
  async conversation(id = 'default'): Promise<ConversationMessage[]> {
    const assistant = await this.get(id)
    const messages: ConversationMessage[] = []
    const seen = new Set<string>()
    for (const sessionId of [...assistant.priorSessionIds, assistant.sessionId]) {
      for (const message of await this.options.runtime.conversation(sessionId)) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        messages.push(message)
      }
    }
    return messages
  }
  /** A later user input never changes an earlier tool's authorization source. */
  async userInput(id: string, messageId: string): Promise<AssistantUserInput | undefined> {
    if (!messageId) return undefined
    return this.findUserInput(await this.get(id), messageId)
  }
  private async findUserInput(assistant: Assistant, messageId: string): Promise<AssistantUserInput | undefined> {
    const receipt = own(assistant.inputs, messageId)
    if (receipt?.status === 'pending' && receipt.text !== undefined) {
      if (receipt.fingerprint !== undefined && fingerprint(receipt.text) !== receipt.fingerprint) throw new Error('Stored user input fingerprint mismatch.')
      const sessionId = receipt.sessionId ?? assistant.sessionId
      const workspaceId = receipt.workspaceId ?? own(assistant.sessionWorkspaces, sessionId)?.id
      if (workspaceId === undefined) return undefined
      return { id: messageId, text: receipt.text, sessionId, workspaceId, at: receipt.at }
    }
    const sessionIds = [...new Set([...(receipt?.sessionId ? [receipt.sessionId] : []), ...assistant.priorSessionIds, assistant.sessionId])]
    for (const sessionId of sessionIds) {
      const message = (await this.options.runtime.inputs(sessionId)).get(messageId)
      if (!message || message.source !== 'user') continue
      if (receipt?.fingerprint !== undefined && fingerprint(message.text) !== receipt.fingerprint) throw new Error('Native user input fingerprint mismatch.')
      const workspaceId = (receipt?.sessionId === sessionId ? receipt.workspaceId : undefined) ?? own(assistant.sessionWorkspaces, sessionId)?.id
      if (workspaceId === undefined) continue
      const at = receipt?.at
      return { id: messageId, text: message.text, sessionId, workspaceId, ...(at === undefined ? {} : { at }) }
    }
    return undefined
  }
  async recoverInputs(): Promise<{ recovered: number; failed: AssistantRecoveryFailure[] }> {
    const report = { recovered: 0, failed: [] as AssistantRecoveryFailure[] }
    const failed = (assistantId: string, messageId: string, error: unknown) => {
      const failure = { assistantId, messageId, error: String(error) }
      report.failed.push(failure)
      try {
        if (this.options.onRecoveryError) this.options.onRecoveryError(failure)
        else console.warn('deepseek-servant: foreground input recovery failed', failure)
      } catch (notificationError) { console.warn('deepseek-servant: input recovery notification failed', notificationError) }
    }
    for (const { value } of await this.options.store.list<Assistant>('assistant/')) {
      const assistant = this.normalize(value)
      const snapshots = new Map<string, Promise<ReadonlyMap<string, AssistantInputEvidence>>>()
      const snapshot = (sessionId: string) => {
        let reading = snapshots.get(sessionId)
        if (!reading) { reading = this.options.runtime.inputs(sessionId); snapshots.set(sessionId, reading) }
        return reading
      }
      const pending: Array<{ kind: 'input' | 'delivery'; key: string; messageId: string; sessionId: string; at: string; order: number; text?: string }> = []
      const entries = [
        ...Object.entries(assistant.inputs).map(([messageId, input]) => ({ kind: 'input' as const, key: messageId, messageId, receipt: input })),
        ...Object.entries(assistant.deliveries).map(([key, delivery]) => ({ kind: 'delivery' as const, key, messageId: delivery.messageId, receipt: delivery })),
      ]
      for (const entry of entries) {
        const sessionId = entry.receipt.sessionId ?? assistant.sessionId
        try {
          const native = await snapshot(sessionId)
          const input = native.get(entry.messageId)
          if (entry.receipt.status === 'sent' && (input?.state === 'consumed' || input?.state === 'claimed' && input.active)) continue
          const text = entry.kind === 'input' ? own(assistant.inputs, entry.messageId)?.text ?? input?.text : undefined
          if (entry.kind === 'input' && (text === undefined || input && input.source !== 'user')) throw new Error('原始用户输入正文不可用或来源不匹配。')
          pending.push({ kind: entry.kind, key: entry.key, messageId: entry.messageId, sessionId, at: entry.receipt.at,
            order: [...native.keys()].indexOf(entry.messageId), ...(text === undefined ? {} : { text }) })
        } catch (error) { failed(assistant.id, entry.messageId, error) }
      }
      pending.sort((a, b) => a.at.localeCompare(b.at) || (a.sessionId === b.sessionId && a.order >= 0 && b.order >= 0 ? a.order - b.order : 0))
      for (const entry of pending) {
        try {
          if (entry.kind === 'input') await this.sendMessage(assistant.id, entry.messageId, entry.text!)
          else await this.serial(assistant.id, async () => {
            const current = await this.options.store.get<Assistant>(this.key(assistant.id))
            if (!current) throw new Error('Assistant disappeared during delivery recovery')
            const normalized = this.normalize(current)
            const receipt = own(normalized.deliveries, entry.key)
            if (receipt) await this.admitDelivery(normalized, entry.key, receipt)
          })
          report.recovered += 1
        } catch (error) { failed(assistant.id, entry.messageId, error) }
      }
    }
    return report
  }
  async flush(): Promise<void> { await Promise.all(this.chains.values()) }
}
