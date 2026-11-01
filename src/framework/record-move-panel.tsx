import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FrameworkClientApi } from './client-contracts.js'
import css from '../client/page.module.css'

type MoveInput = Parameters<FrameworkClientApi['moveRecords']>[0]
interface Attempt { input: MoveInput; submitted: boolean; promise?: ReturnType<FrameworkClientApi['moveRecords']>; confirmed?: boolean; error?: string }
// Closing Settings is not cancellation. Retain the original browser command so
// its uncertain result is resolved rather than replaced with another move.
const attempts = new WeakMap<FrameworkClientApi, Map<string, Attempt>>()
export function RecordMovePanel({ api, storageScope, settingsRevision, pendingRequest, tr, changed }: {
  api: FrameworkClientApi; storageScope: string; settingsRevision: string; pendingRequest?: Omit<MoveInput, 'mode'>; tr: (cn: string, en: string) => string; changed(): Promise<void>
}) {
  let scoped = attempts.get(api)
  if (!scoped) { scoped = new Map(); attempts.set(api, scoped) }
  const retained = scoped
  const [pending, setPending] = useState(() => {
    const existing = retained.get(storageScope)
    if (existing) return existing
    if (!pendingRequest) return undefined
    const restored: Attempt = { input: { ...pendingRequest, mode: 'local' }, submitted: true }
    retained.set(storageScope, restored)
    return restored
  })
  const [directory, setDirectory] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState(''), [error, setError] = useState(pending?.error ?? '')
  const active = useRef(true)
  const submit = async (attempt: Attempt) => {
    attempt.submitted = true; retained.set(storageScope, attempt)
    setBusy(true); setError('')
    try {
      if (!attempt.confirmed) {
        attempt.promise ??= api.moveRecords(attempt.input)
        await attempt.promise
        attempt.confirmed = true
      }
      if (!active.current) return
      await changed()
      if (!active.current) return
      retained.delete(storageScope); setPending(undefined); setDirectory('')
      setResult(tr('记录已搬家并应用。宿主原生日志位置未改变。', 'Records moved and applied. Native Host log locations were not changed.'))
    } catch (reason) {
      attempt.error = reason instanceof Error ? reason.message : String(reason)
      if (active.current) setError(attempt.error)
    } finally { attempt.promise = undefined; if (active.current) setBusy(false) }
  }
  useEffect(() => {
    active.current = true
    const attempt = retained.get(storageScope)
    if (attempt?.promise || attempt?.confirmed) void submit(attempt)
    return () => { active.current = false }
  }, [])
  const prepare = () => {
    if (!directory.trim()) return
    const attempt: Attempt = { input: { mode: 'local', storageScope, expectedRevision: settingsRevision, commandId: crypto.randomUUID(), directory }, submitted: false }
    retained.set(storageScope, attempt); setPending(attempt); setError(''); setResult('')
  }
  return <section className={css.section} aria-label={tr('记录搬家', 'Move record storage')}>
    <h3>{tr('记录搬家', 'Move record storage')}</h3>
    {!pending && <><label className={css.field}><span>{tr('目标记录目录（绝对路径）', 'Target record directory (absolute path)')}</span><Input value={directory} disabled={busy} onChange={event => setDirectory(event.target.value)} /></label>
      <Button disabled={busy || !directory.trim()} onClick={prepare}>{tr('搬家并应用', 'Move and apply')}</Button></>}
    {pending && <div role="group" aria-label={tr('确认记录搬家', 'Confirm record move')}>
      <code>{pending.input.directory}</code>
      <p>{tr('这不是单纯修改目录：会暂停本插件在 Local 和 Git 两种模式中拥有的执行，确认已停止后搬迁技术记录与 Local 数据库，保留原逻辑范围、身份和完整正文；宿主原生日志不搬迁。不会自动删除你选择的目录。', 'This is not merely a directory setting: it pauses executions owned by this plugin in both Local and Git modes, confirms they stopped, then moves technical records and the Local database while preserving logical scope, identities and full originals. Native Host logs are not moved. The selected directories are not automatically deleted.')}</p>
      <Button disabled={busy} onClick={() => void submit(pending)}>{pending.submitted ? tr('核对并重试原搬家', 'Resolve and retry original move') : tr('确认搬家并应用', 'Confirm move and apply')}</Button>
      {!pending.submitted && <Button disabled={busy} onClick={() => { retained.delete(storageScope); setPending(undefined); setError('') }}>{tr('取消', 'Cancel')}</Button>}
      {pending.submitted && <p>{tr('请求已发送；结果未确认时保留原命令、原目录和原设置版本。关闭面板不会撤销已接纳的搬家。', 'The request was sent. An unconfirmed outcome retains the original command, locations and settings revision. Closing this panel does not cancel an accepted move.')}</p>}
    </div>}
    {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
  </section>
}
