import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
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
    for (;;) {
      signal?.throwIfAborted()
      const r = await handle.read(buffer, 0, buffer.length, bytes)
      if (!r.bytesRead) break
      hash.update(buffer.subarray(0, r.bytesRead)); bytes += r.bytesRead
    }
    await unchanged(path, handle, before)
    return { bytes, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}
async function manifest(root: string, signal?: AbortSignal): Promise<Entry[]> {
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
 * A process stop between exclusive create and saving its identity is explicitly
 * unconfirmed: preserve that path for inspection, rather than guess ownership.
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
  if (state.version !== 1 || state.source !== source || state.destination !== destination || state.fingerprint !== fingerprint)
    throw new Error('The retained record copy no longer matches its original source, destination or contents.')
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
      await mkdir(path) // EEXIST preserves any pre-existing directory or file.
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
      for (;;) {
        signal?.throwIfAborted()
        const r = await input.read(buffer, 0, buffer.length, position)
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
