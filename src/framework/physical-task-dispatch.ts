import { publishPreparedPhysicalFile, samePhysicalPublication } from './physical-publication-evidence.js'
import type { PreparedLocalAppend } from './local-record-files.js'
import { createHash, randomUUID } from 'node:crypto'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { inTasks, physicalTaskTerminalPath } from './physical-task-terminal.js'
import { paths, encodeJson, readJson, taskLifecycle, taskInitializationFiles, type TaskMetadata, type TaskRoute } from './task-files.js'
import { linkedChild } from './task-relations.js'
import { filePath, withSnapshot, type FilesSnapshot } from './transactions.js'

interface Identity { taskId: string; lifecycleId?: string }
export interface RequirementPublication { taskId: string; commandId: string }
interface Publication {
  version: 1
  kind: 'supplement' | 'dispatch'
  commandId: string
  request: string
  task: TaskMetadata
  child?: TaskMetadata
  newChild?: true
  sourcePrepared?: PreparedLocalAppend
  sourcePublished?: true
  inboxPrepared?: PreparedLocalAppend
  inboxPublished?: true
  decisionPrepared?: PreparedLocalAppend
  decisionPublished?: true
  signalVersion?: string
  published?: true
}
export interface PhysicalTaskSupplement extends Identity { commandId: string; text: string }
export interface PhysicalChildDispatch extends Identity {
  commandId: string; owner: string; objectiveId: string; member: string
  route: TaskRoute; members?: readonly string[]; plan: string; decision: string
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reference = (fact: Publication): RequirementPublication => ({ taskId: fact.task.taskId, commandId: fact.commandId })
const root = (ref: RequirementPublication): string => paths.run(ref.taskId) + '/.requirements/' + hash(ref.commandId)
const factPath = (ref: RequirementPublication): string => root(ref) + '/publication.json'
const same = (a: RequirementPublication | undefined, b: RequirementPublication): boolean => a?.taskId === b.taskId && a.commandId === b.commandId
const publicationLanes = new Map<string, Promise<unknown>>()
/** Only this actual objective/source publication is sequenced. Different child
 * files do not retain their parent's Task lane while carrying out I/O. */
async function inPublication<T>(files: PhysicalLocalFiles, taskId: string, kind: Publication['kind'], objectiveId: string | undefined,
  work: () => Promise<T>): Promise<T> {
  const key = files.directory + '\0' + JSON.stringify([taskId, kind, objectiveId])
  const operation = (publicationLanes.get(key)?.catch(() => {}) ?? Promise.resolve()).then(work)
  publicationLanes.set(key, operation)
  try { return await operation } finally { if (publicationLanes.get(key) === operation) publicationLanes.delete(key) }
}
const decodeTask = (bytes: Uint8Array | undefined): TaskMetadata | undefined => bytes === undefined ? undefined : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
const segment = (value: string): void => { filePath(value); if (value.includes('/')) throw new Error('An identity must occupy one path segment.') }
async function currentTask(files: PhysicalLocalFiles, snapshot: FilesSnapshot, expected: Identity): Promise<TaskMetadata> {
  const task = await readJson<TaskMetadata>(files, snapshot, paths.task(expected.taskId))
  if (!task || task.taskId !== expected.taskId || taskLifecycle(task) !== taskLifecycle(expected))
    throw new Error('Requirement publication belongs to a missing or different Task lifecycle.')
  return task
}
async function assertOpen(files: PhysicalLocalFiles, snapshot: FilesSnapshot, expected: Identity): Promise<TaskMetadata> {
  const task = await currentTask(files, snapshot, expected)
  if (task.status !== 'running') throw new Error('The Task is closed; submit a new Task or objective referencing its durable results.')
  if (await files.fileInfo(physicalTaskTerminalPath(task)))
    throw new Error('This Task has already accepted its terminal handoff; use its durable results for a new Task.')
  return task
}
const save = (files: PhysicalLocalFiles, fact: Publication): Promise<void> => files.replace(factPath(reference(fact)), encodeJson(fact))
async function attach(files: PhysicalLocalFiles, expected: Identity, ref: RequirementPublication): Promise<void> {
  await files.update(paths.task(expected.taskId), bytes => {
    const task = decodeTask(bytes)
    if (!task || taskLifecycle(task) !== taskLifecycle(expected) || task.status !== 'running')
      throw new Error('Task lifecycle or admission changed before requirement publication.')
    return { value: undefined, ...(task.requirementPublications?.some(item => same(item, ref)) ? {} : {
      content: encodeJson({ ...task, requirementPublications: [...task.requirementPublications ?? [], ref] }) }) }
  })
}
async function detach(files: PhysicalLocalFiles, expected: Identity, ref: RequirementPublication): Promise<void> {
  await files.update(paths.task(expected.taskId), bytes => {
    const task = decodeTask(bytes)
    if (!task || taskLifecycle(task) !== taskLifecycle(expected) || !task.requirementPublications?.some(item => same(item, ref))) return { value: undefined }
    const { requirementPublications: existing, ...rest } = task
    const remaining = existing.filter(item => !same(item, ref))
    return { value: undefined, content: encodeJson({ ...rest, ...(remaining.length ? { requirementPublications: remaining } : {}) }) }
  })
}
async function retire(files: PhysicalLocalFiles, fact: Publication): Promise<void> {
  const ref = reference(fact)
  // Until the original native result is durably successful, retain only the
  // actual requirement identity/targets/phase for unknown-result retries. The
  // native result hook retires that exact fact; Task cleanup also owns this scope.
  if (fact.child) await detach(files, fact.child, ref)
  await detach(files, fact.task, ref)
  for (const name of ['input.txt', 'decision.txt', 'source.stage', 'inbox.stage', 'decision.stage', 'signal.stage'])
    await files.delete(root(ref) + '/' + name)
}
async function load(files: PhysicalLocalFiles, snapshot: FilesSnapshot, ref: RequirementPublication): Promise<Publication | undefined> {
  const fact = await readJson<Publication>(files, snapshot, factPath(ref))
    ?? await readJson<Publication>(files, snapshot, root(ref) + '/prepared.json')
  if (fact && (fact.version !== 1 || fact.commandId !== ref.commandId || fact.task?.taskId !== ref.taskId
    || !['supplement', 'dispatch'].includes(fact.kind))) throw new Error('Invalid accepted requirement publication identity.')
  return fact
}
/** The Task's exact pending reference is the acceptance point. The fact is
 * first a prepared file, then this reference is attached, then the fact is
 * renamed into its published location. A cold Host with the reference can read
 * either location; no accepted fact is undiscoverable between save and attach. */
async function accept(files: PhysicalLocalFiles, snapshot: FilesSnapshot, fact: Publication): Promise<void> {
  const ref = reference(fact)
  await inTasks(files, [fact.task.taskId, ...(fact.child ? [fact.child.taskId] : [])], async () => {
    const parent = await assertOpen(files, snapshot, fact.task)
    if (parent.owner !== fact.task.owner || parent.sourcePath !== fact.task.sourcePath || parent.route !== fact.task.route)
      throw new Error('The original Task ownership/source changed before accepting the requirement.')
    if (fact.child && !fact.newChild) await assertOpen(files, snapshot, fact.child)
    if (fact.child) {
      const prior = parent.children?.find(item => item.objectiveId === fact.child!.parent!.objectiveId)
      if (prior && (prior.taskId !== fact.child.taskId || prior.member !== fact.child.owner))
        throw new Error('This objective already identifies another child.')
    }
    await attach(files, parent, ref)
    if (fact.child && !fact.newChild) await attach(files, fact.child, ref)
  })
  if (!await files.rename(root(ref) + '/prepared.json', factPath(ref))) {
    const accepted = await readJson<Publication>(files, snapshot, factPath(ref))
    if (!accepted || accepted.commandId !== fact.commandId || accepted.request !== fact.request
      || accepted.task?.taskId !== fact.task.taskId || accepted.kind !== fact.kind)
      throw new Error('The accepted requirement publication fact is missing or changed: ' + factPath(ref))
  }
}
async function appendSource(files: PhysicalLocalFiles, fact: Publication, text: string): Promise<void> {
  if (fact.sourcePublished) return
  const target = fact.child ?? fact.task, stage = root(reference(fact)) + '/source.stage'
  if (fact.newChild) {
    if (!fact.sourcePrepared) {
      if (await files.fileInfo(target.sourcePath)) throw new Error('The new child source path already exists; preserve its actual contents.')
      await files.replace(stage, 'Task ID: ' + target.taskId + '\n' + text)
      const observed = await files.fileInfo(stage)
      if (!observed) throw new Error('The prepared child requirement source is missing.')
      fact.sourcePrepared = { stageVersion: observed.version }; await save(files, fact)
    }
    // This is a new child's original requirement, not a requested replacement.
    // Order same-process writers on the existing source/destination queues.
    // Portable Node still has an external check-to-rename window; no cross-
    // process no-replace guarantee or hardlink-capable filesystem is assumed.
    const publication = await files.renameIfAbsent(stage, target.sourcePath)
    if (publication === 'destination-exists')
      throw new Error('The new child source path already exists; preserve its contents and the prepared requirement.')
    if (publication === 'source-missing') {
      const actual = await files.fileInfo(target.sourcePath)
      if (!actual || !samePhysicalPublication(fact.sourcePrepared.stageVersion, actual.version))
        throw new Error('The prepared child requirement is unavailable and its publication is not confirmed: ' + target.sourcePath)
    }
  } else {
    // Missing original input is never replaced by a supplement. Only this
    // exact prepared file at its target proves an interrupted append.
    if (!await files.fileInfo(target.sourcePath))
      throw new Error('The original task requirement is missing: ' + target.sourcePath)
    await files.appendPrepared(target.sourcePath, stage, '\n\n' + text, fact.sourcePrepared,
      async prepared => { fact.sourcePrepared = prepared; await save(files, fact) })
  }
  fact.sourcePublished = true; await save(files, fact)
}
/** Finish only one accepted requirement, with original bodies/targets and the
 * correct acceptance-role signal. This is not a FileChange transaction replay.
 * The original signal stage is consumed by rename; a retry never recreates a
 * signal already claimed, even when its final phase save was interrupted. */
async function publish(files: PhysicalLocalFiles, snapshot: FilesSnapshot, fact: Publication,
  assertLive: () => void | Promise<void>, sources?: (path: string) => Promise<readonly { path: string; version: string }[]>): Promise<void> {
  if (fact.published) { await retire(files, fact); return }
  await assertLive()
  const task = await assertOpen(files, snapshot, fact.task), ref = reference(fact), work = root(ref)
  if (task.owner !== fact.task.owner || task.route !== fact.task.route || task.sourcePath !== fact.task.sourcePath)
    throw new Error('Task ownership or requirement source changed during publication.')
  await attach(files, task, ref)
  const text = await files.read(snapshot, work + '/input.txt')
  if (text === undefined) throw new Error('Accepted requirement text is missing: ' + work + '/input.txt')
  if (fact.child) {
    const child = fact.child
    if (fact.newChild) {
      // Metadata and reciprocal relation precede tasks/*.md discovery. A Host
      // must never see this child source while it could still initialize a root.
      for (const change of taskInitializationFiles(child)) {
        if (typeof change.content !== 'string') continue
        await files.createIfAbsent(change.path, child.route === 'P' && change.path === paths.inbox(child.taskId, child.owner) ? text : change.content)
      }
      await files.createIfAbsent(paths.task(child.taskId), encodeJson({ ...child, requirementPublications: [ref] }))
      await files.update(paths.task(task.taskId), bytes => {
        const current = decodeTask(bytes)
        if (!current || taskLifecycle(current) !== taskLifecycle(task) || current.status !== 'running') throw new Error('Parent changed before child relation publication.')
        const prior = current.children?.find(item => item.objectiveId === child.parent!.objectiveId)
        if (prior && (prior.taskId !== child.taskId || prior.member !== child.owner)) throw new Error('This objective already identifies another child.')
        return { value: undefined, ...(prior ? {} : { content: encodeJson({ ...current, children: [...current.children ?? [],
          { objectiveId: child.parent!.objectiveId, taskId: child.taskId, member: child.owner }] }) }) }
      })
      await files.update(paths.cache(task.taskId), bytes => {
        const cache = bytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : { version: 1, links: [
          { kind: 'file', path: task.sourcePath }, { kind: 'file', path: paths.task(task.taskId) }, { kind: 'directory', path: paths.run(task.taskId) + '/' }] }
        const target = paths.task(child.taskId)
        if (!Array.isArray(cache.links)) throw new Error('Parent Recorder cache references are invalid.')
        return { value: undefined, ...(cache.links.some((link: { path?: string }) => link.path === target) ? {} : {
          content: encodeJson({ ...cache, links: [...cache.links, { kind: 'file', path: target }] }) }) }
      })
    }
    const actual = await assertOpen(files, snapshot, child), parent = await currentTask(files, snapshot, task)
    if (!linkedChild(parent, actual) || actual.route !== child.route || actual.owner !== child.owner || actual.sourcePath !== child.sourcePath)
      throw new Error('Objective child ownership is inconsistent.')
    await attach(files, actual, ref)
    // The existing P Inbox delivery contains only the new supplement if the
    // Inbox was deleted. Other current templates never replace authored files.
    if (!fact.newChild) for (const change of taskInitializationFiles(actual)) {
      if (change.path !== paths.inbox(actual.taskId, actual.owner) && typeof change.content === 'string') await files.createIfAbsent(change.path, change.content)
    }
    if (!fact.newChild && actual.route === 'P' && !fact.inboxPublished) {
      const inbox = paths.inbox(actual.taskId, actual.owner)
      const separator = await files.fileInfo(inbox) ? '\n\n' : ''
      await files.appendPrepared(inbox, work + '/inbox.stage', separator + text, fact.inboxPrepared,
        async prepared => { fact.inboxPrepared = prepared; await save(files, fact) })
      fact.inboxPublished = true; await save(files, fact)
    }
    if (!fact.decisionPublished) {
      const decision = await files.read(snapshot, work + '/decision.txt')
      if (decision === undefined) throw new Error('Accepted Organizer decision is missing: ' + work + '/decision.txt')
      await files.appendPrepared(paths.run(task.taskId) + '/Dispatch.md', work + '/decision.stage', decision, fact.decisionPrepared,
        async prepared => { fact.decisionPrepared = prepared; await save(files, fact) })
      fact.decisionPublished = true; await save(files, fact)
    }
  }
  await assertLive()
  await appendSource(files, fact, text)
  const recipient = fact.child ?? fact.task
  const signal = paths.state(recipient.owner, recipient.taskId) + (fact.kind === 'supplement'
    ? (recipient.route === 'P' ? '/Planner_Foreground' : '/Organizer_Foreground')
    : (recipient.route === 'P' ? '/Planner_Inbox' : '/Organizer_Task'))
  if (!fact.signalVersion) {
    await files.replace(work + '/signal.stage', '')
    const stage = await files.fileInfo(work + '/signal.stage')
    if (!stage) throw new Error('The prepared requirement signal is missing.')
    fact.signalVersion = stage.version; await save(files, fact)
  }
  await assertLive()
  await publishPreparedPhysicalFile(files, work + '/signal.stage', signal, fact.signalVersion, sources && (() => sources(signal)))
  fact.published = true; await save(files, fact)
  await retire(files, fact)
}
export async function supplementPhysicalTask(files: PhysicalLocalFiles, input: PhysicalTaskSupplement,
  assertLive: () => void | Promise<void>, sources?: (path: string) => Promise<readonly { path: string; version: string }[]>): Promise<void> {
  return inPublication(files, input.taskId, 'supplement', undefined, () => withSnapshot(files, async snapshot => {
    await assertLive()
    const ref = { taskId: input.taskId, commandId: input.commandId }, request = hash([input.taskId, input.lifecycleId ?? '', input.text])
    let fact = await load(files, snapshot, ref)
    if (fact && (fact.kind !== 'supplement' || fact.request !== request)) throw new Error('Retry the original Task supplement with its unchanged content.')
    if (!fact) {
      const task = await assertOpen(files, snapshot, input)
      if (!await files.fileInfo(task.sourcePath)) throw new Error('The original task requirement is missing.')
      await files.replace(root(ref) + '/input.txt', input.text)
      fact = { version: 1, kind: 'supplement', commandId: input.commandId, request, task }
      await files.replace(root(ref) + '/prepared.json', encodeJson(fact))
    }
    if (!fact.published) await accept(files, snapshot, fact)
    await publish(files, snapshot, fact, assertLive, sources)
  }))
}
export async function dispatchPhysicalChild(files: PhysicalLocalFiles, input: PhysicalChildDispatch,
  assertLive: () => void | Promise<void>, sources?: (path: string) => Promise<readonly { path: string; version: string }[]>): Promise<void> {
  segment(input.objectiveId); segment(input.member)
  if (input.route !== 'P' && input.route !== 'O') throw new Error('Choose the explicit P or O child route.')
  return inPublication(files, input.taskId, 'dispatch', input.objectiveId, () => withSnapshot(files, async snapshot => {
    await assertLive()
    const ref = { taskId: input.taskId, commandId: input.commandId }
    const request = hash([input.taskId, input.lifecycleId ?? '', input.owner, input.objectiveId, input.member, input.route, input.members, input.plan, input.decision])
    let fact = await load(files, snapshot, ref)
    if (fact && (fact.kind !== 'dispatch' || fact.request !== request)) throw new Error('Retry the original objective dispatch with its unchanged content and scope.')
    if (!fact) {
      const task = await assertOpen(files, snapshot, input)
      if (task.owner !== input.owner || task.route !== 'O') throw new Error('Independent child dispatch belongs to this instance’s open O package.')
      const registered = task.members ?? [task.owner]
      if (!registered.includes(input.member)) throw new Error('Choose an actual member registered in this task package.')
      const members = [...new Set([input.member, ...(input.members ?? (input.route === 'O' ? registered : []))])]
      for (const member of members) { segment(member); if (!registered.includes(member)) throw new Error('Child scope must remain within the parent package registered members.') }
      const assigned = task.children?.find(child => child.objectiveId === input.objectiveId)
      let child: TaskMetadata
      if (assigned) {
        if (assigned.member !== input.member) throw new Error('An existing objective remains assigned to its original member.')
        child = await readJson<TaskMetadata>(files, snapshot, paths.task(assigned.taskId)) as TaskMetadata
        if (!child || !linkedChild(task, child) || child.route !== input.route || child.owner !== input.member) throw new Error('Objective child ownership is inconsistent.')
        if (child.status !== 'running') throw new Error('A completed child Task stays closed; create a new objective identity referencing its results.')
        await assertOpen(files, snapshot, child)
        if (input.members && (child.members?.length !== members.length || members.some(member => !child.members?.includes(member))))
          throw new Error('An existing child retains its assigned member scope; supplement without changing ownership.')
        if (!await files.fileInfo(child.sourcePath)) throw new Error('The original child requirement is missing; report the missing original instead of inventing it.')
      } else {
        const taskId = randomUUID()
        child = { version: 1, taskId, route: input.route, sourcePath: 'tasks/' + taskId + '_' + input.route + '.md', owner: input.member,
          status: 'running', archiveFolder: paths.archive(task).slice('archives/'.length) + '/' + taskId, members,
          parent: { taskId: task.taskId, owner: task.owner, objectiveId: input.objectiveId } }
      }
      await files.replace(root(ref) + '/input.txt', input.plan)
      await files.replace(root(ref) + '/decision.txt', input.decision)
      fact = { version: 1, kind: 'dispatch', commandId: input.commandId, request, task, child, ...(!assigned ? { newChild: true as const } : {}) }
      await files.replace(root(ref) + '/prepared.json', encodeJson(fact))
    }
    if (!fact.published) await accept(files, snapshot, fact)
    await publish(files, snapshot, fact, assertLive, sources)
  }))
}
/** Existing Host Task discovery resumes only the exact accepted publication
 * referenced by this Task. No scan, new work admission, queue or guessed input. */
export async function resumePhysicalTaskRequirement(files: PhysicalLocalFiles, task: TaskMetadata, sources?: (path: string) => Promise<readonly { path: string; version: string }[]>): Promise<TaskMetadata> {
  const refs = task.requirementPublications
  if (!refs?.length) return task
  await Promise.all(refs.map(async ref => {
    const observed = await withSnapshot(files, snapshot => load(files, snapshot, ref))
    if (!observed) throw new Error('The Task’s accepted requirement publication is missing.')
    await inPublication(files, ref.taskId, observed.kind, observed.child?.parent?.objectiveId, () => withSnapshot(files, async snapshot => {
      const fact = await load(files, snapshot, ref)
      if (!fact) throw new Error('The Task’s accepted requirement publication is missing.')
      if (!fact.published) await accept(files, snapshot, fact)
      await publish(files, snapshot, fact, () => {}, sources)
    }))
  }))
  return withSnapshot(files, snapshot => currentTask(files, snapshot, task))
}

/** The original native tool result is durably successful. Its retry window is
 * closed, so retire only this finished command's technical files immediately;
 * original requirements, Inbox, Dispatcher notes and signals stay untouched. */
export async function retirePhysicalTaskRequirement(files: PhysicalLocalFiles, taskId: string, commandId: string): Promise<void> {
  const ref = { taskId, commandId }, observed = await withSnapshot(files, snapshot => load(files, snapshot, ref))
  if (observed && !observed.published) return
  const finish = async () => withSnapshot(files, async snapshot => {
    const fact = await load(files, snapshot, ref)
    if (fact && !fact.published) return
    if (fact) await retire(files, fact)
    // Success evidence also permits finishing a prior interrupted retirement
    // after the fact itself was removed. No arbitrary child is traversed.
    for (const name of ['input.txt', 'decision.txt', 'source.stage', 'inbox.stage', 'decision.stage', 'signal.stage', 'prepared.json', 'publication.json'])
      await files.delete(root(ref) + '/' + name)
    for (const path of [root(ref), paths.run(taskId) + '/.requirements']) {
      try { await files.removeEmptyDirectory(path) }
      catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    }
  })
  if (observed) await inPublication(files, taskId, observed.kind, observed.child?.parent?.objectiveId, finish)
  else await finish()
}
