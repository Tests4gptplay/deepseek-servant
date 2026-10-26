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
import { en, NS, zh } from './client/locales.js'
import { ModeClient } from './mode-router/client.js'
import { ModePage, ModeSettingsPage, type ModeInjected } from './mode-router/page.js'
import { MODE_NS, modeEn, modeZh } from './mode-router/locales.js'

declare const __SERVANT_CLIENT_CSS__: string

export const name = 'deepseek-servant-client'
export const inject = ['slots', 'locale', 'connection', 'sessions', 'workspaces', 'modelDirectories', 'remote', 'remote.agentPresets']
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
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const result = await connection.rpc.call('/api', 'deepseek-servant-mode/call', { mode: 'LOCAL', method, params })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const api: ServantClientApi = {
    view: async input => parseView(await call('view', input ?? {}), t('runtime.invalidResponse')),
    send: input => call('send', input),
    configure: input => call('configure', input),
    configureRuntime: input => call('configureRuntime', input),
    control: input => call('control', input),
    priority: input => call('priority', input),
    reconcile: input => call('reconcile', input),
    answer: input => call('answer', input),
    revise: input => call('revise', input),
    knowledge: input => call('knowledge', input),
    retention: input => call('retention', input),
    moveRecords: input => call('moveRecords', input),
    readDelivery: input => call('readDelivery', input),
    exportRecords: async input => await call('exportRecords', input) as { path: string; sha256: string; bytes: number },
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
  const modeRpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const result = await connection.rpc.call('/api', 'deepseek-servant-mode/' + method, params)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const credentials = (ctx.get('remote', true) as unknown as {
    credentials: { set(ref: string, value: string): Promise<{ ok: boolean; error?: { message: string } }> }
  }).credentials
  const modeClient = new ModeClient(modeRpc, async (ref, value) => {
    const result = await credentials.set(ref, value)
    if (!result.ok) throw new Error(result.error?.message ?? 'Could not save credential.')
  }, listener => {
    const events = new EventSource(new URL('api/deepseek-servant-mode/events', document.baseURI))
    events.addEventListener('changed', listener); events.addEventListener('open', listener)
    const reset = ctx.on('connection/reset', listener)
    return () => { events.close(); reset() }
  })
  ctx.effect(() => () => modeClient.dispose(), 'servant.client.modes')
  const source = createServantSource(api, notices.show)
  const models = createServantModels(ctx.get('sessions', true) as unknown as NativeModelSessions,
    ctx.get('modelDirectories', true) as unknown as NativeModelDirectories, async () => {
      const response = await connection.rpc.call('/api', 'session/modelCatalog', {})
      if (!response.ok) throw new Error(response.error.message)
      return response.value as ModelCatalog
    })
  const presetRemote = ctx.get('remote', true) as unknown as {
    agentPresets: { list(): Promise<{ ok: true; value: AgentPresetRoster } | { ok: false; error: { message: string } }> }
  }
  const onLoadPresets = async () => {
    const response = await presetRemote.agentPresets.list()
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
