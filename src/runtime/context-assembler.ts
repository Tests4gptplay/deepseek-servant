import type { KnowledgeRecord } from '../contracts/knowledge.js'
import type { Child, CommandSource, DecisionRecord, ExecutionBinding, ExecutionReport, PendingAction, Task, WaitRecord } from '../contracts/task.js'

/** References identify local authoritative Task data, never a Git transport or Session transcript. */
export type MemorySection = 'goal' | 'origin' | 'plan' | 'children' | 'planner' | 'note' | 'child' | 'report' | 'incident' | 'execution' | 'wait' | 'waits'
export interface TaskMemoryQuery { ref: string; offset?: number; limit?: number; characterOffset?: number }
export interface MemoryRead extends TaskMemoryQuery { purpose: string }
export interface TaskMemoryPage { ref: string; taskRevision: number; offset: number; total: number; entries: unknown[]; text?: string; textFormat?: 'json'; characterOffset?: number; totalCharacters?: number; next?: TaskMemoryQuery }
export interface MemoryEntry {
  kind: 'work' | 'feedback' | 'recovery'
  sequence: number
  at: string
  ref: string
  exactRead?: TaskMemoryQuery
  resultId?: string
  executionId?: string
  assignmentVersion?: number
  outcome?: string
  summary: string
  frontier?: string
  evidence?: string[]
  artifacts?: ExecutionReport['artifacts']
  checkpoint?: ExecutionReport['checkpoint']
  goalRevision: number
}

const HOT_ENTRIES = 6
const HOT_FAILURES = 6
const HOT_CHILDREN = 24
const MAX_PAGE = 50
const own = <T>(map: Record<string, T>, id: string): T | undefined => Object.hasOwn(map, id) ? map[id] : undefined
const clipped = (value: string, limit = 1600): string => value.length > limit ? `${value.slice(0, limit)}\n[Truncated in handoff; read its exact memory ref for the remainder.]` : value
const recent = <T>(values: T[], count = HOT_ENTRIES): T[] => values.slice(Math.max(0, values.length - count))
const hotStrings = (values: string[], count = 12, length = 800) => values.slice(0, count).map(value => clipped(value, length))
const hotArtifacts = (values: ExecutionReport['artifacts']) => values.slice(0, 12).map(value => ({ ...value, description: clipped(value.description, 500) }))
function hotNote(task: Task) {
  const note = task.plannerNote!
  return { revision: note.revision, goalRevision: note.goalRevision, body: clipped(note.body, 3000), frontier: clipped(note.frontier, 1200),
    currentGoal: note.goalRevision === task.goal.revision, ref: memoryRef(task.id, 'note'),
    backlog: (note.backlog ?? []).slice(0, 20).map(item => ({ ...item, objective: clipped(item.objective, 500), reason: clipped(item.reason, 500),
      trigger: clipped(item.trigger, 500), dependsOn: item.dependsOn.slice(0, 24) })),
    backlogCount: note.backlog?.length ?? 0, requiredPendingCount: note.backlog?.filter(item => item.required && item.status === 'pending').length ?? 0 }
}

export function memoryRef(taskId: string, section: MemorySection, id?: string): string {
  return `servant-memory://tasks/${encodeURIComponent(taskId)}/${section}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`
}
function parseRef(task: Task, ref: string): { section: MemorySection; id?: string } {
  const match = /^servant-memory:\/\/tasks\/([^/]+)\/(goal|origin|plan|children|planner|note|child|report|incident|execution|wait|waits)(?:\/([^/]+))?$/.exec(ref)
  if (!match || decodeURIComponent(match[1]) !== task.id) throw new Error('MEMORY_SCOPE: Read a reference belonging to this exact Task.')
  const section = match[2] as MemorySection
  const id = match[3] === undefined ? undefined : decodeURIComponent(match[3])
  if (['child', 'report', 'incident', 'execution', 'wait'].includes(section) !== (id !== undefined)) throw new Error('MEMORY_REF: This memory section needs its exact record identity.')
  return { section, ...(id ? { id } : {}) }
}
function caller(task: Task, supplied: ExecutionBinding | undefined): ExecutionBinding | undefined {
  if (!supplied) return undefined // Trusted application boundary checks user/assistant scope.
  const current = own(task.executions, supplied.executionId)
  if (!current || current.agentId !== supplied.agentId || current.sessionId !== supplied.sessionId || current.role !== supplied.role || current.state !== 'active') {
    throw new Error('MEMORY_OWNER: This role instance no longer owns the Task capability.')
  }
  return current
}
function childScope(task: Task, execution: ExecutionBinding): Set<string> {
  const childId = execution.childId ?? (execution.incidentId ? task.incidents[execution.incidentId]?.childId : undefined)
  const ids = new Set<string>()
  const add = (id: string) => { if (ids.has(id)) return; ids.add(id); for (const dep of task.children[id]?.dependsOn ?? []) add(dep) }
  if (childId) add(childId)
  return ids
}
function authorize(task: Task, execution: ExecutionBinding | undefined, section: MemorySection, id?: string): void {
  if (!execution || execution.role === 'planner' || execution.role === 'foreground') return
  if (['goal', 'origin'].includes(section)) return
  if (section === 'waits') return // Individual entries are scoped before paging.
  if (section === 'wait' && waitVersions(task, id!).some(entry => visibleWait(task, execution, entry.wait))) return
  const allowed = childScope(task, execution)
  if (section === 'child' && allowed.has(id!)) return
  if (section === 'report' && allowed.has(own(task.reports, id!)?.childId ?? '')) return
  if (section === 'execution') {
    const target = own(task.executions, id!)
    if (target && (target.executionId === execution.executionId || (!!target.childId && allowed.has(target.childId))
      || (!!execution.incidentId && task.incidents[execution.incidentId]?.executionId === target.executionId))) return
  }
  if (section === 'incident') {
    const target = own(task.incidents, id!)
    if (target && (execution.incidentId === target.id || (!!target.childId && allowed.has(target.childId)))) return
  }
  throw new Error('MEMORY_SCOPE: This role may read only its assignment, accepted dependencies, and bound recovery incident.')
}

interface WaitMemory { wait: WaitRecord; sequence: number; goalRevision: number; source?: CommandSource; current: boolean }
function visibleWait(task: Task, execution: ExecutionBinding | undefined, wait: WaitRecord): boolean {
  return !execution || execution.role === 'planner' || execution.role === 'foreground' || !wait.childId
    || childScope(task, execution).has(wait.childId) || wait.executionId === execution.executionId
    || (!!execution.incidentId && wait.incidentId === execution.incidentId)
}
/** A repeated wait id keeps each answer; existing records without snapshots remain readable. */
function waitVersions(task: Task, id: string): WaitMemory[] {
  const history: WaitMemory[] = task.decisions.filter(entry => entry.resolvedWait?.id === id).map(entry => ({
    wait: entry.resolvedWait!, sequence: entry.sequence ?? 0, goalRevision: entry.goalRevision, source: entry.source, current: false,
  }))
  const current = own(task.waits, id)
  if (current) {
    const saved = JSON.stringify(current)
    let same = -1
    for (let index = 0; index < history.length; index++) if (JSON.stringify(history[index].wait) === saved) same = index
    if (same >= 0) history[same].current = true
    else history.push({ wait: current, sequence: 0, goalRevision: current.executionId ? task.executions[current.executionId]?.goalRevision ?? task.goal.revision : task.goal.revision, current: true })
  }
  return history
}
function waitMemory(task: Task, execution?: ExecutionBinding): Array<WaitMemory & { exactRef: string; exactRead: TaskMemoryQuery }> {
  const ids = new Set([...Object.keys(task.waits), ...task.decisions.flatMap(entry => entry.resolvedWait ? [entry.resolvedWait.id] : [])])
  return [...ids].flatMap(id => waitVersions(task, id).filter(entry => visibleWait(task, execution, entry.wait)).map((entry, index) => ({ ...entry,
    exactRef: memoryRef(task.id, 'wait', id), exactRead: { ref: memoryRef(task.id, 'wait', id), offset: index, limit: 1 },
  }))).sort((a, b) => a.sequence && b.sequence ? a.sequence - b.sequence : (a.wait.resolvedAt ?? a.wait.createdAt).localeCompare(b.wait.resolvedAt ?? b.wait.createdAt))
}
function waitView(task: Task, entry: WaitMemory & { exactRef: string; exactRead: TaskMemoryQuery }, hot = false) {
  const wait = entry.wait
  const owner = wait.executionId ? task.executions[wait.executionId] : undefined
  return { ...structuredClone(wait),
    ...(hot ? { reason: clipped(wait.reason, 800), condition: clipped(wait.condition, 1200), resume: clipped(wait.resume, 1200),
      ...(wait.question ? { question: clipped(wait.question, 1200) } : {}), ...(wait.answer ? { answer: clipped(wait.answer, 2400) } : {}) } : {}),
    goalRevision: entry.goalRevision, current: entry.current,
    ...(entry.source ? { resolvedBy: entry.source } : {}),
    ...(owner ? { originalOwner: { executionId: owner.executionId, sessionId: owner.sessionId, agentId: owner.agentId, role: owner.role,
      ...(owner.childId ? { childId: owner.childId, assignmentVersion: owner.assignmentVersion } : {}), ref: memoryRef(task.id, 'execution', owner.executionId) } } : {}),
    exactRef: entry.exactRef, exactRead: entry.exactRead,
  }
}

/** One append-only logical child ledger, derived from authoritative reports and decisions. */
export function childMemory(task: Task, childId: string): MemoryEntry[] {
  if (!own(task.children, childId)) throw new Error('MEMORY_NOT_FOUND: Child does not exist.')
  const entries: MemoryEntry[] = Object.values(task.reports).filter(report => report.childId === childId).map(report => ({
    kind: 'work', sequence: report.sequence ?? 0, at: report.receivedAt,
    ref: memoryRef(task.id, 'report', report.resultId), resultId: report.resultId,
    executionId: report.executionId, assignmentVersion: report.assignmentVersion,
    outcome: report.outcome, summary: report.summary, frontier: report.frontier,
    evidence: [...report.evidence], artifacts: structuredClone(report.artifacts),
    ...(report.checkpoint ? { checkpoint: structuredClone(report.checkpoint) } : {}), goalRevision: report.goalRevision,
  }))
  task.decisions.forEach(entry => {
    for (const feedback of entry.childDecisions ?? []) if (feedback.childId === childId) entries.push({
      kind: 'feedback', sequence: entry.sequence ?? 0, at: entry.at,
      ref: memoryRef(task.id, 'child', childId), resultId: feedback.resultId,
      assignmentVersion: feedback.assignmentVersion, outcome: feedback.outcome, summary: feedback.reason,
      ...(entry.frontier ? { frontier: entry.frontier } : {}), evidence: [memoryRef(task.id, 'report', feedback.resultId), `decision:${entry.commandId}`], goalRevision: entry.goalRevision,
    })
    if (entry.kind === 'recovery' && entry.childId === childId) entries.push({
      kind: 'recovery', sequence: entry.sequence ?? 0, at: entry.at,
      ref: entry.incidentId ? memoryRef(task.id, 'incident', entry.incidentId) : memoryRef(task.id, 'execution', entry.executionId!),
      ...(entry.executionId ? { executionId: entry.executionId } : {}), outcome: entry.recoveryOutcome,
      summary: entry.summary, evidence: entry.physicalDisposition ? [`Observed ${entry.physicalDisposition.state}; recorded jobs: ${entry.physicalDisposition.ownedJobIds.join(', ') || 'none'}.`] : [], goalRevision: entry.goalRevision,
    })
  })
  // Sequences survive identical timestamps and process replacement. Legacy
  // records without a sequence retain deterministic timestamp/source order.
  return entries.sort((a, b) => a.sequence && b.sequence ? a.sequence - b.sequence : a.at.localeCompare(b.at)).map((entry, index) => ({ ...entry,
    exactRead: entry.kind === 'work' ? { ref: entry.ref, limit: 1 } : { ref: memoryRef(task.id, 'child', childId), offset: index, limit: 1 } }))
}

/** Paged cold reads. Callers cannot turn a Task-scoped reference into filesystem or network access. */
export function queryTaskMemory(task: Task, execution: ExecutionBinding | undefined, query: TaskMemoryQuery): TaskMemoryPage {
  const current = caller(task, execution)
  const { section, id } = parseRef(task, query.ref)
  authorize(task, current, section, id)
  const offset = query.offset ?? 0
  const limit = query.limit ?? 20
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new Error('MEMORY_PAGE: offset must be nonnegative and limit must be between 1 and 50.')
  let entries: unknown[]
  switch (section) {
    case 'goal': entries = [task.goal]; break
    case 'origin': entries = task.goalHistory?.length ? task.goalHistory : [{ goal: task.goal, source: task.source }]; break
    case 'plan': entries = [task.plan]; break
    case 'children': entries = task.plan.childIds.map(childId => task.children[childId]); break
    case 'planner': entries = task.decisions; break
    case 'note': entries = task.plannerNote ? [task.plannerNote] : []; break
    case 'child': entries = childMemory(task, id!); break
    case 'report': entries = own(task.reports, id!) ? [task.reports[id!]] : []; break
    case 'incident': entries = own(task.incidents, id!) ? [task.incidents[id!]] : []; break
    case 'execution': entries = own(task.executions, id!) ? [task.executions[id!]] : []; break
    case 'wait': entries = waitVersions(task, id!).filter(entry => visibleWait(task, current, entry.wait)).map((entry, index) => waitView(task, { ...entry,
      exactRef: memoryRef(task.id, 'wait', id!), exactRead: { ref: memoryRef(task.id, 'wait', id!), offset: index, limit: 1 } })); break
    case 'waits': entries = waitMemory(task, current).map(entry => waitView(task, entry)); break
  }
  const selected = entries.slice(offset, offset + limit), serialized = JSON.stringify(selected)
  const characterOffset = query.characterOffset ?? 0
  if (!Number.isInteger(characterOffset) || characterOffset < 0 || characterOffset > serialized.length) throw new Error('MEMORY_PAGE: Invalid character cursor.')
  const following = offset + limit < entries.length ? { ref: query.ref, offset: offset + limit, limit } : undefined
  if (serialized.length > 32768 || characterOffset) {
    const end = Math.min(serialized.length, characterOffset + 32768)
    return { ref: query.ref, taskRevision: task.revision, offset, total: entries.length, entries: [],
      textFormat: 'json', text: serialized.slice(characterOffset, end), characterOffset, totalCharacters: serialized.length,
      next: end < serialized.length ? { ref: query.ref, offset, limit, characterOffset: end } : following }
  }
  return { ref: query.ref, taskRevision: task.revision, offset, total: entries.length, entries: structuredClone(selected), next: following }
}

function compactEntry(entry: MemoryEntry): MemoryEntry {
  return { ...entry, summary: clipped(entry.summary), ...(entry.frontier ? { frontier: clipped(entry.frontier, 1200) } : {}),
    ...(entry.evidence ? { evidence: entry.evidence.slice(0, 8).map(item => clipped(item, 500)) } : {}),
    ...(entry.artifacts ? { artifacts: hotArtifacts(entry.artifacts) } : {}),
    ...(entry.checkpoint ? { checkpoint: {
      completed: entry.checkpoint.completed.slice(0, 8).map(item => clipped(item, 500)),
      failedApproaches: entry.checkpoint.failedApproaches.slice(0, 4).map(failed => ({ approach: clipped(failed.approach, 700), outcome: clipped(failed.outcome, 700), evidence: failed.evidence.slice(0, 4).map(item => clipped(item, 500)) })),
      remaining: entry.checkpoint.remaining.slice(0, 8).map(item => clipped(item, 500)), nextAction: clipped(entry.checkpoint.nextAction, 1000), nextReads: hotStrings(entry.checkpoint.nextReads, 8, 500),
    } } : {}) }
}
function compactDecision(task: Task, entry: DecisionRecord, index: number) {
  return { commandId: entry.commandId, kind: entry.kind ?? 'plan', goalRevision: entry.goalRevision, planRevision: entry.planRevision,
    summary: clipped(entry.summary), ...(entry.frontier ? { frontier: clipped(entry.frontier, 1200) } : {}),
    ...(entry.childDecisions ? { childDecisions: entry.childDecisions.slice(0, 24).map(decision => ({ childId: decision.childId, resultId: decision.resultId, outcome: decision.outcome, reason: clipped(decision.reason, 1200), assignmentVersion: decision.assignmentVersion, resultingAssignmentVersion: decision.resultingAssignmentVersion })) } : {}),
    ...(entry.failedApproaches ? { failedApproaches: entry.failedApproaches.slice(0, 8).map(item => clipped(item, 500)) } : {}),
    ...(entry.changedAssumptions ? { changedAssumptions: entry.changedAssumptions.slice(0, 8).map(item => clipped(item, 500)) } : {}),
    ...(entry.planNoteUsage ? { planNoteUsage: { ...entry.planNoteUsage, summary: clipped(entry.planNoteUsage.summary, 800), frontier: clipped(entry.planNoteUsage.frontier, 800) } } : {}), ...(entry.planNoteChange ? { planNoteChange: { ...entry.planNoteChange, summary: clipped(entry.planNoteChange.summary, 800), frontier: clipped(entry.planNoteChange.frontier, 800) } } : {}),
    ...(entry.physicalDisposition ? { physicalDisposition: entry.physicalDisposition } : {}),
    ...(entry.resolvedWait ? { resolvedWait: { ...entry.resolvedWait, reason: clipped(entry.resolvedWait.reason, 800), condition: clipped(entry.resolvedWait.condition, 1200), resume: clipped(entry.resolvedWait.resume, 1200),
      ...(entry.resolvedWait.answer ? { answer: clipped(entry.resolvedWait.answer, 2400) } : {}), ...(entry.resolvedWait.question ? { question: clipped(entry.resolvedWait.question, 800) } : {}), exactRef: memoryRef(task.id, 'wait', entry.resolvedWait.id) } } : {}),
    exactRead: { ref: memoryRef(task.id, 'planner'), offset: index, limit: 1 },
  }
}
function childSummary(task: Task, child: Child) {
  const report = child.currentResultId ? task.reports[child.currentResultId] : undefined
  return { id: child.id, title: child.title, objective: clipped(child.objective, 1000), assignmentVersion: child.assignmentVersion, goalRevision: child.goalRevision,
    status: child.status, dependsOn: child.dependsOn.slice(0, 24), dependencyCount: child.dependsOn.length, ...(child.acceptedResultId ? { acceptedResultId: child.acceptedResultId, acceptedAtGoalRevision: child.acceptedAtGoalRevision } : {}),
    ...(report ? { latestResultId: report.resultId, frontier: clipped(report.frontier, 900), outcome: report.outcome, disposition: report.disposition } : {}), historyRef: memoryRef(task.id, 'child', child.id) }
}
function childContext(task: Task, child: Child) {
  const history = childMemory(task, child.id)
  const failures = history.filter(entry => entry.outcome === 'failed' || entry.outcome === 'rework' || (entry.checkpoint?.failedApproaches.length ?? 0) > 0)
  const previouslyAccepted = new Set(task.decisions.flatMap(entry => (entry.childDecisions ?? []).filter(decision => decision.childId === child.id && decision.outcome === 'accept').map(decision => decision.resultId)))
  const accepted = Object.values(task.reports).filter(report => report.childId === child.id && report.outcome === 'complete' && (report.disposition === 'accepted' || previouslyAccepted.has(report.resultId)))
  const latest = history.filter(entry => entry.kind === 'work').at(-1)
  return { childId: child.id, currentAssignment: { ...childSummary(task, child), objective: clipped(child.objective, 4000), inputArtifacts: hotArtifacts(child.inputArtifacts), acceptanceCriteria: hotStrings(child.acceptanceCriteria, 20), writeScopes: hotStrings(child.writeScopes, 24, 4000), resources: child.resources.slice(0, 24) },
    latestFrontier: latest ? { resultId: latest.resultId, frontier: latest.frontier ? clipped(latest.frontier, 1600) : undefined, ref: latest.ref, assignmentVersion: latest.assignmentVersion } : undefined,
    acceptedWork: recent(accepted, HOT_ENTRIES).map(report => ({ resultId: report.resultId, assignmentVersion: report.assignmentVersion, goalRevision: report.goalRevision,
      acceptedForCurrentGoal: child.acceptedResultId === report.resultId && child.acceptedAtGoalRevision === task.goal.revision,
      summary: clipped(report.summary), artifacts: hotArtifacts(report.artifacts), ref: memoryRef(task.id, 'report', report.resultId) })),
    failedApproaches: recent(failures, HOT_FAILURES).map(compactEntry), recentEntries: recent(history).map(compactEntry),
    history: { ref: memoryRef(task.id, 'child', child.id), total: history.length, hotOffset: Math.max(0, history.length - HOT_ENTRIES), earlierEntries: Math.max(0, history.length - HOT_ENTRIES), failureCount: failures.length },
  }
}

/** New role instances reconstruct purposeful work from saved state, not a prior Agent's conversation. */
export function assembleRoleInput(task: Task, execution: ExecutionBinding, action: PendingAction, knowledgeFacts: readonly KnowledgeRecord[] = []) {
  const bound = caller(task, execution)!
  if (task.archive) throw new Error('MEMORY_ARCHIVED: An archived Task cannot create a new role context.')
  const savedAction = own(task.pendingActions, action.id)
  if (!savedAction || bound.actionId !== savedAction.id && !(savedAction.kind === 'continue' && savedAction.payload.executionId === bound.executionId)) throw new Error('MEMORY_ACTION: Context must come from the role instance\'s exact action.')
  const allCurrentChildren = task.plan.childIds.map(id => task.children[id])
  const scope = childScope(task, bound)
  const ownChildId = bound.childId ?? (bound.incidentId ? task.incidents[bound.incidentId]?.childId : undefined)
  const ownChild = ownChildId ? task.children[ownChildId] : undefined
  const broad = bound.role === 'planner' || bound.role === 'foreground'
  const relevantChildren = broad ? allCurrentChildren : allCurrentChildren.filter(child => scope.has(child.id))
  const childIds = new Set(relevantChildren.map(child => child.id))
  const waits = waitMemory(task, bound)
  const restart = bound.incidentId ? task.incidents[bound.incidentId] : undefined
  const resolvedWaits = waits.filter(entry => entry.wait.state === 'resolved')
  const next_reads: MemoryRead[] = []
  const read = (section: MemorySection, purpose: string, id?: string, offset?: number) => next_reads.push({ ref: memoryRef(task.id, section, id), purpose, ...(offset !== undefined ? { offset, limit: 20 } : {}) })
  read('goal', 'Recheck current user requirements whenever planning or evidence conflicts.')
  if (task.goalHistory?.length) read('origin', 'Inspect exact earlier user requirements only to explain a change; currentGoal remains authoritative.', undefined, 0)
  if (broad) {
    read('planner', 'Older planning decisions, rejected methods, and evidence; read the narrow page relevant to this frontier.', undefined, Math.max(0, task.decisions.length - HOT_ENTRIES - 20))
    if (task.plannerNote) read('note', 'Read the full mutable planning note; record noteUse or a note change in the next planning write.')
    if (allCurrentChildren.length > HOT_CHILDREN) read('children', 'Continue the current plan child index beyond the hot handoff.', undefined, HOT_CHILDREN)
  }
  for (const child of relevantChildren.slice(0, broad ? HOT_CHILDREN : HOT_ENTRIES)) read('child', `Inspect durable work, failures, planner feedback, and recovery history for child ${child.id}.`, child.id, Math.max(0, childMemory(task, child.id).length - HOT_ENTRIES - 20))
  for (const resultId of (savedAction.payload.resultIds ?? []).slice(0, HOT_CHILDREN)) if (task.reports[resultId]) read('report', 'Read the exact saved result this action must evaluate; summary is not acceptance.', resultId)
  if (bound.incidentId) read('incident', 'Read the exact prior error and saved restart evidence relevant to the next operation.', bound.incidentId)
  if (waits.length) read('waits', 'Read scoped dependency questions, exact user answers, and recovery conditions; resolved answers remain part of the work requirements.', undefined, Math.max(0, waits.length - HOT_ENTRIES - 20))
  for (const entry of recent(resolvedWaits)) next_reads.push({ ...entry.exactRead, purpose: 'Read the exact resolved dependency and answer before continuing the affected work.' })
  const relatedExecutions = Object.values(task.executions).filter(owner => owner.executionId === bound.executionId || (broad ? owner.state === 'active' || !['stopped', 'lost'].includes(owner.physicalState) : !!owner.childId && childIds.has(owner.childId))
    || (!!bound.incidentId && task.incidents[bound.incidentId]?.executionId === owner.executionId))
  const predecessor = (savedAction.payload.predecessorExecutionId ? task.executions[savedAction.payload.predecessorExecutionId] : undefined)
    ?? Object.values(task.executions).filter(owner => owner.executionId !== bound.executionId && owner.role === bound.role && owner.childId === bound.childId && (bound.role !== 'helper' || owner.incidentId === bound.incidentId)).at(-1)
  const facts = knowledgeFacts.filter((record): record is Exclude<KnowledgeRecord, { kind: 'skill' }> => record.kind !== 'skill' && record.scope.assistantId === task.assistantId && record.scope.workspaceId === task.workspace.id)
  return {
    authority: { taskId: task.id, revision: task.revision, assistantId: task.assistantId, workspace: structuredClone(task.workspace), control: task.control,
      currentGoal: broad ? { ...task.goal, request: clipped(task.goal.request, 3000), objective: clipped(task.goal.objective, 2000), constraints: hotStrings(task.goal.constraints), deliverables: hotStrings(task.goal.deliverables), acceptanceCriteria: hotStrings(task.goal.acceptanceCriteria), sourceRef: clipped(task.goal.sourceRef, 500), exactRef: memoryRef(task.id, 'goal') } : { revision: task.goal.revision, exactRef: memoryRef(task.id, 'goal') }, originalRequestRef: memoryRef(task.id, 'origin'), needsPlanning: task.needsPlanning,
      rule: 'Current user requirements are authoritative. Formal plans and historical decisions are evidence and instructions only within that goal. A saved Session or job id does not prove a live physical owner.' },
    role: { role: bound.role, executionId: bound.executionId, generation: bound.generation, sessionId: bound.sessionId,
      actionId: savedAction.id, actionKind: savedAction.kind, reason: savedAction.payload.reason ? clipped(savedAction.payload.reason, 1200) : undefined,
      ...(bound.childId ? { childId: bound.childId, assignmentVersion: bound.assignmentVersion } : {}), ...(bound.incidentId ? { incidentId: bound.incidentId } : {}) },
    plan: { revision: task.plan.revision, goalRevision: task.plan.goalRevision,
      ...(broad ? { strategy: clipped(task.plan.strategy, 4000), children: relevantChildren.slice(0, HOT_CHILDREN).map(child => childSummary(task, child)), totalChildren: allCurrentChildren.length,
        exactRef: memoryRef(task.id, 'plan') } : { relevantChildren: relevantChildren.slice(0, HOT_CHILDREN).map(child => childSummary(task, child)), relevantChildrenCount: relevantChildren.length }) },
    ...(broad ? { plannerMemory: { recentEntries: recent(task.decisions).map((entry, index) => compactDecision(task, entry, Math.max(0, task.decisions.length - HOT_ENTRIES) + index)),
      history: { ref: memoryRef(task.id, 'planner'), total: task.decisions.length, earlierEntries: Math.max(0, task.decisions.length - HOT_ENTRIES) } },
      ...(task.plannerNote ? { planNote: hotNote(task) } : {}),
      eventResults: (savedAction.payload.resultIds ?? []).slice(0, HOT_CHILDREN).flatMap(id => task.reports[id] ? [compactEntry(childMemory(task, task.reports[id].childId).find(entry => entry.kind === 'work' && entry.resultId === id)!)] : []),
    } : {}),
    ...(ownChild ? { childMemory: childContext(task, ownChild), dependencyResults: ownChild.dependsOn.slice(0, HOT_CHILDREN).flatMap(id => {
      const dependency = task.children[id]
      const report = dependency?.acceptedResultId ? task.reports[dependency.acceptedResultId] : undefined
      return report && dependency.acceptedAtGoalRevision === task.goal.revision ? [{ childId: id, resultId: report.resultId, summary: clipped(report.summary), artifacts: hotArtifacts(report.artifacts), ref: memoryRef(task.id, 'report', report.resultId) }] : []
    }) } : {}),
    handoff: { ...(restart?.state === 'resolved' ? { recovery: {
      notice: 'The previous execution failed. The runtime settled its exact owner and jobs, then restarted this same role for the original Task and Child. Resume the saved frontier and retained artifacts; this is not a new user request.',
      incidentId: restart.id, previousExecutionId: restart.executionId,
      errors: restart.errors.slice(-3).map(error => ({ ...error, operation: clipped(error.operation, 500), message: clipped(error.message, 1000) })),
      resolution: restart.resolution ? clipped(restart.resolution, 1500) : undefined, ref: memoryRef(task.id, 'incident', restart.id),
    } } : {}), ...(predecessor ? { predecessor: { executionId: predecessor.executionId, sessionId: predecessor.sessionId, generation: predecessor.generation, assignmentVersion: predecessor.assignmentVersion, state: predecessor.state, physicalState: predecessor.physicalState,
      ref: memoryRef(task.id, 'execution', predecessor.executionId) } } : {}),
      actualOwners: relatedExecutions.filter(owner => owner.state === 'active' || !['stopped', 'lost'].includes(owner.physicalState)).map(owner => ({ executionId: owner.executionId, role: owner.role, childId: owner.childId,
        semanticState: owner.state, physicalState: owner.physicalState, ownedJobIds: owner.ownedJobIds.slice(0, 24), observedAt: owner.observedAt, ref: memoryRef(task.id, 'execution', owner.executionId) })),
      waits: waits.filter(entry => entry.current && entry.wait.state === 'waiting').slice(0, HOT_CHILDREN).map(entry => waitView(task, entry, true)),
      resolvedWaits: recent(resolvedWaits).map(entry => waitView(task, entry, true)),
      resolvedWaitsOmitted: Math.max(0, resolvedWaits.length - HOT_ENTRIES),
      incidents: Object.values(task.incidents).filter(incident => incident.state !== 'resolved' && (broad || bound.incidentId === incident.id || (!!incident.childId && childIds.has(incident.childId)))).slice(0, HOT_CHILDREN).map(incident => ({ id: incident.id, executionId: incident.executionId, childId: incident.childId, state: incident.state, errors: incident.errors.slice(-3).map(error => ({ ...error, operation: clipped(error.operation, 500), message: clipped(error.message, 1000) })), ref: memoryRef(task.id, 'incident', incident.id) })),
      next_reads,
    },
    knowledgeFacts: facts.slice(-24).map(record => ({ kind: record.kind, id: record.id, revision: record.revision, text: clipped(record.text, 1500),
      ...(record.kind === 'preference' ? { applicability: clipped(record.applicability, 800), sourceRef: record.userSourceRef } : { sourceResultId: record.sourceResultId }) })),
    knowledgeFactsOmitted: Math.max(0, facts.length - 24),
  }
}
