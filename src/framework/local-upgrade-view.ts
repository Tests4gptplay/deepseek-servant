import type { StoragePort } from '../contracts/ports.js'
import type { FrameworkLocalUpgradeStatus } from './client-contracts.js'
import { readLocalUpgradeCompleted } from './local-upgrade-completion.js'
import type { LocalUpgradeAgentResult } from './local-startup-upgrade-agent.js'

/** Project the existing owner/result only. No source audit, export or Agent is
 * started by an ordinary view; cold reads reuse the exact persisted result. */
export async function localUpgradeView(directory: string, storage: StoragePort,
  owner?: { result?: LocalUpgradeAgentResult; failure?: string }): Promise<FrameworkLocalUpgradeStatus | undefined> {
  const completed = await readLocalUpgradeCompleted(directory, storage)
  const result = owner?.result
  if (result?.status === 'not-needed') return undefined
  if (!owner && !completed) return undefined
  const report = result?.report ?? completed?.report
  const pending = result?.pending !== undefined ? [...result.pending] : report?.issues.map(issue => ({ path: issue.path ?? report.sourcePath, reason: issue.message })) ?? []
  // A complete finish assessment checks actual stage existence. An unfinished
  // report or an Agent ending before finish has only last-reported paths.
  for (const stage of result?.status === 'pending' && (result.pending === undefined || report?.status !== 'complete') ? report?.retainedStages ?? [] : [])
    if (!stage.keptByUser && !pending.some(item => item.path === stage.path && item.reason === stage.reason))
      pending.push({ path: stage.path, reason: '上次报告保留的升级暂存，归属待核；不要仅凭文件名或空文件自动删除。 / Last reported retained upgrade stage; review ownership before handling. ' + stage.reason })
  return { status: owner?.failure ? 'pending' : result?.status ?? (completed ? 'complete' : 'running'),
    ...(report ? { sourcePath: report.sourcePath } : {}),
    ...(result?.status === 'pending' && report?.operationId ? { conflicts: report.issues.filter(issue => issue.code === 'target-conflict' && issue.choice === 'ready-stage-absent' && !!issue.path)
      .map(issue => ({ path: issue.path!, operationId: report.operationId! })) } : {}),
    ...(result?.status === 'pending' ? { retainedStageChoices: [
      ...(report?.operationId ? report.retainedStages.filter(stage => !stage.keptByUser).map(stage => ({ path: stage.path, operationId: report.operationId! })) : []),
      ...(result.specialStageChoices?.map(stage => ({ path: stage.path, operationId: stage.operationId, owner: stage.owner })) ?? []),
    ] } : {}),
    ...((report?.retainedStages.some(stage => stage.keptByUser) || result?.retainedSpecialStages?.length || completed?.retainedSpecialStages?.length)
      ? { keptRetainedStages: [
        ...(report?.retainedStages.filter(stage => stage.keptByUser).map(stage => ({ path: stage.path, selectedAt: stage.keptByUser!.selectedAt })) ?? []),
        ...(result?.retainedSpecialStages ?? completed?.retainedSpecialStages ?? []).map(stage => ({ path: stage.path, selectedAt: stage.selectedAt, owner: stage.owner })),
      ] } : {}),
    ...(report?.keptCurrent?.length ? { keptCurrent: report.keptCurrent } : {}),
    ...(owner?.failure || result?.detail ? { detail: owner?.failure ?? result?.detail } : {}),
    ...(pending.length ? { pending } : {}),
    ...(result?.sourceDisposition || completed ? { sourceDisposition: result?.sourceDisposition ?? completed?.sourceDisposition ?? 'retained-pending-retirement-review' } : {}),
    ...(result?.sourceAudit ?? completed?.sourceAudit ? { sourceAudit: result?.sourceAudit ?? completed?.sourceAudit } : {}) }
}
