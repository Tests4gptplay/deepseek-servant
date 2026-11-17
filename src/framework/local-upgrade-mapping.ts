import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type { LegacySqliteFile } from './legacy-sqlite-reader.js'
import { localRecordPath } from './local-record-files.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
/** Evidence of one completed source conversion. Used only by the one-time
 * exporter so that it cannot replay SQL over an already independent scope.
 * Never read by normal file operations; target edits/deletions are not versions. */
export interface LocalUpgradeMapping {
  kind: 'dss-once-source-mapping'
  directory: string
  sourcePath: string
  sourceHash: string
  sourceBytes: number
  operationId: string
  disposition: 'converted' | 'physical-original-retained'
  targets: string[]
}
export const localSkillUpgradeKey = (directory: string, sourcePath: string) => 'framework-upgrade-skill/' + hash(directory + '\0' + sourcePath)
export const localUpgradeResultKey = (directory: string) => 'framework-local-upgrade-result/' + hash(directory)
export const localUpgradeMappingKey = (directory: string, path: string) => 'framework-upgrade-source/' + hash(directory + '\0' + path)
export async function rememberLocalUpgradeMapping(storage: StoragePort, directory: string, source: Pick<LegacySqliteFile, 'path' | 'bytes'>,
  operationId: string, targets: string[], disposition: LocalUpgradeMapping['disposition'] = 'converted'): Promise<void> {
  const value: LocalUpgradeMapping = { kind: 'dss-once-source-mapping', directory, sourcePath: localRecordPath(source.path),
    sourceHash: hash(source.bytes), sourceBytes: source.bytes.byteLength, operationId, disposition, targets: targets.map(path => localRecordPath(path)) }
  const key = localUpgradeMappingKey(directory, source.path), previous = await storage.get<LocalUpgradeMapping>(key)
  if (previous && (previous.sourceHash !== value.sourceHash || previous.sourceBytes !== value.sourceBytes || previous.sourcePath !== value.sourcePath || previous.directory !== directory))
    throw new Error('The original source changed after its recorded conversion; both source and physical files were retained.')
  await storage.set(key, value)
}
export async function inspectLocalUpgradeMapping(storage: StoragePort, directory: string, source: Pick<LegacySqliteFile, 'path' | 'bytes'>): Promise<'absent' | 'mapped' | 'source-changed'> {
  const value = await storage.get<LocalUpgradeMapping>(localUpgradeMappingKey(directory, source.path))
  if (!value) return 'absent'
  if (value.kind !== 'dss-once-source-mapping' || value.directory !== directory || value.sourcePath !== source.path || !value.operationId
    || !['converted', 'physical-original-retained'].includes(value.disposition) || !Array.isArray(value.targets) || !value.targets.length)
    throw new Error('The exact source conversion record is invalid; it was retained.')
  return value.sourceHash === hash(source.bytes) && value.sourceBytes === source.bytes.byteLength ? 'mapped' : 'source-changed'
}

/** Only an addressed old UI selection uses this existing conversion mapping;
 * ordinary native paths do not read it or create another redirect index. */
export async function convertedLocalSkillPath(directory: string, sourcePath: string, storage: StoragePort): Promise<string | undefined> {
  if (!/^skills\/(?:[^/]+\/)+(?:record|legacy-git)\.json$/.test(sourcePath)) return
  const mapped = await storage.get<LocalUpgradeMapping>(localUpgradeMappingKey(directory, sourcePath))
  const target = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) + 'SKILL.md'
  return mapped?.kind === 'dss-once-source-mapping' && mapped.directory === directory && mapped.sourcePath === sourcePath
    && mapped.disposition === 'converted' && mapped.targets.includes(target) ? target : undefined
}
