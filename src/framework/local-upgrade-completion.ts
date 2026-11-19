import type { StoragePort } from '../contracts/ports.js'
import type { LocalStartupUpgradeReport } from './local-startup-upgrade.js'
import { localUpgradeResultKey } from './local-upgrade-mapping.js'

/** Historical completed marker; only read for backend selection and to avoid
 * surfacing originals already superseded by a verified conversion. */
export interface LocalUpgradeCompleted {
  kind: 'dss-local-upgrade-result'
  directory: string
  operationId: string
  completedAt: string
  report: LocalStartupUpgradeReport
}

export { localUpgradeResultKey } from './local-upgrade-mapping.js'
export async function readLocalUpgradeCompleted(directory: string, storage: StoragePort): Promise<LocalUpgradeCompleted | undefined> {
  const value = await storage.get<LocalUpgradeCompleted>(localUpgradeResultKey(directory))
  if (value && (value.kind !== 'dss-local-upgrade-result' || value.directory !== directory || !value.operationId || value.report?.status !== 'complete'))
    throw new Error('The one-time upgrade result is invalid; it was retained.')
  return value
}
