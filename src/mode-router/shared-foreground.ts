import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServantView } from '../contracts/views.js'
import type { ConversationQuery } from '../contracts/assistant.js'
import type { ModeEndpoint, ServantMode } from './mode-router.js'
import type { CoopService } from '../experimental/private-git/service.js'
import type { UserIntent } from '../experimental/private-git/contracts.js'
import { conversationPage } from '../experimental/private-git/conversation.js'
import { digest, readJson, readText, segment } from '../experimental/private-git/journal.js'
import { gitTaskViews, originalTaskId } from './git-view.js'

interface Cursor { local?: string | null; git?: string | null }
const unpack = (before?: string): Cursor => before?.startsWith('shared:') ? JSON.parse(Buffer.from(before.slice(7), 'base64url').toString()) as Cursor : { local: before }

/** One conversation surface; selected mode routes only new input, not existing work. */
export class SharedForeground implements ModeEndpoint {
  private taskProjection?: { key: string; tasks: ServantView['tasks'] }
  private async tasks(service: CoopService, base: ServantView): Promise<ServantView['tasks']> {
    const key = JSON.stringify([service.cache.settings.ownerRepo, service.cache.settings.repositoryDirectory, service.cache.instanceId,
      service.displaySnapshot()?.head, base.assistant.id, base.assistant.workspace.directory])
    if (this.taskProjection?.key === key) return this.taskProjection.tasks
    const tasks = await gitTaskViews(service, base)
    this.taskProjection = { key, tasks }
    return tasks
  }
  constructor(private readonly local: ModeEndpoint, private readonly coop: () => Promise<CoopService>,
    private readonly mode: () => ServantMode, private readonly activated: () => boolean) {}

  async view(params: Record<string, unknown>, signal?: AbortSignal): Promise<ServantView> {
    const query = (params.conversation ?? {}) as ConversationQuery, cursor = unpack(query.before)
    const base = await this.local.call('view', { ...params, conversation: { ...query, before: cursor.local ?? undefined } }, signal) as ServantView
    if (!this.activated()) return base
    const service = await this.coop(), remote = await service.view()
    const snapshot = service.displaySnapshot()
    let messages = remote.messages, moreBefore = remote.moreBefore
    if (snapshot && remote.connection && (cursor.git || query.date)) {
      const dateBefore = query.date ? 'dss-coop/conversations/' + remote.connection.identity.id + '/' + query.date + '/\uffff' : undefined
      const page = await conversationPage(service.repository, service.cache, snapshot, String(remote.connection.identity.id), cursor.git ?? dateBefore)
      messages = page.messages; moreBefore = page.moreBefore
    }
    const localMessages = cursor.local === null ? [] : base.messages
    const gitMessages = cursor.git === null ? [] : messages
    const next: Cursor = { local: cursor.local === null ? null : base.conversationBefore ?? null, git: cursor.git === null ? null : moreBefore ?? null }
    const active = this.mode() === 'PRIVATE_GIT_EXPERIMENTAL'
    return { ...base, tasks: [...base.tasks, ...await this.tasks(service, base)],
      messages: [...localMessages, ...gitMessages.map(message => ({ id: 'git:' + message.id, ref: 'git:' + message.id,
        role: message.role, text: message.text, at: message.createdAt, source: 'DSS-cah' }))].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')),
      conversationBefore: next.local || next.git ? 'shared:' + Buffer.from(JSON.stringify(next)).toString('base64url') : undefined,
      assistant: { ...base.assistant, pendingInputs: [...base.assistant.pendingInputs, ...remote.pending.filter(d => d.kind === 'user-input').map(d => ({ messageId: d.id, error: d.error }))] },
      runtime: active && remote.error ? { ...base.runtime, status: 'degraded', message: remote.error } : base.runtime }
  }

  private async sendGit(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const service = await this.coop()
    const base = await this.local.call('view', {}, signal) as ServantView
    const settings = base.assistant.settings
    const route = settings.foreground.provider && settings.foreground.model ? settings.foreground : params.autoModel ?? {}
    const profile: NonNullable<UserIntent['foreground']> = { ...(route as NonNullable<UserIntent['foreground']>),
      workspace: base.assistant.workspace.directory, presetId: settings.presetId }
    const starts = base.messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
    const context = base.messages.slice(starts.at(-6) ?? 0).map(message => ({ role: message.role, text: message.text, at: message.at }))
    return service.send({ ...params, id: params.messageId ?? params.id ?? randomUUID(), foreground: profile, context })
  }

  async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (method === 'view') {
      try { return await this.view(params, signal) }
      catch (error) {
        if (!this.activated()) throw error
        const base = await this.local.call('view', { ...params, conversation: { ...(params.conversation as object ?? {}), before: unpack((params.conversation as ConversationQuery | undefined)?.before).local ?? undefined } }, signal) as ServantView
        return { ...base, runtime: { ...base.runtime, status: 'degraded', message: error instanceof Error ? error.message : String(error) } }
      }
    }
    if (method === 'send') return this.mode() === 'LOCAL' ? this.local.call(method, params, signal) : this.sendGit(params, signal)
    if (typeof params.taskId === 'string' && params.taskId.startsWith('git:')) {
      const id = segment(originalTaskId(params.taskId)), service = await this.coop()
      if (method === 'readDelivery') return { status: 'applied' }
      if (method === 'exportRecords') {
        const snapshot = service.displaySnapshot() ?? await service.repository.snapshot()
        const manifest = await readJson<{ recordsPath: string }>(service.repository, snapshot, 'dss-coop/records/' + id + '/manifest.json')
        if (!manifest) throw new Error('Task records are still being archived. Open the Git records link for current results.')
        const body = await readText(service.repository, snapshot, manifest.recordsPath)
        const base = await this.local.call('view', {}, signal) as ServantView
        const directory = join(base.recordStorage.directory, 'exports')
        await mkdir(directory, { recursive: true })
        const path = join(directory, 'DSS-cah-' + digest(id).slice(0, 16) + '.md')
        await writeFile(path, body)
        return { path, sha256: digest(body), bytes: Buffer.byteLength(body) }
      }
      if (['control', 'revise', 'answer'].includes(method)) {
        const text = method === 'control' ? 'For DSS-cah task ' + id + ', ' + String(params.intent) + ' my participation' + (params.intent === 'cancel' ? ' and cancel my shared goal.' : '.')
          : method === 'revise' ? 'Revise DSS-cah task ' + id + ' to this goal:\n' + JSON.stringify(params.goal)
          : 'For DSS-cah task ' + id + ', my answer to ' + String(params.waitId) + ':\n' + String(params.answer)
        const receipt = await this.sendGit({ text, id: randomUUID() }, signal) as { state?: string; error?: string }
        return { ...receipt, status: 'queued' }
      }
    }
    return this.local.call(method, params, signal)
  }
}
