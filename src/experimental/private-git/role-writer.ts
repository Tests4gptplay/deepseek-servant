import type { CoopStore } from './cache.js'
import { readIntent } from './intake.js'
import { loadPaths } from './repository-paths.js'
import type { GitChange, GitRepository, GitSnapshot, RoleBinding, UserIntent } from './contracts.js'
import { digest, GitJournal, json, readJson, readText, textChanges } from './journal.js'
import {
  actionPath, CommandSchema, executionPath, joinPath, participantPath, planPath, sameBinding, RejectedCoopWrite, StaleCoopWrite, taskPath,
  type Claim, type CoopCommand, type Join, type ParticipantPlan, type RoleAction, type RoleOutcome, type RootPlan, type RootTask,
} from './protocol.js'

const bRoleRequiresActiveTask = (binding: RoleBinding): boolean => binding.role !== 'foreground' || !!binding.sourceIntentId
interface RoleDraft { id: string; kind: 'transaction'; createdAt: string; state: 'PENDING_UNCOMMITTED'; payload: { binding: RoleBinding; command: CoopCommand }; error?: string; stale?: boolean }

/** Only the installed native role calls this writer. Git paths and actors never come from model parameters. */
export class RoleWriter {
  constructor(readonly repo: GitRepository, readonly journal: GitJournal, readonly cache: CoopStore) {}
  async read<T>(snapshot: GitSnapshot, path: string): Promise<T | undefined> { return readJson<T>(this.repo, snapshot, path) }
  async current(snapshot: GitSnapshot, binding: RoleBinding): Promise<RoleAction> {
    const action = await this.read<RoleAction>(snapshot, actionPath(binding))
    if (!action || action.state !== 'active' || !sameBinding(action.binding, binding)) throw new StaleCoopWrite('This role execution was replaced or ended.')
    if (await this.repo.read(snapshot, binding.outputPath) !== undefined) throw new StaleCoopWrite('This role already committed its final outcome.')
    if (binding.role !== 'foreground' && !binding.taskId) throw new StaleCoopWrite('Planner and Worker executions need their task assignment.')
    if (binding.taskId) {
      const task = await this.task(snapshot, binding.taskId)
      const join = await this.read<Join>(snapshot, joinPath(task.id, binding.participantId, binding.instanceId))
      if (!join || join.state !== 'active' || join.epoch !== binding.epoch) throw new StaleCoopWrite('This participant paused, left or changed execution generation.')
      if (task.status === 'cancelled' && bRoleRequiresActiveTask(binding)) throw new StaleCoopWrite('This task was cancelled.')
      if (binding.role === 'worker') {
        const plan = await this.read<ParticipantPlan>(snapshot, planPath(task.id, binding.participantId, binding.instanceId))
        const child = plan?.children.find(value => value.id === binding.childId)
        const root = await this.rootPlan(snapshot, task.id)
        const work = root.works.find(value => value.id === child?.workId)
        if (join.goalRevision !== task.goalRevision || !child || child.state !== 'pending' || child.revision !== binding.childRevision || child.assignmentVersion !== binding.assignmentVersion
          || !work || work.version !== binding.assignmentVersion || work.participantId !== binding.participantId || work.instanceId !== binding.instanceId) {
          throw new StaleCoopWrite('This worker assignment changed. Its saved evidence remains available.')
        }
      }
    }
    return action
  }
  async task(snapshot: GitSnapshot, taskId: string): Promise<RootTask> {
    const task = await this.read<RootTask>(snapshot, taskPath(taskId) + '/contract.json')
    if (!task || task.id !== taskId) throw new RejectedCoopWrite('Task is unavailable: ' + taskId)
    return task
  }
  async rootPlan(snapshot: GitSnapshot, taskId: string): Promise<RootPlan> {
    return await this.read<RootPlan>(snapshot, taskPath(taskId) + '/plan.json') ?? { revision: 0, works: [] }
  }
  private async source(snapshot: GitSnapshot, b: RoleBinding, source: { sourcePath?: string; sourceRevision?: string }): Promise<UserIntent> {
    if (b.role !== 'foreground') throw new RejectedCoopWrite('Task intake belongs to the Foreground.')
    if (b.sourceIntentId) {
      const input = await readIntent(this.repo, snapshot, b.participantId, b.sourceIntentId)
      if (!input || input.participantId !== b.participantId || input.instanceId !== b.instanceId) throw new RejectedCoopWrite('The committed input belongs to another instance.')
      return input
    }
    const action = await this.read<RoleAction>(snapshot, actionPath(b))
    let input = action?.input as { original?: unknown; gitChanges?: unknown } | undefined
    while (input?.original) input = input.original as typeof input
    const notification = input?.gitChanges
    if (!notification) throw new RejectedCoopWrite('This execution has no task input or Git-change notification.')
    const at = source.sourceRevision && this.repo.at ? await this.repo.at(source.sourceRevision) : snapshot
    const text = source.sourcePath ? await this.repo.read(at, source.sourcePath) : json(notification)
    if (text === undefined) throw new RejectedCoopWrite('The source was deleted; use its parent commit from coop_changes.')
    return { id: 'remote-' + digest((source.sourcePath ?? b.actionId) + ':' + digest(text)).slice(0, 40),
      participantId: b.participantId, instanceId: b.instanceId, text, createdAt: action!.createdAt }
  }
  private async joined(snapshot: GitSnapshot, b: RoleBinding, taskId: string): Promise<Join> {
    const path = joinPath(taskId, b.participantId, b.instanceId)
    const join = await this.read<Join>(snapshot, path)
    if (!join || join.state !== 'active') throw new RejectedCoopWrite('This instance has not accepted participation in that task.')
    return join
  }
  async execute(binding: RoleBinding, input: unknown): Promise<{ commit: string; replay: boolean; refs: string[] }> {
    const command = CommandSchema.parse(input)
    const id = 'role-' + digest(binding.executionId + ':' + command.id).slice(0, 40)
    const key = 'draft/' + id
    const previous = this.cache.get<RoleDraft>(key)
    const draft: RoleDraft = previous ?? { id, kind: 'transaction', state: 'PENDING_UNCOMMITTED', createdAt: new Date().toISOString(), payload: { binding, command } }
    if (previous && json(previous.payload) !== json({ binding, command })) throw new RejectedCoopWrite('Use a new operation ID for different input.')
    await this.cache.put(key, draft)
    let refs: string[] = []
    try {
      const receipt = await this.journal.transact(id, { binding, command }, async snapshot => {
        await this.current(snapshot, binding)
        const changes = await this.build(snapshot, binding, command, draft.createdAt)
        refs = changes.filter(change => change.content !== null && !change.path.includes('/parts/')).map(change => change.path)
        return changes
      })
      await this.cache.remove(key)
      return { ...receipt, refs }
    } catch (error) {
      await this.cache.put(key, { ...draft, error: error instanceof Error ? error.message : String(error), stale: error instanceof RejectedCoopWrite })
      throw error
    }
  }
  async retryDrafts(): Promise<void> {
    for (const [, draft] of this.cache.entries<RoleDraft>('draft/')) {
      if (draft.kind !== 'transaction') continue
      if (!draft.stale) {
        try { await this.execute(draft.payload.binding, draft.payload.command); continue }
        catch (error) { if (!(error instanceof RejectedCoopWrite)) throw error; draft.error = error.message }
      }
      {
        const b = draft.payload.binding
        await this.journal.transact('late-' + draft.id, draft.payload, async snapshot => {
          const root = b.taskId && snapshot.files.has(taskPath(b.taskId) + '/contract.json')
            ? executionPath(b) + '/late-evidence/' + draft.id
            : 'dss-coop/incidents/' + b.participantId + '/' + b.executionId + '/' + draft.id
          return [...textChanges(root + '/command', json(draft.payload.command)), { path: root + '/incident.json',
            content: json({ binding: b, error: draft.error, createdAt: draft.createdAt, commandPath: root + '/command' }) }]
        })
        await this.cache.remove('draft/' + draft.id)
      }
    }
  }
  private async build(s: GitSnapshot, b: RoleBinding, c: CoopCommand, now: string): Promise<GitChange[]> {
    const object = (path: string, value: unknown): GitChange => ({ path, content: json(value) })
    const requireRole = (role: string) => { if (b.role !== role) throw new RejectedCoopWrite('This operation belongs to the ' + role + ' role.') }
    const requireTask = () => { if (!b.taskId) throw new RejectedCoopWrite('This role is not bound to a task.'); return b.taskId }
    const compare = (actual: number, expected: number) => { if (actual !== expected) throw new StaleCoopWrite('Revision changed from ' + expected + ' to ' + actual + '. Read the current record before revising it.') }
    const coordinator = async (): Promise<RootTask> => {
      requireRole('planner'); const task = await this.task(s, requireTask())
      if (task.coordinatorParticipantId !== b.participantId) throw new RejectedCoopWrite('Send a proposal to the current coordinator for shared plan changes.')
      return task
    }
    const root = b.taskId ? taskPath(b.taskId) : undefined
    const participant = b.taskId ? participantPath(b.taskId, b.participantId) + '/instances/' + b.instanceId : undefined
    const entry = executionPath(b) + '/entries/' + c.id
    if (c.op === 'root') {
      const source = await this.source(s, b, c)
      const id = 'task-' + source.id
      if (await this.repo.read(s, taskPath(id) + '/contract.json') !== undefined || await this.repo.read(s, 'dss-coop/history/' + id + '.json') !== undefined) throw new StaleCoopWrite('A task already exists for this input: ' + id)
      const goalPath = 'dss-coop/origins/' + id + '/goal/1'
      const task: RootTask = { id, title: c.title, originatingParticipantId: b.participantId, coordinatorParticipantId: b.participantId,
        originIntentId: source.id, originPath: 'dss-coop/origins/' + id + '/request', goalPath,
        revision: 1, goalRevision: 1, epoch: 1, status: 'active', createdAt: now, updatedAt: now, sourcePath: c.sourcePath, sourceRevision: c.sourceRevision }
      const join: Join = { taskId: id, participantId: b.participantId, instanceId: b.instanceId,
        sourceIntentId: source.id, sourceHash: digest(source.text), scope: c.goal, capabilities: '', revision: 1, epoch: 1,
        state: 'active', goalRevision: 1, writer: b }
      const path = joinPath(id, b.participantId, b.instanceId)
      return [...textChanges(task.originPath, source.text), ...textChanges(goalPath, c.goal),
        ...textChanges(taskPath(id) + '/initial-plan', c.initialPlan), object(taskPath(id) + '/contract.json', task),
        object(taskPath(id) + '/plan.json', { revision: 0, works: [] }), object(path, join)]
    }
    if (c.op === 'join') {
      const source = await this.source(s, b, c)
      const task = await this.task(s, c.taskId)
      if (!['active', 'waiting'].includes(task.status)) throw new RejectedCoopWrite('Choose an active collaboration task.')
      const path = joinPath(task.id, b.participantId, b.instanceId)
      const previous = await this.read<Join>(s, path)
      const join: Join = { taskId: task.id, participantId: b.participantId, instanceId: b.instanceId, sourceIntentId: source.id,
        sourceHash: digest(source.text), scope: c.scope, capabilities: c.capabilities, revision: (previous?.revision ?? 0) + 1,
        epoch: (previous?.epoch ?? 0) + 1, state: 'active', goalRevision: task.goalRevision, writer: b }
      return [object(path, join), ...textChanges(entry, source.text)]
    }
    if (c.op === 'control' || c.op === 'revise') {
      const source = await this.source(s, b, c)
      const task = await this.task(s, c.taskId)
      if (c.op === 'revise') {
        if (task.originatingParticipantId !== b.participantId) throw new RejectedCoopWrite('Only the originating user revises this goal.')
        compare(task.revision, c.expectedRevision)
        const revision = task.goalRevision + 1
        const goalPath = 'dss-coop/origins/' + task.id + '/goal/' + revision
        const path = joinPath(task.id, b.participantId, b.instanceId), previous = await this.joined(s, b, task.id)
        const join: Join = { ...previous, goalRevision: revision, revision: previous.revision + 1, epoch: previous.epoch + 1,
          sourceIntentId: source.id, sourceHash: digest(source.text), scope: c.goal, writer: b }
        return [...textChanges(goalPath, c.goal), object(path, join), object(taskPath(task.id) + '/contract.json', { ...task, goalPath, goalRevision: revision, revision: task.revision + 1, updatedAt: now })]
      }
      if (c.state === 'cancel') {
        if (task.originatingParticipantId !== b.participantId) throw new RejectedCoopWrite('Only the originating user cancels the shared goal. Other participants may leave.')
        compare(task.revision, c.expectedRevision)
        return [object(taskPath(task.id) + '/contract.json', { ...task, status: 'cancelled', revision: task.revision + 1, epoch: task.epoch + 1, updatedAt: now })]
      }
      const path = joinPath(task.id, b.participantId, b.instanceId)
      const previous = await this.read<Join>(s, path)
      if (!previous) throw new RejectedCoopWrite('This instance has no participation to change.')
      compare(previous.revision, c.expectedRevision)
      const join: Join = { ...previous, revision: previous.revision + 1, epoch: previous.epoch + 1,
        state: c.state === 'resume' ? 'active' : c.state === 'pause' ? 'paused' : 'left', writer: b }
      return [object(path, join)]
    }
    if (c.op === 'root_plan') {
      const task = await coordinator()
      const plan = await this.rootPlan(s, task.id); compare(plan.revision, c.expectedRevision)
      if (new Set(c.works.map(work => work.id)).size !== c.works.length) throw new RejectedCoopWrite('Work IDs must be unique.')
      for (const work of c.works) {
        const old = plan.works.find(value => value.id === work.id)
        if (old && json(old) !== json(work) && work.version !== old.version + 1) throw new RejectedCoopWrite('Changed assignments increment their version by one.')
        if (!old && work.version !== 1) throw new RejectedCoopWrite('New assignments start at version one.')
      }
      const changes: GitChange[] = [object(root + '/plan.json', { revision: plan.revision + 1, works: c.works })]
      for (const work of c.works) changes.push(object(root + '/assignments/' + work.id + '.json', work))
      for (const old of plan.works) if (!c.works.some(work => work.id === old.id)) changes.push({ path: root + '/assignments/' + old.id + '.json', content: null })
      return changes
    }
    if (c.op === 'proposal') {
      requireRole('planner'); requireTask()
      return [...textChanges(participant + '/proposals/' + c.id, c.text), object(participant + '/proposals/' + c.id + '.json', { writer: b, textPath: participant + '/proposals/' + c.id, createdAt: now })]
    }
    if (c.op === 'claim') {
      requireRole('planner'); const taskId = requireTask()
      const join = await this.joined(s, b, taskId)
      const task = await this.task(s, taskId)
      if (join.goalRevision !== task.goalRevision) throw new RejectedCoopWrite('The shared goal changed. Ask the local user to accept its revised scope before claiming new work.')
      const plan = await this.rootPlan(s, taskId), work = plan.works.find(value => value.id === c.workId)
      if (!work || work.version !== c.assignmentVersion || work.participantId !== b.participantId || work.instanceId !== b.instanceId) throw new StaleCoopWrite('The assignment is not offered to this instance at that version.')
      const claim: Claim = { taskId, workId: work.id, assignmentVersion: work.version, participantId: b.participantId, instanceId: b.instanceId, scope: c.scope, joinRevision: join.revision, writer: b }
      return [object(participant + '/claims/' + work.id + '.json', claim)]
    }
    if (c.op === 'participant_plan') {
      requireRole('planner'); const taskId = requireTask()
      const path = planPath(taskId, b.participantId, b.instanceId)
      const previous = await this.read<ParticipantPlan>(s, path) ?? { revision: 0, children: [] }
      compare(previous.revision, c.expectedRevision)
      const ids = new Set(c.children.map(child => child.id))
      if (ids.size !== c.children.length) throw new RejectedCoopWrite('Child IDs must be unique.')
      const visiting = new Set<string>(), seen = new Set<string>()
      const visit = (id: string): void => {
        if (visiting.has(id)) throw new RejectedCoopWrite('Child dependencies form a cycle.')
        if (seen.has(id)) return
        const child = c.children.find(value => value.id === id)
        if (!child) throw new RejectedCoopWrite('Unknown dependency: ' + id)
        visiting.add(id); child.dependencies.forEach(visit); visiting.delete(id); seen.add(id)
      }
      c.children.forEach(child => visit(child.id))
      const plan = await this.rootPlan(s, taskId)
      for (const child of c.children) {
        const claimFile = participant + '/claims/' + child.workId + '.json'
        const claim = await this.read<Claim>(s, claimFile), work = plan.works.find(value => value.id === child.workId)
        if (!claim || claim.assignmentVersion !== child.assignmentVersion
          || !work || work.version !== child.assignmentVersion) throw new RejectedCoopWrite('Accept the current assignment before planning its workers.')
      }
      const children = c.children.map(child => {
        const old = previous.children.find(value => value.id === child.id)
        if (old && json({ ...old, state: undefined, revision: undefined, result: undefined, review: undefined }) === json(child)) return old
        return { ...child, revision: (old?.revision ?? 0) + 1, state: 'pending' as const }
      })
      return [object(path, { revision: previous.revision + 1, children, writer: b })]
    }
    if (c.op === 'review') {
      requireRole('planner'); const taskId = requireTask()
      const path = planPath(taskId, b.participantId, b.instanceId), plan = await this.read<ParticipantPlan>(s, path)
      if (!plan) throw new RejectedCoopWrite('No participant plan.'); compare(plan.revision, c.expectedRevision)
      const child = plan.children.find(value => value.id === c.childId)
      const resultPath = taskPath(taskId) + '/executions/' + b.participantId + '/' + c.resultExecutionId + '/outcome.json'
      const outcome = await this.read<RoleOutcome>(s, resultPath)
      if (!child || !outcome || outcome.kind !== 'result' || outcome.binding.childId !== child.id || outcome.binding.assignmentVersion !== child.assignmentVersion) throw new StaleCoopWrite('Read the exact current child result before reviewing it.')
      const work = (await this.rootPlan(s, taskId)).works.find(value => value.id === child.workId)
      if (outcome.binding.childRevision !== child.revision || work?.version !== child.assignmentVersion || (c.accepted && outcome.resultStatus !== 'done')) throw new StaleCoopWrite('The result does not complete the current child revision.')
      const workerAction = await this.read<RoleAction>(s, actionPath(outcome.binding))
      if (!workerAction || !sameBinding(workerAction.binding, outcome.binding)) throw new StaleCoopWrite('This result belongs to a replaced execution.')
      const updated = { ...child, state: c.accepted ? 'accepted' as const : 'pending' as const, result: resultPath, review: c.review,
        revision: c.accepted ? child.revision : child.revision + 1, direction: c.nextDirection ?? child.direction }
      return [object(path, { ...plan, revision: plan.revision + 1, children: plan.children.map(value => value.id === child.id ? updated : value), writer: b }),
        object(participant + '/reviews/' + c.id + '.json', { writer: b, childId: child.id, resultPath, accepted: c.accepted, review: c.review, createdAt: now })]
    }
    if (c.op === 'report') {
      requireRole('planner'); const taskId = requireTask()
      const plan = await this.read<ParticipantPlan>(s, planPath(taskId, b.participantId, b.instanceId))
      const children = plan?.children.filter(child => child.workId === c.workId && child.assignmentVersion === c.assignmentVersion)
      if (!children?.length || children.some(child => child.state !== 'accepted')) throw new RejectedCoopWrite('Review and accept this assignment’s children before reporting completion.')
      return [...textChanges(entry, c.text), object(participant + '/reports/' + c.workId + '.json',
        { writer: b, workId: c.workId, assignmentVersion: c.assignmentVersion, review: c.review, textPath: entry, children: children.map(child => child.result), createdAt: now })]
    }
    if (c.op === 'accept') {
      const task = await coordinator(); compare(task.revision, c.expectedRevision)
      const plan = await this.rootPlan(s, task.id)
      for (const work of plan.works) {
        const report = await this.read<{ assignmentVersion: number }>(s, participantPath(task.id, work.participantId) + '/instances/' + work.instanceId + '/reports/' + work.id + '.json')
        if (!report || report.assignmentVersion !== work.version) throw new RejectedCoopWrite('A current assignment still needs its participant review: ' + work.id)
      }
      return [...textChanges(entry, c.text), object(root + '/acceptance.json', { writer: b, review: c.review, textPath: entry, createdAt: now }),
        object(root + '/contract.json', { ...task, status: 'accepted', revision: task.revision + 1, updatedAt: now })]
    }
    if (c.op === 'entry') {
      const permanent = ['knowledge', 'skill', 'preference'].includes(c.kind)
      const path = permanent ? 'dss-coop/knowledge/' + b.participantId + '/' + c.kind + '/' + b.executionId + '-' + c.id : entry + '/' + c.kind
      return [...textChanges(path, c.text), object(path + '/source.json', { writer: b, kind: c.kind, createdAt: now })]
    }
    if (c.op === 'outcome') {
      if (b.role === 'foreground' && !['respond', 'handoff_planner'].includes(c.kind)) throw new RejectedCoopWrite('Foreground outcomes are respond or handoff_planner.')
      if (b.role === 'planner' && !['plan_ready', 'wait', 'continue', 'complete'].includes(c.kind)) throw new RejectedCoopWrite('Choose a Planner outcome.')
      if (b.role === 'worker' && !['result', 'continue'].includes(c.kind)) throw new RejectedCoopWrite('Choose a Worker outcome.')
      if (c.kind === 'handoff_planner') {
        if (!c.taskId) throw new RejectedCoopWrite('Choose the task for this handoff.')
        const join = await this.joined(s, b, c.taskId)
        if (join.writer.executionId !== b.executionId) throw new RejectedCoopWrite('Join or create this task from the current user input before handing it to the Planner.')
      }
      if (c.question && (b.role !== 'planner' || c.kind !== 'wait')) throw new RejectedCoopWrite('A local-user question belongs to a Planner wait outcome.')
      const refs = [...c.prerequisitePaths]
      if (b.taskId) refs.push(taskPath(b.taskId) + '/contract.json')
      if (c.taskId) refs.push(joinPath(c.taskId, b.participantId, b.instanceId))
      for (const path of refs) {
        if (await this.repo.read(s, path) === undefined) throw new RejectedCoopWrite('Commit the prerequisite before its outcome: ' + path)
        if (path.endsWith('/manifest.json')) await readText(this.repo, s, path.slice(0, -'/manifest.json'.length))
      }
      const outputRoot = executionPath(b) + '/output'
      const conversation = 'dss-coop/conversations/' + b.participantId + '/' + now.slice(0, 10) + '/' + now.replace(/\D/g, '') + '-' + b.executionId
      const textPath = b.role === 'foreground' ? conversation + '/text' : outputRoot + '/text'
      const changes = textChanges(textPath, c.text)
      if (c.memory) changes.push(...textChanges(outputRoot + '/memory', c.memory))
      if (c.note) changes.push(...textChanges(outputRoot + '/note', c.note))
      const outcome: RoleOutcome & { observedTrigger?: string } = { binding: b, kind: c.kind, textPath, taskId: c.taskId ?? b.taskId,
        memoryPath: c.memory ? outputRoot + '/memory' : undefined, notePath: c.note ? outputRoot + '/note' : undefined,
        prerequisitePaths: [...new Set(refs)], resultStatus: c.resultStatus, question: c.question, createdAt: now }
      if (b.role === 'planner' && b.taskId) outcome.observedTrigger = await plannerTrigger(this.repo, s, b.taskId, b.participantId)
      changes.push(object(b.outputPath, outcome))
      if (b.role === 'foreground') {
        changes.push(object(conversation + '/entry.json', { id: b.executionId, role: 'assistant', textPath: outcome.textPath, createdAt: now, writer: b }))
      }
      return changes
    }
    throw new RejectedCoopWrite('Unknown collaboration operation.')
  }
}

export async function plannerTrigger(repo: GitRepository, snapshot: GitSnapshot, taskId: string, participantId: string): Promise<string> {
  const prefix = taskPath(taskId) + '/'
  await loadPaths(repo, snapshot, prefix)
  const selected: Array<[string, string]> = []
  for (const [path, sha] of snapshot.files) {
    if (!path.startsWith(prefix)) continue
    if (path === prefix + 'contract.json' || path === prefix + 'plan.json'
      || path.endsWith('/join.json') || /\/(proposals|reports)\/[^/]+\.json$/.test(path)) selected.push([path, sha])
    else if (path.startsWith(prefix + 'executions/' + participantId + '/') && path.endsWith('/outcome.json')) {
      const result = await readJson<RoleOutcome>(repo, snapshot, path)
      if (result?.binding.role === 'worker' && result.kind === 'result') selected.push([path, sha])
    }
  }
  return digest(json(selected.sort(([a], [b]) => a.localeCompare(b))))
}
