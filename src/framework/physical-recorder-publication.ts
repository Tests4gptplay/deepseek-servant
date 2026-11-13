import { createHash } from 'node:crypto'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { prepareRecorderOutputReferences, selectRecorderOutputReferences, prepareRecorderRetention, resolveChildResultReferences, type RetentionManifest, type RecorderRetentionOriginalSink } from './recorder-retention.js'
import { isSkillFile, publishPhysicalSkillProposal, SkillMergeRequired, type SkillMergeBase, type SkillProposal } from './skill-merge.js'
import { readTaskHistoryIdentity, readTaskReferenceIdentity, taskHistoryPath } from './task-history.js'
import { readTaskArchiveState, taskArchiveLifecycle } from './task-archive.js'
import { taskFamily } from './task-relations.js'
import { paths, encodeJson, readJson, taskLifecycle, taskArchiveOwnsPath, isTerminalTask, taskWorkingRoots, taskIdentity, type TaskMetadata } from './task-files.js'
import { withSnapshot, filePath, type FilesSnapshot } from './transactions.js'

export interface PhysicalRecorderInput {
  commandId: string
  signal?: AbortSignal
  taskId: string
  lifecycleId?: string
  owner: string
  outputs: SkillProposal[]
  retainedPaths: string[]
  bases: Map<string, SkillMergeBase | undefined>
}
export interface PhysicalRecorderIncomplete {
  saved: false
  recorderCommand: string
  pendingSkills: Array<{ path: string; commandId: string; outcome: 'merge-required' | 'unknown'; reason: string; detail?: unknown }>
  continuation: string
}
export interface PhysicalRecorderResult {
  saved: true
  recorderCommand: string
  skillIssues: string[]
  missingReferences?: string[]
  unmergedSkills: Array<{ path: string; reason: string; proposalPreservedAt: string }>
}
interface SkillAttempt {
  commandId?: string
  proposal: SkillProposal
  base?: SkillMergeBase
  result?: { published: true } | { published: false; reason: string; detail?: unknown; uncertain?: true }
}
/** Raw originals have one exact owned stage each. Metadata and the constant-size
 * publication cursor never embed those bytes or rewrite a complete archive. */
interface ArchiveBody { path: string; stage: string; sha256: string; previous: string | null }
interface RecorderPackage {
  records: ArchiveBody[]
  originals: ArchiveBody[]
  identities: ArchiveBody[]
  skillProposals?: ArchiveBody[]
  catalog?: ArchiveBody
  final?: true
  retention: RetentionManifest
  resultPaths?: string[]
}
interface RecorderProgress { next: number; attempting?: true; resultsUpdated?: true }
interface PendingRecorder {
  version: 2
  kind: 'recorder-publication'
  commandId: string
  request: string
  task: TaskMetadata
  outputs: Array<{ path: string; commandId?: string }>
  retainedPaths: string[]
  cleanerPrepared?: true
}
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export const physicalRecorderPendingPath = (taskId: string): string => paths.run(taskId) + '/.recorder-handoff.json'
const cleanerStage = (pending: PendingRecorder): string => paths.run(pending.task.taskId) + '/.recorder-cleaner-' + hash(pending.commandId) + '.stage'
const cleanerPath = (task: Pick<TaskMetadata, 'taskId' | 'owner'>): string => paths.state(task.owner, task.taskId) + '/Cleaner'
const requestKey = (input: Pick<PhysicalRecorderInput, 'outputs' | 'retainedPaths'>): string => hash(JSON.stringify({
  outputs: input.outputs.map(({ path, text }) => ({ path, text })), retainedPaths: input.retainedPaths,
}))
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const persist = (files: PhysicalLocalFiles, pending: PendingRecorder) => files.replace(physicalRecorderPendingPath(pending.task.taskId), encodeJson(pending))
// Only concurrent invocations of the SAME Recorder handoff coordinate. Other
// records, Tasks, skill paths and terminal/Foreground work do not enter this lane.
const publications = new Map<string, Promise<unknown>>()
async function ownHandoff<T>(files: PhysicalLocalFiles, taskId: string, action: () => Promise<T>): Promise<T> {
  const key = files.directory + '\0' + physicalRecorderPendingPath(taskId), previous = publications.get(key)
  const result = (previous?.catch(() => {}) ?? Promise.resolve()).then(action)
  publications.set(key, result)
  try { return await result } finally { if (publications.get(key) === result) publications.delete(key) }
}
function sameTask(task: TaskMetadata | undefined, input: Pick<PhysicalRecorderInput, 'taskId' | 'owner' | 'lifecycleId'>): void {
  if (!task || task.taskId !== input.taskId || task.owner !== input.owner || taskLifecycle(task) !== taskLifecycle(input))
    throw new Error('Recorder handoff belongs to a missing or different Task lifecycle/owner.')
  if (task.parent || !isTerminalTask(task)) throw new Error('Only the terminal total Task Recorder can publish archives and request Cleaner.')
}
const resultOf = (retention: RetentionManifest): PhysicalRecorderResult => ({ saved: true, recorderCommand: retention.recorderCommand!,
  skillIssues: retention.skillPublication?.issues ?? [], unmergedSkills: retention.skillPublication?.unmerged ?? [],
  ...(retention.missingReferences?.length ? { missingReferences: retention.missingReferences } : {}) })
/** Replay uses actual notice/release evidence, not absence of a stage file.
 * The Cleaner does not call this, inspect archives, or provide a new ACK. */
async function handoffObserved(files: PhysicalLocalFiles, snapshot: FilesSnapshot, task: TaskMetadata): Promise<boolean> {
  if (await files.readBytes(snapshot, cleanerPath(task)) !== undefined) return true
  const runtime = await readJson<TaskMetadata>(files, snapshot, paths.task(task.taskId))
  if (!runtime) {
    const history = await readTaskHistoryIdentity(files, snapshot, task.taskId)
    return !!history && taskLifecycle(history) === taskLifecycle(task) && history.owner === task.owner
  }
  sameTask(runtime, task)
  const state = await readTaskArchiveState(files, snapshot, task)
  return Object.values(taskArchiveLifecycle(state, task)?.hosts ?? {}).some(host => host.released === true)
}
const stageRoot = (pending: PendingRecorder): string => paths.run(pending.task.taskId) + '/.recorder-handoff/' + hash(pending.commandId)
const outputCommand = (pending: PendingRecorder, path: string): string => pending.outputs.find(output => output.path === path)?.commandId ?? pending.commandId
const outputRoot = (pending: PendingRecorder, path: string): string => stageRoot({ ...pending, commandId: outputCommand(pending, path) })
const inputPath = (pending: PendingRecorder, path: string): string => outputRoot(pending, path) + '/inputs/' + hash(path) + '.json'
const packagePath = (pending: PendingRecorder): string => stageRoot(pending) + '/archive-plan.json'
const progressPath = (pending: PendingRecorder): string => stageRoot(pending) + '/progress.json'
const skillPath = (pending: PendingRecorder, path: string): string => outputRoot(pending, path) + '/skill-results/' + hash(path) + '.json'
const stagePath = (pending: PendingRecorder, category: string, key: string): string => stageRoot(pending) + '/' + category + '/' + hash(key) + '.raw'
async function stageBody(files: PhysicalLocalFiles, snapshot: FilesSnapshot, pending: PendingRecorder,
  category: string, key: string, path: string, bytes: Uint8Array): Promise<ArchiveBody> {
  const stage = stagePath(pending, category, key), descriptor = stage + '.json'
  const existing = await readJson<ArchiveBody>(files, snapshot, descriptor)
  if (existing) {
    if (existing.path !== path || existing.stage !== stage || existing.sha256 !== hash(bytes))
      throw new Error('Prepared Recorder original differs from its exact source: ' + key)
    return existing
  }
  // A process stop after raw publication but before its descriptor must preserve
  // the first captured bytes. No copy is overwritten or inferred from absence.
  await files.createIfAbsent(stage, bytes)
  const captured = await files.readBytes(snapshot, stage)
  if (captured === undefined || hash(captured) !== hash(bytes)) throw new Error('Recorder stage differs from its accepted original: ' + key)
  const previous = await files.fingerprint(path)
  const body: ArchiveBody = { path, stage, sha256: hash(captured), previous: previous?.sha256 ?? null }
  await files.replace(descriptor, encodeJson(body))
  return body
}
async function readOutputs(files: PhysicalLocalFiles, snapshot: FilesSnapshot, pending: PendingRecorder): Promise<SkillProposal[]> {
  const outputs: SkillProposal[] = []
  for (const output of pending.outputs) {
    const saved = await readJson<SkillAttempt>(files, snapshot, inputPath(pending, output.path))
    if (!saved || saved.proposal.path !== output.path) throw new Error('Accepted Recorder output is missing: ' + output.path)
    outputs.push(saved.proposal)
  }
  return outputs
}
async function prepareArchive(files: PhysicalLocalFiles, snapshot: FilesSnapshot, pending: PendingRecorder, signal?: AbortSignal): Promise<RecorderPackage> {
  const task = pending.task, family = await taskFamily(files, snapshot, task.taskId)
  const selectedOutputs = selectRecorderOutputReferences(family.length ? family : [task], await readOutputs(files, snapshot, pending))
  const outputs = selectedOutputs.outputs.filter(output => !isSkillFile(output.path))
  const captured = new Map<string, ArchiveBody>(), capturedSources = new Map<string, { path: string; bytes: number; sha256: string }>(), sourceRoots = family.flatMap(taskWorkingRoots), sources = new Set(family.map(member => member.sourcePath))
  const originalSource = (path: string): boolean => sources.has(path) || sourceRoots.some(root => path.startsWith(root + '/'))
  const originalStage = (source: string) => stagePath(pending, 'originals', source)
  const originals: RecorderRetentionOriginalSink = {
    info: async path => originalSource(path) ? await files.fileInfo(originalStage(path)) ?? files.entryInfo(path) : files.entryInfo(path),
    taskIdentity: async path => {
      // Task ID is one fixed ASCII header, optionally preceded by a UTF-8 BOM.
      // A partial later codepoint is irrelevant to that header, not a file cap.
      const prefix = await files.readPrefix(originalStage(path), 64) ?? await files.readPrefix(path, 64)
      return prefix === undefined ? undefined : taskIdentity(new TextDecoder('utf-8').decode(prefix))
    },
    retain: async (source, archiveRoot) => {
      const already = capturedSources.get(source)
      if (already) return already
      const stage = originalStage(source), descriptor = stage + '.json'
      const prior = await readJson<ArchiveBody>(files, snapshot, descriptor)
      if (prior && !await files.fileInfo(stage)) throw new Error('An accepted Recorder original stage is missing: ' + stage)
      const copied = await files.stageCopy(source, stage, signal)
      if (!copied) return undefined
      const path = archiveRoot + '/retained/' + hash(source) + '/' + copied.sha256 + '/' + source.split('/').at(-1)!
      let body: ArchiveBody
      if (prior) {
        if (prior.path !== path || prior.stage !== stage || prior.sha256 !== copied.sha256) throw new Error('Accepted Recorder source stage differs: ' + source)
        body = prior
      } else {
        const previous = await files.fingerprint(path, signal)
        if (previous && previous.sha256 !== copied.sha256) throw new Error('Archived retained reference already differs: ' + path)
        body = { path, stage, sha256: copied.sha256, previous: previous?.sha256 ?? null }
        await files.replace(descriptor, encodeJson(body))
      }
      captured.set(path, body)
      const result = { path, bytes: copied.bytes, sha256: copied.sha256 }; capturedSources.set(source, result)
      return result
    },
    fingerprint: async path => captured.get(path)?.sha256 ?? (await files.fingerprint(path, signal))?.sha256,
  }
  const retainedPaths = await resolveChildResultReferences(files, snapshot, task, [...pending.retainedPaths, ...selectedOutputs.retainedPaths], true)
  const manifest: RetentionManifest = { outputs: outputs.map(output => output.path), retainedPaths,
    recorderCommand: pending.commandId, recorderRequest: pending.request, ...(task.lifecycleId ? { lifecycleId: task.lifecycleId } : {}),
  }
  const plan = await prepareRecorderRetention(files, snapshot, task, manifest, outputs.map(output => ({ path: output.path, content: output.text })), originals)
  if (plan.ancestorChanges.length) throw new Error('A total Recorder cannot have ancestor publications.')
  const archive: RecorderPackage = { records: [], originals: [...captured.values()].filter(body => Object.values(plan.retention.relocatedReferences ?? {}).includes(body.path)), identities: [], retention: plan.retention,
    ...(plan.task.resultPaths ? { resultPaths: plan.task.resultPaths } : {}) }
  for (const change of plan.changes) {
    if (change.path === paths.task(task.taskId)) continue
    if (change.content === null) throw new Error('Recorder archive publication cannot delete a file.')
    const entry = await stageBody(files, snapshot, pending, 'records', change.path, change.path, change.bytes ?? Buffer.from(change.content!, 'utf8'))
    if (family.some(member => change.path === taskHistoryPath(member.taskId))) archive.identities.push(entry)
    else if (!family.some(member => taskArchiveOwnsPath(member, change.path))) throw new Error('Recorder package escapes its actual family archive.')
    else archive.records.push(entry)
  }
  return archive
}
async function publishArchiveBody(files: PhysicalLocalFiles, snapshot: FilesSnapshot, pending: PendingRecorder,
  progress: RecorderProgress, body: ArchiveBody, beforeAttempt: () => void | Promise<void>): Promise<void> {
  const saveProgress = () => files.replace(progressPath(pending), encodeJson(progress))
  if (progress.attempting) {
    // Only this ambiguously interrupted accepted rename is compared. Already
    // confirmed outputs and ordinary reads are never hash/version gated.
    const currentHash = (await files.fingerprint(body.path))?.sha256 ?? null
    if (currentHash === body.sha256) {
      await files.delete(body.stage)
      progress.next++; delete progress.attempting; await saveProgress(); return
    }
    if (currentHash !== body.previous) throw new Error('Interrupted Recorder publication meets a changed archive file; prepared original remains at ' + body.stage + ': ' + body.path)
  } else { progress.attempting = true; await saveProgress() }
  await beforeAttempt()
  if (!await files.rename(body.stage, body.path))
    throw new Error('Recorder prepared original is missing and its publication is unconfirmed: ' + body.stage)
  progress.next++; delete progress.attempting
  await saveProgress()
}

interface SkillWork extends SkillAttempt {
  index?: { done?: true; issues?: string[] }
  pendingIndexIssue?: string
}
interface SkillAttemptRecord {
  commandId: string
  path: string
  result?: NonNullable<SkillAttempt['result']>
}
interface SkillSettlementContext { retentionPath: string; commandId: string }
const skillRequest = (skill: SkillAttempt): string => hash(JSON.stringify({ proposal: skill.proposal, base: skill.base }))
const skillFailure = (error: unknown): NonNullable<SkillAttempt['result']> => {
  const issue = error instanceof SkillMergeRequired ? error.issues[0] : undefined
  return { published: false, reason: issue?.reason ?? 'Skill publication was not confirmed: ' + message(error),
    ...(issue ? { detail: issue } : { uncertain: true }) }
}
/** Before archive publication starts, a new explicit call can revise its
 * authored archive and continue individual skill files. Per-file accepted
 * operations keep their original input/result locations across these calls. */
async function acceptContinuation(files: PhysicalLocalFiles, snapshot: FilesSnapshot, pending: PendingRecorder,
  input: PhysicalRecorderInput, request: string): Promise<PendingRecorder> {
  if (pending.commandId === input.commandId && pending.request !== request)
    throw new Error('The same Recorder command cannot change its accepted input.')
  if (await files.fileInfo(packagePath(pending))) {
    if (pending.request !== request)
      throw new Error('The original archive publication already started. Resume that exact operation before starting another archive input.')
    return pending
  }
  const outputs = new Map<string, { path: string; commandId: string }>()
  // Omitted entries do not discard previously accepted outputs or skills.
  for (const row of pending.outputs)
    outputs.set(row.path, { path: row.path, commandId: outputCommand(pending, row.path) })
  const captures: Array<{ path: string; value: SkillAttempt }> = []
  for (const proposal of input.outputs) {
    const previous = pending.outputs.find(row => row.path === proposal.path)
    const saved = previous ? await readJson<SkillAttempt>(files, snapshot, inputPath(pending, proposal.path)) : undefined
    if (previous && (!saved || saved.proposal.path !== proposal.path)) throw new Error('Accepted Recorder input is missing: ' + proposal.path)
    const next: SkillAttempt = { proposal, base: input.bases.get(proposal.path), commandId: input.commandId }
    if (saved && skillRequest(saved) === skillRequest(next)) {
      outputs.set(proposal.path, { path: proposal.path, commandId: outputCommand(pending, proposal.path) }); continue
    }
    if (saved && outputCommand(pending, proposal.path) === input.commandId)
      throw new Error('The same file operation cannot replace its accepted proposal or read base.')
    if (saved && isSkillFile(proposal.path)) {
      const attempted = await readJson<SkillAttemptRecord>(files, snapshot, skillPath(pending, proposal.path))
      if (!attempted || attempted.path !== proposal.path || attempted.commandId !== outputCommand(pending, proposal.path)
        || !attempted.result || (attempted.result.published === false && attempted.result.uncertain)) {
        // Keep the original UNKNOWN attempt. Other explicitly supplied files
        // remain independent and can progress; this one is reported unfinished.
        continue
      }
    }
    outputs.set(proposal.path, { path: proposal.path, commandId: input.commandId })
    captures.push({ path: stageRoot({ ...pending, commandId: input.commandId }) + '/inputs/' + hash(proposal.path) + '.json', value: next })
  }
  const next: PendingRecorder = { ...pending, commandId: input.commandId, request,
    outputs: [...outputs.values()], retainedPaths: input.retainedPaths }
  // Publish only changed authored inputs before the one existing pending-row
  // replacement. A stop before that pointer leaves the previous accepted row.
  for (const capture of captures) {
    if (await files.createIfAbsent(capture.path, encodeJson(capture.value))) continue
    const captured = await readJson<SkillAttempt>(files, snapshot, capture.path)
    if (!captured || skillRequest(captured) !== skillRequest(capture.value)) throw new Error('This explicit call already captured different input.')
  }
  await persist(files, next)
  return next
}
async function settleSkillIndex(files: PhysicalLocalFiles, skill: SkillWork, context: SkillSettlementContext): Promise<void> {
  if (!skill.pendingIndexIssue || !skill.index?.done) return
  await files.update(context.retentionPath, bytes => {
    if (bytes === undefined) return { value: undefined }
    const current = JSON.parse(decode(bytes)) as RetentionManifest
    if (current.recorderCommand !== context.commandId || !current.skillPublication?.issues.includes(skill.pendingIndexIssue!)) return { value: undefined }
    current.skillPublication.issues = current.skillPublication.issues.flatMap(issue => issue === skill.pendingIndexIssue ? skill.index!.issues ?? [] : [issue])
    return { value: undefined, content: encodeJson(current) }
  })
}
interface RecorderSkillScope {
  works: SkillWork[]
  complete(): Promise<void>
  finish(context?: SkillSettlementContext): void
}
async function startSkillAttempts(files: PhysicalLocalFiles, snapshot: FilesSnapshot, pending: PendingRecorder,
  mayStart: boolean, signal?: AbortSignal, skillsChanged?: () => void): Promise<RecorderSkillScope> {
  const works: SkillWork[] = [], running: Promise<void>[] = []
  let finish!: (context: SkillSettlementContext | undefined) => void
  const archiveFinished = new Promise<SkillSettlementContext | undefined>(resolve => { finish = resolve })
  const startIndex = (work: SkillWork): void => {
    work.index = {}
    void (async () => {
      try {
        const { refreshPhysicalFrameworkSkillIndex } = await import('./skills.js')
        // The definition already succeeded. Native PTC ends its tool signal at
        // normal run_code settlement; that cannot cancel this derived update.
        const issues = await refreshPhysicalFrameworkSkillIndex(files, [work.proposal.path])
        work.index = { done: true, issues }
        // Refresh only after the current derived catalog has actually published.
        // This independent continuation never holds the Recorder/Cleaner handoff.
        try { skillsChanged?.() }
        catch (error) { work.index.issues!.push('Skill cache refresh failed after catalog publication: ' + message(error)) }
      } catch (error) { work.index = { done: true, issues: ['Skill catalog update for ' + work.proposal.path + ' was not confirmed: ' + message(error)] } }
      const context = await archiveFinished
      if (context) await settleSkillIndex(files, work, context)
    })().catch(() => {}) // A derived catalog issue never changes definition success.
  }
  try {
    for (const output of pending.outputs.filter(output => isSkillFile(output.path))) {
      const saved = await readJson<SkillAttempt>(files, snapshot, inputPath(pending, output.path))
      if (!saved || saved.proposal.path !== output.path) throw new Error('Accepted skill proposal is missing.')
      const work: SkillWork = { ...saved }; works.push(work)
      const commandId = outputCommand(pending, output.path)
      const attempted = await readJson<SkillAttemptRecord>(files, snapshot, skillPath(pending, output.path))
      const exactAttempt = attempted?.path === output.path && attempted.commandId === commandId
      if (exactAttempt && attempted.result && (attempted.result.published || !attempted.result.uncertain)) {
        work.result = attempted.result
        // A process can stop after this durable success but before its derived
        // catalog update. Continue only that exact published path, not its body.
        if (work.result.published) startIndex(work)
        continue
      }
      if ((attempted && !exactAttempt) || !mayStart) {
        work.result = { published: false, reason: 'The original accepted skill attempt cannot yet be matched to this exact continuation.', uncertain: true }; continue
      }
      // An exact UNKNOWN continues the SAME file operation with its frozen
      // proposal/base and command. The existing file queue re-evaluates current
      // text: already-included edits are a no-op; real overlaps are rejected.
      // This is not a new proposal, an external-side-effect retry or a new ID.
      const record: SkillAttemptRecord = { commandId, path: output.path }
      // The original command and exact proposal/base stay fixed through this
      // file operation and any interrupted continuation.
      await files.replace(skillPath(pending, output.path), encodeJson(record))
      const action = (async () => {
        try { await publishPhysicalSkillProposal(files, work.proposal, work.base, signal); work.result = { published: true } }
        catch (error) { work.result = skillFailure(error) }
        await files.replace(skillPath(pending, output.path), encodeJson({ ...record, result: work.result }))
        if (work.result.published) startIndex(work)
      })()
      running.push(action)
      // Register rejection immediately while the other independent files start.
      void action.catch(() => {})
    }
  } catch (error) { finish(undefined); await Promise.allSettled(running); throw error }
  return { works, async complete() { await Promise.all(running) }, finish(context) { finish(context) } }
}
async function finishArchivePlan(files: PhysicalLocalFiles, snapshot: FilesSnapshot, pending: PendingRecorder,
  archive: RecorderPackage, scope: RecorderSkillScope, request: string): Promise<void> {
  const savedCatalog = await files.readBytes(snapshot, stagePath(pending, 'catalog', 'retention'))
  if (savedCatalog !== undefined) {
    const retention = JSON.parse(decode(savedCatalog)) as RetentionManifest
    if (retention.recorderCommand !== pending.commandId || retention.recorderRequest !== request)
      throw new Error('Prepared Recorder catalog belongs to another accepted operation.')
    archive.skillProposals = []
    for (const row of retention.skillPublication?.unmerged ?? []) {
      const bytes = await files.readBytes(snapshot, stagePath(pending, 'skill-proposals', row.path))
      if (bytes === undefined || row.proposalPreservedAt !== paths.archive(pending.task) + '/unmerged-skills/' + hash(row.path) + '.json')
        throw new Error('Prepared failed skill proposal is missing or outside this Task.')
      archive.skillProposals.push(await stageBody(files, snapshot, pending, 'skill-proposals', row.path, row.proposalPreservedAt, bytes))
    }
    archive.retention = retention
    archive.catalog = await stageBody(files, snapshot, pending, 'catalog', 'retention', paths.archive(pending.task) + '/retention.json', savedCatalog)
    archive.final = true
    await files.replace(packagePath(pending), encodeJson(archive)); return
  }
  const issues: string[] = []
  for (const work of scope.works) {
    if (work.result?.published !== true) throw new Error('Recorder skill responsibility is unfinished: ' + work.proposal.path)
    if (work.index && !work.index.done) {
      work.pendingIndexIssue = 'Skill catalog update for ' + work.proposal.path + ' was unfinished at the archive handoff.'
      issues.push(work.pendingIndexIssue)
    } else if (work.index?.done) issues.push(...work.index.issues ?? [])
  }
  if (issues.length) archive.retention.skillPublication = { unmerged: [], issues }
  archive.retention.recorderRequest = request
  archive.catalog = await stageBody(files, snapshot, pending, 'catalog', 'retention', paths.archive(pending.task) + '/retention.json', Buffer.from(encodeJson(archive.retention), 'utf8'))
  archive.final = true
  await files.replace(packagePath(pending), encodeJson(archive))
}

export async function publishPhysicalRecorder(files: PhysicalLocalFiles, input: PhysicalRecorderInput,
  beforeAttempt: () => void | Promise<void>, beforeAccept: (snapshot: FilesSnapshot) => Promise<void>, skillsChanged?: () => void): Promise<PhysicalRecorderResult | PhysicalRecorderIncomplete> {
  return ownHandoff(files, input.taskId, () => withSnapshot(files, async snapshot => {
    await beforeAttempt()
    const current = await readTaskReferenceIdentity(files, snapshot, input.taskId)
    sameTask(current as TaskMetadata | undefined, input)
    const selected = current as TaskMetadata, request = requestKey(input)
    let pending = await readJson<PendingRecorder>(files, snapshot, physicalRecorderPendingPath(input.taskId))
    const retained = await readJson<RetentionManifest>(files, snapshot, paths.archive(selected) + '/retention.json')
    if (retained?.recorderCommand && taskLifecycle(retained) === taskLifecycle(input)) {
      if (retained.recorderCommand !== input.commandId && retained.recorderRequest !== request)
        throw new Error('This total Task archive has already accepted another Recorder save; do not start a second Cleaner handoff.')
      if (await handoffObserved(files, snapshot, selected)) return resultOf(retained)
      if (!pending) throw new Error('Recorder archive is saved, but its Cleaner handoff cannot yet be confirmed. Do not recreate the signal; retain this original operation identity.')
    }
    const linked = await prepareRecorderOutputReferences(files, snapshot, selected, input.outputs)
    input = { ...input, outputs: linked.outputs, retainedPaths: [...new Set([...input.retainedPaths, ...linked.retainedPaths])] }
    if (pending) {
      if (pending.version !== 2 || pending.kind !== 'recorder-publication') throw new Error('Invalid pending Recorder publication.')
      sameTask(pending.task, input)
      // Resume the original accepted-before-input-copy boundary exactly as in
      // the initial physical handoff; createIfAbsent never replaces a capture.
      if (pending.commandId === input.commandId && pending.request === request)
        for (const proposal of input.outputs) if (pending.outputs.some(row => row.path === proposal.path) && outputCommand(pending, proposal.path) === input.commandId)
          await files.createIfAbsent(inputPath(pending, proposal.path), encodeJson({ proposal, base: input.bases.get(proposal.path), commandId: input.commandId } satisfies SkillAttempt))
      if (pending.commandId !== input.commandId) {
        const family = await taskFamily(files, snapshot, input.taskId)
        for (const output of input.outputs) {
          filePath(output.path)
          if (isSkillFile(output.path)) continue
          if (!family.some(member => taskArchiveOwnsPath(member, output.path))) throw new Error('Recorder outputs belong in this actual Task tree archives or skills.')
          if (family.some(member => output.path.startsWith(paths.archive(member) + '/lifecycles/') || ['retention.json', 'state.json'].some(name => output.path === paths.archive(member) + '/' + name || output.path.startsWith(paths.archive(member) + '/' + name + '/'))))
            throw new Error('Lifecycle history, retention.json and state.json are not authored output paths.')
        }
        await beforeAccept(snapshot)
      }
      pending = await acceptContinuation(files, snapshot, pending, input, request)
    } else {
      const runtime = await readJson<TaskMetadata>(files, snapshot, paths.task(input.taskId))
      sameTask(runtime, input)
      const family = await taskFamily(files, snapshot, input.taskId)
      if (!input.outputs.some(output => output.path === paths.archive(selected) + '/records.md')) throw new Error('Save the AI-authored Task records at ' + paths.archive(selected) + '/records.md before requesting Cleaner.')
      for (const output of input.outputs) {
        filePath(output.path)
        if (isSkillFile(output.path)) continue
        if (!family.some(member => taskArchiveOwnsPath(member, output.path))) throw new Error('Recorder outputs belong in this actual Task tree archives or skills.')
        if (family.some(member => output.path.startsWith(paths.archive(member) + '/lifecycles/') || ['retention.json', 'state.json'].some(name => output.path === paths.archive(member) + '/' + name || output.path.startsWith(paths.archive(member) + '/' + name + '/'))))
          throw new Error('Lifecycle history, retention.json and state.json are not authored output paths.')
      }
      await beforeAccept(snapshot)
      pending = { version: 2, kind: 'recorder-publication', commandId: input.commandId, request, task: runtime!,
        outputs: input.outputs.map(({ path }) => ({ path, commandId: input.commandId })), retainedPaths: input.retainedPaths }
      await persist(files, pending)
    }
    // Each authored output/baseline is accepted once, separately from the small
    // command identity. Raw retained originals never enter these JSON records.
    for (const proposal of input.outputs) if (outputCommand(pending, proposal.path) === input.commandId)
      await files.createIfAbsent(inputPath(pending, proposal.path),
        encodeJson({ proposal, base: input.bases.get(proposal.path), commandId: input.commandId } satisfies SkillAttempt))
    let archive = await readJson<RecorderPackage>(files, snapshot, packagePath(pending))
    const skillScope = await startSkillAttempts(files, snapshot, pending, !archive?.final, input.signal, skillsChanged)
    let settlement: SkillSettlementContext | undefined
    try {
      await skillScope.complete()
      if (!archive?.final) {
        const requested = new Map(input.outputs.filter(output => isSkillFile(output.path)).map(proposal => [proposal.path,
          { proposal, base: input.bases.get(proposal.path) } satisfies SkillAttempt]))
        const unaccepted = new Set(skillScope.works.filter(work => {
          const next = requested.get(work.proposal.path)
          return next && skillRequest(next) !== skillRequest(work)
        }).map(work => work.proposal.path))
        const unfinished = skillScope.works.filter(work => work.result?.published !== true || unaccepted.has(work.proposal.path))
        if (unfinished.length) return { saved: false, recorderCommand: pending.commandId,
          pendingSkills: unfinished.map(work => ({ path: work.proposal.path, commandId: outputCommand(pending, work.proposal.path),
            outcome: !unaccepted.has(work.proposal.path) && work.result?.published === false && !work.result.uncertain ? 'merge-required' as const : 'unknown' as const,
            reason: unaccepted.has(work.proposal.path) ? 'This call did not replace the original UNKNOWN input. Its changed proposal is not complete. Inspect the original result and continue this explicit requested input; do not treat confirmation of the old contribution as completion of the new proposal.'
              : work.result?.published === false ? work.result.reason : 'No confirmed result is available.',
            ...(work.result?.published === false && work.result.detail ? { detail: work.result.detail } : {}) })),
          continuation: 'This Recorder is unfinished and Cleaner was not notified. Read and resolve the identified definitive conflicts with a new explicit call. The archive and other files can be updated before archive publication starts. Continue an UNKNOWN file operation only with its original identity and accepted proposal/read base. The existing single-file merge decides its actual current outcome; do not replace it with a new proposal while it remains unresolved. Use the existing dss_help entry when its real failure requires repair.' }
      }
      if (!archive) { archive = await prepareArchive(files, snapshot, pending, input.signal); await files.replace(packagePath(pending), encodeJson(archive)) }
      const progress = await readJson<RecorderProgress>(files, snapshot, progressPath(pending)) ?? { next: 0 }
      const bodies = [...archive.originals, ...archive.records, ...archive.identities]
      while (progress.next < bodies.length) await publishArchiveBody(files, snapshot, pending, progress, bodies[progress.next]!, beforeAttempt)
      if (!progress.resultsUpdated) {
        await files.update(paths.task(input.taskId), bytes => {
          const task = bytes === undefined ? undefined : JSON.parse(decode(bytes)) as TaskMetadata
          sameTask(task, input)
          return { value: undefined, ...(JSON.stringify(task!.resultPaths) !== JSON.stringify(archive!.resultPaths)
            ? { content: encodeJson({ ...task, ...(archive!.resultPaths ? { resultPaths: archive!.resultPaths } : {}) }) } : {}) }
        })
        progress.resultsUpdated = true; await files.replace(progressPath(pending), encodeJson(progress))
      }
      if (!archive.final) await finishArchivePlan(files, snapshot, pending, archive, skillScope, request)
      const finalBodies = [...bodies, ...archive.skillProposals ?? [], archive.catalog!]
      while (progress.next < finalBodies.length) await publishArchiveBody(files, snapshot, pending, progress, finalBodies[progress.next]!, beforeAttempt)
      settlement = { retentionPath: archive.catalog!.path, commandId: pending.commandId }
      const stage = cleanerStage(pending)
      if (!pending.cleanerPrepared) {
        await beforeAttempt(); await files.createIfAbsent(stage, '')
        pending.cleanerPrepared = true; await persist(files, pending)
      }
      await beforeAttempt()
      // Last runtime write. Cleaner may immediately remove this package and all
      // known working files. Never persist another receipt or success Note after it.
      const moved = await files.rename(stage, cleanerPath(pending.task))
      if (!moved && !await handoffObserved(files, snapshot, pending.task))
        throw new Error('Prepared Recorder Cleaner source is missing and its handoff is unconfirmed. Do not re-emit; retain the original accepted operation.')
      return resultOf(archive.retention)
    } finally { skillScope.finish(settlement) }
  }))
}
