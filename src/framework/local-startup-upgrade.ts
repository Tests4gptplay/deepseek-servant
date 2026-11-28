import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { dirname, join, parse, sep } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { localRecordPath } from './local-record-files.js'
import type { LegacySqliteFile, LegacySqliteIssue } from './legacy-sqlite-reader.js'
import { localUpgradeResultKey } from './local-upgrade-mapping.js'
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
async function completedResult(directory: string, storage: StoragePort): Promise<LocalStartupUpgradeReport | undefined> {
  const value = await storage.get<{ kind: string; directory: string; report: LocalStartupUpgradeReport }>(localUpgradeResultKey(directory))
  if (!value) return undefined
  if (value.kind !== 'dss-local-upgrade-result' || value.directory !== directory || value.report?.status !== 'complete') throw new Error('Invalid one-time Local upgrade result; retained without replaying SQL.')
  return value.report
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
