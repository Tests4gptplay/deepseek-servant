import { paths, readJson, taskLifecycle, type TaskMetadata } from './task-files.js'
import { readTaskArchiveState, taskArchiveCleanup, taskArchiveHostFacts } from './task-archive.js'
import { taskCommandReceiptPath, taskCommandReceiptOwner, type TaskCommandOwner } from './task-command-paths.js'
import { observeFileReads } from './file-read-observation.js'
import type { GitReadDependencies } from '../experimental/private-git/contracts.js'
import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { FilesConflictError, FilesOutcomeUnknownError, GitFiles, withWriteOperation, withReadOperation, withSnapshot, type FileChange, type FileReadPlan, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'

interface CommandRecord {
  id: string
  requestHash: string
  receipt?: FileReceipt
  /** New pending-only input journal; older records are not swept or rewritten. */
  transient?: true
  taskOwner?: TaskCommandOwner
  inputs?: { reads: Array<[string, string]>; targets: string }
}
export interface CommandOptions {
  /** Internal existing terminal/deletion fact, never an added acknowledgement. */
  completionProof?: (snapshot: FilesSnapshot) => Promise<boolean>
  /** Exact validated execution/Task owner, never inferred from business arguments. */
  taskOwner?: TaskCommandOwner
  /** Live, non-Git ownership/cancellation guard; no business rebuilding. */
  beforeAttempt?: () => void | Promise<void>
  /** Known business predicates share the command's original snapshot. */
  readPlan?: FileReadPlan
  /** Caller explicitly requests a fresh business evaluation after a proven conflict. */
  reevaluate?: boolean
  /** AI-authored effects may retry unrelated contention, not changed assessed inputs. */
  preserveInputs?: boolean
  /** Merge derived state from the final business changes at the SAME snapshot,
   * outside only the assessed-input observer. Its real reads/write targets stay
   * inside the existing dependency capture and atomic publication, so a proven
   * conflict rebuilds the merge instead of publishing a stale shared index. */
  deriveChanges?: (snapshot: FilesSnapshot, businessChanges: readonly FileChange[]) => Promise<readonly FileChange[]>
  /** Internal acquisition only: an empty Git build observes an already-present
   * target, without completing a replayable command. Local keeps its journal. */
  gitEmptyResult?: 'observation-only'
}
export class CommandCleanupFailure extends Error {
  constructor(readonly commandId: string, readonly key: string, cause: unknown) {
    super('Command ' + commandId + ' committed successfully, but its temporary input journal could not be removed. Cleanup remains incomplete.', { cause })
    this.name = 'CommandCleanupFailure'
  }
}
export interface FrameworkTransactionDiagnostics {
  /** Cleanup warnings are separate from a command's confirmed business result. */
  onCleanupFailure?: (failure: CommandCleanupFailure) => void
}
export class TaskCommandRetiredError extends Error {
  constructor(readonly owner: TaskCommandOwner) {
    super('This Task lifecycle has released its command namespace. The command was not executed again.')
    this.name = 'TaskCommandRetiredError'
  }
}
export class CommandInputsChangedError extends Error {
  constructor() { super('Business material or write targets changed during contention; read and evaluate the changed facts before submitting again.'); this.name = 'CommandInputsChangedError' }
}
export type CommandBuilder = (snapshot: FilesSnapshot) => Promise<readonly FileChange[]>
/** Owned by exactly one run callback, never a session cache or caller option. */
interface GitRecoveryRound { snapshot?: FilesSnapshot }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const sameOwner = (a: TaskCommandOwner | undefined, b: TaskCommandOwner | undefined) => JSON.stringify(a && [a.taskId, taskLifecycle(a), a.hostKey]) === JSON.stringify(b && [b.taskId, taskLifecycle(b), b.hostKey])
// The existing accepted promises, shared only by handles of this same record owner.
const taskPending = new WeakMap<StoragePort, Set<{ owner: TaskCommandOwner; promise: Promise<FileReceipt> }>>()
// Same-connection handles share only still-unresolved native operations.
const taskAttemptHandles = new WeakMap<StoragePort, Set<FrameworkTransactions>>()

/** Stable commands retain their replay identity beside the committed effects.
 * Local input journals live only until confirmation; Git has no local history. */
export class FrameworkTransactions {
  private readonly pending = new Map<string, { hash: string; owner?: TaskCommandOwner; promise: Promise<FileReceipt> }>()
  private readonly prefix: string
  private readonly taskPrefix: string
  private gitClosed = false
  private gitCloseReason: unknown
  private gitClosing?: Promise<void>
  private readonly gitAttempts = new Map<string, { owner?: TaskCommandOwner; hash: string; operationId: string; expectedRevision: string; path: string; content: string; changes: FileChange[]; reads: GitReadDependencies }>()
  private readonly gitInputGuards = new Map<string, { owner?: TaskCommandOwner; hash: string; reads: Map<string, string>; targets: string }>()
  constructor(readonly files: FilesStore, private readonly records: StoragePort, scope: string, private readonly diagnostics: FrameworkTransactionDiagnostics = {}) {
    this.prefix = 'framework-commands/' + hash(scope) + '/'
    this.taskPrefix = 'framework-task-commands/' + hash(scope) + '/'
  }
  /** Read only a persisted acknowledgement or atomic receipt. This does not
   * replay a builder or resolve an unconfirmed transport operation. */
  async confirmed(id: string, request: unknown, taskOwner?: TaskCommandOwner): Promise<FileReceipt | undefined> {
    const requestHash = hash(JSON.stringify(request)), active = this.pending.get(id);
    if (active && (active.hash !== requestHash || !sameOwner(active.owner, taskOwner))) throw new Error('A native command identity cannot be reused with different arguments.');
    if (this.files instanceof GitFiles) return this.gitConfirmed(id, requestHash, this.receiptPath(id, taskOwner));
    const record = await this.records.get<CommandRecord>(this.commandKey(id, taskOwner));
    if (record && (record.requestHash !== requestHash || !sameOwner(record.taskOwner, taskOwner))) throw new Error('A native command identity cannot be reused with different arguments.');
    if (record?.receipt) return { ...record.receipt };
    // Local COMMIT owns this receipt independently of its disposable input
    // journal. Read it without replaying the command builder.
    return withSnapshot(this.files, async snapshot => {
      const raw = await this.readCommandReceipt(snapshot, id, this.receiptPath(id, taskOwner))
      if (raw === undefined) return
      const saved = JSON.parse(raw) as { requestHash: string }
      if (saved.requestHash !== requestHash) throw new Error('Stored command receipt does not match its arguments.')
      return { revision: snapshot.revision, replay: true }
    });
  }
  /** Read an existing receipt without replaying or acknowledging a command. */
  committedReceipt(id: string, request: unknown, taskOwner?: TaskCommandOwner): Promise<FileReceipt | undefined> {
    return this.confirmed(id, request, taskOwner)
  }
  /** Use an already-owned Host observation for this attempt. Actual file
   * dependencies still govern publication; no whole-revision business gate.
   * The caller retains/releases the lease. Related changes wait for its next poll. */
  runObserved(id: string, request: unknown, snapshot: FilesSnapshot, build: CommandBuilder): Promise<FileReceipt> {
    return this.runOwned(id, request, {}, build, snapshot)
  }
  /** Final deletion is confirmed by its existing authoritative state/inventory,
   * so it must not write a fresh ordinary receipt into the retired namespace. */
  runObservedFinalization(id: string, request: unknown, snapshot: FilesSnapshot, build: CommandBuilder,
    completionProof: (snapshot: FilesSnapshot) => Promise<boolean>): Promise<FileReceipt> {
    return this.runOwned(id, request, { completionProof }, build, snapshot)
  }
  runFinalization(id: string, request: unknown, options: Omit<CommandOptions, 'taskOwner' | 'completionProof'>,
    build: CommandBuilder, completionProof: (snapshot: FilesSnapshot) => Promise<boolean>): Promise<FileReceipt> {
    return this.runOwned(id, request, { ...options, completionProof }, build)
  }
  run(id: string, request: unknown, options: CommandOptions, build: CommandBuilder): Promise<FileReceipt> {
    return this.runOwned(id, request, options, build)
  }
  private runOwned(id: string, request: unknown, options: CommandOptions, build: CommandBuilder, observed?: FilesSnapshot): Promise<FileReceipt> {
    if (this.files instanceof GitFiles && this.gitClosed) return Promise.reject(this.gitCloseReason)
    options = { ...options, ...(options.taskOwner ? { taskOwner: structuredClone(options.taskOwner) } : {}) }
    const requestHash = hash(JSON.stringify(request))
    const active = this.pending.get(id)
    if (active) return active.hash === requestHash && sameOwner(active.owner, options.taskOwner) ? active.promise : Promise.reject(new Error('A native command identity cannot be reused with different arguments.'))
    const operation = withWriteOperation(this.files, () => this.executeWithContentionRetry(id, requestHash, options, build, observed)).then(receipt => {
      this.gitInputGuards.delete(id); this.releaseGitHandleIfIdle()
      return receipt
    })
    this.pending.set(id, { hash: requestHash, owner: options.taskOwner, promise: operation })
    if (options.taskOwner) {
      const accepted = taskPending.get(this.records) ?? new Set(), own = { owner: options.taskOwner, promise: operation }
      accepted.add(own); taskPending.set(this.records, accepted)
      void operation.finally(() => { accepted.delete(own) }).catch(() => {})
    }
    void operation.finally(() => { if (this.pending.get(id)?.promise === operation) this.pending.delete(id) }).catch(() => {})
    return operation
  }
  private async executeWithContentionRetry(id: string, requestHash: string, options: CommandOptions, build: CommandBuilder, observed?: FilesSnapshot): Promise<FileReceipt> {
    // Related-content changes require explicit fresh business evaluation.
    // Unrelated writes may reuse the existing dependency-checked publication.
    const retryable = options.reevaluate
    const savedInputs = options.preserveInputs && this.files instanceof GitFiles ? this.gitInputGuards.get(id) : undefined
    if (savedInputs && (savedInputs.hash !== requestHash || !sameOwner(savedInputs.owner, options.taskOwner))) throw new Error('A native command identity cannot be reused with different arguments.')
    const localRecord = options.preserveInputs && !(this.files instanceof GitFiles) ? await this.records.get<CommandRecord>(this.commandKey(id, options.taskOwner)) : undefined
    let firstReads: Map<string, string> | undefined = savedInputs?.reads ?? (localRecord?.inputs ? new Map(localRecord.inputs.reads) : undefined), firstTargets: string | undefined = savedInputs?.targets ?? localRecord?.inputs?.targets
    const checkedBuild: CommandBuilder = options.preserveInputs ? snapshot => {
      const reads = new Map<string, string>(), recheckedTargets = new Set<string>()
      return observeFileReads(snapshot, (key, fingerprint) => {
        if (firstReads && firstReads.get(key) !== fingerprint) throw new CommandInputsChangedError()
        reads.set(key, fingerprint)
      }, async () => {
        const changes = await build(snapshot)
        const targets = JSON.stringify([...new Set(changes.map(change => change.path))].sort())
        if (firstTargets !== undefined && targets !== firstTargets) throw new CommandInputsChangedError()
        firstTargets ??= targets
        // Compare exact write targets too, including a previously absent file.
        // Reuse builder observations; never scan unrelated content.
        for (const change of changes) if (!reads.has('file:' + change.path) && !recheckedTargets.has(change.path)) await this.files.readBytes(snapshot, change.path)
        if (firstReads && firstReads.size !== reads.size) throw new CommandInputsChangedError()
        firstReads ??= reads
        return changes
      }, path => recheckedTargets.add(path))
    } : build
    // A derived index merges current shared state, not newly assessed material.
    // executeGit captures both phases; Local records their reads at this same
    // snapshot. An explicit material read of that index stays protected above.
    const deriveChanges = options.deriveChanges
    const attemptBuild: CommandBuilder = options.preserveInputs || deriveChanges ? async snapshot => {
      const changes = await checkedBuild(snapshot)
      const derived = deriveChanges ? await deriveChanges(snapshot, changes) : []
      // Retain input guards only after the complete build succeeds, as before.
      if (options.preserveInputs) {
        if (this.files instanceof GitFiles && !this.gitInputGuards.has(id)) {
          this.gitInputGuards.set(id, { owner: options.taskOwner, hash: requestHash, reads: new Map(firstReads!), targets: firstTargets! })
          if (options.taskOwner) this.retainGitHandle()
        }
        if (!(this.files instanceof GitFiles)) {
          const key = this.commandKey(id, options.taskOwner), record = await this.records.get<CommandRecord>(key)
          if (record || options.taskOwner && (changes.length || derived.length)) await this.records.set(key, {
            ...(record ?? { id, requestHash, transient: true, taskOwner: options.taskOwner }),
            inputs: { reads: [...firstReads!], targets: firstTargets! }
          })
        }
      }
      return derived.length ? [...changes, ...derived] : changes
    } : checkedBuild
    // A session-only operation store can retire the proven conflict immediately.
    // Durable/custom stores without release retain their existing resolution path.
    const recovery: GitRecoveryRound | undefined = this.files instanceof GitFiles ? {} : undefined
    try {
      for (let retry = 0; ; retry++) {
        options.readPlan?.signal?.throwIfAborted()
        try { return await this.execute(id, requestHash, options, attemptBuild, recovery, observed) } catch (error) {
          if (!retryable || !(error instanceof FilesConflictError)) throw error
          if (this.files instanceof GitFiles) this.assertGitOpen()
          const delay = Math.min(160, 5 * 2 ** retry)
          await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * delay)))
        }
      }
    } finally { await recovery?.snapshot?.release() }
  }
  /** Seal before connection I/O cancellation, then drain only our accepted
   * commands. Their caller retains the original failure; UNKNOWN is not success. */
  closeGitSession(reason: unknown): Promise<void> {
    if (!(this.files instanceof GitFiles)) return Promise.resolve()
    if (this.gitClosing) return this.gitClosing
    this.gitClosed = true; this.gitCloseReason = reason
    this.clearSessionCache()
    return this.gitClosing = (async () => {
      try {
        const results = await Promise.allSettled([...this.pending.values()].map(item => item.promise))
        const errors = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map(item => item.reason).filter(error => error !== reason)
        if (errors.length) throw new AggregateError(errors, 'Git commands did not settle cleanly while closing.')
      } finally { this.clearSessionCache() }
    })()
  }
  private assertGitOpen(): void { if (this.gitClosed) throw this.gitCloseReason }
  /** Shutdown releases volatile attempts; accepted calls drain before final release. */
  clearSessionCache(): void { this.gitAttempts.clear(); this.gitInputGuards.clear(); taskAttemptHandles.get(this.records)?.delete(this) }
  private retainGitAttempt(id: string, attempt: NonNullable<ReturnType<typeof this.gitAttempts.get>>): void {
    this.gitAttempts.set(id, attempt)
    if (attempt.owner) this.retainGitHandle()
  }
  private releaseGitAttempt(id: string): void {
    this.gitAttempts.delete(id)
    this.releaseGitHandleIfIdle()
  }
  private retainGitHandle(): void { const handles = taskAttemptHandles.get(this.records) ?? new Set(); handles.add(this); taskAttemptHandles.set(this.records, handles) }
  private releaseGitHandleIfIdle(): void {
    if (![...this.gitAttempts.values(), ...this.gitInputGuards.values()].some(entry => entry.owner)) taskAttemptHandles.get(this.records)?.delete(this)
  }
  private gitReceiptPath(id: string): string { return 'technical/command-receipts/' + hash(id) + '.json' }
  private receiptPath(id: string, owner?: TaskCommandOwner): string { return owner ? taskCommandReceiptPath(owner, id) : this.files instanceof GitFiles ? this.gitReceiptPath(id) : 'technical/transaction-receipts/' + hash(id) + '.json' }
  private ownerPrefix(owner: TaskCommandOwner): string { taskCommandReceiptPath(owner, ''); return this.taskPrefix + owner.taskId + '/' + hash(taskLifecycle(owner)) + '/' + hash(owner.hostKey) + '/' }
  private commandKey(id: string, owner?: TaskCommandOwner): string { return (owner ? this.ownerPrefix(owner) : this.prefix) + hash(id) }
  private async readCommandReceipt(snapshot: FilesSnapshot, id: string, path: string): Promise<string | undefined> {
    const owner = taskCommandReceiptOwner(path)
    if (!owner) return this.files.read(snapshot, path)
    // One native command remains one command if another Host retries it. The
    // exact basename predicate records absence/new matching owners without
    // turning unrelated command files into a whole-Task contention gate.
    const root = paths.run(owner.taskId) + '/.command-receipts/' + owner.lifecycleHash
    const rows = (await this.files.list(snapshot, root, { names: [hash(id) + '.json'] })).filter(row => {
      const found = taskCommandReceiptOwner(row.path)
      return found?.taskId === owner.taskId && found.lifecycleHash === owner.lifecycleHash
    })
    if (rows.length > 1) throw new Error('A Task command has more than one original Host receipt.')
    if (!rows.length) {
      // Exact old command identity only. Do not scan, migrate or rewrite old
      // receipts when a caller from this version supplies explicit ownership.
      return this.files.read(snapshot, this.receiptPath(id))
    }
    const selected = rows[0]!.path, raw = await this.files.read(snapshot, selected)
    if (raw === undefined) throw new Error('Task command receipt disappeared from its immutable snapshot.')
    const value = JSON.parse(raw) as { taskOwner?: TaskCommandOwner; id?: string }
    if (!value.taskOwner || value.id !== id || taskCommandReceiptPath(value.taskOwner, id) !== selected) throw new Error('Task command receipt content differs from its original Host.')
    return raw
  }
  private async assertTaskCommandOpen(snapshot: FilesSnapshot, owner: TaskCommandOwner | undefined): Promise<void> {
    if (!owner) return
    const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(owner.taskId))
    if (!task || task.taskId !== owner.taskId || taskLifecycle(task) !== taskLifecycle(owner)) throw new TaskCommandRetiredError(owner)
    const state = await readTaskArchiveState(this.files, snapshot, task), host = taskArchiveHostFacts(state, owner, owner.hostKey)
    if (taskArchiveCleanup(state, owner) || host?.runtimeReleased || host?.released) throw new TaskCommandRetiredError(owner)
  }
  private async readGitReceipt(snapshot: FilesSnapshot, id: string, requestHash: string, path = this.gitReceiptPath(id)): Promise<FileReceipt | undefined> {
    const raw = await this.readCommandReceipt(snapshot, id, path)
    if (raw === undefined) return
    const record = JSON.parse(raw) as { version?: number; id?: string; requestHash?: string }
    if (record.version !== 1 || record.id !== id || record.requestHash !== requestHash) throw new Error('A native command identity cannot be reused with different arguments.')
    return { revision: snapshot.revision, replay: true }
  }
  private async gitConfirmed(id: string, requestHash: string, path = this.gitReceiptPath(id)): Promise<FileReceipt | undefined> {
    this.assertGitOpen()
    const snapshot = await this.files.snapshot({ files: [path] })
    try { return await this.readGitReceipt(snapshot, id, requestHash, path) } finally { await snapshot.release() }
  }
  /** Git owns the command result in the SAME commit as its business effects.
   * There is no local durable id mapping, nor a recursively journalled set. */
  private async executeGit(id: string, requestHash: string, options: CommandOptions, build: CommandBuilder, recovery?: GitRecoveryRound, observed?: FilesSnapshot): Promise<FileReceipt> {
    this.assertGitOpen()
    const commandHash = hash(id), path = this.receiptPath(id, options.taskOwner)
    const git = this.files as GitFiles
    let attempt = this.gitAttempts.get(id)
    if (attempt) {
      if (attempt.hash !== requestHash || !sameOwner(attempt.owner, options.taskOwner)) throw new Error('A native command identity cannot be reused with different arguments.')
      const resolution = await git.resolve(attempt.operationId)
      if (resolution.status === 'confirmed') {
        const receipt: FileReceipt = { revision: resolution.commit, replay: true, operationId: attempt.operationId }
        if (resolution.verifiedWrites) Object.defineProperty(receipt, 'verifiedWrites', { value: resolution.verifiedWrites })
        if (!options.completionProof) git.bindCommandReceipt(receipt, attempt.path, attempt.content)
        this.releaseGitAttempt(id)
        return receipt
      }
      if (resolution.status === 'unknown' || resolution.status === 'pending') throw new FilesOutcomeUnknownError(attempt.operationId)
      // A proven conflict may reuse the same captured output and actual read
      // set. Only a changed dependency below authorizes a fresh builder run.
    }
    const evaluate = async () => {
      this.assertGitOpen()
      const plan = { ...options.readPlan, files: [...(options.readPlan?.files ?? []), path] }
      const recovered = recovery?.snapshot
      if (recovery) recovery.snapshot = undefined // Transfer the single lease to this evaluation.
      const snapshot = recovered ?? (attempt ? await git.at(attempt.expectedRevision) : observed ?? await this.files.snapshot(plan))
      try {
        // Recovery's current remote snapshot already checked the command receipt.
        // Validate its live scope/token and load the new builder inputs at that H.
        // The next publication still uses exact-H CAS, never a local head hint.
        if (recovered && this.files.prefetch) await this.files.prefetch(snapshot, plan)
        const existing = options.completionProof ? await options.completionProof(snapshot) ? { revision: snapshot.revision, replay: true } : undefined : await this.readGitReceipt(snapshot, id, requestHash, path)
        if (existing) return existing
        if (attempt) git.restoreReads(snapshot, attempt.reads)
        const changes = attempt?.changes ?? await git.withDependencyCapture(snapshot, async () => { await this.assertTaskCommandOpen(snapshot, options.taskOwner); return build(snapshot) })
        this.assertGitOpen()
        if (!attempt && !changes.length && options.completionProof) throw new Error('Finalization has neither an existing completion proof nor changes to publish.')
        if (!attempt && !changes.length && (options.taskOwner || options.gitEmptyResult === 'observation-only')) {
          // A builder observation is not a persisted command acknowledgement.
          // Existing receipts and unresolved attempts were handled above.
          options.readPlan?.signal?.throwIfAborted()
          await options.beforeAttempt?.()
          options.readPlan?.signal?.throwIfAborted()
          this.assertGitOpen()
          return { revision: snapshot.revision, replay: false, observationOnly: true } satisfies FileReceipt
        }
        if (changes.some(change => change.path === path)) throw new Error('Business changes cannot replace their command receipt.')
        const receipt = { version: 1, id, requestHash, ...(options.taskOwner ? { taskOwner: options.taskOwner } : {}) }
        try {
          const content = JSON.stringify(receipt) + '\n'
          const combined = options.completionProof ? [...changes] : [...changes, { path, content }], message = 'DSS command ' + commandHash
          if (!attempt) {
            const operation = await git.prepare(snapshot, combined, message)
            this.assertGitOpen()
            attempt = { owner: options.taskOwner, hash: requestHash, operationId: operation.id, expectedRevision: snapshot.revision, path, content, changes: structuredClone([...changes]), reads: git.captureReads(snapshot) }
            this.retainGitAttempt(id, attempt)
          }
          const result = await git.commitPrepared(snapshot, combined, message, attempt.operationId, {
            beforeAttempt: async () => { this.assertGitOpen(); options.readPlan?.signal?.throwIfAborted(); await options.beforeAttempt?.(); this.assertGitOpen() },
            ...(options.completionProof ? {} : { replayReceipt: { path, content } }),
            onAttempt: operation => {
              attempt = { ...attempt!, operationId: operation.id, expectedRevision: operation.expectedHead }
              this.retainGitAttempt(id, attempt)
            },
          })
          if (!options.completionProof) git.bindCommandReceipt(result, path, content)
          this.releaseGitAttempt(id)
          return result
        } catch (error) {
          if (!(error instanceof FilesConflictError) && !(error instanceof FilesOutcomeUnknownError)) throw error
          // A current terminal fact does not relabel an unresolved transport.
          if (options.completionProof && error instanceof FilesOutcomeUnknownError) throw error
          // A competing caller or an acknowledgement lost after publication is
          // proven by the remote atomic receipt, never by a local cache entry.
          let confirmed: FileReceipt | undefined
          try {
            if (error instanceof FilesConflictError && recovery) {
              // Native already proved this operation conflicted. One fresh remote
              // view checks a different native operation's atomic command receipt
              // and, if absent, becomes this callback's next pure build snapshot.
              // UNKNOWN/pending and failed receipt reads retain normal resolution.
              let current: FilesSnapshot | undefined = git.takeConflictSnapshot(error) ?? await git.snapshot({ files: [path], signal: options.readPlan?.signal })
              try {
                confirmed = options.completionProof ? await options.completionProof(current) ? { revision: current.revision, replay: true } : undefined : await this.readGitReceipt(current, id, requestHash, path)
                if (!confirmed) {
                  if (attempt) await git.operations.delete?.(attempt.operationId)
                  this.releaseGitAttempt(id)
                  recovery.snapshot = current; current = undefined
                }
              } finally { await current?.release() }
            } else confirmed = options.completionProof ? await withSnapshot(this.files, async current => await options.completionProof!(current) ? { revision: current.revision, replay: true } : undefined) : await this.gitConfirmed(id, requestHash, path)
          } catch (readError) {
            // An explicit identity mismatch must never be hidden as transport loss.
            if (readError instanceof Error && readError.message === 'A native command identity cannot be reused with different arguments.') throw readError
          }
          if (confirmed) { this.releaseGitAttempt(id); return confirmed }
          throw error
        }
      } finally { if (snapshot !== observed) await snapshot.release() }
    }
    return withReadOperation(this.files, evaluate)
  }
  /** Only this version's pending input journal is disposable. The same SQLite
   * transaction already owns the replay receipt. Failure to retire auxiliary
   * state cannot turn a proven business commit into failure or UNKNOWN. */
  private async releaseConfirmedInputs(key: string, record: CommandRecord | undefined, receipt: FileReceipt, observationOnly = false): Promise<void> {
    if (!record?.transient) return
    try {
      if (this.records.delete) await this.records.delete(key)
      else if (!observationOnly) await this.records.set(key, { id: record.id, requestHash: record.requestHash, receipt })
      else throw new Error('This record adapter cannot remove the temporary input journal.')
    } catch (cause) {
      const failure = new CommandCleanupFailure(record.id, key, cause)
      if (observationOnly) failure.message = 'Command ' + record.id + ' made no changes, but its temporary input journal could not be removed. Cleanup remains incomplete.'
      // Diagnostics cannot relabel a proven business commit. Production wires
      // its existing Host logger; standalone/custom callers still get stderr.
      try {
        if (this.diagnostics.onCleanupFailure) this.diagnostics.onCleanupFailure(failure)
        else console.warn(failure)
      } catch (reportingError) { console.warn(new AggregateError([failure, reportingError], 'Confirmed command cleanup warning could not be reported.')) }
    }
  }
  /** Called inside the existing final release, after its runtimeReleased fact.
   * It drains this Host/Task only. Finalizer commands deliberately have no owner
   * here, so this cannot await its own Cleaner/release publication. */
  async releaseTaskCommands(owner: TaskCommandOwner): Promise<void> {
    for (;;) {
      const accepted = [...taskPending.get(this.records) ?? []].filter(row => sameOwner(row.owner, owner))
      if (!accepted.length) break
      await Promise.allSettled(accepted.map(row => row.promise))
    }
    await withSnapshot(this.files, async snapshot => {
      const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(owner.taskId))
      if (!task || taskLifecycle(task) !== taskLifecycle(owner)) throw new Error('Task command release requires its exact retained lifecycle.')
      const state = await readTaskArchiveState(this.files, snapshot, task), host = taskArchiveHostFacts(state, owner, owner.hostKey), cleanup = taskArchiveCleanup(state, owner)
      if (!host?.runtimeReleased || !cleanup) throw new Error('Task commands release only after existing runtime and fixed-namespace retirement facts.')
      if (this.files instanceof GitFiles) {
        for (const handle of [...taskAttemptHandles.get(this.records) ?? []]) {
          if (!(handle.files instanceof GitFiles)) continue
          for (const [id, attempt] of handle.gitAttempts) if (sameOwner(attempt.owner, owner)) {
            const outcome = await handle.files.resolve(attempt.operationId)
            if (outcome.status === 'unknown' || outcome.status === 'pending') throw new FilesOutcomeUnknownError(attempt.operationId)
            handle.releaseGitAttempt(id); handle.gitInputGuards.delete(id)
            await handle.files.operations.delete?.(attempt.operationId)
          }
          for (const [id, guard] of handle.gitInputGuards) if (sameOwner(guard.owner, owner)) handle.gitInputGuards.delete(id)
          handle.releaseGitHandleIfIdle()
        }
        return
      }
      for (const row of await this.records.list<CommandRecord>(this.ownerPrefix(owner))) {
        const record = row.value
        if (!record?.transient || !sameOwner(record.taskOwner, owner) || row.key !== this.commandKey(record.id, owner)) throw new Error('Task command journal does not match its exact owner.')
        const path = this.receiptPath(record.id, owner), raw = await this.files.read(snapshot, path)
        if (raw !== undefined && (JSON.parse(raw) as { requestHash?: string }).requestHash !== record.requestHash) throw new Error('Task command receipt differs from its original request.')
        // Present or listed as deleted: the atomic commit is confirmed. Absent
        // from both: it was not applied before cleanup's CAS. The same retired
        // state dependency prevents a later old publication. Neither case runs
        // the builder or tells an UNKNOWN caller that it succeeded.
        const confirmed = raw !== undefined || cleanup.deletedPaths?.includes(path)
        if (!confirmed && host.released) throw new Error('A released Host still has an unresolved command journal without its deletion proof.')
        if (!this.records.delete) throw new Error('This record adapter cannot retire its Task command journal.')
        try { await this.records.delete(row.key) }
        catch (cause) {
          const warning = new CommandCleanupFailure(record.id, row.key, cause)
          try { this.diagnostics.onCleanupFailure?.(warning) } catch { /* Existing release error still surfaces below. */ }
          throw warning
        }
      }
    })
  }
  private async execute(id: string, requestHash: string, options: CommandOptions, build: CommandBuilder, recovery?: GitRecoveryRound, observed?: FilesSnapshot): Promise<FileReceipt> {
    if (this.files instanceof GitFiles) return this.executeGit(id, requestHash, options, build, recovery, observed)
    const key = this.commandKey(id, options.taskOwner)
    let record = await this.records.get<CommandRecord>(key)
    if (record && (record.requestHash !== requestHash || !sameOwner(record.taskOwner, options.taskOwner))) throw new Error('A native command identity cannot be reused with different arguments.')
    if (record?.receipt) return { ...record.receipt, replay: true }
    if (options.taskOwner && !record) {
      const prior = await this.records.get<CommandRecord>(this.prefix + hash(id))
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error('A native command identity cannot be reused with different arguments.')
        if (prior.receipt) return { ...prior.receipt, replay: true }
        throw new Error('Resolve this original unscoped command before assigning it a new Task owner.')
      }
    }
    const evaluate = async () => {
      const plan = { ...options.readPlan }
      const snapshot = observed ?? await this.files.snapshot(plan)
      try {
        const receiptPath = this.receiptPath(id, options.taskOwner)
        // A Local process can exit after COMMIT but before saving its local command acknowledgement.
        // This receipt is part of the same authoritative transaction as the business changes.
        if (options.completionProof && await options.completionProof(snapshot)) return { revision: snapshot.revision, replay: true }
        const existing = options.completionProof ? undefined : await this.readCommandReceipt(snapshot, id, receiptPath)
        if (existing !== undefined) {
          const saved = JSON.parse(existing) as { requestHash: string }
          if (saved.requestHash !== requestHash) throw new Error('Stored command receipt does not match its arguments.')
          const receipt = { revision: snapshot.revision, replay: true }
          await this.releaseConfirmedInputs(key, record, receipt)
          return receipt
        }
        await this.assertTaskCommandOpen(snapshot, options.taskOwner)
        if (!record && !options.completionProof && !options.taskOwner) {
          record = { id, requestHash, transient: true, ...(options.taskOwner ? { taskOwner: options.taskOwner } : {}) }
          await this.records.set(key, record)
        }
        if (options.readPlan && this.files.prefetch) await this.files.prefetch(snapshot, options.readPlan)
        const changes = await build(snapshot)
        if (!changes.length && options.completionProof) throw new Error('Finalization has neither an existing completion proof nor changes to publish.')
        if (!changes.length && options.taskOwner) {
          const receipt: FileReceipt = { revision: snapshot.revision, replay: false, observationOnly: true }
          await this.releaseConfirmedInputs(key, record, receipt, true)
          return receipt
        }
        if (!changes.length && !options.taskOwner) {
          const receipt = { revision: snapshot.revision, replay: false }
          // An observation with no commit still needs its existing minimal
          // acknowledgement. Its assessed inputs have no remaining job.
          await this.records.set(key, record && !record.transient ? { ...record, receipt } : { id, requestHash, receipt })
          return receipt
        }
        if (changes.some(change => change.path === receiptPath)) throw new Error('Business changes cannot replace their command receipt.')
        if (options.taskOwner && !record) {
          record = await this.records.get<CommandRecord>(key)
          if (record && (record.requestHash !== requestHash || !sameOwner(record.taskOwner, options.taskOwner))) throw new Error('A native command identity cannot be reused with different arguments.')
          if (!record) { record = { id, requestHash, transient: true, taskOwner: options.taskOwner }; await this.records.set(key, record) }
        }
        const combined = options.completionProof ? [...changes] : [...changes, { path: receiptPath, content: JSON.stringify({ requestHash, ...(options.taskOwner ? { version: 1, id, taskOwner: options.taskOwner } : {}) }) + '\n' }]
        const message = 'DSS command ' + hash(id)
        const receipt = await this.files.commit(snapshot, combined, message)
        const { verifiedWrites: _liveVerification, ...persistedReceipt } = receipt
        await this.releaseConfirmedInputs(key, record, persistedReceipt)
        return receipt
      } finally { if (snapshot !== observed) await snapshot.release() }
    }
    // Planned predicates reuse one operation-owned read session. The existing
    // commit boundary still resolves write credentials and checks authority.
    // Confirmed command replays returned above never open a remote session.
    return options.readPlan ? withReadOperation(this.files, evaluate) : evaluate()
  }
}
