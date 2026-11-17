import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { withLegacySqliteSnapshot } from './legacy-sqlite-reader.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { inspectLocalUpgradeMapping, localUpgradeMappingKey, type LocalUpgradeMapping } from './local-upgrade-mapping.js'
import { localStartupUpgradeKey, type LocalUpgradePublication } from './local-startup-upgrade.js'

export interface LocalSourceRetirementAudit {
  sourcePath: string
  sourceDisposition: 'retained-pending-retirement-review'
  copiedOrRepresentedExactly: number
  /** Byte-distinct does not decide whether it is valuable or obsolete. The
   * existing AI/user-approved retention scope, not a hash, must decide that. */
  onlyOriginalBytesInSql: Array<{ path: string; category: string; convertedTargets: string[] }>
  metadataKeys: string[]
  gitOperationIds: string[]
  otherTables: string[]
  issues: Array<{ path?: string; message: string }>
}
const category = (path: string): string => /^skills\/.*\/(?:record|legacy-git)\.json$/.test(path) ? 'old-skill-definition-and-versions'
  : path.startsWith('skills/') ? 'skill-definition-or-resource'
  : /^tasks\/[^/]+\.json$/.test(path) ? 'original-task-identity'
  : /^(?:task-runs|state|Recorder Cache|technical\/recovery-inputs)\//.test(path) ? 'original-runtime-or-signal'
  : /^conversation-(?:index|context)\//.test(path) || /^conversations\//.test(path) ? 'original-conversation-layout'
  : /^(?:roles|assistants)\//.test(path) ? 'custom-role-or-assistant-original' : 'unclassified-original'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** An explicit final verification inventory, not a delete, archive-directory
 * decision, recurring scan, normal-read version gate, or source SQL writer. */
export async function auditLocalUpgradeSource(directory: string, storage: StoragePort, signal?: AbortSignal): Promise<LocalSourceRetirementAudit> {
  const root = await canonicalLocalLocation(directory, true), sourcePath = join(root, 'dss-files.sqlite')
  const exported = await storage.get<LocalUpgradePublication & { kind: string; directory: string }>(localStartupUpgradeKey(root))
  const publications = new Map((exported?.kind === 'dss-local-sqlite-to-physical' && exported.directory === root ? exported.files : []).map(file => [file.path, file]))
  return withLegacySqliteSnapshot(sourcePath, async source => {
    const infrastructure = await source.infrastructure()
    const result: LocalSourceRetirementAudit = { sourcePath, sourceDisposition: 'retained-pending-retirement-review', copiedOrRepresentedExactly: 0,
      onlyOriginalBytesInSql: [], ...infrastructure, issues: [] }
    const files = new PhysicalLocalFiles(root), view = await files.snapshot()
    try {
      for await (const entry of source.entries()) {
        signal?.throwIfAborted()
        if (entry.kind === 'issue') { result.issues.push({ path: entry.issue.path, message: entry.issue.message }); continue }
        // Check the original against this operation's recorded source evidence,
        // never against the current user-editable physical file as a version
        // lock. A new/changed SQL row is unfinished conversion, whereas bytes
        // retained solely for source disposal are a separate obligation.
        try {
          const mapped = await inspectLocalUpgradeMapping(storage, root, entry)
          const file = publications.get(entry.path)
          const published = file && ['published', 'already-present'].includes(file.status)
            && file.bytes === entry.bytes.byteLength && file.sha256 === hash(entry.bytes)
          const explicitlyKept = file?.status === 'kept-current-unexported' && !!file.keptCurrent
            && file.bytes === entry.bytes.byteLength && file.sha256 === hash(entry.bytes)
          if (mapped === 'source-changed' || mapped !== 'mapped' && !published && !explicitlyKept)
            result.issues.push({ path: entry.path, message: 'This original SQL row has no matching verified conversion or exact-export evidence. Its new or changed source remains pending; current physical content was not replaced.' })
        } catch (error) { result.issues.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) }) }
        const mapping = await storage.get<LocalUpgradeMapping>(localUpgradeMappingKey(root, entry.path))
        const targets = mapping?.kind === 'dss-once-source-mapping' && mapping.directory === root && mapping.sourcePath === entry.path && Array.isArray(mapping.targets) ? mapping.targets : []
        let exact = false
        for (const path of new Set([entry.path, ...targets])) {
          try { const bytes = await files.readBytes(view, path); if (bytes !== undefined && hash(bytes) === hash(entry.bytes)) { exact = true; break } }
          catch (error) { signal?.throwIfAborted(); result.issues.push({ path, message: error instanceof Error ? error.message : String(error) }) }
        }
        if (exact) result.copiedOrRepresentedExactly++
        else result.onlyOriginalBytesInSql.push({ path: entry.path, category: category(entry.path), convertedTargets: targets })
      }
      return result
    } finally { await view.release(); await files.close() }
  }, { signal })
}
