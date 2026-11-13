import { PhysicalLocalPublicationRequiredError } from './physical-local-files.js'
import { paths, readJson, taskLifecycle, type TaskMetadata } from './task-files.js'
import { readTaskArchiveState, taskArchiveCleanup, taskArchiveHostFacts } from './task-archive.js'
import { taskCommandReceiptPath, taskCommandReceiptOwner, type TaskCommandOwner } from './task-command-paths.js'
import { observeFileReads } from './file-read-observation.js'
import type { GitReadDependencies } from '../experimental/private-git/contracts.js'
import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { FilesConflictError, FilesOutcomeUnknownError, GitFiles, withWriteOperation, withReadOperation, withSnapshot, type FileChange, type FileReadPlan, type FileReceipt, type FilesSnapshot, type FilesStore } from './transactions.js'

export interface CommandOptions {
  /** Internal existing terminal/deletion fact, never an added acknowledgement. */
  completionProof?: (snapshot: FilesSnapshot) => Promise<boolean>
  /** Exact validated execution/Task owner, never inferred from business arguments. */
  taskOwner?: TaskCommandOwner
  /** Live operation ownership/cancellation guard; no business rebuilding. */
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
   * target, without completing a replayable command. */
  gitEmptyResult?: 'observation-only'
  /** Business-state commands retain their original native operation only while
   * unresolved in this connection. No cross-session command receipt is written;
   * later calls evaluate current business files rather than proving that original
   * operation's historical outcome. */
  gitReplay?: 'session-only'
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
export type CommandBuilder = (snapshot: FilesSnapshot, resumedChanges?: readonly FileChange[]) => Promise<readonly FileChange[]>
/** Owned by exactly one run callback, never a session cache or caller option. */
interface GitRecoveryRound {
  snapshot?: FilesSnapshot
  receiptAbsent?: { id: string; requestHash: string; path: string }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export const gitCommandReceiptPath = (id: string): string => 'technical/command-receipts/' + hash(id) + '.json'
const sameOwner = (a: TaskCommandOwner | undefined, b: TaskCommandOwner | undefined) => JSON.stringify(a && [a.taskId, taskLifecycle(a), a.hostKey]) === JSON.stringify(b && [b.taskId, taskLifecycle(b), b.hostKey])
// The existing accepted promises, shared only by handles of this same record owner.
const taskPending = new WeakMap<StoragePort, Set<{ owner: TaskCommandOwner; promise: Promise<FileReceipt> }>>()
// Same-connection handles share only still-unresolved native operations.
const taskAttemptHandles = new WeakMap<StoragePort, Set<FrameworkTransactions>>()

/** Git commands retain only unresolved native attempts and exact committed receipts.
 * Physical Local operations use their own explicit publication paths. */
export class FrameworkTransactions {
  private readonly pending = new Map<string, { hash: string; owner?: TaskCommandOwner; promise: Promise<FileReceipt> }>()
  private gitClosed = false
  private gitCloseReason: unknown
  private gitClosing?: Promise<void>
  private readonly gitAttempts = new Map<string, { owner?: TaskCommandOwner; hash: string; operationId: string; expectedRevision: string; path: string; content: string; changes: FileChange[]; reads: GitReadDependencies; release?: () => void }>()
  private readonly gitInputGuards = new Map<string, { owner?: TaskCommandOwner; hash: string; reads: Map<string, string>; targets: string }>()
  constructor(readonly files: FilesStore, private readonly records: StoragePort) {}
  /** Exact command ownership only, not proof of dispatch or permission to
   * discard an operation. Cleaner keeps its original publication while this
   * connection still owns the corresponding native attempt. */
  ownsGitAttempt(id: string): boolean { return this.gitAttempts.has(id) }
  /** Read only a persisted acknowledgement or atomic receipt. This does not
   * replay a builder or resolve an unconfirmed transport operation. */
  async confirmed(id: string, request: unknown, taskOwner?: TaskCommandOwner): Promise<FileReceipt | undefined> {
    if (!(this.files instanceof GitFiles)) throw new PhysicalLocalPublicationRequiredError(id)
    const requestHash = hash(JSON.stringify(request)), active = this.pending.get(id)
    if (active && (active.hash !== requestHash || !sameOwner(active.owner, taskOwner)))
      throw new Error('A native command identity cannot be reused with different arguments.')
    return this.gitConfirmed(id, requestHash, this.receiptPath(id, taskOwner))
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
    // Development route only: never execute an old atomic builder, create its
    // journal, or append a false physical receipt. Migrated operations call
    // their own explicit physical publication (for example role-guide update).
    if (!(this.files instanceof GitFiles)) return Promise.reject(new PhysicalLocalPublicationRequiredError(id))
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
    // A resumed UNKNOWN attempt already owns its original business bytes. If
    // resolution later proves conflict, hand those bytes to its fresh builder
    // rather than making callers recapture external inputs. executeGit checks
    // the attempt's command identity before any builder can run.
    const resumedChanges = this.files instanceof GitFiles ? this.gitAttempts.get(id)?.changes : undefined
    const buildCurrent: CommandBuilder = snapshot => build(snapshot, resumedChanges)
    const savedInputs = options.preserveInputs && this.files instanceof GitFiles ? this.gitInputGuards.get(id) : undefined
    if (savedInputs && (savedInputs.hash !== requestHash || !sameOwner(savedInputs.owner, options.taskOwner))) throw new Error('A native command identity cannot be reused with different arguments.')
    let firstReads: Map<string, string> | undefined = savedInputs?.reads, firstTargets: string | undefined = savedInputs?.targets
    const checkedBuild: CommandBuilder = options.preserveInputs ? snapshot => {
      const reads = new Map<string, string>(), recheckedTargets = new Set<string>()
      return observeFileReads(snapshot, (key, fingerprint) => {
        if (firstReads && firstReads.get(key) !== fingerprint) throw new CommandInputsChangedError()
        reads.set(key, fingerprint)
      }, async () => {
        const changes = await buildCurrent(snapshot)
        // A target explicitly reevaluated by its business owner can become a
        // no-op (for example a peer already published identical skill text).
        // Its current-content decision replaces this first-attempt target guard.
        const targets = JSON.stringify([...new Set(changes.map(change => change.path).filter(path => !recheckedTargets.has(path)))].sort())
        if (firstTargets !== undefined && targets !== firstTargets) throw new CommandInputsChangedError()
        firstTargets ??= targets
        // Compare exact write targets too, including a previously absent file.
        // Reuse builder observations; never scan unrelated content.
        for (const change of changes) if (!reads.has('file:' + change.path) && !recheckedTargets.has(change.path)) await this.files.readBytes(snapshot, change.path)
        if (firstReads && firstReads.size !== reads.size) throw new CommandInputsChangedError()
        firstReads ??= reads
        return changes
      }, path => recheckedTargets.add(path))
    } : buildCurrent
    // A derived index merges current shared state, not newly assessed material.
    // Git captures both phases in its existing dependency view. An explicit
    // material read of that index stays protected above.
    const deriveChanges = options.deriveChanges
    const attemptBuild: CommandBuilder = options.preserveInputs || deriveChanges ? async snapshot => {
      const changes = await checkedBuild(snapshot)
      const derived = deriveChanges ? await deriveChanges(snapshot, changes) : []
      // Retain input guards only after the complete build succeeds, as before.
      if (options.preserveInputs && !this.gitInputGuards.has(id)) {
        this.gitInputGuards.set(id, { owner: options.taskOwner, hash: requestHash, reads: new Map(firstReads!), targets: firstTargets! })
        if (options.taskOwner) this.retainGitHandle()
      }
      return derived.length ? [...changes, ...derived] : changes
    } : checkedBuild
    // A session-only operation store can retire the proven conflict immediately.
    // Durable/custom stores without release retain their existing resolution path.
    const recovery: GitRecoveryRound | undefined = this.files instanceof GitFiles ? {} : undefined
    try {
      for (let retry = 0; ; retry++) {
        options.readPlan?.signal?.throwIfAborted()
        try { return await this.executeGit(id, requestHash, options, attemptBuild, recovery, observed) } catch (error) {
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
  clearSessionCache(): void { for (const attempt of this.gitAttempts.values()) attempt.release?.(); this.gitAttempts.clear(); this.gitInputGuards.clear(); taskAttemptHandles.get(this.records)?.delete(this) }
  private retainGitAttempt(id: string, attempt: NonNullable<ReturnType<typeof this.gitAttempts.get>>): void {
    const previous = this.gitAttempts.get(id)
    if (previous?.operationId === attempt.operationId) attempt.release = previous.release
    else {
      attempt.release = this.files instanceof GitFiles ? this.files.retainOperation(attempt.operationId) : undefined
      previous?.release?.()
    }
    this.gitAttempts.set(id, attempt)
    if (attempt.owner) this.retainGitHandle()
  }
  private releaseGitAttempt(id: string): void {
    const attempt = this.gitAttempts.get(id)
    this.gitAttempts.delete(id)
    attempt?.release?.()
    this.releaseGitHandleIfIdle()
  }
  private retainGitHandle(): void { const handles = taskAttemptHandles.get(this.records) ?? new Set(); handles.add(this); taskAttemptHandles.set(this.records, handles) }
  private releaseGitHandleIfIdle(): void {
    if (![...this.gitAttempts.values(), ...this.gitInputGuards.values()].some(entry => entry.owner)) taskAttemptHandles.get(this.records)?.delete(this)
  }
  /** Exact successful native calls only; the caller owns their persisted result evidence.
   * Return changes for an already-needed publication, never start a cleanup write. */
  async completedNativeCommandChanges(snapshot: FilesSnapshot, ids: readonly string[]): Promise<FileChange[]> {
    const selected = ids.map(id => ({ id, path: gitCommandReceiptPath(id) }))
    await this.files.prefetch?.(snapshot, { files: selected.map(item => item.path) })
    const changes: FileChange[] = []
    for (const { id, path } of selected) {
      const raw = await this.files.read(snapshot, path)
      if (raw === undefined) continue
      let receipt: { version?: number; id?: string; requestHash?: string; taskOwner?: unknown }
      try { receipt = JSON.parse(raw) }
      catch (error) { if (error instanceof SyntaxError) continue; throw error }
      if (!receipt || receipt.version !== 1 || receipt.id !== id || receipt.taskOwner !== undefined
        || typeof receipt.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.requestHash)) continue
      changes.push({ path, content: null })
    }
    return changes
  }
  private receiptPath(id: string, owner?: TaskCommandOwner): string { return owner ? taskCommandReceiptPath(owner, id) : gitCommandReceiptPath(id) }
  private async readCommandReceipt(snapshot: FilesSnapshot, id: string, path: string): Promise<string | undefined> {
    const owner = taskCommandReceiptOwner(path)
    if (!owner) return this.files.read(snapshot, path)
    const validate = (raw: string, selected: string): string => {
      const value = JSON.parse(raw) as { taskOwner?: TaskCommandOwner; id?: string }
      if (!value.taskOwner || value.id !== id || taskCommandReceiptPath(value.taskOwner, id) !== selected) throw new Error('Task command receipt content differs from its original Host.')
      return raw
    }
    // The original Host's exact atomic receipt already proves this command.
    // A miss still follows the existing cross-Host recovery below.
    const exact = await this.files.read(snapshot, path)
    if (exact !== undefined) return validate(exact, path)
    // One native command remains one command if another Host retries it. The
    // exact basename predicate records absence/new matching owners without
    // turning unrelated command files into a whole-Task contention gate.
    const root = paths.run(owner.taskId) + '/.command-receipts/' + owner.lifecycleHash
    const name = hash(id) + '.json'
    const rows = (await this.files.list(snapshot, root, { names: [name], pathSegments: [...root.split('/'), null, name] })).filter(row => {
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
    return validate(raw, selected)
  }
  private async assertTaskCommandOpen(snapshot: FilesSnapshot, owner: TaskCommandOwner | undefined): Promise<void> {
    if (!owner) return
    const task = await readJson<TaskMetadata>(this.files, snapshot, paths.task(owner.taskId))
    if (!task || task.taskId !== owner.taskId || taskLifecycle(task) !== taskLifecycle(owner)) throw new TaskCommandRetiredError(owner)
    const state = await readTaskArchiveState(this.files, snapshot, task), host = taskArchiveHostFacts(state, owner, owner.hostKey)
    if (taskArchiveCleanup(state, owner) || host?.runtimeReleased || host?.released) throw new TaskCommandRetiredError(owner)
  }
  private async readGitReceipt(snapshot: FilesSnapshot, id: string, requestHash: string, path = gitCommandReceiptPath(id)): Promise<FileReceipt | undefined> {
    const raw = await this.readCommandReceipt(snapshot, id, path)
    if (raw === undefined) return
    const record = JSON.parse(raw) as { version?: number; id?: string; requestHash?: string }
    if (record.version !== 1 || record.id !== id || record.requestHash !== requestHash) throw new Error('A native command identity cannot be reused with different arguments.')
    return { revision: snapshot.revision, replay: true }
  }
  private async gitConfirmed(id: string, requestHash: string, path = gitCommandReceiptPath(id)): Promise<FileReceipt | undefined> {
    this.assertGitOpen()
    const snapshot = await this.files.snapshot({ files: [path] })
    try { return await this.readGitReceipt(snapshot, id, requestHash, path) } finally { await snapshot.release() }
  }
  /** Replayable Git commands own their receipt in the SAME business commit.
   * Session-only commands retain the original operation without a receipt.
   * There is no local durable id mapping, nor a recursively journalled set. */
  private async executeGit(id: string, requestHash: string, options: CommandOptions, build: CommandBuilder, recovery?: GitRecoveryRound, observed?: FilesSnapshot): Promise<FileReceipt> {
    this.assertGitOpen()
    const commandHash = hash(id), path = this.receiptPath(id, options.taskOwner)
    const sessionOnly = options.gitReplay === 'session-only'
    const durableReceipt = !options.completionProof && !sessionOnly
    const git = this.files as GitFiles
    let attempt = this.gitAttempts.get(id)
    const resumeUnsent = !!attempt && git.canResumeUnsent(attempt.operationId)
    if (attempt) {
      if (attempt.hash !== requestHash || !sameOwner(attempt.owner, options.taskOwner)) throw new Error('A native command identity cannot be reused with different arguments.')
      if (!resumeUnsent) {
        const resolution = await git.resolve(attempt.operationId)
        if (resolution.status === 'confirmed') {
          const receipt: FileReceipt = { revision: resolution.commit, replay: true, operationId: attempt.operationId }
          this.releaseGitAttempt(id)
          return receipt
        }
        if (resolution.status === 'unknown' || resolution.status === 'pending') throw new FilesOutcomeUnknownError(attempt.operationId)
      }
      // A proven conflict or still-owned unsent attempt reuses captured output
      // and reads. Only changed dependencies authorize a fresh builder run.
    }
    const evaluate = async () => {
      this.assertGitOpen()
      const plan = { ...options.readPlan, files: [...(options.readPlan?.files ?? []), ...(sessionOnly ? [] : [path])] }
      const recovered = recovery?.snapshot, absent = recovery?.receiptAbsent
      // Transfer only this run's exact immutable observation, never a latest-head
      // hint or the result of a potentially live completionProof callback.
      const receiptAbsent = recovered && absent?.id === id && absent.requestHash === requestHash && absent.path === path
      if (recovery) { recovery.snapshot = undefined; recovery.receiptAbsent = undefined }
      const snapshot = recovered ?? (attempt ? await git.at(attempt.expectedRevision) : observed ?? await this.files.snapshot(plan))
      try {
        // Recovery's current remote snapshot already checked the command receipt.
        // Validate its live scope/token and load the new builder inputs at that H.
        // The next publication still uses exact-H CAS, never a local head hint.
        if (recovered && this.files.prefetch) await this.files.prefetch(snapshot, plan)
        const existing = options.completionProof ? await options.completionProof(snapshot) ? { revision: snapshot.revision, replay: true } : undefined : !durableReceipt || receiptAbsent ? undefined : await this.readGitReceipt(snapshot, id, requestHash, path)
        if (existing) return existing
        if (attempt) git.restoreReads(snapshot, attempt.reads)
        const changes = attempt?.changes ?? await git.withDependencyCapture(snapshot, async () => { await this.assertTaskCommandOpen(snapshot, options.taskOwner); return build(snapshot) })
        this.assertGitOpen()
        if (!attempt && !changes.length && options.completionProof) throw new Error('Finalization has neither an existing completion proof nor changes to publish.')
        if (!attempt && !changes.length && (options.taskOwner || options.gitReplay === 'session-only' || options.gitEmptyResult === 'observation-only')) {
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
          const combined = durableReceipt ? [...changes, { path, content }] : [...changes], message = 'DSS command ' + commandHash
          if (!attempt) {
            const operation = await git.prepare(snapshot, combined, message)
            this.assertGitOpen()
            attempt = { owner: options.taskOwner, hash: requestHash, operationId: operation.id, expectedRevision: snapshot.revision, path, content, changes: structuredClone([...changes]), reads: git.captureReads(snapshot) }
            this.retainGitAttempt(id, attempt)
          }
          const result = await git.commitPrepared(snapshot, combined, message, attempt.operationId, {
            ...(resumeUnsent ? { resumeUnsent: true as const } : {}),
            beforeAttempt: async () => { this.assertGitOpen(); options.readPlan?.signal?.throwIfAborted(); await options.beforeAttempt?.(); this.assertGitOpen() },
            ...(durableReceipt ? { replayReceipt: { path, content } } : {}),
            onAttempt: operation => {
              attempt = { ...attempt!, operationId: operation.id, expectedRevision: operation.expectedHead }
              this.retainGitAttempt(id, attempt)
            },
          })
          this.releaseGitAttempt(id)
          return result
        } catch (error) {
          if (!(error instanceof FilesConflictError) && !(error instanceof FilesOutcomeUnknownError)) throw error
          // Neither a current target nor a terminal fact relabels an unresolved
          // original transport. Session-only callers must resolve that operation.
          if (!durableReceipt && error instanceof FilesOutcomeUnknownError) throw error
          // A competing caller or an acknowledgement lost after publication is
          // proven by the remote atomic receipt, never by a local cache entry.
          let confirmed: FileReceipt | undefined
          try {
            if (error instanceof FilesConflictError && recovery) {
              // Native already proved this operation conflicted. One fresh remote
              // view checks an atomic command receipt only when required, then
              // becomes this callback's next pure build snapshot if not confirmed.
              // UNKNOWN/pending and failed receipt reads retain normal resolution.
              let current: FilesSnapshot | undefined = git.takeConflictSnapshot(error) ?? await git.snapshot({ files: sessionOnly ? [] : [path], signal: options.readPlan?.signal })
              try {
                confirmed = options.completionProof ? await options.completionProof(current) ? { revision: current.revision, replay: true } : undefined : durableReceipt ? await this.readGitReceipt(current, id, requestHash, path) : undefined
                if (!confirmed) {
                  if (attempt) await git.operations.delete?.(attempt.operationId)
                  this.releaseGitAttempt(id)
                  recovery.snapshot = current
                  recovery.receiptAbsent = durableReceipt ? { id, requestHash, path } : undefined
                  current = undefined
                }
              } finally { await current?.release() }
            } else confirmed = options.completionProof ? await withSnapshot(this.files, async current => await options.completionProof!(current) ? { revision: current.revision, replay: true } : undefined) : durableReceipt ? await this.gitConfirmed(id, requestHash, path) : undefined
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
  /** Drain this Task's accepted Git commands, then resolve only its still-owned
   * native attempts after the existing runtime and cleanup facts are present. */
  async releaseTaskCommands(owner: TaskCommandOwner): Promise<void> {
    if (!(this.files instanceof GitFiles)) throw new PhysicalLocalPublicationRequiredError('release task commands')
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
    })
  }

}
