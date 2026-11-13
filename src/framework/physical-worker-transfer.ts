import { createHash } from 'node:crypto'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { publishPreparedPhysicalFile } from './physical-publication-evidence.js'
import { encodeJson, readJson } from './task-files.js'
import { withSnapshot } from './transactions.js'
import type { WorkerBusinessTransfer } from './worker-business.js'

interface PreparedFile { stage: string; path: string; version: string; published?: true }
interface PhysicalTransfer {
  commandId: string
  request: string
  directory: string
  files: PreparedFile[]
  signal: PreparedFile
  initializations?: string[]
  published?: true
}
export type PhysicalWorkerBusinessTransfer<R = WorkerBusinessTransfer['record']> = WorkerBusinessTransfer<R> & { physical?: PhysicalTransfer }
export interface WorkerTransferInput {
  commandId: string
  markerPath: string
  directory: string
  replyPath: string
  reply: string
  notePath: string
  records: readonly { path: string; text: string }[]
  handoff?: { path: string; text: string }
  successor?: { contractPath: string; contract: string; notePath: string; replyPath: string; initialize: boolean }
  signalPath: string
}
const lanes = new Map<string, Promise<unknown>>()
async function serial<T>(files: PhysicalLocalFiles, marker: string, action: () => Promise<T>): Promise<T> {
  const key = files.directory + '\0' + marker
  const pending = (lanes.get(key)?.catch(() => {}) ?? Promise.resolve()).then(action)
  lanes.set(key, pending)
  try { return await pending } finally { if (lanes.get(key) === pending) lanes.delete(key) }
}
const requestHash = (input: WorkerTransferInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex')

/** This execution's existing Worker business-transfer marker owns its accepted
 * relay/delivery. Original result/contract bytes precede the ordinary empty
 * notification; native disposal remains a separate responsibility. */
export function transferPhysicalWorker<R>(files: PhysicalLocalFiles, input: WorkerTransferInput,
  prepare: () => Promise<WorkerBusinessTransfer<R>>, beforePublication: () => Promise<void>,
  acceptedSources: () => Promise<readonly { path: string; version: string }[]>,
  beforeAcceptance?: () => void | Promise<void>): Promise<void> {
  return serial(files, input.markerPath, () => withSnapshot(files, async snapshot => {
    let transfer = await readJson<PhysicalWorkerBusinessTransfer<R>>(files, snapshot, input.markerPath)
    if (transfer) {
      if (!transfer.physical || transfer.physical.commandId !== input.commandId || transfer.physical.request !== requestHash(input))
        throw new Error('This Worker already transferred its business responsibility through a different accepted command.')
    } else {
      const original = await prepare()
      const prepared: PreparedFile[] = []
      const stage = async (path: string, text: string, name: string): Promise<PreparedFile> => {
        const staged = input.directory + '/' + name
        await files.replace(staged, text)
        const observation = await files.fileInfo(staged)
        if (!observation) throw new Error('The prepared Worker transfer file disappeared: ' + staged)
        return { stage: staged, path, version: observation.version }
      }
      prepared.push(await stage(input.replyPath, (await files.read(snapshot, input.replyPath) ?? '') + input.reply, 'reply.stage'))
      for (const [index, item] of input.records.entries()) prepared.push(await stage(item.path, item.text, 'record-' + index + '.stage'))
      if (input.handoff) prepared.push(await stage(input.handoff.path, input.handoff.text, 'handoff.stage'))
      if (input.successor) {
        prepared.push(await stage(input.successor.contractPath, input.successor.contract, 'contract.stage'))
      }
      // Clear this round's Note only after the actual reply and output records.
      prepared.push(await stage(input.notePath, '', 'note.stage'))
      const signal = await stage(input.signalPath, '', 'signal.stage')
      await beforeAcceptance?.()
      transfer = { ...original, physical: { commandId: input.commandId, request: requestHash(input),
        directory: input.directory, files: prepared, signal, ...(input.successor?.initialize
          ? { initializations: [input.successor.notePath, input.successor.replyPath] } : {}) } }
      await files.replace(input.markerPath, encodeJson(transfer))
    }
    await publish(files, input.markerPath, transfer, beforePublication, acceptedSources)
  }))
}

export function resumePhysicalWorkerTransfer<R>(files: PhysicalLocalFiles, markerPath: string,
  beforePublication: () => Promise<void>,
  acceptedSources: (transfer: WorkerBusinessTransfer<R>) => Promise<readonly { path: string; version: string }[]>): Promise<void> {
  return serial(files, markerPath, () => withSnapshot(files, async snapshot => {
    const transfer = await readJson<PhysicalWorkerBusinessTransfer<R>>(files, snapshot, markerPath)
    if (!transfer?.physical) return
    await publish(files, markerPath, transfer, beforePublication, () => acceptedSources(transfer))
  }))
}

async function publish<R>(files: PhysicalLocalFiles, markerPath: string, transfer: PhysicalWorkerBusinessTransfer<R>,
  beforePublication: () => Promise<void>, acceptedSources: () => Promise<readonly { path: string; version: string }[]>): Promise<void> {
  const publication = transfer.physical!
  if (publication.published) return
  await beforePublication()
  for (const item of publication.files) {
    if (item.published) continue
    await publishPreparedPhysicalFile(files, item.stage, item.path, item.version)
    item.published = true
    await files.replace(markerPath, encodeJson(transfer))
  }
  for (const path of publication.initializations ?? []) await files.createIfAbsent(path, '')
  await beforePublication()
  await publishPreparedPhysicalFile(files, publication.signal.stage, publication.signal.path, publication.signal.version, acceptedSources)
  // Keep the existing small transfer responsibility until native/task retirement;
  // remove its bulky operation materials now, not at the next global scan.
  await files.removeDirectory(publication.directory)
  publication.published = true
  publication.files = []
  await files.replace(markerPath, encodeJson(transfer))
}
