import { isLocalAttachmentError, LocalAttachmentError } from './framework/conversation-attachment-reference.js'
import { createClientFaults } from './framework/client-faults.js'
import { frameworkErrorText, frameworkRpcError, installClientErrorReporter } from './framework/client-error.js'
import { Toast, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { completionToastEnabled, createFrameworkClientNotices } from './framework/client-notices.js';
import { getFrameworkClientController } from './framework/client-contracts.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createForegroundModelPublication, selectedForegroundModel } from './client/foreground-model-publication.js';
import type { Context } from '@deepseek-ai/cordis';
import type { ClientTransportHooks, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import { attachmentFetch, uploadConversationAttachment, prepareConversationAttachmentDownload } from './framework/client-attachments.js';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types';
import { presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display';
import { createServantModels, subscribeServantModelUpdates } from './client/models.js';
import { ModelPicker } from './client/model-picker.js';
import { PresetPicker } from './client/preset-picker.js';
import { createRequestLifecycle } from './client/request-lifecycle.js';
import { subscribeEventStreams } from './client/event-streams.js';
import { en, zh, NS } from './client/locales.js';
import css from './client/page.module.css';
import { FrameworkPage } from './framework/client-page.js';
import type { FrameworkClientApi, FrameworkClientModel } from './framework/client-contracts.js';
import { createNativeQuestionClient, NativeQuestionRegion } from './client/native-questions.js'
declare const __SERVANT_CLIENT_CSS__: string;
declare const __SERVANT_STATUS_ICON_DATA_URI__: string;
export const name = 'deepseek-servant-client';
export const inject = ['slots', 'locale', 'connection', 'sessions', 'workspaces', 'remote', 'remote.agentPresets'];
const PANEL_ID = 'deepseek-servant' as MainPanelId;
export function apply(ctx: Context): void {
    const nativeQuestions = createNativeQuestionClient(ctx);
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dss.locales');
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.deepseekServant = 'client'; style.textContent = typeof __SERVANT_CLIENT_CSS__ === 'undefined' ? '' : __SERVANT_CLIENT_CSS__; document.head.append(style); return () => style.remove(); }, 'dss.styles');
    const connection = ctx.get('connection', true) as unknown as ConnectionHandle, requests = createRequestLifecycle(), t = ctx.locale.bind(NS);
    ctx.effect(() => { const off = ctx.on('connection/reset', requests.reset); return () => { off(); requests.dispose(); }; }, 'dss.requests');
    const browserFaults = createClientFaults(async input => {
        const response = await requests.request(undefined, signal => connection.rpc.call('/api', 'deepseek-servant-framework/clientFault', input as any, signal));
        if (!response.ok) throw new Error(response.error.message);
        return response.value as any;
    });
    const faultContext = (source: string, input?: unknown) => {
        const data = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const view = controller.snapshot().value;
        return { mode: data.mode === 'local' || data.mode === 'git' ? data.mode : view?.activeMode ?? 'local',
            storageScope: typeof data.storageScope === 'string' ? data.storageScope : view?.storageScope, source,
            ...(typeof data.path === 'string' ? { target: data.path } : {}) };
    };
    const call = async (method: string, input: unknown, signal?: AbortSignal): Promise<any> => {
        const occurrence = browserFaults.begin(), context = faultContext(method, input);
        try {
        const response = await requests.request(signal, signal => connection.rpc.call('/api', 'deepseek-servant-framework/' + method, input as any, signal));
        if (!response.ok)
            throw frameworkRpcError(method, response.error);
        browserFaults.observeOccurrence((response.value as any)?.faultOccurrence, (response.value as any)?.faultOwner);
        return response.value;
        } catch (error) {
            const cancelled = signal?.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason));
            if (!cancelled && !isLocalAttachmentError(error)) browserFaults.capture(error, context, occurrence);
            throw error;
        }
    };
    const rawAttachmentRequest = async <T,>(method: string, input: unknown, signal: AbortSignal | undefined, operation: (owned: AbortSignal) => Promise<T>): Promise<T> => {
        const occurrence = browserFaults.begin(), context = faultContext(method, input);
        try { return await requests.request(signal, operation); }
        catch (error) {
            if (!signal?.aborted) browserFaults.capture(error, context, occurrence);
            throw error;
        }
    };
    const attachmentTransport = (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: ClientTransportHooks }).__DSH_TRANSPORT__;
    const rawAttachmentFetch = attachmentFetch(attachmentTransport, (input, init) => globalThis.fetch(input, init));
    const api: FrameworkClientApi = {
        selectLocalAttachment: (input, signal) => call('selectLocalAttachment', input, signal),
        openLocalAttachment: (input, signal) => call('openLocalAttachment', input, signal),
        ...({
            uploadAttachment: (input, file, signal) => rawAttachmentRequest('uploadAttachment', input, signal, owned => uploadConversationAttachment(rawAttachmentFetch, input, file, owned)),
            attachment: (input, signal) => {
                if (input.reference.mode !== 'git') return Promise.reject(new LocalAttachmentError('Open the original Local attachment at its selected native path.'))
                const sha256 = input.reference.sha256
                return rawAttachmentRequest('attachmentDownload', input, signal, async owned => prepareConversationAttachmentDownload(attachmentTransport, await call('attachment', input, owned), sha256, owned))
            },
        } satisfies Partial<FrameworkClientApi>), clientFault: input => call('clientFault', input), maintenanceView: input => call('maintenanceView', input), openMaintenancePath: input => call('openMaintenancePath', input), keepCurrentLocalUpgradeTarget: input => call('keepCurrentLocalUpgradeTarget', input), exportRecords: input => call('exportRecords', input), cleanupPreview: input => call('cleanupPreview', input), cleanupRecords: input => call('cleanupRecords', input), knowledgeList: input => call('knowledgeList', input), knowledgeRead: input => call('knowledgeRead', input), knowledgeEdit: input => call('knowledgeEdit', input), knowledgeStatus: input => call('knowledgeStatus', input), view: (input, signal) => call('view', input, signal), history: (input, signal) => call('history', input, signal), send: input => call('send', input), configure: input => call('configure', input), foregroundModel: input => call('foregroundModel', input), taskControl: input => call('taskControl', input), stopExecution: input => call('stopExecution', input), gitMembers: input => call('gitMembers', input), gitMemberAction: input => call('gitMemberAction', input), invite: input => call('invite', input), moveRecords: input => call('moveRecords', input), legacyRecords: input => call('legacyRecords', input), legacyControl: input => call('legacyControl', input), participation: input => call('participation', input), selectMode: input => call('selectMode', input), readFile: input => call('readFile', input), openWorkspaceFile: input => call('openWorkspaceFile', input),
        subscribeChanged: (listener, availability) => subscribeEventStreams<import('./framework/client-contracts.js').FrameworkClientChange>(['api/deepseek-servant-framework/events'], change => { if (change?.domain === 'safety') { browserFaults.observeOccurrence(change.occurrence, change.owner); } listener(change); }, requests.subscribeReset, undefined, availability, connection.state) };
    const controller = getFrameworkClientController(api), notices = createFrameworkClientNotices({ completionToast: completionToastEnabled });
    ctx.effect(() => {
        const off = installClientErrorReporter(error => browserFaults.capture(error, faultContext('client')));
        const reset = requests.subscribeReset(browserFaults.flush);
        const connectionOff = connection.state?.subscribe(() => { if (connection.state.getSnapshot() === 'connected') browserFaults.flush(); });
        return () => { off(); reset(); connectionOff?.(); browserFaults.dispose(); };
    }, 'dss.client-safety');
    ctx.effect(() => {
        const observe = () => { const view = controller.snapshot().value; if (view) notices.observe(view); };
        const off = controller.subscribe(observe), release = controller.retainConnection();
        observe();
        return () => { off(); release(); };
    }, 'dss.client-completion');
    function Notice() {
        const { notice } = useSyncExternalStore(notices.subscribe, notices.getSnapshot);
        return notice ? <Toast key={notice.id} text={t('notice.completed') + ': ' + notice.title} tone="success" onDone={notices.dismiss}/> : null;
    }
    function Sidebar({ size }: { size: number }) {
        const snapshot = useSyncExternalStore(notices.subscribe, notices.getSnapshot);
        const unread = Object.values(snapshot.unread).some(count => count > 0);
        const mask = typeof __SERVANT_STATUS_ICON_DATA_URI__ === 'undefined' ? '' : `url("${__SERVANT_STATUS_ICON_DATA_URI__}")`;
        return <span aria-hidden="true" style={{ position: 'relative', display: 'inline-flex' }}><span className={css.servantSidebarGlyph} style={{ width: size, height: size, maskImage: mask, WebkitMaskImage: mask }}/>{unread && <span title={t('notice.completed')} style={{ position: 'absolute', right: -4, top: -4 }}><StateDot state="done"/></span>}</span>;
    }
    if (completionToastEnabled) ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'deepseek-servant.notice', locale: NS, inject: () => ({}) }, Notice));
    const models = createServantModels(async () => {
        const occurrence = browserFaults.begin(), context = faultContext('modelCatalog');
        try {
        const response = await requests.request(undefined, signal => connection.rpc.call('/api', 'session/modelCatalog', { args: {} }, signal));
        if (!response.ok)
            throw Object.assign(new Error(response.error.message), { code: response.error.code, details: response.error.details });
        const value = response.value as ModelCatalog;
        return { ...value, failures: value.failures.map(failure => { const error = new Error(failure.message); browserFaults.capture(error, { ...context, target: failure.id }, occurrence); return { ...failure, message: frameworkErrorText(error) }; }) };
        } catch (error) { browserFaults.capture(error, context, occurrence); throw error; }
    });
    ctx.effect(() => ctx.on('connection/reset', models.reset), 'dss.model-catalog-reset');
    const modelEvents = ctx.get('remote', true) as unknown as { $on: Parameters<typeof subscribeServantModelUpdates>[0] };
    ctx.effect(() => subscribeServantModelUpdates((event, listener) => modelEvents.$on(event, listener), models.invalidate), 'dss.model-catalog-updates');
    const presetRemote = ctx.get('remote', true) as unknown as {
        agentPresets: {
            list(): Promise<{
                ok: true;
                value: AgentPresetRoster;
            } | {
                ok: false;
                error: {
                    message: string;
                };
            }>;
        };
    };
    const onLoadPresets = async () => {
        const occurrence = browserFaults.begin(), context = faultContext('presets');
        try { const response = await presetRemote.agentPresets.list(); if (!response.ok) throw new Error(response.error.message);
            const text = ctx.locale.bind('settings.agentPreset');
            return response.value.presets.map(row => { const broken = row.broken && new Error(row.broken); if (broken) browserFaults.capture(broken, { ...context, target: row.id }, occurrence);
                return { ...row, ...presetDisplayText(row, text), ...(broken ? { broken: frameworkErrorText(broken) } : {}) }; });
        } catch (error) { browserFaults.capture(error, context, occurrence); throw error; }
    };
    const subscribeLocale = (listener: () => void) => ctx.locale.subscribe(listener);
    const localeSnapshot = () => ctx.locale.getSnapshot();
    const connectionState = connection.state;
    const subscribeConnection = (listener: () => void) => connectionState?.subscribe(listener) ?? (() => {});
    const connectionSnapshot = () => connectionState?.getSnapshot();
    function Page({ onConversationVisible, settingsOnly }: { onConversationVisible?: (visible: boolean) => void; settingsOnly?: boolean }) {
        const transportState = useSyncExternalStore(subscribeConnection, connectionSnapshot);
        const locale = useSyncExternalStore(subscribeLocale, localeSnapshot);
        const modelView = useSyncExternalStore(models.source.subscribe, models.source.getSnapshot);
        const picker = (globalThis as typeof globalThis & { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__;
        return <FrameworkPage nativeQuestions={(executions, zh) => <NativeQuestionRegion client={nativeQuestions} executions={executions} zh={zh}/>} api={api} settingsOnly={settingsOnly} onConversationVisible={onConversationVisible} transportConnected={connectionState ? transportState === 'connected' : undefined} language={locale.active.toLowerCase().startsWith('zh') ? 'zh' : 'en'} onViewed={view => notices.ackLocal({ mode: view.activeMode, collaborationId: view.collaborationId, storageScope: view.storageScope })} onPickDirectory={picker ? async () => { const occurrence = browserFaults.begin(), context = faultContext('directoryPicker'); try { return await picker.pick(); } catch (error) { browserFaults.capture(error, context, occurrence); throw error; } } : undefined} modelControl={(value, onChange, label, options) => <ModelPicker {...options} value={value ?? {}} models={modelView} onRefresh={models.refresh} label={label} t={t} onChange={route => onChange(route.provider && route.model ? route as FrameworkClientModel : undefined)}/>} presetControl={(value, onChange) => <PresetPicker value={value ?? 'standard'} onLoad={onLoadPresets} onChange={onChange} t={t}/>}/>;
    }
    function MainPage() {
        const [conversationVisible, setConversationVisible] = useState(false);
        const [documentVisible, setDocumentVisible] = useState(document.visibilityState === 'visible');
        const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
        const modelView = useSyncExternalStore(models.source.subscribe, models.source.getSnapshot);
        const layout = ctx.get('layout');
        const panel = useSyncExternalStore(layout?.panelInfo.subscribe ?? (() => () => {}), layout?.panelInfo.getSnapshot ?? (() => undefined));
        const publication = useRef<ReturnType<typeof createForegroundModelPublication>>();
        useEffect(() => {
            const owned = createForegroundModelPublication(ctx); publication.current = owned;
            return () => { owned.dispose(); publication.current = undefined; };
        }, []);
        useEffect(() => {
            const changed = () => setDocumentVisible(document.visibilityState === 'visible');
            document.addEventListener('visibilitychange', changed);
            return () => document.removeEventListener('visibilitychange', changed);
        }, []);
        const selection = selectedForegroundModel(state.value?.settings.foreground, modelView);
        useEffect(() => {
            controller.setConversationVisible(conversationVisible && documentVisible && panel?.activePanelId === PANEL_ID);
            return () => controller.setConversationVisible(false);
        }, [conversationVisible, documentVisible, panel?.activePanelId]);
        useEffect(() => {
            publication.current?.update(conversationVisible && documentVisible && panel?.activePanelId === PANEL_ID, selection);
        }, [conversationVisible, documentVisible, panel?.activePanelId, selection?.provider, selection?.model, selection?.reasoningEffort]);
        return <Page onConversationVisible={setConversationVisible}/>;
    }
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) }, MainPage));
    const settings = ctx.slots as unknown as {
        inject(name: 'settings.section', register: () => unknown): void;
        register(options: any, component: typeof Page): unknown;
    };
    function SettingsPage() { return <Page settingsOnly/>; }
    settings.inject('settings.section', () => settings.register({ name: 'settings.section', id: 'deepseek-servant', order: 70, locale: NS, label: () => t('panel'), inject: () => ({}) }, SettingsPage));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel'), inject: () => ({}) }, Sidebar));
}
