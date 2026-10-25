import { useEffect, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RetentionPolicy, RetentionPreview } from '../contracts/retention.js'
import type { ServantSnapshot, ServantSource } from './source.js'
import type { ServantLocaleKey } from './locales.js'
import css from './page.module.css'

type Translate = PropsLocale<'dsh.servant'>['t']
export function RetentionPanel({ preview, outcome, busy, onRetention, onOpenRecords, t }: {
  preview?: RetentionPreview; outcome?: ServantSnapshot['lastCleanup']; busy: boolean; onRetention: ServantSource['retention']; onOpenRecords: () => Promise<void>; t: Translate
}) {
  useEffect(() => { void onRetention({ action: 'preview' }) }, [onRetention])
  return <section className={css.retention} aria-label={t('retention.title')}>
    <div className={`${css.rowBetween} ${css.retentionHeader}`}>
      <h2>{t('retention.title')}</h2>
      <div className={css.retentionActions}>
        <Button size="sm" onClick={() => { void onOpenRecords() }}>{t('retention.openFolder')}</Button>
        <Button size="sm" disabled={busy} title={t('retention.previewHint')} onClick={() => { void onRetention({ action: 'preview' }) }}>{t('retention.preview')}</Button>
      </div>
    </div>
    <p className={css.muted}>{t('retention.description')}</p>
    {!preview && busy && <div className={css.empty}><StateDot state="ongoing" /></div>}
    {preview && <>
      <dl className={css.retentionStats}>
        {([
          ['retention.servantBytes', bytes(preview.totals.servantBytes)], ['retention.taskBytes', bytes(preview.totals.taskBytes)],
          ['retention.skillBytes', bytes(preview.totals.knowledgeBytes)], ['retention.assistantBytes', bytes(preview.totals.assistantBytes)],
          ['retention.identityBytes', bytes(preview.totals.tombstoneBytes)], ['retention.nativeBytes', bytes(preview.totals.nativeSessionBytes)],
          ['retention.foregroundBytes', bytes(preview.totals.foregroundSessionBytes)],
        ] as Array<[ServantLocaleKey, string]>).map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}
      </dl>
      <p>{t('retention.plan', { archive: preview.archiveTasks.length, remove: preview.deleteArchives.length, skills: preview.compactSkills.length, bytes: bytes(preview.totals.estimatedReclaimedBytes) })}</p>
      <p className={css.muted}>{t('retention.protected', { count: preview.blocked.length, bytes: bytes(preview.blocked.filter(item => item.kind !== 'native').reduce((sum, item) => sum + item.bytes, 0)) })}</p>
      {preview.totals.overBudgetBytes > 0 && <p className={css.notice}>{t('retention.overBudget', { bytes: bytes(preview.totals.overBudgetBytes) })}</p>}
      <p className={css.muted}>{t('retention.nativeHint')}</p>
      {(preview.totals.nativeSizeUnknown + preview.totals.foregroundSizeUnknown) > 0 && <p className={css.muted}>{t('retention.unknownSizes', { count: preview.totals.nativeSizeUnknown + preview.totals.foregroundSizeUnknown })}</p>}
      <div className={css.actions}><Button variant="outline" disabled={busy || !(preview.archiveTasks.length || preview.deleteArchives.length || preview.compactSkills.length || preview.nativeCleanup.length)}
        onClick={() => { void onRetention({ action: 'sweep', previewId: preview.previewId }) }}>{t('retention.clean')}</Button><span className={css.muted}>{t('retention.automatic')}</span></div>
      {outcome && <p role="status">{t('retention.actual', { bytes: bytes(outcome.reclaimedServantBytes), native: bytes(outcome.nativeReclaimedBytes) })}</p>}
      {!!outcome?.skipped.length && <details><summary>{t('retention.skipped', { count: outcome.skipped.length })}</summary><ul>{outcome.skipped.map((item, index) => <li key={`${item.id}:${index}`}><code>{item.id}</code> · {item.reason}</li>)}</ul></details>}
      <details><summary>{t('retention.policy')}</summary><RetentionPolicyEditor key={preview.policyRevision} preview={preview} busy={busy} onRetention={onRetention} t={t} /></details>
    </>}
  </section>
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
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}
