import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { defaultRetentionPolicy, hasRetentionLimits, parseRetentionPolicy, parseRetentionPolicyFile, serializeRetentionPolicy, retentionPolicyBounds, retentionPolicyKeys, type RetentionPolicy, type RetentionPreview } from '../contracts/retention.js'
import type { ServantSnapshot, ServantSource } from './source.js'
import type { ServantLocaleKey } from './locales.js'
import type { RecordStorageView } from '../contracts/views.js'
import css from './page.module.css'

type Translate = PropsLocale<'dsh.servant'>['t']
export function RetentionPanel({ preview, outcome, busy, recordStorage, moving, onMoveRecords, onPickDirectory, onRetention, onOpenRecords, t }: {
  recordStorage?: RecordStorageView; moving: boolean; onMoveRecords: ServantSource['moveRecords']; onPickDirectory?: () => Promise<string | null>
  preview?: RetentionPreview; outcome?: ServantSnapshot['lastCleanup']; busy: boolean; onRetention: ServantSource['retention']; onOpenRecords: () => Promise<void>; t: Translate
}) {
  useEffect(() => { void onRetention({ action: 'preview' }) }, [onRetention])
  return <section className={css.retention} aria-label={t('retention.title')}>
    <div className={`${css.rowBetween} ${css.retentionHeader}`}>
      <h2>{t('retention.title')}</h2>
      <Button type="button" variant="outline" size="sm" disabled={busy || moving} title={t('retention.previewHint')}
        onClick={() => { void onRetention({ action: 'preview' }) }}>{t('retention.preview')}</Button>
    </div>
    <p className={css.muted}>{t('retention.description')}</p>
    {recordStorage && <RecordLocation storage={recordStorage} busy={moving || busy} moving={moving} onMove={onMoveRecords} onOpen={onOpenRecords} onPickDirectory={onPickDirectory} t={t} />}
    {!preview && busy && <div className={css.empty}><StateDot state="ongoing" /></div>}
    {preview && <>
      <div className={css.retentionStats}>
        <dl className={css.retentionTotal}>
          <div><dt>{t('retention.servantBytes')}</dt><dd>{bytes(preview.totals.servantBytes)}</dd></div>
        </dl>
        {([
          [
            ['retention.skillBytes', bytes(preview.totals.knowledgeBytes)],
            ['retention.assistantBytes', bytes(preview.totals.assistantBytes)],
            ['retention.identityBytes', bytes(preview.totals.tombstoneBytes)],
            ['retention.foregroundBytes', bytes(preview.totals.foregroundSessionBytes)],
          ],
          [
            ['retention.taskBytes', bytes(preview.totals.taskBytes)],
            ['retention.nativeBytes', bytes(preview.totals.nativeSessionBytes)],
          ],
        ] as Array<Array<[ServantLocaleKey, string]>>).map(group => <dl key={group[0][0]}>
          {group.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}
        </dl>)}
      </div>
      <p>{t('retention.plan', { archive: preview.archiveTasks.length, remove: preview.deleteArchives.length, skills: preview.compactSkills.length, bytes: bytes(preview.totals.estimatedReclaimedBytes) })}</p>
      <p className={css.muted}>{t('retention.protected', { count: preview.blocked.length, bytes: bytes(preview.blocked.filter(item => item.kind !== 'native').reduce((sum, item) => sum + item.bytes, 0)) })}</p>
      {preview.totals.overBudgetBytes > 0 && <p className={css.notice}>{t('retention.overBudget', { bytes: bytes(preview.totals.overBudgetBytes) })}</p>}
      <p className={css.muted}>{t('retention.nativeHint')}</p>
      {(preview.totals.nativeSizeUnknown + preview.totals.foregroundSizeUnknown) > 0 && <p className={css.muted}>{t('retention.unknownSizes', { count: preview.totals.nativeSizeUnknown + preview.totals.foregroundSizeUnknown })}</p>}
      <div className={css.actions}><Button variant="outline" disabled={busy || moving || !(preview.archiveTasks.length || preview.deleteArchives.length || preview.compactSkills.length || preview.nativeCleanup.length)}
        onClick={() => { void onRetention({ action: 'sweep', previewId: preview.previewId }) }}>{t('retention.clean')}</Button><span className={css.muted}>{t(hasRetentionLimits(preview.policy) ? 'retention.automatic' : 'retention.unlimited')}</span></div>
      {outcome && <p role="status">{t('retention.actual', { bytes: bytes(outcome.reclaimedServantBytes), native: bytes(outcome.nativeReclaimedBytes) })}</p>}
      {!!outcome?.skipped.length && <details><summary>{t('retention.skipped', { count: outcome.skipped.length })}</summary><ul>{outcome.skipped.map((item, index) => <li key={`${item.id}:${index}`}><code>{item.id}</code> · {item.reason}</li>)}</ul></details>}
      <details><summary>{t('retention.policy')}</summary><RetentionPolicyEditor key={preview.policyRevision} preview={preview} busy={busy || moving} onRetention={onRetention} t={t} /></details>
    </>}
  </section>
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
        <Input id={id} required maxLength={4000} value={directory} title={directory} disabled={disabled}
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
      step={field.scale ? 'any' : 1} min={retentionPolicyBounds[field.key][0] / (field.scale ?? 1)} max={retentionPolicyBounds[field.key][1] / (field.scale ?? 1)}
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
        if (file.size > 64 * 1024) { setError(t('retention.importTooLarge')); return }
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
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}
