import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

/** An observation of the same file across an ordinary rename. ctime changes
 * on rename; device, inode, birth time, byte count and mtime do not. This is
 * scoped to an unfinished operation, never a lock on later user edits. */
const parsePhysicalFile = (value: string) => /^local-file:(\d+):(\d+):(\d+):(-?\d+):(-?\d+):(-?\d+)$/.exec(value)
export function samePhysicalPublication(staged: string, observed: string): boolean {
  const a = parsePhysicalFile(staged), b = parsePhysicalFile(observed)
  return !!a && !!b && [1, 2, 3, 4, 6].every(index => a[index] === b[index])
}
/** Only the interrupted Helper report rename may use file identity without
 * byte count or mtime: its already published body may have been edited later. */
const sameRenamedReportFile = (staged: string, observed: string): boolean => {
  const a = parsePhysicalFile(staged), b = parsePhysicalFile(observed)
  return !!a && !!b && [1, 2, 6].every(index => a[index] === b[index])
}

export interface PreparedLocalReport { stageVersion: string; targetVersion: string | null }
export interface PreparedLocalAppend { stageVersion: string }
export interface LocalRecordEntry { path: string; bytes: number; empty: boolean }
export interface LocalRecordFingerprint { bytes: number; sha256: string }
/** Capability-backed source: native target keys never become Node paths. The
 * opener supplies bounded reads and checks its own unchanged source on finish. */
export interface LocalCaptureSource {
  version: string
  read(offset: number, length: number): Promise<Uint8Array>
  verify(bytes: number): Promise<void>
  close?(): Promise<void>
}
interface LocalCaptureOwner {
  version: 1
  source: string
  stage: string
  sourceVersion: string
  partialIdentity: string
  completed?: LocalRecordFingerprint
}
const transferWindow = 256 * 1024 // Transport buffer, never a file-size limit.
/** Actual per-file metadata for discovery, never a content hash or write gate. */
export interface LocalRecordMetadata extends LocalRecordEntry { version: string }
/** Omit content to retain the current bytes, null to delete, or supply a replacement.
 * The callback is synchronous and must only decide about this one file. */
export interface LocalRecordUpdate<T> { value: T; content?: string | Uint8Array | null }
/** A Task-owned state update never deletes or creates its containing directory. */
export interface LocalRecordReplacement<T> { value: T; content?: string | Uint8Array }

/** Only the Task-owned update's initial parent lookup failed as absent, before
 * reading or deciding about the file. Other failures retain their original type. */
export class LocalTaskRecordParentMissing extends Error {
  readonly path: string
  constructor(path: string, message: string) { super(message); this.path = path }
}

const temporaryName = /^\.dss-write-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i
const deviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i
const noFollow = constants.O_NOFOLLOW ?? 0
const nonBlock = constants.O_NONBLOCK ?? 0
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const mutationKey = (target: string): string => process.platform === 'win32' ? target.toLowerCase() : target
const fileIdentity = (info: BigIntStats): string => [info.dev, info.ino, info.birthtimeNs].join(':')
const fileObservation = (info: BigIntStats): string =>
  'local-file:' + [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].join(':')

/** Preserve the existing slash-separated filePath contract. Windows-only name
 * restrictions apply on Windows, not to valid POSIX filenames. The explicit
 * platform argument allows filename-rule checks without pretending to exercise
 * another operating system's filesystem; physical operations use this host.
 * The exact temporary-name pattern is reserved for unfinished replacements. */
export function localRecordPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof path !== 'string' || !path || /[\\\0\r\n]/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || temporaryName.test(part))) {
    throw new Error('Use a relative file path inside the Local records root.')
  }
  if (platform === 'win32' && (/[<>:"|?*\u0000-\u001f]/u.test(path)
    || path.split('/').some(part => /[ .]$/u.test(part) || deviceName.test(part)))) {
    throw new Error('Use an ordinary Windows filename inside the Local records root.')
  }
  return path
}

// Only overlapping mutations of the same physical file wait. This is a process-
// local append/write ordering queue, not a store lock or a cross-process lease.
const mutations = new Map<string, Promise<void>>()
function mutate<T>(target: string, action: () => Promise<T>): Promise<T> {
  const key = mutationKey(target)
  const result = (mutations.get(key) ?? Promise.resolve()).then(action)
  const settled = result.then(() => {}, () => {})
  mutations.set(key, settled)
  void settled.then(() => { if (mutations.get(key) === settled) mutations.delete(key) })
  return result
}

/** Direct physical records. There is no database, snapshot, content version,
 * whole-store scan, journal or multi-file transaction. Logical-to-physical role
 * mapping belongs to the caller; this class receives the mapped relative path.
 *
 * Only the requested directory chain is inspected. Existing symlinks/junctions
 * and special files are refused; listings never follow them. Portable Node
 * pathname APIs do not sandbox against a hostile process swapping directories
 * between checks and syscalls. The selected root must be user-controlled.
 */
export class LocalRecordFiles {
  readonly root: string
  constructor(root: string) {
    if (!isAbsolute(root) || root.includes('\0')) throw new Error('Local records require an absolute root directory.')
    this.root = resolve(root)
  }
  private target(path: string): string { return join(this.root, ...localRecordPath(path).split('/')) }

  /** Walk only this known chain, creating missing directories only for a write. */
  private async directory(directory: string, create: boolean): Promise<boolean> {
    let current = parse(directory).root
    for (const part of directory.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part)
      let info
      try { info = await fs.lstat(current) }
      catch (error) {
        if (!missing(error)) throw error
        if (!create) return false
        try { await fs.mkdir(current) }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
        info = await fs.lstat(current)
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Not an ordinary Local records directory: ' + current)
    }
    return true
  }
  private async ordinaryFile(target: string): Promise<boolean> {
    let info
    try { info = await fs.lstat(target) }
    catch (error) { if (missing(error)) return false; throw error }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not an ordinary Local record file: ' + target)
    return true
  }
  private async openedFile(target: string, handle: FileHandle, writing: boolean): Promise<void> {
    const opened = await handle.stat()
    let current
    try { current = await fs.lstat(target) }
    catch (error) { if (!missing(error)) throw error }
    if (!opened.isFile() || current?.isSymbolicLink()
      || writing && (!current?.isFile() || opened.dev !== current.dev || opened.ino !== current.ino)) {
      throw new Error('Local record changed while opening: ' + target)
    }
    // Reads may finish from an already-open ordinary file when another writer
    // replaces or deletes its pathname. An append must still target that file.
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    const target = this.target(path)
    if (!await this.directory(dirname(target), false) || !await this.ordinaryFile(target)) return undefined
    let handle
    try { handle = await fs.open(target, constants.O_RDONLY | noFollow | nonBlock) }
    catch (error) { if (missing(error)) return undefined; throw error }
    try {
      await this.openedFile(target, handle, false)
      return await handle.readFile()
    } finally { await handle.close() }
  }
  async read(path: string): Promise<string | undefined> {
    const bytes = await this.readBytes(path)
    return bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  /** Exact ordinary-file metadata; no sibling listing or content allocation. */
  /** Observe one already-addressed ordinary file using the same metadata and
   * skip semantics as directory discovery, without listing siblings or opening
   * the file. This is live metadata, not a content lease or existence gate. */
  async fileMetadata(path: string): Promise<LocalRecordMetadata | undefined> {
    const target = this.target(path)
    if (!await this.directory(dirname(target), false)) return undefined
    let info
    try { info = await fs.lstat(target, { bigint: true }) }
    catch (error) { if (missing(error)) return undefined; throw error }
    if (!info.isFile()) return undefined
    return { path, bytes: Number(info.size), empty: info.size === 0n, version: fileObservation(info) }
  }
  async fileInfo(path: string): Promise<{ bytes: number; version: string } | undefined> {
    const target = this.target(path)
    if (!await this.directory(dirname(target), false) || !await this.ordinaryFile(target)) return undefined
    let handle
    try { handle = await fs.open(target, constants.O_RDONLY | noFollow | nonBlock) }
    catch (error) { if (missing(error)) return undefined; throw error }
    try {
      await this.openedFile(target, handle, false)
      const info = await handle.stat({ bigint: true })
      return { bytes: Number(info.size), version: fileObservation(info) }
    }
    finally { await handle.close() }
  }
  /** Exact file-or-directory observation for callers that accept either. */
  async entryInfo(path: string): Promise<{ bytes: number; version: string; directory?: false } | { directory: true } | undefined> {
    const target = this.target(path)
    if (!await this.directory(dirname(target), false)) return undefined
    let named
    try { named = await fs.lstat(target) }
    catch (error) { if (missing(error)) return undefined; throw error }
    if (named.isSymbolicLink() || !named.isFile() && !named.isDirectory()) throw new Error('Not an ordinary Local record file or directory: ' + target)
    if (named.isDirectory()) return { directory: true }
    let handle
    try { handle = await fs.open(target, constants.O_RDONLY | noFollow | nonBlock) }
    catch (error) { if (missing(error)) return undefined; throw error }
    try {
      await this.openedFile(target, handle, false)
      const info = await handle.stat({ bigint: true })
      return { bytes: Number(info.size), version: fileObservation(info) }
    }
    finally { await handle.close() }
  }
  /** Reads a caller's known control-header length, not an exposed material cap. */
  async readPrefix(path: string, length: number): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('A header length must be a nonnegative integer.')
    const target = this.target(path)
    if (!await this.directory(dirname(target), false) || !await this.ordinaryFile(target)) return undefined
    let handle
    try { handle = await fs.open(target, constants.O_RDONLY | noFollow | nonBlock) }
    catch (error) { if (missing(error)) return undefined; throw error }
    try {
      await this.openedFile(target, handle, false)
      const bytes = Buffer.alloc(length), { bytesRead } = await handle.read(bytes, 0, length, 0)
      return bytes.subarray(0, bytesRead)
    } finally { await handle.close() }
  }
  /** Capture/recovery only: do not accept a mixed read as one original. This
   * observes the opened file and its exact current pathname, never ordinary
   * reads or a previous archive version. No other file is gated. */
  private async unchanged(target: string, handle: FileHandle, before: BigIntStats): Promise<void> {
    const after = await handle.stat({ bigint: true })
    let named: BigIntStats | undefined
    if (await this.directory(dirname(target), false)) {
      try { named = await fs.lstat(target, { bigint: true }) }
      catch (error) { if (!missing(error)) throw error }
    }
    if (!named?.isFile() || named.isSymbolicLink() || fileObservation(before) !== fileObservation(after)
      || fileObservation(before) !== fileObservation(named))
      throw new Error('Local file changed during capture; it was not published as a consistent original: ' + target)
  }
  private async fingerprintOpened(target: string, handle: FileHandle, signal?: AbortSignal): Promise<LocalRecordFingerprint> {
    const before = await handle.stat({ bigint: true })
    const buffer = Buffer.allocUnsafe(transferWindow), digest = createHash('sha256'); let bytes = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes)
      if (!bytesRead) break
      digest.update(buffer.subarray(0, bytesRead)); bytes += bytesRead
    }
    await this.unchanged(target, handle, before)
    return { bytes, sha256: digest.digest('hex') }
  }
  /** Stream the current exact file for an explicit capture/recovery operation.
   * Ordinary read() stays live and is not checked against a saved fingerprint. */
  async fingerprint(path: string, signal?: AbortSignal): Promise<LocalRecordFingerprint | undefined> {
    signal?.throwIfAborted()
    const target = this.target(path)
    if (!await this.directory(dirname(target), false) || !await this.ordinaryFile(target)) return undefined
    let handle
    try { handle = await fs.open(target, constants.O_RDONLY | noFollow | nonBlock) }
    catch (error) { if (missing(error)) return undefined; throw error }
    try {
      await this.openedFile(target, handle, false)
      return await this.fingerprintOpened(target, handle, signal)
    } finally { await handle.close() }
  }
  /** Both fresh and cold captures finish through one exact pathname boundary.
   * The caller already owns this process's stage/partial file queues. This is
   * not an atomic no-replace or handle-bound rename against another process:
   * portable fs.rename has neither facility. Do not add a new filesystem
   * requirement or claim these last pathname checks close that OS boundary. */
  private async publishCapturedFile(partial: string, stage: string, verified: BigIntStats, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!await this.directory(dirname(stage), false)) throw new Error('Recorder staging directory disappeared before capture publication.')
    if (await this.ordinaryFile(stage)) throw new Error('Capture destination appeared during publication; it was preserved: ' + stage)
    const current = await fs.lstat(partial, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || fileObservation(current) !== fileObservation(verified))
      throw new Error('Capture partial changed before publication; it was preserved: ' + partial)
    await fs.rename(partial, stage)
  }
  /** One exact accepted source capture, not a general write journal. A small
   * owner record binds the actual partial inode to this source/stage. Existing
   * partials are never truncated: cold continuation checks their actual bytes
   * against that unchanged source prefix before appending. Unknown/edited
   * partials remain untouched. Completed captures retain their digest until the
   * caller ends its known working scope. Ordinary files remain live/editable.
   * Fixed transfer windows, no size cap, hardlink, scan or fallback root. */
  stageCopy(sourcePath: string, stagePath: string, signal?: AbortSignal): Promise<LocalRecordFingerprint | undefined> {
    const source = this.target(sourcePath)
    if ([stagePath, stagePath + '.copying', stagePath + '.capture.json'].some(path => mutationKey(this.target(path)) === mutationKey(source)))
      throw new Error('A captured original requires its own distinct stage.')
    return this.stageRead(sourcePath, stagePath, async () => {
      if (!await this.directory(dirname(source), false) || !await this.ordinaryFile(source)) return undefined
      const reader = await fs.open(source, constants.O_RDONLY | noFollow | nonBlock)
      try {
        await this.openedFile(source, reader, false)
        const before = await reader.stat({ bigint: true })
        return { version: fileObservation(before),
          read: async (offset, length) => {
            const buffer = Buffer.allocUnsafe(length), { bytesRead } = await reader.read(buffer, 0, length, offset)
            return buffer.subarray(0, bytesRead)
          },
          verify: async bytes => {
            await this.unchanged(source, reader, before)
            if (BigInt(bytes) !== before.size) throw new Error('Source size changed during capture: ' + sourcePath)
          },
          close: () => reader.close(),
        }
      } catch (error) { await reader.close(); throw error }
    }, signal)
  }
  /** Stream an authorized capability source into only this owned root stage.
   * The source may be remote or opaque; this method never resolves it as a path. */
  stageRead(sourcePath: string, stagePath: string, openSource: () => Promise<LocalCaptureSource | undefined>,
    signal?: AbortSignal): Promise<LocalRecordFingerprint | undefined> {
    const stage = this.target(stagePath)
    const partial = this.target(stagePath + '.copying'), ownerPath = stagePath + '.capture.json', ownerTarget = this.target(ownerPath)
    const targets = [stage, partial, ownerTarget].sort((a, b) => mutationKey(a) < mutationKey(b) ? -1 : 1)
    return mutate(targets[0]!, () => mutate(targets[1]!, () => mutate(targets[2]!, async () => {
      signal?.throwIfAborted()
      const saved = await this.readBytes(ownerPath)
      let owner: LocalCaptureOwner | undefined
      if (saved !== undefined) {
        try { owner = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved)) as LocalCaptureOwner }
        catch { throw new Error('Capture ownership record is unreadable; existing files were preserved: ' + ownerPath) }
        if (owner?.version !== 1 || owner.source !== sourcePath || owner.stage !== stagePath
          || typeof owner.sourceVersion !== 'string' || typeof owner.partialIdentity !== 'string')
          throw new Error('Capture ownership differs; existing files were preserved: ' + ownerPath)
      }
      if (await this.directory(dirname(stage), false) && await this.ordinaryFile(stage)) {
        const current = await this.fingerprint(stagePath, signal)
        if (!owner?.completed || !current || current.bytes !== owner.completed.bytes || current.sha256 !== owner.completed.sha256)
          throw new Error('Completed capture is unowned or changed; it was preserved: ' + stagePath)
        return current
      }
      const priorPartial = await this.directory(dirname(partial), false) && await this.ordinaryFile(partial)
      if (priorPartial && !owner) throw new Error('Unowned partial capture was preserved: ' + stagePath + '.copying')
      if (!priorPartial && owner?.completed) throw new Error('Completed capture is missing; its publication is unconfirmed: ' + stagePath)
      let reader: LocalCaptureSource | undefined, writer: FileHandle | undefined, fresh = false, published = false
      let ownedIdentity: string | undefined, ownerText = saved === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(saved)
      const digest = createHash('sha256'); let bytes = 0
      try {
        if (priorPartial) {
          writer = await fs.open(partial, constants.O_RDWR | noFollow | nonBlock)
          await this.openedFile(partial, writer, true)
          ownedIdentity = fileIdentity(await writer.stat({ bigint: true }))
          if (ownedIdentity !== owner!.partialIdentity) throw new Error('Partial capture identity changed; it was preserved: ' + stagePath + '.copying')
          if (owner!.completed) {
            const verifiedBefore = await writer.stat({ bigint: true })
            const current = await this.fingerprintOpened(partial, writer, signal)
            if (current.bytes !== owner!.completed.bytes || current.sha256 !== owner!.completed.sha256)
              throw new Error('Completed partial capture was edited; it was preserved: ' + stagePath + '.copying')
            await this.unchanged(partial, writer, verifiedBefore)
            await writer.close(); writer = undefined
            await this.publishCapturedFile(partial, stage, verifiedBefore, signal); published = true
            return current
          }
        }
        reader = await openSource()
        if (!reader) {
          if (priorPartial) throw new Error('Source of an unfinished capture is missing; its partial was preserved: ' + sourcePath)
          return undefined
        }
        if (priorPartial && reader.version !== owner!.sourceVersion)
          throw new Error('Source of an unfinished capture changed; its partial was preserved: ' + sourcePath)
        if (!writer) {
          await this.directory(dirname(stage), true)
          // EXCL is deliberate: a newly appeared file is not ours to truncate.
          writer = await fs.open(partial, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
          fresh = true; await this.openedFile(partial, writer, true)
          ownedIdentity = fileIdentity(await writer.stat({ bigint: true }))
          owner = { version: 1, source: sourcePath, stage: stagePath, sourceVersion: reader.version, partialIdentity: ownedIdentity }
          ownerText = JSON.stringify(owner)
          await this.replaceAt(ownerTarget, Buffer.from(ownerText, 'utf8'))
        }
        const buffer = Buffer.allocUnsafe(transferWindow), partialBefore = await writer.stat({ bigint: true })
        const prefixBytes = Number(partialBefore.size)
        if (priorPartial) {
          const existing = Buffer.allocUnsafe(transferWindow)
          while (bytes < prefixBytes) {
            signal?.throwIfAborted()
            const length = Math.min(buffer.length, prefixBytes - bytes)
            const part = await writer.read(existing, 0, length, bytes)
            let from = 0
            while (from < part.bytesRead) {
              const next = await reader.read(bytes + from, part.bytesRead - from)
              if (next.byteLength > part.bytesRead - from) throw new Error('Capture source exceeded its requested read window.')
              if (!next.byteLength) break
              buffer.set(next, from); from += next.byteLength
            }
            if (!part.bytesRead || from !== part.bytesRead || !existing.subarray(0, part.bytesRead).equals(buffer.subarray(0, from)))
              throw new Error('Partial capture content changed; it was preserved: ' + stagePath + '.copying')
            digest.update(existing.subarray(0, part.bytesRead)); bytes += part.bytesRead
          }
          await this.unchanged(partial, writer, partialBefore)
        }
        // This invocation owns the open private partial. Live copying only
        // drains writes; prior-process bytes were checked above on cold entry.
        for (;;) {
          signal?.throwIfAborted()
          const chunk = await reader.read(bytes, buffer.length), bytesRead = chunk.byteLength
          if (bytesRead > buffer.length) throw new Error('Capture source exceeded its requested read window.')
          if (!bytesRead) break
          buffer.set(chunk)
          for (let written = 0; written < bytesRead;) {
            const next = await writer.write(buffer, written, bytesRead - written, bytes)
            if (!next.bytesWritten) throw new Error('Captured original write made no progress.')
            digest.update(buffer.subarray(written, written + next.bytesWritten))
            written += next.bytesWritten; bytes += next.bytesWritten
          }
        }
        await reader.verify(bytes)
        await writer.sync()
        const result = { bytes, sha256: digest.copy().digest('hex') }
        const verifiedBefore = await writer.stat({ bigint: true })
        if (verifiedBefore.size !== BigInt(bytes)) throw new Error('Captured original size differs from its completed writes: ' + stagePath + '.copying')
        // Persist completion before the one rename. Cold replay can finish this
        // exact full capture even if its original source is later removed.
        owner!.completed = result; ownerText = JSON.stringify(owner)
        await this.replaceAt(ownerTarget, Buffer.from(ownerText, 'utf8'))
        await writer.close(); writer = undefined
        await reader.close?.(); reader = undefined
        await this.publishCapturedFile(partial, stage, verifiedBefore, signal); published = true
        return result
      } finally {
        try { await reader?.close?.() } finally {
          try { await writer?.close() } finally {
              // A recovered partial is never discarded on failure. For a fresh
              // attempt, delete only the same actual file with our exact bytes.
              // Unknown/edited bytes and ownership records remain for the caller.
              if (fresh && !published) {
                let current: BigIntStats | undefined
                try { current = await fs.lstat(partial, { bigint: true }) } catch (error) { if (!missing(error)) throw error }
                if (current?.isFile() && !current.isSymbolicLink() && fileIdentity(current) === ownedIdentity) {
                  const actual = await this.fingerprint(stagePath + '.copying')
                  if (actual?.bytes === bytes && actual.sha256 === digest.copy().digest('hex')) {
                    await this.deleteAt(partial)
                    const savedOwner = await this.readBytes(ownerPath)
                    if (ownerText !== undefined && savedOwner !== undefined && Buffer.from(savedOwner).equals(Buffer.from(ownerText))) await this.deleteAt(ownerTarget)
                  }
                }
              }
          }
        }
      }
    })))
  }

  /** An ordinary authorized replacement, NOT migration/import-if-absent.
   * Write and close a sibling temporary file, then rename once over the target.
   * Rename failure never triggers delete-then-rename or an automatic retry. A
   * process stop before rename leaves the prior target intact and may leave its
   * temporary sibling; no background cleanup or implicit import is performed.
   */
  replace(path: string, content: string | Uint8Array): Promise<void> {
    const target = this.target(path), bytes = this.capture(content)
    return mutate(target, () => this.replaceAt(target, bytes))
  }
  /** Initialize one known Task template only if absent. All handles in this
   * process share its existing same-file queue, then publish complete bytes via
   * the normal temporary-file rename. This is NOT migration/import-if-absent
   * against other processes or arbitrary concurrent external editors, and does
   * not require a hardlink-capable filesystem. Existing bodies are not read. */
  createIfAbsent(path: string, content: string | Uint8Array): Promise<boolean> {
    const target = this.target(path), bytes = this.capture(content)
    return mutate(target, async () => {
      if (await this.directory(dirname(target), false) && await this.ordinaryFile(target)) return false
      await this.replaceAt(target, bytes)
      return true
    })
  }
  /** Publish one prepared file only while its exact destination is absent.
   * No copy/delete fallback or cross-process no-replace guarantee. */
  renameIfAbsent(from: string, to: string): Promise<'renamed' | 'source-missing' | 'destination-exists'> {
    const source = this.target(from), target = this.target(to)
    if (mutationKey(source) === mutationKey(target)) throw new Error('A publication needs distinct source and destination paths.')
    const targets = [source, target].sort((a, b) => mutationKey(a) < mutationKey(b) ? -1 : 1)
    return mutate(targets[0]!, () => mutate(targets[1]!, async () => {
      if (!await this.directory(dirname(source), false) || !await this.ordinaryFile(source)) return 'source-missing'
      await this.directory(dirname(target), true)
      if (await this.ordinaryFile(target)) return 'destination-exists'
      // Same-process target writers are ordered. Portable Node rename still has
      // the documented external-process check-to-syscall window, not no-replace.
      await fs.rename(source, target)
      return 'renamed'
    }))
  }
  /** One real prepared-file handoff. Only these two pathnames coordinate;
   * ordering them prevents opposite handoffs from deadlocking. Destination
   * replacement is the normal rename behavior. A missing source is false,
   * never proof that a particular prior handoff succeeded. No copy/delete
   * fallback, directory-wide lock, or automatic retry is performed. */
  rename(from: string, to: string): Promise<boolean> {
    const source = this.target(from), target = this.target(to)
    if (mutationKey(source) === mutationKey(target)) throw new Error('A prepared Local file handoff needs two distinct paths.')
    const pair = [source, target].sort((a, b) => mutationKey(a) < mutationKey(b) ? -1 : 1)
    return mutate(pair[0]!, () => mutate(pair[1]!, async () => {
      if (!await this.directory(dirname(source), false) || !await this.ordinaryFile(source)) return false
      await this.directory(dirname(target), true)
      await this.ordinaryFile(target)
      try { await fs.rename(source, target); return true }
      catch (error) {
        // ENOENT can also identify a disappeared destination parent. Report
        // that actual failure unless the addressed source really is absent.
        if (missing(error) && !await this.ordinaryFile(source)) return false
        throw error
      }
    }))
  }
  /** One accepted business append, not an ordinary-write transaction. Rename
   * consumes its stage. A missing stage needs the saved file identity at the
   * target; absence alone never proves publication. If the stage still exists,
   * rename has not completed: rebuild from the current target, then save this
   * newly prepared file's observation before handing it off. Only these two
   * files share their existing queues; later edits are not locked or reverted. */
  appendPrepared(path: string, stagePath: string, content: string, prepared: PreparedLocalAppend | undefined,
    markPrepared: (value: PreparedLocalAppend) => Promise<void>): Promise<void> {
    const target = this.target(path), stage = this.target(stagePath)
    if (mutationKey(target) === mutationKey(stage)) throw new Error('A prepared append requires its own stage file.')
    const pair = [target, stage].sort((a, b) => mutationKey(a) < mutationKey(b) ? -1 : 1)
    return mutate(pair[0]!, () => mutate(pair[1]!, async () => {
      const staged = await this.directory(dirname(stage), false) && await this.ordinaryFile(stage)
      if (prepared && !staged) {
        const actual = await this.fileInfo(path)
        if (actual && samePhysicalPublication(prepared.stageVersion, actual.version)) return
        throw new Error('The prepared append is unavailable and its publication is not confirmed: ' + path)
      }
      // Preserve the same prepared-file handoff without retaining the growing
      // old body in memory. A surviving stage is rebuilt from the current
      // target, exactly as before; no new target-change gate is introduced.
      await this.replaceAt(stage, async writer => {
        let reader: FileHandle | undefined
        if (await this.directory(dirname(target), false) && await this.ordinaryFile(target)) {
          try { reader = await fs.open(target, constants.O_RDONLY | noFollow | nonBlock) }
          catch (error) { if (!missing(error)) throw error }
        }
        try {
          if (reader) {
            await this.openedFile(target, reader, false)
            // Like the prior readFile of a nonempty ordinary file, copy only
            // its initially observed length, not a concurrently growing tail.
            // An initially empty file remains EOF-based as readFile was.
            const size = (await reader.stat()).size
            const buffer = Buffer.allocUnsafe(Math.min(transferWindow, size || transferWindow))
            let copied = 0
            for (;;) {
              const length = size ? Math.min(buffer.length, size - copied) : buffer.length
              if (!length) break
              const { bytesRead } = await reader.read(buffer, 0, length, null)
              if (!bytesRead) break
              await writer.writeFile(buffer.subarray(0, bytesRead))
              copied += bytesRead
            }
          }
          await writer.writeFile(Buffer.from(content, 'utf8'))
        } finally { await reader?.close() }
      })
      const observed = await this.fileInfo(stagePath)
      if (!observed) throw new Error('The prepared append stage is missing: ' + stagePath)
      await markPrepared({ stageVersion: observed.version })
      await this.directory(dirname(target), true)
      await this.ordinaryFile(target)
      // Do not call rename(): these two exact file queues are already owned.
      await fs.rename(stage, target)
    }))
  }
  /** Accepted Helper reports and Task reconstruction use this whole-file
   * handoff. Ordinary append/replace are unchanged. The old daily report streams
   * through one fixed window; only this exact report and stage share their file
   * queues. Saved metadata belongs to this unfinished handoff, never a lasting
   * document lock. External edits remain possible (portable rename is not a
   * cross-process compare-and-swap); a detected change preserves all material. */
  publishPreparedReport(path: string, stagePath: string, text: string, append: boolean,
    prepared: PreparedLocalReport | undefined, markPrepared: (value: PreparedLocalReport) => Promise<void>,
    missingStage: 'strict' | 'same-file-identity' = 'strict'): Promise<void> {
    const target = this.target(path), stage = this.target(stagePath)
    if (mutationKey(target) === mutationKey(stage)) throw new Error('A prepared report requires its own stage file.')
    const pair = [target, stage].sort((a, b) => mutationKey(a) < mutationKey(b) ? -1 : 1)
    return mutate(pair[0]!, () => mutate(pair[1]!, async () => {
      if (!prepared) {
        const actual = await this.fileInfo(path)
        await this.directory(dirname(stage), true)
        await this.ordinaryFile(stage)
        let writer: FileHandle | undefined, reader: FileHandle | undefined
        try {
          // The accepted call owns this one exact disposable stage. Until its
          // prepared identity is saved no target rename can have been issued,
          // so a cold partial is rewritten here rather than leaving full-day
          // random orphan copies after repeated interruption.
          writer = await fs.open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow | nonBlock, 0o600)
          await this.openedFile(stage, writer, true)
          let offset = 0
          const write = async (bytes: Uint8Array) => {
            for (let at = 0; at < bytes.byteLength;) {
              const next = await writer!.write(bytes, at, bytes.byteLength - at, offset)
              if (!next.bytesWritten) throw new Error('Prepared report write made no progress.')
              at += next.bytesWritten; offset += next.bytesWritten
            }
          }
          if (append && actual) {
            reader = await fs.open(target, constants.O_RDONLY | noFollow | nonBlock)
            await this.openedFile(target, reader, false)
            const before = await reader.stat({ bigint: true })
            if (fileObservation(before) !== actual.version) throw new Error('The Helper report changed before preparation: ' + path)
            const buffer = Buffer.allocUnsafe(transferWindow)
            for (;;) {
              const next = await reader.read(buffer, 0, buffer.length, offset)
              if (!next.bytesRead) break
              await write(buffer.subarray(0, next.bytesRead))
            }
            await this.unchanged(target, reader, before)
            await reader.close(); reader = undefined
          }
          await write(Buffer.from(text, 'utf8'))
          await writer.sync(); await writer.close(); writer = undefined
        } finally {
          try { await reader?.close() } finally { await writer?.close() }
        }
        const staged = await this.fileInfo(stagePath)
        if (!staged) throw new Error('The prepared Helper report is missing: ' + stagePath)
        prepared = { stageVersion: staged.version, targetVersion: actual?.version ?? null }
        await markPrepared(prepared)
      }
      const staged = await this.fileInfo(stagePath), current = await this.fileInfo(path)
      if (!staged) {
        if (current && (missingStage === 'same-file-identity' ? sameRenamedReportFile(prepared.stageVersion, current.version)
          : samePhysicalPublication(prepared.stageVersion, current.version))) return
        throw new Error('The prepared Helper report is missing and publication is unconfirmed: ' + path)
      }
      if (staged.version !== prepared.stageVersion || (current?.version ?? null) !== prepared.targetVersion)
        throw new Error('The prepared Helper report or its destination changed; publication is unconfirmed and both were preserved: ' + path)
      await this.directory(dirname(target), true)
      // Both same-process file queues are already owned; no extra rename lane.
      await fs.rename(stage, target)
    }))
  }
  private async existingParent(target: string, expected?: string, initialTaskPath?: string): Promise<string> {
    const parent = dirname(target)
    if (!await this.directory(parent, false)) {
      const message = 'The original Local record directory no longer exists: ' + parent
      throw initialTaskPath === undefined ? new Error(message) : new LocalTaskRecordParentMissing(initialTaskPath, message)
    }
    let info: BigIntStats
    try { info = await fs.lstat(parent, { bigint: true }) }
    catch (error) {
      if (initialTaskPath !== undefined && missing(error)) throw new LocalTaskRecordParentMissing(initialTaskPath, (error as Error).message)
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Not an ordinary Local records directory: ' + parent)
    const identity = fileIdentity(info)
    if (expected !== undefined && identity !== expected) throw new Error('The original Local record directory changed: ' + parent)
    return identity
  }
  private async replaceAt(target: string, bytes: Uint8Array | ((writer: FileHandle) => Promise<void>), signal?: AbortSignal, parentIdentity?: string): Promise<void> {
      signal?.throwIfAborted()
      if (parentIdentity === undefined) await this.directory(dirname(target), true)
      else await this.existingParent(target, parentIdentity)
      await this.ordinaryFile(target)
      const temporary = join(dirname(target), '.dss-write-' + randomUUID() + '.tmp')
      let created = false, published = false, failure: unknown
      try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
        created = true
        try {
          if (typeof bytes === 'function') await bytes(handle)
          else await handle.writeFile(bytes)
          await handle.sync()
        }
        finally { await handle.close() }
        if (parentIdentity !== undefined) await this.existingParent(target, parentIdentity)
        else if (!await this.directory(dirname(target), false)) throw new Error('Local records directory disappeared before replacement: ' + target)
        await this.ordinaryFile(target)
        // Only an explicit caller-owned optional attempt can be cancelled.
        // Once this rename syscall is issued its outcome must be observed.
        signal?.throwIfAborted()
        await fs.rename(temporary, target)
        published = true
      } catch (error) { failure = error; throw error }
      finally {
          if (created && !published) {
            try {
              if (await this.directory(dirname(target), false)) await fs.unlink(temporary)
            } catch (cleanup) {
              if (!missing(cleanup)) throw failure === undefined ? cleanup
                : new AggregateError([failure, cleanup], 'Local replacement failed and its temporary file could not be removed.')
            }
          }
      }
  }

  /** Read/decide/replace only one file under the SAME ordering as direct append,
   * replace and delete. There is no version comparison or store-wide gate.
   * This coordinates this process's users of this class, not external editors.
   * Ordinary writes should use replace/append rather than adding a read here. */
  update<T>(path: string, decide: (current: Uint8Array | undefined) => LocalRecordUpdate<T>, signal?: AbortSignal): Promise<T> {
    const target = this.target(path)
    return mutate(target, async () => {
      signal?.throwIfAborted()
      const current = await this.readBytes(path)
      signal?.throwIfAborted()
      const decision = decide(current)
      if (!decision || typeof decision !== 'object' || !('value' in decision)
        || 'then' in decision) throw new Error('A Local record update must return a synchronous decision for this file.')
      signal?.throwIfAborted()
      if (decision.content === null) await this.deleteAt(target)
      else if (decision.content !== undefined) await this.replaceAt(target, this.capture(decision.content), signal)
      return decision.value
    })
  }

  /** Direct append, ordered with this process's writes to the same file only.
   * No read/rewrite of the old body. A failed or interrupted append can leave a
   * partial suffix; it is not rolled back or retried as if nothing was written.
   */
  append(path: string, content: string | Uint8Array): Promise<void> {
    const target = this.target(path), bytes = this.capture(content)
    return mutate(target, async () => {
      await this.directory(dirname(target), true)
      const exists = await this.ordinaryFile(target)
      const handle = await fs.open(target, constants.O_WRONLY | constants.O_APPEND | noFollow | nonBlock
        | (exists ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
      try {
        await this.openedFile(target, handle, true)
        await handle.writeFile(bytes)
        await handle.sync()
      } finally { await handle.close() }
    })
  }
  delete(path: string): Promise<boolean> {
    const target = this.target(path)
    return mutate(target, () => this.deleteAt(target))
  }
  /** Consume only the actual file already named by an existing wake/claim.
   * A missing or newly published signal is left alone without rejecting other
   * work. The comparison and unlink share this process's same-file queue with
   * append/replace/rename. This is not a cross-process conditional-unlink API.
   * No directory listing or file body read is needed. */
  deleteObserved(path: string, observedVersion: string, beforeDelete?: () => void): Promise<boolean> {
    const target = this.target(path)
    return mutate(target, async () => {
      if (!await this.directory(dirname(target), false)) return false
      let info: BigIntStats
      try { info = await fs.lstat(target, { bigint: true }) }
      catch (error) { if (missing(error)) return false; throw error }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not an ordinary Local record file: ' + target)
      if (fileObservation(info) !== observedVersion) return false
      beforeDelete?.()
      try { await fs.unlink(target); return true }
      catch (error) { if (missing(error)) return false; throw error }
    })
  }
  private async deleteAt(target: string): Promise<boolean> {
    if (!await this.directory(dirname(target), false) || !await this.ordinaryFile(target)) return false
    try { await fs.unlink(target); return true }
    catch (error) { if (missing(error)) return false; throw error }
  }
  private capture(content: string | Uint8Array): Uint8Array {
    if (typeof content === 'string') return Buffer.from(content, 'utf8')
    if (content instanceof Uint8Array) return Uint8Array.from(content)
    throw new Error('A Local record write requires text or bytes.')
  }

  /** Same-file asynchronous evaluation for an existing program-state record.
   * The callback may read known facts, but must not write other files or await
   * a mutation of this file. This does not make its other reads atomic. */
  updateAsync<T>(path: string, decide: (current: Uint8Array | undefined) => Promise<LocalRecordUpdate<T>>, signal?: AbortSignal): Promise<T> {
    const target = this.target(path)
    return mutate(target, async () => {
      signal?.throwIfAborted()
      const current = await this.readBytes(path)
      signal?.throwIfAborted()
      const decision = await decide(current)
      if (!decision || typeof decision !== 'object' || !('value' in decision))
        throw new Error('A Local record update requires a decision for this file.')
      signal?.throwIfAborted()
      if (decision.content === null) await this.deleteAt(target)
      else if (decision.content !== undefined) await this.replaceAt(target, this.capture(decision.content), signal)
      return decision.value
    })
  }

  /** Update state inside an already owned Task directory. Initialization and
   * explicit recovery own creating that directory; this operation never does.
   * Capture the parent before reading so an old accepted update cannot publish
   * into a later same-named Task directory. Only an explicit caller-owned
   * cleanup boundary joins the parent directory lane; other files retain
   * their original file-level ordering. */
  updateInExistingDirectory<T>(path: string, decide: (current: Uint8Array | undefined) => Promise<LocalRecordReplacement<T>>, signal?: AbortSignal, coordinateRemoval = false): Promise<T> {
    const target = this.target(path)
    const update = () => mutate(target, async () => {
      signal?.throwIfAborted()
      const parentIdentity = await this.existingParent(target, undefined, path)
      const current = await this.readBytes(path)
      signal?.throwIfAborted()
      const decision = await decide(current)
      if (!decision || typeof decision !== 'object' || !('value' in decision) || decision.content === null)
        throw new Error('A Local Task record update requires a replacement decision for this file.')
      signal?.throwIfAborted()
      if (decision.content !== undefined) await this.replaceAt(target, this.capture(decision.content), signal, parentIdentity)
      return decision.value
    })
    return coordinateRemoval ? mutate(dirname(target), update) : update()
  }

  /** Remove this exact owned Task directory as a whole. Node/OS handles the
   * recursion; DSS does not enumerate or inspect individual children. This is
   * ordinary interruptible deletion, not an atomic directory transaction.
   * Errors such as an actual Windows sharing violation retain caller-owned
   * cleanup responsibility for retry. Symlinks below the root are not followed.
   * An explicitly coordinated directory waits for in-flight updates to that
   * same directory, never for other Task or unrelated file operations. */
  removeDirectory(path: string, coordinateRemoval = false): Promise<void> {
    const target = this.target(path)
    const remove = async () => {
      if (!await this.directory(target, false)) return
      await fs.rm(target, { recursive: true, force: true })
    }
    return coordinateRemoval ? mutate(target, remove) : remove()
  }
  /** Remove one empty, explicitly addressed directory. ENOTEMPTY is an actual
   * incomplete cleanup, never a reason to recursively remove new material. */
  async removeEmptyDirectory(path: string): Promise<boolean> {
    const target = this.target(path)
    if (!await this.directory(target, false)) return false
    try { await fs.rmdir(target); return true }
    catch (error) { if (missing(error)) return false; throw error }
  }

  private async entries(prefix: string, recursive: boolean, descend?: (path: string) => boolean): Promise<LocalRecordMetadata[]> {
    const logical = prefix === '' ? '' : localRecordPath(prefix.replace(/\/$/, ''))
    const directory = logical ? this.target(logical) : this.root
    if (!await this.directory(directory, false)) return []
    const result: LocalRecordMetadata[] = []
    const visit = async (current: string, relative: string): Promise<void> => {
      let entries
      try { entries = await fs.readdir(current, { withFileTypes: true }) }
      catch (error) { if (missing(error)) return; throw error }
      for (const entry of entries) {
        if (temporaryName.test(entry.name) || entry.isSymbolicLink()) continue
        const path = relative ? relative + '/' + entry.name : entry.name
        // External names that cannot be addressed safely are never traversed.
        try { localRecordPath(path) } catch { continue }
        const target = join(current, entry.name)
        let info
        try { info = await fs.lstat(target, { bigint: true }) }
        catch (error) { if (missing(error)) continue; throw error }
        if (info.isSymbolicLink()) continue
        if (info.isFile()) result.push({ path, bytes: Number(info.size), empty: info.size === 0n,
          // Nanosecond metadata keeps untouched empty notifications stable,
          // while a real replace/append is a new observation, across handles
          // and process restarts. Reading a directory never loads file bodies.
          version: fileObservation(info) })
        else if (recursive && info.isDirectory() && (descend?.(path) ?? true)) await visit(target, path)
      }
    }
    await visit(directory, logical)
    return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  }
  listMetadata(prefix = '', recursive = false, descend?: (path: string) => boolean): Promise<LocalRecordMetadata[]> { return this.entries(prefix, recursive, descend) }
  async list(prefix = '', descend?: (path: string) => boolean): Promise<LocalRecordEntry[]> {
    return (await this.entries(prefix, true, descend)).map(({ version: _observation, ...entry }) => entry)
  }
  async listDirectory(prefix = ''): Promise<LocalRecordEntry[]> {
    return (await this.entries(prefix, false)).map(({ version: _observation, ...entry }) => entry)
  }
  async listDirectoryNames(prefix = ''): Promise<string[]> { return (await this.listDirectory(prefix)).map(entry => entry.path) }
}
