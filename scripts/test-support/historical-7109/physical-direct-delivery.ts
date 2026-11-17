import { createHash } from 'node:crypto'
import { publishPreparedPhysicalFile } from './physical-publication-evidence.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { encodeJson, readJson } from './task-files.js'
import { filePath, withSnapshot } from './transactions.js'

interface Delivery {
  version: 1
  commandId: string
  request: string
  inputPath: string
  resultPath: string
  recipientSignal: string
  resultHash: string
  resultText?: string
  resultPrepared?: true
  resultPublished?: true
  signalVersion?: string
  published?: true
}
export interface PublishedDirectDelivery { commandId: string }
export interface PhysicalDirectDelivery {
  commandId: string
  inputPath: string
  resultPath: string
  recipientSignal: string
  text: string
}
/** Existing recipient wake/claim sources can establish that this exact staged
 * signal was accepted. No receiver ACK or new persistent record is created. */
export type DirectSignalSources = (path: string) => Promise<readonly { path: string; version: string }[]>
const digest = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex')
const requestHash = (input: Omit<PhysicalDirectDelivery, 'commandId'>): string =>
  digest(JSON.stringify([input.inputPath, input.resultPath, input.recipientSignal, input.text]))
const lanes = new Map<string, Promise<unknown>>()
const root = (inputPath: string): string => {
  filePath(inputPath)
  const match = /^direct\/([^/]+)\.md$/.exec(inputPath)
  if (!match) throw new Error('Direct delivery requires its original direct input path.')
  return 'direct/' + match[1] + '/.delivery'
}
async function inDelivery<T>(files: PhysicalLocalFiles, inputPath: string, work: () => Promise<T>): Promise<T> {
  const key = files.directory + '\0' + inputPath
  const operation = (lanes.get(key)?.catch(() => {}) ?? Promise.resolve()).then(work)
  lanes.set(key, operation)
  try { return await operation } finally { if (lanes.get(key) === operation) lanes.delete(key) }
}
async function load(files: PhysicalLocalFiles, inputPath: string): Promise<Delivery | undefined> {
  const fact = await withSnapshot(files, snapshot => readJson<Delivery>(files, snapshot, root(inputPath) + '/publication.json'))
  if (fact && (fact.version !== 1 || fact.inputPath !== inputPath || typeof fact.commandId !== 'string'
    || typeof fact.request !== 'string' || typeof fact.resultHash !== 'string')) throw new Error('The accepted direct delivery identity is invalid.')
  if (fact) { filePath(fact.resultPath); filePath(fact.recipientSignal) }
  return fact
}
const save = (files: PhysicalLocalFiles, fact: Delivery): Promise<void> => files.replace(root(fact.inputPath) + '/publication.json', encodeJson(fact))
async function publish(files: PhysicalLocalFiles, fact: Delivery, assertLive: () => void | Promise<void>, sources?: DirectSignalSources): Promise<void> {
  if (fact.published) return
  const work = root(fact.inputPath)
  await assertLive()
  if (!fact.resultPublished) {
    if (!fact.resultPrepared) {
      if (fact.resultText === undefined) throw new Error('The accepted direct result text is missing.')
      await files.replace(work + '/result.stage', fact.resultText)
      fact.resultPrepared = true
      await save(files, fact)
    }
    if (!await files.rename(work + '/result.stage', fact.resultPath)) {
      // Only the interrupted rename needs this targeted read. Never overwrite
      // an edited result or infer delivery merely from a missing stage.
      const result = await withSnapshot(files, snapshot => files.readBytes(snapshot, fact.resultPath))
      if (!result || digest(result) !== fact.resultHash) throw new Error('The prepared direct result is missing and its publication cannot be established: ' + fact.resultPath)
    }
    fact.resultPublished = true
    delete fact.resultText
    await save(files, fact)
  }
  if (!fact.signalVersion) {
    await files.replace(work + '/signal.stage', '')
    const stage = await files.fileInfo(work + '/signal.stage')
    if (!stage) throw new Error('The prepared direct recipient signal is missing.')
    fact.signalVersion = stage.version
    await save(files, fact)
  }
  await assertLive()
  await publishPreparedPhysicalFile(files, work + '/signal.stage', fact.recipientSignal, fact.signalVersion,
    sources && (() => sources(fact.recipientSignal)))
  fact.published = true
  await save(files, fact)
}
/** The actual direct business object owns only its result and designated final
 * notification. It is independent of Foreground submission and Task trees. */
export async function deliverPhysicalDirect(files: PhysicalLocalFiles, input: PhysicalDirectDelivery,
  assertLive: () => void | Promise<void>, sources?: DirectSignalSources,
  settled?: () => Promise<boolean>): Promise<PublishedDirectDelivery | undefined> {
  const work = root(input.inputPath)
  filePath(input.resultPath); filePath(input.recipientSignal)
  if (['publication.json', 'result.stage', 'signal.stage'].some(name => input.resultPath === work + '/' + name))
    throw new Error('The designated result overlaps this delivery’s temporary publication files.')
  return inDelivery(files, input.inputPath, async () => {
    await assertLive()
    // The same source responsibility may already be settled even when its
    // native tool result was interrupted. Check inside this actual input lane,
    // shared with retirement, before admitting another physical publication.
    if (await settled?.()) return
    let fact = await load(files, input.inputPath)
    const request = requestHash(input)
    if (fact && fact.request !== request) throw new Error('Continue the accepted direct delivery with its original result and recipient.')
    if (!fact) {
      fact = { version: 1, commandId: input.commandId, request, inputPath: input.inputPath,
        resultPath: input.resultPath, recipientSignal: input.recipientSignal, resultHash: digest(input.text), resultText: input.text }
      // The source RoleRecord already identifies this exact inputPath. Its
      // existing startup recovery can find this fact without a STATE scan.
      await save(files, fact)
    }
    await publish(files, fact, assertLive, sources)
    return { commandId: fact.commandId }
  })
}
export async function resumePhysicalDirectDelivery(files: PhysicalLocalFiles, inputPath: string,
  sources?: DirectSignalSources): Promise<PublishedDirectDelivery | undefined> {
  return inDelivery(files, inputPath, async () => {
    const fact = await load(files, inputPath)
    if (!fact) { await removeEmptyDelivery(files, inputPath); return }
    await publish(files, fact, () => {}, sources)
    return { commandId: fact.commandId }
  })
}
async function removeEmptyDelivery(files: PhysicalLocalFiles, inputPath: string): Promise<void> {
  const work = root(inputPath)
  // The parent is also only a temporary container when no takeover or other
  // business file exists. Never traverse or remove any nonempty directory.
  for (const path of [work, work.slice(0, -'/.delivery'.length)]) {
    try { await files.removeEmptyDirectory(path) }
    catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
}
/** The source RoleRecord has durably settled this exact delivery. Native
 * execution shutdown is independent; only this accepted command's technical
 * material retires, never the input, takeover, result or recipient signal. */
export async function retirePublishedDirectDelivery(files: PhysicalLocalFiles, inputPath: string,
  commandId: string): Promise<void> {
  await inDelivery(files, inputPath, async () => {
    const fact = await load(files, inputPath)
    if (fact && (!fact.published || fact.commandId !== commandId)) return
    if (fact) for (const name of ['result.stage', 'signal.stage', 'publication.json']) await files.delete(root(inputPath) + '/' + name)
    await removeEmptyDelivery(files, inputPath)
  })
}
