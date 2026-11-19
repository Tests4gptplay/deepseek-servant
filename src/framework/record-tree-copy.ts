import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { canonicalLocalLocation } from './local-location.js'

interface Identity { dev: string; ino: string }
interface Entry { path: string; kind: 'directory' | 'file'; bytes?: number; sha256?: string }
export interface RecordTreeCopyState {
  version: 1
  source: string
  destination: string
  fingerprint: string
  /** Only paths exclusively created by this accepted move may be resumed. */
  owned: Record<string, Identity>
}
const windowSize = 256 * 1024
const flags = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const identity = (s: BigIntStats): Identity => ({ dev: String(s.dev), ino: String(s.ino) })
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino
const version = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
const nested = (parent: string, child: string) => { const p = relative(parent, child); return p === '' || !isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep) }
async function ordinaryDirectory(path: string): Promise<BigIntStats> {
  const s = await lstat(path, { bigint: true })
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(path) !== path) throw new Error('Record copy requires an ordinary unchanged directory: ' + path)
  return s
}
async function unchanged(path: string, handle: FileHandle, before: BigIntStats): Promise<void> {
  const actual = await lstat(path, { bigint: true }), held = await handle.stat({ bigint: true })
  if (!actual.isFile() || actual.isSymbolicLink() || version(actual) !== version(before) || version(held) !== version(before))
    throw new Error('Record file changed during the explicit copy: ' + path)
}
async function fileHash(path: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | flags)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('Record copy does not follow links or special files: ' + path)
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(windowSize)
    let bytes = 0
    const length = Number(before.size)
    while (bytes < length) {
      signal?.throwIfAborted()
      const r = await handle.read(buffer, 0, Math.min(buffer.length, length - bytes), bytes)
      if (!r.bytesRead) break
      hash.update(buffer.subarray(0, r.bytesRead)); bytes += r.bytesRead
    }
    await unchanged(path, handle, before)
    return { bytes, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}
async function manifest(root: string, signal?: AbortSignal, observed?: Map<string, BigIntStats>): Promise<Entry[]> {
  const entries: Entry[] = []
  const visit = async (path: string) => {
    signal?.throwIfAborted()
    const directory = path ? join(root, path) : root
    const before = identity(await ordinaryDirectory(directory))
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      signal?.throwIfAborted()
      const logical = path ? path + '/' + name : name, absolute = join(directory, name)
      const info = await lstat(absolute, { bigint: true })
      observed?.set(logical, info)
      if (info.isSymbolicLink()) throw new Error('Record copy does not follow symbolic links: ' + absolute)
      if (info.isDirectory()) { entries.push({ path: logical, kind: 'directory' }); await visit(logical) }
      else if (info.isFile()) entries.push({ path: logical, kind: 'file', ...await fileHash(absolute, signal) })
      else throw new Error('Record copy does not copy special files: ' + absolute)
    }
    if (!same(before, identity(await ordinaryDirectory(directory))) || JSON.stringify(names) !== JSON.stringify((await readdir(directory)).sort()))
      throw new Error('Record directory changed during the explicit copy: ' + directory)
  }
  await visit('')
  return entries
}
// Recovery only: a changed source may contain new configuration not yet copied.
// Accept its new snapshot only when every retained byte still matches it.
async function verifyRetainedPrefix(source: string, destination: string, state: RecordTreeCopyState,
  entries: Entry[], signal?: AbortSignal): Promise<void> {
  const expected = new Map(entries.map(entry => [entry.path, entry]))
  const actual = await manifest(destination, signal), actualPaths = new Set(actual.map(entry => entry.path))
  if (!state.owned[''] || !same(state.owned[''], identity(await ordinaryDirectory(destination))))
    throw new Error('The retained record destination was replaced: ' + destination)
  for (const entry of actual) {
    const original = expected.get(entry.path), target = join(destination, entry.path), owner = state.owned[entry.path]
    if (!original || original.kind !== entry.kind) throw new Error('Retained destination conflicts with the current source: ' + target)
    if (entry.kind === 'directory') {
      const info = await ordinaryDirectory(target)
      if (owner ? !same(owner, identity(info)) : (await readdir(target)).length !== 0)
        throw new Error('Unrecognized retained directory contents: ' + target)
      continue
    }
    const info = await lstat(target, { bigint: true })
    if (!owner || !same(owner, identity(info)) || entry.bytes! > original.bytes!)
      throw new Error('Unrecognized or changed retained file: ' + target)
    const input = await open(join(source, entry.path), constants.O_RDONLY | flags)
    try {
      const before = await input.stat({ bigint: true }), buffer = Buffer.allocUnsafe(windowSize), hash = createHash('sha256')
      let read = 0
      while (read < entry.bytes!) {
        signal?.throwIfAborted()
        const next = await input.read(buffer, 0, Math.min(buffer.length, entry.bytes! - read), read)
        if (!next.bytesRead) throw new Error('Current source no longer contains retained prefix: ' + target)
        hash.update(buffer.subarray(0, next.bytesRead)); read += next.bytesRead
      }
      await unchanged(join(source, entry.path), input, before)
      if (hash.digest('hex') !== entry.sha256) throw new Error('Retained output differs from the current source: ' + target)
    } finally { await input.close() }
  }
  for (const logical of Object.keys(state.owned)) {
    if (!logical) continue
    if (!actualPaths.has(logical)) throw new Error('A retained copied path is missing: ' + join(destination, logical))
  }
}
const digest = (entries: Entry[]) => createHash('sha256').update(JSON.stringify(entries)).digest('hex')
/** Content and directory names, including empty directories and user-added
 * files. This is an explicit move check, never an ordinary Local read gate. */
export async function recordTreeFingerprint(directory: string, signal?: AbortSignal): Promise<string> {
  return digest(await manifest(await canonicalLocalLocation(directory), signal))
}

/** A selected, inactive destination is populated with exclusive file creation.
 * Cold continuation checks its saved physical identities and exact source
 * prefixes before APPENDING an incomplete file. It never truncates/replaces an
 * existing file, removes an original, follows a link, or merges unknown files.
 * A retained move may resume an empty directory left between creation and
 * identity persistence, under its unchanged owned parent. Unknown files stay intact.
 * Portable Node path operations are not a cross-process filesystem transaction.
 */
export async function copyRecordTree(sourceDirectory: string, destinationDirectory: string,
  prior: RecordTreeCopyState | undefined, save: (state: RecordTreeCopyState) => Promise<void>,
  signal?: AbortSignal, expectedFingerprint?: string): Promise<RecordTreeCopyState> {
  signal?.throwIfAborted()
  const source = await canonicalLocalLocation(sourceDirectory), destination = await canonicalLocalLocation(destinationDirectory)
  if (nested(source, destination) || nested(destination, source)) throw new Error('Record copy locations must be distinct, non-overlapping directories.')
  const entries = await manifest(source, signal), fingerprint = digest(entries)
  if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint)
    throw new Error('Record source changed after its copy was prepared; no destination was created.')
  const state: RecordTreeCopyState = prior ? structuredClone(prior) : { version: 1, source, destination, fingerprint, owned: {} }
  if (state.version !== 1 || state.source !== source || state.destination !== destination)
    throw new Error('The retained record copy no longer matches its original source, destination or contents.')
  if (prior && state.fingerprint !== fingerprint) {
    await verifyRetainedPrefix(source, destination, state, entries, signal)
    // Freeze the current source only after all existing destination content
    // has been checked; ordinary copies do not perform this recovery pass.
    if (await recordTreeFingerprint(source, signal) !== fingerprint) throw new Error('Record source changed during recovery.')
    state.fingerprint = fingerprint
    await save(structuredClone(state))
  }
  if (!prior) await save(structuredClone(state))
  // Parents are routing containers only. An existing destination itself is
  // never adopted, including an empty directory or identical-looking tree.
  await mkdir(dirname(destination), { recursive: true })
  if (await canonicalLocalLocation(dirname(destination)) !== dirname(destination)) throw new Error('Record destination parent changed.')
  const ownDirectory = async (logical: string) => {
    const path = logical ? join(destination, logical) : destination
    const owner = Object.hasOwn(state.owned, logical) ? state.owned[logical] : undefined
    if (owner) {
      if (!same(owner, identity(await ordinaryDirectory(path)))) throw new Error('The retained record destination was replaced: ' + path)
    } else {
      try { await mkdir(path) }
      catch (error) {
        // Only a retained move can leave this creation/persistence gap. Its
        // owned parent and an empty ordinary directory permit continuation;
        // never adopt files, populated directories, or a different parent.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !prior || !logical) throw error
        const parentKey = logical.includes('/') ? logical.slice(0, logical.lastIndexOf('/')) : ''
        const parentOwner = state.owned[parentKey]
        if (!parentOwner || !same(parentOwner, identity(await ordinaryDirectory(dirname(path))))) throw error
        await ordinaryDirectory(path)
        if ((await readdir(path)).length) throw error
      }
      Object.defineProperty(state.owned, logical, { value: identity(await ordinaryDirectory(path)), enumerable: true, writable: true, configurable: true }); await save(structuredClone(state))
    }
  }
  await ownDirectory('')
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (entry.kind === 'directory') { await ownDirectory(entry.path); continue }
    const target = join(destination, entry.path), original = join(source, entry.path)
    await ordinaryDirectory(dirname(target)); await ordinaryDirectory(dirname(original))
    const owner = Object.hasOwn(state.owned, entry.path) ? state.owned[entry.path] : undefined
    let output: FileHandle | undefined, input: FileHandle | undefined
    try {
      output = await open(target, constants.O_RDWR | flags | (owner ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
      const out = await output.stat({ bigint: true }), named = await lstat(target, { bigint: true })
      if (!out.isFile() || named.isSymbolicLink() || !same(identity(out), identity(named)) || owner && !same(owner, identity(out)))
        throw new Error('The retained record output was replaced: ' + target)
      if (!owner) { Object.defineProperty(state.owned, entry.path, { value: identity(out), enumerable: true, writable: true, configurable: true }); await save(structuredClone(state)) }
      const existing = Number(out.size)
      if (existing > entry.bytes!) throw new Error('The retained record output has additional content: ' + target)
      input = await open(original, constants.O_RDONLY | flags)
      const before = await input.stat({ bigint: true })
      if (!before.isFile()) throw new Error('Record source is not an ordinary file: ' + original)
      const buffer = Buffer.allocUnsafe(windowSize), compared = Buffer.allocUnsafe(windowSize), hash = createHash('sha256')
      let position = 0
      while (position < entry.bytes!) {
        signal?.throwIfAborted()
        const r = await input.read(buffer, 0, Math.min(buffer.length, entry.bytes! - position), position)
        if (!r.bytesRead) break
        hash.update(buffer.subarray(0, r.bytesRead))
        const prefix = Math.max(0, Math.min(r.bytesRead, existing - position))
        for (let read = 0; read < prefix;) {
          const next = await output.read(compared, read, prefix - read, position + read)
          if (!next.bytesRead) throw new Error('Retained record prefix disappeared: ' + target)
          read += next.bytesRead
        }
        if (!buffer.subarray(0, prefix).equals(compared.subarray(0, prefix))) throw new Error('Retained record output was edited; both copies are preserved: ' + target)
        for (let written = prefix; written < r.bytesRead;) {
          const next = await output.write(buffer, written, r.bytesRead - written, position + written)
          if (!next.bytesWritten) throw new Error('Record copy write made no progress.')
          written += next.bytesWritten
        }
        position += r.bytesRead
      }
      await unchanged(original, input, before)
      if (position !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error('Record source changed after its copy was accepted: ' + original)
      await output.sync()
    } finally { try { await input?.close() } finally { await output?.close() } }
  }
  if (await recordTreeFingerprint(source, signal) !== fingerprint || await recordTreeFingerprint(destination, signal) !== fingerprint)
    throw new Error('Record copy verification failed; both locations are preserved.')
  return state
}

/** One explicit move's old copy, after its target has been verified and reopened.
 * Use the existing copy inventory. Changed sources are left for the user; never
 * recursively delete a parent, chase a link, or create a background cleanup. */
export async function retireRecordTreeSource(copy: RecordTreeCopyState): Promise<void> {
  if (await canonicalLocalLocation(copy.source) !== copy.source || await canonicalLocalLocation(copy.destination) !== copy.destination
    || nested(copy.source, copy.destination) || nested(copy.destination, copy.source)) throw new Error('Moved copy locations changed; source retained.')
  let sourceRoot: BigIntStats
  try { sourceRoot = await ordinaryDirectory(copy.source) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const owner = copy.owned['']
  if (!owner || !same(owner, identity(await ordinaryDirectory(copy.destination)))) throw new Error('Moved destination ownership changed; source retained.')
  const observed = new Map<string, BigIntStats>(), entries = await manifest(copy.source, undefined, observed)
  if (digest(entries) !== copy.fingerprint || entries.some(entry => !Object.hasOwn(copy.owned, entry.path)))
    throw new Error('Old copy changed since it was copied; remaining source retained.')
  // Children first; rmdir never removes files added after the accepted copy.
  for (const entry of [...entries].reverse()) {
    const original = join(copy.source, entry.path), before = observed.get(entry.path)!, current = await lstat(original, { bigint: true })
    await ordinaryDirectory(dirname(original))
    if (entry.kind === 'directory') {
      if (!current.isDirectory() || !same(identity(current), identity(before))) throw new Error('Old directory changed; remaining source retained: ' + original)
      await rmdir(original)
    } else {
      if (!current.isFile() || version(current) !== version(before)) throw new Error('Old file changed; remaining source retained: ' + original)
      await unlink(original)
    }
  }
  if (!same(identity(sourceRoot), identity(await ordinaryDirectory(copy.source)))) throw new Error('Old root changed; source retained.')
  await rmdir(copy.source)
}
