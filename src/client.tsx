import { Toast, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { createFrameworkClientNotices } from './framework/client-notices.js';
import { getFrameworkClientController } from './framework/client-contracts.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createForegroundModelPublication, selectedForegroundModel } from './client/foreground-model-publication.js';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types';
import { presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display';
import { createServantModels, type NativeModelSessions, type NativeModelDirectories } from './client/models.js';
import { ModelPicker } from './client/model-picker.js';
import { PresetPicker } from './client/preset-picker.js';
import { createRequestLifecycle } from './client/request-lifecycle.js';
import { subscribeEventStreams } from './client/event-streams.js';
import { en, zh, NS } from './client/locales.js';
import { FrameworkPage } from './framework/client-page.js';
import type { FrameworkClientApi, FrameworkClientModel } from './framework/client-contracts.js';
declare const __SERVANT_CLIENT_CSS__: string;
declare const __SERVANT_STATUS_ICON_DATA_URI__: string;
export const name = 'deepseek-servant-client';
export const inject = ['slots', 'locale', 'connection', 'sessions', 'workspaces', 'modelDirectories', 'remote', 'remote.agentPresets'];
const PANEL_ID = 'deepseek-servant' as MainPanelId;
export function apply(ctx: Context): void {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dss.locales');
    ctx.effect(() => { const style = document.createElement('style'); style.dataset.deepseekServant = 'client'; style.textContent = typeof __SERVANT_CLIENT_CSS__ === 'undefined' ? '' : __SERVANT_CLIENT_CSS__; document.head.append(style); return () => style.remove(); }, 'dss.styles');
    const connection = ctx.get('connection', true) as unknown as ConnectionHandle, requests = createRequestLifecycle(), t = ctx.locale.bind(NS);
    ctx.effect(() => { const off = ctx.on('connection/reset', requests.reset); return () => { off(); requests.dispose(); }; }, 'dss.requests');
    const call = async (method: string, input: unknown, signal?: AbortSignal): Promise<any> => {
        const response = await requests.request(signal, signal => connection.rpc.call('/api', 'deepseek-servant-framework/' + method, input as any, signal));
        if (!response.ok)
            throw Object.assign(new Error(response.error.message), { code: response.error.code, details: response.error.details });
        return response.value;
    };
    const api: FrameworkClientApi = { maintenanceView: input => call('maintenanceView', input), openMaintenancePath: input => call('openMaintenancePath', input), exportRecords: input => call('exportRecords', input), cleanupPreview: input => call('cleanupPreview', input), cleanupRecords: input => call('cleanupRecords', input), knowledgeList: input => call('knowledgeList', input), knowledgeRead: input => call('knowledgeRead', input), knowledgeEdit: input => call('knowledgeEdit', input), knowledgeStatus: input => call('knowledgeStatus', input), view: (input, signal) => call('view', input, signal), history: (input, signal) => call('history', input, signal), send: input => call('send', input), configure: input => call('configure', input), foregroundModel: input => call('foregroundModel', input), taskControl: input => call('taskControl', input), stopExecution: input => call('stopExecution', input), gitMembers: input => call('gitMembers', input), gitMemberAction: input => call('gitMemberAction', input), invite: input => call('invite', input), moveRecords: input => call('moveRecords', input), legacyRecords: input => call('legacyRecords', input), legacyControl: input => call('legacyControl', input), participation: input => call('participation', input), selectMode: input => call('selectMode', input), readFile: input => call('readFile', input),
        subscribeChanged: (listener, availability) => subscribeEventStreams(['api/deepseek-servant-framework/events'], listener, requests.subscribeReset, undefined, availability, connection.state) };
    const controller = getFrameworkClientController(api), notices = createFrameworkClientNotices();
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
    function Sidebar() {
        const snapshot = useSyncExternalStore(notices.subscribe, notices.getSnapshot);
        const unread = Object.values(snapshot.unread).some(count => count > 0);
        return <span style={{ position: 'relative' }}><img src={typeof __SERVANT_STATUS_ICON_DATA_URI__ === 'undefined' ? '' : __SERVANT_STATUS_ICON_DATA_URI__} alt="DSS" style={{ width: 20, height: 20 }}/>{unread && <span title={t('notice.completed')} style={{ position: 'absolute', right: -4, top: -4 }}><StateDot state="done"/></span>}</span>;
    }
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'deepseek-servant.notice', locale: NS, inject: () => ({}) }, Notice));
    const models = createServantModels(ctx.get('sessions', true) as unknown as NativeModelSessions, ctx.get('modelDirectories', true) as unknown as NativeModelDirectories, async () => {
        const response = await requests.request(undefined, signal => connection.rpc.call('/api', 'session/modelCatalog', { args: {} }, signal));
        if (!response.ok)
            throw Object.assign(new Error(response.error.message), { code: response.error.code, details: response.error.details });
        return response.value as ModelCatalog;
    });
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
    const onLoadPresets = async () => { const response = await presetRemote.agentPresets.list(); if (!response.ok)
        throw new Error(response.error.message); const text = ctx.locale.bind('settings.agentPreset'); return response.value.presets.map(row => ({ ...row, ...presetDisplayText(row, text) })); };
    const subscribeLocale = (listener: () => void) => ctx.locale.subscribe(listener);
    const localeSnapshot = () => ctx.locale.getSnapshot();
    const connectionState = connection.state;
    const subscribeConnection = (listener: () => void) => connectionState?.subscribe(listener) ?? (() => {});
    const connectionSnapshot = () => connectionState?.getSnapshot();
    function Page({ onConversationVisible }: { onConversationVisible?: (visible: boolean) => void }) {
        const transportState = useSyncExternalStore(subscribeConnection, connectionSnapshot);
        const locale = useSyncExternalStore(subscribeLocale, localeSnapshot);
        const modelView = useSyncExternalStore(models.source.subscribe, models.source.getSnapshot);
        const picker = (globalThis as typeof globalThis & { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__;
        return <FrameworkPage api={api} onConversationVisible={onConversationVisible} transportConnected={connectionState ? transportState === 'connected' : undefined} language={locale.active.toLowerCase().startsWith('zh') ? 'zh' : 'en'} onViewed={view => notices.ackLocal({ mode: view.activeMode, collaborationId: view.collaborationId, storageScope: view.storageScope })} onPickDirectory={picker ? () => picker.pick() : undefined} modelControl={(value, onChange, label, options) => <ModelPicker {...options} value={value ?? {}} models={modelView} onRefresh={models.refresh} label={label} t={t} onChange={route => onChange(route.provider && route.model ? route as FrameworkClientModel : undefined)}/>} presetControl={(value, onChange) => <PresetPicker value={value ?? 'standard'} onLoad={onLoadPresets} onChange={onChange} t={t}/>}/>;
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
            publication.current?.update(conversationVisible && documentVisible && panel?.activePanelId === PANEL_ID, selection);
        }, [conversationVisible, documentVisible, panel?.activePanelId, selection?.provider, selection?.model, selection?.reasoningEffort]);
        return <Page onConversationVisible={setConversationVisible}/>;
    }
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) }, MainPage));
    const settings = ctx.slots as unknown as {
        inject(name: 'settings.section', register: () => unknown): void;
        register(options: any, component: typeof Page): unknown;
    };
    settings.inject('settings.section', () => settings.register({ name: 'settings.section', id: 'deepseek-servant', order: 70, locale: NS, label: () => t('panel'), inject: () => ({}) }, Page));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel'), inject: () => ({}) }, Sidebar));
}
