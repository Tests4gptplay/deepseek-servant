import * as React from 'react'
import type { FrameworkLocalUpgradeStatus } from './client-contracts.js'
import type { LocalUpgradeSpecialStageOwner } from './local-upgrade-completion.js'
const h = React.createElement

/** A projection of the existing one-time upgrade, separate from participation
 * and task controls. Completion never presents retained SQL as disposed. */
export function LocalUpgradeStatus({ value, tr, className, onKeepCurrent, onKeepStage }: { value?: FrameworkLocalUpgradeStatus; tr: (cn: string, en: string) => string; className?: string;
  onKeepCurrent?: (path: string, operationId: string) => Promise<void>; onKeepStage?: (path: string, operationId: string, owner?: LocalUpgradeSpecialStageOwner) => Promise<void> }) {
  if (!value) return null
  const title = value.status === 'complete' && value.keptCurrent?.length ? tr('Local 升级处理完成；部分旧原文未导出', 'Local upgrade resolved; some original bytes were not exported')
    : value.status === 'complete' ? tr('Local 文件转换已完成', 'Local file conversion completed')
    : value.status === 'running' ? tr('正在转换原有 Local 记录', 'Converting existing Local records') : tr('Local 文件转换仍有待处理事项', 'Local file conversion has pending work')
  const audit = value.sourceAudit
  const pending = [...value.pending ?? [], ...audit?.issues.map(issue => ({ path: issue.path ?? audit.sourcePath, reason: issue.message })) ?? []]
  const details = [
    ...(pending.map((item, index) => h('li', { key: 'pending:' + index }, item.path + ': ' + item.reason))),
    ...(value.keptCurrent?.map(item => h('li', { key: 'kept:' + item.path }, item.path + ': ' + tr('已按您的选择保留当前物理状态；此行没有重新导出，原 SQL 仍保留。', 'Current physical state kept by your choice; this row was not re-exported and the original SQL remains.'))) ?? []),
    ...(value.keptRetainedStages?.map(item => h('li', { key: 'stage:' + (item.owner?.kind ?? 'startup') + ':' + (item.owner?.id ?? '') + ':' + item.path },
      (item.owner ? item.owner.kind + ': ' + item.owner.id + ' / ' : '') + item.path + ': ' + tr('已按您的选择保留此待判暂存路径，不交清理；不证明文件现在仍存在或原行已导出。原 SQL 仍保留。', 'This ambiguous staging path was kept out of cleanup by your choice; its present existence and source-row export are not asserted. Original SQL remains.'))) ?? []),
    ...(audit?.onlyOriginalBytesInSql.map(item => h('li', { key: 'original:' + item.path }, tr('仅原 SQL 保留这些字节', 'Original bytes retained only in SQL') + ': ' + item.path,
      item.convertedTargets.length ? ' (' + tr('已转换位置', 'Converted locations') + ': ' + item.convertedTargets.join(', ') + ')' : '')) ?? []),
    ...(audit?.metadataKeys.map(key => h('li', { key: 'metadata:' + key }, tr('待核对的原元数据', 'Original metadata requiring review') + ': ' + key)) ?? []),
    ...(audit?.gitOperationIds.map(id => h('li', { key: 'operation:' + id }, tr('待核对的原 Git 操作记录', 'Original Git operation requiring review') + ': ' + id)) ?? []),
    ...(audit?.otherTables.map(name => h('li', { key: 'table:' + name }, tr('待核对的原数据表', 'Original table requiring review') + ': ' + name)) ?? []),
  ]
  return h('section', { className, 'aria-label': tr('Local 记录转换', 'Local record conversion') },
    h('p', { role: 'status' }, title),
    value.sourceDisposition ? h('p', null, tr('原 SQL 仍保留，后续处置待核对；未执行清理。', 'The original SQL is retained pending disposition review; it has not been cleaned up.')) : null,
    value.detail ? h('p', null, value.detail) : null,
    details.length ? h('details', null, h('summary', null, tr('查看待处理记录', 'View pending records')), h('ul', null, ...details)) : null,
    onKeepCurrent && value.status === 'pending' ? value.conflicts?.map(item => h(KeepCurrentChoice, { key: 'choice:' + item.path, item, tr, onKeepCurrent })) : null,
    onKeepStage && value.status === 'pending' ? value.retainedStageChoices?.map(item => h(KeepRetainedStageChoice, { key: 'stage-choice:' + (item.owner?.kind ?? 'startup') + ':' + (item.owner?.id ?? '') + ':' + item.operationId + ':' + item.path, item, tr, onKeepStage })) : null)
}

function KeepRetainedStageChoice({ item, tr, onKeepStage }: { item: { path: string; operationId: string; owner?: LocalUpgradeSpecialStageOwner }; tr: (cn: string, en: string) => string;
  onKeepStage: (path: string, operationId: string, owner?: LocalUpgradeSpecialStageOwner) => Promise<void> }) {
  const [selected, setSelected] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  return h('div', null,
    h('p', null, (item.owner ? item.owner.kind + ': ' + item.owner.id + ' / ' : '') + item.path + ': ' + tr('此路径是上次转换留下的归属待判暂存。选择仅表示保留它、不交清理，不证明文件现在仍存在或原 SQL 行已导出；其他转换仍须正常核验。',
      'This path is an ambiguous stage retained by the previous conversion. Choosing to keep it only excludes cleanup; it does not prove the file still exists or that the original SQL row was exported. Other conversion checks still apply.')),
    selected ? h('button', { type: 'button', disabled: busy, onClick: () => {
      setBusy(true); setError(''); void onKeepStage(item.path, item.operationId, item.owner).then(() => setSelected(false), cause => setError(String(cause))).finally(() => setBusy(false))
    } }, tr('确认保留此暂存，不交清理', 'Confirm keeping this stage out of cleanup'))
      : h('button', { type: 'button', disabled: busy, onClick: () => setSelected(true) }, tr('选择保留此待判暂存', 'Choose to keep this ambiguous stage')),
    selected ? h('button', { type: 'button', disabled: busy, onClick: () => setSelected(false) }, tr('取消选择', 'Cancel choice')) : null,
    error ? h('p', { role: 'alert' }, error) : null)
}

function KeepCurrentChoice({ item, tr, onKeepCurrent }: { item: { path: string; operationId: string }; tr: (cn: string, en: string) => string;
  onKeepCurrent: (path: string, operationId: string) => Promise<void> }) {
  const [selected, setSelected] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  return h('div', null,
    h('p', null, item.path + ': ' + tr('上次核查发现原暂存已消失，无法确认是否交付；提交前会再次核对。保留现状不会恢复被删目标，此行不会从原 SQL 重新导出，原 SQL 仍保留。',
      'The last check found the original stage absent, so delivery cannot be confirmed; it will be checked again before saving. Keeping the current state will not restore a deleted target; the old bytes remain in the original SQL.')),
    selected
      ? h('button', { type: 'button', disabled: busy, onClick: () => {
        setBusy(true); setError(''); void onKeepCurrent(item.path, item.operationId).then(() => setSelected(false), cause => setError(String(cause))).finally(() => setBusy(false))
      } }, tr('确认保留当前状态，不导出该行', 'Confirm keeping current state without exporting this row'))
      : h('button', { type: 'button', disabled: busy, onClick: () => setSelected(true) }, tr('选择保留当前状态', 'Choose to keep current state')),
    selected ? h('button', { type: 'button', disabled: busy, onClick: () => setSelected(false) }, tr('取消选择', 'Cancel choice')) : null,
    error ? h('p', { role: 'alert' }, error) : null)
}

/** Reading old identities never hides already converted Tasks. */
export function OriginalTaskReadStatus({ status, tr }: { status?: 'loading' | 'failed'; tr: (cn: string, en: string) => string }) {
  if (!status) return null
  return h('p', { role: 'status' }, status === 'loading'
    ? tr('正在读取原有任务记录，已转换任务可继续使用。', 'Reading original task records. Converted tasks remain available.')
    : tr('原有任务记录尚未读出，可刷新重试；已转换任务仍可使用。', 'Original task records could not be read. Refresh to retry; converted tasks remain available.'))
}
