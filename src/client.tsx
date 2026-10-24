import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ServantView } from './contracts/views.js'
import { createServantNotices, createServantSource, type ServantClientApi } from './client/source.js'
import { ServantNoticeOverlay, ServantPage, ServantSidebarIcon, type ServantInjected, type ServantNoticeInjected } from './client/page.js'
import { en, NS, zh } from './client/locales.js'

declare const __SERVANT_CLIENT_CSS__: string

export const name = 'deepseek-servant-client'
export const inject = ['slots', 'locale', 'connection']
const PANEL_ID = 'deepseek-servant' as MainPanelId

/** Native DSH page; all background execution remains owned by the Host bundle. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'servant.client.locales')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseekServant = 'client'
    style.textContent = typeof __SERVANT_CLIENT_CSS__ === 'undefined' ? '' : __SERVANT_CLIENT_CSS__
    document.head.append(style)
    return () => { style.remove() }
  }, 'servant.client.styles')
  const t = ctx.locale.bind(NS)
  const installedConnection = ctx.get('connection', true)
  if (!installedConnection) throw new Error('Servant requires the native client connection service.')
  // Host and Client share a TypeScript program but run in separate bundles;
  // Cordis's same service key is Host-typed after declaration merging here.
  const connection = installedConnection as unknown as ConnectionHandle
  const notices = createServantNotices()
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const result = await connection.rpc.call('/api', `deepseek-servant/${method}`, params)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const api: ServantClientApi = {
    view: async () => parseView(await call('view', {}), t('runtime.invalidResponse')),
    send: input => call('send', input),
    configure: input => call('configure', input),
    control: input => call('control', input),
    priority: input => call('priority', input),
    reconcile: input => call('reconcile', input),
    answer: input => call('answer', input),
    revise: input => call('revise', input),
    knowledge: input => call('knowledge', input),
    retention: input => call('retention', input),
    subscribeChanged(listener) {
      const events = new EventSource(new URL('api/deepseek-servant/events', document.baseURI))
      events.addEventListener('changed', listener)
      // Re-read after connection establishment as well as after commits: an
      // initial read or reconnect can otherwise miss an intervening write.
      events.addEventListener('open', listener)
      return () => { events.close() }
    },
    subscribeReset: listener => ctx.on('connection/reset', listener),
  }
  const source = createServantSource(api, notices.show)
  const onOpenArtifact = async (taskId: string, artifactId: string): Promise<void> => {
    try { await call('openArtifact', { taskId, artifactId }) }
    catch (error) { notices.show({ kind: 'error', key: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
    inject: (): ServantInjected => ({
      hooks: { servant: source.source },
      onRefresh: source.refresh, onSend: source.send, onConfigure: source.configure,
      onControl: source.control, onPriority: source.priority, onReconcile: source.reconcile, onAnswer: source.answer, onRevise: source.revise,
      onKnowledge: source.knowledge, onRetention: source.retention, onOpenArtifact,
    }),
  }, ServantPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel'),
  }, ServantSidebarIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'deepseek-servant.notice', locale: NS,
    inject: (): ServantNoticeInjected => ({ hooks: { notice: notices.source }, dismiss: notices.dismiss }),
  }, ServantNoticeOverlay))
}

/** Validate the versioned projection envelope once at the transport boundary. */
function parseView(value: unknown, errorMessage: string): ServantView {
  if (!isObject(value) || !isObject(value.assistant) || !isObject(value.runtime)
    || typeof value.assistant.id !== 'string' || typeof value.assistant.revision !== 'number'
    || !isObject(value.assistant.settings) || !isObject(value.assistant.workspace)
    || !Array.isArray(value.assistant.pendingInputs) || !Array.isArray(value.messages)
    || !Array.isArray(value.tasks) || !Array.isArray(value.knowledge) || !Array.isArray(value.workspaces)
    || !['running', 'stopping', 'degraded'].includes(String(value.runtime.status))) {
    throw new Error(errorMessage)
  }
  return value as unknown as ServantView
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
