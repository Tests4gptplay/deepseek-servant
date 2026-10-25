import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RetentionPreview } from '../contracts/retention.js'
import type { ServantSource } from './source.js'
import css from './page.module.css'

type CleanupProps = { busy: boolean; onRetention: ServantSource['retention']; t: PropsLocale<'dsh.servant'>['t'] }

/** Preview ended tasks before the owner's explicit destructive confirmation. */
export function ManualTaskCleanup({ preview, busy, onRetention, t }: CleanupProps & { preview?: RetentionPreview }) {
  const [open, setOpen] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const count = new Set([...(preview?.archiveTasks ?? []).map(item => item.taskId),
    ...(preview?.deleteArchives ?? []).map(item => item.taskId)]).size
  async function prepare() {
    setOpen(true); setReady(false); setPreparing(true)
    try { setReady(await onRetention({ action: 'preview' })) }
    finally { setPreparing(false) }
  }
  async function confirm() {
    if (!ready || !preview || busy || preparing || submitting) return
    setSubmitting(true)
    try {
      if (await onRetention({ action: 'sweep', previewId: preview.previewId, confirmation: 'clear-ended-task-records' })) setOpen(false)
      else setReady(false)
    } finally { setSubmitting(false) }
  }
  return <>
    <Button type="button" variant="outline" disabled={busy || preparing || submitting} onClick={() => { void prepare() }}>{t('retention.clean')}</Button>
    <Modal open={open} onClose={() => { if (!submitting) setOpen(false) }} title={t('retention.confirmTitle')} closeLabel={t('retention.cancel')}
      className={css.cleanupDialog} contentClassName={css.cleanupContent} footer={<div className={css.cleanupActions}>
        <Button type="button" variant="primary" data-modal-autofocus disabled={submitting} onClick={() => setOpen(false)}>{t('retention.cancel')}</Button>
        {!ready && <Button type="button" variant="outline" disabled={busy || preparing || submitting} onClick={() => { void prepare() }}>{t('retention.preview')}</Button>}
        <Button type="button" variant="outline" disabled={busy || preparing || submitting || !ready || !preview} onClick={() => { void confirm() }}>{t('retention.confirm')}</Button>
      </div>}>
      <p className={css.cleanupWarning}>{t('retention.confirmWarning')}</p>
      <p className={css.cleanupDetail}>{t('retention.confirmKeep')}</p>
      {ready && <p className={css.cleanupDetail}>{t('retention.confirmCount', { count })}</p>}
    </Modal>
  </>
}

/** Foreground history is a separate owner action, independent of task cleanup. */
export function ManualConversationCleanup({ busy, onRetention, t }: CleanupProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  async function confirm() {
    if (busy || submitting) return
    setSubmitting(true)
    try {
      if (await onRetention({ action: 'clearConversation', confirmation: 'clear-foreground-conversation' })) setOpen(false)
    } finally { setSubmitting(false) }
  }
  return <>
    <Button type="button" variant="outline" disabled={busy || submitting} onClick={() => setOpen(true)}>{t('retention.clearConversation')}</Button>
    <Modal open={open} onClose={() => { if (!submitting) setOpen(false) }} title={t('retention.conversationTitle')} closeLabel={t('retention.cancel')}
      className={css.cleanupDialog} contentClassName={css.cleanupContent} footer={<div className={css.cleanupActions}>
        <Button type="button" variant="primary" data-modal-autofocus disabled={submitting} onClick={() => setOpen(false)}>{t('retention.cancel')}</Button>
        <Button type="button" variant="outline" disabled={busy || submitting} onClick={() => { void confirm() }}>{t('retention.confirm')}</Button>
      </div>}>
      <p className={css.cleanupWarning}>{t('retention.conversationWarning')}</p>
      <p className={css.cleanupDetail}>{t('retention.conversationDetail')}</p>
    </Modal>
  </>
}
