import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { inspectLocalStartupUpgrade } from './local-startup-upgrade.js'
import type { LocalUpgradeCompleted } from './local-upgrade-completion.js'
import { localUpgradeResultKey } from './local-upgrade-mapping.js'

/** Distinguish a previously selected SQL location from a fresh physical root.
 * This is exact acquisition evidence, not a layout/version check or a claim
 * that the one-time AI has finished. Known physical roots never consult SQL. */
export async function identifyLocalPhysicalBackend(directory: string, storage: StoragePort,
  previous: { localBackend?: 'physical' } | undefined, signal?: AbortSignal): Promise<boolean> {
  if (previous?.localBackend === 'physical') return true
  const upgrade = await inspectLocalStartupUpgrade(directory, storage, { signal })
  if (upgrade.status === 'complete') {
    const completed = await storage.get<LocalUpgradeCompleted>(localUpgradeResultKey(directory))
    if (completed?.kind === 'dss-local-upgrade-result' && completed.directory === directory
      && completed.operationId && completed.report?.status === 'complete') return true
  }
  // A real interrupted source operation owns its own continuation. Opening its
  // already published files is not permission to mark that conversion complete.
  if (upgrade.operationId) return false
  if (!previous) return upgrade.status === 'not-needed'
  try {
    await lstat(join(directory, 'dss-files.sqlite'))
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error('The previously selected Local SQL source is missing and this location has no recorded physical conversion. Its settings and remaining files were retained; no replacement store was created.')
  }
}
