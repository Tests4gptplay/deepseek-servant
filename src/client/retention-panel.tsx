import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { defaultRetentionPolicy, hasRetentionLimits, parseRetentionPolicy, parseRetentionPolicyFile, serializeRetentionPolicy, retentionPolicyBounds, retentionPolicyKeys, type RetentionPolicy, type RetentionPreview, type StorageUsageStats } from '../contracts/retention.js'
import type { ServantSnapshot, ServantSource } from './source.js'
import type { ServantLocaleKey } from './locales.js'
import type { RecordStorageView } from '../contracts/views.js'
import { ManualTaskCleanup, ManualConversationCleanup } from './manual-cleanup.js'
import css from './page.module.css'

type Translate = PropsLocale<'dsh.servant'>['t']
type UsageRow = readonly [ServantLocaleKey, number]

export function RetentionPanel({ stats, preview, outcome, busy, recordStorage, moving, onMoveRecords, onPickDirectory, onRetention, onOpenRecords, t }: {
  stats?: StorageUsageStats
  recordStorage?: RecordStorageView; moving: boolean; onMoveRecords: ServantSource['moveRecords']; onPickDirectory?: () => Promise<string | null>
  preview?: RetentionPreview; outcome?: ServantSnapshot['lastCleanup']; busy: boolean; onRetention: ServantSource['retention']; onOpenRecords: () => Promise<void>; t: Translate
}) {
  const permanent: UsageRow[] = [
    ['retention.chatBytes', stats?.permanent.chatBytes ?? 0],
    ['retention.assistantBytes', stats?.permanent.assistantBytes ?? 0],
    ['retention.skillBytes', stats?.permanent.knowledgeBytes ?? 0],
    ['retention.originBytes', stats?.permanent.originBytes ?? 0],
    ['retention.archiveBytes', stats?.permanent.archiveBytes ?? 0],
    ['retention.planningBytes', stats?.permanent.planningBytes ?? 0],
    ['retention.otherBytes', stats?.permanent.otherBytes ?? 0],
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
      {recordStorage && <RecordLocation storage={recordStorage} busy={moving || busy} moving={moving} onMove={onMoveRecords} onOpen={onOpenRecords} onPickDirectory={onPickDirectory} t={t} />}
      <div className={css.actions}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void onRetention({ action: 'preview' }) }}>{t('retention.preview')}</Button>
        <ManualTaskCleanup preview={preview} busy={busy || moving} onRetention={onRetention} t={t} />
        <ManualConversationCleanup busy={busy || moving} onRetention={onRetention} t={t} />
        <ManualConversationCleanup planning busy={busy || moving} onRetention={onRetention} t={t} />
        <ManualConversationCleanup reset busy={busy || moving} onRetention={onRetention} t={t} />
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
    {rows.map(([key, size]) => <div key={key} className={css.retentionRow}><dt>{t(key)}</dt><dd title={measured ? size.toLocaleString() + ' B' : undefined}>{measured ? bytes(size) : '—'}</dd></div>)}
    <div className={`${css.retentionRow} ${css.retentionSubtotal}`}><dt>{subtotalLabel}</dt><dd>{measured && subtotal !== undefined ? bytes(subtotal) : '—'}</dd></div>
  </dl>
}

function RecordLocation({ storage, busy, moving, onMove, onOpen, onPickDirectory, t }: {
  storage: RecordStorageView; busy: boolean; moving: boolean; onMove: ServantSource['moveRecords']; onOpen(): Promise<void>
  onPickDirectory?: () => Promise<string | null>; t: Translate
}) {
  const id = useId()
  const [directory, setDirectory] = useState(storage.directory)
  const [picking, setPicking] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { setDirectory(storage.directory) }, [storage.directory])
  const dirty = directory.trim() !== storage.directory
  const disabled = busy || picking
  return <form className={css.recordLocation} onSubmit={event => {
    event.preventDefault()
    if (!disabled && dirty && directory.trim()) void onMove(directory.trim(), storage.directory)
  }}>
    <div className={css.recordLocationRow}>
      <label className={css.directoryField} htmlFor={id}><span>{t('retention.directory')}</span>
        <Input id={id} required value={directory} title={directory} disabled={disabled}
          placeholder={t('retention.directoryPlaceholder')} onChange={event => { setDirectory(event.target.value); setError(undefined) }} />
      </label>
      <div className={css.recordLocationActions}>
        {onPickDirectory && <Button type="button" variant="outline" disabled={disabled} onClick={() => {
          setPicking(true); setError(undefined)
          void onPickDirectory().then(selected => { if (selected !== null) setDirectory(selected) })
            .catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setPicking(false))
        }}>{t(picking ? 'settings.directoryPicking' : 'settings.browseDirectory')}</Button>}
        <Button type="button" variant="outline" disabled={disabled || opening} title={t('retention.openCurrentFolder')} onClick={() => {
          setOpening(true)
          void onOpen().finally(() => setOpening(false))
        }}>{t('retention.openFolder')}</Button>
      </div>
    </div>
    <p className={css.muted}>{t('retention.directoryHint')}</p>
    {storage.issues?.map(issue => <p key={issue} role="alert" className={css.errorDetail}>{issue}</p>)}
    {dirty && <>
      <p className={css.muted}>{t('retention.activeDirectory')} <code>{storage.directory}</code></p>
      <div className={css.recordLocationActions}>
        <Button type="submit" variant="primary" disabled={disabled || !directory.trim()}>{t(moving ? 'retention.moving' : 'retention.move')}</Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => { setDirectory(storage.directory); setError(undefined) }}>{t('tasks.discard')}</Button>
      </div>
    </>}
    {error && <p className={css.errorDetail} role="alert">{error}</p>}
    {storage.retainedSource && <p className={css.errorDetail} role="status">{t('retention.oldCopy', { path: storage.retainedSource })}</p>}
    <p className={css.muted}>{t('retention.logLocationHint')}</p>
    {storage.nativeDirectory && <details className={css.nativeLogDirectory}>
      <summary>{t('retention.logDirectory')}</summary><code>{storage.nativeDirectory}</code>
    </details>}
  </form>
}
function RetentionPolicyEditor({ preview, busy, onRetention, t }: { preview: RetentionPreview; busy: boolean; onRetention: ServantSource['retention']; t: Translate }) {
  const [policy, setPolicy] = useState<RetentionPolicy>(() => structuredClone(preview.policy))
  const [fileBusy, setFileBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<ServantLocaleKey>()
  const form = useRef<HTMLFormElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const disabled = busy || fileBusy
  const dirty = retentionPolicyKeys.some(key => policy[key] !== preview.policy[key])
  const fields: Array<{ key: keyof RetentionPolicy; label: ServantLocaleKey; scale?: number }> = [
    { key: 'taskDetailDays', label: 'retention.detailDays' },
    { key: 'archiveDays', label: 'retention.archiveDays' },
    { key: 'maxArchives', label: 'retention.maxArchives' },
    { key: 'maxServantBytes', label: 'retention.maxBytes', scale: 1024 * 1024 },
    { key: 'skillHistoryDays', label: 'retention.skillDays' },
    { key: 'maxFullSkillVersions', label: 'retention.skillVersions' },
    { key: 'maxSkillReceipts', label: 'retention.receipts' },
  ]
  const fail = (error: unknown) => { setNotice(undefined); setError(error instanceof Error ? error.message : String(error)) }
  return <form ref={form} className={css.retentionPolicy} onSubmit={event => {
    event.preventDefault(); setError(undefined); setNotice(undefined)
    try { void onRetention({ action: 'configure', policy: parseRetentionPolicy(policy), expectedRevision: preview.policyRevision }) }
    catch (error) { fail(error) }
  }}>
    <p className={css.retentionPolicyHint}>{t('retention.policyHint')}</p>
    {fields.map(field => <label key={field.key} className={css.field}><span>{t(field.label)}</span><Input type="number" disabled={disabled}
      step={field.scale ? 'any' : 1} min={retentionPolicyBounds[field.key][0] / (field.scale ?? 1)}
      value={policy[field.key] === undefined ? '' : policy[field.key]! / (field.scale ?? 1)} onChange={event => {
        const value = event.target.value
        setPolicy(current => { const next = { ...current }; if (value === '') delete next[field.key]; else next[field.key] = Number(value) * (field.scale ?? 1); return next })
        setError(undefined); setNotice(undefined)
      }} /></label>)}
    <div className={css.retentionPolicyActions}>
      <Button type="submit" variant="primary" size="sm" disabled={disabled || !dirty}>{t('retention.savePolicy')}</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => {
        if (!form.current?.reportValidity()) return
        setError(undefined); setNotice(undefined)
        try {
          const url = URL.createObjectURL(new Blob([serializeRetentionPolicy(policy)], { type: 'application/json;charset=utf-8' }))
          const anchor = document.createElement('a')
          anchor.href = url; anchor.download = 'deepseek-servant-retention-policy.json'
          document.body.append(anchor)
          try { anchor.click() } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
          setNotice('retention.exportReady')
        } catch (error) { fail(error) }
      }}>{t('retention.exportPolicy')}</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => fileInput.current?.click()}>{t('retention.importPolicy')}</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => {
        setPolicy({ ...defaultRetentionPolicy }); setError(undefined); setNotice('retention.resetDraft')
      }}>{t('retention.resetPolicy')}</Button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden disabled={disabled} aria-label={t('retention.importPolicy')} onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (!file) return
        setError(undefined); setNotice(undefined)
        setFileBusy(true)
        void file.text().then(text => { const imported = parseRetentionPolicyFile(text); setPolicy(imported); setNotice('retention.importedDraft') })
          .catch(fail).finally(() => setFileBusy(false))
      }} />
    </div>
    {error && <p className={css.retentionPolicyHint} role="alert">{t('retention.policyError')} {error}</p>}
    {notice && <p className={css.retentionPolicyHint} role="status">{t(notice)}</p>}
  </form>
}

function bytes(value: number): string {
  if (value < 1024) return `${Math.max(0, Math.round(value))} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}
