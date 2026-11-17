import type { PhysicalLocalFiles } from './physical-local-files.js'

import { samePhysicalPublication } from './local-record-files.js'
export { samePhysicalPublication } from './local-record-files.js'

/** Publish the already prepared file. Only an interrupted rename needs a
 * targeted observation. An absent stage alone never proves publication, and
 * this function never recreates a possibly consumed signal. Existing accepted
 * wake/claim sources may prove its identity without a new acknowledgement. */
export async function publishPreparedPhysicalFile(files: PhysicalLocalFiles,
  stage: string, target: string, stagedVersion: string,
  acceptedSources?: () => Promise<readonly { path: string; version: string }[]>): Promise<void> {
  if (await files.rename(stage, target)) return
  const current = await files.fileInfo(target)
  if (current && samePhysicalPublication(stagedVersion, current.version)) return
  if (acceptedSources && (await acceptedSources()).some(source => source.path === target
    && samePhysicalPublication(stagedVersion, source.version))) return
  throw new Error('The prepared Local publication is unavailable and its result is not confirmed: ' + target)
}
