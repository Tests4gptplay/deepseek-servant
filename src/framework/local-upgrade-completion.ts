import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { localRecordPath } from './local-record-files.js'
import type { StoragePort } from '../contracts/ports.js'
import { canonicalLocalLocation } from './local-location.js'
import { inspectLegacyLocalInventory, inspectLocalStartupUpgrade, localStartupUpgradeKey, type LocalStartupUpgradeReport, type RetainedLocalUpgradeStage } from './local-startup-upgrade.js'
import { localSkillUpgradeKey } from './local-upgrade-mapping.js'
import { localTaskUpgradeKey } from './local-upgrade-task.js'
import { localConversationUpgradeKey } from './local-upgrade-conversation.js'
import { localUpgradeMappingKey, localUpgradeResultKey, type LocalUpgradeMapping } from './local-upgrade-mapping.js'
import type { LocalSourceRetirementAudit } from './local-upgrade-source-audit.js'

export interface LocalUpgradePending { path: string; reason: string }
export interface LocalUpgradeSpecialStageOwner { kind: 'task' | 'conversation' | 'skill'; id: string }
export interface LocalUpgradeSpecialStageChoice { owner: LocalUpgradeSpecialStageOwner; operationId: string; path: string; reason: string }
export interface LocalUpgradeSpecialStageDecision extends LocalUpgradeSpecialStageChoice { selectedAt: string }
export interface LocalUpgradeAssessment {
  report: LocalStartupUpgradeReport
  pending: LocalUpgradePending[]
  /** Exact one-time records observed by this assessment, not a prefix scan. */
  cleanup: Array<{ key: string; kind: string; operationId: string }>
  /** Offered only from completed, already-addressed specialist operations. */
  specialStageChoices?: LocalUpgradeSpecialStageChoice[]
  retainedSpecialStages?: LocalUpgradeSpecialStageDecision[]
}
export interface LocalUpgradeCompleted {
  kind: 'dss-local-upgrade-result'
  directory: string
  operationId: string
  completedAt: string
  report: LocalStartupUpgradeReport
  /** Removed after exact temporary records have been retired. */
  cleanup?: LocalUpgradeAssessment['cleanup']
  /** Original SQL is neither deleted nor moved by conversion completion. */
  sourceDisposition?: 'retained-pending-retirement-review'
  /** Conversion evidence is distinct from unresolved source disposal. */
  sourceAudit?: LocalSourceRetirementAudit
  retainedSourceMappings?: LocalUpgradeAssessment['cleanup']
  /** Exact user dispositions survive retirement of Task/conversation/skill temporary owners. */
  retainedSpecialStages?: LocalUpgradeSpecialStageDecision[]
}

export { localUpgradeResultKey } from './local-upgrade-mapping.js'
export async function readLocalUpgradeCompleted(directory: string, storage: StoragePort): Promise<LocalUpgradeCompleted | undefined> {
  const value = await storage.get<LocalUpgradeCompleted>(localUpgradeResultKey(directory))
  if (value && (value.kind !== 'dss-local-upgrade-result' || value.directory !== directory || !value.operationId || value.report?.status !== 'complete'))
    throw new Error('The one-time upgrade result is invalid; it was retained.')
  return value
}
/** A finish check of actual converted inputs, never a daily admission gate.
 * Unimplemented known semantic work remains explicit instead of being declared
 * finished merely because all SQL bytes reached similarly named files. */
export async function assessLocalUpgradeCompletion(directory: string, storage: StoragePort, signal?: AbortSignal): Promise<LocalUpgradeAssessment> {
  const root = await canonicalLocalLocation(directory, true)
  const report = await inspectLocalStartupUpgrade(root, storage, { signal }), pending: LocalUpgradePending[] = [], cleanup: LocalUpgradeAssessment['cleanup'] = []
  const specialStageChoices: LocalUpgradeSpecialStageChoice[] = [], retainedSpecialStages: LocalUpgradeSpecialStageDecision[] = []
  if (report.status !== 'complete') return { report, pending: report.issues.map(issue => ({ path: issue.path ?? report.sourcePath, reason: issue.message })), cleanup }
  const inventory = await inspectLegacyLocalInventory(root, { signal })
  const capture = async (key: string, owner?: LocalUpgradeSpecialStageOwner) => {
    const value = await storage.get<{ kind?: string; operationId?: string; directory?: string; status?: string;
      taskId?: string; collaborationId?: string; sourcePath?: string; retainedStages?: RetainedLocalUpgradeStage[] }>(key)
    if (value?.directory !== root || !value.kind || !value.operationId || cleanup.some(item => item.key === key)) return
    cleanup.push({ key, kind: value.kind, operationId: value.operationId })
    const exactSpecial = owner && value.status === 'complete' && (
      owner.kind === 'task' && value.kind === 'dss-once-task-layout' && value.taskId === owner.id
      || owner.kind === 'conversation' && value.kind === 'dss-once-conversation-full-text' && value.collaborationId === owner.id
      || owner.kind === 'skill' && value.kind === 'dss-once-native-skill' && value.sourcePath === owner.id)
    // Only actual paths already recorded by this one-time operation. Do not
    // discard their recovery ownership while unresolved temporary bytes remain.
    for (const stage of value.retainedStages ?? []) {
      signal?.throwIfAborted()
      // The exact user-retained path remains recorded in the completed report;
      // no filesystem cleanup or claim about its current existence follows.
      if (key === localStartupUpgradeKey(root) && stage.keptByUser) continue
      if (exactSpecial && stage.keptByUser) {
        retainedSpecialStages.push({ owner, operationId: value.operationId, path: stage.path, reason: stage.reason, selectedAt: stage.keptByUser.selectedAt })
        continue
      }
      try {
        await lstat(join(root, ...localRecordPath(stage.path).split('/')))
        pending.push({ path: stage.path, reason: stage.reason })
        if (exactSpecial) specialStageChoices.push({ owner, operationId: value.operationId, path: stage.path, reason: stage.reason })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  const skillDefinitions = inventory.files.map(file => file.path).filter(path => /^skills\/(?:[^/]+\/)+(?:SKILL\.md|record\.json|legacy-git\.json)$/.test(path))
  await capture(localStartupUpgradeKey(root))
  for (const file of inventory.files) {
    signal?.throwIfAborted()
    await capture(localUpgradeMappingKey(root, file.path))
    const match = /^conversation-index\/local\/([^/]+)\/index\.json$/.exec(file.path)
    if (match) {
      let scope: string
      try { scope = decodeURIComponent(match[1]!) } catch { pending.push({ path: file.path, reason: 'The original conversation scope cannot be decoded without guessing.' }); continue }
      const key = localConversationUpgradeKey(root, scope), value = await storage.get<{ kind?: string; status?: string; directory?: string; collaborationId?: string }>(key)
      if (value?.kind !== 'dss-once-conversation-full-text' || value.status !== 'complete' || value.directory !== root || value.collaborationId !== scope)
        pending.push({ path: file.path, reason: 'This original conversation still needs its verified full-body conversion.' })
      await capture(key, { kind: 'conversation', id: scope })
    }
    if (/^tasks\/[^/]+\.json$/.test(file.path)) {
      const taskId = file.path.slice('tasks/'.length, -5), key = localTaskUpgradeKey(root, taskId)
      const value = await storage.get<{ kind?: string; status?: string; directory?: string; taskId?: string }>(key)
      if (value?.kind !== 'dss-once-task-layout' || value.status !== 'complete' || value.directory !== root || value.taskId !== taskId)
        pending.push({ path: file.path, reason: 'The original Task needs its actual lifecycle/current-or-history mapping; status alone is not a release fact.' })
      await capture(key, { kind: 'task', id: taskId })
    }
    if (/^skills\/[^/]+\//.test(file.path)) {
      let restored = false
      const mapping = await storage.get<LocalUpgradeMapping>(localUpgradeMappingKey(root, file.path))
      for (const definition of skillDefinitions.filter(path => file.path.startsWith(path.slice(0, path.lastIndexOf('/') + 1)))) {
        const key = localSkillUpgradeKey(root, definition)
        const value = await storage.get<{ kind?: string; status?: string; directory?: string; sourcePath?: string; operationId?: string }>(key)
        if (value?.kind === 'dss-once-native-skill' && value.status === 'complete' && value.directory === root && value.sourcePath === definition
          && mapping?.kind === 'dss-once-source-mapping' && mapping.operationId === value.operationId && mapping.disposition === 'converted') restored = true
        await capture(key, { kind: 'skill', id: definition })
      }
      if (!restored) pending.push({ path: file.path, reason: 'The original skill is preserved; its native definition has not yet been verified and published by this upgrade.' })
    }
  }
  for (const issue of inventory.issues) pending.push({ path: issue.path ?? report.sourcePath, reason: issue.message })
  signal?.throwIfAborted()
  return { report, pending, cleanup, ...(specialStageChoices.length ? { specialStageChoices } : {}),
    ...(retainedSpecialStages.length ? { retainedSpecialStages } : {}) }
}
/** Runs only after the exact native Agent scope has actually been disposed.
 * A compact completed result is source disposition, not a sleeping wake or a
 * file-version lock. Original SQL and user-owned recovery material are retained. */
export async function retireLocalUpgradeRecords(storage: StoragePort, completed: LocalUpgradeCompleted, wakeKey: string): Promise<string | undefined> {
  if (!storage.delete) return 'This storage adapter cannot delete the exact one-time wake/recovery records yet. Native tools are retired; those records remain for cleanup.'
  const resultKey = localUpgradeResultKey(completed.directory)
  await storage.set(resultKey, completed)
  const retainedSourceMappings = [...completed.retainedSourceMappings ?? []]
  for (const owned of completed.cleanup ?? []) {
    if (owned.kind === 'dss-once-source-mapping') { if (!retainedSourceMappings.some(item => item.key === owned.key)) retainedSourceMappings.push(owned); continue }
    const actual = await storage.get<{ kind?: string; operationId?: string; directory?: string }>(owned.key)
    if (!actual) continue
    if (actual.kind !== owned.kind || actual.operationId !== owned.operationId || actual.directory !== completed.directory)
      return 'A one-time recovery record changed ownership and was retained: ' + owned.key
    await storage.delete(owned.key)
  }
  // The wake is last: interruption retains the exact result and cleanup list.
  await storage.delete(wakeKey)
  const { cleanup: _cleanup, ...result } = completed
  await storage.set(resultKey, { ...result, sourceDisposition: 'retained-pending-retirement-review', ...(retainedSourceMappings.length ? { retainedSourceMappings } : {}) })
  return undefined
}
