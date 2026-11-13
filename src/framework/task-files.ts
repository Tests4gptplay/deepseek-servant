import { randomUUID } from 'node:crypto'
import type { PhysicalLocalFiles } from './physical-local-files.js'
import type { TaskArchiveState } from './task-archive.js'
import { fileReadFingerprint, withReevaluatedFileTarget } from './file-read-observation.js'
import { taskSourceName, taskWorkspaceFolder, type PhysicalWorkspaceReference } from './workspace-paths.js'
import { filePath, type FileChange, type FilesSnapshot, type FilesStore, type FileListSelection } from './transactions.js'

export type TaskRoute = 'P' | 'O'
/** Native root applies only to this exact producing Host. */
export interface TaskHostWorkspace { instanceUUID: string; root: string }
export interface TaskMetadata {
  version: 1
  taskId: string
  route: TaskRoute
  sourcePath: string
  owner: string
  status: 'running' | 'complete' | 'cancelled'
  lifecycleId?: string
  /** Git's existing cleanup and per-Host facts live with this Task, outside archives. */
  runtimeState?: Pick<TaskArchiveState, 'lifecycles'>
  /** Exact accepted, unfinished source/dispatch publication; cleared after its role signal. */
  requirementPublications?: Array<{ taskId: string; commandId: string }>
  /** Fixed relative archive path at creation; child Tasks nest beneath their actual parent, never a native workspace. */
  archiveFolder?: string
  workspaceFolder?: string
  workspaceRootTaskId?: string
  hostWorkspaces?: Record<string, string>
  workspaceResults?: Array<PhysicalWorkspaceReference | string>
  resultPaths?: string[]
  parent?: { taskId: string; owner: string; objectiveId: string }
  children?: Array<{ objectiveId: string; taskId: string; member: string }>
  /** Registered task participants remain here even while their Host is offline. */
  members?: string[]
}
export const taskLifecycle = (task: { lifecycleId?: string }): string => task.lifecycleId ?? ''
export const taskLifecycleKey = (task: { taskId: string; lifecycleId?: string }): string => task.lifecycleId ? task.taskId + ':' + task.lifecycleId : task.taskId
export async function assertTaskLifecycle(store: FilesStore, snapshot: FilesSnapshot, taskId: string, expected: { lifecycleId?: string }): Promise<TaskMetadata | undefined> {
  const path = paths.task(taskId)
  const task = await withReevaluatedFileTarget(snapshot, path, () => readJson<TaskMetadata>(store, snapshot, path))
  // Missing legacy Tasks and an empty lifecycle have the same existing predicate.
  // Other readers of this metadata still observe the fields they actually use.
  if (task && taskLifecycle(task) !== taskLifecycle(expected) || !task && taskLifecycle(expected))
    throw new Error('Task lifecycle changed; this prior execution cannot act on the current continuation.')
  fileReadFingerprint(snapshot, 'task-lifecycle:' + taskId, taskLifecycle(task ?? {}))
  return task
}
export const isTerminalTask = (task: Pick<TaskMetadata, 'status'>): boolean => task.status === 'complete' || task.status === 'cancelled'

export interface MemberStatus { state: 'running' | 'complete' }
export interface PlannedChange<T> { changes: FileChange[]; value: T }
export const encodeJson = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'
const segment = (value: string): string => {
  filePath(value)
  if (value.includes('/')) throw new Error('An identity must occupy one path segment.')
  return value
}
export const paths = {
  task: (taskId: string) => 'tasks/' + segment(taskId) + '.json',
  run: (taskId: string) => 'task-runs/' + segment(taskId),
  state: (member: string, taskId: string) => 'state/' + segment(member) + '/' + segment(taskId),
  member: (taskId: string, member: string) => 'task-runs/' + segment(taskId) + '/' + segment(member),
  inbox: (taskId: string, member: string) => 'task-runs/' + segment(taskId) + '/' + segment(member) + '/' + segment(member) + '_Inbox/' + segment(member) + '_' + segment(taskId) + '.md',
  memberStatus: (taskId: string, member: string) => 'task-runs/' + segment(taskId) + '/' + segment(member) + '/' + segment(member) + '_Inbox/status.json',
  cache: (taskId: string) => 'Recorder Cache/' + segment(taskId) + '/links.json',
  /** String form is only for exact explicitly addressed historical directories. */
  archive: (task: string | { taskId: string; archiveFolder?: string; sourcePath?: string }) => {
    if (typeof task === 'string') return 'archives/' + segment(task)
    if (!task.archiveFolder && !task.sourcePath) throw new Error('Task archive requires its pinned folder or actual source path.')
    const folder = filePath(task.archiveFolder ?? taskWorkspaceFolder(taskSourceName(task.sourcePath!), task.taskId))
    // Every component is a relative identity-bearing Task directory. Ordinary
    // artifact subdirectories do not appear in this pinned Task path.
    for (const part of folder.split('/')) {
      if (/[<>:"|?*\u0000-\u001f\u007f]/u.test(part) || /[ .]$/u.test(part)) throw new Error('Invalid Task archive directory segment.')
    }
    const leaf = folder.split('/').at(-1)!.toLowerCase(), id = task.taskId.toLowerCase()
    if (leaf !== id && !leaf.endsWith('_' + id)) throw new Error('Task archive directory must retain its own Task identity.')
    return 'archives/' + folder
  },
}
/** Archive operations belong to this Task, not every Task physically nested
 * below it. Direct child identities are already in this Task's own metadata. */
export function taskArchiveOwnsPath(task: Pick<TaskMetadata, 'taskId'> & Partial<Pick<TaskMetadata, 'sourcePath' | 'archiveFolder' | 'children'>>, path: string): boolean {
  const root = paths.archive(task)
  if (path === root) return true
  if (!path.startsWith(root + '/')) return false
  const first = path.slice(root.length + 1).split('/')[0]!.toLowerCase()
  return !(task.children ?? []).some(child => first === child.taskId.toLowerCase() || first.endsWith('_' + child.taskId.toLowerCase()))
}
export function taskArchiveSelection(task: Pick<TaskMetadata, 'taskId'> & Partial<Pick<TaskMetadata, 'sourcePath' | 'archiveFolder' | 'children'>>): FileListSelection | undefined {
  return task.children?.length ? { archiveScope: { root: paths.archive(task), childTaskIds: task.children.map(child => child.taskId) } } : undefined
}
/** Fixed transient namespace shared by Recorder's retention step and Host cleanup. */
export function taskWorkingRoots(task: TaskMetadata): string[] {
  return [paths.run(task.taskId), 'Recorder Cache/' + task.taskId, 'technical/recovery-inputs/' + task.taskId,
    ...new Set([task.owner, ...(task.members ?? [])].map(member => paths.state(member, task.taskId)))]
}
/** Global result notification survives reclamation of the Task's working state. */
export const foregroundTaskSignal = (taskId: string): string => 'state/Foreground_Task_' + encodeURIComponent(segment(taskId))
/** A Task completion signal carries the existing Task ID UUID, not a username prefix. */
export function parseForegroundTaskSignal(path: string): string | undefined {
  return /^state\/Foreground_Task_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path)?.[1]
}
/** Only the root owns final recording/cleanup. Child completion is handed to
 * its verified parent by the accepting/cancelling transaction; its runtime
 * materials remain available until that whole Task tree is finalized. */
export function taskCompletionSignals(task: TaskMetadata): FileChange[] {
  if (task.parent) return []
  return [{ path: foregroundTaskSignal(task.taskId), content: '' },
    { path: paths.state(task.owner, task.taskId) + '/Recorder', content: '' }]
}
export async function readJson<T>(store: FilesStore, snapshot: FilesSnapshot, path: string): Promise<T | undefined> {
  const value = await store.read(snapshot, path)
  return value === undefined ? undefined : JSON.parse(value) as T
}
/** Missing status retains the caller's existing missing-record behavior;
 * malformed stored state is an error, never evidence of running or completion. */
export async function readMemberStatus(store: FilesStore, snapshot: FilesSnapshot, path: string): Promise<MemberStatus | undefined> {
  let value: unknown
  try { value = await readJson<unknown>(store, snapshot, path) }
  catch (cause) { throw new Error('Cannot read member status: ' + path, { cause }) }
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || !('state' in value)
    || typeof value.state !== 'string' || !['running', 'complete'].includes(value.state)) {
    throw new Error('Invalid member status: ' + path)
  }
  return { state: value.state as MemberStatus['state'] }
}
export function taskIdentity(text: string): string | undefined {
  return /^Task ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\r?\n|$)/i.exec(text)?.[1]
}
function templates(taskId: string, member: string): FileChange[] {
  const root = paths.member(taskId, member)
  return [
    { path: paths.inbox(taskId, member), content: '' },
    { path: paths.memberStatus(taskId, member), content: encodeJson({ state: 'running' } satisfies MemberStatus) },
    { path: root + '/Planner_Memory.md', content: '' },
    { path: root + '/Plan_Note.md', content: '' },
    { path: root + '/Plan.md', content: '' },
    { path: root + '/Reply.md', content: '' },
  ]
}
function taskCacheLinks(task: TaskMetadata): Array<{ kind: 'file' | 'directory'; path: string }> {
  return [
    { kind: 'file', path: task.sourcePath }, { kind: 'file', path: paths.task(task.taskId) },
    { kind: 'directory', path: paths.run(task.taskId) + '/' },
    ...(task.children ?? []).map(child => ({ kind: 'file' as const, path: paths.task(child.taskId) })),
  ]
}
/** Current-design defaults contain no recovered business prose. P has one
 * owning Planner; O has its own Organizer and separately identified children.
 * Member running is the open P work state, not a claim about native execution.
 * P acceptance writes owner completion and Task completion in one transaction. */
export function taskInitializationFiles(task: TaskMetadata): FileChange[] {
  if (task.status !== 'running') return []
  const run = paths.run(task.taskId)
  return [
    ...(task.route === 'P' ? templates(task.taskId, task.owner) : [
      { path: run + '/Organizer_Note.md', content: '' }, { path: run + '/Dispatch.md', content: '' },
    ]),
    { path: paths.cache(task.taskId), content: encodeJson({ version: 1, links: taskCacheLinks(task) }) },
  ]
}
/** Call inside the existing transaction builder. Each absent target is an
 * actual read dependency, so a concurrent writer wins instead of being replaced. */
export async function restoreTaskInitialization(store: FilesStore, snapshot: FilesSnapshot, task: TaskMetadata): Promise<FileChange[]> {
  const defaults = taskInitializationFiles(task), directories = new Map<string, string[]>()
  for (const { path } of defaults) {
    const directory = path.slice(0, path.lastIndexOf('/'))
    const paths = directories.get(directory) ?? []
    paths.push(path); directories.set(directory, paths)
  }
  const present = new Set((await Promise.all([...directories].map(async ([directory, paths]) =>
    store.listDirectoryNames ? store.listDirectoryNames(snapshot, directory, { paths })
      : (await store.listDirectory(snapshot, directory, { paths })).map(entry => entry.path)))).flat())
  return defaults.filter(change => !present.has(change.path))
}

/** Prepare a top-level physical Task under the Host's existing source lane.
 * The Host durably reserves the identity first. Keep the latest source body,
 * create only absent defaults and publish metadata last. The caller publishes
 * the initial notification only after this preparation has finished. */
export async function preparePhysicalTask(store: PhysicalLocalFiles, snapshot: FilesSnapshot, sourcePath: string,
  assignment: { taskId: string; owner: string; members: readonly string[]; workspace?: TaskHostWorkspace }): Promise<TaskMetadata> {
  filePath(sourcePath); segment(assignment.owner)
  const route = /^tasks\/[^/]+_(P|O)\.md$/.exec(sourcePath)?.[1] as TaskRoute | undefined
  if (!route) throw new Error('New tasks use tasks/<name>_P.md or tasks/<name>_O.md.')
  if (!taskIdentity('Task ID: ' + assignment.taskId)) throw new Error('Assigned task identity must be a UUID.')
  const source = await store.update(sourcePath, bytes => {
    if (bytes === undefined) throw new Error('Task source is missing: ' + sourcePath)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), identity = taskIdentity(text)
    if (identity && identity !== assignment.taskId) throw new Error('Task source now belongs to another Task: ' + sourcePath)
    return { value: text, ...(!identity ? { content: 'Task ID: ' + assignment.taskId + '\n' + text } : {}) }
  })
  const metadataPath = paths.task(assignment.taskId)
  const existing = await readJson<TaskMetadata>(store, snapshot, metadataPath)
  if (existing && (existing.taskId !== assignment.taskId || existing.sourcePath !== sourcePath || existing.parent))
    throw new Error('The top-level Task source does not match its existing metadata: ' + sourcePath)
  if (existing && existing.status !== 'running') return existing
  const task: TaskMetadata = existing ?? {
    version: 1, taskId: assignment.taskId, route, sourcePath, owner: assignment.owner, status: 'running',
    archiveFolder: taskWorkspaceFolder(taskSourceName(sourcePath), assignment.taskId),
    workspaceFolder: taskWorkspaceFolder(taskSourceName(sourcePath), assignment.taskId),
    members: [...new Set([assignment.owner, ...assignment.members])],
    ...(assignment.workspace ? { hostWorkspaces: { [assignment.workspace.instanceUUID]: assignment.workspace.root } } : {}),
  }
  const cleanPlan = taskIdentity(source) ? source.replace(/^Task ID: [^\r\n]+\r?\n?/, '') : source
  for (const change of taskInitializationFiles(task)) {
    if (change.content === undefined || change.content === null) continue
    await store.createIfAbsent(change.path, task.route === 'P' && change.path === paths.inbox(task.taskId, task.owner)
      ? cleanPlan : change.content)
  }
  // Existing metadata is authoritative, including authored/custom fields.
  if (!existing) await store.createIfAbsent(metadataPath, encodeJson(task))
  const current = await readJson<TaskMetadata>(store, snapshot, metadataPath)
  if (!current || current.taskId !== task.taskId || current.sourcePath !== sourcePath || current.parent)
    throw new Error('Prepared Task metadata is unavailable at its own source: ' + sourcePath)
  return current
}

/** Initializes the identity, routing and record references as one transaction.
 * Planner_Inbox is the Planner wake-up caused by an Inbox delivery, not a
 * Foreground admission signal. It is committed with that delivery.
 */
export async function initializeTask(store: FilesStore, snapshot: FilesSnapshot, sourcePath: string,
  owner: string, members: readonly string[], assignedTaskId?: string, workspace?: TaskHostWorkspace): Promise<PlannedChange<TaskMetadata>> {
  const source = await store.read(snapshot, filePath(sourcePath))
  if (source === undefined) throw new Error('Task source is missing: ' + sourcePath)
  return planTask(store, snapshot, sourcePath, owner, members, source, assignedTaskId, workspace)
}
async function planTask(store: FilesStore, snapshot: FilesSnapshot, sourcePath: string,
  owner: string, members: readonly string[], source: string, assignedTaskId?: string, workspace?: TaskHostWorkspace): Promise<PlannedChange<TaskMetadata>> {
  filePath(sourcePath); segment(owner)
  const route = /^tasks\/[^/]+_(P|O)\.md$/.exec(sourcePath)?.[1] as TaskRoute | undefined
  if (!route) throw new Error('New tasks use tasks/<name>_P.md or tasks/<name>_O.md.')
  if (assignedTaskId && !taskIdentity('Task ID: ' + assignedTaskId)) throw new Error('Assigned task identity must be a UUID.')
  const taskId = taskIdentity(source) ?? assignedTaskId ?? randomUUID()
  const existing = await readJson<TaskMetadata>(store, snapshot, paths.task(taskId))
  if (existing) return { value: existing, changes: await restoreTaskInitialization(store, snapshot, existing) }
  const metadata: TaskMetadata = { version: 1, taskId, route, sourcePath, owner, status: 'running', archiveFolder: taskWorkspaceFolder(taskSourceName(sourcePath), taskId), workspaceFolder: taskWorkspaceFolder(taskSourceName(sourcePath), taskId), members: [...new Set([owner, ...members])], ...(workspace ? { hostWorkspaces: { [workspace.instanceUUID]: workspace.root } } : {}) }
  const changes = new Map<string, FileChange>()
  const add = (change: FileChange) => changes.set(change.path, change)
  add({ path: sourcePath, content: taskIdentity(source) ? source : 'Task ID: ' + taskId + '\n' + source })
  add({ path: paths.task(taskId), content: encodeJson(metadata) })
  for (const change of await restoreTaskInitialization(store, snapshot, metadata)) add(change)
  if (route === 'P') {
    const cleanPlan = taskIdentity(source) ? source.replace(/^Task ID: [^\r\n]+\r?\n?/, '') : source
    // Only the absent Inbox template receives the initial requirement. An
    // interrupted creation may already have durable member content or status.
    if (changes.has(paths.inbox(taskId, owner))) add({ path: paths.inbox(taskId, owner), content: cleanPlan })
    add({ path: paths.state(owner, taskId) + '/Planner_Inbox', content: '' })
  } else add({ path: paths.state(owner, taskId) + '/Organizer_Task', content: '' })
  return { value: metadata, changes: [...changes.values()] }
}

/** AI-selected independent objective (P) or bundled objectives (O), owned by an exact member. */
export async function dispatchPlannerObjective(store: FilesStore, snapshot: FilesSnapshot, parent: TaskMetadata,
  objectiveId: string, member: string, plan: string, records: readonly FileChange[] = [],
  route: TaskRoute = 'P', members?: readonly string[]): Promise<FileChange[]> {
  segment(objectiveId); segment(member)
  if (parent.route !== 'O' || parent.status !== 'running') throw new Error('Independent child dispatch requires an open O package.')
  if (!(parent.members ?? [parent.owner]).includes(member)) throw new Error('Choose an actual member registered in this task package.')
  const childMembers = [...new Set([member, ...(members ?? (route === 'O' ? parent.members ?? [parent.owner] : []))])]
  if (route !== 'P' && route !== 'O') throw new Error('Choose the explicit P or O child route.')
  for (const participant of childMembers) {
    segment(participant)
    if (!(parent.members ?? [parent.owner]).includes(participant)) throw new Error('Child scope must remain within the parent package registered members.')
  }
  const previous = parent.children?.find(child => child.objectiveId === objectiveId)
  if (previous) {
    if (previous.member !== member) throw new Error('An existing objective remains assigned to its original member.')
    const child = await readJson<TaskMetadata>(store, snapshot, paths.task(previous.taskId))
    if (!child || child.taskId !== previous.taskId || child.route !== route || child.owner !== member || child.parent?.taskId !== parent.taskId
      || child.parent.owner !== parent.owner || child.parent.objectiveId !== objectiveId) throw new Error('Objective child ownership is inconsistent.')
    if (isTerminalTask(child)) throw new Error('A completed child Task stays closed; create a new objective identity referencing its results.')
    if (members && (child.members?.length !== childMembers.length || childMembers.some(participant => !child.members?.includes(participant))))
      throw new Error('An existing child retains its assigned member scope; supplement its requirement without changing ownership.')
    const source = await store.read(snapshot, child.sourcePath)
    const requirement = source === undefined ? 'Task ID: ' + child.taskId + '\n' + plan : source + '\n\n' + plan
    const repaired = await restoreTaskInitialization(store, snapshot, child)
    if (route === 'O') return [...repaired, ...records, { path: child.sourcePath, content: requirement },
      { path: paths.state(member, child.taskId) + '/Organizer_Task', content: '' }]
    const inboxPath = paths.inbox(child.taskId, member), inbox = await store.read(snapshot, inboxPath)
    return [...repaired.filter(change => change.path !== inboxPath), ...records,
      { path: child.sourcePath, content: requirement },
      // A deleted Inbox starts empty and receives only this actual new delivery.
      { path: inboxPath, content: inbox === undefined ? plan : inbox + '\n\n' + plan },
      { path: paths.state(member, child.taskId) + '/Planner_Inbox', content: '' }]
  }
  const taskId = randomUUID(), sourcePath = 'tasks/' + taskId + '_' + route + '.md'
  const initialized = await planTask(store, snapshot, sourcePath, member, childMembers, 'Task ID: ' + taskId + '\n' + plan, taskId)
  const { workspaceFolder: _childFolder, ...childMetadata } = initialized.value
  const ownName = taskSourceName(sourcePath), leaf = ownName.toLowerCase() === taskId.toLowerCase() ? taskId.toLowerCase() : taskWorkspaceFolder(ownName, taskId)
  const child: TaskMetadata = { ...childMetadata, archiveFolder: paths.archive(parent).slice('archives/'.length) + '/' + leaf, parent: { taskId: parent.taskId, owner: parent.owner, objectiveId } }
  const children = [...(parent.children ?? []), { objectiveId, taskId, member }]
  const cache = await readJson<{ version: number; links: Array<{ kind: 'file' | 'directory'; path: string }> }>(store, snapshot, paths.cache(parent.taskId))
  const links = [...(cache?.links ?? taskCacheLinks(parent)), { kind: 'file' as const, path: paths.task(taskId) }]
  return [...initialized.changes.filter(change => change.path !== paths.task(taskId)),
    { path: paths.task(taskId), content: encodeJson(child) },
    { path: paths.task(parent.taskId), content: encodeJson({ ...parent, children }) },
    { path: paths.cache(parent.taskId), content: encodeJson({ version: 1, links }) }, ...records]
}
export const childCompletionSignal = (parent: NonNullable<TaskMetadata['parent']>, childTaskId: string): string =>
  paths.state(parent.owner, parent.taskId) + '/Organizer_Child_' + segment(childTaskId)

