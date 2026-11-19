import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

// An attempt-owned observer only, never an ambient read cache or authority.
// It records values already read at one immutable snapshot, not extra scans.
type ReadObserver = (key: string, fingerprint: string) => void
const observers = new WeakMap<object, { read: ReadObserver; rechecked?: (path: string) => void }>()
const rechecking = new AsyncLocalStorage<{ snapshot: object; key: string }>()
const observerAt = (snapshot: object): ReadObserver | undefined => {
  const observer = observers.get(snapshot)
  if (!observer) return
  return (key, fingerprint) => {
    const own = rechecking.getStore()
    if (own?.snapshot === snapshot && key === own.key) return
    observer.read(key, fingerprint)
  }
}
/** A caller-owned three-way validation replaces only its own current-target
 * read. Other reads of the same path remain assessed business inputs; native
 * Git dependencies are independent and are never suppressed here. */
export async function withReevaluatedFileTarget<T>(snapshot: object, path: string, action: () => Promise<T>): Promise<T> {
  const result = await rechecking.run({ snapshot, key: 'file:' + path }, action)
  observers.get(snapshot)?.rechecked?.(path)
  return result
}
/** Observe only the business values taken from this exact file. The raw
 * read still contributes its native dependency and remains an exact write
 * target if this same command also updates it. */
export async function withProjectedFileRead<T>(snapshot: object, path: string, read: () => Promise<T>, project: (value: T) => unknown, key = 'file:' + path): Promise<T> {
  return withProjectedRead(snapshot, 'file:' + path, read, project, key)
}
export async function withProjectedRead<T>(snapshot: object, key: string, read: () => Promise<T>,
  project: (value: T) => unknown, projectedKey = key): Promise<T> {
  const value = await rechecking.run({ snapshot, key }, read)
  observerAt(snapshot)?.(projectedKey, createHash('sha256').update(JSON.stringify(project(value))).digest('hex'))
  return value
}
export async function observeFileReads<T>(snapshot: object, observer: ReadObserver, action: () => Promise<T>, rechecked?: (path: string) => void): Promise<T> {
  if (observers.has(snapshot)) throw new Error('This snapshot already has an owned read observer.')
  observers.set(snapshot, { read: observer, rechecked })
  try { return await action() } finally { observers.delete(snapshot) }
}
export function fileReadFingerprint(snapshot: object, key: string, fingerprint: string): void { observerAt(snapshot)?.(key, fingerprint) }
export function observedFileBytes(snapshot: object, path: string, bytes: Uint8Array | undefined): void {
  const observer = observerAt(snapshot)
  if (observer) observer('file:' + path, bytes === undefined ? 'absent' : createHash('sha256').update(bytes).digest('hex'))
}
export function observedFileList(snapshot: object, kind: 'list' | 'directory', prefix: string,
  entries: readonly { path: string; version: string }[]): void {
  const observer = observerAt(snapshot)
  if (observer) observer(kind + ':' + prefix, createHash('sha256').update(JSON.stringify(entries.map(entry => [entry.path, entry.version]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0))).digest('hex'))
}

