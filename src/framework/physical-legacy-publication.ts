import { createHash } from 'node:crypto'
import type { LegacyTask, MigrationManifest, LegacyControlInput, LegacyAnswerInput } from './legacy-migration.js'
import { legacyRoutingSignal } from './legacy-routing.js'
import { legacyMigratedTaskId } from './legacy-record-export.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { inTasks, physicalTaskTerminalPath } from './physical-task-terminal.js'
import { publishPreparedPhysicalFile, samePhysicalPublication } from './physical-publication-evidence.js'
import type { DirectSignalSources } from './physical-direct-delivery.js'
import type { PreparedLocalAppend } from './local-record-files.js'
import { readTaskHistoryIdentity, readTaskReferenceIdentity } from './task-history.js'
import { taskSourceName, taskWorkspaceFolder } from './workspace-paths.js'
import { paths, encodeJson, readJson, taskLifecycle, taskInitializationFiles, type TaskMetadata, type TaskRoute } from './task-files.js'
import { workerPaths } from './role-tools.js'
import { filePath, withSnapshot, type FilesSnapshot } from './transactions.js'

type Action = LegacyControlInput & { commandId: string; action: 'resume' | 'answer'; taskId: string; waitId?: string; answer?: string }
interface ControlRecord extends Action { physicalPending?: true; supersededBy?: { status: 'complete' | 'cancelled'; lifecycleId?: string } }
interface Signal { path: string; stage: string; version?: string; published?: true }
interface ControlPublication {
  version: 1; kind: 'control'; manifestPath: string; oldTaskId: string; taskId: string; controlPath: string; action: Action
  target?: TaskMetadata; sourcePrepared?: PreparedLocalAppend; sourcePublished?: true; materialsReady?: true
  signal?: Signal; finished?: true
}
export interface PhysicalLegacyRoute { manifestPath: string; oldTaskId: string; name: string; route: TaskRoute; decision: string }
interface RoutePublication {
  version: 1; kind: 'route'; manifestPath: string; oldTaskId: string; taskId: string; task: TaskMetadata
  sourceStage: string; sourceText?: string; sourceVersion?: string; sourcePublished?: true; originalPaths: string[]
  inboxPrepared?: PreparedLocalAppend; inboxPublished?: true; routingDecision: string
  decisionPrepared?: PreparedLocalAppend; decisionPublished?: true; materialsReady?: true; signal: Signal; finished?: true
}
type Publication = ControlPublication | RoutePublication
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const controlPath = (input: LegacyControlInput & { action: Action['action']; waitId?: string }): string =>
  input.manifestPath.slice(0, -'manifest.json'.length) + 'controls/' + hash(input.oldTaskId + '\0' + input.member
    + (input.action === 'answer' ? '\0answer\0' + input.waitId : '\0resume')) + '.json'
const pendingPath = (fact: Pick<ControlPublication, 'kind' | 'controlPath'> | Pick<RoutePublication, 'kind' | 'taskId'>): string =>
  fact.kind === 'control' ? 'state/.Legacy_Control_' + hash(fact.controlPath) + '.json' : 'state/.Legacy_Route_' + fact.taskId + '.json'
export const isPhysicalLegacyPendingPath = (path: string): boolean => /^state\/\.Legacy_(?:Control_[a-f0-9]{64}|Route_[a-f0-9-]{36})\.json$/i.test(path)
const lanes = new Map<string, Promise<unknown>>()
/** Controls and the one semantic route share only their actual mapped Task. */
async function inLegacyTask<T>(files: PhysicalLocalFiles, taskId: string, work: () => Promise<T>): Promise<T> {
  const key = files.directory + '\0' + paths.task(taskId)
  const operation = (lanes.get(key)?.catch(() => {}) ?? Promise.resolve()).then(work)
  lanes.set(key, operation)
  try { return await operation } finally { if (lanes.get(key) === operation) lanes.delete(key) }
}
const decode = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T
async function selected(files: PhysicalLocalFiles, snapshot: FilesSnapshot, manifestPath: string, oldTaskId: string) {
  filePath(manifestPath)
  const manifest = await readJson<MigrationManifest>(files, snapshot, manifestPath)
  if (!manifest || manifest.version !== 1 || manifestPath !== 'technical/legacy-migrations/' + manifest.id + '/manifest.json')
    throw new Error('Choose the actual preserved migration manifest.')
  const mapped = manifest.tasks.find(task => task.oldId === oldTaskId)
  if (!mapped || mapped.taskId !== legacyMigratedTaskId(manifest.id, mapped.oldId)) throw new Error('The original mapped Task identity is inconsistent.')
  filePath(mapped.recordPath); filePath(mapped.continuationPath)
  return { manifest, mapped }
}
async function originalTask(files: PhysicalLocalFiles, snapshot: FilesSnapshot, mapped: MigrationManifest['tasks'][number]): Promise<LegacyTask> {
  const original = await readJson<LegacyTask>(files, snapshot, mapped.continuationPath)
  if (!original || original.id !== mapped.oldId || typeof original.request !== 'string' || !Array.isArray(original.participants))
    throw new Error('Original task requirement is unavailable.')
  return original
}
async function currentTask(files: PhysicalLocalFiles, snapshot: FilesSnapshot, taskId: string, expected?: TaskMetadata): Promise<TaskMetadata | undefined> {
  const current = await readJson<TaskMetadata>(files, snapshot, paths.task(taskId))
  if (current) {
    if (current.taskId !== taskId || current.status !== 'running' || !['P', 'O'].includes(current.route)) throw new Error('The current Task is closed or invalid; legacy control cannot reopen it.')
    if (expected && (taskLifecycle(current) !== taskLifecycle(expected) || current.owner !== expected.owner || current.route !== expected.route || current.sourcePath !== expected.sourcePath))
      throw new Error('The accepted legacy action belongs to a different Task continuation.')
    if (await files.fileInfo(physicalTaskTerminalPath(current))) throw new Error('The current Task already accepted its terminal handoff.')
  } else if (expected || await readTaskHistoryIdentity(files, snapshot, taskId)) throw new Error('The original Task is no longer open; legacy control cannot recreate it.')
  return current
}
async function endedTask(files: PhysicalLocalFiles, snapshot: FilesSnapshot, taskId: string, expected?: TaskMetadata) {
  const actual = await readTaskReferenceIdentity(files, snapshot, taskId)
  if (!actual || !['complete', 'cancelled'].includes(actual.status)) return undefined
  if (expected && (taskLifecycle(actual) !== taskLifecycle(expected) || actual.sourcePath !== expected.sourcePath
    || actual.owner !== expected.owner || actual.route !== expected.route)) throw new Error('The accepted legacy action belongs to another Task lifecycle.')
  return actual
}
async function settleEndedRoute(files: PhysicalLocalFiles, fact: RoutePublication): Promise<void> {
  if (!fact.materialsReady) throw new Error('The Task ended before its accepted original routing input was preserved; the original pending input was retained.')
  // Complete accepted input and exact old-record links preceded metadata. A
  // Recorder can already read them. Never race its Cleaner with a late source,
  // template or business signal write, even if current metadata still exists.
  await files.update(fact.manifestPath, bytes => {
    if (!bytes) return { value: undefined }
    const manifest = decode<MigrationManifest>(bytes), mapped = manifest.tasks.find(task => task.oldId === fact.oldTaskId)
    if (!mapped || mapped.taskId !== fact.taskId || mapped.routePending !== true) return { value: undefined }
    mapped.routePending = false
    return { value: undefined, content: encodeJson(manifest) }
  })
  await retire(files, fact)
}
async function save(files: PhysicalLocalFiles, fact: Publication): Promise<void> { await files.replace(pendingPath(fact), encodeJson(fact)) }
async function signalConfirmed(files: PhysicalLocalFiles, signal: Signal | undefined, sources?: DirectSignalSources): Promise<boolean> {
  if (signal?.published) return true
  if (!signal?.version) return false
  const current = await files.fileInfo(signal.path)
  return !!current && samePhysicalPublication(signal.version, current.version)
    || !!sources && (await sources(signal.path)).some(source => source.path === signal.path && samePhysicalPublication(signal.version!, source.version))
}
async function publishSignal(files: PhysicalLocalFiles, fact: Publication, signal: Signal, sources?: DirectSignalSources): Promise<void> {
  if (signal.published) return
  if (!signal.version) {
    await files.replace(signal.stage, '')
    const info = await files.fileInfo(signal.stage)
    if (!info) throw new Error('The prepared legacy notification is missing.')
    signal.version = info.version; await save(files, fact)
  }
  await publishPreparedPhysicalFile(files, signal.stage, signal.path, signal.version, sources && (() => sources(signal.path)))
  signal.published = true; await save(files, fact)
}
/** Mutate only the addressed member/task within the CURRENT shared manifest. */
async function updateManifest(files: PhysicalLocalFiles, fact: Publication, action?: Action, participantIdentity?: string): Promise<void> {
  await files.update(fact.manifestPath, bytes => {
    if (!bytes) throw new Error('The original migration manifest is missing.')
    const manifest = decode<MigrationManifest>(bytes), mapped = manifest.tasks.find(task => task.oldId === fact.oldTaskId)
    if (!mapped || mapped.taskId !== fact.taskId) throw new Error('The original migration mapping changed.')
    if (['complete', 'cancelled'].includes(mapped.continuation)) throw new Error('Ended legacy work cannot be reopened.')
    if (fact.kind === 'route') mapped.routePending = false
    else {
      mapped.continuation = 'running'
      if (!fact.target) mapped.routePending = true
      const summary = mapped.memberContinuations?.find(item => item.member === action!.member && item.identity === participantIdentity)
      if (summary) {
        summary.continuation = 'running'
        if (action!.action === 'answer') summary.waits = summary.waits?.filter(wait => wait.id !== action!.waitId)
      }
      if (!summary?.waits?.length) {
        const prefix = 'original-control-and-input:' + fact.oldTaskId
        manifest.pendingAdapters = manifest.pendingAdapters.filter(item => item !== prefix + ':' + participantIdentity
          && (item !== prefix || mapped.memberContinuations?.some(member => ['paused', 'wait-user', 'unresolved'].includes(member.continuation) || !!member.waits?.length)))
      }
    }
    return { value: undefined, content: encodeJson(manifest) }
  })
}
async function retire(files: PhysicalLocalFiles, fact: Publication): Promise<void> {
  if (fact.kind === 'control') {
    await files.delete(fact.controlPath + '.source.stage')
    await files.delete(fact.controlPath + '.signal.stage')
  } else {
    for (const path of [fact.sourceStage, fact.sourceStage + '.inbox', fact.sourceStage + '.decision', fact.signal.stage]) await files.delete(path)
  }
  await files.delete(pendingPath(fact))
}
function sameAction(record: Action, action: Action): boolean {
  return JSON.stringify([record.commandId, record.action, record.manifestPath, record.oldTaskId, record.member, record.taskId, record.waitId, record.answer])
    === JSON.stringify([action.commandId, action.action, action.manifestPath, action.oldTaskId, action.member, action.taskId, action.waitId, action.answer])
}
async function finishControl(files: PhysicalLocalFiles, snapshot: FilesSnapshot, fact: ControlPublication, sources?: DirectSignalSources): Promise<void> {
  if (!fact.action || fact.action.taskId !== fact.taskId || fact.action.manifestPath !== fact.manifestPath || controlPath(fact.action) !== fact.controlPath)
    throw new Error('The accepted original legacy control input is missing or inconsistent.')
  await files.createIfAbsent(fact.controlPath, encodeJson({ ...fact.action, physicalPending: true }))
  const record = await readJson<ControlRecord>(files, snapshot, fact.controlPath)
  if (!record || !sameAction(record, fact.action) || record.taskId !== fact.taskId || record.manifestPath !== fact.manifestPath || controlPath(record) !== fact.controlPath)
    throw new Error('The accepted original legacy control is missing or inconsistent.')
  if (!record.physicalPending) { await retire(files, fact); return }
  const { physicalPending: _pending, ...action } = record
  if (fact.finished || await signalConfirmed(files, fact.signal, sources)) {
    await files.replace(fact.controlPath, encodeJson(action)); await retire(files, fact); return
  }
  // A later answer must supplement the accepted route, not restore its old
  // pre-route templates. This exact Task address needs no directory scan.
  const routing = await readJson<RoutePublication>(files, snapshot, pendingPath({ kind: 'route', taskId: fact.taskId }))
  if (routing) await finishRoute(files, snapshot, routing, sources)
  const { manifest, mapped } = await selected(files, snapshot, fact.manifestPath, fact.oldTaskId)
  const original = await originalTask(files, snapshot, mapped)
  const participant = original.participants.find(item => manifest.members[item.identity] === action.member)
  if (!participant) throw new Error('The original participating instance is unavailable.')
  await inTasks(files, [fact.taskId], async () => {
    const ended = await endedTask(files, snapshot, fact.taskId, fact.target)
    if (ended) {
      // The later terminal decision wins. Keep this exact original user input
      // with its actual disposition; do not claim a new business delivery.
      await files.replace(fact.controlPath, encodeJson({ ...action, supersededBy: { status: ended.status, ...(ended.lifecycleId ? { lifecycleId: ended.lifecycleId } : {}) } }))
      await retire(files, fact); return
    }
    const current = await currentTask(files, snapshot, fact.taskId, fact.target)
    if (current && !fact.target) { fact.target = current; await save(files, fact) }
    if (fact.target) {
      if (!fact.sourcePublished) {
        if (!await files.fileInfo(fact.target.sourcePath)) throw new Error('The current Task original source is missing.')
        await files.appendPrepared(fact.target.sourcePath, fact.controlPath + '.source.stage', '\n\n' + encodeJson({
          legacyUserAction: action, originalTask: mapped.recordPath, referenceIndex: fact.manifestPath,
        }), fact.sourcePrepared, async prepared => { fact.sourcePrepared = prepared; await save(files, fact) })
        fact.sourcePublished = true; await save(files, fact)
      }
    } else if (!fact.materialsReady) {
      const context = encodeJson({ originalTask: mapped.recordPath, referenceIndex: fact.manifestPath, original: participant,
        waits: original.waits, userAction: { commandId: action.commandId, action: action.action, manifestPath: action.manifestPath,
          oldTaskId: action.oldTaskId, member: action.member, ...(action.action === 'answer' ? { waitId: action.waitId, answer: action.answer } : {}) } })
      const memberRoot = paths.member(fact.taskId, action.member)
      for (const [path, content] of [[paths.inbox(fact.taskId, action.member), context], [memberRoot + '/Planner_Memory.md', context],
        [memberRoot + '/Plan.md', encodeJson(participant.plan)]] as const) await files.createIfAbsent(path, content)
      for (const child of participant.children) {
        const worker = workerPaths(fact.taskId, action.member, child.id)
        for (const [path, content] of [[worker.contract, encodeJson(child.contract)], [worker.reply, encodeJson(child.reports)],
          [worker.handoff, encodeJson({ reports: child.reports, legacyExecutions: child.executions })], [worker.notes, '']] as const)
          await files.createIfAbsent(path, content)
      }
      fact.materialsReady = true; await save(files, fact)
    }
    await updateManifest(files, fact, action, participant.identity)
    fact.signal ??= { path: fact.target ? paths.state(fact.target.owner, fact.taskId) + (fact.target.route === 'P' ? '/Planner_Foreground' : '/Organizer_Foreground')
      : legacyRoutingSignal(manifest.id, fact.taskId), stage: fact.controlPath + '.signal.stage' }
    await publishSignal(files, fact, fact.signal, sources)
    fact.finished = true; await save(files, fact)
    // This original control is the successful result identity. Its plain v44
    // representation now closes retries before any transient stage is retired.
    await files.replace(fact.controlPath, encodeJson(action))
    await retire(files, fact)
  })
}
async function controlPublication(files: PhysicalLocalFiles, snapshot: FilesSnapshot, record: ControlRecord): Promise<ControlPublication> {
  const path = controlPath(record)
  const fact = await readJson<ControlPublication>(files, snapshot, pendingPath({ kind: 'control', controlPath: path }))
  if (!fact || fact.kind !== 'control' || fact.controlPath !== path || fact.taskId !== record.taskId || fact.manifestPath !== record.manifestPath
    || !sameAction(fact.action, record)) throw new Error('The accepted original legacy control publication is missing or inconsistent.')
  return fact
}
export async function controlPhysicalLegacyTask(files: PhysicalLocalFiles, commandId: string,
  input: LegacyControlInput | LegacyAnswerInput, action: Action['action'], sources?: DirectSignalSources): Promise<{ taskId: string; revision: string }> {
  const identity = await withSnapshot(files, snapshot => selected(files, snapshot, input.manifestPath, input.oldTaskId))
  return inLegacyTask(files, identity.mapped.taskId, () => withSnapshot(files, async snapshot => {
    const { manifest, mapped } = await selected(files, snapshot, input.manifestPath, input.oldTaskId)
    const technical: Action = { commandId, action, ...input, taskId: mapped.taskId }, path = controlPath(technical)
    const record = await readJson<ControlRecord>(files, snapshot, path)
    let pending = await readJson<ControlPublication>(files, snapshot, pendingPath({ kind: 'control', controlPath: path }))
    if (pending && (!pending.action || !sameAction(pending.action, technical))) throw new Error('This original continuation already has a different accepted control.')
    if (record) {
      if (!sameAction(record, technical)) throw new Error('This original continuation already has a different accepted control.')
      if (!record.physicalPending) return { taskId: mapped.taskId, revision: snapshot.revision }
    } else if (!pending) {
      if (['cancelled', 'complete'].includes(mapped.continuation)) throw new Error('Ended legacy work cannot be reopened.')
      const original = await originalTask(files, snapshot, mapped)
      const participant = original.participants.find(item => manifest.members[item.identity] === input.member)
      if (!participant) throw new Error('Legacy control belongs to a mapped participating instance.')
      const current = participant.continuation ?? original.continuation
      const summary = mapped.memberContinuations?.find(item => item.member === input.member && item.identity === participant.identity)
      if (action === 'resume' && current !== 'paused') throw new Error('This legacy task is not awaiting resume.')
      if (action === 'answer') {
        const answer = input as LegacyAnswerInput
        if (current !== 'wait-user' || summary?.waits && !summary.waits.some(wait => wait.id === answer.waitId)
          || !original.waits?.some(wait => wait.id === answer.waitId && wait.memberIdentity === participant.identity && wait.question))
          throw new Error('The original user question is not pending for this instance.')
        if (typeof answer.answer !== 'string' || !answer.answer.trim()) throw new Error('Answer the original pending question.')
      }
      const target = await currentTask(files, snapshot, mapped.taskId)
      pending = { version: 1, kind: 'control', manifestPath: input.manifestPath, oldTaskId: input.oldTaskId, taskId: mapped.taskId,
        controlPath: path, action: technical, ...(target ? { target } : {}) }
      // Save the exact accepted input before any original-control or stage
      // write. The existing Host enumeration can recover every accepted action.
      if (!await files.createIfAbsent(pendingPath(pending), encodeJson(pending))) throw new Error('The original legacy control changed; inspect its saved action.')
    }
    await finishControl(files, snapshot, pending ?? await controlPublication(files, snapshot, record!), sources)
    return { taskId: mapped.taskId, revision: snapshot.revision }
  }))
}
async function finishRoute(files: PhysicalLocalFiles, snapshot: FilesSnapshot, fact: RoutePublication, sources?: DirectSignalSources): Promise<void> {
  if (fact.finished || await signalConfirmed(files, fact.signal, sources)) { await retire(files, fact); return }
  await inTasks(files, [fact.taskId], async () => {
    if (await endedTask(files, snapshot, fact.taskId, fact.task)) { await settleEndedRoute(files, fact); return }
    await currentTask(files, snapshot, fact.taskId)
    const existing = await readJson<TaskMetadata>(files, snapshot, paths.task(fact.taskId))
    if (existing) await currentTask(files, snapshot, fact.taskId, fact.task)
    if (!fact.sourceVersion) {
      if (typeof fact.sourceText !== 'string') throw new Error('The accepted original routing input is missing.')
      await files.replace(fact.sourceStage, fact.sourceText)
      const staged = await files.fileInfo(fact.sourceStage)
      if (!staged) throw new Error('The prepared preserved requirement is missing.')
      fact.sourceVersion = staged.version; delete fact.sourceText; await save(files, fact)
    }
    if (!fact.materialsReady) {
      const source = await files.read(snapshot, fact.sourceStage)
      if (source === undefined) throw new Error('The accepted original routing requirement is missing.')
      for (const change of taskInitializationFiles(fact.task)) if (typeof change.content === 'string' && change.path !== paths.inbox(fact.taskId, fact.task.owner))
        await files.createIfAbsent(change.path, change.content)
      if (fact.task.route === 'P' && !fact.inboxPublished) {
        const path = paths.inbox(fact.taskId, fact.task.owner), prefix = await files.fileInfo(path) ? '\n\n## Preserved requirement\n' : ''
        await files.appendPrepared(path, fact.sourceStage + '.inbox', prefix + source, fact.inboxPrepared,
          async prepared => { fact.inboxPrepared = prepared; await save(files, fact) })
        fact.inboxPublished = true; await save(files, fact)
      }
      if (fact.task.route === 'O' && !fact.decisionPublished) {
        // Foreground's actual choice belongs in this O Task's own Note, not
        // a revived shared member/Planner Inbox responsibility. Original user
        // input remains in the exact preserved files linked below.
        const text = '\n\n## Preserved routing decision\n' + fact.routingDecision + '\n' + encodeJson({ originalPaths: fact.originalPaths })
        await files.appendPrepared(paths.run(fact.taskId) + '/Organizer_Note.md', fact.sourceStage + '.decision', text, fact.decisionPrepared,
          async prepared => { fact.decisionPrepared = prepared; await save(files, fact) })
        fact.decisionPublished = true; await save(files, fact)
      }
      await files.update(paths.cache(fact.taskId), bytes => {
        if (!bytes) throw new Error('The Task Recorder Cache is missing.')
        const cache = decode<{ version: number; links: Array<{ kind: string; path: string }> }>(bytes)
        if (!Array.isArray(cache.links)) throw new Error('The Task Recorder Cache links are invalid.')
        for (const path of fact.originalPaths) {
          filePath(path)
          if (!cache.links.some(link => link.kind === 'file' && link.path === path)) cache.links.push({ kind: 'file', path })
        }
        return { value: undefined, content: encodeJson(cache) }
      })
      fact.materialsReady = true; await save(files, fact)
    }
    // Complete defaults precede the mapped identity. Source discovery then sees
    // that identity instead of reserving a new owner. No readiness flag or gate.
    await files.createIfAbsent(paths.task(fact.taskId), encodeJson(fact.task))
    await currentTask(files, snapshot, fact.taskId, fact.task)
    if (!fact.sourcePublished) {
      const result = await files.renameIfAbsent(fact.sourceStage, fact.task.sourcePath)
      if (result !== 'renamed') {
        const target = await files.fileInfo(fact.task.sourcePath)
        if (!target || !samePhysicalPublication(fact.sourceVersion, target.version)) throw new Error('The Task filename changed before the preserved requirement was confirmed; current bytes were retained.')
      }
      fact.sourcePublished = true; await save(files, fact)
    }
    await updateManifest(files, fact)
    await publishSignal(files, fact, fact.signal, sources)
    fact.finished = true; await save(files, fact); await retire(files, fact)
  })
}
/** Existing Foreground tool only: no discovery creates a new route or Task. */
export async function routePhysicalLegacyTask(files: PhysicalLocalFiles, input: PhysicalLegacyRoute,
  assertLive: () => void | Promise<void>, sources?: DirectSignalSources): Promise<void> {
  await assertLive(); filePath(input.name)
  if (input.name.includes('/') || !['P', 'O'].includes(input.route)) throw new Error('Choose a Task filename and explicit P/O route.')
  const identity = await withSnapshot(files, snapshot => selected(files, snapshot, input.manifestPath, input.oldTaskId))
  await inLegacyTask(files, identity.mapped.taskId, () => withSnapshot(files, async snapshot => {
    await assertLive()
    const { manifest, mapped } = await selected(files, snapshot, input.manifestPath, input.oldTaskId)
    const address = pendingPath({ kind: 'route', taskId: mapped.taskId })
    let pending = await readJson<RoutePublication>(files, snapshot, address)
    if (pending) {
      if (pending.manifestPath !== input.manifestPath || pending.oldTaskId !== input.oldTaskId || pending.task.route !== input.route)
        throw new Error('The accepted legacy routing responsibility retains its original target and route.')
      await finishRoute(files, snapshot, pending, sources); return
    }
    const existing = await currentTask(files, snapshot, mapped.taskId)
    if (existing) {
      if (existing.owner !== manifest.owner || existing.route !== input.route) throw new Error('An existing migrated Task retains its explicit route and owner.')
      return
    }
    if (!mapped.routePending || !['running', 'wait-result'].includes(mapped.continuation)) throw new Error('This preserved Task has no pending Foreground routing responsibility.')
    const original = await originalTask(files, snapshot, mapped)
    const root = input.manifestPath.slice(0, -'manifest.json'.length), controls: Array<{ path: string; action: Action }> = []
    for (const entry of await files.listDirectory(snapshot, root + 'controls/')) {
      if (!/\/[a-f0-9]{64}\.json$/.test(entry.path)) continue
      const action = await readJson<ControlRecord>(files, snapshot, entry.path)
      if (action?.oldTaskId !== mapped.oldId || action.taskId !== mapped.taskId) continue
      if (action.physicalPending) await finishControl(files, snapshot, await controlPublication(files, snapshot, action), sources)
      const { physicalPending: _pending, ...accepted } = action
      controls.push({ path: entry.path, action: accepted })
    }
    const latest = await selected(files, snapshot, input.manifestPath, input.oldTaskId)
    const sourcePath = 'tasks/' + input.name + '_' + input.route + '.md'
    if (await files.fileInfo(sourcePath)) throw new Error('This task filename already exists; select a distinct task name.')
    const source = 'Task ID: ' + mapped.taskId + '\n' + original.request + '\n\n## Preserved continuation\n' + encodeJson({
      originalTask: mapped.recordPath, continuationPath: mapped.continuationPath, referenceIndex: input.manifestPath,
      memberRecords: mapped.members.map(member => paths.member(mapped.taskId, member)), memberContinuations: latest.mapped.memberContinuations, controls,
    }) + '\nPreserve participant pauses, pending questions, cancellations and completed effects. Intake of this requirement does not authorize reopening held work.\n\n## Foreground routing decision\n' + input.decision
    const folder = taskWorkspaceFolder(taskSourceName(sourcePath), mapped.taskId)
    const task: TaskMetadata = { version: 1, taskId: mapped.taskId, route: input.route, sourcePath, owner: manifest.owner,
      status: 'running', archiveFolder: folder, workspaceFolder: folder, members: [...new Set([manifest.owner, ...mapped.members])] }
    const sourceStage = root + 'route-' + mapped.taskId + '.source.stage'
    pending = { version: 1, kind: 'route', manifestPath: input.manifestPath, oldTaskId: input.oldTaskId, taskId: mapped.taskId, task,
      sourceStage, sourceText: source, routingDecision: input.decision, originalPaths: [mapped.recordPath, mapped.continuationPath, ...controls.map(control => control.path)], signal: { path: paths.state(task.owner, task.taskId) + (task.route === 'P' ? '/Planner_Inbox' : '/Organizer_Task'), stage: sourceStage + '.signal' } }
    // Accept this one original source input before creating its temporary file.
    // A process exit cannot leave a prepared source with no restart owner.
    await assertLive(); await files.createIfAbsent(address, encodeJson(pending))
    const accepted = await readJson<RoutePublication>(files, snapshot, address)
    if (!accepted || accepted.manifestPath !== input.manifestPath || accepted.oldTaskId !== input.oldTaskId
      || accepted.task.sourcePath !== sourcePath || accepted.task.route !== input.route) throw new Error('The accepted legacy route changed before publication.')
    await finishRoute(files, snapshot, accepted, sources)
  }))
}
/** Called only for an exact pending entry from the Host's existing state/
 * observation. It never enumerates migrations or admits unrequested old work. */
export async function resumePhysicalLegacyPublication(files: PhysicalLocalFiles, path: string, sources?: DirectSignalSources): Promise<void> {
  if (!isPhysicalLegacyPendingPath(path)) throw new Error('Choose the exact unfinished legacy publication.')
  const observed = await withSnapshot(files, snapshot => readJson<Publication>(files, snapshot, path))
  if (!observed) return
  if (observed.version !== 1 || !['control', 'route'].includes(observed.kind) || pendingPath(observed) !== path)
    throw new Error('The accepted legacy publication identity is invalid.')
  await inLegacyTask(files, observed.taskId, () => withSnapshot(files, async snapshot => {
    const fact = await readJson<Publication>(files, snapshot, path)
    if (!fact) return
    if (fact.kind === 'control') await finishControl(files, snapshot, fact, sources)
    else await finishRoute(files, snapshot, fact, sources)
  }))
}
