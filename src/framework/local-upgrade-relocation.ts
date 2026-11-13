import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { StoragePort } from '../contracts/ports.js'
import { withLegacySqliteSnapshot } from './legacy-sqlite-reader.js'
import { LocalRecordFiles, localRecordPath } from './local-record-files.js'
import type { RecordTreeCopyState } from './record-tree-copy.js'

type Row = Record<string, any>
interface Identity { dev: string; ino: string }
interface Proof extends Identity { path: string; version: string; bytes: number; sha256: string }
interface RelocationRow {
  sourceKey: string
  targetKey: string
  original: Row
  sourceProof?: string
  publications: Array<{ index: number; proof?: string }>
}
export interface LocalUpgradeRelocation {
  version: 1
  source: string
  destination: string
  kind: 'none' | 'complete' | 'pending'
  rows: RelocationRow[]
  proofs: Proof[]
  /** This exact accepted move freezes projected metadata before its first
   * write. A cold retry accepts only these same values, never a new adoption. */
  projected?: Array<{ key: string; value: Row }>
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const same = (a: Identity | undefined, b: Identity | undefined) => !!a && !!b && a.dev === b.dev && a.ino === b.ino
const kinds = {
  'dss-once-local-upgrade': 'framework-startup-upgrade-agent/',
  'dss-local-sqlite-to-physical': 'framework-physical-upgrade/',
  'dss-local-upgrade-result': 'framework-local-upgrade-result/',
  'dss-once-source-mapping': 'framework-upgrade-source/',
  'dss-once-task-layout': 'framework-upgrade-task/',
  'dss-once-conversation-full-text': 'framework-upgrade-conversation/',
  'dss-once-native-skill': 'framework-upgrade-skill/',
} as const
function key(kind: string, directory: string, value?: string): string {
  if (!Object.hasOwn(kinds, kind)) throw new Error('Unknown one-time upgrade record kind: ' + kind)
  return kinds[kind as keyof typeof kinds] + hash(directory + (value === undefined ? '' : '\0' + value))
}
function rowKey(directory: string, row: Row): string {
  const suffix = row.kind === 'dss-once-task-layout' ? row.taskId
    : row.kind === 'dss-once-conversation-full-text' ? row.collaborationId
      : ['dss-once-source-mapping', 'dss-once-native-skill'].includes(row.kind) ? row.sourcePath : undefined
  if (suffix !== undefined && (typeof suffix !== 'string' || !suffix)) throw new Error('Invalid addressed upgrade record identity.')
  if (['dss-once-source-mapping', 'dss-once-native-skill'].includes(row.kind)) localRecordPath(suffix)
  if (row.kind === 'dss-once-task-layout' && (typeof row.taskId !== 'string' || /[\/\\\0\r\n]/.test(row.taskId))) throw new Error('Invalid original Task upgrade identity.')
  if (row.kind === 'dss-once-conversation-full-text' && (typeof row.collaborationId !== 'string' || /[\/\\\0\r\n]/.test(row.collaborationId))) throw new Error('Invalid original conversation upgrade identity.')
  return key(row.kind, directory, suffix)
}
async function observe(directory: string, path: string, signal?: AbortSignal): Promise<Proof | undefined> {
  localRecordPath(path)
  const files = new LocalRecordFiles(directory), before = await files.fileInfo(path)
  if (!before) return undefined
  const info = await lstat(join(directory, ...path.split('/')), { bigint: true })
  const content = await files.fingerprint(path, signal), after = await files.fileInfo(path)
  if (!info.isFile() || info.isSymbolicLink() || !content || before.version !== after?.version)
    throw new Error('The addressed upgrade original changed while preparing relocation: ' + path)
  return { path, dev: String(info.dev), ino: String(info.ino), version: before.version, ...content }
}
const references = (row: Row): Array<{ key: string; kind: string; operationId: string }> =>
  [row.cleanup, row.retainedSourceMappings, row.assessment?.cleanup].flatMap(value => Array.isArray(value) ? value : [])

/** Called only after the selected Local producers and its one-time Agent are
 * drained, before freezing/copying this explicit move. No storage prefix scan,
 * SQL conversion, source deletion, or ordinary acquisition fallback occurs. */
export async function prepareLocalUpgradeRelocation(storage: StoragePort, source: string, destination: string,
  signal?: AbortSignal): Promise<LocalUpgradeRelocation> {
  const plan: LocalUpgradeRelocation = { version: 1, source, destination, kind: 'none', rows: [], proofs: [] }
  const read = async (sourceKey: string): Promise<Row | undefined> => {
    signal?.throwIfAborted()
    const found = plan.rows.find(row => row.sourceKey === sourceKey)
    if (found) return found.original
    const value = await storage.get<Row>(sourceKey)
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || value.directory !== source || !value.operationId || rowKey(source, value) !== sourceKey)
      throw new Error('The addressed one-time upgrade record does not belong to the move source: ' + sourceKey)
    plan.rows.push({ sourceKey, targetKey: rowKey(destination, value), original: structuredClone(value), publications: [] })
    return value
  }
  const completed = await read(key('dss-local-upgrade-result', source))
  const wake = await read(key('dss-once-local-upgrade', source))
  const mechanical = await read(key('dss-local-sqlite-to-physical', source))
  if (completed && completed.report?.status !== 'complete') throw new Error('The retained upgrade result does not confirm complete conversion.')
  plan.kind = completed ? 'complete' : wake || mechanical ? 'pending' : 'none'
  // Complete results name their exact cleanup/mapping records. A missing
  // already-retired record stays missing; do not rediscover it by scanning SQL.
  for (let at = 0; at < plan.rows.length; at++) for (const ref of references(plan.rows[at]!.original)) {
    if (!ref || typeof ref.key !== 'string') throw new Error('Invalid exact upgrade cleanup reference.')
    const row = await read(ref.key)
    if (row && (row.kind !== ref.kind || row.operationId !== ref.operationId)) throw new Error('Upgrade cleanup reference changed ownership: ' + ref.key)
  }
  const address = async (path: string) => {
    localRecordPath(path)
    await read(key('dss-once-source-mapping', source, path))
    const task = /^tasks\/([^/]+)\.json$/.exec(path)
    if (task) await read(key('dss-once-task-layout', source, task[1]!))
    const conversation = /^conversation-index\/local\/([^/]+)\/index\.json$/.exec(path)
    if (conversation) {
      let scope: string | undefined
      try { scope = decodeURIComponent(conversation[1]!) } catch { /* No guessed scope. */ }
      if (scope && !/[\/\\\0\r\n]/.test(scope)) await read(key('dss-once-conversation-full-text', source, scope))
    }
    if (/^skills\/(?:[^/]+\/)+(?:SKILL\.md|record\.json|legacy-git\.json)$/.test(path))
      await read(key('dss-once-native-skill', source, path))
  }
  if (!completed) {
    const files = new LocalRecordFiles(source), sql = await files.fileInfo('dss-files.sqlite')
    if (sql) {
      plan.kind = 'pending'
      // Only the selected retained source, and only path columns. Close its
      // WAL reader before the record move freezes the physical tree digest.
      await withLegacySqliteSnapshot(join(source, 'dss-files.sqlite'), async snapshot => {
        for await (const entry of snapshot.paths()) {
          signal?.throwIfAborted()
          if (entry.kind === 'issue') continue // Its unaddressable original stays in SQL.
          await address(entry.path)
        }
      }, { signal })
    } else if (wake || mechanical) {
      throw new Error('The accepted pending upgrade source is missing; retain its original responsibility before relocating this Local root.')
    }
  }
  // Existing publication and audit references remain meaningful even when
  // an original row was removed from SQL after that responsibility began.
  // These exact paths close their own references, never a technical prefix scan.
  for (let at = 0; at < plan.rows.length; at++) {
    const row = plan.rows[at]!.original
    for (const ref of references(row)) {
      const linked = await read(ref.key)
      if (linked && (linked.kind !== ref.kind || linked.operationId !== ref.operationId)) throw new Error('Upgrade cleanup reference changed ownership: ' + ref.key)
    }
    for (const file of Array.isArray(row.files) ? row.files : []) await address(file.path)
    for (const original of row.sourceAudit?.onlyOriginalBytesInSql ?? []) await address(original.path)
  }
  const proof = async (path: string): Promise<Proof | undefined> => {
    const prior = plan.proofs.find(item => item.path === path)
    if (prior) return prior
    const value = await observe(source, path, signal)
    if (value) plan.proofs.push(value)
    return value
  }
  for (const row of plan.rows) {
    const value = row.original
    if (value.kind === 'dss-local-sqlite-to-physical' && value.source) {
      const actual = await proof('dss-files.sqlite')
      if (actual && same(actual, value.source)) row.sourceProof = actual.path
      else if (plan.kind === 'pending') throw new Error('The pending upgrade SQL inode no longer matches its original source; relocation did not adopt the replacement.')
      // Complete historical evidence is not a new assertion that absent or
      // replaced SQL belongs to that old extraction. Preserve that evidence.
    }
    if (value.files !== undefined && !Array.isArray(value.files)) throw new Error('Invalid original upgrade publications.')
    for (const [index, file] of (value.files ?? []).entries()) {
      if (!file?.owned) continue
      localRecordPath(file.path)
      const staged = file.stagePath ? await proof(localRecordPath(file.stagePath)) : undefined
      const final = !same(staged, file.owned) ? await proof(file.path) : undefined
      const confirmed = same(staged, file.owned) ? staged : same(final, file.owned) ? final : undefined
      row.publications.push({ index, ...(confirmed ? { proof: confirmed.path } : {}) })
    }
  }
  return plan
}

function relocateReports(value: Row, plan: LocalUpgradeRelocation, keys: Map<string, string>): void {
  const report = (row: any) => {
    if (!row || typeof row !== 'object') return
    if (row.directory === plan.source) row.directory = plan.destination
    if (row.sourcePath === join(plan.source, 'dss-files.sqlite')) row.sourcePath = join(plan.destination, 'dss-files.sqlite')
  }
  value.directory = plan.destination
  report(value.report); report(value.result); report(value.assessment?.report); report(value.sourceAudit)
  for (const ref of references(value)) if (keys.has(ref.key)) ref.key = keys.get(ref.key)!
}

/** Prove exact copied files before translating inode-bearing recovery metadata.
 * The caller has verified the full Local tree and supplies this same command's
 * exclusive copier ownership, not a destination guessed from matching bytes. */
export async function projectLocalUpgradeRelocation(plan: LocalUpgradeRelocation, copy: RecordTreeCopyState | undefined,
  signal?: AbortSignal): Promise<Array<{ key: string; value: Row }>> {
  const translated = new Map<string, Identity>()
  if (plan.proofs.length) {
    if (!copy) throw new Error('This move has no confirmed physical copy identities for its upgrade recovery files.')
    const prefix = relative(copy.source, plan.source).split(sep).join('/')
    if (prefix.startsWith('../') || prefix === '..' || join(copy.source, prefix) !== plan.source || join(copy.destination, prefix) !== plan.destination)
      throw new Error('Upgrade recovery evidence is not inside this accepted record copy.')
    for (const expected of plan.proofs) {
      signal?.throwIfAborted()
      const original = await observe(plan.source, expected.path, signal)
      if (!original || !isDeepStrictEqual(original, expected)) throw new Error('An upgrade original changed after relocation preparation: ' + expected.path)
      const target = await observe(plan.destination, expected.path, signal), path = prefix ? prefix + '/' + expected.path : expected.path
      const owner = Object.hasOwn(copy.owned, path) ? copy.owned[path] : undefined
      if (!target || !same(owner, target) || target.bytes !== expected.bytes || target.sha256 !== expected.sha256)
        throw new Error('The upgrade recovery target is not the confirmed copied original: ' + expected.path)
      translated.set(expected.path, { dev: target.dev, ino: target.ino })
    }
  }
  const keys = new Map(plan.rows.map(row => [row.sourceKey, row.targetKey]))
  return plan.rows.map(row => {
    const value = structuredClone(row.original)
    relocateReports(value, plan, keys)
    if (row.sourceProof) value.source = translated.get(row.sourceProof)!
    for (const publication of row.publications) {
      const file = value.files[publication.index]
      if (publication.proof) file.owned = translated.get(publication.proof)!
      else {
        // A missing/replaced old inode is NOT ownership of a new inode. Keep
        // ready/stagePath and all bytes. The existing publisher retains an
        // unconfirmed stage or reports a missing ready publication; it cannot
        // use the obsolete numeric identity to write a coincidental new inode.
        delete file.owned
        if (file.status === 'owned') file.status = 'prepared'
      }
    }
    return { key: row.targetKey, value }
  })
}

/** Metadata writes only. Old keys and physical originals remain retained.
 * Persist projected in the move receipt before calling this function. */
export async function applyLocalUpgradeRelocation(storage: StoragePort, plan: LocalUpgradeRelocation,
  signal?: AbortSignal): Promise<void> {
  if (!plan.projected) throw new Error('Upgrade relocation has no frozen target values.')
  for (const row of plan.rows) {
    signal?.throwIfAborted()
    if (!isDeepStrictEqual(await storage.get(row.sourceKey), row.original)) throw new Error('The original upgrade responsibility changed during relocation: ' + row.sourceKey)
  }
  // Preflight every exact key before the first write. No unrelated record is
  // inspected. An interruption can replay only these same frozen values.
  for (const row of plan.projected) {
    const current = await storage.get(row.key)
    if (current !== undefined && !isDeepStrictEqual(current, row.value)) throw new Error('Upgrade relocation target already has different state: ' + row.key)
  }
  for (const row of plan.projected) {
    signal?.throwIfAborted()
    if (await storage.get(row.key) === undefined) await storage.set(row.key, row.value)
    if (!isDeepStrictEqual(await storage.get(row.key), row.value)) throw new Error('Upgrade relocation write is not confirmed: ' + row.key)
  }
}
