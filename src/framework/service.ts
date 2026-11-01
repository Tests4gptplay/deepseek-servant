import { FrameworkRecordMove, type RecordMoveReceipt, type RecordMovePhysicalStore } from './record-move.js'
import { isDeepStrictEqual } from 'node:util'
import { listLegacyRecordExports, readLegacyRecordExport, type LegacyRecordExportIdentity } from './legacy-record-export.js'
import { frameworkStorageUsage, exportFrameworkRecords, exportFrameworkBytes } from './maintenance.js'
import { LocalFiles } from './local-files.js'
import { FrameworkManualCleanup, type ManualTaskCleanupRecord } from './manual-cleanup.js'
import { cleanupRecordPath } from './cleaner.js'
import { FrameworkKnowledge } from './knowledge.js'
import { FrameworkTaskIndex } from './task-index.js'
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { Assistant } from '../contracts/assistant.js';
import type { StoragePort } from '../contracts/ports.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import { DshSessionReader } from '../adapters/dsh/sessions.js';
import { pendingNativeStopJobs } from './native-executions.js';
import { DshWorkspaceAdapter } from '../adapters/dsh/workspace.js';
import { openFrameworkConnection, openFrameworkStorage, type FrameworkConnection, type FrameworkStorage } from './connection.js';
import { resumeLegacyTask, answerLegacyTask, captureLocalLegacy, legacyLocalProfile, readLegacyCoopSettings, type LegacyTask, type MigrationManifest } from './legacy-migration.js';
import { ExecutionControls } from './execution-control.js';
import { migrateFrameworkStorage } from './migration-lifecycle.js';
import { FrameworkConversation } from './conversation.js';
import { FrameworkRoleRuntime } from './role-runtime.js';
import { createRecorderCapacity } from './capacity.js';
import { paths, readJson, readMemberStatus, type TaskMetadata, type MemberStatus } from './task-files.js';
import { withSnapshot, FilesOutcomeUnknownError } from './transactions.js';
import { InstanceRegistration, type ObservedInstance } from './instances.js';
import type { FrameworkClientApi, FrameworkClientSettings, FrameworkClientView, FrameworkMode, FrameworkSendInput } from './client-contracts.js';
const model = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() });
const settingsSchema = z.object({ name: z.string(), userName: z.string(), localDirectory: z.string(), ownerRepo: z.string(), repositoryDirectory: z.string(),
    collaborationId: z.string().min(1), workerSeats: z.number().int().nonnegative(), workspace: z.string(), presetId: z.string().optional(),
    foreground: model.optional(), background: model.optional(), showCornerCharacter: z.boolean().optional(), swapPageIllustrations: z.boolean().optional() });
interface Saved {
    revision: string;
    settings: FrameworkClientSettings;
}
interface Access { legacyExports?: Map<string, LegacyRecordExportIdentity[]>; knowledge?: FrameworkKnowledge; taskIndex?: FrameworkTaskIndex; connection: FrameworkStorage; conversation: FrameworkConversation; observer?: InstanceRegistration; controls?: ExecutionControls }
function abortedBy(signal: AbortSignal | undefined, error: unknown): boolean {
    return !!signal?.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason));
}
interface ConfigurationOwner { mode: FrameworkMode; commandId?: string; controller: AbortController }
interface Running {
    connection: FrameworkConnection;
    runtime: FrameworkRoleRuntime;
    resources: ObservedInstance[];
}
/** Both modes use one business implementation; selecting a page does not own either runtime. */
export class FrameworkService implements Omit<FrameworkClientApi, 'subscribeChanged'> {
    private readonly accessTransitions = new Map<FrameworkMode, Promise<void>>();
    private readonly accesses = new Map<FrameworkMode, Promise<Access>>();
    private readonly stopping = new WeakMap<Running, Promise<void>>();
    private readonly running = new Map<FrameworkMode, Running>();
    private readonly configurationOwners = new Set<ConfigurationOwner>();
    private readonly accessOpening = new Map<FrameworkMode, AbortController>();
    private readonly backgroundOpening = new Map<FrameworkMode, AbortController>();
    private readonly opening = new Map<FrameworkMode, Promise<Running>>();
    private readonly archiveViews = new Map<FrameworkMode, FrameworkClientView['archives']>();
    private readonly errors = new Map<FrameworkMode, string>();
    private readonly configurationErrors = new Map<FrameworkMode, string>();
    private readonly reportedErrors = new Map<FrameworkMode, Map<string, { operationId?: string; commandId?: string }>>();
    private readonly saved = new Map<FrameworkMode, Saved>();
    private readonly listeners = new Set<() => void>();
    private activeMode: FrameworkMode = 'local';
    private legacyCoop?: Awaited<ReturnType<typeof readLegacyCoopSettings>>;
    private configuration: Promise<unknown> = Promise.resolve();
    private closed = false;
    private recordMoving?: Error;
    private recordMoveController?: AbortController;
    private recordMover?: FrameworkRecordMove;
    private pendingRecordMove?: RecordMoveReceipt;
    private readonly relocationOwners = new Map<FrameworkMode, FrameworkRoleRuntime>();
    private disposal?: Promise<void>;
    private starting?: Promise<void>;
    private readonly disposalErrors: unknown[] = [];
    private assertOpen(): void { if (this.closed) throw new Error('Framework service is disposed.'); }
    private cleanupFailure(mode: FrameworkMode, error: unknown): void { this.disposalErrors.push(error); this.report(mode, error); }
    constructor(private readonly ctx: Context, private readonly storage: StoragePort, private readonly defaults: FrameworkClientSettings) { }
    subscribeChanged = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private changed(): void { for (const listener of this.listeners)
        listener(); }
    private diagnosticScope(mode: FrameworkMode, settings = this.saved.get(mode)?.settings): string {
        if (!settings) return mode + ' (storage scope unavailable)';
        return mode === 'local' ? settings.localDirectory : settings.ownerRepo + '/' + settings.repositoryDirectory;
    }
    private refreshErrors(mode: FrameworkMode): void {
        const messages = this.reportedErrors.get(mode);
        if (messages?.size) this.errors.set(mode, [...messages.keys()].join('\n'));
        else { this.errors.delete(mode); this.reportedErrors.delete(mode); }
    }
    private clearResolvedErrors(mode: FrameworkMode, commandId?: string): void {
        const messages = this.reportedErrors.get(mode);
        for (const [message, record] of messages ?? []) {
            if (commandId === undefined ? !record.operationId : record.commandId === commandId) messages!.delete(message);
        }
        this.refreshErrors(mode);
    }
    private report(mode: FrameworkMode, error: unknown, scope?: string, commandId?: string): string {
        const raw = error instanceof Error ? error.message : String(error);
        const operationId = error instanceof FilesOutcomeUnknownError ? error.operationId : undefined;
        const message = operationId ? `Unresolved storage operation ${operationId} in ${scope ?? this.diagnosticScope(mode)}: ${raw}` : raw;
        let messages = this.reportedErrors.get(mode);
        if (!messages) this.reportedErrors.set(mode, messages = new Map());
        if (!messages.has(message)) { messages.set(message, { operationId, commandId }); this.refreshErrors(mode); this.changed(); }
        else if (commandId !== undefined) messages.get(message)!.commandId = commandId;
        return message;
    }
    start(): Promise<void> {
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        return this.starting ??= this.startOwned();
    }
    private async startOwned(): Promise<void> {
        this.activeMode = await this.storage.get<FrameworkMode>('framework-active-mode') ?? 'local';
        for (const mode of ['local', 'git'] as const) {
            this.assertOpen();
            const key = 'framework-settings/' + mode;
            let saved = await this.storage.get<Saved>(key);
            if (!saved) {
                let settings = { ...this.defaults };
                if (mode === 'local') {
                    const legacyRuntime = await this.storage.get<{ schemaVersion?: number; workerSeats?: number }>('settings/runtime');
                    if (legacyRuntime?.schemaVersion === 1 && Number.isSafeInteger(legacyRuntime.workerSeats) && legacyRuntime.workerSeats! >= 0) {
                        settings.workerSeats = legacyRuntime.workerSeats!;
                    }
                    const profile = legacyLocalProfile(await captureLocalLegacy(this.storage));
                    if (profile) {
                        const route = (value: typeof profile.settings.foreground) => value.provider && value.model ? { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort } : undefined;
                        settings = { ...settings, name: profile.settings.name, userName: profile.settings.userName ?? '', presetId: profile.settings.presetId,
                            workspace: profile.settings.workspaceDirectory ?? profile.workspace.directory, foreground: route(profile.settings.foreground), background: route(profile.settings.background),
                            showCornerCharacter: profile.settings.showCornerCharacter, swapPageIllustrations: profile.settings.swapPageIllustrations };
                    }
                } else {
                    this.legacyCoop = await readLegacyCoopSettings(this.ctx);
                    const old = this.legacyCoop.settings;
                    settings = { ...settings, ownerRepo: old.ownerRepo, repositoryDirectory: old.repositoryDirectory, workerSeats: old.workerSeats,
                        workspace: old.workspace, presetId: old.presetId, background: old.provider && old.model ? { provider: old.provider, model: old.model, reasoningEffort: old.reasoningEffort } : undefined };
                    if (await this.storage.get<boolean>('framework-participation/git') === undefined) await this.storage.set('framework-participation/git', old.remoteEnabled);
                }
                saved = { revision: randomUUID(), settings };
            }
            await this.storage.set(key, saved);
            this.saved.set(mode, saved);
        }
        const physical = this.storage as StoragePort & Partial<RecordMovePhysicalStore>;
        if (physical.moveRecords && physical.storageView) {
            const controller = this.recordMoveController = new AbortController();
            try {
                this.pendingRecordMove = await this.mover().pendingReceipt();
                await this.mover().resumePending(controller.signal);
                this.pendingRecordMove = undefined;
            }
            catch (error) {
                if (this.closed) throw error;
                this.recordMoving ??= error instanceof Error ? error : new Error(String(error));
                this.report('local', error); return;
            }
            finally { if (this.recordMoveController === controller) this.recordMoveController = undefined; }
        }
        for (const mode of ['local', 'git'] as const) {
            this.assertOpen();
            const enabled = await this.storage.get<boolean>('framework-participation/' + mode) ?? mode === 'local';
            if (enabled) {
                const scope = this.diagnosticScope(mode), opening = this.connect(mode), signal = this.backgroundOpening.get(mode)?.signal;
                try { await opening; } catch (error) { if (this.closed) throw error; if (!abortedBy(signal, error)) this.report(mode,error,scope); }
            } else if (mode === 'local') {
                try {
                    const access = await this.access(mode);
                    await this.withManualCleanup(access, cleanup => cleanup.resumePending((error, commandId) => { this.report(mode, error, access.connection.scope, commandId); }));
                } catch (error) { if (this.closed) throw error; this.report(mode, error); }
            }
        }
    }
    private access(mode: FrameworkMode): Promise<Access> {
        if (this.recordMoving) return Promise.reject(this.recordMoving);
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        const transition = this.accessTransitions.get(mode);
        if (transition) return transition.then(() => this.access(mode));
        const prior = this.accesses.get(mode); if (prior) return prior;
        const settings = this.config(mode).settings;
        const controller = new AbortController();
        this.accessOpening.set(mode, controller);
        const pending = openFrameworkStorage(mode === 'local' ? { mode, directory: settings.localDirectory, login: settings.userName, workerSeats: settings.workerSeats }
            : { mode, ownerRepo: settings.ownerRepo, repositoryDirectory: settings.repositoryDirectory, workerSeats: settings.workerSeats }, { storage: this.storage, signal: controller.signal })
          .then(async connection => {
            if (this.closed || controller.signal.aborted || this.accessOpening.get(mode) !== controller) {
                try { await connection.close(); } catch (error) { this.cleanupFailure(mode, error); throw error; }
                this.assertOpen();
                controller.signal.throwIfAborted();
                throw new Error('Storage access was replaced before acquisition completed.');
            }
            return { connection, conversation: new FrameworkConversation(connection.files, connection.transactions, { mode, collaborationId: settings.collaborationId }) };
          });
        this.accesses.set(mode,pending);
        void pending.finally(() => { if (this.accessOpening.get(mode) === controller) this.accessOpening.delete(mode); }).catch(() => {});
        void pending.catch(() => { if(this.accesses.get(mode) === pending) this.accesses.delete(mode); });
        return pending;
    }
    private config(mode: FrameworkMode): Saved { this.assertOpen(); const saved = this.saved.get(mode); if (!saved)
        throw new Error('Framework settings are not loaded.'); return saved; }
    private connect(mode: FrameworkMode, signal?: AbortSignal): Promise<Running> {
        if (this.recordMoving) return Promise.reject(this.recordMoving);
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        const active = this.running.get(mode);
        if (active)
            return Promise.resolve(active);
        const pending = this.opening.get(mode);
        if (pending)
            return pending;
        const controller = new AbortController();
        this.backgroundOpening.set(mode, controller);
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        const operation = this.open(mode, controller.signal);
        this.opening.set(mode, operation);
        void operation.finally(() => { signal?.removeEventListener('abort', abort); if (this.backgroundOpening.get(mode) === controller) this.backgroundOpening.delete(mode); if (this.opening.get(mode) === operation)
            this.opening.delete(mode); }).catch(() => { });
        return operation;
    }
    private async open(mode: FrameworkMode, signal?: AbortSignal): Promise<Running> {
        const settings = this.config(mode).settings;
        const workspace = await new DshWorkspaceAdapter(this.ctx).resolve(undefined, settings.workspace || undefined);
        this.assertOpen(); signal?.throwIfAborted();
        const connection = await openFrameworkConnection(mode === 'local' ? { mode, directory: settings.localDirectory, login: settings.userName, workerSeats: settings.workerSeats }
            : { mode, ownerRepo: settings.ownerRepo, repositoryDirectory: settings.repositoryDirectory, workerSeats: settings.workerSeats }, { storage: this.storage, signal });
        let resources: ObservedInstance[];
        try {
            this.assertOpen();
            signal?.throwIfAborted();
            resources = await connection.members();
            signal?.throwIfAborted();
            if (mode === 'git') this.legacyCoop ??= await readLegacyCoopSettings(this.ctx);
            await migrateFrameworkStorage({ mode, scope: connection.scope, files: connection.files, transactions: connection.transactions, records: this.storage,
                options: async (capture, id) => {
                    const member = connection.registration.member, account = connection.repository ? String(connection.repository.identity.id) : member;
                    const members: Record<string, string> = {};
                    if (mode === 'local') for (const task of capture.tasks) for (const participant of task.participants) members[participant.identity] = member;
                    else if (this.legacyCoop?.instanceId) members[account + '/' + this.legacyCoop.instanceId] = member;
                    const nativeOwnershipReconciled: Record<string, Array<{ executionId: string; generation: number; settled: boolean }>> = {};
                    for (const task of capture.tasks) for (const participant of task.participants) {
                        if (!members[participant.identity]) continue;
                        const evidence = nativeOwnershipReconciled[participant.identity] ??= [];
                        for (const execution of participant.nativeExecutions ?? []) {
                            let settled = false;
                            const sessionId = SessionId(execution.sessionId), owner = execution.agentId ?? execution.sessionId;
                            const live = this.ctx.agents.get(sessionId), jobs = this.ctx.jobs.list(sessionId).filter(job => job.owner === owner && (job.status === 'running' || job.status === 'stopping'));
                            if (!live && !jobs.length) {
                                if (execution.recordedSettled && !execution.ownedJobIds.length) settled = true;
                                else try {
                                    const events = await new DshSessionReader(this.ctx).events(execution.sessionId);
                                    const known = [...new Set([...execution.ownedJobIds, ...events.filter(event => event.type === 'job/registered' && event.data.owner === owner).map(event => (event.data as { jobId: string }).jobId)])];
                                    settled = known.length > 0 && pendingNativeStopJobs(owner, events, known).length === 0;
                                } catch { /* Missing native evidence remains an explicit unresolved migration domain. */ }
                            }
                            evidence.push({ executionId: execution.executionId, generation: execution.generation, settled });
                        }
                    }
                    return { id, owner: member, members, nativeOwnershipReconciled, conversations: mode === 'local'
                        ? [{ scope: { mode, collaborationId: settings.collaborationId }, assistantId: 'default', participantId: account }]
                        : [{ scope: { mode, collaborationId: settings.collaborationId }, entryPaths: capture.records.filter(record => /^conversations\/.+\/entry\.json$/.test(record.key)).map(record => record.key),
                            ...(this.legacyCoop?.instanceId ? { foregroundIdentity: { participantId: account, instanceId: this.legacyCoop.instanceId } } : {}) }] };
                } });
        }
        catch (error) {
            await connection.close().catch(failure => this.cleanupFailure(mode, failure));
            throw error;
        }
        const resource = { connection, resources } as Running;
        let runtime: FrameworkRoleRuntime | undefined;
        const cleanupFailures: Array<{ error: unknown; commandId: string }> = [];
        try {
            this.assertOpen();
            const profile = mode === 'local' ? await this.storage.get<Assistant>('assistant/default') : undefined;
            const legacySkillScopes = profile?.schemaVersion === 1 && profile.id === 'default' && profile.workspace.id === workspace.id ? [{ assistantId: 'default', workspaceId: workspace.id }] : [];
            this.assertOpen();
            runtime = new FrameworkRoleRuntime(this.ctx, connection.files, this.storage, {
                scope: connection.scope, legacySkillScopes, legacyGitSkillParticipants: connection.repository ? [String(connection.repository.identity.id)] : [], member: connection.registration.member, primary: connection.registration.primary, workspace: workspace.directory,
                workerSeats: settings.workerSeats, mode, collaborationId: settings.collaborationId, presetId: settings.presetId,
                foreground: settings.foreground, background: settings.background,
            }, { members: () => resource.resources.map(row => row.member), resources: () => resource.resources, capacity: createRecorderCapacity(connection.files),
                changed: () => this.changed(), restored: () => { this.clearResolvedErrors(mode); this.changed(); },
                cancelPending: reason => connection.cancelPending(reason), heartbeat: async () => {
                    await connection.tick();
                    resource.runtime.updateWorkerSeats(connection.registration.workerSeats);
                }, observationInterrupted: () => connection.observationInterrupted(), observeResources: async snapshot => {
                    const next = await connection.members(snapshot);
                    const visible = (rows: ObservedInstance[]) => JSON.stringify(rows.map(row => ({ member: row.member, workerSeats: row.workerSeats, availability: row.availability, error: row.error })));
                    const changed = visible(next) !== visible(resource.resources);
                    resource.resources = next;
                    if (changed)
                        this.changed();
                }, error: error => { this.report(mode, error, this.diagnosticScope(mode, settings)); } });
            resource.runtime = runtime;
            signal?.throwIfAborted();
            if (mode === 'local') {
                const cleanup = new FrameworkManualCleanup(connection.files, connection.transactions, runtime.conversation, runtime);
                await cleanup.resumePending((error, commandId) => { cleanupFailures.push({ error, commandId }); });
            }
            signal?.throwIfAborted();
            await runtime.start();
            this.assertOpen(); signal?.throwIfAborted();
            this.running.set(mode, resource);
            this.clearResolvedErrors(mode);
            for (const { error, commandId } of cleanupFailures) this.report(mode, error, connection.scope, commandId);
            return resource;
        }
        catch (error) {
            await runtime?.dispose().catch(failure => this.cleanupFailure(mode, failure));
            await connection.close().catch(failure => this.cleanupFailure(mode, failure));
            throw error;
        }
    }
    async view(input: {
        mode?: FrameworkMode;
        includeArchives?: boolean;
    } = {}): Promise<FrameworkClientView> {
        const mode = input.mode ?? this.activeMode, saved = this.config(mode), active = this.running.get(mode);
        const base: FrameworkClientView = { revision: saved.revision, activeMode: mode, collaborationId: saved.settings.collaborationId, settings: saved.settings,
            connection: { participating: !!active, status: active ? 'connected' : 'disconnected', detail: this.errors.get(mode), member: active?.connection.registration.member, workerSeats: active?.connection.registration.workerSeats }, messages: [], tasks: [], legacyTasks: [], archives: this.archiveViews.get(mode) ?? [], resources: [] };
        if (mode === 'local' && this.pendingRecordMove?.scope) base.pendingRecordMove = { commandId: this.pendingRecordMove.commandId,
            storageScope: this.pendingRecordMove.scope, expectedRevision: this.pendingRecordMove.settingsBefore.revision, directory: this.pendingRecordMove.targetRecords };
        let access: Access;
        try { access = await this.access(mode); base.connection.status = 'connected'; } catch(error) { if (this.closed) throw error; base.connection.detail = error instanceof Error ? error.message : String(error); return base; }
        // Access may have waited for an actual settings/scope handoff. Never
        // pair an earlier header with the newly acquired destination.
        if (this.config(mode).revision !== saved.revision) return this.view(input);
        base.storageScope = access.connection.scope;
        if (input.includeArchives) base.archives = [];
        const page = await access.conversation.page(20);
        base.messages = page.messages;
        base.pageBefore = page.moreBefore;
        let observed = active?.resources ?? [];
        try { observed = active?.resources ?? await this.observe(access, mode); } catch (error) { this.report(mode, error); }
        const localMember = active?.connection.registration.member ?? observed.find(row => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
        base.resources = observed.filter(row => !row.primary).map(row => ({ name: row.member, status: row.availability, instanceUUID: row.instanceUUID, workerSeats: row.workerSeats, detail: row.error }));
        try { await withSnapshot(access.connection.files, async (snapshot) => {
            try {
            access.taskIndex ??= new FrameworkTaskIndex(access.connection.files, error => this.report(mode, error));
            for (const task of await access.taskIndex.list(snapshot)) {
                const cleanup = (task.status === 'complete' || mode === 'local') ? await readJson<ManualTaskCleanupRecord>(access.connection.files, snapshot, cleanupRecordPath(task.taskId)) : undefined;
                if (cleanup?.version === 1 && cleanup.taskId === task.taskId && cleanup.phase === 'released' && cleanup.historyCleared === true) {
                    if (input.includeArchives && cleanup.preservedArtifacts.length) base.archives.push({ path: cleanup.preservedArtifacts[0]!, title: task.sourcePath, taskId: task.taskId, files: cleanup.preservedArtifacts });
                    continue;
                }
                const members = await Promise.all((task.members ?? [task.owner]).map(async name => {
                    try { return { name, status: (await readMemberStatus(access.connection.files, snapshot, paths.memberStatus(task.taskId, name)))?.state ?? 'unknown' }; }
                    catch (error) { this.report(mode, error); return { name, status: 'unknown' }; }
                }));
                base.tasks.push({ taskId: task.taskId, title: task.sourcePath.split('/').at(-1)!, route: task.route, owner: task.owner, status: task.status,
                    members, control: (await this.controls(access, active).task(task.taskId))?.intent, executions: active?.runtime.executionViews(task.taskId) ?? [], resultPaths: task.resultPaths ?? [] });
            }
            } catch (error) { this.report(mode, error); }
            try {
            const migrations = await readJson<{ migrations: Array<{ id: string; manifestPath: string }> }>(access.connection.files, snapshot, 'technical/legacy-migrations/index.json');
            for (const migration of migrations?.migrations ?? []) {
                try {
                const manifest = await readJson<MigrationManifest>(access.connection.files, snapshot, migration.manifestPath);
                if (input.includeArchives) {
                    try {
                        const found = await listLegacyRecordExports(access.connection.files, snapshot, migration.manifestPath, error => this.report(mode, error));
                        (access.legacyExports ??= new Map()).set(migration.id, found);
                    } catch (error) { access.legacyExports?.delete(migration.id); this.report(mode, error); }
                }
                const clearedIds = new Set((manifest as (MigrationManifest & { clearedTasks?: Array<{ oldId: string }> }) | undefined)?.clearedTasks?.map(item => item.oldId) ?? []);
                const exports = (access.legacyExports?.get(migration.id) ?? []).filter(item => !clearedIds.has(item.oldTaskId));
                for (const task of manifest?.tasks ?? []) {
                    if (clearedIds.has(task.oldId)) continue;
                    const own = task.memberContinuations?.find(row => row.member === localMember);
                    const terminal = task.continuation === 'complete' || task.continuation === 'cancelled';
                    base.legacyTasks.push({ migrationId: migration.id, oldTaskId: task.oldId, taskId: task.taskId, continuation: terminal ? task.continuation : own?.continuation ?? task.continuation,
                        recordPath: task.recordPath, recordsAvailable: exports.some(row => row.oldTaskId === task.oldId), issues: manifest?.issues, waits: terminal ? [] : own?.waits?.map(wait => ({ ...wait, memberIdentity: own.identity })) });
                }
                for (const row of exports) if (!manifest?.tasks.some(task => task.oldId === row.oldTaskId))
                    base.legacyTasks.push({ migrationId: migration.id, ...row, recordsAvailable: true });
                if (input.includeArchives) for (const cleared of (manifest as (MigrationManifest & { clearedTasks?: Array<{ oldId: string; taskId: string; preservedArtifacts?: string[] }> }) | undefined)?.clearedTasks ?? []) {
                    const files = cleared.preservedArtifacts;
                    if (Array.isArray(files) && files.length && files.every(path => typeof path === 'string'))
                        base.archives.push({ path: files[0]!, title: cleared.oldId, taskId: cleared.taskId, files: [...files] });
                }
                } catch (error) { this.report(mode, error); }
            }
            } catch (error) { this.report(mode, error); }
            if (input.includeArchives) {
                const entries = await access.connection.files.list(snapshot, 'archives/');
                base.archives.push(...entries.filter(entry => /^archives\/[^/]+\/records\.md$/.test(entry.path)).map(entry => {
                    const taskId = entry.path.split('/')[1]!, prefix = `archives/${taskId}/`;
                    return { path: entry.path, title: taskId, taskId,
                        files: entries.filter(file => file.path.startsWith(prefix) && file.path !== entry.path && file.path !== `${prefix}retention.json`).map(file => file.path).sort() };
                }));
            }
        }); } catch (error) { this.report(mode, error); }
        base.connection.detail = this.errors.get(mode);
        if (input.includeArchives)
            this.archiveViews.set(mode, base.archives);
        return base;
    }
    private mover(): FrameworkRecordMove {
        if (this.recordMover) return this.recordMover;
        const physical = this.storage as StoragePort & Partial<RecordMovePhysicalStore>;
        if (!physical.moveRecords || !physical.storageView) throw new Error('This Host does not expose its owned records relocation.');
        return this.recordMover = new FrameworkRecordMove(this.storage, physical as StoragePort & RecordMovePhysicalStore, {
            quiesce: (receipt, signal) => this.quiesceRecords(receipt, signal),
            applySettings: async receipt => {
                const current = await this.storage.get<Saved>('framework-settings/local');
                if (!isDeepStrictEqual(current, receipt.settingsAfter)) {
                    if (!isDeepStrictEqual(current, receipt.settingsBefore)) throw new Error('Local settings changed outside the retained record move.');
                    await this.storage.set('framework-settings/local', receipt.settingsAfter);
                }
                this.saved.set('local', structuredClone(receipt.settingsAfter));
            },
            reopen: async (_receipt, signal) => {
                this.recordMoving = undefined;
                for (const mode of ['local', 'git'] as const) {
                    signal.throwIfAborted(); this.assertOpen();
                    if (await this.storage.get<boolean>('framework-participation/' + mode) ?? mode === 'local') await this.connect(mode, signal);
                }
            },
        });
    }
    private async quiesceRecords(_receipt: Readonly<RecordMoveReceipt>, signal: AbortSignal): Promise<void> {
        this.pendingRecordMove = structuredClone(_receipt);
        // Materialize only the configured access owners before blocking new
        // acquisitions. A mechanical runtime reads existing execution evidence;
        // it never starts a loop, registers a member or opens an Agent.
        const owners = new Map<FrameworkMode, Access>();
        for (const mode of ['local', 'git'] as const) {
            if (mode === 'git' && !this.running.has(mode) && !this.opening.has(mode) && !this.accesses.has(mode)) {
                // A configured repository is not an acquired execution owner.
                // Do not authenticate a never-used/offline Git scope merely to
                // move Local records. Only durable unsettled roles require a
                // cold ownership check before moving their technical store.
                let unsettled = false;
                const settings = this.config(mode).settings;
                for (const entry of await this.storage.list<{ mode: string; ownerRepo?: string; repositoryDirectory?: string }>('framework-connection-settings/')) {
                    if (entry.value.mode !== 'git') continue;
                    const prefix = 'framework-runtime/' + entry.key.slice('framework-connection-settings/'.length) + '/roles/';
                    const roles = await this.storage.list<{ released?: boolean; stopped?: boolean }>(prefix);
                    if (!roles.some(row => !row.value.released && !row.value.stopped)) continue;
                    if (entry.value.ownerRepo?.toLowerCase() !== settings.ownerRepo.toLowerCase() || (entry.value.repositoryDirectory ?? '') !== settings.repositoryDirectory)
                        throw new Error('A previous Git storage scope has unresolved native execution ownership; retain its records before moving.');
                    unsettled = true;
                }
                if (!unsettled) continue;
            }
            if (!this.recordMoving) owners.set(mode, await this.access(mode));
        }
        this.recordMoving = new Error('The confirmed record move owns these locations; resume that command before accessing records.');
        for (const controller of [...this.accessOpening.values(), ...this.backgroundOpening.values()]) controller.abort(this.recordMoving);
        await Promise.allSettled([...this.opening.values()]);
        const failures: unknown[] = [];
        for (const mode of ['local', 'git'] as const) {
            const active = this.running.get(mode), access = owners.get(mode);
            const settings = this.config(mode).settings;
            let runtime = this.relocationOwners.get(mode) ?? active?.runtime;
            try {
                if (!runtime && access) runtime = new FrameworkRoleRuntime(this.ctx, access.connection.files, this.storage, {
                    scope: access.connection.scope, member: access.connection.identity.login, primary: mode === 'local',
                    workspace: settings.workspace, workerSeats: settings.workerSeats, mode, collaborationId: settings.collaborationId,
                    presetId: settings.presetId, foreground: settings.foreground, background: settings.background,
                }, { members: () => [], resources: () => [], heartbeat: async () => {}, error: error => this.report(mode, error), changed: () => this.changed(), cancelPending: reason => access.connection.cancelPending(reason) });
                if (runtime) { this.relocationOwners.set(mode, runtime); await runtime.settleForStorageMove(); }
            } catch (error) { failures.push(error); }
            if (active) try { await active.connection.close(); } catch (error) { failures.push(error); }
            if (access) try { access.connection.cancelPending(); await access.connection.close(); } catch (error) { failures.push(error); }
        }
        this.running.clear(); this.accesses.clear(); this.archiveViews.clear();
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Record relocation could not confirm all storage owners stopped.');
        this.relocationOwners.clear();
    }
    moveRecords(input: { mode: 'local'; storageScope: string; expectedRevision: string; commandId: string; directory: string }): Promise<FrameworkClientView> {
        const operation = this.configuration.then(async () => {
            this.assertOpen();
            if (input.mode !== 'local') throw new Error('Owned records relocation is a Local user action.');
            const mover = this.mover(), prior = await mover.receipt(input.commandId);
            const controller = this.recordMoveController = new AbortController();
            try {
                if (prior) {
                    if (prior.scope !== input.storageScope || prior.settingsBefore.revision !== input.expectedRevision)
                        throw new Error('Move retry must retain its original location, scope and settings revision.');
                    await mover.run(input.commandId, { ...prior, targetRecords: input.directory }, controller.signal);
                } else {
                    const before = this.config('local');
                    if (before.revision !== input.expectedRevision) throw new Error('Settings changed; reread before moving records.');
                    const access = await this.access('local'); this.checkScope(access, input.storageScope);
                    if (!(access.connection.files instanceof LocalFiles)) throw new Error('Record relocation requires Local files.');
                    const physical = this.storage as StoragePort & RecordMovePhysicalStore;
                    await mover.run(input.commandId, { sourceRecords: physical.storageView().directory, targetRecords: input.directory,
                        sourceLocal: access.connection.files.directory, scope: access.connection.scope,
                        settingsBefore: structuredClone(before), nextSettingsRevision: randomUUID() }, controller.signal);
                }
                this.pendingRecordMove = undefined;
                this.clearResolvedErrors('local', input.commandId); this.changed();
                return this.view({ mode: 'local', includeArchives: true });
            } catch (error) {
                try { this.pendingRecordMove = await mover.pendingReceipt() ?? this.pendingRecordMove; } catch { /* Keep the already-owned intent if locator reconciliation remains unknown. */ }
                this.report('local', error, input.storageScope, input.commandId); throw error;
            }
            finally { if (this.recordMoveController === controller) this.recordMoveController = undefined; }
        });
        this.configuration = operation.catch(() => {}); return operation;
    }
    async maintenanceView(input: Parameters<FrameworkClientApi['maintenanceView']>[0]) {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        if (input.mode !== 'local' || !(access.connection.files instanceof LocalFiles)) throw new Error('Local records management requires its Local storage.');
        const store = this.storage as StoragePort & { storageView?(): { directory: string; nativeDirectory?: string } };
        const directories = store.storageView?.();
        return { localDirectory: access.connection.files.directory, recordsDirectory: directories?.directory,
            nativeDirectory: directories?.nativeDirectory, usage: await frameworkStorageUsage(access.connection.files) };
    }
    async openMaintenancePath(input: Parameters<FrameworkClientApi['openMaintenancePath']>[0]) {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        if (input.mode !== 'local' || !(access.connection.files instanceof LocalFiles)) throw new Error('Local records management requires its Local storage.');
        const store = this.storage as StoragePort & { storageView?(): { directory: string; nativeDirectory?: string } };
        const path = input.target === 'records' ? access.connection.files.directory : store.storageView?.().nativeDirectory;
        if (!path) throw new Error('The Host has not supplied the native session log directory.');
        const controller = this.ctx.get('sessionController');
        if (!controller?.canOpenWorkspacePath()) throw new Error('This Host cannot open local directories. Path: ' + path);
        await controller.openWorkspacePath({ path });
        return { path };
    }
    private async legacyManifestPath(access: Access, snapshot: import('./transactions.js').FilesSnapshot, migrationId: string): Promise<string> {
        const index = await readJson<{ migrations: Array<{ id: string; manifestPath: string }> }>(access.connection.files, snapshot, 'technical/legacy-migrations/index.json');
        const matches = index?.migrations.filter(item => item.id === migrationId) ?? [];
        if (matches.length !== 1) throw new Error('Select an existing legacy migration.');
        return matches[0]!.manifestPath;
    }
    async legacyRecords(input: { mode: FrameworkMode; storageScope?: string; migrationId: string; oldTaskId: string }): Promise<{ text: string; revision: string }> {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        return withSnapshot(access.connection.files, async snapshot => {
            const manifestPath = await this.legacyManifestPath(access, snapshot, input.migrationId);
            const record = await readLegacyRecordExport(access.connection.files, snapshot, { manifestPath, oldTaskId: input.oldTaskId });
            return { text: Buffer.from(record.bytes).toString('utf8'), revision: snapshot.revision };
        });
    }
    exportRecords(input: Parameters<FrameworkClientApi['exportRecords']>[0]) {
        const operation = this.configuration.then(async () => {
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            if (input.mode !== 'local') throw new Error('Record export is a Local user action.');
            const workspace = await new DshWorkspaceAdapter(this.ctx).resolve(undefined, this.config(input.mode).settings.workspace || undefined);
            if (input.taskId && !input.migrationId && !input.oldTaskId)
                return exportFrameworkRecords(access.connection.files, input.taskId, workspace.directory);
            if (input.taskId || !input.migrationId || !input.oldTaskId) throw new Error('Select exactly one current or legacy record.');
            const record = await withSnapshot(access.connection.files, async snapshot => {
                const manifestPath = await this.legacyManifestPath(access, snapshot, input.migrationId!);
                return readLegacyRecordExport(access.connection.files, snapshot, { manifestPath, oldTaskId: input.oldTaskId! });
            });
            return exportFrameworkBytes(record.bytes, record.taskId, workspace.directory);
        });
        this.configuration = operation.catch(() => {}); return operation;
    }
    /** Explicit maintenance uses the existing background owner when present. A
     * disconnected Local scope gets only a mechanical lifecycle owner: no
     * registration, heartbeat, loop or Agent is started. */
    private async withManualCleanup<T>(access: Access, operation: (cleanup: FrameworkManualCleanup, runtime: FrameworkRoleRuntime) => Promise<T>, owned?: FrameworkRoleRuntime): Promise<T> {
        if (access.conversation.scope.mode !== 'local') throw new Error('Manual record cleanup is a Local user action.');
        const settings = this.config('local').settings;
        const active = owned ?? this.running.get('local')?.runtime;
        const runtime = active ?? new FrameworkRoleRuntime(this.ctx, access.connection.files, this.storage, {
            scope: access.connection.scope, member: access.connection.identity.login, primary: true,
            workspace: settings.workspace, workerSeats: settings.workerSeats, mode: 'local', collaborationId: settings.collaborationId,
            presetId: settings.presetId, foreground: settings.foreground, background: settings.background,
        }, { members: () => [], resources: () => [], heartbeat: async () => {}, error: error => this.report('local', error), changed: () => this.changed() });
        if (runtime.config.scope !== access.connection.scope) throw new Error('Cleanup belongs to another Local storage scope.');
        const cleanup = new FrameworkManualCleanup(access.connection.files, access.connection.transactions, access.conversation, runtime);
        let result: T | undefined; const failures: unknown[] = [];
        try { result = await operation(cleanup, runtime); } catch (error) { failures.push(error); }
        finally { if (!active) try { await runtime.dispose(); } catch (error) { failures.push(error); } }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Manual cleanup and lifecycle disposal failed.');
        return result as T;
    }
    async cleanupPreview(input: Parameters<FrameworkClientApi['cleanupPreview']>[0]) {
        await this.starting;
        const operation = this.configuration.then(async () => {
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            return this.withManualCleanup(access, cleanup => cleanup.previewTasks());
        });
        this.configuration = operation.catch(() => {}); return operation;
    }
    async cleanupRecords(input: Parameters<FrameworkClientApi['cleanupRecords']>[0]) {
        await this.starting;
        const operation = this.configuration.then(async () => {
            this.assertOpen();
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            const result = await this.withManualCleanup(access, async (cleanup, runtime) => {
                if (input.action === 'tasks') {
                    const result = await cleanup.clearTasks(input.commandId, input.preview, input.confirmation);
                    for (const task of input.preview.tasks) await runtime.prepareTaskCleanup(task.taskId);
                    return result;
                }
                if (input.action === 'conversation') return cleanup.clearConversation(input.commandId, input.confirmation);
                return cleanup.clearPlanning(input.commandId, input.confirmation);
            });
            this.archiveViews.delete(input.mode); access.legacyExports = undefined; this.changed(); return result;
        });
        this.configuration = operation.catch(() => {}); return operation;
    }
    private knowledge(access: Access, mode: FrameworkMode): FrameworkKnowledge {
        return access.knowledge ??= new FrameworkKnowledge(access.connection.files, access.connection.transactions, () => {
            this.running.get(mode)?.runtime.invalidateSkills(); this.changed();
        });
    }
    async knowledgeList(input: Parameters<FrameworkClientApi['knowledgeList']>[0]) {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        return this.knowledge(access, input.mode).list();
    }
    async knowledgeRead(input: Parameters<FrameworkClientApi['knowledgeRead']>[0]) {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        return this.knowledge(access, input.mode).read(input.path);
    }
    knowledgeEdit(input: Parameters<FrameworkClientApi['knowledgeEdit']>[0]) {
        const operation = this.configuration.then(async () => {
            this.assertOpen();
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            const { mode, storageScope, commandId, ...edit } = input;
            return this.knowledge(access, mode).edit(commandId, edit);
        });
        this.configuration = operation.catch(() => {}); return operation;
    }
    knowledgeStatus(input: Parameters<FrameworkClientApi['knowledgeStatus']>[0]) {
        const operation = this.configuration.then(async () => {
            this.assertOpen();
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            const { mode, storageScope, commandId, ...status } = input;
            return this.knowledge(access, mode).setStatus(commandId, status);
        });
        this.configuration = operation.catch(() => {}); return operation;
    }
    private controls(access: Access, active?: Running): ExecutionControls {
        if (active) return active.runtime.controls;
        return access.controls ??= new ExecutionControls(this.storage, access.connection.scope);
    }
    taskControl(input: { mode: FrameworkMode; storageScope?: string; commandId: string; taskId: string; intent: 'running' | 'paused' | 'cancelled' }): Promise<FrameworkClientView> {
        const operation = this.configuration.then(async () => {
            this.assertOpen();
            const access = await this.access(input.mode), active = this.running.get(input.mode);
            this.checkScope(access, input.storageScope);
            const task = await withSnapshot(access.connection.files, async snapshot => {
                if (input.mode === 'local') {
                    const cleanup = await readJson<ManualTaskCleanupRecord>(access.connection.files, snapshot, cleanupRecordPath(input.taskId));
                    if (cleanup?.version === 1 && cleanup.taskId === input.taskId && cleanup.phase === 'released' && cleanup.historyCleared === true) throw new Error('This Task history was explicitly cleared. Create a new Task.');
                }
                return readJson<TaskMetadata>(access.connection.files, snapshot, paths.task(input.taskId));
            });
            if (!task || task.status === 'complete') throw new Error('A completed or absent Task cannot be reopened or controlled.');
            const member = active?.connection.registration.member ?? (await this.observe(access, input.mode)).find(row => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
            if (!member || !(task.members ?? [task.owner]).includes(member)) throw new Error('This Host has no registered execution domain in the selected Task.');
            const controls = this.controls(access, active);
            await controls.setTask(input.commandId, input.taskId, z.enum(['running', 'paused', 'cancelled']).parse(input.intent));
            if (active) {
                await active.runtime.applyUserControls(true, { taskId: input.taskId });
                const current = await controls.task(input.taskId);
                if (current?.commandId === input.commandId && current.intent === 'running') await active.runtime.resumeTask(input.taskId, input.commandId);
            }
            this.changed(); return this.view({ mode: input.mode });
        });
        this.configuration = operation.catch(() => {}); return operation;
    }
    async stopExecution(input: { mode: FrameworkMode; storageScope?: string; commandId: string; workId: string; executionId: string }): Promise<FrameworkClientView> {
        const access = await this.access(input.mode);
        this.checkScope(access, input.storageScope);
        const active = this.running.get(input.mode);
        if (!active) throw new Error('This Host does not own a running backend for the selected execution.');
        await active.runtime.requestExecutionStop(input.commandId, input.workId, input.executionId);
        return this.view({ mode: input.mode });
    }
    private observe(access: Access, mode: FrameworkMode): Promise<ObservedInstance[]> {
        const c = access.connection;
        access.observer ??= new InstanceRegistration(c.files, c.transactions, this.storage, { repositoryId: c.identity.repositoryId, repositoryOwner: c.identity.owner, login: c.identity.login, instanceUUID: c.identity.instanceUUID, workerSeats: 0 });
        return access.observer.observe().then(rows => mode === 'local' ? rows.map(row => ({ ...row, primary: row.instanceUUID === c.identity.instanceUUID })) : rows);
    }
    private checkScope(access: Access, expected?: string): void {
        if (expected !== undefined && expected !== access.connection.scope) throw new Error('Storage destination changed; retained input belongs to its original scope.');
    }
    async history(input: Parameters<FrameworkClientApi['history']>[0]) { const active = await this.access(input.mode); this.checkScope(active, input.storageScope); if (input.collaborationId !== this.config(input.mode).settings.collaborationId)
        throw new Error('Conversation selection changed.'); return active.conversation.page(input.limit, input.beforeId, { afterId: input.afterId, date: input.date }); }
    send(input: FrameworkSendInput) {
        const operation = this.configuration.then(async () => { await this.starting; this.assertOpen(); return this.sendStored(input); });
        this.configuration = operation.catch(() => {});
        return operation;
    }
    private async sendStored(input: FrameworkSendInput) {
        const mode = z.enum(['local', 'git']).parse(input.mode), active = await this.access(mode);
        if (input.collaborationId !== this.config(mode).settings.collaborationId)
            throw new Error('Conversation selection changed; retained input belongs to its original conversation.');
        const body = z.object({ id: z.string().min(1), createdAt: z.string().datetime({ offset: true }), timezoneOffsetMinutes: z.number().int().optional(), text: z.string(), recipient: z.enum(['ai', 'human']), replyTo: z.string().optional(), device: z.string() }).parse(input);
        this.checkScope(active, input.storageScope);
        const participantId = active.connection.repository ? String(active.connection.repository.identity.id) : active.connection.identity.login;
        const destination = { scope: active.connection.scope, collaborationId: input.collaborationId, participantId, body };
        const key = 'framework-message-destinations/' + createHash('sha256').update(JSON.stringify([mode, body.id])).digest('hex');
        const signature = createHash('sha256').update(JSON.stringify(destination)).digest('hex'), previous = await this.storage.get<string>(key);
        if (previous !== undefined && previous !== signature) throw new Error('Original message storage destination or content changed.');
        if (previous === undefined) await this.storage.set(key, signature);
        await active.connection.prepareWrite();
        const receipt = await active.conversation.send('client-message:' + body.id, { ...body, role: 'user', participantId,
            username: active.connection.repository?.identity.login || (this.config(mode).settings.userName || active.connection.identity.login) }, { reevaluate: true });
        this.changed();
        return receipt;
    }
    configure(input: Parameters<FrameworkClientApi['configure']>[0]): Promise<FrameworkClientView> {
        let mode: FrameworkMode, settings: FrameworkClientSettings;
        try { this.assertOpen(); if (this.recordMoving) throw this.recordMoving; mode = z.enum(['local', 'git']).parse(input.mode); settings = settingsSchema.parse(input.settings); }
        catch (error) { return Promise.reject(error); }
        const owner: ConfigurationOwner = { mode, commandId: input.commandId, controller: new AbortController() };
        const predecessors = [...this.configurationOwners].filter(value => value.mode === mode && value.commandId !== input.commandId);
        this.configurationOwners.add(owner);
        const signal = owner.controller.signal;
        const key = 'framework-settings-commands/' + createHash('sha256').update(input.commandId).digest('hex');
        // Validate a superseding request before cancelling an older owner. The
        // serial body remains authoritative for settings persistence/readback.
        const admitted = (async () => {
            const receipt = await this.storage.get<{ signature: string; confirmed?: boolean }>(key);
            signal.throwIfAborted();
            if (receipt && receipt.signature !== JSON.stringify([mode, settings])) throw new Error('Configuration command identity changed.');
            if (!receipt && input.expectedRevision && input.expectedRevision !== this.config(mode).revision) throw new Error('Settings changed; reload before applying this edit.');
            if (!receipt?.confirmed) for (const prior of predecessors) prior.controller.abort();
        })();
        void admitted.catch(() => {});
        const operation = this.configuration.then(async () => {
            await admitted;
            let finishAccessTransition: (() => void) | undefined;
            try {
            this.assertOpen(); signal.throwIfAborted();
            if (this.recordMoving) throw this.recordMoving;
            const signature = JSON.stringify([mode, settings]), old = await this.storage.get<{
                signature: string;
                revision: string;
                confirmed?: boolean;
            }>(key);
            if (old && old.signature !== signature)
                throw new Error('Configuration command identity changed.');
            if (old?.confirmed) return this.view({ mode });
            const previous = this.config(mode);
            if (!old && input.expectedRevision && input.expectedRevision !== previous.revision)
                throw new Error('Settings changed; reload before applying this edit.');
            signal.throwIfAborted();
            // Startup may own an opening outside the settings queue. A new
            // configuration must not adopt a connection captured for its old scope.
            const pendingStartup = this.opening.get(mode);
            if (pendingStartup && !this.running.has(mode)) {
                this.backgroundOpening.get(mode)?.abort();
                await pendingStartup.catch(() => undefined);
                signal.throwIfAborted();
            }
            const running = this.running.get(mode);
            const executionSettings = (value: FrameworkClientSettings) => JSON.stringify([
                mode === 'local' ? [value.localDirectory] : [value.ownerRepo, value.repositoryDirectory],
                value.collaborationId, value.workspace, value.presetId, value.foreground, value.background]);
            const hot = !!running && executionSettings(previous.settings) === executionSettings(settings);
            if (running && !hot) {
                await this.stopRunning(running);
                this.running.delete(mode);
            }
            if (!hot) {
                let releaseTransition!: () => void;
                const transition = new Promise<void>(resolve => { releaseTransition = resolve; });
                this.accessTransitions.set(mode, transition);
                finishAccessTransition = () => {
                    if (this.accessTransitions.get(mode) === transition) this.accessTransitions.delete(mode);
                    releaseTransition();
                };
                const access = this.accesses.get(mode); this.accesses.delete(mode); this.archiveViews.delete(mode);
                this.accessOpening.get(mode)?.abort();
                if (access) {
                    const previousAccess = await access.catch(() => undefined);
                    if (previousAccess) { previousAccess.connection.cancelPending(); await previousAccess.connection.close(); }
                }
            }
            signal.throwIfAborted();
            const next = { revision: old?.revision ?? randomUUID(), settings };
            await this.storage.set(key, { signature, revision: next.revision });
            await this.storage.set('framework-settings/' + mode, next);
            this.saved.set(mode, next);
            finishAccessTransition?.(); finishAccessTransition = undefined;
            signal.throwIfAborted();
            await this.storage.set('framework-participation/' + mode, true);
            signal.throwIfAborted();
            const cancelUpdate = () => running?.connection.cancelPending(signal.reason);
            if (hot) signal.addEventListener('abort', cancelUpdate, { once: true });
            try {
                if (hot && running) {
                    const registration = await running.connection.updateWorkerSeats(settings.workerSeats);
                    signal.throwIfAborted();
                    running.runtime.updateWorkerSeats(registration.workerSeats);
                    running.resources = await running.connection.members();
                } else await this.connect(mode, signal);
                this.assertOpen(); signal.throwIfAborted();
                if (mode === 'git')
                    await this.storage.set('framework-git-enabled', true);
                await this.storage.set(key, { signature, revision: next.revision, confirmed: true });
                this.clearResolvedErrors(mode, input.commandId);
                const priorError = this.configurationErrors.get(mode);
                const messages = this.reportedErrors.get(mode);
                if (priorError && !messages?.get(priorError)?.operationId) { messages?.delete(priorError); this.configurationErrors.delete(mode); this.refreshErrors(mode); }
            }
            catch (error) {
                if (!abortedBy(signal, error)) {
                    this.configurationErrors.set(mode, this.report(mode, error, this.diagnosticScope(mode, settings), input.commandId));
                }
                throw error;
            }
            finally { signal.removeEventListener('abort', cancelUpdate); }
            this.changed();
            return this.view({ mode });
            } finally { finishAccessTransition?.(); }
        });
        void operation.finally(() => this.configurationOwners.delete(owner)).catch(() => {});
        this.configuration = operation.catch(() => { });
        return operation;
    }
    async gitMembers(input: { mode: 'git'; storageScope?: string }) {
        const access = await this.access(z.literal('git').parse(input.mode));
        this.checkScope(access, input.storageScope);
        if (!access.connection.gitMembers) throw new Error('GitHub member operations are unavailable.');
        return access.connection.gitMembers();
    }
    async gitMemberAction(input: { mode: 'git'; storageScope?: string } & ({ action: 'cancelInvitation'; invitationId: number } | { action: 'remove'; username: string })) {
        const access = await this.access(z.literal('git').parse(input.mode));
        this.checkScope(access, input.storageScope);
        if (!access.connection.gitMemberAction) throw new Error('GitHub member operations are unavailable.');
        const action = z.discriminatedUnion('action', [z.object({ action: z.literal('cancelInvitation'), invitationId: z.number().int().positive() }), z.object({ action: z.literal('remove'), username: z.string().min(1) })]).parse(input);
        await access.connection.gitMemberAction(action);
    }
    async invite(input: { mode: 'git'; storageScope?: string; username: string }) {
        if (input.mode !== 'git') throw new Error('GitHub invitations belong to Git mode.');
        const access = await this.access(input.mode);
        this.checkScope(access, input.storageScope);
        if (!access.connection.invite) throw new Error('GitHub member operations are unavailable.');
        return access.connection.invite(input.username);
    }
    legacyControl(input: Parameters<FrameworkClientApi['legacyControl']>[0]): Promise<FrameworkClientView> {
        const operation = this.configuration.then(async () => {
            this.assertOpen();
            const access = await this.access(input.mode);
            this.checkScope(access, input.storageScope);
            const index = await withSnapshot(access.connection.files, snapshot => readJson<{ migrations: Array<{ id: string; manifestPath: string }> }>(access.connection.files, snapshot, 'technical/legacy-migrations/index.json'));
            const migration = index?.migrations.find(row => row.id === input.migrationId);
            if (!migration) throw new Error('Original migration record does not exist in this storage scope.');
            const member = this.running.get(input.mode)?.connection.registration.member ?? (await this.observe(access, input.mode)).find(row => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
            if (!member) throw new Error('Original instance identity cannot be located for this legacy task.');
            const target = { manifestPath: migration.manifestPath, oldTaskId: input.oldTaskId, member };
            await access.connection.prepareWrite();
            if (input.action === 'resume') await resumeLegacyTask(access.connection.files, access.connection.transactions, input.commandId, target);
            else if (input.action === 'answer') await answerLegacyTask(access.connection.files, access.connection.transactions, input.commandId, { ...target, waitId: z.string().min(1).parse(input.waitId), answer: z.string().parse(input.answer) });
            else throw new Error('Unknown legacy control action.');
            this.changed();
            return this.view({ mode: input.mode });
        });
        this.configuration = operation.catch(() => {});
        return operation;
    }
    participation(input: { mode: FrameworkMode; enabled: boolean }): Promise<FrameworkClientView> {
        let mode: FrameworkMode, enabled: boolean;
        try { mode = z.enum(['local','git']).parse(input.mode); enabled = z.boolean().parse(input.enabled); }
        catch (error) { return Promise.reject(error); }
        // Withdrawal must reach an admitted registration before waiting behind
        // its configuration operation. Frontend access has a separate owner.
        if (!enabled) {
            for (const owner of this.configurationOwners) if (owner.mode === mode) owner.controller.abort();
            this.backgroundOpening.get(mode)?.abort();
        }
        const owner: ConfigurationOwner | undefined = enabled ? { mode, controller: new AbortController() } : undefined;
        if (owner) this.configurationOwners.add(owner);
        const operation = this.configuration.then(async () => {
            this.assertOpen(); owner?.controller.signal.throwIfAborted();
            await this.storage.set('framework-participation/' + mode, enabled);
            owner?.controller.signal.throwIfAborted();
            if(enabled) await this.connect(mode, owner!.controller.signal);
            else { const running = this.running.get(mode); if(running) { try { await this.stopRunning(running); } finally { this.running.delete(mode); } } }
            this.changed(); return this.view({mode});
        });
        void operation.finally(() => { if (owner) this.configurationOwners.delete(owner); }).catch(() => {});
        this.configuration = operation.catch(() => {}); return operation;
    }
    async selectMode(input: {
        mode: FrameworkMode;
    }): Promise<FrameworkClientView> { this.assertOpen(); this.activeMode = z.enum(['local', 'git']).parse(input.mode); await this.storage.set('framework-active-mode', this.activeMode); this.changed(); return this.view({ mode: this.activeMode }); }
    async readFile(input: {
        mode: FrameworkMode;
        path: string;
        storageScope?: string;
    }) {
        const active = await this.access(input.mode);
        this.checkScope(active, input.storageScope);
        const downloadUrl = '/api/deepseek-servant-framework/download?mode=' + input.mode + '&path=' + encodeURIComponent(input.path) + '&storageScope=' + encodeURIComponent(active.connection.scope);
        return withSnapshot(active.connection.files, async (snapshot) => {
            const bytes = await active.connection.files.readBytes(snapshot, input.path);
            if (bytes === undefined)
                throw new Error('File does not exist.');
            try {
                return { path: input.path, downloadUrl, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), revision: snapshot.revision };
            }
            catch {
                return { path: input.path, revision: snapshot.revision, binary: { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), downloadUrl: '/api/deepseek-servant-framework/download?mode=' + input.mode + '&path=' + encodeURIComponent(input.path) + '&storageScope=' + encodeURIComponent(active.connection.scope) } };
            }
        });
    }
    async download(mode: FrameworkMode, path: string, storageScope?: string): Promise<Uint8Array> { const active = await this.access(mode); this.checkScope(active, storageScope); return withSnapshot(active.connection.files, async (snapshot) => { const bytes = await active.connection.files.readBytes(snapshot, path); if (bytes === undefined)
        throw new Error('File does not exist.'); return bytes; }); }
    private stopRunning(active: Running): Promise<void> {
        const prior = this.stopping.get(active);
        if (prior) return prior;
        const operation = (async () => {
            const failures: unknown[] = [];
            try { await active.runtime.dispose(); } catch (error) { failures.push(error); }
            try { await active.connection.close(); } catch (error) { failures.push(error); }
            if (failures.length === 1) throw failures[0];
            if (failures.length) throw new AggregateError(failures, 'Runtime and connection disposal failed.');
        })();
        this.stopping.set(active, operation);
        return operation;
    }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        this.closed = true;
        this.recordMoveController?.abort();
        for (const owner of this.configurationOwners) owner.controller.abort();
        for (const controller of [...this.accessOpening.values(), ...this.backgroundOpening.values()]) controller.abort();
        // Pending acquisitions remain owned until they settle. Their publication
        // guards close late resources instead of allowing a post-dispose Host.
        const accesses = [...this.accesses.values()];
        this.disposal = (async () => {
            // Start each owned shutdown before waiting for configuration: a hot
            // update may itself be waiting on this connection's HTTP request.
            const stopping = [...this.running].map(([mode, active]) => this.stopRunning(active).catch(error => this.cleanupFailure(mode, error)));
            const cancellingAccess = accesses.map(pending => pending.then(access => {
                try { access.connection.cancelPending(); } catch (error) { this.disposalErrors.push(error); }
            }, () => {}));
            await Promise.allSettled([this.starting, this.configuration]);
            await Promise.allSettled([...this.opening.values()]);
            await Promise.all(stopping);
            await Promise.all(cancellingAccess);
            for (const [mode, active] of this.running) {
                if (!this.stopping.has(active)) try { await this.stopRunning(active); } catch (error) { this.cleanupFailure(mode, error); }
            }
            this.running.clear();
            for (const runtime of this.relocationOwners.values()) try { await runtime.dispose(); } catch (error) { this.disposalErrors.push(error); }
            this.relocationOwners.clear();
            for (const pending of accesses) {
                const access = await pending.catch(() => undefined);
                if (access) try { await access.connection.close(); } catch (error) { this.disposalErrors.push(error); }
            }
            this.accesses.clear();
            this.listeners.clear();
            if (this.disposalErrors.length) throw new AggregateError(this.disposalErrors, 'Framework service resource disposal failed.');
        })();
        return this.disposal;
    }
}
