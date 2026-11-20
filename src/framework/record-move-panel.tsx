import { frameworkErrorText, errorMessage, isRecordMoveNotStarted } from './client-error.js'
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FrameworkClientApi } from './client-contracts.js'
import css from '../client/page.module.css'

type MoveInput = Parameters<FrameworkClientApi['moveRecords']>[0]
interface Attempt { input: MoveInput; submitted: boolean; promise?: ReturnType<FrameworkClientApi['moveRecords']>; confirmed?: boolean; outcome?: Awaited<ReturnType<FrameworkClientApi['moveRecords']>>['recordMoveOutcome']; error?: string }
// Closing Settings is not cancellation. Retain the original browser command so
// its uncertain result is resolved rather than replaced with another move.
const attempts = new WeakMap<FrameworkClientApi, Map<string, Attempt>>()
export function RecordMovePanel({ api, storageScope, settingsRevision, pendingRequest, currentDirectory, onPickDirectory, tr, changed }: {
  api: FrameworkClientApi; storageScope: string; settingsRevision: string; currentDirectory: string; onPickDirectory?: (initialPath?: string) => Promise<string | null>; pendingRequest?: Omit<MoveInput, 'mode'> & { canAbandon?: boolean }; tr: (cn: string, en: string) => string; changed(): Promise<void>
}) {
  let scoped = attempts.get(api)
  if (!scoped) { scoped = new Map(); attempts.set(api, scoped) }
  const retained = scoped
  const [pending, setPending] = useState(() => {
    const existing = retained.get(storageScope)
    if (existing) return existing
    if (!pendingRequest) return undefined
    const { canAbandon: _canAbandon, ...input } = pendingRequest
    const restored: Attempt = { input: { ...input, mode: 'local' }, submitted: true }
    retained.set(storageScope, restored)
    return restored
  })
  const [directory, setDirectory] = useState(currentDirectory), [busy, setBusy] = useState(false), [result, setResult] = useState(''), [error, setError] = useState(pending?.error ?? '')
  const [checkedCanAbandon, setCheckedCanAbandon] = useState<boolean>()
  const [abandoning, setAbandoning] = useState(false)
  const canAbandon = checkedCanAbandon ?? (pendingRequest?.canAbandon === true && pendingRequest.commandId === pending?.input.commandId)
  const active = useRef(true)
  const [picking, setPicking] = useState(false)
  useEffect(() => { if (!pending) setDirectory(currentDirectory) }, [currentDirectory])
  const submit = async (attempt: Attempt) => {
    attempt.submitted = true; retained.set(storageScope, attempt)
    setCheckedCanAbandon(false)
    setBusy(true); setError('')
    try {
      if (!attempt.confirmed) {
        attempt.promise ??= api.moveRecords(attempt.input)
        const response = await attempt.promise
        attempt.outcome = response.recordMoveOutcome
        attempt.confirmed = true
      }
      if (!active.current) return
      retained.delete(storageScope); setPending(undefined); setDirectory(attempt.outcome?.directory ?? attempt.input.directory)
      const outcome = attempt.outcome
      setResult(outcome?.status === 'current-location'
        ? tr('原请求的完成结果尚未确认，本次没有再次搬迁。核对时的记录目录：', 'The original request’s completion is unconfirmed; no move was repeated. Record directory at this check: ') + outcome.directory
        : tr('记录已搬家并应用。宿主原生日志位置未改变。', 'Records moved and applied. Native Host log locations were not changed.')
          + (outcome ? tr(' 核对时的记录目录：', ' Record directory at this check: ') + outcome.directory : '')
          + (outcome?.retainedSource ? tr(' 原记录目录已保留：', ' Original records folder retained: ') + outcome.retainedSource : '')
          + (outcome?.retainedTargets?.length ? tr(' 目标目录原有记录保留在：', ' Existing destination records retained at: ') + outcome.retainedTargets.join('；') : ''))
      void changed().catch(reason => { if (active.current) setError(frameworkErrorText(reason)) })
    } catch (reason) {
      if (isRecordMoveNotStarted(reason)) {
        retained.delete(storageScope)
        if (active.current) { setPending(undefined); setDirectory(attempt.input.directory); setError(errorMessage(reason)) }
        return
      }
      attempt.error = frameworkErrorText(reason) || errorMessage(reason)
      if (active.current) {
        setError(attempt.error)
        try {
          // A pending move can hold the records closed. Its settings header is
          // available without waiting for conversation or archive reads.
          const { pendingRecordMove: status } = await api.view({ mode: 'local', headerOnly: true })
          if (active.current) setCheckedCanAbandon(status?.canAbandon === true
            && status.commandId === attempt.input.commandId && status.storageScope === attempt.input.storageScope)
        } catch { /* Keep retry available; no confirmed abandonment state was received. */ }
      }
    } finally { attempt.promise = undefined; if (active.current) setBusy(false) }
  }
  useEffect(() => {
    active.current = true
    const attempt = retained.get(storageScope)
    if (attempt?.promise || attempt?.confirmed) void submit(attempt)
    return () => { active.current = false }
  }, [])
  const abandon = async (attempt: Attempt) => {
    if (!api.abandonRecordMove || !canAbandon || busy) return
    setBusy(true); setAbandoning(true); setError('')
    try {
      const outcome = await api.abandonRecordMove(attempt.input)
      retained.delete(storageScope)
      if (!active.current) return
      setPending(undefined); setDirectory(outcome.directory)
      setResult(tr('已放弃本次搬迁，继续使用原记录目录。已复制的文件保留在：', 'Move abandoned. The original records folder remains in use. Copied files remain at: ') + outcome.retainedTarget)
      void changed().catch(reason => { if (active.current) setError(frameworkErrorText(reason)) })
    } catch (reason) { if (active.current) setError(frameworkErrorText(reason) || errorMessage(reason)) }
    finally { if (active.current) { setBusy(false); setAbandoning(false) } }
  }
  const changeDirectory = (directory: string) => {
    if (!directory.trim() || directory.trim() === currentDirectory || busy || pending) return
    const attempt: Attempt = { input: { mode: 'local', storageScope, expectedRevision: settingsRevision, commandId: crypto.randomUUID(), directory: directory.trim() }, submitted: false }
    retained.set(storageScope, attempt); setDirectory(directory); setPending(attempt); setError(''); setResult('')
    void submit(attempt)
  }
  return <section className={css.recordLocation} aria-label={tr('记录保存文件夹', 'Records folder')}>
    <div className={css.recordLocationRow}>
      <label className={css.directoryField}><span>{tr('记录保存文件夹', 'Records folder')}</span><Input value={pending?.input.directory ?? directory} title={pending?.input.directory ?? directory} disabled={busy || !!pending || picking} onChange={event => setDirectory(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); changeDirectory(directory) } }} /></label>
      {onPickDirectory && <Button type="button" variant="outline" disabled={busy || !!pending || picking} onClick={() => {
        setPicking(true); setError('')
        void onPickDirectory(currentDirectory).then(selected => { if (selected !== null && active.current) changeDirectory(selected) }, reason => { if (active.current) setError(frameworkErrorText(reason)) }).finally(() => { if (active.current) setPicking(false) })
      }}>{tr('选择文件夹', 'Choose folder')}</Button>}
    </div>
    {pending && pending.input.directory !== currentDirectory && <p className={css.muted}>{tr('当前使用：', 'Currently in use: ')}{currentDirectory}</p>}
    <p className={css.muted}>{tr('选择新文件夹，或输入新路径后按回车，即会迁移现有记录。', 'Choose a new folder or type a path and press Enter to move your existing records.')}</p>
    {busy && <div className={css.recordMoveProgress} role="status"><progress aria-label={abandoning ? tr('正在放弃搬迁', 'Abandoning move') : tr('正在迁移记录', 'Moving records')} /><span>{abandoning ? tr('正在放弃本次搬迁…', 'Abandoning this move…') : tr('正在迁移记录…', 'Moving records…')}</span></div>}
    {pending && !busy && <div className={css.actions}><Button type="button" variant="outline" onClick={() => void submit(pending)}>{tr('重试迁移', 'Retry move')}</Button>{api.abandonRecordMove && canAbandon && <Button type="button" variant="outline" onClick={() => void abandon(pending)}>{tr('放弃本次搬迁', 'Abandon this move')}</Button>}</div>}
    {pending && !busy && canAbandon && api.abandonRecordMove && <p className={css.muted}>{tr('放弃后继续使用原记录目录；已复制到新目录的文件会保留。', 'Abandoning keeps the original records folder in use. Files already copied to the new folder are retained.')}</p>}
    {error && <p className={css.errorDetail} role="alert">{error}</p>}{result && <p className={css.muted} role="status">{result}</p>}
  </section>
}
