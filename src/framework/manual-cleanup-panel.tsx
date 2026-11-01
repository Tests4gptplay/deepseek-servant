import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FrameworkClientApi } from './client-contracts.js'
import type { ManualTaskCleanupPreview } from './manual-cleanup.js'
import css from '../client/page.module.css'

type Action = 'tasks' | 'conversation' | 'planning'
/** Three separate, explicit Local confirmations; no scheduled retention. */
export function ManualCleanupPanel({ api, storageScope, tr, changed }: {
  api: FrameworkClientApi; storageScope: string; tr: (cn: string, en: string) => string; changed(): Promise<void>
}) {
  const [pending, setPending] = useState<{ action: Action; commandId: string; preview?: ManualTaskCleanupPreview; submitted?: boolean }>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [usage, setUsage] = useState<Awaited<ReturnType<FrameworkClientApi['maintenanceView']>>>()
  const inspect = async () => { setBusy(true); setError(''); try { setUsage(await api.maintenanceView({ mode: 'local', storageScope })) } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }
  const open = async (target: 'records' | 'native-logs') => { setError(''); try { await api.openMaintenancePath({ mode: 'local', storageScope, target }) } catch (error) { setError(error instanceof Error ? error.message : String(error)) } }
  const labels: Record<Action, string> = {
    tasks: tr('清理已结束任务记录', 'Clear ended task records'),
    conversation: tr('清理前台聊天记录', 'Clear Foreground conversation'),
    planning: tr('清空工作清单与缓存', 'Clear working List and Cache'),
  }
  const prepare = async (action: Action) => {
    setBusy(true); setError(''); setResult('')
    try {
      const preview = action === 'tasks' ? await api.cleanupPreview({ mode: 'local', storageScope }) : undefined
      setPending({ action, commandId: crypto.randomUUID(), preview })
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!pending) return
    setPending({ ...pending, submitted: true })
    setBusy(true); setError('')
    try {
      const base = { mode: 'local' as const, storageScope, commandId: pending.commandId }
      const result = await api.cleanupRecords(pending.action === 'tasks'
        ? { ...base, action: 'tasks', preview: pending.preview!, confirmation: 'clear-ended-task-records' }
        : pending.action === 'conversation' ? { ...base, action: 'conversation', confirmation: 'clear-foreground-conversation' }
        : { ...base, action: 'planning', confirmation: 'clear-work-planning-notes' })
      setPending(undefined)
      setResult(tr('已清理记录；保留成果附件：', 'Records cleared; retained artifact files: ') + result.preservedPaths.length)
      await changed()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className={css.section} aria-label={tr('长期记录管理', 'Long-term records')}>
    <h3>{tr('长期记录管理', 'Long-term records')}</h3>
    <p>{tr('记录保留到你明确清理。只作用于当前 Local 存储；不会自动按年龄或容量删除。', 'Records remain until you explicitly clear them. These actions affect this Local storage only; there is no age or capacity based deletion.')}</p>
    <Button disabled={busy} onClick={() => void inspect()}>{tr('查看记录容量与目录', 'Inspect record usage and directories')}</Button>
    <Button disabled={busy} onClick={() => void open('records')}>{tr('打开记录目录', 'Open records directory')}</Button>
    <Button disabled={busy} onClick={() => void open('native-logs')}>{tr('打开宿主会话日志目录', 'Open Host session log directory')}</Button>
    {usage && <div><p>{usage.localDirectory}</p>{usage.recordsDirectory && <p>{tr('技术记录目录', 'Technical records directory')}: {usage.recordsDirectory}</p>}
      {usage.nativeDirectory && <p>{tr('宿主日志目录', 'Host log directory')}: {usage.nativeDirectory}</p>}
      <p>{tr('逻辑记录字节（不等同 SQLite 或宿主日志磁盘占用）', 'Logical record bytes (not SQLite or Host log disk allocation)')}: {usage.usage.totalBytes}</p>
      <dl>{Object.entries({ [tr('聊天', 'Conversation')]: usage.usage.permanent.chatBytes, [tr('工作清单与缓存', 'List and Cache')]: usage.usage.permanent.planningBytes,
        [tr('技能与知识', 'Skills and knowledge')]: usage.usage.permanent.knowledgeBytes, [tr('成果档案', 'Archives')]: usage.usage.permanent.archiveBytes,
        [tr('运行资料', 'Running task material')]: usage.usage.temporaryBytes }).map(([label, bytes]) => <div key={label}><dt>{label}</dt><dd>{bytes} bytes</dd></div>)}</dl>
    </div>}
    {!pending && (Object.keys(labels) as Action[]).map(action => <Button key={action} disabled={busy} onClick={() => void prepare(action)}>{labels[action]}</Button>)}
    {pending && <div role="group" aria-label={tr('确认清理', 'Confirm cleanup')}>
      <h4>{labels[pending.action]}</h4>
      <p>{pending.action === 'tasks' ? tr('只删除本次预览的已结束任务历史；成果、技能和知识保留。', 'Only the ended task history in this preview is removed; artifacts, skills and knowledge remain.')
        : pending.action === 'conversation' ? tr('停止并重建前台会话后删除聊天原文；后台任务及工作清单、缓存保留。', 'Stops and renews the Foreground session before deleting conversation originals. Background tasks, List and Cache remain.')
        : tr('只清空工作清单与缓存正文；聊天和任务档案保留。', 'Only List and Cache bodies are cleared; conversation and task archives remain.')}</p>
      {pending.preview && <p>{pending.preview.tasks.length} {tr('个任务', 'tasks')} · {pending.preview.fileCount} {tr('个文件', 'files')} · {pending.preview.bytes} bytes</p>}
      <Button disabled={busy} onClick={() => void confirm()}>{tr('确认清理', 'Confirm cleanup')}</Button>
      <Button disabled={busy} onClick={() => { setPending(undefined); setError('') }}>{pending.submitted ? tr('关闭（不撤销已发送请求）', 'Close (does not cancel the submitted request)') : tr('取消', 'Cancel')}</Button>
      {pending.submitted && <p>{tr('请求已发送。结果未确认时，请用同一操作重试；关闭面板不会撤销已接纳的清理。', 'The request was sent. Retry this same operation if its outcome is unknown; closing the panel does not revoke an accepted cleanup.')}</p>}
    </div>}
    {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
  </section>
}
