import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'
import type { DirectSignalSources } from './physical-direct-delivery.js'
import { localForegroundRoleRecordPath } from './conversation.js'

/** Storage-only explicit user controls read the same exact existing receiver
 * record as their Host. No Host start, signal receipt or role scan. */
export function physicalControlSignalSources(records: Pick<StoragePort, 'get'>, scope: string, member: string, collaborationId?: string): DirectSignalSources {
  return async path => {
    const parts = path.split('/'), name = parts.at(-1)!
    let role: 'Foreground' | 'Recorder' | 'Organizer' | 'Planner' | undefined, taskId: string | null = null
    if (parts.length === 2 && parts[0] === 'state' && name.startsWith('Foreground_')) role = 'Foreground'
    else if (parts.length === 4 && parts[0] === 'state' && parts[1] === member) {
      taskId = parts[2]!
      if (name === 'Recorder') role = 'Recorder'
      else if (name.startsWith('Planner_')) role = 'Planner'
      else if (name.startsWith('Organizer_')) role = 'Organizer'
    }
    if (!role) return []
    type Source = { path: string; version: string }
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const key = role === 'Foreground' && collaborationId !== undefined ? localForegroundRoleRecordPath(scope, collaborationId)
      : 'framework-runtime/' + digest(scope) + '/roles/' + digest(JSON.stringify([role, taskId, null, null]))
    const record = await records.get<{ delivery?: { request: { sources?: Source[] } }; lastWake?: { sources?: Source[] }; notificationClaims?: Record<string, { sources: Source[] }> }>(key)
    return [...record?.delivery?.request.sources ?? [], ...record?.lastWake?.sources ?? [],
      ...Object.values(record?.notificationClaims ?? {}).flatMap(claim => claim.sources)].filter(source => source.path === path)
  }
}

