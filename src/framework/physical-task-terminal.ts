import { publishPreparedPhysicalFile, samePhysicalPublication } from './physical-publication-evidence.js'
import type { DirectSignalSources } from './physical-direct-delivery.js'
import { resumePhysicalTaskRequirement } from './physical-task-dispatch.js'
import type { PreparedLocalAppend } from './local-record-files.js'
import { createHash } from 'node:crypto'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { readTaskHistoryIdentity, readTaskReferenceIdentity } from './task-history.js'
import { paths, readJson, encodeJson, taskLifecycle, taskCompletionSignals, foregroundTaskSignal, childCompletionSignal, type TaskMetadata } from './task-files.js'
import { linkedChild, taskFamily } from './task-relations.js'
import { withSnapshot, type FilesSnapshot } from './transactions.js'

interface Identity { taskId: string; lifecycleId?: string }
interface PreparedSignal { path: string; stage: string; prepared?: { version: string }; published?: true }
export interface PhysicalCompletionNotifications { notifications: string[] }
export interface PhysicalCompletionPlan {
  task: TaskMetadata
  acceptance: { path: string; text: string }
  recovery?: { path: string; version: string }
}
interface PendingTerminal {
  version: 1
  commandId: string
  request: string
  task: TaskMetadata
  kind: 'complete' | 'cancel'
  targets: Identity[]
  cancelled?: Identity[]
  acceptance?: PhysicalCompletionPlan['acceptance'] & { stage: string; prepared?: PreparedLocalAppend; published?: true }
  recovery?: PhysicalCompletionPlan['recovery']
  signals: PreparedSignal[]
  foreground?: PreparedSignal & { progress: string }
  /** Both notice responsibilities are fulfilled; only temporary-file removal remains. */
  finished?: true
}
interface ForegroundProgress { version: 1; commandId: string; prepared?: { version: string }; published?: true }
/** Root completion and both existing notice responsibilities share one
 * transient fact outside the total Task cleanup scope. Children retain their
 * own ordinary working handoff; no child Foreground responsibility exists. */
export const physicalTaskTerminalPath = (task: string | Pick<TaskMetadata, 'taskId' | 'parent'>): string => {
  const taskId = typeof task === 'string' ? task : task.taskId
  return typeof task !== 'string' && task.parent ? paths.run(taskId) + '/.terminal-handoff.json'
    : 'state/.Task_Terminal_' + encodeURIComponent(taskId).replaceAll('.', '%2E') + '.json'
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const isPhysicalForegroundPendingPath = (path: string): boolean => /^state\/\.Task_Terminal_[^/.]+\.json$/.test(path)

/** The Task lane never writes this Foreground-only file. In particular, a
 * blocked prepare-state write does not own Recorder's common-file queue. */
async function writeForegroundProgress(files: PhysicalLocalFiles, path: string, value: ForegroundProgress): Promise<void> {
  await files.replace(path, encodeJson(value))
}
/** The root Recorder catalog is an existing downstream business result, not
 * an acknowledgement of a particular empty file. It can outlive both the
 * consumed signal and the Task's retired native RoleRecord. History alone is
 * insufficient because migration also writes that projection. */
async function recorderCompleted(files: PhysicalLocalFiles, pending: PendingTerminal): Promise<boolean> {
  if (pending.task.parent) return false
  return withSnapshot(files, async snapshot => {
    const task = pending.task, history = await readTaskHistoryIdentity(files, snapshot, task.taskId)
    if (!history || history.parent || history.owner !== task.owner || history.route !== task.route
      || history.sourcePath !== task.sourcePath || paths.archive(history) !== paths.archive(task)
      || taskLifecycle(history) !== taskLifecycle(task)
      || history.status !== (pending.kind === 'complete' ? 'complete' : 'cancelled')) return false
    const retained = await readJson<{ lifecycleId?: string; recorderCommand?: string; recorderRequest?: string; outputs?: string[] }>(
      files, snapshot, paths.archive(task) + '/retention.json')
    return !!retained && taskLifecycle(retained) === taskLifecycle(task)
      && typeof retained.recorderCommand === 'string' && retained.recorderCommand.length > 0
      && typeof retained.recorderRequest === 'string' && retained.recorderRequest.length > 0
      && Array.isArray(retained.outputs) && retained.outputs.includes(paths.archive(task) + '/records.md')
  })
}
async function retireRootHandoff(files: PhysicalLocalFiles, path: string, pending: PendingTerminal,
  sources?: DirectSignalSources): Promise<void> {
  if (!pending.foreground) return
  if (!pending.finished) {
    // Only the exact prepared file or an existing recipient source proves the
    // interrupted Recorder publication. Stage absence never settles ownership.
    const unresolved = pending.signals.filter(signal => !signal.published)
    for (const signal of unresolved) {
      if (typeof signal.prepared?.version === 'string') {
        const current = await files.fileInfo(signal.path)
        if (current && samePhysicalPublication(signal.prepared.version, current.version)) continue
        if (sources && (await sources(signal.path)).some(source => source.path === signal.path
          && samePhysicalPublication(signal.prepared!.version, source.version))) continue
      }
      // Cleaner/native release stays independent. This existing Recorder
      // result fulfills the business responsibility without re-emitting a
      // consumed notice or claiming that an absent stage proves its rename.
      if (signal.path === paths.state(pending.task.owner, pending.task.taskId) + '/Recorder'
        && await recorderCompleted(files, pending)) continue
      return
    }
    const retired = await files.update(path, bytes => {
      if (bytes === undefined) return { value: false }
      const current = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as PendingTerminal
      if (current.commandId !== pending.commandId) throw new Error('Root handoff retirement belongs to another command.')
      if (current.signals.some(signal => !signal.published && !unresolved.some(old => old.path === signal.path
        && old.stage === signal.stage && old.prepared?.version === signal.prepared?.version))) return { value: false }
      return { value: true, content: encodeJson({ ...current, finished: true }) }
    })
    if (!retired) return
  }
  // Save cleanup phase before removing either fact. A restart cannot mistake
  // removed progress for a never-started Foreground publication.
  for (const signal of pending.signals) await files.delete(signal.stage)
  await files.delete(pending.foreground.progress)
  await files.delete(path)
}
/** Existing global signalPoll owns the COMPLETE Foreground branch: prepare
 * file, prepare fact, rename and local completion fact. No step takes the Task
 * lane or shares Recorder's write target. Common input is not a signal/ACK. */
export async function resumePhysicalForegroundTaskNotice(files: PhysicalLocalFiles, path: string, sources?: DirectSignalSources): Promise<string | undefined> {
  if (!isPhysicalForegroundPendingPath(path)) throw new Error('Not a pending Foreground Task notification.')
  return withSnapshot(files, async snapshot => {
    const pending = await readJson<PendingTerminal>(files, snapshot, path)
    if (!pending) return undefined
    const signal = pending.foreground
    const base = path.slice(0, -5) + '.' + hash(pending.commandId) + '.foreground'
    if (pending.version !== 1 || pending.task.parent || path !== physicalTaskTerminalPath(pending.task)
      || !signal || signal.stage !== base + '.stage' || signal.progress !== base + '.json'
      || signal.path !== foregroundTaskSignal(pending.task.taskId)) throw new Error('Invalid Foreground terminal responsibility.')
    if (pending.finished) { await retireRootHandoff(files, path, pending, sources); return undefined }
    const task = await readTaskReferenceIdentity(files, snapshot, pending.task.taskId)
    if (!task || taskLifecycle(task) !== taskLifecycle(pending.task))
      throw new Error('Foreground notification belongs to a missing or different Task lifecycle.')
    if (task.status === 'running') return undefined
    if (task.parent || task.status !== (pending.kind === 'complete' ? 'complete' : 'cancelled'))
      throw new Error('Foreground notification does not match this terminal root Task.')
    const progress = await readJson<ForegroundProgress>(files, snapshot, signal.progress)
      ?? { version: 1 as const, commandId: pending.commandId }
    if (progress.version !== 1 || progress.commandId !== pending.commandId) throw new Error('Foreground preparation belongs to another command.')
    if (!progress.published) {
      if (!progress.prepared) {
        await files.createIfAbsent(signal.stage, '')
        const prepared = await files.fileInfo(signal.stage)
        if (!prepared) throw new Error('The prepared Foreground terminal signal is missing.')
        progress.prepared = { version: prepared.version }
        await writeForegroundProgress(files, signal.progress, progress)
      }
      if (typeof progress.prepared.version !== 'string') throw new Error('The Foreground terminal signal has no prepared file identity.')
      await publishPreparedPhysicalFile(files, signal.stage, signal.path, progress.prepared.version,
        sources && (() => sources(signal.path)))
      progress.published = true
      await writeForegroundProgress(files, signal.progress, progress)
    }
    await retireRootHandoff(files, path, pending, sources)
    return task.taskId
  })
}
const identity = (task: TaskMetadata): Identity => ({ taskId: task.taskId, ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}) })
const parseTask = (bytes: Uint8Array | undefined): TaskMetadata | undefined => bytes === undefined ? undefined : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

// Only overlapping actual terminal handoffs wait. Ordinary records and Workers
// never enter this lane. Cross-process file editors are not covered by these
// process-local queues (the same limit as PhysicalLocalFiles' file operations).
const terminalLanes = new Map<string, Promise<void>>()
export function inTasks<T>(files: PhysicalLocalFiles, ids: readonly string[], action: () => Promise<T>): Promise<T> {
  return inTaskLanes(files, ids, action)
}
async function inTaskLanes<T>(files: PhysicalLocalFiles, ids: readonly string[], action: () => Promise<T>, ancestor?: string): Promise<T> {
  const ancestorKey = ancestor && files.directory + '\0' + paths.task(ancestor)
  let releaseAncestor: (() => void) | undefined
  const keys = [...new Set(ids.map(id => files.directory + '\0' + paths.task(id)))].sort()
  const enter = async (index: number): Promise<T> => {
    if (index === keys.length) {
      // Acquire every mutation target first, in the existing global key order.
      // This child still owns its own/subtree lanes, so a parent terminal action
      // cannot publish past it. Only its external ancestor's admission lane ends.
      releaseAncestor?.()
      return action()
    }
    const key = keys[index]!, prior = terminalLanes.get(key) ?? Promise.resolve()
    let release!: () => void
    const own = new Promise<void>(resolve => { release = resolve })
    const tail = prior.then(() => own)
    terminalLanes.set(key, tail)
    await prior
    let released = false
    const leave = () => {
      if (released) return
      released = true; release()
      if (terminalLanes.get(key) === tail) terminalLanes.delete(key)
    }
    if (key === ancestorKey) releaseAncestor = leave
    try { return await enter(index + 1) }
    finally { leave() }
  }
  return enter(0)
}
function inTerminalTasks<T>(files: PhysicalLocalFiles, task: TaskMetadata, targets: readonly Identity[], action: () => Promise<T>): Promise<T> {
  const owned = [task.taskId, ...targets.map(target => target.taskId)], parent = task.parent?.taskId
  return inTaskLanes(files, [...owned, ...(parent ? [parent] : [])], action, parent && !owned.includes(parent) ? parent : undefined)
}
async function pendingAt(files: PhysicalLocalFiles, snapshot: FilesSnapshot, task: TaskMetadata): Promise<PendingTerminal | undefined> {
  const pending = await readJson<PendingTerminal>(files, snapshot, physicalTaskTerminalPath(task))
  if (!pending) return
  if (pending.version !== 1 || pending.task?.taskId !== task.taskId || taskLifecycle(pending.task) !== taskLifecycle(task)
    || !['complete', 'cancel'].includes(pending.kind) || typeof pending.commandId !== 'string'
    || !Array.isArray(pending.targets) || !Array.isArray(pending.signals)) throw new Error('Invalid pending terminal handoff for this Task lifecycle.')
  return pending
}
async function currentTask(files: PhysicalLocalFiles, snapshot: FilesSnapshot, expected: Identity): Promise<TaskMetadata> {
  const task = await readJson<TaskMetadata>(files, snapshot, paths.task(expected.taskId))
  if (!task || task.taskId !== expected.taskId || taskLifecycle(task) !== taskLifecycle(expected))
    throw new Error('Task terminal handoff belongs to a missing or different lifecycle: ' + expected.taskId)
  return task
}
async function persist(files: PhysicalLocalFiles, pending: PendingTerminal, initial = false): Promise<void> {
  const path = physicalTaskTerminalPath(pending.task)
  await files.update(path, bytes => {
    const current = bytes === undefined ? undefined : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as PendingTerminal
    if (!current && !initial) {
      // Global retirement can finish after this exact Recorder rename but
      // before its callback saves published. Do not recreate the retired fact.
      if (!pending.task.parent && pending.signals.every(signal => signal.published)) return { value: undefined }
      throw new Error('The pending terminal handoff is no longer present.')
    }
    if (current && (current.commandId !== pending.commandId || current.request !== pending.request))
      throw new Error('Another terminal handoff owns this Task.')
    if (current?.finished) return { value: undefined }
    return { value: undefined, content: encodeJson(pending) }
  })
}
function newPending(task: TaskMetadata, kind: PendingTerminal['kind'], targets: Identity[], commandId: string, request: unknown): PendingTerminal {
  const path = physicalTaskTerminalPath(task)
  return { version: 1, commandId, request: JSON.stringify(request), task, kind, targets, signals: [],
    ...(!task.parent ? { foreground: { path: foregroundTaskSignal(task.taskId),
      stage: path.slice(0, -5) + '.' + hash(commandId) + '.foreground.stage',
      progress: path.slice(0, -5) + '.' + hash(commandId) + '.foreground.json' } } : {}) }
}
function signalStages(pending: PendingTerminal, paths: readonly string[]): PreparedSignal[] {
  return paths.map((path, index) => ({ path, stage: pending.task.parent ? pathsForStage(pending) + '/signal-' + index
    : physicalTaskTerminalPath(pending.task).slice(0, -5) + '.' + hash(pending.commandId) + '.task-signal-' + index + '.stage' }))
}
function pathsForStage(pending: PendingTerminal): string {
  return paths.run(pending.task.taskId) + '/.terminal-handoff/' + hash(pending.commandId)
}
function checkCommand(pending: PendingTerminal, commandId: string, request: unknown): void {
  if (pending.commandId !== commandId || pending.request !== JSON.stringify(request))
    throw new Error('This Task has an unfinished terminal handoff; resume its existing command before submitting another acceptance or cancellation.')
}

/** Resume this already accepted business handoff, never a generic FileChange
 * replay. Note, member state and descendant terminal facts precede root state;
 * actual root/parent notifications are published only after those facts exist.
 * An interrupted rename is confirmed only by the exact file identity or the
 * recipient’s existing accepted source. No completion receipt survives. */
async function publish(files: PhysicalLocalFiles, snapshot: FilesSnapshot, pending: PendingTerminal,
  beforeAttempt: () => void = () => {}, sources?: DirectSignalSources): Promise<TaskMetadata> {
  beforeAttempt()
  const runtime = await readJson<TaskMetadata>(files, snapshot, paths.task(pending.task.taskId))
  const selected = runtime ?? (!pending.task.parent ? await readTaskReferenceIdentity(files, snapshot, pending.task.taskId) : undefined)
  if (!selected || selected.taskId !== pending.task.taskId || taskLifecycle(selected) !== taskLifecycle(pending.task))
    throw new Error('Task terminal handoff belongs to a missing or different lifecycle.')
  if (selected.owner !== pending.task.owner || selected.route !== pending.task.route
    || JSON.stringify(selected.parent) !== JSON.stringify(pending.task.parent)) throw new Error('Task terminal ownership or parent assignment changed.')
  const status = pending.kind === 'complete' ? 'complete' : 'cancelled'
  if (selected.status !== 'running' && selected.status !== status) throw new Error('Task status conflicts with this accepted terminal handoff.')
  if (pending.task.parent) {
    const parent = await readJson<TaskMetadata>(files, snapshot, paths.task(pending.task.parent.taskId))
    if (pending.kind === 'complete' && (!parent || !linkedChild(parent, selected)
      || selected.status === 'running' && parent.status !== 'running'))
      throw new Error('Child completion requires its actual open parent assignment.')
  }
  if (selected.status === 'running') {
    for (const target of pending.targets) await currentTask(files, snapshot, target)
    if (pending.acceptance && !pending.acceptance.published) {
      const note = pending.acceptance
      await files.appendPrepared(note.path, note.stage, note.text, note.prepared, async prepared => {
        const previous = note.prepared
        note.prepared = prepared
        try { await persist(files, pending) } catch (error) { note.prepared = previous; throw error }
      })
      note.published = true
      await persist(files, pending)
    }
    if (pending.kind === 'complete') {
      beforeAttempt()
      if (pending.task.route === 'P') await files.replace(paths.memberStatus(selected.taskId, selected.owner), encodeJson({ state: 'complete' }))
      if (pending.recovery) await files.deleteObserved(pending.recovery.path, pending.recovery.version, beforeAttempt)
    }
    // All requested child cancellations precede the root's terminal state.
    // No Foreground OR Recorder stage/prepared write precedes that state.
    for (const target of [...pending.targets].reverse()) {
      beforeAttempt()
      await files.update(paths.task(target.taskId), bytes => {
        const task = parseTask(bytes)
        if (!task || task.taskId !== target.taskId || taskLifecycle(task) !== taskLifecycle(target)) throw new Error('Task lifecycle changed before terminal publication.')
        if (task.status !== 'running' && task.status !== status) throw new Error('Task status conflicts with this accepted terminal handoff.')
        return { value: undefined, ...(task.status === 'running' ? { content: encodeJson({ ...task, status,
          ...(pending.kind === 'complete' ? { resultPaths: pending.task.resultPaths,
            ...(pending.task.workspaceResults ? { workspaceResults: pending.task.workspaceResults } : {}) } : {}) }) } : {}) }
      })
    }
  }
  const terminal = await readTaskReferenceIdentity(files, snapshot, pending.task.taskId)
  if (!terminal || taskLifecycle(terminal) !== taskLifecycle(pending.task) || terminal.status !== status)
    throw new Error('Task terminal status was not published.')
  if (pending.kind === 'complete' && (JSON.stringify(terminal.resultPaths) !== JSON.stringify(pending.task.resultPaths)
    || pending.task.workspaceResults && JSON.stringify(terminal.workspaceResults) !== JSON.stringify(pending.task.workspaceResults)))
    throw new Error('The Task terminal result references do not match this accepted handoff.')
  // This branch owns only parent/Recorder preparation and publication. Its
  // failure cannot stop global signalPoll from preparing/publishing Foreground.
  for (const signal of pending.signals) if (!signal.prepared) {
    beforeAttempt()
    if (!runtime) throw new Error('Task runtime was removed before its own notification was prepared.')
    await files.createIfAbsent(signal.stage, '')
    const prepared = await files.fileInfo(signal.stage)
    if (!prepared) throw new Error('The prepared terminal signal is missing.')
    signal.prepared = { version: prepared.version }
    try { await persist(files, pending) } catch (error) { delete signal.prepared; throw error }
  }
  for (const signal of pending.signals) if (!signal.published) {
    beforeAttempt()
    if (typeof signal.prepared?.version !== 'string') throw new Error('The terminal signal has no prepared file identity.')
    await publishPreparedPhysicalFile(files, signal.stage, signal.path, signal.prepared.version,
      sources && (() => sources(signal.path)))
    signal.published = true
    if (!pending.task.parent || pending.signals.some(other => !other.published)) await persist(files, pending)
  }
  // Empty stage directories only. Missing runtime after total cleanup never
  // authorizes recreation of member/Note/Task files.
  for (const directory of [pathsForStage(pending), paths.run(pending.task.taskId) + '/.terminal-handoff']) {
    try { await files.removeEmptyDirectory(directory) }
    catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
  if (pending.task.parent) await files.delete(physicalTaskTerminalPath(pending.task))
  // The existing global signal lane retires the root common fact only after
  // its own independent publication and this Recorder publication both finish.
  return terminal
}

/** Exact per-Task startup continuation, called by its existing Host lane. */
export async function resumePhysicalTaskTerminalHandoff(files: PhysicalLocalFiles, task: TaskMetadata, sources?: DirectSignalSources): Promise<TaskMetadata> {
  const pending = await withSnapshot(files, snapshot => pendingAt(files, snapshot, task))
  if (!pending) return task
  return inTerminalTasks(files, pending.task, pending.targets, () => withSnapshot(files, async snapshot => {
    const actual = await pendingAt(files, snapshot, task)
    return actual ? publish(files, snapshot, actual, undefined, sources) : currentTask(files, snapshot, task)
  }))
}

export async function completePhysicalTask(files: PhysicalLocalFiles, expected: Identity, commandId: string, request: unknown,
  build: (snapshot: FilesSnapshot) => Promise<PhysicalCompletionPlan | PhysicalCompletionNotifications>, beforeAttempt: () => void, sources?: DirectSignalSources): Promise<PhysicalCompletionNotifications | undefined> {
  // Complete the actual accepted requirement publication before rechecking the
  // AI's normal pending notifications. A race discovered after taking the lane
  // releases it and resumes that exact work; no pending-field refusal gate.
  const retryTargets = Symbol('refresh-terminal-targets')
  for (;;) {
    const observed = await resumePhysicalTaskRequirement(files,
      await withSnapshot(files, snapshot => currentTask(files, snapshot, expected)), sources)
    const protectedTasks = new Set([observed.taskId, ...observed.children?.map(child => child.taskId) ?? []])
    const result = await inTerminalTasks<PhysicalCompletionNotifications | typeof retryTargets | undefined>(files, observed, observed.children ?? [], () => withSnapshot(files, async snapshot => {
      beforeAttempt()
      const current = await currentTask(files, snapshot, expected)
      // A new child may have fully published after observation, leaving no
      // pending requirement. Reacquire only when a real target was not locked.
      if (current.requirementPublications?.length || current.children?.some(child => !protectedTasks.has(child.taskId))) return retryTargets
      let pending = await pendingAt(files, snapshot, observed)
      if (pending) checkCommand(pending, commandId, request)
      else {
        // The durable business state is not a command receipt. A later invocation
        // cannot pretend its new acceptance text was written, or resend notices.
        const selected = await currentTask(files, snapshot, expected)
        if (selected.status !== 'running') throw new Error('The total task is already closed; use its durable results for a new task.')
        const plan = await build(snapshot)
        if ('notifications' in plan) return plan
        if (plan.task.taskId !== selected.taskId || taskLifecycle(plan.task) !== taskLifecycle(selected) || plan.task.status !== 'complete')
          throw new Error('Completion plan does not identify this accepted Task lifecycle.')
        pending = newPending(plan.task, 'complete', [identity(selected)], commandId, request)
        pending.acceptance = { ...plan.acceptance, stage: pathsForStage(pending) + '/acceptance.md' }
        pending.recovery = plan.recovery
        pending.signals = signalStages(pending, selected.parent ? [childCompletionSignal(selected.parent, selected.taskId)]
          : taskCompletionSignals(selected).slice(1).map(change => change.path))
        beforeAttempt()
        await persist(files, pending, true)
      }
      await publish(files, snapshot, pending, beforeAttempt, sources)
      return undefined
    }))
    if (result !== retryTargets) return result
  }
}

export async function cancelPhysicalTask(files: PhysicalLocalFiles, expected: Identity, member: string, commandId: string, sources?: DirectSignalSources): Promise<Identity[]> {
  const retryTargets = Symbol('refresh-terminal-targets')
  for (;;) {
    const selected = await withSnapshot(files, snapshot => currentTask(files, snapshot, expected))
    if (!(selected.members ?? [selected.owner]).includes(member)) throw new Error('This Host has no registered execution domain in the selected Task.')
    if (selected.status === 'complete') throw new Error('A completed Task cannot be cancelled or reopened.')
    let observed = await withSnapshot(files, snapshot => taskFamily(files, snapshot, expected.taskId))
    for (const task of observed) await resumePhysicalTaskRequirement(files, task, sources)
    observed = await withSnapshot(files, snapshot => taskFamily(files, snapshot, expected.taskId))
    if (!observed[0]) throw new Error('The selected Task does not exist.')
    const protectedTasks = new Set(observed.map(task => task.taskId))
    const request = { ...expected, member }
    const result = await inTerminalTasks<Identity[] | typeof retryTargets>(files, observed[0], observed, () => withSnapshot(files, async snapshot => {
      const current = await taskFamily(files, snapshot, expected.taskId)
      // The selected/known ancestor lanes prevent further admissions while we
      // check. Include newly published descendants before touching the family.
      if (current.some(task => task.requirementPublications?.length || !protectedTasks.has(task.taskId))) return retryTargets
      const initiating = await currentTask(files, snapshot, expected)
      if (!(initiating.members ?? [initiating.owner]).includes(member)) throw new Error('This Host has no registered execution domain in the selected Task.')
      if (initiating.status === 'complete') throw new Error('A completed Task cannot be cancelled or reopened.')
      // A child may have already accepted before this cancellation took its lane.
      // Finish only that child's actual pending publication, preserving its work.
      for (const task of [...observed].reverse()) if (task.taskId !== expected.taskId) {
        const childPending = await pendingAt(files, snapshot, task)
        if (childPending) await publish(files, snapshot, childPending, undefined, sources)
      }
      let pending = await pendingAt(files, snapshot, initiating)
      if (pending) checkCommand(pending, commandId, request)
      else {
        const family = await taskFamily(files, snapshot, expected.taskId), selected = family[0]!
        if (taskLifecycle(selected) !== taskLifecycle(expected)) throw new Error('The selected Task has entered another lifecycle; select its current state before cancelling.')
        if (!(selected.members ?? [selected.owner]).includes(member)) throw new Error('This Host has no registered execution domain in the selected Task.')
        if (selected.status === 'complete') throw new Error('A completed Task cannot be cancelled or reopened.')
        if (selected.status === 'cancelled') return family.filter(task => task.status === 'cancelled')
        if (selected.status !== 'running' || family.some(task => !['running', 'complete', 'cancelled'].includes(task.status)))
          throw new Error('A related Task status is not recognized.')
        pending = newPending(selected, 'cancel', family.filter(task => task.status === 'running').map(identity), commandId, request)
        pending.cancelled = family.filter(task => task.status === 'running' || task.status === 'cancelled').map(identity)
        const signals = taskCompletionSignals(selected).slice(1).map(change => change.path)
        if (selected.parent) {
          const parent = await readJson<TaskMetadata>(files, snapshot, paths.task(selected.parent.taskId))
          if (parent && parent.status === 'running' && linkedChild(parent, selected)) signals.push(paths.state(parent.owner, parent.taskId)
            + '/Organizer_ChildCancelled_' + hash(commandId.replace(/^task-cancel:/, '')))
        }
        pending.signals = signalStages(pending, signals)
        await persist(files, pending, true)
      }
      await publish(files, snapshot, pending, undefined, sources)
      // Successful root publication proves all requested transitions. Keep that
      // exact result even if fast Recorder/Cleaner retirement removed metadata.
      return pending.cancelled ?? pending.targets
    }))
    if (result !== retryTargets) return result
  }
}
