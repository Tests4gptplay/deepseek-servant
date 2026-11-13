import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HelperRepairAttempt } from './role-tools.js'
import type { PreparedLocalReport } from './local-record-files.js'
import type { DirectSignalSources } from './physical-direct-delivery.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { publishPreparedPhysicalFile } from './physical-publication-evidence.js'
import { encodeJson, readJson } from './task-files.js'
import { withSnapshot } from './transactions.js'

export interface PhysicalHelperReportInput {
  commandId: string
  originalCommandId: string
  path: string
  text: string
  append: boolean
  notifyForeground?: boolean
  repairAttempt?: HelperRepairAttempt
}
export interface PhysicalHelperReportServices {
  recordAttempt?(input: HelperRepairAttempt, originalCommandId: string): Promise<void>
  signalSources?: DirectSignalSources
}
interface Report {
  version: 1
  commandId: string
  originalCommandId: string
  request: string
  path: string
  signal?: string
  prepared?: PreparedLocalReport
  reportSaved?: true
  signalVersion?: string
  signalSaved?: true
  attemptSaved?: true
  complete?: true
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const root = (commandId: string) => 'debug/.helper-publications/' + hash(commandId)
const facts = (input: Pick<PhysicalHelperReportInput, 'path' | 'text' | 'append' | 'notifyForeground' | 'repairAttempt'>): string =>
  hash(JSON.stringify([input.path, input.text, input.append, input.notifyForeground === true,
    input.repairAttempt ? [input.repairAttempt.faultId ?? null, input.repairAttempt.actionsTaken, input.repairAttempt.outcome, input.repairAttempt.result] : null]))
function reportSignal(input: PhysicalHelperReportInput): string | undefined {
  const daily = /^debug\/\d{4}-\d{2}-\d{2}\.md$/.test(input.path)
  const named = /^debug\/helper-reports\/([^/\\\0\r\n:*?"<>|]+\.md)$/.exec(input.path)
  if (!daily && !named || input.repairAttempt && !daily) throw new Error('A Helper publication requires its original dated record or named report.')
  if (!input.notifyForeground) return
  const signal = named ? 'Foreground_Helper_Report_' + named[1]
    : 'Foreground_Helper_' + input.path.slice(6, 16) + '_' + hash(input.originalCommandId)
  if (Buffer.byteLength(signal, 'utf8') > 255) throw new Error('Helper report filename is too long for its complete Foreground signal.')
  return 'state/' + signal
}
const operations = new Map<string, Promise<unknown>>()
async function inReport<T>(files: PhysicalLocalFiles, commandId: string, action: () => Promise<T>): Promise<T> {
  const key = files.directory + '\0' + commandId
  const operation = (operations.get(key)?.catch(() => {}) ?? Promise.resolve()).then(action)
  operations.set(key, operation)
  try { return await operation } finally { if (operations.get(key) === operation) operations.delete(key) }
}
async function load(files: PhysicalLocalFiles, commandId: string): Promise<Report | undefined> {
  const value = await withSnapshot(files, snapshot => readJson<Report>(files, snapshot, root(commandId) + '/publication.json'))
  if (value && (value.version !== 1 || value.commandId !== commandId || typeof value.originalCommandId !== 'string'
    || typeof value.request !== 'string' || typeof value.path !== 'string')) throw new Error('The original Helper report publication identity is invalid.')
  return value
}
const save = (files: PhysicalLocalFiles, fact: Report) => files.replace(root(fact.commandId) + '/publication.json', encodeJson(fact))
async function publish(files: PhysicalLocalFiles, fact: Report, input: PhysicalHelperReportInput,
  services: PhysicalHelperReportServices, beforeAttempt: () => void | Promise<void>): Promise<void> {
  if (fact.request !== facts(input) || fact.path !== input.path || fact.signal !== reportSignal(input))
    throw new Error('Continue the original Helper report command with unchanged report text and options.')
  if (fact.complete) return
  const work = root(fact.commandId)
  await beforeAttempt()
  if (!fact.reportSaved) {
    await files.publishPreparedReport(fact.path, work + '/report.stage', input.text, input.append, fact.prepared,
      async prepared => { fact.prepared = prepared; await save(files, fact) }, 'same-file-identity')
    fact.reportSaved = true
    await save(files, fact)
  }
  if (fact.signal && !fact.signalSaved) {
    if (!fact.signalVersion) {
      await files.replace(work + '/signal.stage', '')
      const prepared = await files.fileInfo(work + '/signal.stage')
      if (!prepared) throw new Error('The prepared Foreground report signal is missing.')
      fact.signalVersion = prepared.version
      await save(files, fact)
    }
    await beforeAttempt()
    await publishPreparedPhysicalFile(files, work + '/signal.stage', fact.signal, fact.signalVersion,
      services.signalSources && (() => services.signalSources!(fact.signal!)))
    fact.signalSaved = true
    await save(files, fact)
  }
  if (input.repairAttempt && !fact.attemptSaved) {
    if (!services.recordAttempt) throw new Error('Helper repair-attempt reporting is unavailable.')
    try {
      await services.recordAttempt(input.repairAttempt, fact.originalCommandId)
      fact.attemptSaved = true
      await save(files, fact)
    } catch (cause) {
      const message = 'Record saved at ' + JSON.stringify(fact.path) + '. '
        + (fact.signal ? 'Foreground signal saved at ' + JSON.stringify(fact.signal) + '. ' : 'No Foreground signal was requested. ')
        + 'Repair-attempt reporting did not complete; its status is unconfirmed. Retry the original dss_record call with the same command identity '
        + JSON.stringify(fact.originalCommandId) + ' and unchanged arguments. Cause: ' + String(cause)
      if (cause instanceof Error) { cause.message = message; throw cause }
      throw new Error(message, { cause })
    }
  }
  fact.complete = true
  await save(files, fact)
}
/** Accepted Helper report only. Its native tool call is the restart source; no
 * extra wake, ACK, report index, global journal or directory scan is introduced.
 * Foreground notification and repair-attempt judgment remain explicit options. */
export async function publishPhysicalHelperReport(files: PhysicalLocalFiles, input: PhysicalHelperReportInput,
  services: PhysicalHelperReportServices = {}, beforeAttempt: () => void | Promise<void> = () => {}): Promise<void> {
  const signal = reportSignal(input)
  if (!signal && !input.repairAttempt) throw new Error('A plain Helper record uses ordinary direct writing.')
  return inReport(files, input.commandId, async () => {
    await beforeAttempt()
    let fact = await load(files, input.commandId)
    if (!fact) {
      fact = { version: 1, commandId: input.commandId, originalCommandId: input.originalCommandId,
        request: facts(input), path: input.path, ...(signal ? { signal } : {}) }
      await save(files, fact)
    }
    await publish(files, fact, { ...input, originalCommandId: fact.originalCommandId }, services, beforeAttempt)
  })
}
function callsFromEvents(events: readonly SessionEvent[]) {
  const calls = new Map<string, { arguments: string; success: boolean }>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === 'dss_record')
      calls.set(String(event.data.callId), { arguments: event.data.arguments, success: false })
    if (event.type === 'tool/result' && !event.data.message.isError) {
      const call = calls.get(String(event.data.message.toolCallId))
      if (call) call.success = true
    }
  }
  return calls
}
function acceptedInput(argumentsText: string): Omit<PhysicalHelperReportInput, 'commandId' | 'originalCommandId'> {
  const input = JSON.parse(argumentsText)
  if (!input || typeof input !== 'object' || typeof input.path !== 'string' || typeof input.text !== 'string'
    || !input.notifyForeground && !input.repairAttempt) throw new Error('The accepted Helper report arguments are unavailable.')
  return { path: input.path, text: input.text, append: input.append ?? true,
    ...(input.notifyForeground ? { notifyForeground: true } : {}), ...(input.repairAttempt ? { repairAttempt: input.repairAttempt } : {}) }
}
async function retire(files: PhysicalLocalFiles, commandId: string): Promise<void> {
  const work = root(commandId), fact = await load(files, commandId)
  if (fact && !fact.complete) return
  if (fact) for (const name of ['report.stage', 'signal.stage', 'publication.json']) await files.delete(work + '/' + name)
  for (const directory of [work, 'debug/.helper-publications']) {
    try { await files.removeEmptyDirectory(directory) }
    catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
}
/** Caller supplies the known inactive Helper's persisted native session. An
 * unaccepted native call does not create a report. A completed physical effect
 * is not fabricated into a native result; its exact retry fact stays until the
 * original native result becomes durable. No unrelated session/file is read. */
export async function resumePhysicalHelperReportsFromEvents(files: PhysicalLocalFiles, executionId: string,
  events: readonly SessionEvent[], services: PhysicalHelperReportServices = {}): Promise<void> {
  const results = await Promise.allSettled([...callsFromEvents(events)].map(([callId, call]) => {
    const commandId = executionId + ':' + callId
    return inReport(files, commandId, async () => {
      if (call.success) { await retire(files, commandId); return }
      const fact = await load(files, commandId)
      if (!fact) return
      // Failed/unaccepted native calls may have malformed arguments. Only an
      // actual accepted fact gives this exact call a publication responsibility.
      await publish(files, fact, { ...acceptedInput(call.arguments), commandId, originalCommandId: fact.originalCommandId }, services, () => {})
    })
  }))
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, 'One or more original Helper report publications remain unconfirmed.')
}
/** Only persisted successful native results end these exact call retry windows.
 * Report bodies, ordinary Foreground signals and safety attempts are retained. */
export async function retirePhysicalHelperReportsFromEvents(files: PhysicalLocalFiles, executionId: string,
  events: readonly SessionEvent[]): Promise<void> {
  for (const [callId, call] of callsFromEvents(events)) if (call.success) {
    const commandId = executionId + ':' + callId
    await inReport(files, commandId, () => retire(files, commandId))
  }
}
