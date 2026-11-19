import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { parseInstancePath, type Heartbeat, type OriginalInstanceRegistration } from './instances.js'
import { canonicalLocalLocation } from './local-location.js'
import { withLegacySqliteSnapshot } from './legacy-sqlite-reader.js'
import { inspectLocalStartupUpgrade } from './local-startup-upgrade.js'

/** Read only the roster already used by registration. This temporary source
 * view is used for the initial registration, never for heartbeat ticks. */
export async function readOriginalLocalInstances(directory: string, storage: StoragePort,
  instanceUUID: string, signal?: AbortSignal, onIssue?: (error: Error) => void): Promise<OriginalInstanceRegistration[]> {
  const root = await canonicalLocalLocation(directory, true)
  if ((await inspectLocalStartupUpgrade(root, storage, { signal })).status !== 'incomplete') return []
  try { await lstat(join(root, 'dss-files.sqlite')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  return withLegacySqliteSnapshot(join(root, 'dss-files.sqlite'), async source => {
    const originals: OriginalInstanceRegistration[] = []
    for await (const entry of source.entries('instances/')) {
      if (entry.kind !== 'file') continue
      const registration = parseInstancePath(entry.path)
      if (!registration) continue
      let heartbeat: Heartbeat | undefined
      if (registration.instanceUUID === instanceUUID) {
        try {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)) as Heartbeat
          if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isFinite(Date.parse(value.updatedAt))
            || !['running', 'stopped'].includes(value.status)) throw new Error('Invalid original heartbeat fields.')
          heartbeat = value
        } catch (cause) {
          // Its path still identifies this exact UUID/alias. Do not infer an old
          // liveness sequence from damaged content or stop unrelated startup.
          // Registration retains its already saved sequence (if any); SQL bytes
          // remain untouched and the actual source issue is reported separately.
          onIssue?.(new Error('The original heartbeat is invalid: ' + entry.path + '. Its SQL source was retained; no old liveness was inferred.', { cause }))
        }
      }
      originals.push({ registration, ...(heartbeat ? { heartbeat } : {}) })
    }
    return originals
  }, { signal })
}
