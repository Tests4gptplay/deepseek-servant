import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
import { createServantModels, type NativeModelDirectories, type NativeModelSessions } from './client/models.js'
import { observeServantSidebarVisibility, type SidebarSessions, type SidebarWorkspaces } from './client/session-visibility.js'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ServantView } from './contracts/views.js'
import { createServantNotices, createServantSource, type ServantClientApi } from './client/source.js'
import { ServantNoticeOverlay, ServantSidebarIcon, type ServantInjected, type ServantNoticeInjected } from './client/page.js'
import { createRequestLifecycle } from './client/request-lifecycle.js'
import { subscribeEventStreams } from './client/event-streams.js'
import { en, NS, zh } from './client/locales.js'
import { ModeClient } from './mode-router/client.js'
import { ModePage, ModeSettingsPage, type ModeInjected } from './mode-router/page.js'
import { MODE_NS, modeEn, modeZh } from './mode-router/locales.js'

declare const __SERVANT_CLIENT_CSS__: string

export const name = 'deepseek-servant-client'
export const inject = ['slots', 'locale', 'connection', 'sessions', 'workspaces', 'modelDirectories', 'remote', 'remote.agentPresets', 'remote.credentials']
const PANEL_ID = 'deepseek-servant' as MainPanelId

/** Native DSH page; all background execution remains owned by the Host bundle. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'servant.client.locales')
  ctx.effect(() => ctx.locale.register(MODE_NS, { zh: modeZh, en: modeEn }), 'servant.client.modeLocales')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.deepseekServant = 'client'
    const baseCss = typeof __SERVANT_CLIENT_CSS__ === 'undefined' ? '' : __SERVANT_CLIENT_CSS__
    const sessions = ctx.get('sessions', true) as unknown as { list: HostObservable<SidebarSessions> }
    const workspaces = ctx.get('workspaces', true) as unknown as { list: HostObservable<SidebarWorkspaces> }
    const stop = observeServantSidebarVisibility(sessions.list, workspaces.list, css => { style.textContent = baseCss + '\n' + css })
    document.head.append(style)
    return () => { stop(); style.remove() }
  }, 'servant.client.styles')
  const t = ctx.locale.bind(NS)
  const installedConnection = ctx.get('connection', true)
  if (!installedConnection) throw new Error('Servant requires the native client connection service.')
  // Host and Client share a TypeScript program but run in separate bundles;
  // Cordis's same service key is Host-typed after declaration merging here.
  const connection = installedConnection as unknown as ConnectionHandle
  const notices = createServantNotices()
  const requests = createRequestLifecycle()
  // Abort obsolete unary reads/writes before notifying their consumers. This
  // cancels client waiting only; it neither cancels Host tasks nor replays sends.
  ctx.effect(() => {
    const stop = ctx.on('connection/reset', requests.reset)
    return () => { stop(); requests.dispose() }
  }, 'servant.client.requests')
  const rpc = (endpoint: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    requests.request(signal, active => connection.rpc.call('/api', endpoint, params, active))
  const call = async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const result = await rpc('deepseek-servant-mode/shared', { method, params }, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const api: ServantClientApi = {
    view: async (input, signal) => parseView(await call('view', input ?? {}, signal), t('runtime.invalidResponse')),
    send: (input, signal) => call('send', input, signal),
    configure: (input, signal) => call('configure', input, signal),
    configureRuntime: (input, signal) => call('configureRuntime', input, signal),
    control: (input, signal) => call('control', input, signal),
    priority: (input, signal) => call('priority', input, signal),
    reconcile: (input, signal) => call('reconcile', input, signal),
    answer: (input, signal) => call('answer', input, signal),
    revise: (input, signal) => call('revise', input, signal),
    knowledge: (input, signal) => call('knowledge', input, signal),
    retention: (input, signal) => call('retention', input, signal),
    moveRecords: (input, signal) => call('moveRecords', input, signal),
    readDelivery: (input, signal) => call('readDelivery', input, signal),
    exportRecords: async (input, signal) => await call('exportRecords', input, signal) as { path: string; sha256: string; bytes: number },
    subscribeChanged: listener => subscribeEventStreams(['api/deepseek-servant/events', 'api/deepseek-servant-mode/events'], listener, requests.subscribeReset),
    subscribeReset: requests.subscribeReset,
  }
  const modeRpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const result = await rpc('deepseek-servant-mode/' + method, params)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const modeClient = new ModeClient(modeRpc, listener =>
    subscribeEventStreams(['api/deepseek-servant-mode/events'], listener, requests.subscribeReset))
  ctx.effect(() => () => modeClient.dispose(), 'servant.client.modes')
  const source = createServantSource(api, notices.show)
  ctx.effect(() => () => source.dispose(), 'servant.client.source')
  const models = createServantModels(ctx.get('sessions', true) as unknown as NativeModelSessions,
    ctx.get('modelDirectories', true) as unknown as NativeModelDirectories, async () => {
      const response = await rpc('session/modelCatalog', {})
      if (!response.ok) throw new Error(response.error.message)
      return response.value as ModelCatalog
    })
  const presetRemote = ctx.get('remote', true) as unknown as {
    agentPresets: { list(): Promise<{ ok: true; value: AgentPresetRoster } | { ok: false; error: { message: string } }> }
  }
  const onLoadPresets = async () => {
    const response = await requests.request(undefined, () => presetRemote.agentPresets.list())
    if (!response.ok) throw new Error(response.error.message)
    const roster = response.value as AgentPresetRoster
    const presetText = ctx.locale.bind('settings.agentPreset')
    return roster.presets.map(row => ({ ...row, ...presetDisplayText(row, presetText) }))
  }
  const onOpenArtifact = async (taskId: string, artifactId: string): Promise<void> => {
    try { await call('openArtifact', { taskId, artifactId }) }
    catch (error) { notices.show({ kind: 'error', key: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
  }
  const onOpenRecords = async (): Promise<void> => {
    try { await call('openRecords', {}) }
    catch (error) { notices.show({ kind: 'error', key: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
  }
  const directoryPicker = (globalThis as typeof globalThis & {
    __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> }
  }).__DSH_DIRECTORY_PICKER__
  const injectPage = (): ServantInjected & ModeInjected => ({
    modeClient, modeText: ctx.locale.bind(MODE_NS),
    hooks: { servant: source.source, models: models.source },
    onRefreshModels: models.refresh, onLoadPresets,
    onPickDirectory: directoryPicker ? () => directoryPicker.pick() : undefined,
    onRefresh: source.refresh, onHistoryPage: source.historyPage, onSend: source.send, onConfigure: source.configure, onConfigureRuntime: source.configureRuntime,
    onControl: source.control, onPriority: source.priority, onReconcile: source.reconcile, onAnswer: source.answer, onRevise: source.revise,
    onKnowledge: source.knowledge, onRetention: source.retention, onExportRecords: source.exportRecords, onMoveRecords: source.moveRecords, onOpenArtifact, onOpenRecords,
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: injectPage,
  }, ModePage))
  // Native settings.section is a public slot. Only its small registration
  // contract is needed here; data and actions are identical to the gear entry.
  const settingsSlots = ctx.slots as unknown as {
    inject(name: 'settings.section', register: () => unknown): void
    register(options: { name: 'settings.section'; id: string; order: number; locale: typeof NS; label(): string; inject: typeof injectPage },
      component: typeof ModeSettingsPage): unknown
  }
  settingsSlots.inject('settings.section', () => settingsSlots.register({
    name: 'settings.section', id: 'deepseek-servant', order: 70, locale: NS, label: () => t('panel'), inject: injectPage,
  }, ModeSettingsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel'),
    inject: () => ({ hooks: { servant: source.source }, onReadDeliveries: source.readDeliveries }),
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
