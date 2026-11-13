import { GitStartupUpgrade } from './git-startup-upgrade.js'
import { convertedLocalSkillPath } from './local-upgrade-mapping.js'
import { localUpgradeView } from './local-upgrade-view.js'
import { keepCurrentLocalUpgradeTarget, keepRetainedLocalUpgradeStage } from './local-startup-upgrade.js'
import { keepRetainedSpecialLocalUpgradeStage } from './local-upgrade-special-stage-choice.js'
import { readLocalUpgradeCompleted } from './local-upgrade-completion.js'
import { PendingLocalTaskViewCache, pendingLocalTaskResult } from './legacy-local-task-view.js'
import { pendingLocalInitializationOriginal } from './local-upgrade-initialization.js'
import { frameworkArchiveSkillPublication } from './client-presentation.js'
import { legacyTaskNeedsRestoration, type LocalTaskUpgradeReport } from './local-upgrade-task.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { LocalStartupUpgradeAgent, type LocalUpgradeAgentResult } from './local-startup-upgrade-agent.js'
import { legacyConversationNeedsRestoration, prepareLocalConversation, restoreLegacyConversationSignals, localConversationUpgradeKey, type LocalConversationUpgradeReport } from './local-upgrade-conversation.js'
import { LegacyLocalConversationView } from './legacy-local-conversation-view.js'
import { taskArchiveReadPath } from './task-archive.js'
import { ConversationAttachments, type ConversationAttachmentUpload } from './conversation-attachments.js'
import { validateConversationAttachment, isConversationAttachmentPath, isLocalAttachmentError, LocalAttachmentError, type ConversationAttachmentReference } from './conversation-attachment-reference.js'
import { isPhysicalWorkspaceReference, type PhysicalWorkspaceReference } from './workspace-paths.js'
import { parseTaskReference, referenceTaskId, readPublishedReference } from './published-references.js'
import { submitTaskCancellation } from './task-cancellation.js'
import { physicalControlSignalSources } from './physical-control-signal-sources.js'
import { publishTaskResume } from './task-resume.js'
import { taskFamily } from './task-relations.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { FrameworkSafetyNet, type SafetyFault, type SafetyFaultContext, type SafetyPresentation } from './safety-net.js'
import { HistorySelectionChangedError, requiresUserAction } from './client-error.js'
import type { RoleErrorOrigin, RoleErrorResolution } from './role-error-origin.js'
import { disposeResources } from './dispose-resources.js'
import { omitAbsentFields } from '../adapters/dsh/json-record.js'
import { LegacyLocalConfigurationReadError } from '../adapters/dsh/record-files.js'
import { listLegacyArtifactReferences, type LegacyArtifactReference } from './legacy-artifacts.js'
import { FrameworkRecordMove, type RecordMoveReceipt, type RecordMovePhysicalStore } from './record-move.js'
import { isDeepStrictEqual } from 'node:util'
import { listLegacyRecordExports, readLegacyRecordExport, type LegacyRecordExportIdentity } from './legacy-record-export.js'
import { frameworkStorageUsage, exportFrameworkRecords, exportFrameworkDocument, exportFrameworkBytes } from './maintenance.js'
import { FrameworkManualCleanup } from './manual-cleanup.js'
import { readTaskCleanupRecord } from './cleaner.js'
import { FrameworkKnowledge } from './knowledge.js'
import { FrameworkTaskIndex } from './task-index.js'
import { FrameworkTaskHistoryCache, readTaskReferenceIdentity } from './task-history.js'
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { StoragePort } from '../contracts/ports.js';
import { DshWorkspaceAdapter } from '../adapters/dsh/workspace.js';
import { openFrameworkConnection, openFrameworkStorage, type FrameworkConnection, type FrameworkStorage, type FrameworkConnectionDependencies } from './connection.js';
import { resumeLegacyTask, answerLegacyTask, type LegacyTask, type MigrationManifest } from './legacy-migration.js';
import { ExecutionControls, LegacyLocalControlReadError, type TaskControl } from './execution-control.js';
import { physicalForegroundSignalSources, FrameworkConversation } from './conversation.js';
import { FrameworkRoleRuntime } from './role-runtime.js';
import { createRecorderCapacity } from './capacity.js';
import { paths, readJson, readMemberStatus, taskLifecycle, isTerminalTask, type TaskMetadata, type MemberStatus } from './task-files.js';
import { withOperationChannel, withReadOperation, withSnapshot, FilesConflictError, FilesOutcomeUnknownError, type FilesStore, type FilesSnapshot, type FileChange } from './transactions.js';
import { readArchivedReference, resolveTaskRequirementReference } from './recorder-retention.js';
import { InstanceRegistration, type ObservedInstance, type RegisteredInstance } from './instances.js';
import type { FrameworkClientApi, FrameworkTaskControlSubmission, FrameworkExecutionStopSubmission, FrameworkClientChange, FrameworkClientSettings, FrameworkClientView, FrameworkMode, FrameworkSendInput } from './client-contracts.js';
import { GitAuthorityStore } from './git-authority.js'
import { taskArchiveHostKey } from './task-archive.js'
const model = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() });
const settingsSchema = z.object({ name: z.string(), userName: z.string(), localDirectory: z.string(), ownerRepo: z.string(), repositoryDirectory: z.string(),
    collaborationId: z.string().min(1), workerSeats: z.number().int().nonnegative(), workspace: z.string(), presetId: z.string().optional(),
    foreground: model.optional(), background: model.optional(), showCornerCharacter: z.boolean().optional(), swapPageIllustrations: z.boolean().optional() });
interface Saved {
    revision: string;
    settings: FrameworkClientSettings;
}
interface Access { originalTasks?: PendingLocalTaskViewCache; legacyConversation?: LegacyLocalConversationView; commandHostKey: string; operations?: Set<Promise<unknown>>; closing?: Promise<void>; legacyArtifacts?: Map<string, LegacyArtifactReference[]>; legacyExports?: Map<string, LegacyRecordExportIdentity[]>; knowledge?: FrameworkKnowledge; taskIndex?: FrameworkTaskIndex; taskHistoryCache?: FrameworkTaskHistoryCache; connection: FrameworkStorage; conversation: FrameworkConversation; observer?: InstanceRegistration; controls?: ExecutionControls }
function abortedBy(signal: AbortSignal | undefined, error: unknown): boolean {
    return !!signal?.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason));
}
interface ConfigurationOwner { mode: FrameworkMode; commandId?: string; controller: AbortController; kind?: 'foreground-model' }
interface Running {
    /** One startup continuation of existing, user-confirmed file selections. */
    manualCleanup?: { controller: AbortController; work: Promise<void> };
    connection: FrameworkConnection;
    runtime: FrameworkRoleRuntime;
    resources: ObservedInstance[];
    /** Raw selection whose resolved root this running instance actually uses. */
    workspaceSelection: string;
}
/** Both modes use one business implementation; selecting a page does not own either runtime. */
export class FrameworkService implements Omit<FrameworkClientApi, 'subscribeChanged' | 'uploadAttachment'> {
    private readonly localUpgrades = new Map<string, { controller: AbortController; work?: Promise<LocalUpgradeAgentResult>; agent?: LocalStartupUpgradeAgent; result?: LocalUpgradeAgentResult; failure?: string; choosing?: boolean; oldSourceFound?: true; assessedSignals: Set<string>; conversations: Map<string, Promise<LocalConversationUpgradeReport>>; tasks: Map<string, Promise<LocalTaskUpgradeReport>>; independentTasks: Set<string>; taskChecks?: Map<string, Promise<boolean>>; registered?: RegisteredInstance }>();
    private readonly accessTransitions = new Map<FrameworkMode, Promise<void>>();
    private readonly accesses = new Map<FrameworkMode, Promise<Access>>();
    private readonly writePreparations = new Set<Promise<void>>();
    private gitPreparation?: { revision: string; promise: Promise<void> };
    private readonly stopping = new WeakMap<Running, { promise: Promise<void>; controller: AbortController }>();
    private readonly running = new Map<FrameworkMode, Running>();
    private readonly configurationOwners = new Set<ConfigurationOwner>();
    private readonly accessOpening = new Map<FrameworkMode, AbortController>();
    private readonly backgroundOpening = new Map<FrameworkMode, AbortController>();
    private readonly opening = new Map<FrameworkMode, Promise<Running>>();
    private readonly archiveViews = new Map<FrameworkMode, FrameworkClientView['archives']>();
    private readonly errors = new Map<FrameworkMode, string>();
    private readonly userErrors = new Map<FrameworkMode, string>();
    private readonly displayOwner = randomUUID();
    private readonly safetyNet = new FrameworkSafetyNet(this.displayOwner);
    private readonly safetyOperations = new AsyncLocalStorage<{ context: SafetyFaultContext; occurrence: number }>();
    private readonly safetyErrors = new WeakMap<object, SafetyPresentation>();
    private readonly safetyDeliveries = new Set<string>();
    private displayOccurrence = 0;
    private readonly configurationErrors = new Map<FrameworkMode, string>();
    private readonly startupErrors = new Map<FrameworkMode, string>();
    private readonly resolvedSafetyFaultIds = new Set<string>();
    private readonly resolvedRoleFacts = new Set<string>();
    private readonly reportedErrors = new Map<FrameworkMode, Map<string, { message: string; error?: unknown; operationId?: string; commandId?: string; scope?: string; origin?: RoleErrorOrigin; ownershipKeys?: Set<string>; safety?: SafetyPresentation }>>();
    private readonly saved = new Map<FrameworkMode, Saved>();
    private readonly listeners = new Set<(event?: FrameworkClientChange) => void>();
    private activeMode: FrameworkMode = 'local';
    private readonly modeConfiguration = new Map<FrameworkMode, Promise<unknown>>();
    private readonly settingsCommands = new Map<string, Promise<unknown>>();
    private readonly modeSending = new Map<FrameworkMode, Promise<void>>();
    private readonly conversationBarriers = new Map<FrameworkMode, Promise<void>>();
    private serialMode<T>(mode: FrameworkMode, action: (releaseConversation: () => void) => Promise<T>, commandId?: string, conversationBarrier = false): Promise<T> {
        try { mode = z.enum(['local', 'git']).parse(mode); } catch (error) { return Promise.reject(error); }
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        const predecessors = [this.modeConfiguration.get(mode), commandId === undefined ? undefined : this.settingsCommands.get(commandId),
            conversationBarrier ? this.modeSending.get(mode) : undefined];
        let releaseConversation = () => {};
        const boundary = conversationBarrier ? { promise: new Promise<void>(resolve => { releaseConversation = resolve; }) } : undefined;
        const operation = Promise.all(predecessors).then(() => { this.assertOpen(); return action(releaseConversation); });
        const settled = operation.then(() => undefined, () => undefined);
        this.modeConfiguration.set(mode, settled);
        // Only changing the storage/conversation itself waits for accepted sends
        // and blocks later ones. Unrelated task and knowledge work has no lane here.
        if (boundary) {
            this.conversationBarriers.set(mode, boundary.promise);
            void settled.then(() => {
                releaseConversation();
                if (this.conversationBarriers.get(mode) === boundary.promise) this.conversationBarriers.delete(mode);
            });
        }
        if (commandId !== undefined) {
            this.settingsCommands.set(commandId, settled);
            void settled.then(() => { if (this.settingsCommands.get(commandId) === settled) this.settingsCommands.delete(commandId); });
        }
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
    private readonly startupState = new Map<FrameworkMode, { status: 'starting' | 'failed'; owner: object; error?: unknown }>();
    private readonly disposalErrors: unknown[] = [];
    private assertOpen(): void { if (this.closed) throw new Error('Framework service is disposed.'); }
    private cleanupFailure(mode: FrameworkMode, error: unknown): void { this.disposalErrors.push(error); this.report(mode, error); }
    constructor(private readonly ctx: Context, private readonly storage: StoragePort, private readonly defaults: FrameworkClientSettings, private readonly gitRuntime?: FrameworkConnectionDependencies['gitRuntime'], private readonly hostModuleURL?: string) { }
    subscribeChanged = (listener: (event?: FrameworkClientChange) => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private changed(event?: FrameworkClientChange): void { this.deliverSafetyFaults(); for (const listener of this.listeners)
        listener(event); }
    private diagnosticScope(mode: FrameworkMode, settings = this.saved.get(mode)?.settings): string {
        if (!settings) return mode + ' (storage scope unavailable)';
        return mode === 'local' ? settings.localDirectory : settings.ownerRepo + '/' + settings.repositoryDirectory;
    }
    private refreshErrors(mode: FrameworkMode): void {
        const messages = this.reportedErrors.get(mode);
        if (messages?.size) {
            this.errors.set(mode, [...new Set([...messages.values()].map(record => record.message))].join('\n'));
            const text = [...new Set([...messages.values()].filter(record => !record.safety).map(record => record.message))].join('\n');
            if (text) this.userErrors.set(mode, text); else this.userErrors.delete(mode);
        } else { this.errors.delete(mode); this.userErrors.delete(mode); this.reportedErrors.delete(mode); }
    }
    private sameSafetyFault(left?: SafetyPresentation, right?: SafetyPresentation): boolean {
        const fault = left && this.safetyNet.fault(left.faultId);
        return !!fault && !!right && this.safetyNet.fault(right.faultId) === fault;
    }
    private clearResolvedErrors(mode: FrameworkMode, commandId: string): void {
        const messages = this.reportedErrors.get(mode);
        for (const [key, record] of messages ?? []) {
            if (!record.origin && record.commandId === commandId) { messages!.delete(key); if (record.safety && ![...messages!.values()].some(other => this.sameSafetyFault(other.safety, record.safety))) this.resolveSafetyFault(record.safety.faultId); }
        }
        this.refreshErrors(mode);
    }
    private resolveSafetyFault(id: string): void {
        for (const alias of this.safetyNet.ids(id)) this.resolvedSafetyFaultIds.add(alias);
        this.safetyNet.resolved(id);
    }
    private resolveRoleErrors(mode: FrameworkMode, scope: string, target: RoleErrorResolution): void {
        const messages = this.reportedErrors.get(mode);
        let changed = false;
        for (const [key, record] of messages ?? []) {
            if (record.operationId || record.scope !== scope || !record.origin) continue;
            const matches = 'taskId' in target ? (record.origin.taskId ?? record.origin.identity?.taskId) === target.taskId
                : record.origin.hostRestorationCommandId === target.hostRestorationCommandId;
            if (matches) { for (const fact of record.ownershipKeys ?? []) this.resolvedRoleFacts.add(fact); if (record.safety && ![...messages!.values()].some(other => other !== record && this.sameSafetyFault(other.safety, record.safety) && other.operationId)) this.resolveSafetyFault(record.safety.faultId); messages!.delete(key); changed = true; }
        }
        if (changed) { this.refreshErrors(mode); this.changed(); }
    }
    private clearLegacyLocalControlIssue(scope: string, taskId?: string): void {
        const messages = this.reportedErrors.get('local');
        let cleared = false;
        for (const [key, record] of messages ?? []) {
            if (!(record.error instanceof LegacyLocalControlReadError) || record.scope !== scope
                || (record.origin?.taskId ?? record.origin?.identity?.taskId) !== taskId) continue;
            messages!.delete(key); cleared = true;
        }
        if (cleared) { this.refreshErrors('local'); this.changed(); }
    }
    private report(mode: FrameworkMode, error: unknown, scope?: string, commandId?: string, origin?: RoleErrorOrigin, safety?: { source: string; occurrence: number }): string {
        const raw = error instanceof Error ? error.message : String(error);
        const operationId = error instanceof FilesOutcomeUnknownError ? error.operationId : undefined;
        const message = operationId ? `Unresolved storage operation ${operationId} in ${scope ?? this.diagnosticScope(mode)}: ${raw}` : raw;
        if (origin && !origin.role && !origin.identity && !origin.taskId && !origin.hostRestorationCommandId && !origin.restoreCommandId && !origin.diagnosticContext) origin = undefined;
        const legacyKey = origin ? JSON.stringify([scope, origin.taskId ?? origin.identity?.taskId, origin.identity?.workId,
            origin.identity?.executionId, origin.hostRestorationCommandId, origin.restoreCommandId, message]) : message;
        const source = safety?.source ?? this.safetyOperations.getStore()?.context.source ?? 'service';
        const occurrence = safety?.occurrence ?? this.safetyOperations.getStore()?.occurrence ?? 0;
        const diagnosticSignature = typeof origin?.diagnosticContext?.roleAuthorityContent === 'string'
            || typeof origin?.diagnosticContext?.hostRestorationCommandId === 'string' ? origin.errorSignature : undefined;
        const ownershipKey = origin && JSON.stringify([mode, source, occurrence, legacyKey, ...(diagnosticSignature ? [diagnosticSignature] : [])]);
        const previous = error && typeof error === 'object' ? this.safetyErrors.get(error) : undefined;
        if (!operationId && ((ownershipKey && this.resolvedRoleFacts.has(ownershipKey))
            || (previous && this.resolvedSafetyFaultIds.has(previous.faultId)))) return legacyKey;
        let messages = this.reportedErrors.get(mode);
        if (!messages) this.reportedErrors.set(mode, messages = new Map());
        const presentation = this.captureSafety(error, { ...this.safetyOperations.getStore()?.context, mode, scope: scope ?? this.safetyOperations.getStore()?.context.scope ?? this.running.get(mode)?.connection.scope ?? this.diagnosticScope(mode), source, identity: origin?.identity ?? this.safetyOperations.getStore()?.context.identity, role: origin?.role ?? this.safetyOperations.getStore()?.context.role, taskId: origin?.taskId ?? this.safetyOperations.getStore()?.context.taskId, admissionTimeout: origin?.admissionTimeout, diagnosticContext: origin?.diagnosticContext, errorSignature: origin?.errorSignature, operationId, ...(error instanceof FilesOutcomeUnknownError ? { code: 'dss/outcome-unknown' } : error instanceof FilesConflictError ? { code: 'dss/conflict' } : {}) }, occurrence);
        const key = presentation ? 'safety:' + presentation.faultId + (operationId ? ':' + operationId : '') : legacyKey;
        if (!messages.has(key)) { messages.set(key, { message, error, operationId, commandId, scope, origin, ...(ownershipKey ? { ownershipKeys: new Set([ownershipKey]) } : {}), ...(presentation ? { safety: presentation } : {}) }); this.refreshErrors(mode); this.changed(); }
        else if (presentation && messages.get(key)!.safety?.state !== presentation.state) { messages.get(key)!.safety = presentation; messages.get(key)!.message = message; this.refreshErrors(mode); this.changed(); }
        if (ownershipKey) (messages.get(key)!.ownershipKeys ??= new Set()).add(ownershipKey);
        if (commandId !== undefined) messages.get(key)!.commandId = commandId;
        return key;
    }
    private captureSafety(error: unknown, context: SafetyFaultContext, occurrence: number): SafetyPresentation | undefined {
        if (requiresUserAction(error) || error instanceof LegacyLocalControlReadError || error instanceof LegacyLocalConfigurationReadError) return undefined;
        const original = error && typeof error === 'object' ? this.safetyErrors.get(error) : undefined;
        if (original) return this.safetyNet.presentation(original.faultId) ?? original;
        const presentation = this.safetyNet.capture(error, context, occurrence);
        if (error && typeof error === 'object') this.safetyErrors.set(error, presentation);
        this.ctx.logger?.('deepseek-servant').error(error);
        this.deliverSafetyFaults();
        return presentation;
    }
    private deliverSafetyFaults(): void {
        if (this.closed) return;
        for (const [mode, active] of this.running) {
            const pending = [...this.safetyNet.pending(mode, active.connection.scope), ...this.safetyNet.pending(mode, this.diagnosticScope(mode))];
            for (const fault of pending) {
                this.safetyNet.bindScope(fault.id, active.connection.scope);
                const current = this.safetyNet.fault(fault.id)!;
                if (this.safetyDeliveries.has(current.id) || !this.safetyNet.needsRepair(current.id)) continue;
                this.safetyDeliveries.add(current.id);
                void Promise.resolve().then(() => active.runtime.requestSafetyRepair(current))
                    .then(() => this.safetyNet.assigned(current.id), error => { this.ctx.logger?.('deepseek-servant').error(error); })
                    .finally(() => this.safetyDeliveries.delete(current.id));
            }
        }
    }
    private safetyChanged(mode: FrameworkMode): void {
        this.displayOccurrence = this.safetyNet.begin();
        this.changed({ domain: 'safety', mode, occurrence: this.displayOccurrence, owner: this.displayOwner });
    }
    private safetyCallbacks(mode: FrameworkMode) {
        return { retrySafetyDelivery: () => this.deliverSafetyFaults(), safetyOccurrence: () => this.safetyNet.begin(), safetyDisplayOwner: () => this.displayOwner,
            safetyReplay: (fault: SafetyFault, result: { attemptId?: string; failure?: string; terminal?: boolean; displayOwner?: string }) => {
                if (!fault.operationId && this.resolvedSafetyFaultIds.has(fault.id)) return;
                this.safetyNet.restore(fault, result);
                let messages = this.reportedErrors.get(mode);
                if (!messages) this.reportedErrors.set(mode, messages = new Map());
                messages.set('safety:' + fault.id, { message: fault.message, scope: fault.scope, operationId: fault.operationId,
                    origin: { identity: fault.identity, taskId: fault.taskId }, safety: this.safetyNet.presentation(fault.id) });
                this.refreshErrors(mode); this.safetyChanged(mode);
            },
            safetyResolved: (id: string) => {
                const fault = this.safetyNet.fault(id), messages = this.reportedErrors.get(mode);
                if (!fault) return;
                const matches = [...messages ?? []].filter(([, value]) => value.safety && this.safetyNet.fault(value.safety.faultId) === fault);
                for (const [key, value] of matches) if (!value.operationId) { for (const fact of value.ownershipKeys ?? []) this.resolvedRoleFacts.add(fact); messages!.delete(key); }
                if (fault.operationId || matches.some(([, value]) => value.operationId)) this.safetyNet.awaitingOutcome(id);
                else this.resolveSafetyFault(id);
                this.refreshErrors(mode); this.changed();
            },
            safetyAttempted: (id: string, attemptId: string) => { if (this.safetyNet.attempted(id, attemptId)) { this.refreshErrors(mode); this.safetyChanged(mode); } },
            safetyAttemptFailed: (id: string, attemptId: string, error: unknown, terminal = false) => {
                this.ctx.logger?.('deepseek-servant').error(error);
                this.safetyNet.failed(id, attemptId, error, terminal); this.refreshErrors(mode); this.safetyChanged(mode);
            } };
    }
    /** One occurrence starts before an RPC. Its failure remains a failure; only
     * notification visibility is deferred while the existing Helper owns repair. */
    withSafetyOperation<T>(source: string, input: unknown, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const data = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const mode = data.mode === 'git' || data.mode === 'local' ? data.mode : this.activeMode;
        const context: SafetyFaultContext = { mode, source, scope: typeof data.storageScope === 'string' ? data.storageScope : this.running.get(mode)?.connection.scope,
            ...(typeof data.taskId === 'string' ? { taskId: data.taskId } : isPhysicalWorkspaceReference(data.reference) && typeof data.reference.taskId === 'string' ? { taskId: data.reference.taskId } : {}),
            ...(typeof data.workId === 'string' ? { workId: data.workId } : {}),
            ...(typeof data.executionId === 'string' ? { executionId: data.executionId } : {}),
            ...(typeof data.path === 'string' ? { target: data.path } : {}) };
        return this.safetyOperations.run({ context, occurrence: this.safetyNet.begin() }, async () => {
            try { return await operation(); }
            catch (error) { if (!isLocalAttachmentError(error) && !(source === 'history' && error instanceof HistorySelectionChangedError) && !abortedBy(signal, error)) this.report(mode, error, context.scope, typeof data.commandId === 'string' ? data.commandId : undefined); throw error; }
        });
    }
    errorPresentation(error: unknown): SafetyPresentation | undefined {
        const original = error && typeof error === 'object' ? this.safetyErrors.get(error) : undefined;
        return original && (this.safetyNet.presentation(original.faultId) ?? original);
    }
    async clientFault(input: { mode: FrameworkMode; storageScope?: string; source: string; message: string; code?: string; target?: string; occurrence?: number; displayOwner?: string }): Promise<SafetyPresentation | undefined> {
        const checked = z.object({ mode: z.enum(['local', 'git']), storageScope: z.string().optional(), source: z.string().min(1), message: z.string(), code: z.string().optional(), target: z.string().optional(), occurrence: z.number().int().nonnegative().optional(), displayOwner: z.string().optional() }).parse(input);
        const error = Object.assign(new Error(checked.message), { code: checked.code });
        const presentation = this.captureSafety(error, { mode: checked.mode, scope: checked.storageScope ?? this.running.get(checked.mode)?.connection.scope ?? this.diagnosticScope(checked.mode), source: 'client/' + checked.source, code: checked.code, target: checked.target }, checked.displayOwner === this.displayOwner ? Math.min(checked.occurrence ?? 0, this.safetyNet.current()) : 0);
        if (presentation) {
            let messages = this.reportedErrors.get(checked.mode);
            if (!messages) this.reportedErrors.set(checked.mode, messages = new Map());
            messages.set('client:' + presentation.faultId, { message: checked.message, error, scope: checked.storageScope, safety: presentation });
            this.refreshErrors(checked.mode); this.changed();
        }
        return presentation;
    }
    /** Host registration waits for settings, not remote migration or model admission. */
    initialize(): Promise<void> {
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        return this.initializing ??= this.initializeOwned();
    }
    /** Explicit lifecycle callers may still await every owned startup responsibility. */
    async start(): Promise<void> { await this.initialize(); await this.starting; this.assertOpen(); }
    private boundLocalScope(directory: string): string | undefined {
        const running = this.running.get('local');
        if (!running || this.stopping.has(running) || !(running.connection.files instanceof PhysicalLocalFiles)
            || running.connection.files.directory !== directory
            || running.runtime.config.collaborationId !== this.config('local').settings.collaborationId) return undefined;
        return running.runtime.config.collaborationId;
    }
    /** Activated by the existing Host startup owner, never by an ordinary read.
     * The physical connection is available while this exact source is converted;
     * unrelated tasks and already converted scopes do not await the Agent. */
    private startLocalUpgrade(connection: Pick<FrameworkStorage, 'files' | 'scope' | 'identity'>, workspace: string, settings: FrameworkClientSettings): void {
        if (!(connection.files instanceof PhysicalLocalFiles) || this.localUpgrades.has(connection.files.directory)) return;
        const directory = connection.files.directory;
        const owner = { controller: new AbortController(), conversations: new Map<string, Promise<LocalConversationUpgradeReport>>(), tasks: new Map<string, Promise<LocalTaskUpgradeReport>>(), independentTasks: new Set<string>(), taskChecks: new Map<string, Promise<boolean>>(), assessedSignals: new Set<string>(), oldSourceFound: undefined as true | undefined, work: undefined as Promise<LocalUpgradeAgentResult> | undefined, agent: undefined as LocalStartupUpgradeAgent | undefined, result: undefined as LocalUpgradeAgentResult | undefined, failure: undefined as string | undefined, registered: undefined as RegisteredInstance | undefined };
        this.localUpgrades.set(directory, owner);
        const invalidateTaskView = (taskId?: string) => {
            if (taskId === undefined) owner.taskChecks.clear(); else owner.taskChecks.delete(taskId);
            void this.accesses.get('local')?.then(access => {
                if (access.connection.files instanceof PhysicalLocalFiles && access.connection.files.directory === directory) access.originalTasks?.invalidate(taskId);
            }).catch(() => {});
        };
        const resumeInitialization = () => {
            // The exporter can finish before runtime construction. Reuse this
            // acquisition's opening promise; do not start another connection.
            void (async () => {
                const running = this.running.get('local') ?? await this.opening.get('local')?.catch(() => undefined);
                if (running?.connection.files instanceof PhysicalLocalFiles && running.connection.files.directory === directory)
                    running.runtime.resumeInitializationOriginals();
            })().catch(error => { if (!owner.controller.signal.aborted) this.report('local', error, connection.scope); });
        };
        const agent = new LocalStartupUpgradeAgent(this.ctx, this.storage, { directory, cwd: workspace,
            presetId: settings.presetId, model: settings.background, collaborationId: settings.collaborationId,
            currentCollaborationId: () => this.boundLocalScope(directory),
            whenLocalOpened: () => this.opening.get('local'),
            onOldSourceFound: () => {
                owner.oldSourceFound = true;
                const running = this.running.get('local');
                if (running?.connection.files instanceof PhysicalLocalFiles && running.connection.files.directory === directory)
                    this.scheduleBoundOriginalConversationSignals(running);
            },
            currentInstance: () => ({ instanceUUID: connection.identity.instanceUUID,
                registered: this.running.get('local')?.connection.scope === connection.scope ? this.running.get('local')!.connection.registration : owner.registered }),
            hostKey: taskArchiveHostKey(undefined, connection.scope, connection.identity.instanceUUID),
            changed: () => this.changed(),
            onMaterialization: () => resumeInitialization(),
            onSkillRestoration: result => {
                if (result.status === 'complete') {
                    const running = this.running.get('local');
                    if (running?.connection.files instanceof PhysicalLocalFiles && running.connection.files.directory === directory) running.runtime.refreshSkills();
                }
            },
            onTaskRestoration: (taskId, work) => {
                owner.taskChecks.delete(taskId);
                owner.tasks.set(taskId, work);
                void work.finally(() => { if (owner.tasks.get(taskId) === work) owner.tasks.delete(taskId); invalidateTaskView(taskId); }).catch(() => {});
                void work.then(async result => {
                    if (result.status !== 'complete' && result.status !== 'not-needed') return;
                    owner.independentTasks.add(taskId);
                    const running = this.running.get('local') ?? await this.opening.get('local')?.catch(() => undefined);
                    if (running?.connection.files instanceof PhysicalLocalFiles && running.connection.files.directory === directory)
                        running.runtime.resumeImportedTask(taskId);
                    this.changed();
                }).catch(error => { if (!owner.controller.signal.aborted) this.report('local', error, connection.scope); });
            },
            onConversationRestoration: (scope, work) => {
                owner.conversations.set(scope, work);
                void work.then(async result => {
                    if (result.status !== 'complete' && result.status !== 'not-needed') return;
                    const access = await this.accesses.get('local')?.catch(() => undefined);
                    if (access?.connection.files instanceof PhysicalLocalFiles && access.connection.files.directory === directory && access.conversation.scope.collaborationId === scope) {
                        await access.conversation.resumePhysicalPublication();
                        access.legacyConversation = undefined;
                    }
                    this.changed();
                }).catch(error => { if (!owner.controller.signal.aborted) this.report('local', error, connection.scope); });
            } });
        owner.agent = agent;
        owner.work = agent.start(owner.controller.signal);
        void owner.work.then(result => {
            owner.result = result;
            if (result.status === 'complete') owner.oldSourceFound = undefined;
            invalidateTaskView(); resumeInitialization();
            if (result.status === 'not-needed' && this.localUpgrades.get(directory) === owner) this.localUpgrades.delete(directory);
            if (result.status === 'pending') this.report('local', new Error(result.detail ?? result.pending?.map(item => item.path + ': ' + item.reason).join('; ') ?? 'The one-time Local upgrade remains incomplete; original data is retained.'), connection.scope);
            this.changed();
        }, error => { if (!owner.controller.signal.aborted) { owner.failure = error instanceof Error ? error.message : String(error); invalidateTaskView(); this.report('local', error, connection.scope); this.changed(); } });
    }
    /** Activation only: retry an already-restored exact scope whose old
     * notification was deferred before this Host was bound. The decision is
     * one persisted receipt read, not a SQL scan on every scope switch. */
    private async resumeBoundOriginalConversationSignals(running: Running): Promise<void> {
        if (!(running.connection.files instanceof PhysicalLocalFiles)) return;
        const directory = running.connection.files.directory, scope = running.runtime.config.collaborationId;
        const owner = this.localUpgrades.get(directory);
        if (!owner?.agent || !owner.oldSourceFound || owner.assessedSignals.has(scope)) return;
        const state = await this.storage.get<{ kind: string; directory: string; collaborationId: string; status: string; signalsAssessed?: { version: number; pending?: unknown[] } }>(localConversationUpgradeKey(directory, scope));
        if (state?.kind !== 'dss-once-conversation-full-text' || state.directory !== directory || state.collaborationId !== scope
            || state.status !== 'complete') return;
        if (state.signalsAssessed?.version === 1) {
            if (Array.isArray(state.signalsAssessed.pending) && state.signalsAssessed.pending.length === 0)
                owner.assessedSignals.add(scope);
            return;
        }
        await restoreLegacyConversationSignals(directory, scope, this.storage,
            () => this.boundLocalScope(directory), owner.controller.signal);
        // Only a persisted empty-pending assessment is final. A binding change
        // or an ambiguous original must remain eligible on the next activation.
        const assessed = await this.storage.get<{ signalsAssessed?: { version: number; pending?: unknown[] } }>(localConversationUpgradeKey(directory, scope));
        if (assessed?.signalsAssessed?.version === 1 && Array.isArray(assessed.signalsAssessed.pending)
            && assessed.signalsAssessed.pending.length === 0) owner.assessedSignals.add(scope);
        this.changed();
    }
    private scheduleBoundOriginalConversationSignals(running: Running): void {
        void this.resumeBoundOriginalConversationSignals(running).catch(error => {
            const owner = running.connection.files instanceof PhysicalLocalFiles ? this.localUpgrades.get(running.connection.files.directory) : undefined;
            if (!owner?.controller.signal.aborted) this.report('local', error, running.connection.scope);
        });
    }
    private beforeLocalTaskDiscovery(connection: Pick<FrameworkStorage, 'files'>, task: TaskMetadata): Promise<boolean> {
        return this.beforeLocalTaskUse(connection, task.taskId);
    }
    private async beforeLocalTaskUse(connection: Pick<FrameworkStorage, 'files'>, taskId: string, wait = true): Promise<boolean> {
        if (!(connection.files instanceof PhysicalLocalFiles)) return true;
        const owner = this.localUpgrades.get(connection.files.directory);
        if (owner?.independentTasks.has(taskId)) return true;
        const work = owner?.tasks.get(taskId);
        if (work) {
            // A non-waiting runtime probe borrows this Task's live restoration;
            // it neither opens the original SQL again nor waits for another Task.
            if (!wait) return false;
            await work;
            if (owner?.independentTasks.has(taskId)) return true;
        }
        // Once the existing startup lifecycle has completed without an owner,
        // later Tasks do not repeatedly inspect the old migration source.
        if (!owner) return !!this.starting && !this.startupState.has('local') || !await legacyTaskNeedsRestoration(connection.files.directory, taskId, this.storage);
        const checks = owner.taskChecks ??= new Map<string, Promise<boolean>>();
        const pending = checks.get(taskId);
        if (pending) return pending;
        // Reuse both the in-flight read and its known pending answer until this
        // Task restoration, source result or explicit Refresh changes the facts.
        const checked: Promise<boolean> = legacyTaskNeedsRestoration(connection.files.directory, taskId, this.storage, owner.controller.signal).then(needed => {
            if (!needed && checks.get(taskId) === checked) {
                owner.independentTasks.add(taskId); checks.delete(taskId);
            }
            return !needed;
        }, error => {
            if (checks.get(taskId) === checked) checks.delete(taskId);
            throw error;
        });
        checks.set(taskId, checked);
        return checked;
    }
    private async prepareConversationWrite(access: Access): Promise<void> {
        await access.conversation.prepare();
        await access.conversation.resumePhysicalPublication();
        access.legacyConversation = undefined;
    }
    private async conversationReader(access: Access): Promise<FrameworkConversation | LegacyLocalConversationView> {
        try {
            await this.prepareConversationWrite(access);
            return access.conversation;
        } catch (error) {
            // A genuine pending conversion keeps its original read-only history
            // available in the existing UI. Sending still reports that exact
            // failure and retains the user's input; it cannot create a new index.
            if (!access.legacyConversation) throw error;
            this.report('local', error, access.connection.scope);
            return access.legacyConversation;
        }
    }
    private async initializeOwned(): Promise<void> {
        this.activeMode = await this.storage.get<FrameworkMode>('framework-active-mode') ?? 'local';
        for (const mode of ['local', 'git'] as const) {
            this.assertOpen();
            const key = 'framework-settings/' + mode;
            let saved = await this.storage.get<Saved>(key);
            if (!saved) {
                // Missing current settings start from the current Host defaults.
                // Legacy profiles and cooperation settings remain user-owned history.
                saved = { revision: randomUUID(), settings: { ...this.defaults } };
                await this.persistSettings(mode, saved);
            } else this.saved.set(mode, saved);
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
            const safetyOccurrence = this.safetyNet.begin();
            const operation = Promise.resolve().then(async () => {
                try {
                    if (owner.mode === 'local') await preparation; this.assertOpen(); owner.controller.signal.throwIfAborted();
                    const mode = owner.mode;
                    const enabled = await this.storage.get<boolean>('framework-participation/' + mode) ?? mode === 'local';
                    this.assertOpen(); owner.controller.signal.throwIfAborted();
                    if (enabled && (mode !== 'git' || this.config(mode).settings.ownerRepo.trim())) {
                        await this.connect(mode, owner.controller.signal);
                    } else if (mode === 'local') {
                        const access = await this.access(mode);
                        if (access.connection.files instanceof PhysicalLocalFiles) {
                            const workspace = await new DshWorkspaceAdapter(this.ctx).resolve(undefined, this.config(mode).settings.workspace || undefined);
                            this.startLocalUpgrade(access.connection, workspace.directory, this.config(mode).settings);
                        }
                        await this.withManualCleanup(access, cleanup => cleanup.resumePending((error, commandId) => { this.report(mode, error, access.connection.scope, commandId); }));
                    }
                    if (this.startupState.get(mode)?.owner === owner) this.startupState.delete(mode);
                } catch (error) {
                    if (this.closed || abortedBy(owner.controller.signal, error)) {
                        if (this.startupState.get(owner.mode)?.owner === owner) this.startupState.delete(owner.mode);
                    } else {
                        if (this.startupState.get(owner.mode)?.owner === owner) this.startupState.set(owner.mode, { status: 'failed', owner, error });
                        this.startupErrors.set(owner.mode, this.report(owner.mode, error, this.diagnosticScope(owner.mode), undefined, undefined, { source: 'startup', occurrence: safetyOccurrence }));
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
        const safetyOccurrence = this.safetyNet.begin();
        const access = this.access('git'), acquisition = this.accessOpening.get('git');
        const current = () => !this.closed && this.saved.get('git') === saved && this.accesses.get('git') === access;
        const operation = access.then(async value => {
            if (current()) await value.connection.prepareWrite({ initialize: false });
        }).catch(error => {
            // A failed acquisition removes itself from accesses. Its real error
            // still belongs here; cancellation or a replacement does not.
            if (!this.closed && this.saved.get('git') === saved && !acquisition?.signal.aborted
                && (!this.accesses.has('git') || this.accesses.get('git') === access))
                this.report('git', error, this.diagnosticScope('git', saved.settings), undefined, undefined, { source: 'prepare', occurrence: safetyOccurrence });
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
    private moveError(mode: FrameworkMode, settings = this.saved.get(mode)?.settings): Error | undefined {
        if (mode !== 'local' || !this.recordMoving) return;
        const move = this.pendingRecordMove;
        if (move && settings && [move.sourceLocal, move.targetLocal].filter(Boolean).length
            && ![move.sourceLocal, move.targetLocal].some(path => path && resolve(path) === resolve(settings.localDirectory))) return;
        return this.recordMoving;
    }
    private startupFailure(mode: FrameworkMode): unknown {
        const state = this.startupState.get(mode);
        if (state && 'error' in state) return state.error;
        for (const key of [this.configurationErrors.get(mode), this.startupErrors.get(mode)]) {
            const record = key && this.reportedErrors.get(mode)?.get(key);
            if (record && 'error' in record) return record.error;
        }
        return new Error(this.errors.get(mode) ?? 'Collaboration startup failed. Retry connection to resume the retained work.');
    }
    private async modeReady(mode: FrameworkMode): Promise<void> {
        await this.initializing;
        this.assertOpen();
        if (this.moveError(mode)) throw this.moveError(mode);
        // A replacement connection has already completed its own acquisition,
        // migration and runtime admission. An invalidated bootstrap remains
        // owned for disposal, but cannot gate this newer published connection.
        if (this.running.has(mode)) return;
        if (this.startupState.get(mode)?.status === 'failed') throw this.startupFailure(mode);
        if (mode === 'git' && this.startupState.get(mode)?.status === 'starting') throw new Error('Git collaboration is still initializing; this operation has not been applied. Retry after initialization completes.');
        const opening = this.opening.get(mode);
        if (opening) await opening; else await this.modeStarting.get(mode);
        this.assertOpen();
        if (this.moveError(mode)) throw this.moveError(mode);
        if (!this.running.has(mode) && this.startupState.get(mode)?.status === 'failed') throw this.startupFailure(mode);
    }
    private access(mode: FrameworkMode): Promise<Access> {
        if (this.moveError(mode)) return Promise.reject(this.moveError(mode));
        if (this.closed) return Promise.reject(new Error('Framework service is disposed.'));
        const transition = this.accessTransitions.get(mode);
        if (transition) return transition.then(() => this.access(mode));
        const prior = this.accesses.get(mode); if (prior) return prior;
        const settings = this.config(mode).settings;
        const controller = new AbortController();
        this.accessOpening.set(mode, controller);
        const pending = openFrameworkStorage(mode === 'local' ? { mode, directory: settings.localDirectory, login: settings.userName, workerSeats: settings.workerSeats }
            : { mode, ownerRepo: settings.ownerRepo, repositoryDirectory: settings.repositoryDirectory, workerSeats: settings.workerSeats }, { storage: this.storage, signal: controller.signal, gitRuntime: this.gitRuntime })
          .then(async connection => {
            const assertCurrent = () => {
                this.assertOpen();
                controller.signal.throwIfAborted();
                if (this.accessOpening.get(mode) !== controller) throw new Error('Storage access was replaced before acquisition completed.');
            };
            try {
                assertCurrent();
                const access: Access = { commandHostKey: taskArchiveHostKey(connection.records instanceof GitAuthorityStore ? connection.records.root : undefined, connection.scope, connection.identity.instanceUUID), connection, conversation: new FrameworkConversation(connection.files, connection.transactions, { mode, collaborationId: settings.collaborationId }, path => physicalForegroundSignalSources(connection.records, connection.scope, path, mode === 'local' ? settings.collaborationId : undefined), () => prepareLocalConversation(connection.files, settings.collaborationId, this.storage)) };
                if (connection.files instanceof PhysicalLocalFiles && await legacyConversationNeedsRestoration(connection.files.directory, settings.collaborationId, this.storage, controller.signal))
                    access.legacyConversation = new LegacyLocalConversationView(connection.files.directory, settings.collaborationId);
                else await access.conversation.resumePhysicalPublication();
                // Local attachments refer directly to selected originals and create no storage folder.
                assertCurrent();
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
    /** Independent user work shares only its actual storage lifetime. These
     * promises are concurrent owners, not a configuration or admission queue. */
    private async withAccessOperation<T>(input: { mode: FrameworkMode; storageScope?: string }, action: (access: Access) => Promise<T>): Promise<T> {
        const mode = z.enum(['local', 'git']).parse(input.mode);
        const access = await this.access(mode);
        this.assertOpen(); this.checkScope(access, input.storageScope);
        if (access.closing) throw new Error('The selected storage access is closing.');
        const operation = Promise.resolve().then(() => action(access));
        (access.operations ??= new Set()).add(operation);
        try { return await operation; }
        finally { access.operations!.delete(operation); }
    }
    private closeAccess(access: Access): Promise<void> {
        if (!access.closing) access.closing = Promise.resolve().then(async () => {
            let closing: Promise<void> | undefined;
            await disposeResources([
                () => access.connection.cancelPending(),
                () => access.originalTasks?.close(),
                () => {
                    // Git close seals transaction/authority owners before they
                    // drain. Transport cancellation alone allows reacquisition.
                    if (access.conversation.scope.mode === 'git') {
                        closing = access.connection.close(); void closing.catch(() => {});
                    }
                },
                // Local control records and export output outlive individual
                // Files calls. Retain their original result/rollback on handover.
                async () => { await Promise.allSettled([...(access.operations ?? [])]); },
                () => closing ?? access.connection.close(),
            ]);
        });
        return access.closing;
    }
    private config(mode: FrameworkMode): Saved { this.assertOpen(); const saved = this.saved.get(mode); if (!saved)
        throw new Error('Framework settings are not loaded.'); return saved; }
    private connect(mode: FrameworkMode, signal?: AbortSignal): Promise<Running> {
        if (this.moveError(mode)) return Promise.reject(this.moveError(mode));
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
                else this.startupState.set(mode, { status: 'failed', owner: controller, error });
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
             : { mode, ownerRepo: settings.ownerRepo, repositoryDirectory: settings.repositoryDirectory, workerSeats: settings.workerSeats }, { storage: this.storage, signal, gitRuntime: this.gitRuntime,
                onStorageOpened: access => this.startLocalUpgrade(access, workspace.directory, settings),
                onOriginalInstanceIssue: error => { this.report(mode, error); },
                onInstanceRegistered: (access, registered) => {
                    if (access.files instanceof PhysicalLocalFiles) {
                        const owner = this.localUpgrades.get(access.files.directory);
                        if (owner) owner.registered = registered;
                    }
                },
                ...(mode === 'local' ? { pendingInitializationOriginal: (path: string) => pendingLocalInitializationOriginal(settings.localDirectory, this.storage, path, signal) } : {}),
            });
        if (connection.roleGuideInitializationError !== undefined)
            this.ctx.logger?.('deepseek-servant').error('Foreground reference initialization did not complete; independent work remains available.', connection.roleGuideInitializationError);
        let resources: ObservedInstance[];
        try {
            this.assertOpen();
            signal?.throwIfAborted();
            await withOperationChannel(connection.files, 'write', () => new ConversationAttachments(connection.files, connection.transactions, { mode, collaborationId: settings.collaborationId }).initialize());
            resources = await connection.members();
            signal?.throwIfAborted();
        }
        catch (error) {
            await connection.close().catch(failure => this.cleanupFailure(mode, failure));
            throw error;
        }
        const resource = { connection, resources, workspaceSelection: settings.workspace } as Running;
        let runtime: FrameworkRoleRuntime | undefined;
        try {
            this.assertOpen();
            runtime = new FrameworkRoleRuntime(this.ctx, connection.files, connection.records, {
                scope: connection.scope, member: connection.registration.member, instanceUUID: connection.registration.instanceUUID, primary: connection.registration.primary, workspace: workspace.directory,
                workerSeats: settings.workerSeats, mode, collaborationId: settings.collaborationId, presetId: settings.presetId,
                foreground: settings.foreground, background: settings.background,
            }, { ...(connection.files instanceof PhysicalLocalFiles ? { beforeTaskUse: (taskId: string, wait?: boolean) => this.beforeLocalTaskUse(connection, taskId, wait) } : {}), initialization: connection.initialization, beforeTaskDiscovery: task => this.beforeLocalTaskDiscovery(connection, task), sharedRecords: connection.sharedRecords, members: () => resource.resources.map(row => row.member), resources: () => resource.resources, capacity: createRecorderCapacity(connection.files),
                changed: change => this.changed(change), resolved: target => this.resolveRoleErrors(mode, connection.scope, target),
                oldLocalControlRecovered: taskId => this.clearLegacyLocalControlIssue(connection.scope, taskId),
                cancelPending: reason => connection.cancelPending(reason), heartbeat: async snapshot => {
                    await connection.tick(snapshot);
                    resource.runtime.updateWorkerSeats(connection.registration.workerSeats);
                }, observationInterrupted: () => connection.observationInterrupted(), observeResources: async snapshot => {
                    const next = await connection.members(snapshot);
                    const visible = (rows: ObservedInstance[]) => JSON.stringify(rows.map(row => ({ member: row.member, workerSeats: row.workerSeats, availability: row.availability, error: row.error })));
                    const changed = visible(next) !== visible(resource.resources);
                    resource.resources = next;
                    if (changed)
                        this.changed();
                }, ...this.safetyCallbacks(mode), error: (error, origin, safety) => { this.report(mode, error, connection.scope, undefined, origin, safety); } });
            resource.runtime = runtime;
            signal?.throwIfAborted();
            if (mode === 'local') {
                const cleanup = new FrameworkManualCleanup(connection.files, connection.transactions, runtime.conversation, runtime);
                const reportCleanup = (error: unknown, commandId: string) => { this.report(mode, error, connection.scope, commandId); };
                await cleanup.resumePending(reportCleanup, resume => {
                    const controller = new AbortController();
                    const work = Promise.resolve().then(() => resume(controller.signal)).then(() => undefined).catch(error => {
                        if (!abortedBy(controller.signal, error)) this.report(mode, error, connection.scope);
                    });
                    resource.manualCleanup = { controller, work };
                });
            }
            signal?.throwIfAborted();
            runtime.setForegroundModel(this.config(mode).settings.foreground);
            await runtime.start();
            this.assertOpen(); signal?.throwIfAborted();
            runtime.setForegroundModel(this.config(mode).settings.foreground);
            this.running.set(mode, resource); this.deliverSafetyFaults();
            if (mode === 'local') this.scheduleBoundOriginalConversationSignals(resource);
            if (mode === 'git') this.startGitUpgrade(resource, workspace.directory, settings);
            const startupError = this.startupErrors.get(mode), reported = this.reportedErrors.get(mode);
            if (startupError && !reported?.get(startupError)?.operationId) { reported?.delete(startupError); this.startupErrors.delete(mode); this.refreshErrors(mode); }
            return resource;
        }
        catch (error) {
            await this.stopManualCleanup(resource).catch(failure => this.cleanupFailure(mode, failure));
            await runtime?.dispose().catch(failure => this.cleanupFailure(mode, failure));
            await connection.close().catch(failure => this.cleanupFailure(mode, failure));
            throw error;
        }
    }
    private surfaceFault(mode: FrameworkMode, source: string, message: string | undefined, scope?: string, target?: string, identity?: RoleErrorOrigin['identity'], fresh = false): string | undefined {
        if (!message) return message;
        const context = { mode, source, scope: scope ?? this.running.get(mode)?.connection.scope ?? this.diagnosticScope(mode), target, identity };
        const projected = this.safetyNet.projected(context, message);
        if (projected === null) return undefined;
        projected ?? this.captureSafety(new Error(message), context, fresh ? this.safetyOperations.getStore()?.occurrence ?? 0 : 0);
        return undefined;
    }
    private settingsView(mode: FrameworkMode): FrameworkClientView {
        const saved = this.config(mode), active = this.running.get(mode), executions = active?.runtime.executionViews() ?? [];
        if (active) this.safetyNet.pruneResolvedProjections(mode, active.connection.scope, executions);
        return { ...(this.displayOccurrence ? { faultOccurrence: this.displayOccurrence, faultOwner: this.displayOwner } : {}), revision: saved.revision, activeMode: mode, collaborationId: saved.settings.collaborationId, settings: saved.settings,
            ...(active ? { storageScope: active.connection.scope } : {}),
            connection: { participating: !!active, status: active ? 'connected' : 'disconnected', detail: this.userErrors.get(mode), member: active?.connection.registration.member, workerSeats: active?.connection.registration.workerSeats }, messages: [], tasks: [], legacyTasks: [], archives: this.archiveViews.get(mode) ?? [], resources: [], executions: executions.map(row => row.detail === undefined ? row : ({ ...row, detail: this.surfaceFault(mode, 'execution', row.detail, active?.connection.scope, row.workId, row) })) };
    }
    async view(input: {
        mode?: FrameworkMode;
        includeArchives?: boolean;
        panelsOnly?: boolean;
        headerOnly?: boolean;
        refreshOriginalTasks?: boolean;
    } = {}, signal?: AbortSignal, channel: 'refresh' | 'foreground-read' = 'refresh'): Promise<FrameworkClientView> {
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
        if (startup && !active && (!this.accesses.has(mode) || this.accessOpening.has(mode))) {
            base.connection.status = startup.status; return base;
        }
        let access: Access;
        try { access = await this.access(mode); base.connection.status = 'connected'; } catch(error) { if (this.closed) throw error; this.report(mode, error); base.connection.detail = this.userErrors.get(mode); return base; }
        // Access may have waited for an actual settings/scope handoff. Never
        // pair an earlier header with the newly acquired destination.
        signal?.throwIfAborted();
        if (this.config(mode).revision !== saved.revision) return this.view(input, signal, channel);
        base.storageScope = access.connection.scope;
        if (access.connection.files instanceof PhysicalLocalFiles) {
            try { base.localUpgrade = await localUpgradeView(access.connection.files.directory, this.storage, this.localUpgrades.get(access.connection.files.directory)); } catch (error) { report(error); }
        }
        if (input.includeArchives) base.archives = [];
        // One view reads one authorized revision. Nested readers borrow this
        // snapshot; independent refreshes still acquire their own remote HEAD.
        await withOperationChannel(access.connection.files, channel, () => withSnapshot(access.connection.files, async (snapshot) => {
            signal?.throwIfAborted();
            // The existing file snapshot is already fixed. Only Host observations
            // started after this boundary may supersede it. Local controls retain
            // their existing separate-record semantics, not Git atomicity.
            if (active && this.running.get(mode) === active && active.connection.scope === access.connection.scope)
                base.taskStateCursor = active.runtime.taskStateViewBoundary?.();
            if (!input.panelsOnly) {
                const page = await (await this.conversationReader(access)).page(20, undefined, { missingBodies: 'report' }, snapshot, signal);
                signal?.throwIfAborted();
                base.messages = page.messages;
                base.missingBodies = page.missingBodies;
                base.processGroups = page.processGroups;
                base.pageBefore = page.moreBefore;
            }
            let observed = active?.resources ?? [];
            try { observed = active?.resources ?? await this.observe(access, mode, snapshot, signal); } catch (error) { report(error); }
            signal?.throwIfAborted();
            base.connection.instanceUUID = access.connection.identity.instanceUUID;
            const localMember = active?.connection.registration.member ?? observed.find(row => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
            base.hasOtherInstanceRecords = mode === 'git' && observed.some(row => row.instanceUUID !== access.connection.identity.instanceUUID);
            base.resources = observed.filter(row => !row.primary).map(row => ({ name: row.member, status: row.availability, instanceUUID: row.instanceUUID, workerSeats: row.workerSeats, detail: this.surfaceFault(mode, 'resource', row.error, access.connection.scope, row.instanceUUID) }));
            const archiveTasks = new Map<string, TaskMetadata>();
            try {
            signal?.throwIfAborted();
            try {
            access.taskIndex ??= new FrameworkTaskIndex(access.connection.files, error => this.report(mode, error));
            const taskEntries = await access.connection.files.listDirectory(snapshot, 'tasks/');
            const tasks = await access.taskIndex.list(snapshot, taskEntries, signal);
            for (const task of tasks) { archiveTasks.set(taskArchiveReadPath(task), task); archiveTasks.set(paths.archive(task), task); }
            access.taskHistoryCache ??= new FrameworkTaskHistoryCache(access.connection.files);
            const history = await access.taskHistoryCache.list(snapshot, report, signal);
            for (const task of history) {
                if (tasks.some(current => current.taskId === task.taskId)) continue;
                archiveTasks.set(paths.archive(task), task);
                if (task.historyCleared) {
                    if (input.includeArchives && task.resultPaths?.length) base.archives.push({ path: task.resultPaths[0]!, title: task.sourcePath, taskId: task.taskId, files: task.resultPaths });
                    continue;
                }
                base.tasks.push({ taskId: task.taskId, ...(task.parent ? { parentTaskId: task.parent.taskId } : {}), ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}),
                    title: task.sourcePath.split('/').at(-1)!, route: task.route, owner: task.owner, status: task.status,
                    archived: true, members: [], executions: [], resultPaths: task.resultPaths ?? [],
                    ...(task.workspaceResults ? { workspaceResults: task.workspaceResults } : {}) });
            }
            signal?.throwIfAborted();
            // Runtime and read-only access can open distinct stores for the same
            // scope. This borrowed snapshot belongs only to the access store.
            let pendingOriginalTasks: Awaited<ReturnType<PendingLocalTaskViewCache['read']>> = [];
            if (access.connection.files instanceof PhysicalLocalFiles) {
                if (base.localUpgrade?.status === 'complete') access.originalTasks?.retire();
                else try {
                    if (!access.originalTasks) {
                        const accessOwner = this.accesses.get(mode);
                        const current = () => !this.closed && !access.closing && this.accesses.get(mode) === accessOwner;
                        access.originalTasks = new PendingLocalTaskViewCache(access.connection.files.directory, this.storage,
                            error => { if (current()) this.report(mode, error, access.connection.scope); }, () => { if (current()) this.changed(); });
                    }
                    if (input.refreshOriginalTasks) {
                        access.originalTasks.invalidate();
                        this.localUpgrades.get(access.connection.files.directory)?.taskChecks?.clear();
                    }
                    const originalView = access.originalTasks.view(signal);
                    base.originalTaskRead = originalView.status;
                    pendingOriginalTasks = originalView.rows.filter(row => !history.some(task => task.taskId === row.task.taskId));
                } catch (error) { report(error); }
            }
            const originalTasks = pendingOriginalTasks.filter(row => !tasks.some(task => task.taskId === row.task.taskId));
            const pendingOriginalIds = new Set(pendingOriginalTasks.map(row => row.task.taskId));
            const allVisibleTasks = [...tasks, ...originalTasks.map(row => row.task)];
            const controls = allVisibleTasks.length ? await this.controls(access).taskStates(allVisibleTasks, snapshot) : undefined;
            for (const { task, members, historyCleared } of originalTasks) {
                if (historyCleared) {
                    if (input.includeArchives && task.resultPaths?.length) base.archives.push({ path: task.resultPaths[0]!, title: task.sourcePath, taskId: task.taskId, originalTaskId: task.taskId, files: task.resultPaths });
                    continue;
                }
                base.tasks.push({ taskId: task.taskId, ...(task.parent ? { parentTaskId: task.parent.taskId } : {}), ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}),
                    title: task.sourcePath.split('/').at(-1)!, route: task.route, owner: task.owner, status: task.status, originalSource: 'local-sql',
                    members, control: controls?.get(task.taskId)?.intent, executions: [], resultPaths: task.resultPaths ?? [],
                    ...(task.workspaceResults ? { workspaceResults: task.workspaceResults } : {}) });
            }
            signal?.throwIfAborted();
            await access.connection.files.prefetch?.(snapshot, { signal, isolatePathErrors: true, files: tasks.filter(task => !isTerminalTask(task))
                .flatMap(task => (task.members ?? [task.owner]).map(name => paths.memberStatus(task.taskId, name))) });
            signal?.throwIfAborted();
            for (const task of tasks) {
                signal?.throwIfAborted();
                const storedCleanup = (isTerminalTask(task) || mode === 'local') ? await readTaskCleanupRecord(access.connection.files, snapshot, task) : undefined;
                const cleanup = storedCleanup && taskLifecycle(storedCleanup) === taskLifecycle(task) ? storedCleanup : undefined;
                signal?.throwIfAborted();
                if (cleanup?.version === 1 && cleanup.taskId === task.taskId && cleanup.historyCleared === true) {
                    if (input.includeArchives && task.resultPaths?.length) base.archives.push({ path: task.resultPaths[0]!, title: task.sourcePath, taskId: task.taskId, files: task.resultPaths });
                    continue;
                }
                const members = await Promise.all((task.members ?? [task.owner]).map(async name => {
                    try {
                        // P acceptance belongs to its owner, including older records
                        // and Tasks whose working state Cleaner has since reclaimed.
                        if (task.status === 'complete' && task.route === 'P' && name === task.owner) return { name, status: 'complete' };
                        const path = paths.memberStatus(task.taskId, name);
                        const stored = await readMemberStatus(access.connection.files, snapshot, path);
                        const cleared = cleanup?.version === 1 && cleanup.taskId === task.taskId
                            && ['files-cleaned', 'released'].includes(cleanup.phase);
                        return { name, status: stored?.state ?? (cleared ? 'cleared' : 'unknown') };
                    }
                    catch (error) { report(error); return { name, status: 'unknown' }; }
                }));
                signal?.throwIfAborted();
                const control = controls?.get(task.taskId);
                base.tasks.push({ taskId: task.taskId, ...(task.parent ? { parentTaskId: task.parent.taskId } : {}), ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}), title: task.sourcePath.split('/').at(-1)!, route: task.route, owner: task.owner, status: task.status,
                    ...(pendingOriginalIds.has(task.taskId) ? { originalSource: 'local-sql' as const } : {}), members, control: control?.intent, executions: (active?.runtime.executionViews(task.taskId, taskLifecycle(task)) ?? []).map(row => row.detail === undefined ? row : ({ ...row, detail: this.surfaceFault(mode, 'execution', row.detail, access.connection.scope, row.workId, row) })), resultPaths: task.resultPaths ?? [], ...(task.workspaceResults ? { workspaceResults: task.workspaceResults } : {}) });
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
                    status: item.status, detail: this.surfaceFault(mode, 'legacy-artifact', item.detail, access.connection.scope, item.id) }));
                for (const task of manifest?.tasks ?? []) {
                    if (clearedIds.has(task.oldId)) continue;
                    const own = task.memberContinuations?.find(row => row.member === localMember);
                    const terminal = task.continuation === 'complete' || task.continuation === 'cancelled';
                    base.legacyTasks.push({ migrationId: migration.id, oldTaskId: task.oldId, taskId: task.taskId, continuation: terminal ? task.continuation : own?.continuation ?? task.continuation,
                        recordPath: task.recordPath, recordsAvailable: exports.some(row => row.oldTaskId === task.oldId), artifacts: artifactsFor(task.oldId), issues: manifest?.issues?.map(issue => this.surfaceFault(mode, 'legacy-migration', issue, access.connection.scope, migration.id)!), waits: terminal ? [] : own?.waits?.map(wait => ({ ...wait, memberIdentity: own.identity })) });
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
                const archiveRecordPaths = entries.filter(entry => /^archives\/(?:[^/]+\/)+records\.md$/.test(entry.path));
                for (const entry of archiveRecordPaths) {
                    const directory = entry.path.slice(0, -'/records.md'.length), folder = directory.slice('archives/'.length), prefix = directory + '/';
                    const task = archiveTasks.get(directory);
                    const nestedRoots = [...archiveRecordPaths.map(item => item.path.slice(0, -'/records.md'.length)), ...archiveTasks.keys()].filter(root => root.startsWith(prefix));
                    const taskId = task?.taskId; // An orphan's real path remains openable/exportable without inventing a Task identity.
                    const retention = await readJson<{ workspaceResults?: Array<PhysicalWorkspaceReference | string>; skillPublication?: unknown; missingReferences?: unknown }>(access.connection.files, snapshot, prefix + 'retention.json');
                    base.archives.push({ path: entry.path, title: task?.sourcePath.split('/').at(-1)?.replace(/_(?:P|O)\.md$/, '') ?? folder, ...(taskId ? { taskId } : {}),
                        ...(retention?.workspaceResults ? { workspaceResults: retention.workspaceResults } : {}),
                        skillPublication: frameworkArchiveSkillPublication(retention?.skillPublication),
                        ...(Array.isArray(retention?.missingReferences) ? { missingReferences: retention.missingReferences.filter((path): path is string => typeof path === 'string') } : {}),
                        files: entries.filter(file => file.path.startsWith(prefix) && !nestedRoots.some(root => file.path.startsWith(root + '/')) && file.path !== entry.path && file.path !== `${prefix}retention.json` && file.path !== `${prefix}state.json`).map(file => file.path).sort() });
                }
            }
            } catch (error) { report(error); }
        }, { signal, isolatePathErrors: true, files: [...(!input.panelsOnly ? [access.conversation.indexPath] : []), 'technical/legacy-migrations/index.json'],
            directories: ['tasks', ...(!active ? ['instances'] : [])] }));
        signal?.throwIfAborted();
        if (active && this.running.get(mode) === active) {
            try {
                const pendingProcessing = active.runtime.foregroundProcessing?.();
                const pendingProcessGroups = active.runtime.foregroundProcessGroups?.();
                const processing = await pendingProcessing;
                const processGroups = await pendingProcessGroups;
                if (this.running.get(mode) === active && this.config(mode).revision === saved.revision) {
                    base.foregroundProcessing = processing;
                    base.foregroundProcessGroups = processGroups ? [...processGroups] : undefined;
                }
            } catch (error) { report(error); }
        }
        signal?.throwIfAborted();
        base.connection.detail = this.userErrors.get(mode);
        if (input.includeArchives)
            this.archiveViews.set(mode, base.archives);
        return base;
    }
    private async persistSettings(mode: FrameworkMode, saved: Saved): Promise<Saved> {
        const key = 'framework-settings/' + mode;
        // Match the adapter's persisted JSON representation without reading its
        // in-memory domain map back as a second acknowledgement.
        const stored = omitAbsentFields(structuredClone(saved)) as Saved;
        await this.storage.set(key, stored);
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
                signal.throwIfAborted(); this.assertOpen();
                if (await this.storage.get<boolean>('framework-participation/local') ?? true) await this.connect('local', signal);
            },
        });
    }
    private async quiesceRecords(_receipt: Readonly<RecordMoveReceipt>, signal: AbortSignal): Promise<void> {
        this.pendingRecordMove = structuredClone(_receipt);
        // Materialize only the configured access owners before blocking new
        // acquisitions. A mechanical runtime reads existing execution evidence;
        // it never starts a loop, registers a member or opens an Agent.
        const owners = new Map<FrameworkMode, Access>();
        if (!this.recordMoving) owners.set('local', await this.access('local'));
        for (const owner of this.localUpgrades.values()) owner.controller.abort();
        await Promise.allSettled([...this.localUpgrades.values()].map(owner => owner.work));
        this.localUpgrades.clear();
        this.recordMoving = new Error('The confirmed record move owns these locations; resume that command before accessing records.');
        this.accessOpening.get('local')?.abort(this.recordMoving);
        this.backgroundOpening.get('local')?.abort(this.recordMoving);
        await Promise.allSettled([this.opening.get('local')]);
        const failures: unknown[] = [];
        for (const mode of ['local'] as const) {
            const active = this.running.get(mode), access = owners.get(mode);
            const settings = this.config(mode).settings;
            let runtime = this.relocationOwners.get(mode) ?? active?.runtime;
            try {
                if (!runtime && access) runtime = new FrameworkRoleRuntime(this.ctx, access.connection.files, access.connection.records, {
                    scope: access.connection.scope, member: access.connection.identity.login, instanceUUID: access.connection.identity.instanceUUID, primary: mode === 'local',
                    workspace: settings.workspace, workerSeats: settings.workerSeats, mode, collaborationId: settings.collaborationId,
                    presetId: settings.presetId, foreground: settings.foreground, background: settings.background,
                }, { sharedRecords: access.connection.sharedRecords, observationRecords: access.connection.records, members: () => [], resources: () => [], heartbeat: async () => {}, ...this.safetyCallbacks(mode), error: (error, origin, safety) => { this.report(mode, error, access.connection.scope, undefined, origin, safety); }, resolved: target => this.resolveRoleErrors(mode, access.connection.scope, target), oldLocalControlRecovered: taskId => this.clearLegacyLocalControlIssue(access.connection.scope, taskId), changed: change => this.changed(change), cancelPending: reason => access.connection.cancelPending(reason) });
                if (active) await this.stopManualCleanup(active);
                if (runtime) { this.relocationOwners.set(mode, runtime); await runtime.settleForStorageMove(); }
            } catch (error) { failures.push(error); }
            if (active) try { await active.connection.close(); } catch (error) { failures.push(error); }
            if (access) try { await this.closeAccess(access); } catch (error) { failures.push(error); }
        }
        this.running.delete('local'); this.accesses.delete('local'); this.archiveViews.delete('local');
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Record relocation could not confirm all storage owners stopped.');
        this.relocationOwners.delete('local');
    }
    moveRecords(input: { mode: 'local'; storageScope: string; expectedRevision: string; commandId: string; directory: string }): Promise<FrameworkClientView> {
        const operation = this.serialMode('local', async () => {
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
                    if (before.revision !== input.expectedRevision) {
                        // A retired or never-admitted request cannot be attributed
                        // from today's location. Return the current observation
                        // without repeating a move or inventing its old outcome.
                        const directory = (this.storage as StoragePort & RecordMovePhysicalStore).storageView().directory;
                        const view = await this.view({ mode: 'local', includeArchives: true, panelsOnly: true }, undefined, 'foreground-read');
                        return { ...view, recordMoveOutcome: { status: 'current-location' as const, commandId: input.commandId,
                            requestedDirectory: input.directory, directory } };
                    }
                    const access = await this.access('local'); this.checkScope(access, input.storageScope);
                    if (!(access.connection.files instanceof PhysicalLocalFiles)) throw new Error('Record relocation requires Local files.');
                    const physical = this.storage as StoragePort & RecordMovePhysicalStore;
                    await mover.run(input.commandId, { sourceRecords: physical.storageView().directory, targetRecords: input.directory,
                        sourceLocal: access.connection.files.directory, scope: access.connection.scope,
                        localBackend: 'physical',
                        settingsBefore: structuredClone(before), nextSettingsRevision: randomUUID() }, controller.signal);
                }
                this.pendingRecordMove = undefined;
                this.clearResolvedErrors('local', input.commandId); this.changed();
                const directory = (this.storage as StoragePort & RecordMovePhysicalStore).storageView().directory;
                const view = await this.view({ mode: 'local', includeArchives: true, panelsOnly: true }, undefined, 'foreground-read');
                return { ...view, recordMoveOutcome: { status: 'applied' as const, commandId: input.commandId,
                    requestedDirectory: input.directory, directory } };
            } catch (error) {
                try { this.pendingRecordMove = await mover.pendingReceipt() ?? this.pendingRecordMove; } catch { /* Keep the already-owned intent if locator reconciliation remains unknown. */ }
                this.report('local', error, input.storageScope, input.commandId); throw error;
            }
            finally { if (this.recordMoveController === controller) this.recordMoveController = undefined; }
        }, undefined, true);
        return operation;
    }
    async maintenanceView(input: Parameters<FrameworkClientApi['maintenanceView']>[0]) {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        if (input.mode !== 'local' || !(access.connection.files instanceof PhysicalLocalFiles)) throw new Error('Local records management requires its Local storage.');
        const store = this.storage as StoragePort & { storageView?(): { directory: string; nativeDirectory?: string } };
        const directories = store.storageView?.();
        return { localDirectory: access.connection.files.directory, recordsDirectory: directories?.directory,
            nativeDirectory: directories?.nativeDirectory,
            debugDirectory: resolve(access.connection.files.directory, 'debug'), usage: await frameworkStorageUsage(access.connection.files) };
    }
    async openMaintenancePath(input: Parameters<FrameworkClientApi['openMaintenancePath']>[0], signal = new AbortController().signal) {
        signal.throwIfAborted();
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        if (input.mode !== 'local' || !(access.connection.files instanceof PhysicalLocalFiles)) throw new Error('Local records management requires its Local storage.');
        const store = this.storage as StoragePort & { storageView?(): { directory: string; nativeDirectory?: string } };
        const path = input.target === 'records' ? access.connection.files.directory
            : input.target === 'debug' ? resolve(access.connection.files.directory, 'debug') : store.storageView?.().nativeDirectory;
        if (!path) throw new Error('The Host has not supplied the native session log directory.');
        const controller = this.ctx.get('sessionController');
        if (!controller?.canOpenWorkspacePath()) throw new Error('This Host cannot open local directories. Path: ' + path);
        await controller.openWorkspacePath({ path }, signal);
        return { path };
    }
    async keepCurrentLocalUpgradeTarget(input: Parameters<FrameworkClientApi['keepCurrentLocalUpgradeTarget']>[0]): Promise<{ saved: boolean }> {
        const keepStage = input.confirmation === 'keep-retained-stage-without-cleanup';
        if (input.mode !== 'local' || !keepStage && input.confirmation !== 'keep-current-with-original-unexported')
            throw new Error('Confirm keeping the current physical state while leaving the original SQL row unexported.');
        if (!keepStage && input.stageOwner) throw new Error('A retained-stage owner is not an original-row export choice.');
        const access = await this.access('local'); this.checkScope(access, input.storageScope);
        if (!(access.connection.files instanceof PhysicalLocalFiles)) throw new Error('This choice belongs to the selected Local records.');
        const directory = access.connection.files.directory, owner = this.localUpgrades.get(directory);
        // Two authenticated Settings windows may submit distinct dispositions at once.
        // Serialize only this owner's explicit choice write, never ordinary reads
        // or other Local roots. A losing request refreshes rather than claiming
        // success from a stale operation snapshot.
        if (owner?.choosing) throw new Error('Another Local upgrade choice is being saved; refresh and retry this row.');
        if (owner) owner.choosing = true;
        try {
            const selectedSpecial = (item: { owner: { kind: string; id: string }; operationId: string; path: string }) =>
                !!input.stageOwner && item.owner.kind === input.stageOwner.kind && item.owner.id === input.stageOwner.id
                && item.operationId === input.operationId && item.path === input.path;
            if (keepStage && input.stageOwner && owner?.result?.retainedSpecialStages?.some(selectedSpecial)) return { saved: true };
            if (owner?.result?.report.operationId === input.operationId && (keepStage
                ? !input.stageOwner && owner.result.report.retainedStages?.some(stage => stage.path === input.path && stage.keptByUser)
                : owner.result.report.keptCurrent?.some(row => row.path === input.path)))
                return { saved: true };
            const completed = await readLocalUpgradeCompleted(directory, this.storage);
            if (keepStage && input.stageOwner && completed?.retainedSpecialStages?.some(selectedSpecial)) return { saved: true };
            if (completed?.operationId === input.operationId && (keepStage
                ? !input.stageOwner && completed.report.retainedStages?.some(stage => stage.path === input.path && stage.keptByUser)
                : completed.report.keptCurrent?.some(row => row.path === input.path)))
                return { saved: true };
            if (!owner || owner.result?.status !== 'pending' || !owner.agent || !owner.work)
                throw new Error('Wait for the original one-time upgrade to report its exact conflict before choosing.');
            await owner.work;
            if (keepStage && input.stageOwner && !owner.result?.specialStageChoices?.some(selectedSpecial))
                throw new Error('This exact specialist stage was not offered by the settled one-time finish assessment; refresh it.');
            let saved = true;
            if (keepStage && input.stageOwner) saved = (await keepRetainedSpecialLocalUpgradeStage(directory, this.storage,
                { owner: input.stageOwner, operationId: input.operationId, path: input.path })).saved;
            else if (keepStage) saved = (await keepRetainedLocalUpgradeStage(directory, this.storage, input.operationId, input.path)).saved;
            else await keepCurrentLocalUpgradeTarget(directory, this.storage, input.operationId, input.path);
            // Resume the same one-time owner once; its original wake/session and SQL
            // still decide every other row. Saving the choice never claims finish.
            owner.result = undefined; owner.failure = undefined;
            const work = owner.agent.start(owner.controller.signal);
            owner.work = work;
            void work.then(result => { owner.result = result; this.changed(); }, error => {
                if (!owner.controller.signal.aborted) { owner.failure = error instanceof Error ? error.message : String(error); this.report('local', error, access.connection.scope); this.changed(); }
            });
            this.changed();
            return { saved };
        } finally { if (owner) owner.choosing = false; }
    }
    private async legacyManifestPath(access: Access, snapshot: import('./transactions.js').FilesSnapshot, migrationId: string): Promise<string> {
        const index = await readJson<{ migrations: Array<{ id: string; manifestPath: string }> }>(access.connection.files, snapshot, 'technical/legacy-migrations/index.json');
        const matches = index?.migrations.filter(item => item.id === migrationId) ?? [];
        if (matches.length !== 1) throw new Error('Select an existing legacy migration.');
        return matches[0]!.manifestPath;
    }
    async legacyRecords(input: { mode: FrameworkMode; storageScope?: string; migrationId: string; oldTaskId: string }): Promise<{ text: string; revision: string }> {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        return this.foreground(access, async () => {
            return withSnapshot(access.connection.files, async snapshot => {
                const manifestPath = await this.legacyManifestPath(access, snapshot, input.migrationId);
                const record = await readLegacyRecordExport(access.connection.files, snapshot, { manifestPath, oldTaskId: input.oldTaskId });
                return { text: Buffer.from(record.bytes).toString('utf8'), revision: snapshot.revision };
        });
        });
    }
    exportRecords(input: Parameters<FrameworkClientApi['exportRecords']>[0]) {
        return this.withAccessOperation(input, async access => {
            if (input.mode !== 'local') throw new Error('Record export is a Local user action.');
            const workspace = await new DshWorkspaceAdapter(this.ctx).resolve(undefined, this.config(input.mode).settings.workspace || undefined);
            if (input.recordPath) {
                if (input.taskId || input.migrationId || input.oldTaskId || !/^archives\/(?:[^/]+\/)+records\.md$/.test(input.recordPath)) throw new Error('Select one exact archive records.md path.');
                return exportFrameworkDocument(access.connection.files, input.recordPath, input.recordPath, workspace.directory);
            }
            if (input.taskId && !input.migrationId && !input.oldTaskId)
                return exportFrameworkRecords(access.connection.files, input.taskId, workspace.directory);
            if (input.taskId || !input.migrationId || !input.oldTaskId) throw new Error('Select exactly one current or legacy record.');
            const record = await withSnapshot(access.connection.files, async snapshot => {
                const manifestPath = await this.legacyManifestPath(access, snapshot, input.migrationId!);
                return readLegacyRecordExport(access.connection.files, snapshot, { manifestPath, oldTaskId: input.oldTaskId! });
            });
            return exportFrameworkBytes(record.bytes, record.taskId, workspace.directory, record.sha256);
        });
    }
    /** Explicit maintenance uses the existing background owner when present. A
     * disconnected Local scope gets only a mechanical lifecycle owner: no
     * registration, heartbeat, loop or Agent is started. */
    private async withManualCleanup<T>(access: Access, operation: (cleanup: FrameworkManualCleanup, runtime: FrameworkRoleRuntime) => Promise<T>, owned?: FrameworkRoleRuntime): Promise<T> {
        if (access.conversation.scope.mode !== 'local') throw new Error('Manual record cleanup is a Local user action.');
        const settings = this.config('local').settings;
        const active = owned ?? this.running.get('local')?.runtime;
        const runtime = active ?? new FrameworkRoleRuntime(this.ctx, access.connection.files, access.connection.records, {
            scope: access.connection.scope, member: access.connection.identity.login, instanceUUID: access.connection.identity.instanceUUID, primary: true,
            workspace: settings.workspace, workerSeats: settings.workerSeats, mode: 'local', collaborationId: settings.collaborationId,
            presetId: settings.presetId, foreground: settings.foreground, background: settings.background,
        }, { members: () => [], resources: () => [], heartbeat: async () => {}, ...this.safetyCallbacks('local'), error: (error, origin, safety) => { this.report('local', error, access.connection.scope, undefined, origin, safety); }, resolved: target => this.resolveRoleErrors('local', access.connection.scope, target), oldLocalControlRecovered: taskId => this.clearLegacyLocalControlIssue(access.connection.scope, taskId), changed: change => this.changed(change) });
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
        await this.initializing;
        return this.withAccessOperation(input, access => this.withManualCleanup(access, async cleanup => input.action === 'conversation' ? cleanup.previewConversation()
            : input.action && input.action !== 'tasks' ? cleanup.previewFiles(input.action) : cleanup.previewTasks()));
    }
    async cleanupRecords(input: Parameters<FrameworkClientApi['cleanupRecords']>[0]) {
        // Reserve the existing conversation boundary before readiness can yield.
        // Later input must not enter the history selected by this clear request.
        const operation = this.serialMode(input.mode, async () => {
            await this.modeReady(input.mode);
            this.assertOpen();
            const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
            const result = await this.withManualCleanup(access, async (cleanup, runtime) => {
                if (input.action === 'tasks') {
                    const result = await cleanup.clearTasks(input.commandId, input.preview, input.confirmation);
                    for (const task of input.preview.tasks) await runtime.prepareTaskCleanup(task.taskId);
                    return result;
                }
                if (input.action === 'conversation') return cleanup.clearConversation(input.commandId, input.confirmation, input.preview);
                if (input.action === 'debug') return cleanup.clearDebug(input.commandId, input.preview, input.confirmation);
                return cleanup.clearPlanning(input.commandId, input.confirmation, input.preview);
            });
            this.archiveViews.delete(input.mode); access.legacyExports = undefined; access.legacyArtifacts = undefined; this.changed(); return result;
        }, undefined, input.action === 'conversation');
        return operation;
    }
    private knowledge(access: Access, mode: FrameworkMode): FrameworkKnowledge {
        return access.knowledge ??= new FrameworkKnowledge(access.connection.files, access.connection.transactions, () => {
            this.running.get(mode)?.runtime.refreshSkills(); this.changed();
        }, access.connection.files instanceof PhysicalLocalFiles ? {
            pendingPaths: () => this.localUpgrades.get((access.connection.files as PhysicalLocalFiles).directory)?.agent?.pendingSkillPaths() ?? [],
            resolve: async path => {
                const directory = (access.connection.files as PhysicalLocalFiles).directory;
                const owner = this.localUpgrades.get(directory)?.agent;
                if (owner) return owner.skillSelection(path);
                const convertedPath = await convertedLocalSkillPath(directory, path, this.storage);
                return convertedPath ? { convertedPath } : {};
            },
        } : undefined);
    }
    async knowledgeList(input: Parameters<FrameworkClientApi['knowledgeList']>[0]) {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        const result = await this.foreground(access, () => this.knowledge(access, input.mode).list());
        return { ...result, items: result.items.map(item => ({ ...item, error: this.surfaceFault(input.mode, 'knowledge', item.error, access.connection.scope, item.path, undefined, true) })) };
    }
    async knowledgeRead(input: Parameters<FrameworkClientApi['knowledgeRead']>[0]) {
        const access = await this.access(input.mode); this.checkScope(access, input.storageScope);
        return this.foreground(access, () => this.knowledge(access, input.mode).read(input.path));
    }
    knowledgeEdit(input: Parameters<FrameworkClientApi['knowledgeEdit']>[0]) {
        return this.withAccessOperation(input, async access => {
            const { mode, storageScope, commandId, ...edit } = input;
            return this.foreground(access, () => this.knowledge(access, mode).edit(commandId, edit));
        });
    }
    knowledgeStatus(input: Parameters<FrameworkClientApi['knowledgeStatus']>[0]) {
        return this.withAccessOperation(input, async access => {
            const { mode, storageScope, commandId, ...status } = input;
            return this.foreground(access, () => this.knowledge(access, mode).setStatus(commandId, status));
        });
    }
    private controls(access: Access, active?: Running): ExecutionControls {
        if (active) return active.runtime.controls;
        return access.controls ??= new ExecutionControls(access.connection.sharedRecords, access.connection.scope, undefined, access.connection.files, access.connection.records, access.connection.identity.instanceUUID,
            (error, taskId) => { this.report('local', error, access.connection.scope, undefined, taskId ? { taskId } : undefined); },
            taskId => this.clearLegacyLocalControlIssue(access.connection.scope, taskId));
    }
    taskControl(input: { mode: FrameworkMode; storageScope?: string; commandId: string; taskId: string; lifecycleId?: string; intent: 'running' | 'paused' | 'cancelled' }): Promise<FrameworkTaskControlSubmission> {
        return this.withAccessOperation(input, async access => {
            const active = this.running.get(input.mode);
            if (access.connection.files instanceof PhysicalLocalFiles && !await this.beforeLocalTaskUse(access.connection, input.taskId)) {
                const owner = this.localUpgrades.get(access.connection.files.directory);
                if (!owner?.agent) throw new Error('This original Task is waiting for its one-time Local restoration after DSS Host activation.');
                const restored = await owner.agent.restoreTask(input.taskId, owner.controller.signal);
                if (restored.status === 'incomplete') throw new Error(restored.issues.map(issue => (issue.path ? issue.path + ': ' : '') + issue.message).join('; '));
                if (!await this.beforeLocalTaskUse(access.connection, input.taskId)) throw new Error('The selected original Task restoration remains incomplete; its original data is retained.');
            }
            return withOperationChannel(access.connection.files, 'foreground-write', async () => {
                // Git writes own their foreground access and CAS, never the Host read queue.
                // Physical Local controls own only the addressed Task, never a global writer queue.
                const controls = this.controls(access, input.mode === 'local' ? active : undefined);
                const published = async (task: TaskMetadata, records?: readonly TaskControl[]) => {
                    const current = this.running.get(input.mode)
                    if (current?.connection.scope === access.connection.scope)
                        await current.runtime.taskControlPublished(task, input.intent, records)
                }
                const submitted = (): FrameworkTaskControlSubmission => ({ submitted: true, commandId: input.commandId,
                    taskId: input.taskId, ...(input.lifecycleId ? { lifecycleId: input.lifecycleId } : {}), intent: input.intent });
                const { task, member, prior } = await withSnapshot(access.connection.files, async snapshot => {
                    if (input.mode === 'local') {
                        const cleanup = await readTaskCleanupRecord(access.connection.files, snapshot, input.taskId);
                        if (cleanup?.version === 1 && cleanup.taskId === input.taskId && taskLifecycle(cleanup) === (input.lifecycleId ?? '') && cleanup.historyCleared === true) throw new Error('This Task history was explicitly cleared. Create a new Task.');
                    }
                    const task = await readJson<TaskMetadata>(access.connection.files, snapshot, paths.task(input.taskId));
                    if (!task || task.status === 'complete' || task.status === 'cancelled' && input.intent !== 'cancelled') throw new Error('A completed, cancelled or absent Task cannot be reopened or controlled.');
                    if (taskLifecycle(task) !== (input.lifecycleId ?? '')) throw new Error('This task control belongs to an earlier lifecycle; select the current Task state.');
                    const member = active?.connection.registration.member ?? (await this.observe(access, input.mode, snapshot)).find(row => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
                    if (!member || !(task.members ?? [task.owner]).includes(member)) throw new Error('This Host has no registered execution domain in the selected Task.');
                    const prior = input.mode === 'git' && input.intent === 'cancelled' ? await this.controls(access).priorTaskCommand(input.commandId, snapshot) : undefined;
                    return { task, member, prior };
            });
            if (input.intent === 'cancelled') {
                const previous = input.mode === 'git' ? prior : await controls.priorTaskCommand(input.commandId, undefined, input);
                if (previous) {
                    if (previous.taskId !== input.taskId || previous.intent !== 'cancelled') throw new Error('Control command identity has different arguments.');
                    // This old-format branch only returns a historical command;
                    // no current control changed, so do not republish its intent.
                    return submitted();
                }
                const confirmed = await submitTaskCancellation({ files: access.connection.files, member, commandHostKey: access.commandHostKey,
                    physicalSignalSources: physicalControlSignalSources(access.connection.records, access.connection.scope, member, input.mode === 'local' ? this.config(input.mode).settings.collaborationId : undefined),
                    transact: (id, request, options, build) => access.connection.transactions.run(id, request, options, build)
                }, { taskId: input.taskId, ...(input.lifecycleId ? { lifecycleId: input.lifecycleId } : {}) }, input.commandId);
                const current = this.running.get(input.mode)
                if (current?.connection.scope === access.connection.scope)
                    await current.runtime.taskCancellationPublished(task, confirmed)
                return submitted();
            }
            let controlRecords: readonly TaskControl[] | undefined
            await controls.setTask(input.commandId, input.taskId, z.enum(['running', 'paused', 'cancelled']).parse(input.intent), taskLifecycle(task), undefined, undefined,
                records => { controlRecords = records });
            await published(task, controlRecords);
            if (input.intent === 'running') {
                // A remote owner cannot see this Host's native resume call. Persist
                // ordinary addressed manager signals so offline owners can continue
                // the same Tasks from their records when they next observe the ledger.
                await publishTaskResume({ files: access.connection.files, controls, transactions: access.connection.transactions, member, active: !!active, commandHostKey: access.commandHostKey,
                    physicalSignalSources: physicalControlSignalSources(access.connection.records, access.connection.scope, member, input.mode === 'local' ? this.config(input.mode).settings.collaborationId : undefined) },
                    { taskId: input.taskId, lifecycleId: task.lifecycleId }, input.commandId);
            }
            if (active && input.intent === 'running') active.runtime.scheduleTaskResume(input.taskId, input.commandId, taskLifecycle(task));
            return submitted();
            });
        });
    }
    async stopExecution(input: { mode: FrameworkMode; storageScope?: string; commandId: string; workId: string; executionId: string }): Promise<FrameworkExecutionStopSubmission> {
        const access = await this.access(input.mode);
        this.checkScope(access, input.storageScope);
        const active = this.running.get(input.mode);
        if (!active) throw new Error('This Host does not own a running backend for the selected execution.');
        return withOperationChannel(active.connection.files, 'foreground-write', async () => {
            await active.runtime.requestExecutionStop(input.commandId, input.workId, input.executionId,
                input.mode === 'local' && access.connection.files instanceof PhysicalLocalFiles
                    && active.connection.files instanceof PhysicalLocalFiles
                    && access.connection.scope === active.connection.scope
                    && access.connection.files.directory === active.connection.files.directory
                    ? target => this.controls(access).acknowledgeLocalReleasedExecutionStop(input.commandId, target) : undefined);
            return { submitted: true, commandId: input.commandId, workId: input.workId, executionId: input.executionId };
        });
    }
    private observe(access: Access, mode: FrameworkMode, snapshot?: FilesSnapshot, signal?: AbortSignal): Promise<ObservedInstance[]> {
        const c = access.connection;
        access.observer ??= new InstanceRegistration(c.files, c.records, { repositoryId: c.identity.repositoryId, repositoryOwner: c.identity.owner, login: c.identity.login, instanceUUID: c.identity.instanceUUID, workerSeats: 0 });
        return access.observer.observe(snapshot, signal).then(rows => mode === 'local' ? rows.map(row => ({ ...row, primary: row.instanceUUID === c.identity.instanceUUID })) : rows);
    }
    /** Explicit user work can touch the access and running stores. Both use
     * foreground pools; nested role admissions select their own backend pool. */
    private foreground<T>(access: Access, operation: () => Promise<T>, running?: Running): Promise<T> {
        return withOperationChannel(access.connection.files, 'foreground-read', () => running && running.connection.files !== access.connection.files
            ? withOperationChannel(running.connection.files, 'foreground-read', operation) : operation());
    }
    private checkScope(access: Access, expected?: string): void {
        if (expected !== undefined && expected !== access.connection.scope) throw new Error('Storage destination changed; retained input belongs to its original scope.');
    }
    async history(input: Parameters<FrameworkClientApi['history']>[0], signal?: AbortSignal) {
        signal?.throwIfAborted();
        const active = await this.access(input.mode);
        signal?.throwIfAborted();
        this.checkScope(active, input.storageScope);
        if (input.collaborationId !== this.config(input.mode).settings.collaborationId) throw new HistorySelectionChangedError('Conversation selection changed.');
        const page = await withOperationChannel(active.connection.files, input.live ? 'refresh' : 'foreground-read', async () =>
            (await this.conversationReader(active)).page(input.limit, input.beforeId, { afterId: input.afterId, date: input.date, live: input.live, missingBodies: 'report' }, undefined, signal));
        signal?.throwIfAborted();
        return { ...page, storageScope: active.connection.scope };
    }
    send(input: FrameworkSendInput) {
        let mode: FrameworkMode;
        try { mode = z.enum(['local', 'git']).parse(input.mode); this.assertOpen(); }
        catch (error) { return Promise.reject(error); }
        const operation = Promise.all([this.modeSending.get(mode), this.conversationBarriers.get(mode), this.initializing])
            .then(() => { this.assertOpen(); return this.sendStored(input); });
        const settled = operation.then(() => undefined, () => undefined);
        this.modeSending.set(mode, settled);
        void settled.then(() => { if (this.modeSending.get(mode) === settled) this.modeSending.delete(mode); });
        return operation;
    }
    private async sendStored(input: FrameworkSendInput) {
        const mode = z.enum(['local', 'git']).parse(input.mode), active = await this.access(mode);
        if (input.collaborationId !== this.config(mode).settings.collaborationId)
            throw new Error('Conversation selection changed; retained input belongs to its original conversation.');
        const body = z.object({ id: z.string().min(1), createdAt: z.string().datetime({ offset: true }), timezoneOffsetMinutes: z.number().int().optional(), text: z.string(), attachments: z.array(z.unknown()).optional().transform(values => values?.map(value => validateConversationAttachment(value, { mode, collaborationId: input.collaborationId }))), recipient: z.enum(['ai', 'human']), replyTo: z.string().optional(), device: z.string() }).parse(input);
        this.checkScope(active, input.storageScope);
        const participantId = active.connection.repository ? String(active.connection.repository.identity.id) : active.connection.identity.login;
        await withOperationChannel(active.connection.files, 'foreground-write', async () => {
            await active.connection.prepareWrite();
            await this.prepareConversationWrite(active);
            await active.conversation.send('client-message:' + body.id, { ...body, role: 'user', participantId,
                username: active.connection.repository?.identity.login || (this.config(mode).settings.userName || active.connection.identity.login) }, { reevaluate: true, ...(mode === 'git' ? { gitReplay: 'session-only' as const } : {}) });
        });
        this.changed(mode === 'git' ? { domain: 'conversation', mode } : undefined);
        return { storageScope: active.connection.scope };
    }
    async selectLocalAttachment(input: Parameters<NonNullable<FrameworkClientApi['selectLocalAttachment']>>[0], signal?: AbortSignal) {
        const body = z.object({ mode: z.literal('local'), collaborationId: z.string().min(1), selectionId: z.string().min(1), path: z.string().min(1), name: z.string().min(1), mimeType: z.string() }).parse(input);
        const active = await this.access('local');
        this.checkScope(active, input.storageScope);
        if (body.collaborationId !== this.config('local').settings.collaborationId) throw new LocalAttachmentError('The conversation changed. Select the original file in its intended conversation again.');
        const attachment = await active.conversation.attachments.selectLocal(body, signal);
        return { attachment, storageScope: active.connection.scope };
    }
    async openLocalAttachment(input: Parameters<NonNullable<FrameworkClientApi['openLocalAttachment']>>[0], signal = new AbortController().signal) {
        if (input.mode !== 'local') throw new LocalAttachmentError('Open a selected Local original through its Local conversation.');
        const active = await this.access('local');
        this.checkScope(active, input.storageScope);
        if (input.collaborationId !== this.config('local').settings.collaborationId) throw new LocalAttachmentError('The conversation changed.');
        const reference = validateConversationAttachment(input.reference, active.conversation.scope);
        if (reference.mode !== 'local') throw new LocalAttachmentError('This is not a Local original-file reference.');
        await active.conversation.attachments.validateLocal(reference, signal);
        const controller = this.ctx.get('sessionController');
        if (!controller?.canOpenWorkspacePath()) throw new LocalAttachmentError('This Host cannot open the selected original. Path: ' + reference.path);
        await controller.openWorkspacePath({ path: reference.path }, signal);
        return { path: reference.path };
    }
    async uploadAttachment(input: ConversationAttachmentUpload & { storageScope?: string }, source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
        const mode = z.literal('git').parse(input.mode);
        const active = await this.access(mode);
        this.checkScope(active, input.storageScope);
        if (input.collaborationId !== this.config(mode).settings.collaborationId) throw new Error('Conversation selection changed before attachment upload.');
        const body = z.object({ uploadId: z.string().min(1), name: z.string().min(1), mimeType: z.string(), bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).parse(input);
        const attachment = await withOperationChannel(active.connection.files, 'foreground-write', async () => {
            signal?.throwIfAborted(); await active.connection.prepareWrite();
            return active.conversation.attachments.upload({ ...body, mode, collaborationId: input.collaborationId }, source, signal);
        });
        return { attachment, storageScope: active.connection.scope };
    }
    async attachment(input: { mode: FrameworkMode; collaborationId: string; storageScope?: string; reference: ConversationAttachmentReference }) {
        if (input.mode === 'local') throw new LocalAttachmentError('Open this Local attachment at its selected original path.');
        const active = await this.access(z.enum(['local', 'git']).parse(input.mode));
        this.checkScope(active, input.storageScope);
        if (input.collaborationId !== this.config(input.mode).settings.collaborationId) throw new Error('Conversation selection changed.');
        const reference = validateConversationAttachment(input.reference, { mode: input.mode, collaborationId: input.collaborationId });
        return { downloadUrl: '/api/deepseek-servant-framework/attachment?' + new URLSearchParams({ mode: input.mode, collaborationId: input.collaborationId,
            storageScope: active.connection.scope, reference: JSON.stringify(reference) }), mimeType: reference.mimeType, bytes: reference.bytes };
    }
    /** The authenticated carrier streams a verified Git repository original.
     * Local originals use their independent native-path route. */
    async attachmentStream(input: { mode: FrameworkMode; collaborationId: string; storageScope?: string; reference: ConversationAttachmentReference }, signal?: AbortSignal) {
        if (input.mode === 'local') throw new LocalAttachmentError('Open this Local attachment at its selected original path.');
        const active = await this.access(z.enum(['local', 'git']).parse(input.mode));
        this.checkScope(active, input.storageScope);
        if (input.collaborationId !== this.config(input.mode).settings.collaborationId) throw new Error('Conversation selection changed.');
        const reference = validateConversationAttachment(input.reference, { mode: input.mode, collaborationId: input.collaborationId });
        const files = active.connection.files;
        const snapshot = await withOperationChannel(files, 'foreground-read', () => files.snapshot({ signal }));
        const iterator = active.conversation.attachments.streamAt(snapshot, reference, signal)[Symbol.asyncIterator]();
        let first: IteratorResult<Uint8Array> | undefined;
        // Verify the Git manifest and complete original before 200, including
        // the empty-file digest. No failed digest can satisfy Content-Length.
        try { first = await withOperationChannel(files, 'foreground-read', () => withReadOperation(files, () => iterator.next())); }
        catch (error) { await iterator.return?.(); await snapshot.release(); throw error; }
        let closed = false;
        const close = async () => { if (!closed) { closed = true; try { await iterator.return?.(); } finally { await snapshot.release(); } } };
        const stream = new ReadableStream<Uint8Array>({
            pull: async controller => {
                try {
                    const next = first ?? await withOperationChannel(files, 'foreground-read', () => withReadOperation(files, () => iterator.next()));
                    first = undefined;
                    if (next.done) { await close(); controller.close(); } else controller.enqueue(next.value);
                } catch (error) { await close(); controller.error(error); }
            }, cancel: close,
        });
        return { reference, stream };
    }
    foregroundModel(input: Parameters<FrameworkClientApi['foregroundModel']>[0]): Promise<FrameworkClientView> {
        let mode: FrameworkMode, route: FrameworkClientSettings['foreground'];
        try {
            this.assertOpen();
            mode = z.enum(['local', 'git']).parse(input.mode);
            if (this.moveError(mode)) throw this.moveError(mode);
            route = model.optional().parse(input.model);
            z.string().min(1).parse(input.commandId);
        } catch (error) { return Promise.reject(error); }
        const owner: ConfigurationOwner = { mode, commandId: input.commandId, controller: new AbortController(), kind: 'foreground-model' };
        this.configurationOwners.add(owner);
        const signal = owner.controller.signal;
        const operation = this.serialMode(mode, async () => {
            this.assertOpen(); signal.throwIfAborted(); if (this.moveError(mode)) throw this.moveError(mode);
            if (input.storageScope !== undefined) {
                let scope = this.running.get(mode)?.connection.scope;
                const access = this.accesses.get(mode);
                if (!scope && access && !this.accessOpening.has(mode)) scope = (await access).connection.scope;
                if (scope !== input.storageScope) throw new Error('Storage scope changed or is not ready; refresh before changing the foreground model.');
            }
            signal.throwIfAborted();
            const cached = this.config(mode);
            const persisted = await this.storage.get<Saved>('framework-settings/' + mode);
            const stored = persisted ?? cached;
            const selected = isDeepStrictEqual(omitAbsentFields(stored.settings.foreground), omitAbsentFields(route));
            signal.throwIfAborted();
            // The fixed current configuration is the fact. A repeated selection
            // needs no command history or another revision to confirm its value.
            if (persisted && selected) this.saved.set(mode, stored);
            else await this.persistSettings(mode, { revision: randomUUID(), settings: { ...stored.settings, foreground: route } });
            this.assertOpen(); signal.throwIfAborted();
            this.running.get(mode)?.runtime.setForegroundModel(this.config(mode).settings.foreground);
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
        let mode: FrameworkMode, settings: FrameworkClientSettings, requested: FrameworkClientSettings,
            changedFields: Array<keyof FrameworkClientSettings> | undefined, commandId: string,
            backgroundOnly = false, conversationBarrier = true;
        const applyChanges = (base: FrameworkClientSettings): FrameworkClientSettings => changedFields === undefined
            ? requested : settingsSchema.parse({ ...base, ...Object.fromEntries(changedFields.map(key => [key, requested[key]])) });
        const conversationAccessSettings = (value: FrameworkClientSettings) => JSON.stringify([
            mode === 'local' ? [value.localDirectory, value.userName] : [value.ownerRepo, value.repositoryDirectory], value.collaborationId]);
        try {
            ({ commandId } = input);
            this.assertOpen(); mode = z.enum(['local', 'git']).parse(input.mode);
            requested = settingsSchema.parse(input.settings);
            changedFields = z.array(settingsSchema.keyof()).optional().parse(input.changedFields);
            const current = this.config(mode);
            settings = applyChanges(current.settings);
            if (this.moveError(mode, settings)) throw this.moveError(mode, settings);
            const { background: previousBackground, ...previousFields } = current.settings;
            const { background, ...nextFields } = settings;
            const idleSettings = ![...this.configurationOwners].some(value => value.mode === mode) && !this.conversationBarriers.has(mode);
            backgroundOnly = idleSettings && !isDeepStrictEqual(previousBackground, background)
                && isDeepStrictEqual(omitAbsentFields(previousFields), omitAbsentFields(nextFields));
            // Unrelated settings retain this conversation's independent access.
            // Existing unfinished configuration still owns its original order.
            conversationBarrier = !idleSettings || conversationAccessSettings(current.settings) !== conversationAccessSettings(settings);
        }
        catch (error) { return Promise.reject(error); }
        const owner: ConfigurationOwner = { mode, commandId, controller: new AbortController() };
        const predecessors = [...this.configurationOwners].filter(value => value.mode === mode && value.commandId !== commandId);
        const preserveModel = changedFields !== undefined && !changedFields.includes('foreground')
            && conversationAccessSettings(this.config(mode).settings) === conversationAccessSettings(settings);
        this.configurationOwners.add(owner);
        const signal = owner.controller.signal;
        // The latest explicit save owns this mode's next selection. A reopened
        // settings form can retain the prior view while an earlier connection
        // is still opening; that display revision must not reject the new choice.
        const priorCommand = this.settingsCommands.get(commandId);
        const admitted = (async () => {
            if (priorCommand) await priorCommand;
            signal.throwIfAborted();
            // A model selection already submitted for this destination retains
            // its queue position when this form only edits other fields.
            for (const prior of predecessors) if (prior.kind !== 'foreground-model' || !preserveModel) prior.controller.abort();
        })();
        void admitted.catch(() => {});
        const operation = this.serialMode(mode, async releaseConversation => {
            await admitted;
            let finishAccessTransition: (() => void) | undefined;
            try {
            this.assertOpen(); signal.throwIfAborted();
            if (this.moveError(mode, settings)) throw this.moveError(mode, settings);
            const persisted = await this.storage.get<Saved>('framework-settings/' + mode);
            const previous = persisted ?? this.config(mode);
            // A prior model or settings save may have committed after the form
            // was opened. Untouched fields come from that durable selection.
            settings = applyChanges(previous.settings);
            if (this.moveError(mode, settings)) throw this.moveError(mode, settings);
            const selected = isDeepStrictEqual(omitAbsentFields(previous.settings), omitAbsentFields(settings));
            this.saved.set(mode, previous);
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
            const executionSettings = (value: FrameworkClientSettings, workspace = value.workspace) => JSON.stringify([
                mode === 'local' ? [value.localDirectory] : [value.ownerRepo, value.repositoryDirectory],
                value.collaborationId, workspace, value.presetId, value.foreground]);
            const requestedWorkspace = settings.workspace.trim();
            // Reuse this runtime's already resolved root for equivalent explicit
            // path spelling only; this comparison performs no new acquisition.
            const workspace = running && isAbsolute(requestedWorkspace) && resolve(requestedWorkspace) === running.runtime.config.workspace
                ? running.workspaceSelection : settings.workspace;
            const hot = !!running && executionSettings(previous.settings) === executionSettings(settings, previous.settings.workspace);
            const selectedWorkspace = hot && workspace !== running!.workspaceSelection
                ? await new DshWorkspaceAdapter(this.ctx).resolve(undefined, settings.workspace || undefined) : undefined;
            if (selectedWorkspace && selectedWorkspace.directory !== running!.runtime.config.workspace) await running!.runtime.prepareWorkspaceSelection();
            signal.throwIfAborted();
            if (running && !hot) {
                try { await this.stopRunning(running, signal); }
                catch (error) { if (mode === 'git' && this.running.get(mode) === running) this.running.delete(mode); throw error; }
                this.running.delete(mode);
            }
            if (conversationAccessSettings(previous.settings) !== conversationAccessSettings(settings)) {
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
            if (!persisted || !selected) await this.persistSettings(mode, { revision: randomUUID(), settings });
            if (hot && running) {
                if (selectedWorkspace) running.runtime.setWorkspace(selectedWorkspace.directory);
                running.workspaceSelection = settings.workspace;
                running.runtime.setBackgroundModel(this.config(mode).settings.background);
            }
            finishAccessTransition?.(); finishAccessTransition = undefined;
            // New storage selection is published. Registration, heartbeat and
            // native startup do not own conversation persistence.
            releaseConversation();
            signal.throwIfAborted();
            await this.storage.set('framework-participation/' + mode, true);
            signal.throwIfAborted();
            const cancelUpdate = () => running?.connection.cancelPending(signal.reason);
            // Unchanged seats on this already registered Git connection are
            // not another publication. Unfinished configuration still follows
            // its original registration/recovery path; ordinary Host heartbeat
            // and resource observation continue independently.
            const updateRegistration = hot && running && (mode !== 'git' && !backgroundOnly || predecessors.length > 0
                || this.configurationErrors.has(mode) || previous.settings.workerSeats !== settings.workerSeats
                || running.connection.registration.workerSeats !== settings.workerSeats);
            if (updateRegistration) signal.addEventListener('abort', cancelUpdate, { once: true });
            try {
                if (hot && running) {
                    if (updateRegistration) {
                        const registration = await running.connection.updateWorkerSeats(settings.workerSeats);
                        signal.throwIfAborted();
                        running.runtime.updateWorkerSeats(registration.workerSeats);
                        running.resources = await running.connection.members();
                    }
                } else await this.connect(mode, signal);
                this.assertOpen(); signal.throwIfAborted();
                if (mode === 'git')
                    await this.storage.set('framework-git-enabled', true);
                this.clearResolvedErrors(mode, commandId);
                if (mode === 'git') this.prepareGit();
                const priorError = this.configurationErrors.get(mode);
                const messages = this.reportedErrors.get(mode);
                if (priorError && !messages?.get(priorError)?.operationId) { messages?.delete(priorError); this.configurationErrors.delete(mode); this.refreshErrors(mode); }
            }
            catch (error) {
                if (!abortedBy(signal, error)) {
                    this.configurationErrors.set(mode, this.report(mode, error, this.diagnosticScope(mode, settings), commandId));
                }
                throw error;
            }
            finally { signal.removeEventListener('abort', cancelUpdate); }
            this.changed();
            // The current configuration and native connection are ready. Panel
            // refresh owns its own read and must not retain this settings lane
            // or turn a successful write into an unconfirmed configuration.
            return this.settingsView(mode);
            } finally { finishAccessTransition?.(); }
        }, commandId, conversationBarrier);
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
            return this.foreground(access, async () => {
                const index = await withSnapshot(access.connection.files, snapshot => readJson<{ migrations: Array<{ id: string; manifestPath: string }> }>(access.connection.files, snapshot, 'technical/legacy-migrations/index.json'));
                const migration = index?.migrations.find(row => row.id === input.migrationId);
                if (!migration) throw new Error('Original migration record does not exist in this storage scope.');
                const member = this.running.get(input.mode)?.connection.registration.member ?? (await this.observe(access, input.mode)).find(row => row.instanceUUID === access.connection.identity.instanceUUID)?.member;
                if (!member) throw new Error('Original instance identity cannot be located for this legacy task.');
                const target = { manifestPath: migration.manifestPath, oldTaskId: input.oldTaskId, member };
                await access.connection.prepareWrite();
                const sources = access.connection.files instanceof PhysicalLocalFiles
                    ? physicalControlSignalSources(access.connection.records, access.connection.scope, member, input.mode === 'local' ? this.config(input.mode).settings.collaborationId : undefined) : undefined;
                if (input.action === 'resume') await resumeLegacyTask(access.connection.files, access.connection.transactions, input.commandId, target, sources);
                else if (input.action === 'answer') await answerLegacyTask(access.connection.files, access.connection.transactions, input.commandId, { ...target, waitId: z.string().min(1).parse(input.waitId), answer: z.string().parse(input.answer) }, sources);
                else throw new Error('Unknown legacy control action.');
                this.changed();
                return this.view({ mode: input.mode, panelsOnly: true }, undefined, 'foreground-read');
            });
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
        const owner: ConfigurationOwner | undefined = enabled || mode === 'git' ? { mode, controller: new AbortController() } : undefined;
        if (owner) this.configurationOwners.add(owner);
        const operation = this.serialMode(mode, async () => {
            this.assertOpen(); owner?.controller.signal.throwIfAborted();
            await this.storage.set('framework-participation/' + mode, enabled);
            owner?.controller.signal.throwIfAborted();
            if(enabled) await this.connect(mode, owner!.controller.signal);
            else { const running = this.running.get(mode); if(running) { try { await this.stopRunning(running, owner?.controller.signal); } finally { this.running.delete(mode); } } }
            this.changed(); return this.settingsView(mode);
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
        return this.view({ mode, headerOnly: input.headerOnly, panelsOnly: true }, undefined, 'foreground-read');
    }
    private async readFileBytes(files: FilesStore, snapshot: FilesSnapshot, path: string, originalTaskId?: string): Promise<Uint8Array | undefined> {
        const reference = parseTaskReference(path);
        if (reference) {
            const task = await readTaskReferenceIdentity(files, snapshot, reference.taskId);
            if (!task || task.taskId !== reference.taskId) return undefined;
            const resolved = await resolveTaskRequirementReference(files, snapshot, task, reference.original);
            const bytes = resolved ? await files.readBytes(snapshot, resolved) : undefined;
            if (bytes !== undefined || task.archiveFolder) return bytes;
            const historical = await resolveTaskRequirementReference(files, snapshot, task, reference.original, true);
            return historical ? files.readBytes(snapshot, historical) : undefined;
        }
        const bytes = await files.readBytes(snapshot, path);
        if (bytes !== undefined) return bytes;
        if (originalTaskId && files instanceof PhysicalLocalFiles) {
            const original = await pendingLocalTaskResult(files.directory, this.storage, originalTaskId, path);
            if (original !== undefined) return original;
        }
        const taskId = referenceTaskId(path);
        return taskId ? await readPublishedReference(files, snapshot, taskId, path) ?? await readArchivedReference(files, snapshot, taskId, path)
            ?? await readPublishedReference(files, snapshot, taskId, path, true) ?? await readArchivedReference(files, snapshot, taskId, path, true) : undefined;
    }
    private async physicalMaterial(active: Access, mode: FrameworkMode, reference: PhysicalWorkspaceReference) {
        if (!isPhysicalWorkspaceReference(reference) || reference.instanceUUID !== active.connection.identity.instanceUUID)
            throw new Error('This material belongs to another Host instance. Open the original physical path on its source Host.');
        const files = this.ctx.fs, mapped = files.processPathFromHostPath(reference.path);
        if (mapped === undefined) throw new Error('This Host filesystem cannot map the selected original path.');
        const target = await files.resolve(mapped);
        if (files.processPath(target) !== reference.path) throw new Error('The exact physical result path changed; inspect the original before opening it.');
        const before = await files.stat(target);
        if (!before || before.type !== 'file') throw new Error('Workspace material must be a regular file.');
        // The filesystem requires an inclusive byte bound. Keep whole-file reads
        // within the numeric API range, without adding a product size limit.
        const data = await files.readBytes(target, undefined, Number.MAX_SAFE_INTEGER), after = await files.stat(target);
        if (!after || after.type !== 'file' || before.version !== after.version
            || before.size !== undefined && before.size !== data.byteLength || after.size !== undefined && after.size !== data.byteLength)
            throw new Error('Workspace material changed while reading; open the current file again.');
        if (files.processPath(await files.resolve(mapped)) !== reference.path)
            throw new Error('Workspace material path changed while reading.');
        return { data, nativePath: reference.path, sha256: createHash('sha256').update(data).digest('hex') };
    }
    async openWorkspaceFile(input: Parameters<NonNullable<FrameworkClientApi['openWorkspaceFile']>>[0], signal = new AbortController().signal) {
        signal.throwIfAborted();
        const active = await this.access(input.mode);
        this.checkScope(active, input.storageScope);
        return this.foreground(active, async () => {
            if (input.path !== input.reference?.path) throw new Error('Physical material path does not match its source reference.');
            if (!isPhysicalWorkspaceReference(input.reference) || input.reference.instanceUUID !== active.connection.identity.instanceUUID)
                throw new Error('This material belongs to another Host instance. Open the original physical path on its source Host.');
            const path = input.reference.path;
            const controller = this.ctx.get('sessionController');
            if (!controller?.canOpenWorkspacePath()) throw new Error('This Host cannot open local files. Path: ' + path);
            await controller.openWorkspacePath({ path }, signal);
            return { path };
        });
    }
    async readFile(input: Parameters<FrameworkClientApi['readFile']>[0]) {
        const active = await this.access(input.mode);
        this.checkScope(active, input.storageScope);
        return this.foreground(active, async () => {
            if (!input.reference && isConversationAttachmentPath(input.path)) return withSnapshot(active.connection.files, async snapshot => {
                const reference = await active.conversation.attachments.referenceAtPath(snapshot, input.path);
                const downloadUrl = '/api/deepseek-servant-framework/attachment?' + new URLSearchParams({ mode: input.mode,
                    collaborationId: active.conversation.scope.collaborationId, storageScope: active.connection.scope, reference: JSON.stringify(reference) });
                return { path: input.path, revision: snapshot.revision, binary: { bytes: reference.bytes, sha256: reference.sha256, downloadUrl } };
            });

            if (input.reference) {
                if (input.path !== input.reference.path) throw new Error('Physical material path does not match its source reference.');
                const material = await this.physicalMaterial(active, input.mode, input.reference);
                const downloadUrl = '/api/deepseek-servant-framework/download?mode=' + input.mode + '&path=' + encodeURIComponent(input.path) + '&storageScope=' + encodeURIComponent(active.connection.scope) + '&reference=' + encodeURIComponent(JSON.stringify(input.reference));
                const revision = 'workspace:' + material.sha256;
                try {
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(material.data);
                    if (text.includes('\0')) throw new TypeError('Binary workspace material.');
                    return { path: material.nativePath, nativePath: material.nativePath, downloadUrl, text, revision };
                } catch (error) {
                    if (!(error instanceof TypeError)) throw error;
                    return { path: material.nativePath, nativePath: material.nativePath, revision, binary: { bytes: material.data.byteLength, sha256: material.sha256, downloadUrl } };
                }
            }
            const downloadUrl = '/api/deepseek-servant-framework/download?mode=' + input.mode + '&path=' + encodeURIComponent(input.path) + '&storageScope=' + encodeURIComponent(active.connection.scope) + (input.mode === 'local' && input.originalTaskId ? '&originalTaskId=' + encodeURIComponent(input.originalTaskId) : '');
            return withSnapshot(active.connection.files, async (snapshot) => {
                const bytes = await this.readFileBytes(active.connection.files, snapshot, input.path, input.mode === 'local' ? input.originalTaskId : undefined);
                if (bytes === undefined) throw new Error('File does not exist.');
                try {
                    return { path: input.path, downloadUrl, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), revision: snapshot.revision };
                } catch {
                    return { path: input.path, revision: snapshot.revision, binary: { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), downloadUrl } };
                }
        });
        });
    }
    async download(mode: FrameworkMode, path: string, storageScope?: string, reference?: PhysicalWorkspaceReference, originalTaskId?: string): Promise<Uint8Array> {
        const active = await this.access(mode);
        this.checkScope(active, storageScope);
        return this.foreground(active, async () => {
            if (reference) {
                if (path !== reference.path) throw new Error('Physical material path does not match its source reference.');
                return (await this.physicalMaterial(active, mode, reference)).data;
            }
            return withSnapshot(active.connection.files, async snapshot => {
                const bytes = await this.readFileBytes(active.connection.files, snapshot, path, mode === 'local' ? originalTaskId : undefined);
                if (bytes === undefined) throw new Error('File does not exist.');
                return bytes;
        });
        });
    }
    private readonly gitUpgrades = new Map<Running, { controller: AbortController; work: Promise<unknown>; agent: GitStartupUpgrade }>();
    private startGitUpgrade(active: Running, workspace: string, settings: FrameworkClientSettings): void {
        if (this.gitUpgrades.has(active)) return;
        const controller = new AbortController();
        const agent = new GitStartupUpgrade(this.ctx, active.connection.files, active.connection.transactions,
            { hostModuleURL: this.hostModuleURL, cwd: workspace, presetId: settings.presetId, model: settings.background,
                changed: () => { active.runtime.refreshSkills(); this.changed(); } });
        // Defer execution until this synchronous activation publishes ownership.
        // Neither Host open nor a normal role/task awaits the upgrade.
        const work = Promise.resolve().then(() => agent.start(controller.signal)).then(result => {
            if (result === 'not-needed' && this.gitUpgrades.get(active)?.agent === agent) this.gitUpgrades.delete(active);
            if (result === 'converted-native-pending') this.report('git', new Error('Git skill conversion is complete. The startup file retains unconfirmed native session responsibility. This status does not establish a current Host handle or Cleaner journal acceptance.'), active.connection.scope);
            if (result === 'pending') this.report('git', new Error('The one-time Git skill upgrade remains pending; its deployed wake and remaining originals were retained.'), active.connection.scope);
        }).catch(error => { if (!abortedBy(controller.signal, error)) this.report('git', error, active.connection.scope); });
        this.gitUpgrades.set(active, { controller, work, agent });
    }
    private async stopManualCleanup(active: Running): Promise<void> {
        const cleanup = active.manualCleanup;
        if (!cleanup) return;
        cleanup.controller.abort();
        // Finish only the admitted file operation. The original intent remains
        // discoverable if later selected files have not been processed.
        await cleanup.work;
    }
    private stopRunning(active: Running, signal?: AbortSignal): Promise<void> {
        const follow = (owner: { promise: Promise<void>; controller: AbortController }) => {
            const abort = () => owner.controller.abort(signal!.reason);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            void owner.promise.finally(() => signal?.removeEventListener('abort', abort)).catch(() => {});
            return owner.promise;
        };
        const prior = this.stopping.get(active);
        if (prior) return follow(prior);
        const controller = new AbortController();
        const operation = (async () => {
            const failures: unknown[] = [];
            const upgrade = this.gitUpgrades.get(active);
            upgrade?.controller.abort();
            try { await upgrade?.work; } catch (error) { this.report('git', error, active.connection.scope); }
            let retainUpgrade = false;
            if (upgrade) {
                try {
                    const native = await upgrade.agent.retryNativeRetirement();
                    if (native && (native.retirement !== 'fulfilled' || native.close !== 'closed')) {
                        retainUpgrade = true;
                        this.report('git', new Error('Native upgrade cleanup is still pending for exact session ' + native.sessionId), active.connection.scope);
                    }
                } catch (error) { retainUpgrade = true; this.report('git', error, active.connection.scope); }
            }
            // Releasing Running is independent of this exact native obligation.
            // Keep unresolved owners in this existing service map; no timer,
            // file scan or cross-restart persistence is implied by that retention.
            if (!retainUpgrade) this.gitUpgrades.delete(active);
            try { await this.stopManualCleanup(active); } catch (error) { failures.push(error); }
            try { await active.runtime.dispose(); } catch (error) { failures.push(error); }
            try { await active.connection.close(controller.signal); } catch (error) { failures.push(error); }
            if (failures.length === 1) throw failures[0];
            if (failures.length) throw new AggregateError(failures, 'Runtime and connection disposal failed.');
        })();
        const owner = { promise: operation, controller };
        this.stopping.set(active, owner);
        return follow(owner);
    }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        this.closed = true;
        this.recordMoveController?.abort();
        for (const owner of this.localUpgrades.values()) owner.controller.abort();
        for (const owner of this.configurationOwners) owner.controller.abort();
        for (const controller of [...this.accessOpening.values(), ...this.backgroundOpening.values()]) controller.abort();
        // Pending acquisitions remain owned until they settle. Their publication
        // guards close late resources instead of allowing a post-dispose Host.
        const accesses = [...this.accesses.values()];
        this.disposal = (async () => {
            // Start each owned shutdown before waiting for configuration: a hot
            // update may itself be waiting on this connection's HTTP request.
            const stopping = [...this.running].map(([mode, active]) => {
                // Disposal supersedes an already owned close, including its
                // final stopped I/O. A first close still makes its normal hint.
                this.stopping.get(active)?.controller.abort(new DOMException('Framework service is disposing an already closing runtime.', 'AbortError'));
                return this.stopRunning(active).catch(error => this.cleanupFailure(mode, error));
            });
            const cancellingAccess = accesses.map(pending => pending.then(access => {
                try { access.connection.cancelPending(); } catch (error) { this.disposalErrors.push(error); }
            }, () => {}));
            await Promise.allSettled([...this.localUpgrades.values()].map(owner => owner.work));
            this.localUpgrades.clear();
            await Promise.allSettled([this.initializing, this.starting, ...this.modeConfiguration.values(), ...this.modeSending.values()]);
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
