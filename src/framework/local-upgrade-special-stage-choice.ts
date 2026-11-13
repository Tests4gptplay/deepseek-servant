import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { localRecordPath } from './local-record-files.js'
import { localTaskUpgradeKey } from './local-upgrade-task.js'
import { localConversationUpgradeKey } from './local-upgrade-conversation.js'
import { localSkillUpgradeKey } from './local-upgrade-mapping.js'
import type { LocalUpgradeSpecialStageChoice } from './local-upgrade-completion.js'
import type { RetainedLocalUpgradeStage } from './local-startup-upgrade.js'

/** Only a completed, exact specialist owner may record a cleanup disposition.
 * The source conversion and other stages remain subject to the normal finish. */
export async function keepRetainedSpecialLocalUpgradeStage(directory: string, storage: StoragePort,
  selected: Pick<LocalUpgradeSpecialStageChoice, 'owner' | 'operationId' | 'path'>): Promise<{ saved: boolean }> {
  const root = await canonicalLocalLocation(directory, true)
  localRecordPath(selected.path)
  if (!selected.owner.id) throw new Error('Choose an exact original Local owner.')
  const key = selected.owner.kind === 'task' ? localTaskUpgradeKey(root, selected.owner.id)
    : selected.owner.kind === 'conversation' ? localConversationUpgradeKey(root, selected.owner.id)
      : selected.owner.kind === 'skill' ? localSkillUpgradeKey(root, selected.owner.id)
        : undefined
  if (!key) throw new Error('Choose an existing Task, conversation or skill upgrade owner.')
  const operation = await storage.get<{ kind?: string; directory?: string; operationId?: string; status?: string;
    taskId?: string; collaborationId?: string; sourcePath?: string; retainedStages?: RetainedLocalUpgradeStage[] }>(key)
  const expectedKind = selected.owner.kind === 'task' ? 'dss-once-task-layout'
    : selected.owner.kind === 'conversation' ? 'dss-once-conversation-full-text' : 'dss-once-native-skill'
  const ownerId = selected.owner.kind === 'task' ? operation?.taskId
    : selected.owner.kind === 'conversation' ? operation?.collaborationId : operation?.sourcePath
  if (!operation || operation.directory !== root || operation.kind !== expectedKind || ownerId !== selected.owner.id
    || operation.operationId !== selected.operationId || operation.status !== 'complete' || !Array.isArray(operation.retainedStages))
    throw new Error('The selected completed Local upgrade owner changed; refresh its pending stage.')
  const stages = operation.retainedStages.filter(stage => stage?.path === selected.path)
  if (stages.length !== 1) throw new Error('The selected stage is not one exact retained responsibility of this owner.')
  if (stages[0]!.keptByUser) return { saved: true }
  // One exact check on a user click. A vanished path needs no disposition;
  // the existing one-time finish assessment will naturally drop its pending.
  try { await lstat(join(root, ...selected.path.split('/'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { saved: false }; throw error }
  stages[0]!.keptByUser = { selectedAt: new Date().toISOString() }
  await storage.set(key, structuredClone(operation))
  return { saved: true }
}
