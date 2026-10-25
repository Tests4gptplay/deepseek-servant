import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RetentionPolicy, RetentionPreview, StorageUsageStats } from '../contracts/retention.js'
import type { ServantSnapshot, ServantSource } from './source.js'
import type { ServantLocaleKey } from './locales.js'
import css from './page.module.css'

type Translate = PropsLocale<'dsh.servant'>['t']
type UsageRow = readonly [ServantLocaleKey, number]

export function RetentionPanel({ stats, preview, outcome, busy, onRetention, t }: {
  stats?: StorageUsageStats
  preview?: RetentionPreview
  outcome?: ServantSnapshot['lastCleanup']
  busy: boolean
  onRetention: ServantSource['retention']
  t: Translate
}) {
  const permanent: UsageRow[] = [
    ['retention.chatBytes', stats?.permanent.chatBytes ?? 0],
    ['retention.assistantBytes', stats?.permanent.assistantBytes ?? 0],
    ['retention.skillBytes', stats?.permanent.knowledgeBytes ?? 0],
    ['retention.originBytes', stats?.permanent.originBytes ?? 0],
    ['retention.archiveBytes', stats?.permanent.archiveBytes ?? 0],
    ['retention.historyBytes', stats?.permanent.historyBytes ?? 0],
  ]
  const temporary: UsageRow[] = [
    ['retention.activeTaskBytes', stats?.temporary.taskBytes ?? 0],
    ['retention.plannerMemoryBytes', stats?.temporary.plannerMemoryBytes ?? 0],
    ['retention.plannerNoteBytes', stats?.temporary.plannerNoteBytes ?? 0],
    ['retention.workerReplyBytes', stats?.temporary.workerReplyBytes ?? 0],
    ['retention.executionBytes', stats?.temporary.executionBytes ?? 0],
    ['retention.recoveryBytes', stats?.temporary.recoveryBytes ?? 0],
  ]
  return <section className={css.retention} aria-label={t('retention.title')}>
    <div className={css.retentionHeading}>
      <h2>{t('retention.title')}</h2>
      <span className={css.retentionGrandTotal}>{t('retention.total')} <strong>{stats ? bytes(stats.totalBytes) : '—'}</strong></span>
    </div>
    <div className={css.retentionColumns}>
      <UsageColumn rows={permanent} subtotalLabel={t('retention.permanentTotal')} subtotal={stats?.permanentBytes} measured={!!stats} t={t} />
      <UsageColumn rows={temporary} subtotalLabel={t('retention.temporaryTotal')} subtotal={stats?.temporaryBytes} measured={!!stats} t={t} />
    </div>
    <details className={css.retentionManage}>
      <summary>{t('retention.manage')}</summary>
      <div className={css.actions}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void onRetention({ action: 'preview' }) }}>{t('retention.preview')}</Button>
        <Button size="sm" variant="outline" disabled={busy || !preview || !(preview.archiveTasks.length || preview.deleteArchives.length || preview.compactSkills.length || preview.nativeCleanup.length)}
          onClick={() => { if (preview) void onRetention({ action: 'sweep', previewId: preview.previewId }) }}>{t('retention.clean')}</Button>
      </div>
      {preview && <>
        <p className={css.muted}>{t('retention.plan', { archive: preview.archiveTasks.length, remove: preview.deleteArchives.length,
          skills: preview.compactSkills.length, bytes: bytes(preview.totals.estimatedReclaimedBytes) })}</p>
        <details><summary>{t('retention.policy')}</summary><RetentionPolicyEditor key={preview.policyRevision} preview={preview} busy={busy} onRetention={onRetention} t={t} /></details>
      </>}
      {outcome && <p role="status">{t('retention.actual', { bytes: bytes(outcome.reclaimedServantBytes) })}</p>}
      {!!outcome?.skipped.length && <details><summary>{t('retention.skipped', { count: outcome.skipped.length })}</summary>
        <ul>{outcome.skipped.map((item, index) => <li key={`${item.id}:${index}`}><code>{item.id}</code> · {item.reason}</li>)}</ul>
      </details>}
    </details>
  </section>
}

function UsageColumn({ rows, subtotalLabel, subtotal, measured, t }: {
  rows: UsageRow[]; subtotalLabel: string; subtotal?: number; measured: boolean; t: Translate
}) {
  return <dl className={css.retentionGroup}>
    {rows.map(([key, size]) => <div key={key} className={css.retentionRow}><dt>{t(key)}</dt><dd>{measured ? bytes(size) : '—'}</dd></div>)}
    <div className={`${css.retentionRow} ${css.retentionSubtotal}`}><dt>{subtotalLabel}</dt><dd>{measured && subtotal !== undefined ? bytes(subtotal) : '—'}</dd></div>
  </dl>
}

function RetentionPolicyEditor({ preview, busy, onRetention, t }: { preview: RetentionPreview; busy: boolean; onRetention: ServantSource['retention']; t: Translate }) {
  const [policy, setPolicy] = useState<RetentionPolicy>(() => structuredClone(preview.policy))
  const fields: Array<{ key: keyof RetentionPolicy; label: ServantLocaleKey; min: number; max: number; scale?: number }> = [
    { key: 'taskDetailDays', label: 'retention.detailDays', min: 0, max: 3650 },
    { key: 'archiveDays', label: 'retention.archiveDays', min: 0, max: 36500 },
    { key: 'maxArchives', label: 'retention.maxArchives', min: 1, max: 100000 },
    { key: 'maxServantBytes', label: 'retention.maxBytes', min: 1, max: 1048576, scale: 1024 * 1024 },
    { key: 'skillHistoryDays', label: 'retention.skillDays', min: 0, max: 3650 },
    { key: 'maxFullSkillVersions', label: 'retention.skillVersions', min: 0, max: 1000 },
    { key: 'maxSkillReceipts', label: 'retention.receipts', min: 1, max: 10000 },
  ]
  return <form className={css.retentionPolicy} onSubmit={event => { event.preventDefault(); void onRetention({ action: 'configure', policy, expectedRevision: preview.policyRevision }) }}>
    {fields.map(field => <label key={field.key} className={css.field}><span>{t(field.label)}</span><Input type="number" required step="1" min={field.min} max={field.max}
      value={policy[field.key] / (field.scale ?? 1)} onChange={event => { setPolicy({ ...policy, [field.key]: Number(event.target.value) * (field.scale ?? 1) }) }} /></label>)}
    <div className={css.actions}><Button type="submit" variant="primary" size="sm" disabled={busy || JSON.stringify(policy) === JSON.stringify(preview.policy)}>{t('retention.savePolicy')}</Button></div>
  </form>
}

function bytes(value: number): string {
  if (value < 1024) return `${Math.max(0, Math.round(value))} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}
