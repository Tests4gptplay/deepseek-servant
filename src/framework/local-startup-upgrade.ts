import { mapReplacedLocalInstance, type CurrentLocalUpgradeInstance } from './local-upgrade-instance.js'
import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { dirname, join, parse, sep } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { localRecordPath } from './local-record-files.js'
import { withLegacySqliteSnapshot, type LegacySqliteFile, type LegacySqliteIssue } from './legacy-sqlite-reader.js'
import { inspectLocalUpgradeMapping, localUpgradeResultKey } from './local-upgrade-mapping.js'
import { publishPreparedUpgradeFile } from './local-upgrade-publish.js'

const sourceName = 'dss-files.sqlite'
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
type Identity = { dev: string; ino: string; birthtimeNs: string }
const identity = (stat: BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) })
const same = (a: Identity | undefined, b: Identity | undefined): boolean => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs

export interface LocalUpgradeIssue {
  code: 'source-row' | 'unsafe-target' | 'target-conflict' | 'source-changed' | 'source-missing'
  path?: string
  message: string
  sourceIssue?: LegacySqliteIssue
  /** Only the actual ready-stage-absent branch can present a keep-current choice. */
  choice?: 'ready-stage-absent'
}
export interface UpgradeFilePublication {
  path: string
  sha256: string
  bytes: number
  /** The complete staged inode is recorded before atomic no-replace publication. */
  stagePath?: string
  ready?: boolean
  owned?: Identity
  /** Explicit user choice, not evidence that the original bytes were exported. */
  keptCurrent?: { target: 'absent' | 'different-inode'; selectedAt: string }
  status: 'prepared' | 'owned' | 'published' | 'already-present' | 'kept-current-unexported'
}
export interface LocalUpgradePublication {
  operationId: string
  files: UpgradeFilePublication[]
  retainedStages?: Array<RetainedLocalUpgradeStage>
}
export interface RetainedLocalUpgradeStage {
  path: string
  reason: string
  /** A disposition of this exact leftover path, not proof of its ownership or continued existence. */
  keptByUser?: { selectedAt: string }
}
interface UpgradeOperation extends LocalUpgradePublication {
  kind: 'dss-local-sqlite-to-physical'
  operationId: string
  directory: string
  source: { dev: string; ino: string }
  status: 'publishing' | 'complete'
  files: UpgradeFilePublication[]
  issues: LocalUpgradeIssue[]
  retainedStages?: Array<RetainedLocalUpgradeStage>
  /** Evidence of this one-time source extraction, never an ordinary file version. */
  sourceDigest?: string
}
export interface LocalStartupUpgradeReport {
  status: 'not-needed' | 'complete' | 'incomplete'
  directory: string
  sourcePath: string
  operationId?: string
  published: number
  alreadyPresent: number
  keptCurrent: ReadonlyArray<{ path: string; target: 'absent' | 'different-inode' }>
  issues: readonly LocalUpgradeIssue[]
  retainedStages: ReadonlyArray<RetainedLocalUpgradeStage>
}
type UpgradeStep = 'prepared' | 'created' | 'owned' | 'written' | 'ready' | 'moved' | 'published'
export interface LocalStartupUpgradeOptions {
  requireExisting?: boolean
  /** Native startup tool defers objects that would admit work until their known owner restores them. */
  deferActivation?: boolean
  currentInstance?: CurrentLocalUpgradeInstance
  /** Exact original empty signal: a confirmed publication may already be consumed. */
  publishedSignal?: boolean
  signal?: AbortSignal
  /** Startup progress only. Throwing interrupts this same resumable operation. */
  onProgress?: (progress: { operationId: string; path: string; step: UpgradeStep }) => void | Promise<void>
}
export const localStartupUpgradeKey = (directory: string): string => 'framework-physical-upgrade/' + hash(directory)

/** Inspect only the exact addressed chain. Do not follow a preexisting link or
 * treat a parent file as permission to replace it. See LocalRecordFiles for the
 * same user-controlled-directory boundary of portable Node pathname APIs. */
async function ordinaryDirectory(directory: string, create: boolean): Promise<boolean> {
  let current = parse(directory).root
  for (const part of directory.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let stat
    try { stat = await fs.lstat(current) }
    catch (error) {
      if (!missing(error)) throw error
      if (!create) return false
      try { await fs.mkdir(current) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
      stat = await fs.lstat(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Not an ordinary destination directory: ' + current)
  }
  return true
}
async function inspectTarget(target: string): Promise<Identity | undefined> {
  let stat
  try { stat = await fs.lstat(target, { bigint: true }) } catch (error) { if (missing(error)) return undefined; throw error }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Destination is not an ordinary file: ' + target)
  return identity(stat)
}
async function openTarget(target: string, create: boolean): Promise<FileHandle> {
  return fs.open(target, (create ? constants.O_CREAT | constants.O_EXCL : 0) | constants.O_RDWR
    | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600)
}
async function openedIdentity(target: string, file: FileHandle): Promise<Identity> {
  const stat = await file.stat({ bigint: true }), current = await inspectTarget(target)
  if (!stat.isFile() || !current || !same(identity(stat), current)) throw new Error('Destination changed while opening: ' + target)
  return current
}
function validateOperation(value: UpgradeOperation, directory: string): void {
  if (!value || value.kind !== 'dss-local-sqlite-to-physical' || value.directory !== directory
    || typeof value.operationId !== 'string' || !value.operationId || !value.source
    || typeof value.source.dev !== 'string' || typeof value.source.ino !== 'string'
    || !['publishing', 'complete'].includes(value.status) || !Array.isArray(value.files) || !Array.isArray(value.issues)
    || value.files.some(file => !file || typeof file.path !== 'string' || typeof file.sha256 !== 'string'
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !['prepared', 'owned', 'published', 'already-present', 'kept-current-unexported'].includes(file.status)
      || (file.status === 'owned' && !file.owned)
      || (file.status === 'kept-current-unexported' && (!file.ready || !file.owned || !file.stagePath
        || !file.keptCurrent || !['absent', 'different-inode'].includes(file.keptCurrent.target)
        || typeof file.keptCurrent.selectedAt !== 'string'))
      || (file.status !== 'kept-current-unexported' && file.keptCurrent !== undefined)
      || (file.owned && Object.values(file.owned).some(part => typeof part !== 'string')))
    || new Set(value.files.map(file => file.path)).size !== value.files.length) {
    throw new Error('The existing Local startup operation cannot be interpreted. Its records were retained without resetting ownership.')
  }
  if (value.retainedStages !== undefined && (!Array.isArray(value.retainedStages)
    || value.retainedStages.some(stage => !stage || typeof stage.path !== 'string' || typeof stage.reason !== 'string'
      || (stage.keptByUser !== undefined && (!stage.keptByUser || typeof stage.keptByUser.selectedAt !== 'string' || !stage.keptByUser.selectedAt)))))
    throw new Error('The retained Local staging decision cannot be interpreted; no cleanup responsibility was dropped.')
}
const report = (directory: string, operation?: UpgradeOperation): LocalStartupUpgradeReport => ({
  status: operation ? operation.status === 'complete' ? 'complete' : 'incomplete' : 'not-needed',
  directory, sourcePath: join(directory, sourceName), ...(operation ? { operationId: operation.operationId } : {}),
  published: operation?.files.filter(file => file.status === 'published').length ?? 0,
  alreadyPresent: operation?.files.filter(file => file.status === 'already-present').length ?? 0,
  keptCurrent: operation?.files.filter(file => file.status === 'kept-current-unexported').map(file => ({ path: file.path, target: file.keptCurrent!.target })) ?? [],
  issues: operation?.issues.map(issue => structuredClone(issue)) ?? [],
  retainedStages: operation?.retainedStages?.map(stage => ({ ...stage })) ?? [],
})

export async function publishLocalUpgradeBytes(directory: string, source: Pick<LegacySqliteFile, 'path' | 'bytes'>, operation: LocalUpgradePublication,
  save: () => Promise<void>, options: LocalStartupUpgradeOptions): Promise<LocalUpgradeIssue | undefined> {
  const issue = (code: LocalUpgradeIssue['code'], message: string, choice?: LocalUpgradeIssue['choice']): LocalUpgradeIssue =>
    ({ code, path: source.path, message, ...(choice ? { choice } : {}) })
  let target: string
  try {
    localRecordPath(source.path)
    // Source databases cannot publish over themselves or their SQLite sidecars.
    if ([sourceName, sourceName + '-wal', sourceName + '-shm'].includes(source.path.split('/')[0]!)) throw new Error('The logical path addresses retained SQL recovery material.')
    target = join(directory, ...source.path.split('/'))
  } catch (error) { return issue('unsafe-target', error instanceof Error ? error.message : String(error)) }
  let publication = operation.files.find(file => file.path === source.path)
  const sourceHash = hash(source.bytes)
  if (publication && (publication.sha256 !== sourceHash || publication.bytes !== source.bytes.byteLength)) {
    return issue('source-changed', 'The source row changed after this operation prepared its original bytes. Neither version was overwritten or silently selected.')
  }
  // A completed export is user-owned, including subsequent edits or deletion.
  if (publication?.status === 'published' || publication?.status === 'already-present' || publication?.status === 'kept-current-unexported') return
  // A missing ready stage alone is not proof of publication: the user may
  // have removed its directory before the no-replace move. Only the exact
  // recorded inode at the target proves that the move occurred.
  if (publication?.ready && publication.owned && publication.stagePath) {
    let stage: Identity | undefined, current: Identity | undefined
    try {
      stage = await inspectTarget(join(directory, ...localRecordPath(publication.stagePath).split('/')))
      if (!stage) current = await inspectTarget(target)
    } catch (error) { return issue('unsafe-target', error instanceof Error ? error.message : String(error)) }
    if (!stage) {
      if (!same(publication.owned, current)) return issue('target-conflict', current
        ? 'The ready stage is absent, but the target has a different identity. Whether the original was published is unconfirmed; both current target and SQL original were retained.'
        : 'The ready stage and target are both absent. Whether publication happened before user deletion is unconfirmed; SQL original and pending responsibility were retained without recreating the target.', 'ready-stage-absent')
      publication.status = 'published'
      await save()
      return
    }
  }
  try { await ordinaryDirectory(dirname(target), true) }
  catch (error) { return issue('unsafe-target', error instanceof Error ? error.message : String(error)) }
  const progress = async (step: UpgradeStep): Promise<void> => {
    options.signal?.throwIfAborted()
    await options.onProgress?.({ operationId: operation.operationId, path: source.path, step })
  }
  let current: Identity | undefined
  try { current = await inspectTarget(target) }
  catch (error) { return issue('unsafe-target', error instanceof Error ? error.message : String(error)) }
  if (!publication) {
    publication = { path: source.path, sha256: sourceHash, bytes: source.bytes.byteLength, status: 'prepared' }
    operation.files.push(publication)
    await save(); await progress('prepared')
  }
  // A previously completed atomic move may have lost only its final receipt.
  // An existing independent/custom target is never opened for writing.
  if (current) {
    const existing = await fs.readFile(target)
    if (!Buffer.from(existing).equals(Buffer.from(source.bytes))) return issue('target-conflict', 'The existing physical target differs from the original. Neither it nor the original was replaced.')
    publication.status = publication.ready && publication.owned && same(publication.owned, current) ? 'published' : 'already-present'
    if (publication.stagePath && publication.owned) {
      const residual = join(directory, ...localRecordPath(publication.stagePath).split('/'))
      const owned = await inspectTarget(residual)
      if (owned && same(publication.owned, owned)) {
        const body = await fs.readFile(residual)
        if (Buffer.from(source.bytes).equals(body) && same(publication.owned, await inspectTarget(residual))) {
          // An equivalent final target won the no-replace race. This exact,
          // complete staged file is still ours and is no longer needed.
          await fs.unlink(residual)
          delete publication.stagePath; delete publication.owned; delete publication.ready
        } else (operation.retainedStages ??= []).push({ path: publication.stagePath, reason: 'Residual staging bytes changed; retained instead of cleaning user-modified material.' })
      } else if (owned) (operation.retainedStages ??= []).push({ path: publication.stagePath, reason: 'Residual staging ownership changed; retained without deletion.' })
    }
    await save(); await progress('published'); return
  }
  const preserveStage = async (reason: string): Promise<void> => {
    if (publication!.stagePath) (operation.retainedStages ??= []).push({ path: publication!.stagePath, reason })
    delete publication!.stagePath; delete publication!.owned; delete publication!.ready
    publication!.status = 'prepared'
    await save()
  }
  let stage: string | undefined, staged: Identity | undefined
  if (publication.stagePath) {
    stage = join(directory, ...localRecordPath(publication.stagePath).split('/'))
    staged = await inspectTarget(stage)
    if (publication.ready && !staged) return issue('target-conflict', 'The prepared staged inode and final target are both absent. A prior publication followed by deletion cannot be replayed as a new file.')
    if (staged && (!publication.owned || !same(publication.owned, staged))) {
      await preserveStage('Staging ownership was not durably confirmed or its inode was replaced; bytes retained without blocking a new exclusive staging attempt.')
      stage = undefined; staged = undefined
    } else if (!staged) { await preserveStage('Unpublished staging path disappeared; no final target had been published.'); stage = undefined }
  }
  if (stage && staged) {
    const body = await fs.readFile(stage)
    if (body.length > source.bytes.byteLength || !Buffer.from(source.bytes).subarray(0, body.length).equals(body)) {
      await preserveStage('Staged content was changed. It is retained unchanged; the original is exported using a separate prepared file.')
      stage = undefined; staged = undefined
    }
  }
  if (!stage) {
    const parent = source.path.slice(0, source.path.lastIndexOf('/') + 1)
    publication.stagePath = parent + '.dss-upgrade-' + operation.operationId + '-' + randomUUID() + '.tmp'
    stage = join(directory, ...publication.stagePath.split('/'))
    await save()
  }
  let file: FileHandle | undefined
  try {
    if (staged) {
      file = await openTarget(stage, false)
      if (!same(publication.owned!, await openedIdentity(stage, file))) return issue('target-conflict', 'The prepared staging inode changed while opening; it was retained.')
    } else {
      try { file = await openTarget(stage, true) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { await preserveStage('The chosen staging path was occupied before exclusive creation; the existing file was preserved.'); return publishLocalUpgradeBytes(directory, source, operation, save, options) }
        throw error
      }
      await progress('created')
      publication.owned = await openedIdentity(stage, file); publication.status = 'owned'
      await save(); await progress('owned')
    }
    const previous = await file.readFile()
    if (previous.length > source.bytes.byteLength || !Buffer.from(source.bytes).subarray(0, previous.length).equals(previous)) return issue('target-conflict', 'Staging content changed while opening. Its bytes were retained without writing over them.')
    let offset = previous.length
    while (offset < source.bytes.byteLength) {
      options.signal?.throwIfAborted()
      if (!same(publication.owned!, await openedIdentity(stage, file))) return issue('target-conflict', 'The staged inode changed while writing; no final target was replaced.')
      const written = await file.write(source.bytes, offset, Math.min(64 * 1024, source.bytes.byteLength - offset), offset)
      if (!written.bytesWritten) throw new Error('The staging file accepted no bytes.')
      offset += written.bytesWritten; await progress('written')
    }
    await file.sync()
    if (!same(publication.owned!, await openedIdentity(stage, file)) || !Buffer.from(await fs.readFile(stage)).equals(Buffer.from(source.bytes))) return issue('target-conflict', 'The complete staging file changed before publication; all bytes were retained.')
    publication.ready = true; await save(); await progress('ready')
  } finally { await file?.close() }
  options.signal?.throwIfAborted()
  if (!same(publication.owned!, (await inspectTarget(stage))!)) return issue('target-conflict', 'The staged source was replaced before publication.')
  if (await publishPreparedUpgradeFile(stage, target) === 'exists') return issue('target-conflict', 'A target appeared before atomic publication. The target and prepared source were both retained without replacement.')
  publication.status = 'published'; await save()
  await progress('moved')
  if (options.publishedSignal) { await progress('published'); return }
  if (!same(publication.owned!, (await inspectTarget(target))!) || !Buffer.from(await fs.readFile(target)).equals(Buffer.from(source.bytes))) return issue('target-conflict', 'The newly published target changed before readback. No replacement or rollback was attempted.')
  publication.status = 'published'; await save(); await progress('published')
  return
}

// One already-owned startup operation may be awaited by foreground/background
// acquisition. Ordinary file reads and writes never join this map or its state.
const running = new WeakMap<StoragePort, Map<string, Promise<LocalStartupUpgradeReport>>>()

/** A user's exact, non-destructive choice after the one-time Agent reports a
 * real ready-stage conflict. Never infer a successful rename from absence. */
export async function keepCurrentLocalUpgradeTarget(directory: string, storage: StoragePort,
  expectedOperationId: string, path: string): Promise<LocalStartupUpgradeReport> {
  const root = await canonicalLocalLocation(directory, true)
  localRecordPath(path)
  // Service admits this only after its one-time owner has fully settled and
  // disposed the native tool. No second mechanical exporter is started here.
  const key = localStartupUpgradeKey(root), operation = await storage.get<UpgradeOperation>(key)
  if (!operation) {
    const completed = await storage.get<{ operationId: string; report: LocalStartupUpgradeReport }>(localUpgradeResultKey(root))
    if (completed?.operationId === expectedOperationId && completed.report.keptCurrent?.some(row => row.path === path)) return completed.report
    throw new Error('The selected original upgrade is no longer pending.')
  }
  validateOperation(operation, root)
  if (operation.operationId !== expectedOperationId) throw new Error('The selected Local upgrade changed; refresh its pending row.')
  const file = operation.files.find(item => item.path === path)
  if (!file) throw new Error('The selected original row has no matching publication responsibility.')
  const sql = join(root, sourceName), source = await fs.lstat(sql, { bigint: true })
  if (!source.isFile() || source.isSymbolicLink() || String(source.dev) !== operation.source.dev || String(source.ino) !== operation.source.ino)
    throw new Error('The original SQL source changed; no conflict choice was saved.')
  if (path.startsWith('state/') || /^tasks\/[^/]+\.json$/.test(path)
    || /^conversation-(?:index|context)\/local\/[^/]+\/index\.json$/.test(path)
    || /^skills\/(?:[^/]+\/)+(?:SKILL\.md|record\.json|legacy-git\.json)$/.test(path)
    || !path.includes('/') && path.endsWith('.md'))
    throw new Error('This original may admit work and cannot be skipped by a generic physical-file choice.')
  const original = await withLegacySqliteSnapshot(sql, async snapshot => {
    if (snapshot.identity.dev !== operation.source.dev || snapshot.identity.ino !== operation.source.ino)
      throw new Error('The original SQL source changed; no conflict choice was saved.')
    const entry = await snapshot.read(path)
    if (entry?.kind === 'issue') throw new Error(entry.issue.message)
    return entry
  })
  if (!original || original.bytes.byteLength !== file.bytes || hash(original.bytes) !== file.sha256)
    throw new Error('The original SQL row changed; no conflict choice was saved.')
  if (file.status === 'kept-current-unexported') return report(root, operation)
  if (operation.status !== 'publishing' || file.status !== 'owned' || !file.ready || !file.owned || !file.stagePath
    || !operation.issues.some(issue => issue.code === 'target-conflict' && issue.path === path && issue.choice === 'ready-stage-absent'))
    throw new Error('Only the original unresolved ready-stage target conflict can be kept as current.')
  const stage = join(root, ...localRecordPath(file.stagePath).split('/')), target = join(root, ...path.split('/'))
  const stagePresent = await ordinaryDirectory(dirname(stage), false) && await inspectTarget(stage)
  if (stagePresent) throw new Error('The original staged inode is still available; refresh and retry its normal publication.')
  const current = await ordinaryDirectory(dirname(target), false) ? await inspectTarget(target) : undefined
  if (same(file.owned, current)) throw new Error('The original staged inode is already at the target; refresh its normal completion.')
  file.status = 'kept-current-unexported'
  file.keptCurrent = { target: current ? 'different-inode' : 'absent', selectedAt: new Date().toISOString() }
  operation.issues = operation.issues.filter(issue => !(issue.path === path && issue.code === 'target-conflict'))
  await storage.set(key, structuredClone(operation))
  return report(root, operation)
}

/** Record only the user's decision not to clean this exact ambiguous stage.
 * It does not attest to a published source row, stage ownership, or whether
 * the path still exists. The ordinary finish assessment remains responsible
 * for every source row, Task, conversation, skill, and other retained stage. */
export async function keepRetainedLocalUpgradeStage(directory: string, storage: StoragePort,
  expectedOperationId: string, path: string): Promise<{ report: LocalStartupUpgradeReport; saved: boolean }> {
  const root = await canonicalLocalLocation(directory, true)
  localRecordPath(path)
  const key = localStartupUpgradeKey(root), operation = await storage.get<UpgradeOperation>(key)
  if (!operation) {
    const completed = await storage.get<{ operationId: string; report: LocalStartupUpgradeReport }>(localUpgradeResultKey(root))
    if (completed?.operationId === expectedOperationId && completed.report.retainedStages?.some(stage => stage.path === path && stage.keptByUser))
      return { report: completed.report, saved: true }
    throw new Error('The selected original upgrade is no longer pending.')
  }
  validateOperation(operation, root)
  if (operation.operationId !== expectedOperationId) throw new Error('The selected Local upgrade changed; refresh its pending row.')
  const stages = operation.retainedStages?.filter(stage => stage.path === path) ?? []
  if (stages.length !== 1) throw new Error('The selected retained stage is not a unique responsibility in this operation.')
  if (stages[0]!.keptByUser) return { report: report(root, operation), saved: true }
  // An exact user-initiated check, not a recurring stage scan. If the known
  // path has already gone, the existing finish assessment can clear its own
  // pending item; no keep decision about a missing file is needed.
  try { await fs.lstat(join(root, ...path.split('/'))) }
  catch (error) { if (missing(error)) return { report: report(root, operation), saved: false }; throw error }
  stages[0]!.keptByUser = { selectedAt: new Date().toISOString() }
  await storage.set(key, structuredClone(operation))
  return { report: report(root, operation), saved: true }
}

/** Mechanical execution tool for the one-time AI woken at DSS Host activation. This is
 * an exact one-time mechanical export, not an AI classifier or a fallback SQL
 * store. Unknown but safe logical paths keep their exact names and bytes. The
 * original SQL/WAL is retained; normal SQLite reader SHM bookkeeping is allowed.
 *
 * The old Host must already be stopped, as for any plugin replacement. Portable
 * file APIs cannot make a transaction with another legacy process still writing
 * SQL or a hostile external directory replacer. No cross-process lock is added.
 */
export async function materializeLegacyLocalFiles(directory: string, storage: StoragePort,
  options: LocalStartupUpgradeOptions = {}): Promise<LocalStartupUpgradeReport> {
  options.signal?.throwIfAborted()
  const root = await canonicalLocalLocation(directory, true)
  const pending = running.get(storage)?.get(root)
  if (pending) { const result = await pending; options.signal?.throwIfAborted(); return result }
  const operation = runUpgrade(root, storage, options)
  let roots = running.get(storage)
  if (!roots) running.set(storage, roots = new Map())
  roots.set(root, operation)
  try { return await operation }
  finally { if (roots.get(root) === operation) roots.delete(root) }
}
async function completedResult(directory: string, storage: StoragePort): Promise<LocalStartupUpgradeReport | undefined> {
  const value = await storage.get<{ kind: string; directory: string; report: LocalStartupUpgradeReport }>(localUpgradeResultKey(directory))
  if (!value) return undefined
  if (value.kind !== 'dss-local-upgrade-result' || value.directory !== directory || value.report?.status !== 'complete') throw new Error('Invalid one-time Local upgrade result; retained without replaying SQL.')
  return value.report
}
async function runUpgrade(directory: string, storage: StoragePort, options: LocalStartupUpgradeOptions): Promise<LocalStartupUpgradeReport> {
  const priorResult = await completedResult(directory, storage)
  if (priorResult) return priorResult
  if (options.requireExisting && !await ordinaryDirectory(directory, false)) throw new Error('The existing Local directory is unavailable. Startup did not create a replacement store.')
  const key = localStartupUpgradeKey(directory), prior = await storage.get<UpgradeOperation>(key)
  if (prior) {
    validateOperation(prior, directory)
    // Completed physical records are now user-owned. Do not reimport old SQL,
    // revive removed files, compare versions, or inspect every file on startup.
    if (prior.status === 'complete') return report(directory, prior)
  }
  let sourceExists = false
  try { sourceExists = !!await fs.lstat(join(directory, sourceName)) } catch (error) { if (!missing(error)) throw error }
  if (!sourceExists) {
    const sidecars = []
    for (const suffix of ['-wal', '-shm']) {
      try { await fs.lstat(join(directory, sourceName + suffix)); sidecars.push(sourceName + suffix) } catch (error) { if (!missing(error)) throw error }
    }
    if (prior || sidecars.length) return { ...report(directory, prior), status: 'incomplete', issues: [{ code: 'source-missing', message: 'The original database is absent while its startup operation or sidecars remain. No empty replacement was created.' }] }
    return report(directory)
  }
  const extracted = await withLegacySqliteSnapshot<{ result: LocalStartupUpgradeReport; prepared?: UpgradeOperation }>(join(directory, sourceName), async snapshot => {
    if (prior && (prior.source.dev !== snapshot.identity.dev || prior.source.ino !== snapshot.identity.ino)) return { result: {
      ...report(directory, prior), status: 'incomplete', issues: [{ code: 'source-changed', message: 'The source database file was replaced. Its existing operation was not reset or applied to the replacement.' }],
    } }
    const operation: UpgradeOperation = prior ?? { kind: 'dss-local-sqlite-to-physical', operationId: randomUUID(), directory,
      source: { ...snapshot.identity }, status: 'publishing', files: [], issues: [] }
    operation.issues = []
    const save = () => storage.set(key, structuredClone(operation))
    await save()
    const taskSources = new Set<string>()
    if (options.deferActivation) for await (const entry of snapshot.entries('tasks/')) {
      if (entry.kind !== 'file' || !/^tasks\/[^/]+\.json$/.test(entry.path)) continue
      try { const task = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)); if (typeof task.sourcePath === 'string') taskSources.add(task.sourcePath) } catch {}
    }
    const digest = createHash('sha256'), seen = new Set<string>()
    for await (const entry of snapshot.entries()) {
      options.signal?.throwIfAborted()
      if (entry.kind === 'issue') { operation.issues.push({ code: 'source-row', path: entry.issue.path, message: entry.issue.message, sourceIssue: entry.issue }); continue }
      if (seen.has(entry.path)) { operation.issues.push({ code: 'source-row', path: entry.path, message: 'Duplicate logical source path; no row was silently selected.' }); continue }
      seen.add(entry.path)
      digest.update(JSON.stringify([entry.path, entry.bytes.byteLength, hash(entry.bytes)]) + '\n')
      const mapping = await inspectLocalUpgradeMapping(storage, directory, entry)
      if (mapping === 'mapped') continue
      if (mapping !== 'source-changed' && options.deferActivation && /^skills\/(?:[^/]+\/)+(?:SKILL\.md|record\.json|legacy-git\.json)$/.test(entry.path)) {
        operation.issues.push({ code: 'source-row', path: entry.path, message: 'This original skill definition remains in SQL until publish_skill verifies and publishes its native definition and original controls. Generic export must not activate an obsolete definition.' }); continue
      }
      if (options.deferActivation && (entry.path.startsWith('state/') || /^tasks\/[^/]+\.json$/.test(entry.path)
        || /^conversation-(?:index|context)\/local\/[^/]+\/index\.json$/.test(entry.path) || taskSources.has(entry.path)
        || !entry.path.includes('/') && entry.path.endsWith('.md'))) {
        operation.issues.push({ code: 'source-row', path: entry.path, message: 'This original can admit work. It remains in SQL until its exact Task/conversation/source restoration publishes its real prerequisites and original signal in order.' }); continue
      }
      if (mapping === 'source-changed') { operation.issues.push({ code: 'source-changed', path: entry.path, message: 'This original changed after its recorded conversion. Its physical result was not overwritten.' }); continue }
      const instance = options.deferActivation ? await mapReplacedLocalInstance(storage, directory, entry, operation.operationId, options.currentInstance) : 'unrelated'
      if (instance === 'mapped') continue
      if (instance === 'pending') {
        operation.issues.push({ code: 'source-row', path: entry.path, message: 'This Host has not yet completed its current instance registration; its original heartbeat remains in SQL.' }); continue
      }
      const issue = await publishLocalUpgradeBytes(directory, entry, operation, save, options)
      if (issue) operation.issues.push(issue)
    }
    for (const file of operation.files) if (!seen.has(file.path)) operation.issues.push({ code: 'source-changed', path: file.path,
      message: 'A previously prepared source row is absent. Its physical publication and recovery state were retained.' })
    const sourceDigest = digest.digest('hex')
    operation.sourceDigest = sourceDigest
    await save()
    return { result: report(directory, operation), ...(!operation.issues.length ? { prepared: operation } : {}) }
  }, { signal: options.signal })
  // The reader verifies its source identity and closes its pinned read view
  // before cutover can be recorded. A failing callback/readback cannot leave a
  // falsely completed operation merely because the final body was copied.
  const completed = extracted.prepared
  if (completed) {
    options.signal?.throwIfAborted()
    // A second short read transaction verifies the actual source visible at
    // cutover, rather than silently omitting a commit made during extraction.
    const verified = await withLegacySqliteSnapshot(join(directory, sourceName), async snapshot => {
      if (snapshot.identity.dev !== completed!.source.dev || snapshot.identity.ino !== completed!.source.ino) return false
      const digest = createHash('sha256')
      for await (const entry of snapshot.entries()) {
        if (entry.kind === 'issue') return false
        digest.update(JSON.stringify([entry.path, entry.bytes.byteLength, hash(entry.bytes)]) + '\n')
      }
      return digest.digest('hex') === completed!.sourceDigest
    }, { signal: options.signal })
    if (verified) completed.status = 'complete'
    else completed.issues.push({ code: 'source-changed', message: 'The committed source changed during extraction. All copied files and the original database were retained; cutover was not claimed.' })
    await storage.set(key, structuredClone(completed))
    return report(directory, completed)
  }
  return extracted.result
}

/** Read-only startup/UI status. Inspection never creates migration state,
 * copies a row, starts a model, or opens an SQL writer. A pending conversion
 * does not remove the original source from the independently available reader. */
export async function inspectLocalStartupUpgrade(directory: string, storage: StoragePort,
  options: Pick<LocalStartupUpgradeOptions, 'signal' | 'requireExisting'> = {}): Promise<LocalStartupUpgradeReport> {
  options.signal?.throwIfAborted()
  const root = await canonicalLocalLocation(directory, true)
  if (options.requireExisting && !await ordinaryDirectory(root, false)) throw new Error('The existing Local directory is unavailable. No replacement store was created.')
  const completed = await completedResult(root, storage)
  if (completed) return completed
  const operation = await storage.get<UpgradeOperation>(localStartupUpgradeKey(root))
  if (operation) validateOperation(operation, root)
  try {
    await fs.lstat(join(root, sourceName))
    return operation ? report(root, operation) : { ...report(root), status: 'incomplete', issues: [{ code: 'source-row',
      message: 'Original Local SQL material is present. The one-time upgrade has not published its exact file contents yet.' }] }
  } catch (error) { if (!missing(error)) throw error }
  const sourceMissing = (): LocalStartupUpgradeReport => ({ ...report(root, operation), status: 'incomplete',
    issues: [{ code: 'source-missing', message: 'The original SQL source is absent before full conversion completed. Already published physical files and the existing upgrade responsibility were retained; no replacement source was created.' }] })
  if (operation) return sourceMissing()
  for (const name of [sourceName + '-wal', sourceName + '-shm']) {
    try { await fs.lstat(join(root, name)) } catch (error) { if (missing(error)) continue; throw error }
    return sourceMissing()
  }
  return report(root)
}

export interface LegacyLocalInventory {
  directory: string
  sourcePath: string
  files: Array<{ path: string; bytes: number; representation: 'text' | 'binary'; issues: readonly LegacySqliteIssue[] }>
  issues: LegacySqliteIssue[]
}
/** A requested one-time inventory, not a recurring whole-store scan. */
export async function inspectLegacyLocalInventory(directory: string, options: { signal?: AbortSignal } = {}): Promise<LegacyLocalInventory> {
  const root = await canonicalLocalLocation(directory, true), sourcePath = join(root, sourceName)
  return withLegacySqliteSnapshot(sourcePath, async snapshot => {
    const result: LegacyLocalInventory = { directory: root, sourcePath, files: [], issues: [] }
    for await (const entry of snapshot.entries()) {
      if (entry.kind === 'issue') result.issues.push(entry.issue)
      else result.files.push({ path: entry.path, bytes: entry.bytes.byteLength, representation: entry.source.representation, issues: entry.issues })
    }
    return result
  }, options)
}

/** Original SQL bytes stay readable independently of publication. Never returns
 * a physical conflict file under the label of the old SQL original. */
export async function readLegacyLocalOriginal(directory: string, path: string, options: { signal?: AbortSignal } = {}): Promise<{
  sourcePath: string; path: string; bytes: Uint8Array; representation: 'text' | 'binary'
} | undefined> {
  const root = await canonicalLocalLocation(directory, true), sourcePath = join(root, sourceName)
  return withLegacySqliteSnapshot(sourcePath, async snapshot => {
    const entry = await snapshot.read(path)
    if (entry?.kind === 'issue') throw new Error(entry.issue.message)
    const found = entry
    return found ? { sourcePath, path, bytes: found.bytes, representation: found.source.representation } : undefined
  }, options)
}
