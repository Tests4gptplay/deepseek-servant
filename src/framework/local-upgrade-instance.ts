import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { parseInstancePath, type Heartbeat, type RegisteredInstance, type OriginalInstanceRegistration } from './instances.js'
import { canonicalLocalLocation } from './local-location.js'
import { withLegacySqliteSnapshot, type LegacySqliteFile } from './legacy-sqlite-reader.js'
import { rememberLocalUpgradeMapping } from './local-upgrade-mapping.js'
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
export interface CurrentLocalUpgradeInstance {
  /** Host's real technical UUID, not a name guessed from a source file. */
  instanceUUID: string
  /** Returned only after this Host's actual registration publication succeeded. */
  registered?: RegisteredInstance
}
/** Called only inside the AI's materialize action. The current Host has already
 * replaced its own old heartbeat through normal registration; preserve that
 * historical SQL row as source evidence, not as an instruction to replay it. */
export async function mapReplacedLocalInstance(storage: StoragePort, directory: string,
  source: Pick<LegacySqliteFile, 'path' | 'bytes'>, operationId: string,
  current: CurrentLocalUpgradeInstance | undefined): Promise<'unrelated' | 'pending' | 'mapped'> {
  const original = parseInstancePath(source.path)
  if (!original || !current || original.instanceUUID !== current.instanceUUID) return 'unrelated'
  const registered = current.registered
  if (!registered) return 'pending'
  const target = parseInstancePath(registered.path)
  if (!target || target.instanceUUID !== current.instanceUUID || registered.instanceUUID !== current.instanceUUID
    || target.member !== registered.member || target.workerSeats !== registered.workerSeats)
    throw new Error('The successful Local registration does not identify this original instance.')
  await rememberLocalUpgradeMapping(storage, directory, source, operationId, [registered.path])
  return 'mapped'
}
