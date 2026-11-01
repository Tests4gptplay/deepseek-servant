import { randomUUID } from 'node:crypto'
import { filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'

export type TaskRoute = 'P' | 'O'
export interface TaskMetadata {
  version: 1
  taskId: string
  route: TaskRoute
  sourcePath: string
  owner: string
  status: 'running' | 'complete'
  resultPaths?: string[]
  /** Registered task participants remain here even while their Host is offline. */
  members?: string[]
}
export interface MemberStatus { state: 'running' | 'complete'; deliveryId: string }
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
  inboxCursor: (taskId: string, member: string) => 'task-runs/' + segment(taskId) + '/' + segment(member) + '/inbox-observation.json',
  cache: (taskId: string) => 'Recorder Cache/' + segment(taskId) + '/links.json',
  archive: (taskId: string) => 'archives/' + segment(taskId),
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
  if (!value || typeof value !== 'object' || !('state' in value) || !('deliveryId' in value)
    || typeof value.state !== 'string' || !['running', 'complete'].includes(value.state) || typeof value.deliveryId !== 'string') {
    throw new Error('Invalid member status: ' + path)
  }
  return value as MemberStatus
}
export function taskIdentity(text: string): string | undefined {
  return /^Task ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\r?\n|$)/i.exec(text)?.[1]
}
function templates(taskId: string, member: string): FileChange[] {
  const root = paths.member(taskId, member)
  return [
    { path: paths.inbox(taskId, member), content: '' },
    { path: paths.memberStatus(taskId, member), content: encodeJson({ state: 'running', deliveryId: '' } satisfies MemberStatus) },
    { path: root + '/Planner_Memory.md', content: '' },
    { path: root + '/Plan_Note.md', content: '' },
    { path: root + '/Plan.md', content: '' },
    { path: root + '/Reply.md', content: '' },
  ]
}
/** Initializes the identity, routing and record references as one transaction.
 * Planner_Inbox is the Planner wake-up caused by an Inbox delivery, not a
 * Foreground admission signal. It is written later by discoverInbox.
 */
export async function initializeTask(store: FilesStore, snapshot: FilesSnapshot, sourcePath: string,
  owner: string, members: readonly string[], assignedTaskId?: string): Promise<PlannedChange<TaskMetadata>> {
  filePath(sourcePath); segment(owner)
  const route = /^tasks\/[^/]+_(P|O)\.md$/.exec(sourcePath)?.[1] as TaskRoute | undefined
  if (!route) throw new Error('New tasks use tasks/<name>_P.md or tasks/<name>_O.md.')
  const source = await store.read(snapshot, sourcePath)
  if (source === undefined) throw new Error('Task source is missing: ' + sourcePath)
  if (assignedTaskId && !taskIdentity('Task ID: ' + assignedTaskId)) throw new Error('Assigned task identity must be a UUID.')
  const taskId = taskIdentity(source) ?? assignedTaskId ?? randomUUID()
  const existing = await readJson<TaskMetadata>(store, snapshot, paths.task(taskId))
  if (existing) return { value: existing, changes: [] }
  const metadata: TaskMetadata = { version: 1, taskId, route, sourcePath, owner, status: 'running', members: [...new Set([owner, ...members])] }
  const changes = new Map<string, FileChange>()
  const add = (change: FileChange) => changes.set(change.path, change)
  add({ path: sourcePath, content: taskIdentity(source) ? source : 'Task ID: ' + taskId + '\n' + source })
  add({ path: paths.task(taskId), content: encodeJson(metadata) })
  const run = paths.run(taskId)
  for (const change of [
    { path: run + '/Organizer_Note.md', content: '' }, { path: run + '/Dispatch.md', content: '' },
    ...[...new Set([owner, ...members])].flatMap(member => templates(taskId, member)),
  ]) if (await store.read(snapshot, change.path) === undefined) add(change)
  add({ path: paths.cache(taskId), content: encodeJson({ version: 1, links: [
    { kind: 'file', path: sourcePath }, { kind: 'file', path: paths.task(taskId) }, { kind: 'directory', path: run + '/' },
  ] }) })
  if (route === 'P') {
    const cleanPlan = taskIdentity(source) ? source.replace(/^Task ID: [^\r\n]+\r?\n?/, '') : source
    add({ path: paths.inbox(taskId, owner), content: cleanPlan })
    add({ path: paths.memberStatus(taskId, owner), content: encodeJson({ state: 'running', deliveryId: taskId } satisfies MemberStatus) })
  } else add({ path: paths.state(owner, taskId) + '/Organizer_Task', content: '' })
  return { value: metadata, changes: [...changes.values()] }
}

/** Member assignment and rework update the same Inbox while retaining prior records. */
export async function deliverMember(store: FilesStore, snapshot: FilesSnapshot, task: TaskMetadata,
  member: string, plan: string, records: readonly FileChange[] = [], deliveryId: string = randomUUID()): Promise<FileChange[]> {
  const changes = new Map<string, FileChange>()
  if (!(task.members ?? [task.owner]).includes(member)) changes.set(paths.task(task.taskId), {
    path: paths.task(task.taskId), content: encodeJson({ ...task, members: [...new Set([...(task.members ?? [task.owner]), member])] }),
  })
  for (const template of templates(task.taskId, member)) {
    if (await store.read(snapshot, template.path) === undefined) changes.set(template.path, template)
  }
  for (const record of records) changes.set(record.path, record)
  changes.set(paths.inbox(task.taskId, member), { path: paths.inbox(task.taskId, member), content: plan })
  changes.set(paths.memberStatus(task.taskId, member), { path: paths.memberStatus(task.taskId, member),
    content: encodeJson({ state: 'running', deliveryId } satisfies MemberStatus) })
  return [...changes.values()]
}
/** Discovery is based on the fixed Inbox file's version and explicit delivery identity.
 * Updating completion state alone is not another delivery. Empty Inbox is not completion.
 */
export async function discoverInbox(store: FilesStore, snapshot: FilesSnapshot, taskId: string, member: string): Promise<FileChange[]> {
  const inbox = paths.inbox(taskId, member)
  const entry = (await store.listDirectory(snapshot, inbox.slice(0, inbox.lastIndexOf('/') + 1))).find(entry => entry.path === inbox)
  if (!entry || entry.empty || entry.bytes === 0) return []
  const status = await readMemberStatus(store, snapshot, paths.memberStatus(taskId, member))
  const version = encodeJson({ version: entry.version, deliveryId: status?.deliveryId ?? '' })
  if (await store.read(snapshot, paths.inboxCursor(taskId, member)) === version) return []
  return [
    { path: paths.inboxCursor(taskId, member), content: version },
    { path: paths.state(member, taskId) + '/Planner_Inbox', content: '' },
  ]
}
/** Called by the receiving AI, not the Host's discovery loop. */
export async function claimSignals(store: FilesStore, snapshot: FilesSnapshot,
  signals: readonly string[], records: readonly FileChange[]): Promise<FileChange[]> {
  const removals: FileChange[] = []
  for (const signal of signals) {
    filePath(signal)
    if (!signal.startsWith('state/') || signal.split('/').at(-1) === 'recovery') throw new Error('Claim only ordinary state notifications; recovery has its own Planner consumption.')
    if (await store.read(snapshot, signal) === undefined) throw new Error('Notification is no longer present: ' + signal)
    removals.push({ path: signal, content: null })
  }
  return [...records, ...removals]
}
export async function completeMember(store: FilesStore, snapshot: FilesSnapshot, taskId: string, member: string,
  results: readonly FileChange[]): Promise<FileChange[]> {
  const current = await readMemberStatus(store, snapshot, paths.memberStatus(taskId, member))
  if (!current) throw new Error('Member Inbox status is missing.')
  return [...results, { path: paths.memberStatus(taskId, member), content: encodeJson({ ...current, state: 'complete' }) },
    { path: paths.state(member, taskId) + '/complete', content: '' }]
}
