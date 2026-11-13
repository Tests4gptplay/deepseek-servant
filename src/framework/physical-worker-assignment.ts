import { createHash } from 'node:crypto'
import { publishPreparedPhysicalFile } from './physical-publication-evidence.js'
import type { DirectSignalSources } from './physical-direct-delivery.js'
import type { PreparedLocalAppend } from './local-record-files.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { encodeJson, readJson } from './task-files.js'
import { withSnapshot } from './transactions.js'

interface Assignment {
  version: 1
  commandId: string
  request: string
  taskId: string
  lifecycleId: string
  contractPrepared: { version: string }
  contractPublished?: true
  decisionPrepared?: PreparedLocalAppend
  decisionPublished?: true
  signalPrepared?: { version: string }
  published?: true
}
export interface PhysicalWorkerAssignment {
  commandId: string
  taskId: string
  lifecycleId?: string
  workerRoot: string
  contractPath: string
  notePath: string
  replyPath: string
  plannerMemoryPath: string
  signalPath: string
  contract: string
  decision: string
}
const lanes = new Map<string, Promise<unknown>>()
/** The saved stage observation can identify an in-place edited file after
 * rename. A missing or atomically replaced target remains unconfirmed. */
function sameStageFile(staged: string, current: string): boolean {
  const parse = (value: string) => /^local-file:(\d+):(\d+):(\d+):(-?\d+):(-?\d+):(-?\d+)$/.exec(value)
  const a = parse(staged), b = parse(current)
  return !!a && !!b && [1, 2, 6].every(index => a[index] === b[index])
}
const fingerprint = (input: PhysicalWorkerAssignment): string => createHash('sha256').update(JSON.stringify([
  input.taskId, input.lifecycleId ?? '', input.workerRoot, input.contractPath, input.notePath,
  input.replyPath, input.plannerMemoryPath, input.signalPath, input.contract, input.decision,
])).digest('hex')

/** One Planner→Worker assignment, not a general multi-file transaction. The
 * latest assignment identity stays with that Worker's temporary runtime. Full
 * contract/decision bytes are staged once, never embedded in repeated progress
 * saves. The existing empty Worker notification is published last. */
export async function assignPhysicalWorker(files: PhysicalLocalFiles, input: PhysicalWorkerAssignment,
  assertLive: () => void | Promise<void>, beforeNotify: () => void | Promise<void>,
  sources?: DirectSignalSources): Promise<void> {
  const factPath = input.workerRoot + '/assignment.json', lane = files.directory + '\0' + factPath
  const operation = (lanes.get(lane)?.catch(() => {}) ?? Promise.resolve()).then(() => withSnapshot(files, async snapshot => {
    await assertLive()
    const request = fingerprint(input)
    let fact = await readJson<Assignment>(files, snapshot, factPath)
    const contractStage = input.workerRoot + '/.assignment-contract.stage'
    const decisionPath = input.workerRoot + '/.assignment-decision.txt'
    const noteStage = input.workerRoot + '/.assignment-memory.stage'
    const signalStage = input.workerRoot + '/.assignment-signal.stage'
    const persist = (value: Assignment) => files.replace(factPath, encodeJson(value))
    const retireStages = async () => {
      await files.delete(decisionPath)
      await files.delete(noteStage)
      await files.delete(contractStage)
      await files.delete(signalStage)
    }
    const publishCurrent = async (fact: Assignment) => {
      await assertLive()
      if (!fact.contractPublished) {
        if (typeof fact.contractPrepared?.version !== 'string')
          throw new Error('The accepted Worker contract has no prepared file identity.')
        if (!await files.rename(contractStage, input.contractPath)) {
          const current = await files.fileInfo(input.contractPath)
          if (!current || !sameStageFile(fact.contractPrepared.version, current.version))
            throw new Error('The prepared Local publication is unavailable and its result is not confirmed: ' + input.contractPath)
        }
        fact.contractPublished = true
        await persist(fact)
      }
      if (!fact.decisionPublished) {
        const decision = await files.read(snapshot, decisionPath)
        if (decision === undefined) throw new Error('The accepted Worker assignment decision is missing: ' + decisionPath)
        const staged = fact.decisionPrepared && await files.fileInfo(noteStage)
        if (fact.decisionPrepared && !staged) {
          const current = await files.fileInfo(input.plannerMemoryPath)
          if (!current || !sameStageFile(fact.decisionPrepared.stageVersion, current.version))
            throw new Error('The prepared append is unavailable and its publication is not confirmed: ' + input.plannerMemoryPath)
        } else {
          await files.appendPrepared(input.plannerMemoryPath, noteStage, decision, fact.decisionPrepared,
            async prepared => { fact.decisionPrepared = prepared; await persist(fact) })
        }
        fact.decisionPublished = true
        await persist(fact)
      }
      await Promise.all([files.createIfAbsent(input.notePath, ''), files.createIfAbsent(input.replyPath, '')])
      await beforeNotify()
      if (!fact.signalPrepared) {
        await files.replace(signalStage, '')
        const prepared = await files.fileInfo(signalStage)
        if (!prepared) throw new Error('The accepted Worker signal stage is missing.')
        fact.signalPrepared = { version: prepared.version }
        await persist(fact)
      }
      if (typeof fact.signalPrepared.version !== 'string')
        throw new Error('The accepted Worker signal has no prepared file identity.')
      await publishPreparedPhysicalFile(files, signalStage, input.signalPath, fact.signalPrepared.version,
        sources && (() => sources(input.signalPath)))
      fact.published = true
      await persist(fact)
      // Only the small current assignment fact remains until Task cleanup. No
      // command history, copied contract or stage is retained after publication.
      await retireStages()
    }
    if (fact && (fact.taskId !== input.taskId || fact.lifecycleId !== (input.lifecycleId ?? '')))
      throw new Error('This Worker assignment belongs to a different Task lifecycle.')
    if (fact?.commandId === input.commandId && fact.request !== request)
      throw new Error('Retry this Worker assignment with its original contract and decision.')
    // The actual Planner tool derives these targets from one fixed
    // Task/member/ChildID workerPaths mapping. Resume the accepted fact using
    // its original stages, never the incoming contract/decision text. Only
    // this Worker's lane waits; no queue of new requests is persisted.
    if (fact) {
      if (!fact.published) await publishCurrent(fact)
      else await retireStages()
      if (fact.commandId === input.commandId) return
    }
    await assertLive()
    // Previous accepted work is now complete. A new command updates this
    // Worker's current contract, preserving the existing Planner history.
    await files.replace(contractStage, input.contract)
    await files.replace(decisionPath, input.decision)
    const prepared = await files.fileInfo(contractStage)
    if (!prepared) throw new Error('The accepted Worker contract stage is missing.')
    fact = { version: 1, commandId: input.commandId, request, taskId: input.taskId,
      lifecycleId: input.lifecycleId ?? '', contractPrepared: { version: prepared.version } }
    await persist(fact)
    await publishCurrent(fact)
  }))
  lanes.set(lane, operation)
  try { await operation } finally { if (lanes.get(lane) === operation) lanes.delete(lane) }
}
