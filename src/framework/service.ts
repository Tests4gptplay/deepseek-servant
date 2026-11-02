import { disposeResources } from './dispose-resources.js'
import { omitAbsentFields } from '../adapters/dsh/json-record.js'
import { resumePendingLegacyArtifacts, listLegacyArtifactReferences, type LegacyArtifactReference } from './legacy-artifacts.js'
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
import { resumeLegacyTask, answerLegacyTask, captureLocalLegacy, readLegacyLocalProfile, readLegacyCoopSettings, type LegacyTask, type MigrationManifest } from './legacy-migration.js';
import { ExecutionControls } from './execution-control.js';
import { migrateFrameworkStorage } from './migration-lifecycle.js';
import { FrameworkConversation } from './conversation.js';
import { FrameworkRoleRuntime } from './role-runtime.js';
import { createRecorderCapacity } from './capacity.js';
import { paths, readJson, readMemberStatus, type TaskMetadata, type MemberStatus } from './task-files.js';
import { withSnapshot, FilesOutcomeUnknownError, type FilesStore, type FilesSnapshot } from './transactions.js';
import { readArchivedReference } from './recorder-retention.js';
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
interface Access { artifactRepair?: { controller: AbortController; done: Promise<void> }; legacyArtifacts?: Map<string, LegacyArtifactReference[]>; legacyExports?: Map<string, LegacyRecordExportIdentity[]>; knowledge?: FrameworkKnowledge; taskIndex?: FrameworkTaskIndex; connection: FrameworkStorage; conversation: FrameworkConversation; observer?: InstanceRegistration; controls?: ExecutionControls }
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
    private readonly writePreparations = new Set<Promise<void>>();
    private gitPreparation?: { revision: string; promise: Promise<void> };
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
    // Only physical record relocation owns both mode lanes.
    private configuration: Promise<unknown> = Promise.resolve();
    private readonly modeConfiguration = new Map<FrameworkMode, Promise<unknown>>();
    private readonly settingsCommands = new Map<string, Promise<unknown>>();
    private serialMode<T>(mode: FrameworkMode, action: () => Promise<T>, commandId?: string): Promise<T> {
        try { mode = z.enum(['local', 'git']).parse(mode); } catch (error) { return Promise.reject(error); }
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        const predecessors = [this.configuration, this.modeConfiguration.get(mode), commandId === undefined ? undefined : this.settingsCommands.get(commandId)];
        const operation = Promise.all(predecessors).then(() => { this.assertOpen(); return action(); });
        const settled = operation.then(() => undefined, () => undefined);
        this.modeConfiguration.set(mode, settled);
        if (commandId !== undefined) {
            this.settingsCommands.set(commandId, settled);
            void settled.then(() => { if (this.settingsCommands.get(commandId) === settled) this.settingsCommands.delete(commandId); });
        }
        return operation;
    }
    private serialRecords<T>(action: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        const operation = Promise.all([this.configuration, ...this.modeConfiguration.values()]).then(() => { this.assertOpen(); return action(); });
        this.configuration = operation.then(() => undefined, () => undefined);
        return operation;
    }
    private closed = false;
    private recordMoving?: Error;
    private recordMoveController?: AbortController;
    private recordMover?: FrameworkRecordMove;
    private pendingRecordMove?: RecordMoveReceipt;
    private readonly relocationOwners = new Map<FrameworkMode, FrameworkRoleRuntime>();
    private disposal?: Promise<void>;
    private initializing?: Promise<void>;
    private starting?: Promise<void>;
    private readonly modeStarting = new Map<FrameworkMode, Promise<void>>();
    private readonly startupState = new Map<FrameworkMode, { status: 'starting' | 'failed'; owner: object }>();
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
    /** Host registration waits for settings, not remote migration or model admission. */
    initialize(): Promise<void> {
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        return this.initializing ??= this.initializeOwned();
    }
    /** Explicit lifecycle callers may still await every owned startup responsibility. */
    async start(): Promise<void> { await this.initialize(); await this.starting; this.assertOpen(); }
    private async initializeOwned(): Promise<void> {
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
                    const profile = await readLegacyLocalProfile(this.storage);
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
            await this.persistSettings(mode, saved);
        }
        this.assertOpen();
        // Register every owner before running any asynchronous startup step, so a
        // queued withdrawal/configuration can invalidate work not yet opened.
        const owners = (['local', 'git'] as const).map(mode => {
            const owner: ConfigurationOwner = { mode, controller: new AbortController() };
            this.configurationOwners.add(owner); this.startupState.set(mode, { status: 'starting', owner }); return owner;
        });
        const preparation = Promise.resolve().then(() => this.resumeStartupMove());
        for (const owner of owners) {
            const operation = Promise.resolve().then(async () => {
                try {
                    await preparation; this.assertOpen(); owner.controller.signal.throwIfAborted();
                    const mode = owner.mode;
                    const enabled = await this.storage.get<boolean>('framework-participation/' + mode) ?? mode === 'local';
                    this.assertOpen(); owner.controller.signal.throwIfAborted();
                    if (enabled && (mode !== 'git' || this.config(mode).settings.ownerRepo.trim())) {
                        await this.connect(mode, owner.controller.signal);
                    } else if (mode === 'local') {
                        const access = await this.access(mode);
                        await this.withManualCleanup(access, cleanup => cleanup.resumePending((error, commandId) => { this.report(mode, error, access.connection.scope, commandId); }));
                    }
                    if (this.startupState.get(mode)?.owner === owner) this.startupState.delete(mode);
                } catch (error) {
                    if (this.closed || abortedBy(owner.controller.signal, error)) {
                        if (this.startupState.get(owner.mode)?.owner === owner) this.startupState.delete(owner.mode);
                    } else {
                        if (this.startupState.get(owner.mode)?.owner === owner) this.startupState.set(owner.mode, { status: 'failed', owner });
                        this.report(owner.mode, error, this.diagnosticScope(owner.mode));
                    }
                } finally {
                    this.configurationOwners.delete(owner); this.changed();
                }
            });
            this.modeStarting.set(owner.mode, operation);
        }
        this.starting = Promise.all([...this.modeStarting.values()]).then(() => undefined);
        if (this.activeMode === 'git' || await this.storage.get<boolean>('framework-git-enabled')) this.prepareGit();
    }
    /** Read-only preparation starts independently of Host ready and participation. */
    private prepareGit(): void {
        const saved = this.saved.get('git');
        if (this.closed || !saved?.settings.ownerRepo.trim() || this.gitPreparation?.revision === saved.revision) return;
        const access = this.access('git'), acquisition = this.accessOpening.get('git');
        const current = () => !this.closed && this.saved.get('git') === saved && this.accesses.get('git') === access;
        const operation = access.then(async value => {
            if (current()) await value.connection.prepareWrite({ initialize: false });
        }).catch(error => {
            // A failed acquisition removes itself from accesses. Its real error
            // still belongs here; cancellation or a replacement does not.
            if (!this.closed && this.saved.get('git') === saved && !acquisition?.signal.aborted
                && (!this.accesses.has('git') || this.accesses.get('git') === access))
                this.report('git', error, this.diagnosticScope('git', saved.settings));
        }).finally(() => {
            this.writePreparations.delete(operation);
            if (this.gitPreparation?.promise === operation) this.gitPreparation = undefined;
        });
        this.gitPreparation = { revision: saved.revision, promise: operation };
        this.writePreparations.add(operation);
    }
    private async resumeStartupMove(): Promise<void> {
        this.assertOpen();
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
                this.report('local', error); throw error;
            }
            finally { if (this.recordMoveController === controller) this.recordMoveController = undefined; }
        }
    }
    private async modeReady(mode: FrameworkMode): Promise<void> {
        await this.initializing;
        this.assertOpen();
        if (this.recordMoving) throw this.recordMoving;
        // A replacement connection has already completed its own acquisition,
        // migration and runtime admission. An invalidated bootstrap remains
        // owned for disposal, but cannot gate this newer published connection.
        if (this.running.has(mode)) return;
        if (this.startupState.get(mode)?.status === 'failed') throw new Error(this.errors.get(mode) ?? 'Collaboration startup failed. Retry connection to resume the retained work.');
        if (mode === 'git' && this.startupState.get(mode)?.status === 'starting') throw new Error('Git collaboration is still initializing; this operation has not been applied. Retry after initialization completes.');
        const opening = this.opening.get(mode);
        if (opening) await opening; else await this.modeStarting.get(mode);
        this.assertOpen();
        if (this.recordMoving) throw this.recordMoving;
        if (!this.running.has(mode) && this.startupState.get(mode)?.status === 'failed') throw new Error(this.errors.get(mode) ?? 'Collaboration startup failed. Retry connection to resume the retained work.');
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
            const assertCurrent = () => {
                this.assertOpen();
                controller.signal.throwIfAborted();
                if (this.accessOpening.get(mode) !== controller) throw new Error('Storage access was replaced before acquisition completed.');
            };
            try {
                assertCurrent();
                const access: Access = { connection, conversation: new FrameworkConversation(connection.files, connection.transactions, { mode, collaborationId: settings.collaborationId }) };
                // A verified store is already readable. Optional original file
                // capture belongs to this access lifetime, not its acquisition.
                if (mode === 'local') {
                    const repairController = new AbortController();
                    const done = this.resumeLocalArtifacts(connection, repairController.signal)
                        .then(references => { if (!repairController.signal.aborted && !this.closed) { access.legacyArtifacts = references; this.changed(); } })
                        .catch(error => { if (!abortedBy(repairController.signal, error)) this.report(mode, error, connection.scope); });
                    access.artifactRepair = { controller: repairController, done };
                }
                return access;
            } catch (error) {
                await connection.close().catch(failure => this.cleanupFailure(mode, failure));
                throw error;
            }
          });
        this.accesses.set(mode,pending);
        void pending.finally(() => { if (this.accessOpening.get(mode) === controller) this.accessOpening.delete(mode); }).catch(() => {});
        void pending.catch(() => { if(this.accesses.get(mode) === pending) this.accesses.delete(mode); });
        return pending;
    }
    private async closeAccess(access: Access): Promise<void> {
        access.artifactRepair?.controller.abort();
        await disposeResources([
            () => access.connection.cancelPending(),
            async () => { await access.artifactRepair?.done; },
            () => access.connection.close(),
        ]);
    }
    private async resumeLocalArtifacts(connection: FrameworkStorage, signal: AbortSignal): Promise<Map<string, LegacyArtifactReference[]>> {
        const references = new Map<string, LegacyArtifactReference[]>();
        const index = await withSnapshot(connection.files, snapshot => readJson<{ migrations: Array<{ id: string; manifestPath: string }> }>(connection.files, snapshot, 'technical/legacy-migrations/index.json'));
        for (const migration of index?.migrations ?? []) {
            signal.throwIfAborted();
            try { await resumePendingLegacyArtifacts(this.ctx, connection.files, connection.transactions, migration.manifestPath, { signal,
                onIssue: issue => this.report('local', issue.error ?? new Error(issue.detail), connection.scope) }); }
            catch (error) { if (abortedBy(signal, error)) throw error; this.report('local', error, connection.scope); }
            signal.throwIfAborted();
            try { references.set(migration.id, await withSnapshot(connection.files, snapshot => listLegacyArtifactReferences(connection.files, snapshot, migration.manifestPath))); }
            catch (error) { if (abortedBy(signal, error)) throw error; this.report('local', error, connection.scope); }
        }
        return references;
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
        this.startupState.set(mode, { status: 'starting', owner: controller });
        const operation = this.open(mode, controller.signal).then(value => {
            if (this.startupState.get(mode)?.owner === controller) this.startupState.delete(mode);
            this.changed(); return value;
        }, error => {
            if (this.startupState.get(mode)?.owner === controller) {
                if (controller.signal.aborted || this.closed) this.startupState.delete(mode);
                else this.startupState.set(mode, { status: 'failed', owner: controller });
            }
            this.changed(); throw error;
        });
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
            runtime.setForegroundModel(this.config(mode).settings.foreground);
            await runtime.start();
            this.assertOpen(); signal?.throwIfAborted();
            runtime.setForegroundModel(this.config(mode).settings.foreground);
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
    private settingsView(mode: FrameworkMode): FrameworkClientView {
        const saved = this.config(mode), active = this.running.get(mode);
        return { revision: saved.revision, activeMode: mode, collaborationId: saved.settings.collaborationId, settings: saved.settings,
            connection: { participating: !!active, status: active ? 'connected' : 'disconnected', detail: this.errors.get(mode), member: active?.connection.registration.member, workerSeats: active?.connection.registration.workerSeats }, messages: [], tasks: [], legacyTasks: [], archives: this.archiveViews.get(mode) ?? [], resources: [] };
    }
    async view(input: {
        mode?: FrameworkMode;
        includeArchives?: boolean;
        headerOnly?: boolean;
    } = {}, signal?: AbortSignal): Promise<FrameworkClientView> {
        signal?.throwIfAborted();
        const report = (error: unknown) => {
            if (signal?.aborted && error === signal.reason) throw error;
            this.report(mode, error);
        };
        const mode = input.mode ?? this.activeMode, saved = this.config(mode), active = this.running.get(mode);
        const base = this.settingsView(mode);
        if (mode === 'local' && this.pendingRecordMove?.scope) base.pendingRecordMove = { commandId: this.pendingRecordMove.commandId,
            storageScope: this.pendingRecordMove.scope, expectedRevision: this.pendingRecordMove.settingsBefore.revision, directory: this.pendingRecordMove.targetRecords };
        if (mode === 'git' && !saved.settings.ownerRepo.trim()) { base.connection.status = 'unconfigured'; return base; }
        const startup = this.startupState.get(mode);
        if (input.headerOnly) {
            if (startup && !active) base.connection.status = startup.status;
            // Only a published owner supplies a known scope here. Do not open
            // storage or await a pending access just to describe the real UI mode.
            if (active) base.storageScope = active.connection.scope;
            return base;
        }
        if (startup && !active && (mode === 'git' || !this.accesses.has(mode) || this.accessOpening.has(mode))) {
            base.connection.status = startup.status; return base;
        }
        let access: Access;
        try { access = await this.access(mode); base.connection.status = 'connected'; } catch(error) { if (this.closed) throw error; base.connection.detail = error instanceof Error ? error.message : String(error); return base; }
        // Access may have waited for an actual settings/scope handoff. Never
        // pair an earlier header with the newly acquired destination.
        signal?.throwIfAborted();
        if (this.config(mode).revision !== saved.revision) return this.view(input, signal);
        base.storageScope = access.connection.scope;
        if (input.includeArchives) base.archives = [];
        // One view reads one authorized revision. Nested readers borrow this
        // snapshot; independent refreshes still acquire their own remote HEAD.
        await withSnapshot(access.connection.files, async (snapshot) => {
            signal?.throwIfAborted();
            const page = await access.conversation.page(20, undefined, {}, snapshot, signal);
            signal?.throwIfAborted();
            base.messages = page.messages;
            base.pageBefore = page.moreBefore;
            let observed = active?.resources ?? [];
            try { observed = active?.resources ?? await this.observe(access, mode, snapshot, signal); } catch (error) { report(error); }
            signal?.throwIfAborted();
            const localMember = active?.connection.registration.member ?? observed.find(row => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
            base.hasOtherInstanceRecords = mode === 'git' && observed.some(row => row.instanceUUID !== access.connection.identity.instanceUUID);
            base.resources = observed.filter(row => !row.primary).map(row => ({ name: row.member, status: row.availability, instanceUUID: row.instanceUUID, workerSeats: row.workerSeats, detail: row.error }));
            try {
            signal?.throwIfAborted();
            try {
            access.taskIndex ??= new FrameworkTaskIndex(access.connection.files, error => this.report(mode, error));
            const tasks = await access.taskIndex.list(snapshot, undefined, signal);
            signal?.throwIfAborted();
            const controls = tasks.length ? await this.controls(access, active).taskStates(tasks.map(task => task.taskId)) : undefined;
            signal?.throwIfAborted();
            await access.connection.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: tasks.filter(task => task.status !== 'complete')
                .flatMap(task => (task.members ?? [task.owner]).map(name => paths.memberStatus(task.taskId, name))) });
            signal?.throwIfAborted();
            for (const task of tasks) {
                signal?.throwIfAborted();
                const cleanup = (task.status === 'complete' || mode === 'local') ? await readJson<ManualTaskCleanupRecord>(access.connection.files, snapshot, cleanupRecordPath(task.taskId)) : undefined;
                signal?.throwIfAborted();
                if (cleanup?.version === 1 && cleanup.taskId === task.taskId && cleanup.phase === 'released' && cleanup.historyCleared === true) {
                    if (input.includeArchives && cleanup.preservedArtifacts.length) base.archives.push({ path: cleanup.preservedArtifacts[0]!, title: task.sourcePath, taskId: task.taskId, files: cleanup.preservedArtifacts });
                    continue;
                }
                const members = await Promise.all((task.members ?? [task.owner]).map(async name => {
                    try { return { name, status: (await readMemberStatus(access.connection.files, snapshot, paths.memberStatus(task.taskId, name)))?.state ?? 'unknown' }; }
                    catch (error) { report(error); return { name, status: 'unknown' }; }
                }));
                signal?.throwIfAborted();
                base.tasks.push({ taskId: task.taskId, title: task.sourcePath.split('/').at(-1)!, route: task.route, owner: task.owner, status: task.status,
                    members, control: controls?.get(task.taskId)?.intent, executions: active?.runtime.executionViews(task.taskId) ?? [], resultPaths: task.resultPaths ?? [] });
            }
            } catch (error) { report(error); }
            signal?.throwIfAborted();
            try {
            const migrations = await readJson<{ migrations: Array<{ id: string; manifestPath: string }> }>(access.connection.files, snapshot, 'technical/legacy-migrations/index.json');
            signal?.throwIfAborted();
            await access.connection.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: (migrations?.migrations ?? []).map(migration => migration.manifestPath) });
            signal?.throwIfAborted();
            for (const migration of migrations?.migrations ?? []) {
                signal?.throwIfAborted();
                try {
                const manifest = await readJson<MigrationManifest>(access.connection.files, snapshot, migration.manifestPath);
                signal?.throwIfAborted();
                if (input.includeArchives) {
                    try {
                        const found = await listLegacyRecordExports(access.connection.files, snapshot, migration.manifestPath, error => report(error));
                        signal?.throwIfAborted();
                        (access.legacyExports ??= new Map()).set(migration.id, found);
                    } catch (error) { access.legacyExports?.delete(migration.id); report(error); }
                    if (mode === 'local') try {
                        const references = await listLegacyArtifactReferences(access.connection.files, snapshot, migration.manifestPath);
                        signal?.throwIfAborted();
                        (access.legacyArtifacts ??= new Map()).set(migration.id, references);
                    } catch (error) { access.legacyArtifacts?.delete(migration.id); report(error); }
                }
                const clearedIds = new Set((manifest as (MigrationManifest & { clearedTasks?: Array<{ oldId: string }> }) | undefined)?.clearedTasks?.map(item => item.oldId) ?? []);
                const exports = (access.legacyExports?.get(migration.id) ?? []).filter(item => !clearedIds.has(item.oldTaskId));
                const artifactReferences = (access.legacyArtifacts?.get(migration.id) ?? []).filter(item => !clearedIds.has(item.oldTaskId));
                const artifactsFor = (oldTaskId: string) => artifactReferences.filter(item => item.oldTaskId === oldTaskId).map(item => ({
                    id: item.id, sourcePath: item.sourcePath, sha256: item.sha256, archivedPath: item.status === 'archived' ? item.archivedPath : undefined,
                    status: item.status, detail: item.detail }));
                for (const task of manifest?.tasks ?? []) {
                    if (clearedIds.has(task.oldId)) continue;
                    const own = task.memberContinuations?.find(row => row.member === localMember);
                    const terminal = task.continuation === 'complete' || task.continuation === 'cancelled';
                    base.legacyTasks.push({ migrationId: migration.id, oldTaskId: task.oldId, taskId: task.taskId, continuation: terminal ? task.continuation : own?.continuation ?? task.continuation,
                        recordPath: task.recordPath, recordsAvailable: exports.some(row => row.oldTaskId === task.oldId), artifacts: artifactsFor(task.oldId), issues: manifest?.issues, waits: terminal ? [] : own?.waits?.map(wait => ({ ...wait, memberIdentity: own.identity })) });
                }
                for (const row of exports) if (!manifest?.tasks.some(task => task.oldId === row.oldTaskId))
                    base.legacyTasks.push({ migrationId: migration.id, ...row, recordsAvailable: true, artifacts: artifactsFor(row.oldTaskId) });
                if (input.includeArchives) for (const cleared of (manifest as (MigrationManifest & { clearedTasks?: Array<{ oldId: string; taskId: string; preservedArtifacts?: string[] }> }) | undefined)?.clearedTasks ?? []) {
                    const files = cleared.preservedArtifacts;
                    if (Array.isArray(files) && files.length && files.every(path => typeof path === 'string'))
                        base.archives.push({ path: files[0]!, title: cleared.oldId, taskId: cleared.taskId, files: [...files] });
                }
                } catch (error) { report(error); }
            }
            } catch (error) { report(error); }
            signal?.throwIfAborted();
            if (input.includeArchives) {
                const entries = await access.connection.files.list(snapshot, 'archives/');
                base.archives.push(...entries.filter(entry => /^archives\/[^/]+\/records\.md$/.test(entry.path)).map(entry => {
                    const taskId = entry.path.split('/')[1]!, prefix = `archives/${taskId}/`;
                    return { path: entry.path, title: taskId, taskId,
                        files: entries.filter(file => file.path.startsWith(prefix) && file.path !== entry.path && file.path !== `${prefix}retention.json`).map(file => file.path).sort() };
                }));
            }
            } catch (error) { report(error); }
        }, { signal, isolatePathErrors: true, files: [access.conversation.indexPath, 'technical/legacy-migrations/index.json'],
            directories: ['tasks', ...(!active ? ['instances'] : [])] });
        signal?.throwIfAborted();
        if (active && this.running.get(mode) === active && active.connection.scope === access.connection.scope) {
            try {
                const processing = await active.runtime.foregroundProcessing?.();
                if (this.running.get(mode) === active && this.config(mode).revision === saved.revision) base.foregroundProcessing = processing;
            } catch (error) { report(error); }
        }
        signal?.throwIfAborted();
        base.connection.detail = this.errors.get(mode);
        if (input.includeArchives)
            this.archiveViews.set(mode, base.archives);
        return base;
    }
    private async persistSettings(mode: FrameworkMode, saved: Saved): Promise<Saved> {
        const key = 'framework-settings/' + mode;
        await this.storage.set(key, saved);
        const stored = await this.storage.get<Saved>(key);
        // Native JSON storage omits absent optional fields. Cache the confirmed
        // representation used by durable move receipts and later comparisons.
        if (!stored || !isDeepStrictEqual(omitAbsentFields(stored), omitAbsentFields(saved))) {
            throw new Error('Saved settings could not be confirmed by storage readback.');
        }
        this.saved.set(mode, stored);
        return stored;
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
                    await this.persistSettings('local', receipt.settingsAfter);
                } else this.saved.set('local', current!);
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
            if (access) try { await this.closeAccess(access); } catch (error) { failures.push(error); }
        }
        this.running.clear(); this.accesses.clear(); this.archiveViews.clear();
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Record relocation could not confirm all storage owners stopped.');
        this.relocationOwners.clear();
    }
    moveRecords(input: { mode: 'local'; storageScope: string; expectedRevision: string; commandId: string; directory: string }): Promise<FrameworkClientView> {
        const operation = this.serialRecords(async () => {
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
        return operation;
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
        const operation = this.serialMode(input.mode, async () => {
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
        return operation;
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
        await this.modeReady(input.mode);
        const operation = this.serialMode(input.mode, async () => {
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            return this.withManualCleanup(access, cleanup => cleanup.previewTasks());
        });
        return operation;
    }
    async cleanupRecords(input: Parameters<FrameworkClientApi['cleanupRecords']>[0]) {
        await this.modeReady(input.mode);
        const operation = this.serialMode(input.mode, async () => {
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
            this.archiveViews.delete(input.mode); access.legacyExports = undefined; access.legacyArtifacts = undefined; this.changed(); return result;
        });
        return operation;
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
        const operation = this.serialMode(input.mode, async () => {
            this.assertOpen();
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            const { mode, storageScope, commandId, ...edit } = input;
            return this.knowledge(access, mode).edit(commandId, edit);
        });
        return operation;
    }
    knowledgeStatus(input: Parameters<FrameworkClientApi['knowledgeStatus']>[0]) {
        const operation = this.serialMode(input.mode, async () => {
            this.assertOpen();
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            const { mode, storageScope, commandId, ...status } = input;
            return this.knowledge(access, mode).setStatus(commandId, status);
        });
        return operation;
    }
    private controls(access: Access, active?: Running): ExecutionControls {
        if (active) return active.runtime.controls;
        return access.controls ??= new ExecutionControls(this.storage, access.connection.scope);
    }
    taskControl(input: { mode: FrameworkMode; storageScope?: string; commandId: string; taskId: string; intent: 'running' | 'paused' | 'cancelled' }): Promise<FrameworkClientView> {
        const operation = this.serialMode(input.mode, async () => {
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
        return operation;
    }
    async stopExecution(input: { mode: FrameworkMode; storageScope?: string; commandId: string; workId: string; executionId: string }): Promise<FrameworkClientView> {
        const access = await this.access(input.mode);
        this.checkScope(access, input.storageScope);
        const active = this.running.get(input.mode);
        if (!active) throw new Error('This Host does not own a running backend for the selected execution.');
        await active.runtime.requestExecutionStop(input.commandId, input.workId, input.executionId);
        return this.view({ mode: input.mode });
    }
    private observe(access: Access, mode: FrameworkMode, snapshot?: FilesSnapshot, signal?: AbortSignal): Promise<ObservedInstance[]> {
        const c = access.connection;
        access.observer ??= new InstanceRegistration(c.files, c.transactions, this.storage, { repositoryId: c.identity.repositoryId, repositoryOwner: c.identity.owner, login: c.identity.login, instanceUUID: c.identity.instanceUUID, workerSeats: 0 });
        return access.observer.observe(snapshot, signal).then(rows => mode === 'local' ? rows.map(row => ({ ...row, primary: row.instanceUUID === c.identity.instanceUUID })) : rows);
    }
    private checkScope(access: Access, expected?: string): void {
        if (expected !== undefined && expected !== access.connection.scope) throw new Error('Storage destination changed; retained input belongs to its original scope.');
    }
    async history(input: Parameters<FrameworkClientApi['history']>[0], signal?: AbortSignal) {
        signal?.throwIfAborted();
        const active = await this.access(input.mode);
        signal?.throwIfAborted();
        this.checkScope(active, input.storageScope);
        if (input.collaborationId !== this.config(input.mode).settings.collaborationId) throw new Error('Conversation selection changed.');
        const page = await active.conversation.page(input.limit, input.beforeId, { afterId: input.afterId, date: input.date }, undefined, signal);
        signal?.throwIfAborted();
        return page;
    }
    send(input: FrameworkSendInput) {
        const operation = this.serialMode(input.mode, async () => { await this.modeReady(input.mode); this.assertOpen(); return this.sendStored(input); });
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
        return { ...receipt, storageScope: active.connection.scope };
    }
    async sentMessage(input: FrameworkSendInput, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const mode = z.enum(['local', 'git']).parse(input.mode), access = await this.access(mode);
        this.checkScope(access, input.storageScope);
        if (input.collaborationId !== access.conversation.scope.collaborationId) throw new Error('Conversation selection changed.');
        const hint = z.object({ id: z.string().min(1), createdAt: z.string().datetime({ offset: true }), text: z.string() }).parse(input);
        const participantId = access.connection.repository ? String(access.connection.repository.identity.id) : access.connection.identity.login;
        signal?.throwIfAborted();
        return access.conversation.readback(hint.id, { ...hint, participantId, role: 'user' }, signal);
    }
    foregroundModel(input: Parameters<FrameworkClientApi['foregroundModel']>[0]): Promise<FrameworkClientView> {
        let mode: FrameworkMode, route: FrameworkClientSettings['foreground'];
        try {
            this.assertOpen(); if (this.recordMoving) throw this.recordMoving;
            mode = z.enum(['local', 'git']).parse(input.mode);
            route = model.optional().parse(input.model);
            z.string().min(1).parse(input.commandId); z.string().min(1).parse(input.expectedRevision);
        } catch (error) { return Promise.reject(error); }
        const owner: ConfigurationOwner = { mode, commandId: input.commandId, controller: new AbortController() };
        this.configurationOwners.add(owner);
        const signal = owner.controller.signal;
        const operation = this.serialMode(mode, async () => {
            this.assertOpen(); signal.throwIfAborted(); if (this.recordMoving) throw this.recordMoving;
            if (input.storageScope !== undefined) {
                let scope = this.running.get(mode)?.connection.scope;
                const access = this.accesses.get(mode);
                if (!scope && access && !this.accessOpening.has(mode)) scope = (await access).connection.scope;
                if (scope !== input.storageScope) throw new Error('Storage scope changed or is not ready; refresh before changing the foreground model.');
            }
            signal.throwIfAborted();
            const signature = JSON.stringify(['foreground-model', mode, input.storageScope, input.expectedRevision, route]);
            const key = 'framework-settings-commands/' + createHash('sha256').update(input.commandId).digest('hex');
            type Command = { signature: string; revision: string; previousRevision: string; next: Saved; confirmed?: boolean };
            const prior = await this.storage.get<Command>(key);
            if (prior && prior.signature !== signature) throw new Error('Configuration command identity changed.');
            if (prior?.confirmed) return this.settingsView(mode);
            const cached = this.config(mode);
            const stored = await this.storage.get<Saved>('framework-settings/' + mode) ?? cached;
            const matches = (left: Saved, right: Saved) => isDeepStrictEqual(omitAbsentFields(left), omitAbsentFields(right));
            if (!prior && (input.expectedRevision !== stored.revision || !matches(cached, stored)))
                throw new Error('Settings changed; reload before applying this edit.');
            const next: Saved = prior?.next ?? { revision: randomUUID(), settings: { ...stored.settings, foreground: route } };
            if (prior && !matches(stored, next) && (stored.revision !== prior.previousRevision || !matches(cached, stored)))
                throw new Error('Settings changed while the foreground model update was unconfirmed; reload before applying another edit.');
            signal.throwIfAborted();
            const command: Command = prior ?? { signature, revision: next.revision, previousRevision: stored.revision, next };
            if (!prior) await this.storage.set(key, command);
            signal.throwIfAborted();
            // A retry confirms the original target representation instead of overwriting a later choice.
            if (matches(stored, next)) this.saved.set(mode, stored);
            else await this.persistSettings(mode, next);
            this.assertOpen(); signal.throwIfAborted();
            this.running.get(mode)?.runtime.setForegroundModel(this.config(mode).settings.foreground);
            await this.storage.set(key, { ...command, confirmed: true });
            this.clearResolvedErrors(mode, input.commandId); this.changed();
            return this.settingsView(mode);
        }, input.commandId).catch(error => {
            if (!abortedBy(signal, error)) this.report(mode, error, input.storageScope, input.commandId);
            throw error;
        });
        void operation.finally(() => this.configurationOwners.delete(owner)).catch(() => {});
        return operation;
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
        // Validate a superseding request before cancelling an older owner. A
        // same-ID command in another mode may not have persisted its receipt
        // yet; wait that exact responsibility, never the unrelated mode tail.
        // Capture before serialMode registers this request under the same ID.
        const priorCommand = this.settingsCommands.get(input.commandId);
        const admitted = (async () => {
            if (priorCommand) await priorCommand;
            signal.throwIfAborted();
            const receipt = await this.storage.get<{ signature: string; confirmed?: boolean }>(key);
            signal.throwIfAborted();
            if (receipt && receipt.signature !== JSON.stringify([mode, settings])) throw new Error('Configuration command identity changed.');
            if (!receipt && input.expectedRevision && input.expectedRevision !== this.config(mode).revision) throw new Error('Settings changed; reload before applying this edit.');
            if (!receipt?.confirmed) for (const prior of predecessors) prior.controller.abort();
        })();
        void admitted.catch(() => {});
        const operation = this.serialMode(mode, async () => {
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
                    if (previousAccess) { await this.closeAccess(previousAccess); }
                }
            }
            signal.throwIfAborted();
            const next = { revision: old?.revision ?? randomUUID(), settings };
            await this.storage.set(key, { signature, revision: next.revision });
            await this.persistSettings(mode, next);
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
                if (mode === 'git') this.prepareGit();
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
        }, input.commandId);
        void operation.finally(() => this.configurationOwners.delete(owner)).catch(() => {});
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
        const operation = this.serialMode(input.mode, async () => {
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
        const operation = this.serialMode(mode, async () => {
            this.assertOpen(); owner?.controller.signal.throwIfAborted();
            await this.storage.set('framework-participation/' + mode, enabled);
            owner?.controller.signal.throwIfAborted();
            if(enabled) await this.connect(mode, owner!.controller.signal);
            else { const running = this.running.get(mode); if(running) { try { await this.stopRunning(running); } finally { this.running.delete(mode); } } }
            this.changed(); return enabled ? this.view({mode}) : this.settingsView(mode);
        });
        void operation.finally(() => { if (owner) this.configurationOwners.delete(owner); }).catch(() => {});
        return operation;
    }
    async selectMode(input: {
        mode: FrameworkMode;
        headerOnly?: boolean;
    }): Promise<FrameworkClientView> {
        this.assertOpen();
        const mode = z.enum(['local', 'git']).parse(input.mode);
        this.activeMode = mode;
        await this.storage.set('framework-active-mode', mode);
        if (mode === 'git') this.prepareGit();
        this.changed();
        return this.view({ mode, headerOnly: input.headerOnly });
    }
    private async readFileBytes(files: FilesStore, snapshot: FilesSnapshot, path: string): Promise<Uint8Array | undefined> {
        const bytes = await files.readBytes(snapshot, path);
        if (bytes !== undefined) return bytes;
        // Resolve only a Task identity already present in this exact logical path.
        // Do not scan unrelated archives or infer an identity from a filename.
        const taskId = /^(?:task-runs|Recorder Cache|technical\/recovery-inputs)\/([^/]+)\//.exec(path)?.[1]
            ?? /^state\/[^/]+\/([^/]+)\//.exec(path)?.[1];
        return taskId ? readArchivedReference(files, snapshot, taskId, path) : undefined;
    }
    async readFile(input: {
        mode: FrameworkMode;
        path: string;
        storageScope?: string;
    }) {
        const active = await this.access(input.mode);
        this.checkScope(active, input.storageScope);
        const downloadUrl = '/api/deepseek-servant-framework/download?mode=' + input.mode + '&path=' + encodeURIComponent(input.path) + '&storageScope=' + encodeURIComponent(active.connection.scope);
        return withSnapshot(active.connection.files, async (snapshot) => {
            const bytes = await this.readFileBytes(active.connection.files, snapshot, input.path);
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
    async download(mode: FrameworkMode, path: string, storageScope?: string): Promise<Uint8Array> { const active = await this.access(mode); this.checkScope(active, storageScope); return withSnapshot(active.connection.files, async (snapshot) => { const bytes = await this.readFileBytes(active.connection.files, snapshot, path); if (bytes === undefined)
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
                try { access.artifactRepair?.controller.abort(); access.connection.cancelPending(); } catch (error) { this.disposalErrors.push(error); }
            }, () => {}));
            await Promise.allSettled([this.initializing, this.starting, this.configuration, ...this.modeConfiguration.values()]);
            await Promise.allSettled([...this.opening.values()]);
            await Promise.all(stopping);
            await Promise.all(cancellingAccess);
            await Promise.allSettled([...this.writePreparations]);
            for (const [mode, active] of this.running) {
                if (!this.stopping.has(active)) try { await this.stopRunning(active); } catch (error) { this.cleanupFailure(mode, error); }
            }
            this.running.clear();
            for (const runtime of this.relocationOwners.values()) try { await runtime.dispose(); } catch (error) { this.disposalErrors.push(error); }
            this.relocationOwners.clear();
            for (const pending of accesses) {
                const access = await pending.catch(() => undefined);
                if (access) try { await this.closeAccess(access); } catch (error) { this.disposalErrors.push(error); }
            }
            this.accesses.clear();
            this.listeners.clear();
            if (this.disposalErrors.length) throw new AggregateError(this.disposalErrors, 'Framework service resource disposal failed.');
        })();
        return this.disposal;
    }
}
