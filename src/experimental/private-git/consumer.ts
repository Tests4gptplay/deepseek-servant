import { randomUUID } from 'node:crypto'
import { childDirectories, loadPaths } from './repository-paths.js'
import type { CoopStore } from './cache.js'
import type { GitChange, GitChangeNotice, GitRepository, GitSnapshot, RoleBinding, UserIntent } from './contracts.js'
import { digest, GitJournal, json, readJson, readText, textChanges } from './journal.js'
import { RoleWriter, plannerTrigger } from './role-writer.js'
import { readOutcome, recordPublished } from './outcome.js'
import { appendStatus, statusPath } from './status.js'
import { actionPath, executionPath, joinPath, participantPath, planPath, sameBinding, StaleCoopWrite, taskPath,
  type ChildState, type Claim, type Join, type LocalGrant, type ParticipantPlan, type RoleAction, type RoleOutcome, type RootTask } from './protocol.js'
import { CoopFinalizer } from './finalizer.js'
import { recordReadError } from './conversation.js'
import { releaseConfirmedActionCaches, releaseInputCaches, releaseArchivedTaskCaches, type CacheCleanupResult } from './cache-cleanup.js'

export interface CoopPhysicalState {
  busy: boolean
  finished: boolean
  error?: string
  transcript: string
  jobs: Array<{ id: string; status: string }>
}
export interface CoopAgentPort {
  start(action: RoleAction, context: unknown, writer: RoleWriter, wake: () => void): Promise<void>
  state(executionId: string): CoopPhysicalState | undefined
  release(executionId: string, cancel?: boolean): Promise<void>
  dispose(): Promise<void>
}
export interface CoopEngineOptions {
  repo: GitRepository; cache: CoopStore; journal(): GitJournal; agents: CoopAgentPort
  wake(): void
}
/** One confirmed snapshot drives this instance; a write receipt never enters dispatch(). */
export class CoopConsumer {
  private writerValue?: { participant: string; value: RoleWriter }
  private stopping = false
  private cleanupError?: string
  private reportCleanup(result: CacheCleanupResult): void {
    if (!result.failed.length) return
    const message = JSON.stringify({ count: result.failed.length, first: result.failed.slice(0, 5) })
    if (message !== this.cleanupError) console.error('deepseek-servant cache cleanup', message)
    this.cleanupError = message
  }
  constructor(private readonly options: CoopEngineOptions) {}
  get writer(): RoleWriter {
    const participant = this.options.cache.connection()?.identity.id.toString()
    if (!participant) throw new Error('Connect a private repository first.')
    if (this.writerValue?.participant !== participant) this.writerValue = { participant, value: new RoleWriter(this.options.repo, this.options.journal(), this.options.cache) }
    return this.writerValue.value
  }
  private async actions(snapshot: GitSnapshot): Promise<RoleAction[]> {
    const cache = this.options.cache, participant = cache.connection()?.identity.id.toString()
    const suffix = '/actions/' + participant + '/' + cache.instanceId + '/'
    const actions: RoleAction[] = []
    for (const path of snapshot.files.keys()) {
      if (!path.includes(suffix) || !path.endsWith('.json')) continue
      try {
      const action = await readJson<RoleAction>(this.options.repo, snapshot, path)
      if (action?.binding && action.binding.participantId === participant && action.binding.instanceId === cache.instanceId
        && actionPath(action.binding) === path) actions.push(action)
      } catch (error) { await recordReadError(cache, path, error) }
    }
    return actions
  }
  async notifyChanges(notice: GitChangeNotice): Promise<void> {
    if (!notice.changes.length) return
    const id = 'git-' + digest(json(notice.changes.map(change => [change.commit, change.path, change.status]))).slice(0, 40)
    await this.stage({ role: 'foreground', actionId: id, trigger: notice.to, epoch: 0,
      input: { gitChanges: { from: notice.from, to: notice.to, count: notice.changes.length, preview: notice.changes.slice(0, 100) } } })
    this.options.wake()
  }
  async consume(snapshot: GitSnapshot): Promise<void> {
    if (this.stopping) return
    const { cache, repo, agents } = this.options
    const participantId = cache.connection()!.identity.id.toString()
    await loadPaths(repo, snapshot, 'dss-coop/foreground/actions/' + participantId + '/' + cache.instanceId + '/')
    await loadPaths(repo, snapshot, 'dss-coop/intents/' + participantId + '/')
    const grants: LocalGrant[] = []
    for (const directory of await childDirectories(repo, snapshot, 'dss-coop/tasks/')) {
      const taskId = directory.slice('dss-coop/tasks/'.length, -1)
      const path = joinPath(taskId, participantId, cache.instanceId)
      const joined = await readJson<Join>(repo, snapshot, path)
      if (!joined || joined.participantId !== participantId || joined.instanceId !== cache.instanceId) continue
      const grant = { taskId, joinPath: path, joinHash: '', sourceIntentId: joined.sourceIntentId }
      grants.push(grant)
      await cache.put('grant/' + taskId, grant) // Rebuildable cursor for cleanup, not authority.
      await loadPaths(repo, snapshot, directory)
    }
    for (const [, old] of cache.entries<LocalGrant>('grant/')) {
      if (!grants.some(grant => grant.taskId === old.taskId)) this.reportCleanup(await releaseArchivedTaskCaches(cache, old.taskId))
    }
    let changed = false
    const actions = await this.actions(snapshot)
    // A durable outcome advances scheduling independently of a native reply ending.
    // Retired native owners drain through their existing events and are reaped here.
    for (const [key, owned] of cache.entries<{ binding: RoleBinding }>('physical/')) {
      if (actions.some(action => action.state === 'active' && sameBinding(action.binding, owned.binding))) continue
      const physical = agents.state(owned.binding.executionId)
      if (physical?.busy) continue
      const resultPath = executionPath(owned.binding) + '/physical-result.json'
      const result = await readJson<{ settled?: boolean }>(repo, snapshot, resultPath)
      if (result?.settled === false) {
        await this.options.journal().transact('settle-' + owned.binding.executionId, { resultPath }, async () => [
          ...(physical ? textChanges(executionPath(owned.binding) + '/transcript', physical.transcript) : []),
          { path: resultPath, content: json({ ...result, ...(physical ? { jobs: physical.jobs, error: physical.error } : {}), settled: true }) },
        ])
      }
      await agents.release(owned.binding.executionId)
      await cache.remove(key)
    }
    this.reportCleanup(await releaseConfirmedActionCaches(cache, actions))
    for (const action of actions.filter(value => value.state === 'closed')) {
      const physical = agents.state(action.binding.executionId)
      if (physical?.busy || (physical && !physical.finished)) continue
      try {
        await agents.release(action.binding.executionId)
        await cache.remove('physical/' + action.binding.executionId)
        this.reportCleanup(await releaseInputCaches(cache, action.binding))
        if (action.binding.sourceIntentId) {
          const inputPath = 'dss-coop/intents/' + participantId + '/' + action.binding.sourceIntentId + '.json'
          await this.options.journal().transact('consume-' + action.id, { path: inputPath }, async head => {
            const input = await repo.read(head, inputPath)
            if (input === undefined) return []
            return [{ path: 'dss-coop/inputs/' + participantId + '/' + action.binding.sourceIntentId + '.json', content: input }, { path: inputPath, content: null }]
          })
        }
      } catch (error) {
        this.reportCleanup({ removed: 0, failed: [{ key: actionPath(action.binding), message: error instanceof Error ? error.message : String(error) }] })
      }
    }
    for (const action of actions.filter(value => value.state === 'active')) {
      if (this.stopping) return
      try {
      await cache.remove('read-error/' + actionPath(action.binding))
      const b = action.binding
      const physical = agents.state(b.executionId)
      const outcome = await readOutcome(repo, snapshot, b)
      const validOutcome = !!outcome
      if (validOutcome) {
        await cache.remove('native-error/' + action.id)
        if (outcome.kind === 'continue' || (outcome.kind === 'result' && outcome.resultStatus === 'handoff')) {
          await this.replace(action, 'Role handoff', outcome, physical); changed = true
        } else {
          await this.close(action, physical, undefined, outcome); changed = true
        }
        continue
      }
      try { await this.writer.current(snapshot, b) }
      catch (error) {
        if (!(error instanceof StaleCoopWrite)) throw error
        await this.close(action, physical, error.message); changed = true; continue
      }
      if (!physical && action.stateProtocol !== 1) {
        // Resume an unfinished pre-upgrade action with the same binding and the new role contract.
        await this.options.journal().transact('startup-' + b.executionId, { binding: b }, async head => {
          const current = await readJson<RoleAction>(repo, head, actionPath(b))
          if (!current || current.state !== 'active' || !sameBinding(current.binding, b)) return []
          return [{ path: actionPath(b), content: json({ ...current, stateProtocol: 1 }) },
            ...await appendStatus(this.options.journal(), head, { version: 1, kind: 'started', binding: b, createdAt: current.createdAt })]
        })
        changed = true; continue
      }
      if (action.stateProtocol === 1) {
        const prepared = await readJson<RoleOutcome>(repo, snapshot, b.outputPath)
        if (prepared?.operationId && prepared.binding && sameBinding(prepared.binding, b)) {
          // A crash between the result and status commits can recover entirely from Git.
          await this.writer.completeOutcome(b, prepared.operationId)
          changed = true; continue
        }
      }
      if (physical?.finished && !physical.busy) {
        if (cache.drafts().some(draft => draft.kind === 'transaction' && (draft.payload as { binding?: RoleBinding }).binding?.executionId === b.executionId)) continue
        const incident = physical.error ?? 'The native turn ended before saving its role outcome.'
        const prior = cache.get<{ error: string; count: number }>('native-error/' + action.id)
        const count = (prior?.count ?? 0) + 1
        if (count > 3) { await cache.put('runtime-error', incident); continue }
        await cache.put('native-error/' + action.id, { error: incident, count })
        await this.replace(action, incident, undefined, physical); changed = true
        continue
      }
      if (!physical) {
        if (b.role === 'foreground' && actions.some(other => other.binding.role === 'foreground' && other.binding.executionId !== b.executionId && agents.state(other.binding.executionId)?.busy)) continue
        const activeWorkers = cache.entries<{ binding: RoleBinding }>('physical/').filter(([, value]) => value.binding.role === 'worker' && agents.state(value.binding.executionId)?.busy).length
        if (b.role === 'worker' && activeWorkers >= cache.settings.workerSeats) continue
        const context = await this.context(snapshot, action)
        if (this.stopping) return
        await cache.put('physical/' + b.executionId, { actionId: action.id, binding: b })
        if (this.stopping) return
        await agents.start(action, context, this.writer, this.options.wake)
      }
      } catch (error) { await recordReadError(cache, actionPath(action.binding), error) }
    }
    // A new input becomes runnable only through a separately committed action and a later snapshot.
    const foregroundActive = actions.some(action => action.state === 'active' && action.binding.role === 'foreground')
    if (!foregroundActive) {
      const prefix = 'dss-coop/intents/' + participantId + '/'
      for (const path of [...snapshot.files.keys()].filter(path => path.startsWith(prefix) && path.endsWith('.json')).sort()) {
        const input = await readJson<Omit<UserIntent, 'text'>>(repo, snapshot, path)
        if (!input || input.participantId !== participantId || input.instanceId !== cache.instanceId) continue
        const actionId = 'input-' + input.id
        if (actions.some(action => action.id === actionId)) continue
        await this.stage({ role: 'foreground', actionId, sourceIntentId: input.id, trigger: snapshot.files.get(path)!, input: { sourcePath: path }, epoch: 0 })
        changed = true; break
      }
    }
    let stageSeats = cache.settings.workerSeats - actions.filter(value => value.state === 'active' && value.binding.role === 'worker').length
    let pendingTasks = 0
    for (const grant of grants) {
      if (this.stopping) return
      try {
      await cache.remove('read-error/' + taskPath(grant.taskId) + '/contract.json')
      const task = await readJson<RootTask>(repo, snapshot, taskPath(grant.taskId) + '/contract.json')
      if (!task) {
        const history = await readJson<{ manifestPath: string }>(repo, snapshot, 'dss-coop/history/' + grant.taskId + '.json')
        if (history && await repo.read(snapshot, history.manifestPath) !== undefined) {
          this.reportCleanup(await releaseArchivedTaskCaches(cache, grant.taskId))
        }
        continue
      }
      const join = await readJson<Join>(repo, snapshot, grant.joinPath)
      if (!join || join.instanceId !== cache.instanceId || join.participantId !== participantId) continue

      if (join.state !== 'active') continue
      // Role bodies/indexes can arrive before their final status. Never hand off from those alone.
      if (!await recordPublished(repo, snapshot, join.writer) || !await recordPublished(repo, snapshot, task.writer)) { pendingTasks++; continue }
      const taskActions = actions.filter(action => action.binding.taskId === task.id)
      const activePlanner = taskActions.some(action => action.state === 'active' && action.binding.role === 'planner')
      if (task.status === 'accepted' || task.status === 'cancelled') {
        if (task.coordinatorParticipantId === participantId && !taskActions.some(action => action.state === 'active')) {
          const deliveryId = 'delivery-' + task.id + '-' + task.revision
          if (!taskActions.some(action => action.id === deliveryId)) {
            if (!foregroundActive) {
              await this.stage({ role: 'foreground', taskId: task.id, actionId: deliveryId, trigger: snapshot.files.get(taskPath(task.id) + '/contract.json')!,
                input: { notification: 'Deliver the task result to the local user. This is a notification, not new user authority.', taskId: task.id }, epoch: join.epoch })
              changed = true
            }
            continue
          }
          const finalizer = new CoopFinalizer(repo, this.options.journal(), cache)
          if (await finalizer.finalize(snapshot, task)) changed = true
        }
        continue
      }
      pendingTasks++
      const sharedPlan = await this.writer.rootPlan(snapshot, task.id)
      if (!await recordPublished(repo, snapshot, sharedPlan.writer)) continue
      const trigger = await plannerTrigger(repo, snapshot, task.id, participantId)
      const outcomes: RoleOutcome[] = []
      for (const action of taskActions.filter(value => value.binding.role === 'planner')) {
        const outcome = await readOutcome(repo, snapshot, action.binding)
        if (outcome) outcomes.push(outcome)
      }
      const question = outcomes.filter(outcome => outcome.kind === 'wait' && (outcome.question || outcome.turn_signal === 'error') && outcome.observedTrigger === trigger).at(-1)
      if (question && !foregroundActive && !taskActions.some(action => action.id === 'question-' + question.binding.executionId)) {
        await this.stage({ role: 'foreground', taskId: task.id, actionId: 'question-' + question.binding.executionId, trigger,
          input: { notification: question.question ?? 'The Planner reported an error. Read its bound outcome and inform the user.', question: !!question.question, sourceOutcome: question.binding.outputPath }, epoch: join.epoch })
        changed = true
      }
      if (!activePlanner && !outcomes.some(outcome => outcome.observedTrigger === trigger)) {
        await this.stage({ role: 'planner', taskId: task.id, actionId: 'plan-' + digest(task.id + trigger + join.epoch).slice(0, 36),
          trigger, input: { taskId: task.id, joinPath: grant.joinPath }, epoch: join.epoch })
        changed = true
      }
      const planFile = planPath(task.id, participantId, cache.instanceId)
      const plan = await readJson<ParticipantPlan>(repo, snapshot, planFile)
      if (!plan) continue
      const planOutcome = await readOutcome(repo, snapshot, plan.writer)
      if (!planOutcome || planOutcome.kind !== 'plan_ready') continue
      const rootPlan = await this.writer.rootPlan(snapshot, task.id)
      for (const child of plan.children) {
        if (child.state !== 'pending' || stageSeats <= 0 || child.dependencies.some(id => plan.children.find(value => value.id === id)?.state !== 'accepted')) continue
        const work = rootPlan.works.find(value => value.id === child.workId)
        const claimFile = participantPath(task.id, participantId) + '/instances/' + cache.instanceId + '/claims/' + child.workId + '.json'
        const claim = await readJson<Claim>(repo, snapshot, claimFile)
        if (!work || !claim || claim.joinRevision !== join.revision || work.version !== child.assignmentVersion
          || claim.assignmentVersion !== work.version || work.participantId !== participantId || work.instanceId !== cache.instanceId || join.goalRevision !== task.goalRevision) continue
        const actionId = 'work-' + digest(task.id + ':' + child.id + ':' + child.revision + ':' + work.version + ':' + join.epoch).slice(0, 36)
        if (taskActions.some(action => action.id === actionId)) continue
        await this.stage({ role: 'worker', taskId: task.id, actionId, trigger: snapshot.files.get(planFile)!,
          input: { taskId: task.id, child, claimPath: claimFile, joinPath: grant.joinPath }, epoch: join.epoch,
          childId: child.id, childRevision: child.revision, assignmentVersion: work.version })
        stageSeats--; changed = true
      }
      } catch (error) { pendingTasks++; await recordReadError(cache, taskPath(grant.taskId) + '/contract.json', error) }
    }
    await cache.put('pending-tasks', pendingTasks)
    if (changed) this.options.wake()
  }
  private async stage(input: Pick<RoleBinding, 'role' | 'taskId' | 'childId' | 'childRevision' | 'assignmentVersion' | 'sourceIntentId' | 'epoch'> & {
    actionId: string; trigger: string; input: unknown
  }): Promise<void> {
    const { cache } = this.options
    const binding: RoleBinding = { participantId: String(cache.connection()!.identity.id), instanceId: cache.instanceId,
      role: input.role, taskId: input.taskId, actionId: input.actionId, executionId: 'exec-' + randomUUID(),
      sessionId: 'dss-coop-' + randomUUID(), generation: 1, epoch: input.epoch, fence: randomUUID(),
      assignmentVersion: input.assignmentVersion, childId: input.childId, childRevision: input.childRevision, sourceIntentId: input.sourceIntentId, outputPath: '' }
    binding.outputPath = executionPath(binding) + '/outcome.json'
    const action: RoleAction = { id: input.actionId, binding, trigger: input.trigger, input: input.input, state: 'active', stateProtocol: 1, createdAt: new Date().toISOString() }
    const path = actionPath(binding)
    // Stable action ID deduplicates multiple syncs; the admitted object is retained for a lost Git reply.
    const pending = cache.get<RoleAction>('staged/' + path) ?? action
    await cache.put('staged/' + path, pending)
    await this.options.journal().transact('dispatch-' + digest(path).slice(0, 40), { path }, async snapshot => {
      if (await this.options.repo.read(snapshot, path) !== undefined) return []
      const changes = [{ path, content: json(pending) }, { path: executionPath(pending.binding) + '/binding.json', content: json(pending.binding) },
        ...await appendStatus(this.options.journal(), snapshot, { version: 1, kind: 'started', binding: pending.binding, createdAt: pending.createdAt })]
      const notice = (input.input as { gitChanges?: { to: string } }).gitChanges
      if (notice) changes.push({ path: 'dss-coop/instances/' + cache.instanceId + '/watch.json', content: json({ head: notice.to }) })
      return changes
    })
  }
  private async close(action: RoleAction, physical?: CoopPhysicalState, cancelled?: string, outcome?: RoleOutcome): Promise<void> {
    const { cache, agents } = this.options, path = actionPath(action.binding)
    if (cancelled && physical) await agents.release(action.binding.executionId, true)
    const closed: RoleAction = { ...action, state: 'closed' }, closedAt = new Date().toISOString()
    await cache.put('transition/' + path, closed)
    await this.options.journal().transact('close-' + action.binding.executionId, { path, cancelled }, async snapshot => {
      const current = await readJson<RoleAction>(this.options.repo, snapshot, path)
      if (!current || !sameBinding(current.binding, action.binding)) return []
      const changes: GitChange[] = [{ path, content: json(closed) }]
      const observedTrigger = outcome?.observedTrigger ?? (outcome && action.binding.role === 'planner' && action.binding.taskId
        ? await plannerTrigger(this.options.repo, snapshot, action.binding.taskId, action.binding.participantId) : undefined)
      changes.push(...await appendStatus(this.options.journal(), snapshot, { version: 1, kind: 'closed', binding: action.binding,
        createdAt: closedAt, observedTrigger, reason: cancelled }))
      if (physical) {
        changes.push(...textChanges(executionPath(action.binding) + '/transcript', physical.transcript))
        changes.push({ path: executionPath(action.binding) + '/physical-result.json', content: json({ jobs: physical.jobs, error: physical.error, cancelled, settled: !physical.busy || !!cancelled }) })
      }
      return changes
    })
    if (!physical?.busy || cancelled) {
      await agents.release(action.binding.executionId)
      await cache.remove('physical/' + action.binding.executionId)
    }
  }
  private async replace(action: RoleAction, reason: string, outcome?: RoleOutcome, physical?: CoopPhysicalState): Promise<void> {
    const { cache, repo, agents } = this.options, old = action.binding, path = actionPath(old)
    const pendingKey = 'replacement/' + old.executionId
    let replacement = cache.get<RoleAction>(pendingKey)
    if (!replacement) {
      const binding: RoleBinding = { ...old, executionId: 'exec-' + randomUUID(), sessionId: 'dss-coop-' + randomUUID(), generation: old.generation + 1, fence: randomUUID(), outputPath: '' }
      binding.outputPath = executionPath(binding) + '/outcome.json'
      replacement = { ...action, binding, stateProtocol: 1, createdAt: new Date().toISOString(), input: { original: action.input, recovery: { reason, previous: old, outcome } } }
      await cache.put(pendingKey, replacement)
    }
    const next = replacement
    await cache.put('transition/' + path, next)
    await this.options.journal().transact('recover-' + old.executionId, { path, next: next.binding.executionId }, async snapshot => {
      const current = await readJson<RoleAction>(repo, snapshot, path)
      if (!current || !sameBinding(current.binding, old)) throw new StaleCoopWrite('The recovery was superseded.')
      const changes: GitChange[] = [{ path, content: json(next) }, { path: executionPath(next.binding) + '/binding.json', content: json(next.binding) },
        { path: executionPath(old) + '/incident.json', content: json({ reason, previous: old, replacement: next.binding, jobs: physical?.jobs, createdAt: new Date().toISOString() }) }]
      changes.push(...await appendStatus(this.options.journal(), snapshot, { version: 1, kind: 'replaced', binding: old,
        successor: next.binding.executionId, reason, createdAt: next.createdAt }),
        ...await appendStatus(this.options.journal(), snapshot, { version: 1, kind: 'started', binding: next.binding, createdAt: next.createdAt }))
      if (physical) {
        changes.push(...textChanges(executionPath(old) + '/transcript', physical.transcript))
        changes.push({ path: executionPath(old) + '/physical-result.json', content: json({ jobs: physical.jobs, error: physical.error, settled: !physical.busy }) })
      }
      return changes
    })
    if (!physical?.busy) { await agents.release(old.executionId); await cache.remove('physical/' + old.executionId) }
  }
  async context(snapshot: GitSnapshot, action: RoleAction): Promise<unknown> {
    const { cache } = this.options, b = action.binding
    // Pass references, not prefetched documents. Each role chooses the relevant text through coop_read.
    return { binding: b, startupStatusPath: action.stateProtocol === 1 ? statusPath(b, 'started') : undefined, confirmedHead: snapshot.head, input: action.input, capacity: { workerSeats: cache.settings.workerSeats },
      inputPath: b.sourceIntentId ? 'dss-coop/intents/' + b.participantId + '/' + b.sourceIntentId + '.json' : undefined,
      conversationPrefix: 'dss-coop/conversations/' + b.participantId + '/',
      tasksPrefix: 'dss-coop/tasks/',
      roleRecordsPrefix: (b.taskId ? taskPath(b.taskId) : 'dss-coop/foreground') + '/executions/' + b.participantId + '/',
      taskPath: b.taskId ? taskPath(b.taskId) + '/contract.json' : undefined,
      participationPath: b.taskId ? joinPath(b.taskId, b.participantId, b.instanceId) : undefined,
      planPath: b.taskId ? planPath(b.taskId, b.participantId, b.instanceId) : undefined }
  }
  async retryNative(): Promise<void> {
    for (const [key] of this.options.cache.entries('native-error/')) await this.options.cache.remove(key)
    await this.options.cache.remove('runtime-error')
  }
  hasWork(): boolean {
    const cache = this.options.cache
    return !!cache.drafts().length || !!cache.entries('physical/').length || (cache.get<number>('pending-tasks') ?? 0) > 0
  }
  async dispose(): Promise<void> { this.stopping = true; await this.options.agents.dispose() }
}
