import { createHash } from 'node:crypto'
import type { ArtifactReference } from './artifacts.js'
import type { LocalCaptureSource, LocalRecordFingerprint } from './local-record-files.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { paths, readJson, encodeJson } from './task-files.js'
import { withSnapshot, type FilesSnapshot } from './transactions.js'

interface ArtifactPublication {
  version: 1
  commandId: string
  requestHash: string
  taskId: string
  lifecycleId: string
  artifact?: ArtifactReference
  attempting?: true
  bytesPublished?: true
  published?: true
}
export interface PhysicalArtifactInput {
  commandId: string; requestHash: string; taskId: string
  destination: string; manifestPath: string; name: string
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const root = (taskId: string, commandId: string): string => paths.run(taskId) + '/.artifacts/' + hash(commandId)
const lanes = new Map<string, Promise<unknown>>()
async function inLane<T>(key: string, action: () => Promise<T>): Promise<T> {
  const pending = (lanes.get(key)?.catch(() => {}) ?? Promise.resolve()).then(action)
  lanes.set(key, pending)
  try { return await pending } finally { if (lanes.get(key) === pending) lanes.delete(key) }
}
async function cleanupCapture(files: PhysicalLocalFiles, work: string): Promise<void> {
  // Both callers have confirmed publication. The exact command-owned capture
  // is no longer the archive original or an unfinished retry input.
  const stage = work + '/original.raw'
  await files.delete(stage)
  await files.delete(stage + '.capture.json')
}
/** Native source bytes are staged once through the authorized capability. Only
 * this command and actual destination coordinate; no Task/store writer lock.
 * A tiny phase fact survives until the original native success result is durable.
 * It is not a new acknowledgement, background retry or permanent command log. */
export async function preservePhysicalArtifact(files: PhysicalLocalFiles, input: PhysicalArtifactInput,
  openSource: () => Promise<LocalCaptureSource>, validate: (snapshot: FilesSnapshot) => Promise<string>,
  beforeAttempt: () => void | Promise<void>, signal?: AbortSignal): Promise<ArtifactReference> {
  const work = root(input.taskId, input.commandId), factPath = work + '/publication.json', stage = work + '/original.raw'
  const keys = [factPath, input.destination].sort().map(path => files.directory + '\0artifact:' + path)
  return inLane(keys[0]!, () => inLane(keys[1]!, () => withSnapshot(files, async snapshot => {
    signal?.throwIfAborted(); await beforeAttempt(); const lifecycleId = await validate(snapshot)
    let fact = await readJson<ArtifactPublication>(files, snapshot, factPath)
    if (fact && (fact.version !== 1 || fact.commandId !== input.commandId || fact.requestHash !== input.requestHash || fact.taskId !== input.taskId || fact.lifecycleId !== lifecycleId))
      throw new Error('Artifact command arguments changed; its original pending capture was preserved.')
    if (fact?.artifact && (fact.artifact.path !== input.destination || fact.artifact.manifestPath !== input.manifestPath
      || fact.artifact.name !== input.name || !Number.isSafeInteger(fact.artifact.bytes) || fact.artifact.bytes < 0
      || !/^[a-f0-9]{64}$/.test(fact.artifact.sha256)))
      throw new Error('Accepted artifact result identity changed; original files were preserved.')
    if (fact?.published && !fact.artifact) throw new Error('Completed artifact result is missing; original files were preserved.')
    const persist = () => files.replace(factPath, encodeJson(fact))
    const retireCapture = async () => {
      // Completed publication no longer needs raw staging. Never recreate it
      // or read the source merely because an earlier cleanup was interrupted.
      await cleanupCapture(files, work)
    }
    if (fact?.published) { await retireCapture(); return fact.artifact! }
    if (!fact) {
      fact = { version: 1, commandId: input.commandId, requestHash: input.requestHash, taskId: input.taskId, lifecycleId }
      await persist()
    }
    let captured: LocalRecordFingerprint | undefined
    if (!fact.artifact) {
      captured = await files.stageRead('native-artifact:' + input.requestHash, stage, openSource, signal)
      if (!captured) throw new Error('Artifact source is missing.')
      fact.artifact = { path: input.destination, manifestPath: input.manifestPath, name: input.name, ...captured }
      await persist()
    }
    const artifact = fact.artifact
    if (!fact.bytesPublished) {
      const current = await files.fingerprint(input.destination, signal)
      if (current) {
        if (current.bytes !== artifact.bytes || current.sha256 !== artifact.sha256)
          throw new Error('An archived artifact cannot be overwritten with different content; the original and pending capture were preserved.')
        const old = await readJson<ArtifactReference & { version: number; taskId: string }>(files, snapshot, input.manifestPath)
        if (!fact.attempting && (!old || old.version !== 1 || old.taskId !== input.taskId || old.path !== artifact.path
          || old.manifestPath !== artifact.manifestPath || old.name !== artifact.name
          || old.bytes !== artifact.bytes || old.sha256 !== artifact.sha256))
          throw new Error('An existing archive file has another or unknown artifact identity; it was preserved.')
      } else {
        // stageRead already accepted these bytes in this invocation. Only a
        // cold fact without that just-completed capture needs a stage reread.
        const staged = captured ?? await files.fingerprint(stage, signal)
        if (!staged || staged.bytes !== artifact.bytes || staged.sha256 !== artifact.sha256)
          throw new Error('The accepted artifact stage is missing or changed; no original was recaptured or overwritten.')
        // Save the original intended rename before issuing it. Cold continuation
        // checks this destination, not absence of a source stage as proof.
        fact.attempting = true; await persist()
        signal?.throwIfAborted(); await beforeAttempt(); if (await validate(snapshot) !== lifecycleId) throw new Error('Artifact Task lifecycle changed before publication.')
        const publication = await files.renameIfAbsent(stage, input.destination)
        if (publication !== 'renamed')
          throw new Error('Artifact publication did not replace its destination (' + publication + '); retry this exact command to reconcile it.')
      }
      fact.bytesPublished = true; await persist()
    }
    signal?.throwIfAborted(); await beforeAttempt(); if (await validate(snapshot) !== lifecycleId) throw new Error('Artifact Task lifecycle changed before publication.')
    const manifest = { version: 1, taskId: input.taskId, ...artifact }
    const existing = await readJson<typeof manifest>(files, snapshot, input.manifestPath)
    if (existing) {
      // Reuse only this accepted capture's manifest. This compares publication
      // metadata, not later user edits to an already published physical file.
      if (existing.version !== 1 || existing.taskId !== input.taskId || existing.path !== artifact.path
        || existing.manifestPath !== artifact.manifestPath || existing.name !== artifact.name
        || existing.bytes !== artifact.bytes || existing.sha256 !== artifact.sha256)
        throw new Error('The artifact manifest belongs to another identity; existing material was preserved.')
    } else if (!await files.createIfAbsent(input.manifestPath, encodeJson(manifest))) {
      throw new Error('The artifact manifest appeared during publication; retry this exact command without overwriting it.')
    }
    fact.published = true; await persist()
    await retireCapture()
    return artifact
  }, { signal })))
}
/** Called only after the original tool/result has been flushed, or from those
 * persisted Session events on reopening. No scan and no additional handshake. */
export async function retirePhysicalArtifact(files: PhysicalLocalFiles, taskId: string, commandId: string): Promise<void> {
  const work = root(taskId, commandId), path = work + '/publication.json'
  await inLane(files.directory + '\0artifact:' + path, () => withSnapshot(files, async snapshot => {
    const fact = await readJson<ArtifactPublication>(files, snapshot, path)
    if (!fact) return
    if (fact.version !== 1 || fact.commandId !== commandId || fact.taskId !== taskId || !fact.published)
      throw new Error('Successful artifact result does not match a finished original publication.')
    await cleanupCapture(files, work)
    await files.delete(path)
    await files.removeEmptyDirectory(work)
    // This parent is shared by independent commands in the same Task. Another
    // live capture or unretired result is normal, not failed retirement of ours.
    // Never enumerate or recursively remove it; other I/O errors still surface.
    try { await files.removeEmptyDirectory(paths.run(taskId) + '/.artifacts') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error }
  }))
}
