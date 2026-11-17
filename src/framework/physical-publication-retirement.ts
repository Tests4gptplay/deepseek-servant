import { retirePhysicalHelperReportsFromEvents } from './physical-helper-report.js'
import { retirePhysicalArtifact } from './physical-artifact-publication.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { retirePhysicalTaskRequirement } from './physical-task-dispatch.js'

const publicationTools = new Set(['dss_supplement_task', 'dss_planner_dispatch', 'dss_preserve_artifact'])
/** Reuse original native call/result evidence, not a new ACK, receipt index or
 * filesystem scan. Live callers must flush the original Session first; cold
 * callers supply its persisted events. Successful result evidence closes only
 * this exact execution/call's retry window, never a different command. */
export async function retirePhysicalPublicationsFromEvents(files: PhysicalLocalFiles, executionId: string,
  events: readonly SessionEvent[]): Promise<void> {
  await retirePhysicalHelperReportsFromEvents(files, executionId, events)
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>()
  for (const event of events) {
    if (event.type === 'tool/call' && publicationTools.has(event.data.name)) calls.set(String(event.data.callId), event)
    if (event.type !== 'tool/result' || event.data.message.isError) continue
    const call = calls.get(String(event.data.message.toolCallId))
    if (!call) continue
    const input: unknown = JSON.parse(call.data.arguments)
    if (!input || typeof input !== 'object') throw new Error('The successful publication call has no original object arguments.')
    const commandId = executionId + ':' + String(call.data.callId)
    if (!('snapshotId' in input) || typeof input.snapshotId !== 'string') throw new Error('The original publication Task reference is missing.')
    const view: unknown = JSON.parse(Buffer.from(input.snapshotId, 'base64url').toString('utf8'))
    if (!view || typeof view !== 'object' || !('taskId' in view) || typeof view.taskId !== 'string')
      throw new Error('The original publication view does not identify its Task.')
    if (call.data.name === 'dss_preserve_artifact') await retirePhysicalArtifact(files, view.taskId, commandId)
    else await retirePhysicalTaskRequirement(files, view.taskId, commandId)
    calls.delete(String(call.data.callId))
  }
}
