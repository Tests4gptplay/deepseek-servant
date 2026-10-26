import { randomUUID } from 'node:crypto'
import type { CoopStore } from './cache.js'
import type { GitChange, GitRepository, GitSnapshot, RoleBinding, UserIntent } from './contracts.js'
import { digest, GitJournal, json, readJson, readText, textChanges } from './journal.js'
import { RoleWriter, plannerTrigger } from './role-writer.js'
import { actionPath, executionPath, joinPath, participantPath, planPath, sameBinding, StaleCoopWrite, taskPath,
  type ChildState, type Claim, type Join, type LocalGrant, type ParticipantPlan, type RoleAction, type RoleOutcome, type RootTask } from './protocol.js'
import { CoopFinalizer } from './finalizer.js'
import { conversationPaths, conversationHeader, conversationText } from './conversation.js'

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
      const action = await readJson<RoleAction>(this.options.repo, snapshot, path)
      const transition = cache.get<RoleAction>('transition/' + path)
      if (action && transition && json(action) === json(transition)) {
        await cache.put('admission/' + path, digest(json(action)))
        await cache.remove('transition/' + path)
      }
      if (action?.binding && action.binding.participantId === participant && action.binding.instanceId === cache.instanceId
        && actionPath(action.binding) === path && cache.get<string>('admission/' + path) === digest(json(action))) actions.push(action)
    }
    return actions
  }
  async consume(snapshot: GitSnapshot): Promise<void> {
    if (this.stopping) return
    const { cache, repo, agents } = this.options
    const participantId = cache.connection()!.identity.id.toString()
    let changed = false
    const actions = await this.actions(snapshot)
    for (const action of actions.filter(value => value.state === 'active')) {
      const b = action.binding
      const physical = agents.state(b.executionId)
      const outcome = await readJson<RoleOutcome>(repo, snapshot, b.outputPath)
      const validOutcome = outcome && sameBinding(outcome.binding, b) && await this.writer.proven(snapshot, b.outputPath)
      if (validOutcome) {
        await this.validateOutcome(snapshot, outcome)
        await cache.remove('native-error/' + action.id)
        if (physical?.busy || (physical && !physical.finished)) continue
        if (outcome.kind === 'continue' || (outcome.kind === 'result' && outcome.resultStatus === 'handoff')) {
          await this.replace(action, 'Role handoff', outcome, physical); changed = true
        } else {
          await this.close(action, physical); changed = true
        }
        continue
      }
      try { await this.writer.current(snapshot, b) }
      catch (error) {
        if (!(error instanceof StaleCoopWrite)) throw error
        await this.close(action, physical, error.message); changed = true; continue
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
        const activeWorkers = actions.filter(value => value.state === 'active' && value.binding.role === 'worker' && agents.state(value.binding.executionId)?.busy).length
        if (b.role === 'worker' && activeWorkers >= cache.settings.workerSeats) continue
        const context = await this.context(snapshot, action)
        await cache.put('physical/' + b.executionId, { actionId: action.id, binding: b })
        await agents.start(action, context, this.writer, this.options.wake)
      }
    }
    // A new input becomes runnable only through a separately committed action and a later snapshot.
    const foregroundActive = actions.some(action => action.state === 'active' && action.binding.role === 'foreground')
    if (!foregroundActive) {
      for (const [, input] of cache.entries<UserIntent>('user-source/').sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt))) {
        if (input.participantId !== participantId || input.instanceId !== cache.instanceId) continue
        const path = 'dss-coop/intents/' + participantId + '/' + input.id + '.json'
        const confirmed = await readJson<UserIntent & { textPath: string }>(repo, snapshot, path)
        if (!confirmed || confirmed.instanceId !== cache.instanceId || await readText(repo, snapshot, confirmed.textPath) !== input.text) continue
        const actionId = 'input-' + input.id
        if (actions.some(action => action.id === actionId)) continue
        await this.stage({ role: 'foreground', actionId, sourceIntentId: input.id, trigger: snapshot.files.get(path)!, input: { sourcePath: path }, epoch: 0 })
        changed = true; break
      }
    }
    let stageSeats = cache.settings.workerSeats - actions.filter(value => value.state === 'active' && value.binding.role === 'worker').length
    let pendingTasks = 0
    for (const [, grant] of cache.entries<LocalGrant>('grant/')) {
      const task = await readJson<RootTask>(repo, snapshot, taskPath(grant.taskId) + '/contract.json')
      if (!task) {
        const history = await readJson<{ manifestPath: string }>(repo, snapshot, 'dss-coop/history/' + grant.taskId + '.json')
        if (history && snapshot.files.has(history.manifestPath)) {
          await cache.remove('grant/' + grant.taskId)
          for (const [key] of cache.entries('')) if (key.includes(taskPath(grant.taskId) + '/')) await cache.remove(key)
        }
        continue
      }
      const join = await readJson<Join>(repo, snapshot, grant.joinPath)
      if (!join || !await this.writer.proven(snapshot, grant.joinPath) || join.instanceId !== cache.instanceId || join.participantId !== participantId) continue
      const source = cache.get<UserIntent>('user-source/' + join.sourceIntentId)
      if (!source || source.instanceId !== cache.instanceId || digest(source.text) !== join.sourceHash) continue
      const foregroundOutcome = await readJson<RoleOutcome>(repo, snapshot, join.writer.outputPath)
      if (!foregroundOutcome || !await this.writer.proven(snapshot, join.writer.outputPath) || !sameBinding(foregroundOutcome.binding, join.writer)) continue
      if (join.state !== 'active') continue
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
      const trigger = await plannerTrigger(repo, snapshot, task.id, participantId)
      const outcomes: RoleOutcome[] = []
      for (const action of taskActions.filter(value => value.binding.role === 'planner')) {
        const outcome = await readJson<RoleOutcome>(repo, snapshot, action.binding.outputPath)
        if (outcome && await this.writer.proven(snapshot, action.binding.outputPath)) outcomes.push(outcome)
      }
      const question = outcomes.filter(outcome => outcome.kind === 'wait' && outcome.question && outcome.observedTrigger === trigger).at(-1)
      if (question && !foregroundActive && !taskActions.some(action => action.id === 'question-' + question.binding.executionId)) {
        await this.stage({ role: 'foreground', taskId: task.id, actionId: 'question-' + question.binding.executionId, trigger,
          input: { notification: question.question, question: true, sourceOutcome: question.binding.outputPath }, epoch: join.epoch })
        changed = true
      }
      if (!activePlanner && !outcomes.some(outcome => outcome.observedTrigger === trigger)) {
        await this.stage({ role: 'planner', taskId: task.id, actionId: 'plan-' + digest(task.id + trigger + join.epoch).slice(0, 36),
          trigger, input: { taskId: task.id, joinPath: grant.joinPath }, epoch: join.epoch })
        changed = true
      }
      const planFile = planPath(task.id, participantId, cache.instanceId)
      const plan = await readJson<ParticipantPlan>(repo, snapshot, planFile)
      if (!plan || !await this.writer.proven(snapshot, planFile)) continue
      const planOutcome = await readJson<RoleOutcome>(repo, snapshot, plan.writer.outputPath)
      if (!planOutcome || !await this.writer.proven(snapshot, plan.writer.outputPath) || !['plan_ready', 'wait'].includes(planOutcome.kind)) continue
      await this.validateOutcome(snapshot, planOutcome)
      const rootPlan = await this.writer.rootPlan(snapshot, task.id)
      for (const child of plan.children) {
        if (child.state !== 'pending' || stageSeats <= 0 || child.dependencies.some(id => plan.children.find(value => value.id === id)?.state !== 'accepted')) continue
        const work = rootPlan.works.find(value => value.id === child.workId)
        const claimFile = participantPath(task.id, participantId) + '/instances/' + cache.instanceId + '/claims/' + child.workId + '.json'
        const claim = await readJson<Claim>(repo, snapshot, claimFile)
        if (!work || !claim || !await this.writer.proven(snapshot, claimFile) || claim.joinRevision !== join.revision || work.version !== child.assignmentVersion
          || claim.assignmentVersion !== work.version || work.participantId !== participantId || work.instanceId !== cache.instanceId || join.goalRevision !== task.goalRevision) continue
        const actionId = 'work-' + digest(task.id + ':' + child.id + ':' + child.revision + ':' + work.version + ':' + join.epoch).slice(0, 36)
        if (taskActions.some(action => action.id === actionId)) continue
        await this.stage({ role: 'worker', taskId: task.id, actionId, trigger: snapshot.files.get(planFile)!,
          input: { taskId: task.id, child, claimPath: claimFile, joinPath: grant.joinPath }, epoch: join.epoch,
          childId: child.id, childRevision: child.revision, assignmentVersion: work.version })
        stageSeats--; changed = true
      }
    }
    await cache.put('pending-tasks', pendingTasks)
    if (changed) this.options.wake()
  }
  private async validateOutcome(snapshot: GitSnapshot, outcome: RoleOutcome): Promise<void> {
    for (const ref of outcome.prerequisitePaths) if (!snapshot.files.has(ref)) throw new Error('The outcome is missing its prerequisite: ' + ref)
    await readText(this.options.repo, snapshot, outcome.textPath)
    if (outcome.memoryPath) await readText(this.options.repo, snapshot, outcome.memoryPath)
    if (outcome.notePath) await readText(this.options.repo, snapshot, outcome.notePath)
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
    const action: RoleAction = { id: input.actionId, binding, trigger: input.trigger, input: input.input, state: 'active', createdAt: new Date().toISOString() }
    const path = actionPath(binding)
    // Stable action ID deduplicates multiple syncs; the admitted object is retained for a lost Git reply.
    const pending = cache.get<RoleAction>('staged/' + path) ?? action
    await cache.put('staged/' + path, pending)
    await this.options.journal().transact('dispatch-' + digest(path).slice(0, 40), { path }, async snapshot => {
      if (snapshot.files.has(path)) throw new Error('The action path is already occupied.')
      await cache.put('admission/' + path, digest(json(pending)))
      return [{ path, content: json(pending) }, { path: executionPath(pending.binding) + '/binding.json', content: json(pending.binding) }]
    })
  }
  private async close(action: RoleAction, physical?: CoopPhysicalState, cancelled?: string): Promise<void> {
    const { cache, agents } = this.options, path = actionPath(action.binding)
    if (cancelled && physical) await agents.release(action.binding.executionId, true)
    const closed: RoleAction = { ...action, state: 'closed' }
    await cache.put('transition/' + path, closed)
    await this.options.journal().transact('close-' + action.binding.executionId, { path, cancelled }, async snapshot => {
      const current = await readJson<RoleAction>(this.options.repo, snapshot, path)
      if (!current || !sameBinding(current.binding, action.binding)) return []
      const changes: GitChange[] = [{ path, content: json(closed) }]
      if (physical) {
        changes.push(...textChanges(executionPath(action.binding) + '/transcript', physical.transcript))
        changes.push({ path: executionPath(action.binding) + '/physical-result.json', content: json({ jobs: physical.jobs, error: physical.error, cancelled }) })
      }
      return changes
    })
    await cache.put('admission/' + path, digest(json(closed)))
    await agents.release(action.binding.executionId)
    await cache.remove('physical/' + action.binding.executionId)
  }
  private async replace(action: RoleAction, reason: string, outcome?: RoleOutcome, physical?: CoopPhysicalState): Promise<void> {
    const { cache, repo, agents } = this.options, old = action.binding, path = actionPath(old)
    const pendingKey = 'replacement/' + old.executionId
    let replacement = cache.get<RoleAction>(pendingKey)
    if (!replacement) {
      const binding: RoleBinding = { ...old, executionId: 'exec-' + randomUUID(), sessionId: 'dss-coop-' + randomUUID(), generation: old.generation + 1, fence: randomUUID(), outputPath: '' }
      binding.outputPath = executionPath(binding) + '/outcome.json'
      replacement = { ...action, binding, input: { original: action.input, recovery: { reason, previous: old, outcome } } }
      await cache.put(pendingKey, replacement)
    }
    const next = replacement
    await cache.put('transition/' + path, next)
    await this.options.journal().transact('recover-' + old.executionId, { path, next: next.binding.executionId }, async snapshot => {
      const current = await readJson<RoleAction>(repo, snapshot, path)
      if (!current || !sameBinding(current.binding, old)) throw new StaleCoopWrite('The recovery was superseded.')
      const changes: GitChange[] = [{ path, content: json(next) }, { path: executionPath(next.binding) + '/binding.json', content: json(next.binding) },
        { path: executionPath(old) + '/incident.json', content: json({ reason, previous: old, replacement: next.binding, jobs: physical?.jobs, createdAt: new Date().toISOString() }) }]
      if (physical) changes.push(...textChanges(executionPath(old) + '/transcript', physical.transcript))
      return changes
    })
    await cache.put('admission/' + path, digest(json(next)))
    await agents.release(old.executionId); await cache.remove('physical/' + old.executionId)
  }
  async context(snapshot: GitSnapshot, action: RoleAction): Promise<unknown> {
    const { cache, repo } = this.options, b = action.binding
    const base = { binding: b, confirmedHead: snapshot.head, input: action.input, capacity: { workerSeats: cache.settings.workerSeats } }
    if (b.role === 'foreground') {
      if (!b.sourceIntentId && b.taskId) {
        const task = await this.writer.task(snapshot, b.taskId)
        const records = [...snapshot.files.keys()].filter(path => path.startsWith(taskPath(task.id) + '/') && (path.endsWith('/acceptance.json') || path.includes('/reports/')))
        return { ...base, notification: true, task, originalRequest: await readText(repo, snapshot, task.originPath), records,
          instructions: (action.input as { question?: boolean }).question
            ? 'Present the Planner question from input.notification to the local user using a respond outcome. Wait for an actual local reply before changing participation or the task.'
            : 'Deliver the confirmed result and useful artifact references using a respond outcome. This notification grants no new user intent.' }
      }
      const source = cache.get<UserIntent>('user-source/' + b.sourceIntentId)!
      const history: unknown[] = [], tasks: unknown[] = []
      let rounds = 0
      for (const path of conversationPaths(snapshot, b.participantId)) {
        const entry = await conversationHeader(repo, cache, snapshot, path)
        if (!entry || entry.createdAt >= source.createdAt) continue
        history.unshift(await conversationText(repo, cache, snapshot, entry))
        if (entry.role === 'user' && ++rounds === 6) break
      }
      for (const path of snapshot.files.keys()) if (/^dss-coop\/tasks\/[^/]+\/contract.json$/.test(path)) {
        const task = await readJson<RootTask>(repo, snapshot, path)
        if (task && ['active', 'waiting'].includes(task.status)) tasks.push(task)
      }
      return { ...base, actualLocalUserInput: source.text, recentConversation: history, activeTasks: tasks }
    }
    const task = await this.writer.task(snapshot, b.taskId!)
    const join = await readJson<Join>(repo, snapshot, joinPath(task.id, b.participantId, b.instanceId))
    const plan = await readJson<ParticipantPlan>(repo, snapshot, planPath(task.id, b.participantId, b.instanceId))
    const refs = [...snapshot.files.keys()].filter(path => path.startsWith(taskPath(task.id) + '/') && (path.endsWith('/outcome.json') || /\/(reports|proposals)\/[^/]+\.json$/.test(path)))
    return { ...base, task, originalRequest: await readText(repo, snapshot, task.originPath), goal: await readText(repo, snapshot, task.goalPath),
      localParticipation: join, rootPlan: await this.writer.rootPlan(snapshot, task.id), participantPlan: plan, recordRefs: refs.slice(-80), recordCount: refs.length, recordPrefix: taskPath(task.id) + '/' }
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
