import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { inspectLocalStartupUpgrade, readLegacyLocalOriginal } from './local-startup-upgrade.js'
import { foregroundGuidePath } from './foreground-prompt.js'
import { frameworkSkillIndexPath } from './skills.js'

/** Only these two existing Host defaults can race their old source originals.
 * This is a one-time source ownership query, not a Task/role admission check.
 * The AI still owns conversion; ordinary reads do not copy or modify SQL. */
export async function pendingLocalInitializationOriginal(directory: string, storage: StoragePort,
  path: string, signal?: AbortSignal): Promise<boolean> {
  if (path !== foregroundGuidePath && path !== frameworkSkillIndexPath) return false
  const root = await canonicalLocalLocation(directory, true)
  const status = await inspectLocalStartupUpgrade(root, storage, { signal })
  if (status.status !== 'incomplete') return false
  try { await lstat(join(root, 'dss-files.sqlite')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  // Even a published original remains the exporter's source until its existing
  // mechanical publication completes. Template rewriting must not precede it.
  return await readLegacyLocalOriginal(root, path, { signal }) !== undefined
}
