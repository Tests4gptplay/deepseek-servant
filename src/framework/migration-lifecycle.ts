import { createHash, randomUUID } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import { captureGitLegacy, captureLocalLegacy, prepareLegacyMigration, applyLegacyMigration,
  type LegacyCapture, type LegacyMigrationPlan, type MigrationOptions } from './legacy-migration.js'
import { GitFiles, type FilesStore, type FilesSnapshot } from './transactions.js'
import type { FrameworkTransactions } from './command-transactions.js'

type StoredPlan = Omit<LegacyMigrationPlan, 'changes'> & { changes: Array<{ path: string; content?: string | null; base64?: string }> }
interface Cutover {
  id: string
  expectedRevision: string
  sourceRevision: string
  options: Omit<MigrationOptions, 'artifacts'>
  artifacts?: Array<{ sourcePath: string; sha256: string }>
  localPlan?: StoredPlan
  manifestPath?: string
  verified?: boolean
  complete?: boolean
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** One cutover identity survives unknown writes. Git plans are reconstructed at
 * their original immutable commit; remote business bodies are never cached here. */
export async function migrateFrameworkStorage(input: {
  mode: 'local' | 'git'; scope: string; files: FilesStore; transactions: FrameworkTransactions;
  records: StoragePort; localSource?: StoragePort;
  options(capture: LegacyCapture, id: string): MigrationOptions | Promise<MigrationOptions>;
}): Promise<{ manifestPath?: string; verified: boolean; complete: boolean }> {
  const key = 'framework-cutovers/' + digest(input.scope)
  let saved = await input.records.get<Cutover>(key)
  if (saved?.verified) return { manifestPath: saved.manifestPath, verified: true, complete: !!saved.complete }
  let snapshot: FilesSnapshot
  if (saved && input.mode === 'git') {
    if (!(input.files instanceof GitFiles)) throw new Error('Git cutover requires immutable remote snapshot access.')
    snapshot = await input.files.at(saved.expectedRevision)
  } else snapshot = await input.files.snapshot()
  try {
    let plan: LegacyMigrationPlan
    if (saved?.localPlan) {
      plan = { ...saved.localPlan, changes: saved.localPlan.changes.map(change => change.base64 === undefined
        ? { path: change.path, content: change.content! } : { path: change.path, bytes: Uint8Array.from(Buffer.from(change.base64, 'base64')) }) }
    } else {
      const capture = input.mode === 'local' ? await captureLocalLegacy(input.localSource ?? input.records) : await captureGitLegacy(input.files, snapshot, input.files instanceof GitFiles ? { at: revision => (input.files as GitFiles).at(revision) } : undefined)
      if (!capture.records.length && !saved) {
        await input.records.set(key, { id: randomUUID(), expectedRevision: snapshot.revision, sourceRevision: capture.revision,
          options: { id: '', owner: '', members: {} }, verified: true, complete: true } satisfies Cutover)
        return { verified: true, complete: true }
      }
      if (saved && capture.revision !== saved.sourceRevision) throw new Error('Original migration source changed; preserve its pending operation rather than replacing the plan.')
      const id = saved?.id ?? randomUUID()
      const supplied = await input.options(capture, id)
      const options: MigrationOptions = saved ? { ...saved.options, artifacts: supplied.artifacts } : supplied
      const artifacts = options.artifacts?.map(artifact => ({ sourcePath: artifact.sourcePath, sha256: createHash('sha256').update(artifact.bytes).digest('hex') }))
      if (saved && JSON.stringify(saved.artifacts) !== JSON.stringify(artifacts)) throw new Error('Original migration artifact bytes are unavailable or changed; retain the same pending operation.')
      plan = await prepareLegacyMigration(capture, input.files, snapshot, options, input.transactions)
      if (!saved) {
        const { artifacts: _bytes, ...metadataOptions } = options
        saved = { id, expectedRevision: snapshot.revision, sourceRevision: capture.revision, options: metadataOptions, artifacts }
        if (input.mode === 'local') saved.localPlan = { ...plan, changes: plan.changes.map(change => change.bytes === undefined
          ? { path: change.path, content: change.content } : { path: change.path, base64: Buffer.from(change.bytes).toString('base64') }) }
        await input.records.set(key, saved)
      }
    }
    const result = await applyLegacyMigration(input.files, input.transactions, plan)
    await input.records.set(key, { ...saved!, localPlan: undefined, manifestPath: plan.manifestPath, verified: true, complete: result.complete })
    return { manifestPath: plan.manifestPath, verified: true, complete: result.complete }
  } finally { await snapshot.release() }
}
